import rfdc from "rfdc";
import * as URI from "uri-js";

/** Typescript types for JSON values */
type JsonValue =
  | JsonValue[]
  | boolean
  | number
  | null
  | { [k: string]: JsonValue }
  | string;

/** Typescript types for JSON objects */
interface JsonObject {
  [k: string]: JsonValue;
}

/**
 * Context of $ref rewrite (resolve) operations
 */
interface RewriteContext {
  // List of all schemas used for local resolution
  readonly schemaList: JsonObject[];
  // Map of schema $id to schemaList index
  readonly idMap: Record<string, number>;
  // $id of schema currently being rewritten
  readonly currentId: string;
  // Index of schema currently being rewritten
  readonly currentIndex: number;
  // Dependencies of current schema against other schema by index
  readonly usedMap: Record<number, boolean>;
  // Cache of resolved $ref values in current schema for performance
  readonly refCacheMap: Record<string, string>;
  // True if current schema is the outer/top level schema
  readonly topSchema: boolean;
}

/** Configuration options for Resolver */
interface ResolverOptions {
  // Default schema id to use when resolving
  applicationUri: string;
  // Backwards compatible property
  // Ignored since we always clone for safety (if not performance)
  clone: boolean;
  // When true $comment will be adjusted
  commentId: boolean;
  // Top level schema element where definitions are stored
  defElement: string;
  // Generated definition prefix
  defPrefix: string;
  // When true, definition $id will be stripped
  deleteId: boolean;
  // Pre-loaded JSON schema documents available for resolving
  externalSchemas: JsonObject[];
  // When true definitions are merged during resolve
  mergeDefinitions: boolean;
  // JSON Schema Draft target version
  target: "draft-07";
}

class Resolver {
  // Default configuration options
  private static DEFAULT_OPTIONS: ResolverOptions = {
    applicationUri: "",
    clone: false,
    commentId: false,
    defElement: "definitions",
    defPrefix: "def-",
    deleteId: true,
    externalSchemas: [],
    mergeDefinitions: false,
    target: "draft-07",
  };

  // Configuration options for Resolver instance
  private readonly options: ResolverOptions;
  // JSON data fast copy utility
  private static rfdc = rfdc({ proto: true, circles: false });
  // List of external (re-written) schemas
  private externalIds: string[] = [];
  // Map external schema $id to schema index
  private externalMap: Record<string, number> = {};
  // List of external schema dependency relationships
  private usedMapList: Record<number, boolean>[] = [];

  // The default $id used when resolving a top level schema
  private readonly defaultUri: string;
  // Flag to indicate if external schemas have been analyzed/re-written
  private initDone = false;

  /**
   * Class constructor.
   *
   * @param options Configuration options
   */
  public constructor(options: Partial<ResolverOptions>) {
    this.options = Object.assign({}, Resolver.DEFAULT_OPTIONS, options);
    this.defaultUri = this.options.applicationUri || "";
    if (!options.defElement && options.target) {
      if (options.target === "draft-07") {
        this.options.defElement = "definitions";
      } else if (options.target === "draft-08") {
        this.options.defElement = "$defs";
      }
    }
  }

  /**
   * Embedded required external schemas as definitions
   * and resolve $ref values to these definitions
   * whenever possible.
   *
   * @param schema The root/top level schema
   */
  public resolve(schema: JsonObject): JsonObject {
    this.init();
    schema = Resolver.rfdc(schema);
    const usedMap = this.rewriteRootSchema(schema);
    if (this.options.mergeDefinitions) {
      const usedDefs = this.usedDefs(usedMap);
      this.mergeDefinitions(schema, usedDefs, true);
    }
    return schema;
  }

  /**
   * Return the map of possible definitions
   */
  public definitions(): JsonObject {
    this.init();
    const map: Record<number, boolean> = {};
    this.options.externalSchemas.forEach((schema, index) => {
      map[index] = true;
    });
    const usedDefs = this.usedDefs(map);
    const schema: JsonObject = {};
    this.mergeDefinitions(schema, usedDefs, false);
    return schema;
  }

  /**
   * Delay expensive operations until first use.
   * Rationale: fastify hooks may construct and throw away many Resolver instances during startup.
   */
  private init(): void {
    if (this.initDone) {
      return;
    }
    this.registerExternalSchemas();
    this.rewriteExternalSchemas();
    this.initDone = true;
  }

  /**
   * Analyze the externalSchemas one time to expedite later
   * resolve operations.
   */
  private registerExternalSchemas(): void {
    // We always copy external schemas so we can safely modify $id, $ref and $schema
    this.options.externalSchemas = this.options.externalSchemas.map((value) =>
      Resolver.rfdc(value)
    );
    // Capture the schema $id
    this.options.externalSchemas.forEach((schema, index) => {
      const id = schema.$id;
      if (typeof id === "string" && id !== "") {
        this.externalIds[index] = id;
        // NOTE: duplicates are silently ignored here
        this.externalMap[id] = index;
        if (this.options.deleteId) {
          delete schema.$id;
        }
        if (this.options.commentId) {
          // Preserve original $id in comment
          schema.$comment = `${
            schema.$comment ? `${schema.$comment} ` : ""
          }[Originally $id: ${id}]`;
        }
      } else {
        this.externalIds[index] = "";
      }
      delete schema.$schema;
    });
  }

  /**
   * Rewrite the externalSchemas $ref values one time to expedite later
   * resolve oeprations.
   */
  private rewriteExternalSchemas(): void {
    this.options.externalSchemas.forEach((schema, index) => {
      const usedMap: Record<number, boolean> = {};
      const context: RewriteContext = {
        currentId: this.externalIds[index],
        currentIndex: index,
        idMap: this.externalMap,
        refCacheMap: {},
        schemaList: this.options.externalSchemas,
        topSchema: false,
        usedMap,
      };
      this.rewriteObject(context, schema);
      this.usedMapList[index] = usedMap;
    });
  }

  /**
   * Transform a (possibly) relative $id value into an absolute $id value
   *
   * @param context the rewrite context
   * @param relativeId the (possibly) relative $id value
   * @returns The absolute form of the relative $id value
   */
  private absoluteId(context: RewriteContext, relativeId: string): string {
    if (relativeId.startsWith(".")) {
      const currentUri = URI.parse(context.currentId);
      const currentPath = currentUri.path ? currentUri.path.split("/") : [""];
      currentPath.length -= 1;
      const refPath = relativeId.split("/");
      let isRelative = false;
      while (refPath.length && (refPath[0] === "." || refPath[0] === "..")) {
        isRelative = true;
        if (refPath[0] === "..") {
          if (currentPath.length > 0) {
            currentPath.length -= 1;
          } else {
            // Can't navigate up.  Return original $id
            return relativeId;
          }
        }
        refPath.shift();
      }
      if (isRelative && refPath.length) {
        currentPath.push(...refPath);
        currentUri.path = currentPath.join("/");
        return URI.serialize(currentUri);
      }
    }
    return relativeId;
  }

  /**
   * Attempt to resolve a $ref against available/embedded schemas
   * @param context the rewrite context
   * @param refValue the $ref value to resolve
   * @returns The locally resolved $ref value when possible, else original value
   */
  private resolveRef(context: RewriteContext, refValue: string): string {
    const cached = context.refCacheMap[refValue];
    if (cached) {
      return cached;
    }
    const relativeId = this.getId(refValue);
    const fragment = this.getFragment(refValue);
    const id = this.absoluteId(context, relativeId);
    const defNum = id ? context.idMap[id] : context.currentIndex;
    let result: string;
    if (typeof defNum === "undefined") {
      // Unable to resolve.  Leave it alone.
      result = refValue;
    } else if (context.topSchema && defNum === context.currentIndex) {
      // Locally resolves in the outer schema
      result = `#${fragment}`;
    } else {
      if (context.currentIndex !== defNum) {
        context.usedMap[defNum] = true;
      }
      result = `${this.defPath(defNum)}${fragment}`;
    }
    context.refCacheMap[refValue] = result;
    return result;
  }

  /**
   * Calculate the local path for a particular definition by index
   * @param defNum the definition index
   * @returns the local $ref path for the definition
   */
  private defPath(defNum: number): string {
    return `#/${this.options.defElement}/${this.options.defPrefix}${defNum}`;
  }

  /**
   * Rewrite all $ref values found nested inside an object
   * @param context the rewrite context
   * @param item the object to traverse
   */
  private rewriteObject(context: RewriteContext, item: JsonObject): void {
    for (const key in item) {
      const value = item[key];
      if (typeof value === "object" && value !== null) {
        if (Array.isArray(value)) {
          this.rewriteArray(context, value);
        } else {
          this.rewriteObject(context, value);
        }
      } else if (key === "$ref" && typeof value === "string") {
        item.$ref = this.resolveRef(context, value);
      }
    }
  }

  /**
   * Rewrite all $ref values found nested inside an array
   * @param context the rewrite context
   * @param items the array to traverse
   */
  private rewriteArray(context: RewriteContext, items: JsonValue[]): void {
    for (const value of items) {
      if (typeof value === "object" && value !== null) {
        if (Array.isArray(value)) {
          this.rewriteArray(context, value);
        } else {
          this.rewriteObject(context, value);
        }
      }
    }
  }

  private rewriteRootSchema(schema: JsonObject): Record<number, boolean> {
    let currentId = schema.$id;
    if (!currentId || typeof currentId !== "string") {
      currentId = this.defaultUri;
    }
    const idMap = Object.assign({}, this.externalMap);
    const schemaList = Array.from(this.options.externalSchemas);
    const currentIndex = schemaList.length;
    const usedMap: Record<number, boolean> = {};
    schemaList.push(schema);
    idMap[currentId] = currentIndex;
    const context: RewriteContext = {
      currentId,
      currentIndex,
      idMap,
      refCacheMap: {},
      schemaList,
      topSchema: true,
      usedMap,
    };
    this.rewriteObject(context, schema);
    return usedMap;
  }

  /**
   * Calculate the definitions referenced anywhere in the top level schema
   * @param usedMap The root schema directly used map
   * @returns The definitions that should be included
   */
  private usedDefs(
    rootUsedMap: Record<number, boolean>
  ): Record<string, JsonObject> {
    // Only include those definitions reachable from the root schema
    const map: Record<number, "expand" | "done"> = {};
    for (const defNum in rootUsedMap) {
      map[defNum] = "expand";
    }
    let retry = true;
    while (retry) {
      retry = false;
      for (const defNum in map) {
        const value = map[defNum];
        if (value === "expand") {
          const subMap = this.usedMapList[defNum];
          for (const subDefNum in subMap) {
            if (!map[subDefNum]) {
              map[subDefNum] = "expand";
              retry = true;
            }
          }
          map[defNum] = "done";
        }
      }
    }
    const list: number[] = [];
    for (const defNum in map) {
      list.push(Number.parseInt(defNum));
    }
    list.sort();
    const result: Record<string, JsonObject> = {};
    for (const defNum of list) {
      result[`${this.options.defPrefix}${defNum}`] =
        this.options.externalSchemas[defNum];
    }
    return result;
  }

  /**
   * Merge the (deeply) referenced external schemas into the root level schema
   * @param schema the root level schema
   * @param defs the referenced external schemas
   */
  private mergeDefinitions(
    schema: JsonObject,
    defs: Record<string, JsonObject>,
    skipWhenEmpty: boolean
  ): void {
    if (skipWhenEmpty && !Object.keys(defs).length) {
      return;
    }
    const path = this.options.defElement.split("/");
    let here = schema;
    for (const name of path) {
      let next = here[name];
      if (next && typeof next === "object" && !Array.isArray(next)) {
        // Do nothing
      } else {
        next = {};
        here[name] = next;
      }
      here = next;
    }
    for (const key in defs) {
      here[key] = defs[key];
    }
  }

  /**
   * Extract the root $id from a $ref that may contain a #fragment
   *
   * @param refValue the string form of the URI
   * @returns the $id porition of the URI
   */
  private getId(refValue: string): string {
    return refValue.split("#")[0];
  }

  /**
   * Extract the root $id from a $ref that may contain a #fragment
   *
   * @param refValue the string form of the URI
   * @returns the $id porition of the URI
   */
  private getFragment(refValue: string): string {
    return refValue.split("#")[1] || "";
  }
}

function resolver(options?: Partial<ResolverOptions>): Resolver {
  return new Resolver(options || {});
}

export = resolver;

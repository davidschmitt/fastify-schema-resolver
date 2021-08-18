import resolver from "./resolver";
import { describe, it } from "mocha";
import { expect } from "chai";

const refArray = (ref: string) => {
  return { items: { $ref: ref }, type: "array" };
};

const dumpJson = (data: unknown) => {
  console.log(JSON.stringify(data, null, 2));
};

const person = (prefix: string) => {
  return {
    $id: `${prefix}/subdir/Person.json`,
    type: "object",
    properties: {
      name: { type: "string" },
      parents: refArray(`${prefix}/subdir/Person.json`),
      children: refArray(`./Person.json`),
      friends: refArray(`../subdir/Person.json`),
      cats: refArray(`${prefix}/subdir/Animal.json#/defs/pet`),
      dogs: refArray(`./Animal.json#/defs/pet`),
      fish: refArray(`../subdir/Animal.json#/defs/pet`),
    },
  };
};

const animal = (prefix: string, absolute?: boolean) => {
  const id = `${prefix}/subdir/Animal.json`;

  return {
    $comment: "Schema for animals of various kinds",
    $id: id,
    title: "Non-human Animals",
    oneOf: [
      { $ref: `${absolute ? id : ""}#/defs/pet` },
      { $ref: `${absolute ? id : ""}#/defs/wild` },
    ],
    type: "object",
    defs: {
      pet: {
        properties: { name: { type: "string" } },
        type: "object",
      },
      wild: {
        properties: { name: { type: "string" } },
        type: "object",
      },
    },
  };
};

function schemaExpect(original: unknown, resolved: unknown, equal?: boolean) {
  const originalJson = JSON.stringify(original);
  const resolvedJson = JSON.stringify(resolved);
  if (equal) {
    expect(originalJson).to.equal(resolvedJson);
  } else {
    expect(originalJson).to.not.equal(resolvedJson);
  }
}

const localPrefix = "topdir";
const networkPrefix = "https://example.com";

describe("resolver", () => {
  it("Can leave root schema alone", () => {
    for (const prefix of [localPrefix, networkPrefix]) {
      const ref = resolver();
      const original = animal(prefix);
      const resolved = ref.resolve(original);
      schemaExpect(original, resolved, true);
    }
  });
  it("Can transform local refs in root schema", () => {
    for (const prefix of [localPrefix, networkPrefix]) {
      const ref = resolver();
      const original = animal(prefix, true);
      const resolved = ref.resolve(original);
      schemaExpect(original, resolved);
    }
  });
  it("Can handle a single external schema", () => {
    for (const prefix of [localPrefix, networkPrefix]) {
      const animalSchema = animal(prefix);
      const animalId = animalSchema.$id;
      const ref = resolver({
        externalSchemas: [animal(prefix)],
      });
      const original = {
        properties: {
          cat: {
            $ref: `${animalId}#/defs/pet`,
          },
        },
      };
      const resolved = ref.resolve(original);
      schemaExpect(original, resolved);
    }
  });
  it("Can prune external schema", () => {
    for (const prefix of [localPrefix, networkPrefix]) {
      const animalSchema = animal(prefix);
      const animalId = animalSchema.$id;
      const ref = resolver({
        externalSchemas: [person(prefix), animal(prefix)],
      });
      const original = {
        properties: {
          cat: {
            $ref: `${animalId}#/defs/pet`,
          },
        },
      };
      const resolved = ref.resolve(original);
      schemaExpect(original, resolved);
    }
  });
  it("Can handle relative $ref values", () => {
    for (const prefix of [localPrefix, networkPrefix]) {
      const ref = resolver({
        externalSchemas: [animal(prefix)],
      });
      const original = person(prefix);
      const resolved = ref.resolve(original);
      schemaExpect(original, resolved);
    }
  });
  it("Can handle relative $ref values in external schemas", () => {
    for (const prefix of [localPrefix, networkPrefix]) {
      const personSchema = person(prefix);
      const ref = resolver({
        externalSchemas: [person(prefix), animal(prefix)],
      });
      const original = {
        properties: {
          employee: {
            $ref: `${personSchema.$id}`,
          },
        },
      };
      const resolved = ref.resolve(original);
      schemaExpect(original, resolved);
    }
  });
  it("Can export the external schemas", () => {
    for (const prefix of [localPrefix, networkPrefix]) {
      const ref = resolver({
        externalSchemas: [person(prefix), animal(prefix)],
      });
      const defs = ref.definitions();
      // dumpJson(defs);
    }
  });
});

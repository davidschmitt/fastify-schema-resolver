# fastify-schema-resolver

Drop in replacement for `json-schema-resolver` package 
for use with `fastify-swagger` package.

Simply change the `require('json-schema-resolver')` line in 
`fastify-swagger/lib/util/common.js`.

The API was (obviously) designed to match `json-schema-resolver`, but it is an
independent implementation using TypeScript.

Key Features/Rationale:

* Resolves relative `$ref` values between external schemas
* Resolves absolute `$ref` values between external schemas
* Resolves local `$ref` values within external schemas
* Caches resolved external schemas for performance
* Defers analysis of external schemas to avoid overhead
  while `fastify-schema` `onRegister` hook is called repeatedly
* Successfully passes all `fastify-swagger` tests

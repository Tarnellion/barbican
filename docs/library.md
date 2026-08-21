# Using barbican as a library

The package is a CLI and a library from the same build. This page says which of
the exported names are meant for a consumer, and what the rest are.

It exists because nothing said so. The package exported 266 names and the only
place any of them appeared was one example in the README — five of them — so a
consumer had no way to tell an entry point from a helper the CLI happens to share
with itself. Found by the audit of 14 August 2026 (E-6).

## The four entry points

Everything a consumer needs is reachable from these.

| Name | What it does |
|---|---|
| `parseRunConfig(source)` | validates a run configuration and returns a `RunConfig`. The only supported way in: it applies the size and depth limits and every check the CLI applies |
| `buildAccessMatrix({ endpoints, accounts, resources, observations })` | assembles the matrix from observations you collected however you like |
| `diffAccess(matrix, policy)` | compares the matrix against a resolved policy and returns the discrepancies |
| `buildReport(options)` | turns a walk into the report the CLI writes, verdict and summary included |

Two more you will need beside them:

- `expandPolicy(policy, endpoints)` turns the patterns in a declared policy into
  names. `diffAccess` takes the **resolved** policy, and a pattern matching
  nothing has to fail there rather than quietly stop applying.
- `configJsonSchema()` returns the JSON Schema an editor completes a
  configuration from. This is the supported way to get it — the zod schema that
  validates a run is deliberately **not** exported, so that a zod major is not a
  breaking change for you.

The example in the [README](../README.md) is compiled and run by a test, and it
uses four of these.

## Running the walk yourself

`collectObservations` performs it: it takes the endpoints, the accounts, a
credential provider and an HTTP client, and honours the throttle and the
safe-method default. The adapters behind it are exported alongside their ports,
so an implementation of your own can be substituted:

- `createHttpClient`, `createThrottle`, `createCredentialProvider`
- `createOpenApiParser`, `createEndpointListParser`, `createPostmanCollectionParser`
- `createSignalExtractor` — response-body scalars, and nothing else reads a body
- `createTenantHierarchy`, `createIdenticalResponseCheck`, `CheckRegistry`
- `safeHeaders` — the checked constructor of the `HeaderValue` that
  `CredentialProvider.headersFor` returns. A provider that signs a request needs
  it ([ADR-0018](adr/0018-request-signing-is-a-port-concern.md)); an object
  literal does not type-check in its place, because the grammar for a string from
  outside applies to this door as well as to the CLI
  ([ADR-0024](adr/0024-strings-from-outside.md)). It was unreachable until
  21 August 2026, which made that whole promise false.

The port interfaces are in `src/adapters/ports.ts` and exported by name.

## What the rest of the surface is

The package exports 175 values and a comparable number of types. They fall into
three groups, and only the first is a contract:

1. **The names above**, plus the domain types they take and return — `Account`,
   `Endpoint`, `Resource`, `RunConfig`, `AccessObservation`, `AccessDiff`,
   `RunReport` and their neighbours.
2. **83 error classes.** These are public on purpose: catching an error and
   naming it is the only way to tell a configuration mistake from a network
   failure, and `instanceof` needs the class. They are grouped by the module that
   throws them.
3. **Everything else** — `assertPolicyIsSound`, `indexPolicy`, `relationOf`,
   `expandPattern` and some forty more. These exist because the CLI needs them
   and the CLI is built from the same modules. They are exported rather than
   hidden so that the build does not carry code no one can reach, which is the
   older of the two mistakes. **They are not a contract.** Use them if they help;
   they may change in any release while the version is `0.x`.

## What is deliberately not exported

- **The zod schema.** `configSchema` was exported until 17 August 2026, and that
  put 100 lines of `z.ZodObject<…>` into the published types — naming
  `z.core.$strip`, zod's internal namespace. A dependency inside a public type is
  a version of that dependency the package has promised to keep. Use
  `parseRunConfig` to validate and `configJsonSchema()` to obtain the schema. A
  CI step asserts that no shipped declaration imports from any package at all.
- **Anything that would let a body reach a report.** The `HttpResponse` port
  carries no body, `SignalValue` is a number or a boolean, and neither is an
  oversight; see [ADR-0011](adr/0011-response-body-signals.md).

## Stability

The version is `0.x` and the whole surface may change, including the four entry
points. What will not happen quietly: the report has a `schemaVersion`, and every
change to what the tool writes is recorded in an ADR under
[docs/adr/](adr/).

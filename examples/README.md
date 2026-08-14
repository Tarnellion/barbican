# Examples

## `minimal/`

The smallest working configuration: two tenants, three accounts (one of them
anonymous), three endpoints. The comments explain what each field is for, not
what it means.

There is no deployment here — this is a template to start from. It parses and its
cross-references check out, but `baseUrl` points nowhere: put in your own.

```bash
barbican run --config examples/minimal/barbican.run.yaml --endpoints examples/minimal/endpoints.yaml
```

Tokens come from the environment, under the names given in `tokenEnv`:

```bash
TOKEN_ALICE=… TOKEN_CAROL=… barbican run --config examples/minimal/barbican.run.yaml --endpoints examples/minimal/endpoints.yaml
```

## A complete working example

`polygon/` in the repository root is not an example but a deployment for testing
the tool itself: a multi-tenant API with twelve switchable defects, a
machine-readable oracle and a verification script. It is worth looking there when
what you need is not a template but a working configuration against a live server.

```bash
node polygon/verify.mjs
```

## What to understand before the first run

**You declare the expected access.** It is not derived from the specification of
the API under test: the spec is generated from the same code, and deriving from
it would mean comparing an implementation against itself (ADR-0006). An empty
policy produces a run without a single finding — and that will mean "nothing was
declared", not "everything is clean".

**Exit code 2 is not a startup error but distrust of the run.** It means the
result cannot be trusted: a token went stale, the ceiling on requests was used
up, there are no observations at all. Telling it apart from an honest zero
matters more than it seems: "there are no findings" and "nothing was tested" look
the same in the report.

**Canaries are not decoration.** An account without a canary cannot be tested: if
every one of its requests was denied, the tool cannot tell working protection
from a stale token.

---
name: add-adapter
description: Add or replace a barbican adapter (HTTP client, spec parser, throttling) behind a port from src/adapters/ports.ts, together with a fake for tests. Use when implementing a new adapter or replacing an existing one.
---

**DRAFT — not active. Review and move by hand.**

# Adding an adapter

Adapters are isolated behind ports (`src/adapters/ports.ts`). The core must not learn
that an implementation has been replaced.

## Steps

1. The implementation goes in `src/adapters/<name>.ts`. It implements an existing port. If the port
   has to be extended — first work out whether an implementation detail is leaking into the core.

2. A fake in `tests/fixtures` for the same port. The core tests go through the fake only;
   there is no network in the core tests.

3. Injection through an argument, not through a singleton import: global state is forbidden.

## Invariants by adapter type

**HTTP client.** Do not return response bodies — the `HttpResponse` port does not carry them,
and it must not be extended without an ADR. Every request goes through `Throttle`. The method
is checked against `SAFE_METHODS` before sending, not inside the client.

**Spec parser.** External `$ref`s are not resolved — neither `http(s)` nor file ones.
Proving tests are required, separately for each case; an adapter without them
is not accepted. Plus a limit on the size and the depth of the input document (a YAML bomb).

**Throttling.** A concurrency limit, a requests-per-second limit, an overall ceiling per run,
exponential backoff, a circuit breaker on runs of 5xx/429, respect for `Retry-After`.
The defaults are conservative. There must be no switchable "no limits" mode.

## Check before committing

- The core imports nothing from `src/adapters` except `ports.ts`.
- The core tests pass with the fake, without the network.
- For the parser — the tests on external `$ref`s exist and fail when resolution is turned on.
- `pnpm run check` passes.

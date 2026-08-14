# 0002. A pure core and JSON as the single source of truth

- **Status:** accepted
- **Date:** 2026-08-11

## Context

The tool makes network requests to someone else's API and, on the strength of them, draws
conclusions about the presence of vulnerabilities. Two risks: inference logic mixed in with
input and output cannot be tested without the network and is therefore tested badly; a
report assembled as the checks run cannot be reproduced or verified.

## Decision

`src/core` contains only pure functions and types: no HTTP, no file system, no global
state. The input is roles, endpoints and observed responses. The output is the access
matrix and the discrepancies. Everything is tested on fixtures without the network.

The check registry is per-instance (`new CheckRegistry()`), no singleton is exported:
global state in the core is forbidden, including state of the "default registry" kind. The
`Check.run` method is synchronous — that makes unnoticed input and output inside a check
impossible.

JSON is the single source of truth. A run ends with a JSON document; HTML, PDF and any
human-readable output are rendered from it by a separate step in `src/report`.

## Alternatives

- **A core that goes to the network itself:** fewer layers, but the tests then need a
  polygon or HTTP mocks, and a particular run cannot be reproduced.
- **Rendering the report as the checks run:** it saves one pass, but makes the output
  non-reproducible and ties the presentation format to the detection logic.

## Consequences

The core can be run over recorded observations and give the same result — that yields
regression tests on real data and the ability to re-check an old run with a new version of
the detectors.

The price: observations have to be materialized in full before analysis, which rules out
streaming parsing on the fly. For the expected volumes that is acceptable.

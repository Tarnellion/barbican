# 0074. What nothing carries

- **Status:** accepted
- **Date:** 2026-08-24

## Context

`0.7.0` is published and both modules are done. The question this round asked is
not "what is slow" — the tool has no hot path worth the name: 2 888 cells in
0.5 s against a local stub, `pack` on a 2.4 MB report in 0.19 s, the core linear
at 13 ms for 20 000 cells. The question is what the tree costs a person who has
to read it, and specifically what it carries that nothing is using.

Four things were measured: the published surface, the code the coverage report
cannot reach, helpers that exist once per module, and the test tree against the
source tree. Every number below was produced by running something, and the
scripts that produced them are described precisely enough to be written again.

Most of the answer is that this tree is in better shape than the question
assumed, and the honest output of a round like that is a list rather than a
diff. Three things did come out of it, and they are at the bottom.

## What was measured

### 1. The published surface

`src/index.ts` exports **242 values** — the number `docs/library.md` states and
`tests/public-surface.test.ts` holds. Each was counted against every tracked file
in the repository, by bucket:

| | count |
|---|---|
| error classes | 99 |
| `UPPER_SNAKE` constants | 45 |
| other values | 98 |
| named anywhere in `docs/library.md` | 51 |
| named in any document in the repository | 124 |
| named by at least one test | 223 |
| used by `src/cli/` | 48 |
| **named by no document, no test and not by the CLI** | **13** |

And by the route a name takes to the surface: **64** are written out one by one
in a barrel that lists names — `src/io/config.ts` and `src/runner.ts` — and
**178** arrive through `export *` from a module somebody chose.

The three sentences `docs/library.md` makes about the shape of this surface were
checked rather than assumed, and all three hold: 99 error classes; 43 non-error
names in the documented group; and the remaining 100 in the group the document
calls "not a contract", four of which it names and "ninety-six more".

**The finding is that this surface has almost no accidents in it.** Two written
policies decide what is on it, and between them they account for every name:

- the modules of `src/adapters` and `src/io` are re-exported **whole**, on
  purpose and with the reasoning written in `src/index.ts` — an implementation
  behind a port a consumer cannot reach is dead weight in the build, and a
  hand-picked subset of a module's exports is a second list beside the module's
  own, which is the shape of the fact that went stale here in the first place;
- `src/io/config.ts` and `src/runner.ts` are lists of names, precisely so that
  what those modules hand each other does not become surface.

So a name being unused outside `src/` does not make it an accident: it makes it
a name that rode along on a module the policy exports whole. The thirteen with no
evidence at all are these, with what each actually is:

| name | home | what it is |
|---|---|---|
| `BODY_OVER_LIMIT_SIGNAL` | `core/checks/tenant-isolation.ts` | a reserved signal name |
| `DEFAULT_DIGEST_SIGNAL` | `core/checks/tenant-isolation.ts` | a reserved signal name |
| `DIGEST_SCOPE_MISSING_SIGNAL` | `core/checks/tenant-isolation.ts` | a reserved signal name |
| `IDENTICAL_RESPONSE_CHECK_ID` | `core/checks/tenant-isolation.ts` | a reserved check id |
| `CWE_ID` | `core/checks/clauses.ts` | the id of a bundled standard |
| `OWASP_API_2023_ID` | `core/checks/clauses.ts` | the id of a bundled standard |
| `OWASP_ASVS_5_0_ID` | `core/checks/clauses.ts` | the id of a bundled standard |
| `FLAT_HIERARCHY` | `core/tenancy.ts` | the hierarchy used when no tenant links are declared |
| `COMPARISON_SCHEMA_VERSION` | `report/compare.ts` | the comparison document's `schemaVersion` |
| `describeAcceptance` | `core/accepted.ts` | `accepted[3]` for a message |
| `assertAuthSchemeIsSound` | `adapters/credentials.ts` | a configuration check |
| `isHeaderValue` | `io/untrusted.ts` | the predicate half of a grammar |
| `systemClock` | `adapters/throttle.ts` | the clock the adapters read |

Seven of the thirteen are values a consumer is **refused for colliding with** —
`ReservedSignalNameError` and `ReservedCheckIdError` are raised by name — or ids
they need in order to ask the catalogue about a bundled standard. `isHeaderValue`
and `systemClock` are on the surface by the whole-module policy above.
`COMPARISON_SCHEMA_VERSION` is the odd one. When this survey was taken,
`docs/library.md` explained **only** `PACK_SCHEMA_VERSION`; the other two were on
the surface and unexplained. The change that carries this document adds
`REPORT_SCHEMA_VERSION` to that page, which is why the sentence reads as it does
now — and the first version of it described the state after its own edit as
though it were what the survey found. All three are gaps in the document rather
than names to remove, and the third is still one.

**Nothing on this list is removed, and none of it is proposed for 1.0 as a
list.** A removal is a breaking change and needs its own argument; what this
measurement says is that the argument would have to be made thirteen times and
would win at most twice, which is not a project. What it did produce is the next
section.

### 2. Code the coverage report cannot reach

The run measures **3 362 statements, 2 399 branches, 714 functions**. Before this
round: 3 307 / 2 277 / 705 covered. The 186 unreached points were read one by
one, off `coverage-final.json` with each line's source text beside it, and sorted
into the three kinds:

- **75 are mechanical** and deliberate: 24 are the `: String(cause)` arm of
  `cause instanceof Error ? cause.message : String(cause)`, 34 are a `??`
  fallback for a value the type system cannot narrow, 10 are the `{}` arm of an
  `exactOptionalPropertyTypes` spread, 7 are a singular/plural ternary. The four
  patterns are counted without overlap, in that order — one line is both a `??=`
  and an `instanceof Error`, and it is counted once.
- **Two are unreachable and already say so in the source**, at length: the
  `UnknownCanaryEndpointError` inside `probeCanaries`, and the `Set` branch of
  `canonicalInto`. The second was checked rather than taken on trust —
  `canonical` has exactly two callers, `configDigest` and `contentDigestOf`, and
  `RunConfig.accountAuth` is a `ReadonlyMap`, which is why the `Map` branch beside
  it *is* exercised while no field anywhere is a `Set`. Deleting it would make a
  `Set` added tomorrow hash as `{}` — a silently equal digest for two different
  configurations — so it stays.
- **One was unreachable and did not say so**: the loop in
  `assertReferencesResolve` over `bodySignals.compareSubtree`. Measured against
  the built tree: the parse gate refuses a scope whose endpoint is not under
  `responseMustDifferByTenant`, so an unknown id has to appear in both, and the
  loop over `responseMustDifferByTenant` twenty lines above throws first. It is
  kept and commented, on the argument `probeCanaries` keeps its own unreachable
  throw on — the rule holding it up lives in another module, and
  `assertReferencesResolve` takes a `RunConfig`, which is an interface and not a
  brand.
- **Seven were reachable through the supported door and nothing ran them.** They
  are the change this round is mostly made of; see the Decision.

`src/cli/preview.ts` and `src/cli/run.ts` were named going in as places where
dead code had been spotted during the week. They were already dealt with on 23
and 24 August — a `?? ""` after a filter that had excluded `undefined`, a `?? 1`
on a lookup in a map built from the list being looked up in, and a `?? reason` on
a table keyed by the type of the value being looked up. What is left is one `{}`
spread arm in `src/cli/preview.ts` and **three** in `src/cli/run.ts` — lines 271,
439 and 574. The first version of this sentence said one each; it was measured
against the wrong file.

### 3. Helpers that exist once per module

`isRecord` has **four copies** in `src/`, `describe(cause)` has **three**, and
the expression the third wraps is written inline **20 more times**. The sweep of
23 August judged the copies harmless because each derives from one source. That
judgement no longer holds for one of them, and the measurement is exact:

```
src/adapters/endpoint-list.ts  typeof v === "object" && v !== null && !Array.isArray(v)
src/adapters/postman.ts        typeof v === "object" && v !== null && !Array.isArray(v)
src/report/document.ts         typeof v === "object" && v !== null && !Array.isArray(v)
src/adapters/openapi.ts        typeof v === "object" && v !== null
```

Three copies say an array is not a record; the fourth says it is. The divergence
is observable through the public door. `createOpenApiParser().parse` on a
document whose `get:` is a YAML sequence:

```
openapi: "3.0.0"
info: { title: t, version: "1" }
paths:
  /x:
    get:
      - a
```

returns **one endpoint**, `GET /x`. With the other spelling it would return none.
The two neighbouring cases are the same either way — a document that is a
sequence is refused by `SwaggerParser.dereference` first, and a `paths` that is a
sequence gives zero endpoints down both branches.

**Not unified in this round, deliberately.** Making the four one requires picking
a spelling, and picking one changes what the tool does with a malformed
specification. That is a correctness decision with its own argument to make and
its own commit to make it in, not a side effect of a tidying round whose
constraint was that behaviour must not change. The measurement is recorded here
so the next person starts from the case rather than from the four copies.

### 4. The test tree against the source tree

Measured before this round's own additions. `src/` is 23 091 lines, `tests/`
43 732 — a ratio of 1.89. With comments and blank lines stripped it is 10 784
against 27 110, a ratio of **2.51**: the test tree is proportionally more code
and less prose than the source tree, where 53 % of the lines are commentary
against 38 % here.

Duplication was measured by hashing every window of 10 consecutive code lines,
keeping those that appear in two or more files, and extending each to its maximal
block:

| | `src/` | `tests/` |
|---|---|---|
| files | 71 | 130 |
| code lines | 10 784 | 27 110 |
| maximal duplicated blocks (≥ 10 lines, ≥ 2 files) | 2 | 24 |
| code lines inside one | 42 (0.4 %) | 733 (2.7 %) |
| lines that repeat an earlier copy | ~21 | ~411 |

411 lines of 27 110 is **1.5 %**. The most repeated single thing is an
in-process loopback stub: `server.listen(0, "127.0.0.1", …)` appears 17 times
across 12 test files, and the surrounding twelve lines of address-reading and
teardown are what four of the 24 blocks are made of. That is not enough to
justify moving fixtures between an invariant test and a unit test: a shared
fixture edited for one file's needs changes the other file's meaning silently,
which is the failure this repository is most careful about, and the stub differs
between callers in what it answers. No test was removed and none is proposed for
removal. The number is here so that the next round can compare against it rather
than re-deriving it.

## Decision

**Seven refusals that were written, were reachable, and were run by nothing now
have tests.** All seven are reachable through `parseRunConfig` or through the
library door, verified against the built tree before a line of test was written:

- a context id declared twice (`DuplicateContextIdError`);
- a context naming an account that is not declared (`UnknownContextAccountError`);
- a context query value that cannot go into an address;
- a context naming an endpoint the run does not have;
- a body signal naming an endpoint the run does not have;
- a header **value** naming a write method, at the seam rather than at the door —
  the third of the three layers CLAUDE.md describes, and the one it says catches
  a method override smuggled through an attribute;
- `PathEscapesTargetError` reaching a consumer as a class rather than as a
  substring of a `reason`.

Two of them raise error classes that no test and no document named anywhere; a
third does the same for a class whose `throw` runs four times a suite and is
caught every time by `staysWithinTarget`, inside the module that threw it.

**The unreachable `compareSubtree` loop keeps its lines and gains the
measurement**, in the shape `src/runner/canaries.ts` already uses: what makes it
unreachable, what would make it live again, and why the three lines are cheaper
than the assertion that deleting them would cost.

**The `isRecord` divergence is recorded and not fixed**, for the reason in §3.

## Alternatives

**Remove the thirteen unused exports now.** Rejected on the count: seven are
reserved values a consumer meets in an error message, two are on the surface by a
policy written down in `src/index.ts`, and the rest would need an argument each.
A breaking change that buys thirteen fewer names in a `d.ts` is not worth a major
version on its own; if one is taken for another reason, this list is where to
start.

**Unify `isRecord` to the majority spelling.** Rejected for this round: it
changes what the tool does with a malformed OpenAPI operation, and the round's
constraint was that behaviour must not change. Recorded in §3 with the case that
demonstrates it.

**Extract the duplicated test fixtures.** Rejected on the count: 411 lines of
27 110 — 1.5 % — and the coupling it introduces between an invariant test and a
unit test costs more than the lines do.

**Delete the unreachable branches instead of commenting them.** Rejected for both
of the two: the `Set` branch because deleting it turns a wrong digest into a
silent one, and the `compareSubtree` loop because what holds it up is a rule in
another module and a `RunConfig` a consumer can assemble by hand.

## Consequences

- Coverage moved without a threshold moving: statements 3 307 → 3 317 of 3 362,
  branches 2 277 → 2 284 of 2 399, functions 705 → 707 of 714, lines 3 220 →
  3 230 of 3 273. `src/io/config` went from 97.17 % of statements to 99.19 %,
  `contexts.ts` and `basis.ts` to 100 %.
- The suite is 1 943 passing tests in 126 files, up from 1 936.
- The published surface is unchanged at 242 values, which is what
  `docs/library.md` and `tests/public-surface.test.ts` both still say.
- The census is not held by a gate and is a snapshot of 24 August 2026. Nothing
  in this document should be read as a claim about a later tree; the numbers in
  `docs/library.md` are the ones a test keeps true.

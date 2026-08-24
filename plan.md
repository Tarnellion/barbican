# Roadmap

## Where it comes from

Sources: the technical report on the stack, the packages and the security requirements
(sections 1–5) and the decisions taken along the way, recorded in [docs/adr/](docs/adr/).

Where the report diverged from the actual state of the registry, verified data wins —
the discrepancies are listed in [ADR-0001](docs/adr/0001-stack-and-versions.md).

## Constraints

Solo, 8–10 hours a week, sessions of 2–3 hours — about 3–4 sessions a week.
The estimates below are in hours of effort, not calendar promises. Anchor: phase 0 and
session 2 of phase 1 closed on 11 August 2026.

| Phase | Content | Effort | Status |
|---|---|---|---|
| 0 | Skeleton: configs, hooks, CI, ADRs, the check registry | ~3 h | done |
| 1 | The core of Module 1: the matrix, the adapters, the CLI | ~9 h | done |
| 2 | Validation on public polygons | ~8 h | done |
| 3 | Multi-tenancy: a reference platform of our own | ~15–20 h | done |
| 4 | Stabilization and publishing | ~10 h | one criterion left |
| 5 | Module 2: the evidence pack | ~20 h | |

Module 1 works and is published: `barbican@0.2.0` went out through a release by
tag with provenance over OIDC. What phase 4 still lacks is its exit criterion,
not its content — see below.

Phase 3 was expected to be the largest and the most likely place to get stuck.
It was neither: the reference platform carries twelve switchable defects and 28
combinations that agree with a hand-written oracle cell for cell, and the whole
of it is plain Node without Docker. What actually took the time was everything
that came out of reading the report with someone else's eyes.

---

## Phase 1 — the core of Module 1

**Goal:** the tool walks the role × endpoint matrix over a real API and produces JSON.

| Session | Content | Status |
|---|---|---|
| 2 | Expected access policy separate from the observed matrix. Pure functions that build the matrix and the diff with a classification of discrepancies. Fixtures: two tenants, three roles. Coverage thresholds. | done |
| 3 | An OpenAPI parser with external `$ref` resolution disabled — **together with proof tests** — and protection against a YAML bomb. HTTP through the built-in global fetch. Throttling written by hand instead of `p-queue` (ADR-0001). | done |
| 4 | CLI: a mandatory host allowlist, `--unsafe-methods`, a JSON report, configuration with no secrets (ADR-0008). | done |

**Exit criterion:** a run against a local target produces a JSON report; without an
allowlist the tool refuses to start; response bodies are stored nowhere; the tests for
external `$ref` are in CI.

**Packages accepted:** `@apidevtools/swagger-parser`, `yaml`, `zod`. Rejected after
review: `p-limit` and `p-queue` (throttling was written by hand), `js-yaml` (no
protection against billion laughs), `picocolors` (there is a built-in
`node:util styleText`), `pino` and `fast-redact` (there are no tokens in the report by
construction, nothing to redact).

---

## Phase 2 — validation on public polygons

**Goal:** prove that the core finds known defects and does not invent ones that do not
exist.

1. **VAmPI — passed.** The run found three real discrepancies: `/users/v1/_debug`
   is open to everyone (a password leak) and `/users/v1` is available to an ordinary user.
   **But the `vulnerable=0/1` switch turned out to be useless as an oracle** — the modes
   are indistinguishable by response statuses, see [ADR-0009](docs/adr/0009-validation-oracle.md).
2. **crAPI — next.** Documented BOLA/IDOR, a mapping onto the OWASP API Top 10,
   an official docker-compose.
3. **Juice Shop — on leftover time.** A broad ground truth on broken access control.

**Exit criterion:** the defects from the hand-written list reproduce, and there are no
findings beyond the declared policy. The criterion "zero findings in the protected mode"
is dropped as trivially satisfied.

**A conflict surfaces here that needs an ADR** (see the open questions, item 1): some of
the BOLAs in crAPI are reachable only through an identifier from the body of a previous
response. Our invariant forbids storing bodies. Without a decision this class of defects
is structurally out of reach.

---

## Phase 3 — multi-tenancy: a reference platform of our own

**Goal:** validate the detection of cross-tenant leaks. Public polygons
are not multi-tenant — tenant isolation cannot be checked on them at all.

Content: an application with defects switchable through env — missing tenant filters in
the guards, role checks that can be turned off, IDOR by direct identifier.
Plus a machine-readable ground truth with the expected access matrix.

**Defects must show up in response codes.** Otherwise the platform repeats the
uselessness of the VAmPI switch: a difference visible only in the bodies does not exist
for the tool (ADR-0009). The role of this phase grew after the VAmPI check — it is the
only source of switchable defects fit to serve as an oracle.

**Exit criterion — met.** Every switchable defect is detected when it is on and produces
no finding when it is off, and the traceability between the findings and the ground truth
is reproducible: 29 combinations, 0 mismatches, run in CI rather than from a laptop. The
platform ended up bigger than the minimal version described above — twelve switches, a
three-level tenant tree, an account with a set of tenants, declared request conditions,
and since 14 August a write endpoint that keeps `--unsafe-methods` from being a code path
nothing had ever walked.

**This is the most expensive phase, and it is about writing a *second* application.** If
the pace slips, cut here: the minimal version is 3–4 endpoints, two tenants, three
switchable defects. A full platform is not needed; an oracle is.

---

## Phase 4 — stabilization and publishing

Done: publishing moved to npm trusted publishing over OIDC, with automatic provenance
and not a single long-lived token; `publishConfig.provenance` is back; `barbican@0.2.0`
went out through a release by tag and was checked from the registry, not from the build
log. `0.1.0` — a stub whose CLI registered no commands — is deprecated with a message
pointing at 0.2.0. User documentation is written and was rewritten twice from the
misunderstandings of cold readers. Changesets were vetted and rejected: 40 transitive
packages against a lockfile of 256, for a changelog on a project whose version is moved
by hand once every few days.

**Exit criterion — the run passed, the artifact failed it.** On 14 August someone
installed `barbican` from npm, read nothing but the README and the two guides, wrote
their own configuration and reached a meaningful run on the first attempt: 25 cells, a
deliberate cross-tenant defect found, exit 1. The safety promises held under experiment
rather than under reading — the redirect trap on a second port got zero requests, the
session cookie was `[REDACTED]`, the write endpoint was skipped and said so.

What failed was the package. The `v0.2.0` tag was cut from a commit whose README still
said "build from source until `0.2.0` is published", so the npm page argued against the
package it was serving; `files: ["dist"]` left the tarball with no guide and no example,
making every relative link dead for anyone who installed rather than cloned; and the CLI
in that release still spoke Russian around English documentation. All three are fixed on
`main` and none of them is fixed for anyone who runs `npm install barbican` today.

**Phase 4 closed on 17 August 2026 with the release of `0.3.0`**, which was its
stated exit criterion. `barbican@0.3.0` is on npm as `latest`, published through
the pipeline with provenance.

`0.4.0` followed on 18 August and is what `latest` points at today: the raw zod
schema is no longer in the published types, the signal extractor is exported at
last, and `basis` travels on observations rather than only on findings. Recording
it here is not bookkeeping — the version this file forgot to mention is the
version main then drifted twenty-one commits past, in silence, until the audit of
19 August. The rule that came out of that is
[ADR-0034](docs/adr/0034-what-main-carries-beyond-the-release.md), and the place
the drift is written down from now on is README's `### Unreleased` section.

The blocker this section named is gone: `release.yml` ran one CI gate of four —
`pnpm run check` — and skipped the secret scan over the history, the oracle
verification and the vulnerability scan, so a tag could publish a commit that
three quarters of CI had never seen, with provenance attesting to it. Since
15 August the release *calls* the CI workflow rather than repeating part of it,
and `tests/workflows/release-gate.test.ts` is what keeps the call there.

**What the release itself found**, and it is the second time this exact shape has
cost something: `0.3.0` shipped three changes to the report — `defects[].kind`
became `defects[].kinds`, `findingsOmitted` appeared, `coverage.checksRun[]`
gained a `description` — and the README section describing that version mentions
none of them. The first is breaking for a reader of schema 2. All three were
written down in ADRs, which is not a place a consumer looks. `v0.2.0` failed the
same way, in the other direction, and the guard written after it reads only the
lines mentioning the version being shipped — so it had nothing to say. It now
also asserts that the one sentence claiming a current release names the version
in `package.json`.

---

## Phase 5 — Module 2: the evidence pack

**The claim that this was architecturally prepared did not survive the audit of
14 August**, and the rework it called for was done on 15 August rather than at
the start of this phase — see [ADR-0025](docs/adr/0025-checks-are-plugins-in-fact.md).
Five gaps, each proven, all now closed: `standards` was declared and filled and
**read by no line of code**, so the promised "finding ↔ standard clause" matrix
could not be built from a saved report at all; a finding naming neither an
account nor an endpoint — the natural shape of "this clause is not covered" — was
silently discarded; the report layer imported a specific check;
`evidence.otherAccountId` was an undocumented contract between layers; and
`CheckContext` carried only the matrix, so the whole class "was enough tested for
this clause" was inexpressible rather than unwritten.

What that leaves for this phase: the shapes exist and are tested, and nothing
uses them yet. No registered check produces a run-level finding, and none reads
`CheckContext.scope`. **The estimate of ~20 h above was made under the assumption
the audit refuted; treat it as unknown.** It is smaller than it was — the schema
change and the core edits are behind us — and the part that was never estimated
is still ahead: the clause-by-clause content itself.

What holds, and held: the registry ([ADR-0003](docs/adr/0003-check-registry.md))
— registration, duplicate ids, a synchronous pure `run` — and now also a registry
assembled for a particular run, which that ADR described and the CLI did not
offer.

Content: a mapping of checks onto clauses of external standards (the reference point from
the report — GLI-19, the AGCO requirements), report generation from JSON as a separate
step, a traceability matrix "finding ↔ standard clause".

Rendering: `pdfkit` (active, released 2 months ago) or HTML → PDF through a headless
browser. `pdf-lib` is not to be considered — 57 months without a release.

**Start only after phase 3.** A mapping onto standards on top of an unvalidated core
gives a document that confirms compliance which does not exist — that is worse than
having no document.

**That condition is met as of 17 August 2026**: phase 3 closed with the reference
platform and its hand-written oracle — 29 combinations, 0 mismatches on every run
— and phase 4 closed with the release of `0.3.0`. This is the next phase, and the
first thing it needs is not code: the clause-by-clause content was never
estimated, and choosing which standard to map first (GLI-19, the AGCO
requirements, OWASP ASVS 5.0, which the existing check already cites) decides
what the rest of the phase looks like.

### The entry ticket, paid on 21 August 2026

That choice is made and three things it needed are in: **OWASP ASVS 5.0 first**.
It is public and under CC BY-SA, so clause identifiers can live in a public
repository; its numbering is stable; and the one registered check already cites
it. GLI-19 and the AGCO requirements are distributed under registration — their
numbers and texts cannot go into this repository at all — so the catalogue is
built to take a second standard by **registration from a source the repository
never sees**, and the invariant is about a run rather than about the tree: every
reference resolves against the catalogue assembled for that run
([ADR-0043](docs/adr/0043-a-catalogue-of-clauses.md)).

Three gaps the audit of 20 August found in what this phase was about to be built
on, all closed:

- **Matrix findings carried no clause at all**, so a traceability matrix built
  from a report would have covered the one registered check and not privilege
  escalation or cross-tenant access — that is, not the reason the tool exists
  ([ADR-0041](docs/adr/0041-a-matrix-discrepancy-answers-for-a-clause.md)).
- **A finding could not name the resource it was about**, so a check judging an
  object — the first kind Module 2 will write — produced a cell the report
  printed as agreed ([ADR-0039](docs/adr/0039-a-finding-names-the-whole-cell.md)).
- **One check throwing discarded the whole run**, at the step after the traffic
  had been spent. At one registered check that was theoretical; at fifty, written
  by more than one person, it is ordinary.

**The second direction of traceability is in, as of 22 August 2026.**
`coverage.clauses` is one row per clause either channel reached, and the sentence
a certifying body asks for — "8.2.2 was exercised across the surface and holds" —
is now something a saved report can be asked. Nothing in it is a percentage: a
row carries the cells that concluded and the cells that concluded nothing by
reason, plus the reservations that stop "exercised" from meaning "holds", because
claiming a clause covered over a surface the tool structurally could not see is
the same class of failure as a falsely clean run
([ADR-0052](docs/adr/0052-a-clause-can-be-reported-as-exercised.md)). The matrix
channel is still not a registered check; ADR-0041's reasoning for that is
unchanged, and this buys the time to make the move carefully rather than
replacing it.

Beside it, and about the artifact rather than its contents: **the report carries
a digest of itself** ([ADR-0051](docs/adr/0051-the-report-answers-for-itself.md)).
A document meant as the raw material of an evidence pack could be edited in a
text editor without a trace. `contentDigest` closes the careless half of that and
says out loud that it does not close the other one — a signature is named there
as not done, with the questions it needs answered first.

**Which clauses nothing answers is measured, as of 24 August 2026.** It had
never been. `findUncoveredClauses` subtracted the registered checks and not the
matrix channel, so over the sixteen bundled clauses it said thirteen where the
answer is nine: ASVS 8.1.1, 8.2.1, 8.2.2 and OWASP API5 are cited by
`standardsForDiff` on findings the tool produces every run. It is replaced by
`findUnansweredClauses`, over a table `clauseAnswers` derives from both channels,
and each of the nine now carries the sentence saying why nothing here answers it
— which is also the first thing a pack has to print beside a clause it is silent
about ([ADR-0069](docs/adr/0069-the-catalogue-says-what-is-unanswered.md)). The
clause paraphrases were checked against the published documents in the same pass;
four ASVS summaries and the ASVS boundary statement were narrowed to what their
source says.

What is still ahead and still unestimated: **the clause-by-clause content
itself**, and the rendering. The catalogue holds the part of ASVS V8 this tool
can speak to and now says which of it nothing answers; deciding what a pack
claims per clause, and what a reader of it is entitled to conclude, is the work
none of these ADRs does.

---

## Open questions that need an ADR

1. **Identifiers from responses against the ban on storing bodies.** Some BOLAs are
   reachable only through an `id` from the body of a previous response. The proposed
   direction: extract individual values along paths fixed in the code into a short-lived
   in-memory pool that never reaches the report. To be decided in phase 2, before the
   detectors of this class are written.
2. **The format of the machine-readable ground truth.** Shared between VAmPI, crAPI and
   our own platform, otherwise the validation is not reused. To be decided in phase 2.

Closed: where the expected matrix comes from — [ADR-0006](docs/adr/0006-expected-access-declaration.md),
the configuration format — [ADR-0008](docs/adr/0008-run-configuration-format.md).

---

## Thresholds for revisiting decisions

| What | Condition | Where we go |
|---|---|---|
| `@apidevtools/swagger-parser` | 18 months without a release. The latest is 12.1.0 of 14.10.2025, so the threshold arrives around **April 2027** | `@readme/openapi-parser` (7.0.1 of 07.08.2026, active) |
| TypeScript 7 | this project starts importing the compiler as a library while its API is still exported under `unstable/`, or a platform in use stops getting a binary | back to 6.x, or to whatever ships a stable API |
| The build through `tsc` | CJS or a bundle is needed | `tsup`, then `tsdown` |
| Biome | rules are missing | ESLint 9 flat + `oxlint` in CI |
| `fast-redact` (a candidate, not installed) | 28 months without a release; it mutates the source object | `@pinojs/redact` |
| `pdfkit` (a candidate, not installed) | it cannot carry the report we need | HTML → PDF as a separate step |
| Any dependency | a supply-chain incident | a 7-day cooldown gives time for a version to be pulled |

Check on every dependency update, and at least once a quarter.

### Reviewed 18 August 2026

Measured against the registry rather than recalled, since a table of conditions
nobody checks is the same as no table. Two of the rows are candidates that were
never installed — `fast-redact` is deferred by ADR-0001, `pdfkit` belongs to
module 2 — and they are marked as such above, because a row that reads like a
dependency invites somebody to go looking for it in the lockfile.

| Row | Measured | Fired? |
|---|---|---|
| `@apidevtools/swagger-parser` | latest 12.1.0 of 14.10.2025, 10 months ago | no — April 2027 stands |
| TypeScript 6 | 7.0.2 of 08.07.2026, 40 days old; the shipped README calls it the latest stable | **yes**, and acted on — ADR-0031 |
| `fast-redact` | latest 3.5.0 of 19.03.2024, 29 months ago | **yes**, against a threshold of 28 — but it is not installed, so what this settles is where to go if redaction ever needs a library: `@pinojs/redact`, 0.4.0 of 14.10.2025 |
| `pdfkit` | 0.19.1 of 10.06.2026, active | not yet applicable |
| The build through `tsc`, Biome | conditions are internal, nothing to measure | no |

**TypeScript, in detail, because the row now asks for a decision.** The second
half of the condition — "stabilizes its public API" — does not apply to this
project: nothing here imports the TypeScript API, `tsc` is invoked from the
command line in exactly two scripts. What was left to check was whether the
project builds, and it does, unchanged: `tsc --noEmit` under 7.0.2 is clean
against the same `tsconfig.json`, and `tsconfig.build.json` emits the same 26
JavaScript files. Byte-for-byte the same, with one exception —
`core/types.d.ts`, where 7.0.2 keeps the per-element doc comments on
`RESOURCE_RELATIONS` that 6.0.3 dropped, which is a gain for a consumer reading
the declarations. Type checking takes 0.2–0.3 s against 2.3–2.4 s.

That was the measurement. The decision followed on 19 August in ADR-0031, which
also records the half of the condition being set aside: the programmatic API is
still exported under `unstable/`, and this project never imports it. `dist-tags`
was not the evidence for "left preview" and could not have been — ADR-0001 shows
7.0.2 was already on `latest` while its README still carried the warning. The
shipped package's README is.

---

## Risks

**Phase 3 — a second application.** The biggest chance that the project stalls.
Mitigation: cut down to a minimal oracle instead of building a platform.

**False positives.** A tool that "finds" things that do not exist loses trust on the
first run. That is why VAmPI with the defects switched off comes before crAPI.

**Pace drift.** 8–10 hours a week is an optimistic estimate alongside a full-time job.
Phases 1 and 2 are self-contained: if the project stops after them, what is left is a
working tool without an evidence pack, not half of both modules.

---

## What is deliberately out of the roadmap

Monorepo and workspaces. Orchestration and "architecture to grow into". A web interface.
Continuous monitoring and a scheduler for runs. GraphQL and gRPC support —
REST and OpenAPI only, until Module 1 is stable.

## Directory boundaries

They are created in the session where the first real implementation appears — there are
no empty directories "for the future" in the repository.

| Directory | Purpose | Appears |
|---|---|---|
| `src/core` | Pure functions: the matrix, the diffs, the checks | exists |
| `src/adapters` | The HTTP client, the spec parser, throttling — behind ports | the ports exist, the implementations in phase 1 |
| `src/io` | Reading specs and accounts, writing JSON | phase 1, session 4 |
| `src/report` | Building the JSON report and its verdict | exists since phase 1; HTML/PDF rendering is phase 5 |
| `tests/fixtures` | Core fixtures, no network | phase 1, session 2 |
| `tests/integration` | Never created: the polygon runs go through `polygon/verify.mjs` against the built CLI, which is closer to how the tool is used | dropped |

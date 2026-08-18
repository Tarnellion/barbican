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
| TypeScript 6 | TS 7 leaves preview and stabilizes its public API | migrate to 7.x |
| The build through `tsc` | CJS or a bundle is needed | `tsup`, then `tsdown` |
| Biome | rules are missing | ESLint 9 flat + `oxlint` in CI |
| `fast-redact` | 28 months without a release; it mutates the source object | `@pinojs/redact` |
| `pdfkit` | it cannot carry the report we need | HTML → PDF as a separate step |
| Any dependency | a supply-chain incident | a 7-day cooldown gives time for a version to be pulled |

Check on every dependency update, and at least once a quarter.

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

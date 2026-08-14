# Roadmap

## Where it comes from

Sources: the technical report on the stack, the packages and the security requirements
(sections 1–5) and the decisions taken along the way, recorded in [ADR 0001–0010](docs/adr/).

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
It was neither: the reference platform carries ten switchable defects and 25
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

**Exit criterion:** every switchable defect is detected when it is on and produces no
finding when it is off; traceability between the findings and the ground truth is
reproducible.

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

**Exit criterion — not met, and it is the only thing left in this phase:** an outsider
following the README gets `npx barbican` to a meaningful run. Two cold reads have
happened, but both read the *report* and the guides; the README and the installation
path have never been read by anyone but their author. Until `0.2.0` that check was not
even worth running — the published CLI was a stub — and now it is.

---

## Phase 5 — Module 2: the evidence pack

Architecturally it is already prepared: the `standards` field in the `Check` interface
and the check registry ([ADR-0003](docs/adr/0003-check-registry.md)). It is added by
registering checks.

Content: a mapping of checks onto clauses of external standards (the reference point from
the report — GLI-19, the AGCO requirements), report generation from JSON as a separate
step, a traceability matrix "finding ↔ standard clause".

Rendering: `pdfkit` (active, released 2 months ago) or HTML → PDF through a headless
browser. `pdf-lib` is not to be considered — 57 months without a release.

**Start only after phase 3.** A mapping onto standards on top of an unvalidated core
gives a document that confirms compliance which does not exist — that is worse than
having no document.

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
| `src/report` | Rendering JSON into HTML/PDF as a separate step | phase 5 |
| `tests/fixtures` | Core fixtures, no network | phase 1, session 2 |
| `tests/integration` | Runs against the polygons | phase 2 |

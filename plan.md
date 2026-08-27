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
| 4 | Stabilization and publishing | ~10 h | done, 17 August 2026 |
| 5 | Module 2: the evidence pack | ~20 h, an estimate this document then withdrew | done, 24 August 2026 |

**Those two status cells said "one criterion left" and nothing at all until 26
August 2026**, and both were refuted further down this same document: phase 4
records its own closure on 17 August with the release of `0.3.0`, phase 5 records
its own on 24 August. The table is the part a reader looks at first and the part
nobody edits when a phase closes, so this summary was nine days behind the body it
summarises for phase 4 and two days behind for phase 5.

Both modules are published: `barbican@0.7.0` is what `npm install barbican` gives,
released through the pipeline with provenance over OIDC. **This paragraph named
`0.2.0` until 26 August 2026** — five releases behind — and the sentence that
followed it, "what phase 4 still lacks is its exit criterion", had been false since
17 August. Measured on 26 August 2026: `package.json` says `0.7.0`, `npm view
barbican dist-tags` answers `latest: 0.7.0`, and the repository carries six tags,
`v0.2.0` through `v0.7.0`.

Phase 3 was expected to be the largest and the most likely place to get stuck.
It was neither: the reference platform carries twelve switchable defects and 29
combinations that agree with a hand-written oracle cell for cell, and the whole
of it is plain Node without Docker. What actually took the time was everything
that came out of reading the report with someone else's eyes.

**That number said 28 until 26 August 2026, and how it survived is worth the
line.** The gate went from 28 combinations to 29 on 18 August, and commit
`08c88c1` corrected the two live claims it found by searching this file for the
phrase "28 combinations" — the phase 3 exit criterion and the phase 5 entry
condition, both of which are right below and have been right since. Here the
number ends one line and the word begins the next, so the phrase does not occur
in this file at all and the search passed over it. It cost nothing; the correct
number was two sections down the whole time. But a count that a search-and-replace
cannot see is the same defect as a count nobody re-measures, and it is the one a
reader is least likely to suspect. Measured on 26 August 2026 by running `node
polygon/verify.mjs` in the foreground against port 9102: `Total: 29 combinations,
0 mismatches.`

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
2. **crAPI — passed, 13 August 2026.** Documented BOLA/IDOR, a mapping onto the
   OWASP API Top 10, an official docker-compose. `polygons/crapi/` holds the
   declaration, a hand-written oracle in the format of
   [ADR-0012](docs/adr/0012-ground-truth-format.md) and a `verify.mjs` that uses
   the shared `tools/oracle` module — the same one VAmPI and the reference
   platform use. The run and its numbers are in
   [docs/polygons/crapi.md](docs/polygons/crapi.md).

   **This item said "next" until 24 August**, eleven days after it was done, and
   the line above is the correction. Nothing checked it: the polygon oracles are
   not in CI and not in `pnpm run check`, so a phase item can stay open in this
   document while the work sits finished in the tree beside it. Re-verified on
   24 August against `0.7.0` — 60 cells, 16 findings against 16 expected, 0
   mismatches — which is the only evidence that seven days of cutting modules
   apart did not break it.
3. **Juice Shop — passed, 18 August 2026.** A broad ground truth on broken access
   control, and the one of the three that is only about ownership and
   authentication: Juice Shop has no tenancy, so it covers half of what the
   reference platform does and nothing should read it as covering the other half.
   `polygons/juice-shop/` holds the declaration, the hand-written endpoint list,
   a hand-written oracle in the format of
   [ADR-0012](docs/adr/0012-ground-truth-format.md), a `tokens.mjs` that registers
   the two customers, and a `verify.mjs` on the shared `tools/oracle` module. The
   recon it was built from is in
   [docs/polygons/juice-shop.md](docs/polygons/juice-shop.md).

   **This item said "on leftover time" until 26 August 2026**, eight days after it
   was done — the same failure as item 2 above, in the same list, on the same day
   it was found there, and it was not corrected then because only the item that
   had already misled somebody was looked at. It has now misled somebody too: a
   session on 26 August was told to treat it as open.

   The numbers are second-hand and said so. The build and its first run are
   `tasks.md:181` — ten defects and twenty-five findings over sixty-nine cells,
   agreeing on the first attempt.
   The adversarial review of 19 August then widened the oracle to eleven defects
   over twenty-eight expected findings across sixty-nine cells and proved the new
   rows by mutation. Read out of `polygons/juice-shop/ground-truth.json` on 26
   August rather than by bringing the container up, which is outside a
   documentation pass: eleven defects, twenty-eight findings, `expectedCells: 69`.

**Exit criterion:** the defects from the hand-written list reproduce, and there are no
findings beyond the declared policy. The criterion "zero findings in the protected mode"
is dropped as trivially satisfied.

**A conflict surfaced here that needed an ADR, and it got one on 24 August 2026:**
[ADR-0071](docs/adr/0071-an-identifier-from-a-body-is-not-worth-a-pool.md), and the
answer is that there was less here than the paragraph claimed. **Until 26 August
this read "a conflict surfaces here that needs an ADR ... without a decision this
class of defects is structurally out of reach"** — an open item pointing at open
question 1, which had been closed for two days, and a claim the closing ADR
measured and refuted. Of crAPI's eighteen numbered challenges the count blocked
*solely* by the ban on storing bodies is **zero**: the motivating vehicle GUID is a
constant of the seed, proven by `docker compose down -v` and a re-seed, so it is
declared in `resources[]` like any other resource; the rest are blocked by
something else or by nothing. "Structurally out of reach" was the estimate, and the
price had never been taken.

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
by hand once every few days. (Both numbers are the measurement of the day the decision
was taken and are left as they stand; the lockfile holds 148 packages on 26 August 2026,
which makes the ratio the decision rested on larger, not smaller.)

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
in that release still spoke Russian around English documentation. All three were fixed
on `main`, and they reached the registry in `0.3.0` on 17 August 2026.

**That last sentence read "none of them is fixed for anyone who runs `npm install
barbican` today" until 26 August 2026.** It was true when it was written on 14
August and false three days later, and "today" is the word that made it rot: a
sentence anchored to the reader's clock rather than to a date has no state at
which somebody would think to re-check it. `npm install barbican` gives `0.7.0`,
measured on 26 August 2026.

**Phase 4 closed on 17 August 2026 with the release of `0.3.0`**, which was its
stated exit criterion. `0.3.0` was published through the pipeline with provenance,
and it was `latest` on npm until `0.4.0` followed the next day.

The sentence above said "`barbican@0.3.0` is on npm as `latest`" in the present
tense for eight days, through four more releases. It was corrected on 26 August by
the review of the pass that audited this file — which had declared this class of
staleness closed twenty-two lines above. Present tense about a moving thing is the
defect
[ADR-0075](docs/adr/0075-a-count-of-this-tree-is-measured-where-it-is-written.md)
is about, and a version on
a registry moves without anybody in this repository touching a file, which is why
no gate here can catch it and why it is written in the past tense now.

`0.4.0` followed on 18 August: the raw zod schema is no longer in the published
types, the signal extractor is exported at last, and `basis` travels on
observations rather than only on findings. Recording it here is not bookkeeping —
the version this file forgot to mention is the version main then drifted
twenty-one commits past, in silence, until the audit of 19 August. The rule that
came out of that is
[ADR-0034](docs/adr/0034-what-main-carries-beyond-the-release.md), and the place
the drift is written down from now on is README's `### Unreleased` section.

**And this paragraph then made the same mistake it was written about.** It said
`0.4.0` "is what `latest` points at today", and `0.5.0`, `0.6.0` and `0.7.0`
followed it, so the line was wrong from 22 August until 26 August 2026 — the
document recording a release that went unmentioned, itself going unmentioned three
times over. ADR-0034 put the running description in README's `### Unreleased`
section and a gate on it, `tests/docs/release-readme.test.ts`; nothing was put on
this file, which is the whole answer to why the same shape recurred here. **This
file should not carry which version is current at all** — README's Install section
does, under a gate — and the two sentences above have been rewritten to record
what `0.4.0` contained and to stop naming a `latest`. Measured on 26 August 2026:
`npm view barbican dist-tags` answers `latest: 0.7.0`.

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

What that left for this phase, written while it was open: the shapes exist and are
tested, and nothing uses them yet. **The estimate of ~20 h above was made under the
assumption the audit refuted; treat it as unknown.** It is smaller than it was —
the schema change and the core edits are behind us — and the part that was never
estimated is still ahead: the clause-by-clause content itself.

**Read as of 26 August 2026, with the phase closed.** The estimate was never
settled and is not settled now; what the phase actually cost is not recorded
anywhere, so this document has no honest number to put there and does not invent
one. The clause-by-clause content is behind us. Two of the sentences this
paragraph used to carry, however, are still true of the code and have been moved
out of the past tense rather than deleted: **no registered check produces a
run-level finding, and nothing reads `CheckContext.scope`.** Measured on 26
August 2026 — `src/cli/run.ts` registers exactly one check,
`createIdenticalResponseCheck()`, and every finding it builds names both an
`endpointId` and an `accountId`; `grep` for `context.scope` across `src/` returns
nothing, so the field declared in `src/core/checks/types.ts` is still read by no
line of code. That is the same shape as the `standards` gap the audit of 14 August
found, one field further along, and it is a live claim rather than a phase item.

What holds, and held: the registry ([ADR-0003](docs/adr/0003-check-registry.md))
— registration, duplicate ids, a synchronous pure `run` — and now also a registry
assembled for a particular run, which that ADR described and the CLI did not
offer.

Content, as planned: a mapping of checks onto clauses of external standards (the
reference point from the report — GLI-19, the AGCO requirements), report generation
from JSON as a separate step, a traceability matrix "finding ↔ standard clause".
All three shipped, and the first standard is OWASP ASVS 5.0 rather than GLI-19 for
the licensing reason set out under the entry ticket below.

Rendering was an open choice here — `pdfkit` or HTML → PDF through a headless
browser — and **it was decided on 24 August 2026 and this paragraph was not
updated until 26 August**:
[ADR-0068](docs/adr/0068-a-pack-is-drawn-from-the-json.md) chose one
self-contained HTML file with hand-written escaping, printed to PDF by the
reader's own browser if a PDF is wanted. No renderer is installed and none is
going to be. The threshold table below already carried the outcome, so for two
days this file argued both ways about the same decision.

The two numbers this paragraph carried have both moved, which is the reason the
threshold table is the place for them and this one is not. `pdfkit` was "active,
released 2 months ago" against a measurement in June; measured on 26 August 2026
its latest is `0.20.1` of 23.08.2026, three days old. `pdf-lib` was "57 months
without a release": measured on 26 August 2026 its last published version is
`1.17.1` of 06.11.2021, which is 57 months to the month — right today, and 58 from
6 September 2026, without anybody touching either package.

**Start only after phase 3.** A mapping onto standards on top of an unvalidated core
gives a document that confirms compliance which does not exist — that is worse than
having no document.

**That condition was met as of 17 August 2026**: phase 3 closed with the reference
platform and its hand-written oracle — 29 combinations, 0 mismatches on every run
— and phase 4 closed with the release of `0.3.0`. The first thing the phase needed
was not code: the clause-by-clause content was never estimated, and choosing which
standard to map first (GLI-19, the AGCO requirements, OWASP ASVS 5.0, which the
existing check already cites) decided what the rest of it looked like. That choice
is the section below. **"This is the next phase" stood here until 26 August 2026**,
five days after the choice was made and two after the phase closed.

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

**Both of those landed on 24 August 2026, and phase 5 is closed.** What a pack
claims per clause is `src/report/pack.ts` and
[ADR-0067](docs/adr/0067-an-evidence-pack-says-what-it-checked.md): six claims,
and three of them — `inconclusive`, `unanswered`, `withheld` — say something
about the run rather than about the platform, which is the half a reader
otherwise mistakes for the first. A clause nothing answers is never "passed", and
a run that exited 2 withholds `upheld` while keeping `breached`, because a later
failure of the run does not un-observe what was already seen. The rendering is
`src/report/page.ts` and `barbican pack`
([ADR-0068](docs/adr/0068-a-pack-is-drawn-from-the-json.md)): one self-contained
HTML file, hand-written escaping, nothing fetched from anywhere. Both shipped in
`0.7.0`.

**So both modules are done and published, and this document has no phase 6.**
What is left in it is smaller than a phase and is listed here so that it is not
mistaken for nothing. **Two of the four entries below were not open when the list
was written on 24 August 2026, and are struck through as of 26 August**; what is
genuinely left is the two that remain:

- ~~**Juice Shop — phase 2, item 3**~~ — **not open, and it was not open when this
  list was written on 24 August 2026.** The entry said so because it read phase 2
  item 3 above, which still said "on leftover time"; the polygon had been built and
  run on 18 August. Corrected 26 August 2026, together with the item it was reading.
  This is the second time a wrong line in phase 2 was copied outward rather than
  checked — the first copied it into `CLAUDE.md` — and both copies were made by a
  reader doing exactly the right thing with a document that is supposed to describe
  the present.
- **The polygon oracles run nowhere but by hand.** VAmPI, crAPI and Juice Shop
  each have a `verify.mjs`, and none of them is in CI or in `pnpm run check` —
  crAPI's needs an external clone and about 2.5 GB of images, which is a real
  reason, and the consequence is that it went unrun for eleven days while this
  document said it had never run at all. Whether that is worth a scheduled job
  is a decision nobody has taken. Confirmed on 26 August 2026: the only oracle
  either gate runs is `polygon/verify.mjs --check-readme`, in `ci.yml`, and
  `pnpm run check` is `lint && typecheck && test:coverage && build`.
- ~~**Open question 2**, the shared ground-truth format.~~ **Answered by
  [ADR-0012](docs/adr/0012-ground-truth-format.md) on 12 August 2026**, which is
  before this list was written and before three of the four oracles existed. This
  entry said the question was "further along than this section implies" and that
  the shared module was "most of what the question asked for" — it was all of it,
  and the ADR that says so is cited twice elsewhere in this file. Measured on 26
  August 2026: `tools/oracle/index.mjs` is imported by four `verify.mjs` files —
  `polygon/`, `polygons/vampi/`, `polygons/crapi/`, `polygons/juice-shop/` — and
  the entry said "all three polygons", which undercounts by leaving out the
  reference platform, the oracle the question was originally about.
- **A run against a platform somebody actually operates.** Not in this document
  at all, and the one thing the reference platform cannot substitute for: a cold
  start against the published `0.6.0` on 24 August found a defect no gate in this
  repository could have — the report prints `relation` and a declaration asks for
  `scope`. Forty lines of stub found that. A real deployment will find more.

---

## Open questions that need an ADR

1. ~~**Identifiers from responses against the ban on storing bodies.**~~ **Closed
   24 August 2026, and the answer is no** —
   [ADR-0071](docs/adr/0071-an-identifier-from-a-body-is-not-worth-a-pool.md). The
   price was measured rather than estimated: of crAPI's eighteen challenges, the
   number blocked *solely* by the ban is **zero**. The motivating case — a vehicle
   GUID — turned out to be a constant of the seed, proven by tearing the volumes
   down and re-seeding, so it is declared in `resources[]` like any other resource.
   And the proposed pool could not have carried it anyway: it was to hold scalars,
   `SignalValue` is a number or a boolean, and a GUID is a string.
2. ~~**The format of the machine-readable ground truth.**~~ **Closed 12 August 2026** —
   [ADR-0012](docs/adr/0012-ground-truth-format.md), written the day the second oracle
   diverged from the first. **This item said "to be decided in phase 2" until 26 August
   2026**, fourteen days after it was decided and eight days after phase 2's own last
   item closed — Juice Shop, on 18 August — while phase 2 item 2 and item 3
   above both cite the deciding ADR by name
   for the format their oracles are written in. A document can hold a question and its
   answer at once as long as nothing reads it end to end, and until 26 August nothing
   had. One shape, `tools/oracle/index.mjs`, and four oracles on it: the reference
   platform, VAmPI, crAPI, Juice Shop.

Closed: where the expected matrix comes from —
[ADR-0006](docs/adr/0006-expected-access-declaration.md),
the configuration format — [ADR-0008](docs/adr/0008-run-configuration-format.md),
the ground-truth format — [ADR-0012](docs/adr/0012-ground-truth-format.md), and
identifiers from response bodies —
[ADR-0071](docs/adr/0071-an-identifier-from-a-body-is-not-worth-a-pool.md).

**Nothing on this list is open as of 26 August 2026.** Both numbered items are struck
through, and the section keeps its heading and its struck entries rather than being
deleted, because "these were the questions and this is where each was answered" is the
part worth having.

---

## Thresholds for revisiting decisions

| What | Condition | Where we go |
|---|---|---|
| `@apidevtools/swagger-parser` | 18 months without a release. The latest was 12.1.0 of 14.10.2025 when this row was written, and still is on 27 August 2026, so the threshold arrives around **April 2027** | `@readme/openapi-parser` — 8.0.1 of 27.08.2026, and very active: the row said 7.0.1 of 07.08.2026 and was two majors behind within three weeks |
| TypeScript 7 | this project starts importing the compiler as a library while its API is still exported under `unstable/`, or a platform in use stops getting a binary | back to 6.x, or to whatever ships a stable API |
| The build through `tsc` | CJS or a bundle is needed | `tsup`, then `tsdown` |
| Biome | rules are missing | ESLint 9 flat + `oxlint` in CI |
| `fast-redact` (a candidate, not installed) | 28 months without a release; it mutates the source object | `@pinojs/redact` |
| `pdfkit` | not installed, and now not needed: ADR-0068 chose one self-contained HTML file, printed to PDF by the reader's own browser. The row stays as the record of a candidate that was weighed and dropped | — |
| Any dependency | a supply-chain incident | a 7-day cooldown gives time for a version to be pulled |

Check on every dependency update, and at least once a quarter. Two reviews are
below, the most recent first: a re-measurement on 26 August 2026 that answered the
four rows a registry can answer, and the full review of 18 August. A quarter from
the full one puts the next by **18 November 2026**; the re-measurement does not
reset that clock, because it read four rows and not the reasoning behind the
others.

### Re-measured 26 August 2026

Only the four rows a registry can answer, and only against the registry — the two
internal conditions have nothing to measure. Nothing fired that had not fired
already, and no row's condition or destination changed.

| Row | Measured 26 August 2026 | Fired? |
|---|---|---|
| `@apidevtools/swagger-parser` | `latest` is still 12.1.0, published 14.10.2025; the installed version is the same | no — 10 months of the 18, April 2027 stands |
| TypeScript | `latest` is still 7.0.2 of 08.07.2026, which is what this project builds with; `7.1.0-dev` publishes nightly and `unstable/` is still where the programmatic API lives | no — and the half-condition ADR-0031 set aside is still set aside |
| `fast-redact` (not installed) | still 3.5.0 of 19.03.2024, now 29 months | already fired in the review below; nothing changes, because nothing depends on it |
| `pdfkit` (not installed) | 0.20.1 of 23.08.2026 — two releases since the row below was written, three days old | not applicable, and now permanently so: ADR-0068 chose HTML |

The `pdfkit` row is the useful one, and not for `pdfkit`. It moved twice in eight
days while the table said "0.19.1 of 10.06.2026, active", which is what a
measurement dated in its own heading is *supposed* to do — the heading is what
stops the number being read as current. The rows that hurt in this document are
the ones with no date on them.

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

These were written before phase 3. **All three are now settled, and they are kept
rather than deleted because what a risk turned out to be worth is the part a next
roadmap can use.** Reviewed 26 August 2026.

**Phase 3 — a second application.** The biggest chance that the project stalls.
Mitigation: cut down to a minimal oracle instead of building a platform. **It did not
stall, and the mitigation was not needed**: phase 3 closed on 17 August with a
platform larger than the minimal version this document offered to fall back to —
twelve switches and 29 combinations rather than three and two. The risk was real and
the estimate of it was the wrong way round; the phase this document called the most
likely place to get stuck is the one whose exit criterion has held on every run since.

**False positives.** A tool that "finds" things that do not exist loses trust on the
first run. That is why VAmPI with the defects switched off comes before crAPI. **This
one held its shape**: four independent hand-written oracles now answer it rather than
one, and the property they check is the negative — 0 mismatches means no finding
beyond the declared policy, not only that the declared defects were found.

**Pace drift.** 8–10 hours a week is an optimistic estimate alongside a full-time job.
Phases 1 and 2 are self-contained: if the project stops after them, what is left is a
working tool without an evidence pack, not half of both modules. **The fallback was
never taken**: both modules shipped, six releases in twelve days. What this document
cannot say is what either phase cost in hours, because nothing here ever recorded
one — which is why the phase 5 estimate above is withdrawn rather than corrected.

---

## What is deliberately out of the roadmap

Monorepo and workspaces. Orchestration and "architecture to grow into". A web interface.
Continuous monitoring and a scheduler for runs. GraphQL and gRPC support —
REST only.

**Checked against the tree on 26 August 2026, and nothing on this list has arrived**,
but two entries needed narrowing and one needs a note.

- **Monorepo and workspaces** holds. `pnpm-workspace.yaml` exists and is easy to
  misread as the opposite: it carries the supply-chain settings —
  `minimumReleaseAge`, `minimumReleaseAgeExclude`, `strictDepBuilds`,
  `allowBuilds`, `engineStrict` and `savePrefix` — and has no `packages:` key. One
  package, one `src`. (`overrides` was in this list until 26 August and is not a
  key of that file; the enumeration was written from the rule about overrides in
  `CLAUDE.md` rather than from the file.)
- **A web interface** holds, and `barbican pack` is not one. It writes a single
  self-contained HTML file with nothing fetched from anywhere (ADR-0068) — a document
  the reader opens, not a server, not a page that talks to the tool. `src/report/page.ts`
  renders it and no HTTP server ships with the package.
- **Continuous monitoring and a scheduler** holds. Nothing in `src/` schedules anything;
  the two files that match a search for "schedule" match on the English word.
- **"REST and OpenAPI only, until Module 1 is stable" was wrong in both halves and is
  narrowed above.** OpenAPI is not the boundary and has not been since phase 1: the tool
  also reads a Postman collection (`src/adapters/postman.ts`) and a hand-written endpoint
  list (`src/adapters/endpoint-list.ts`), and the exclusion is about the protocol, not
  about where the endpoints come from. And "until Module 1 is stable" is a condition that
  has now arrived — Module 1 shipped — without anybody deciding anything, which is how a
  deferral becomes an omission. Nothing here proposes taking it up; the sentence is cut
  so that it stops promising a review that is not scheduled.

## Directory boundaries

They are created in the session where the first real implementation appears — there are
no empty directories "for the future" in the repository. Still true on 26 August 2026:
`find src tests -type d -empty` returns nothing.

**The table was written as a plan and never turned into a description**, so it
described four of the six directories under `src/` and, under `tests/`, one of the
eleven that exist plus one that never did — `tests/integration`, which the same
table marks "never created". Its rightmost column still said which phase would
create things that have existed for a fortnight. Rewritten 26 August 2026 against the tree; the two
missing `src` rows were added, and the "Appears" column becomes "Since", because a
directory that exists has a date and not a promise.

| Directory | Purpose | Since |
|---|---|---|
| `src/core` | Pure functions: the matrix, the diffs, the checks, the clause catalogue | 11 August 2026, phase 0 |
| `src/adapters` | The HTTP client, the spec and Postman parsers, credentials, signals, throttling — behind the ports in `ports.ts` | 11 August 2026, ports first and implementations in phase 1 |
| `src/io` | Reading configuration and accounts, writing JSON, and `untrusted.ts` — the grammar every string from outside passes through | 12 August 2026; `config/` became a directory of its own on 23 August, ADR-0055 |
| `src/report` | Building the JSON report and its verdict, and drawing the evidence pack | 12 August 2026; HTML rendering arrived with ADR-0068 in `0.7.0`, and PDF never will — the reader's browser prints it |
| `src/cli` | The option grammar, the wording an operator reads, and the four subcommands — `run`, `diff`, `pack`, `schema` | 23 August 2026, ADR-0056 — cut out of a `src/cli.ts` that had reached 1872 lines |
| `src/runner` | The walk itself: planning it, addressing it, streaming it, the canaries | 23 August 2026, ADR-0057 |
| `tests/fixtures` | Core fixtures, no network | 11 August 2026, phase 1 session 2 |
| `tests/docs` | The gates over the documentation: the repository language, every link in every tracked markdown file, README's release section, and the worked examples the guides print | 14 August 2026 |
| `tests/invariants` | The gates over decisions with one home — the verdict seams and the transport rules first, then the source-text scans of ADR-0059 to ADR-0066 | 21 August 2026 |
| `tests/integration` | Never created: the polygon runs go through `polygon/verify.mjs` against the built CLI, which is closer to how the tool is used | dropped, and still absent |

The rest of `tests/` mirrors `src/` one directory per module — `adapters`, `cli`,
`core`, `io`, `report`, `runner` — plus `tools` and `workflows`, and is not listed
row by row here for the reason the whole table nearly went wrong: an enumeration
nothing checks is a list that stops being true the first time somebody adds a
directory. `find src tests -maxdepth 1 -type d` is the answer that cannot go stale.

---

## Why this document went stale, and whether it is worth a gate

Read line by line on 26 August 2026, after two wrong decisions in one day were
traced to two lines of it. Nineteen claims came back false or misleading. The
interesting part is not any one of them but that they failed the same way, and
that the three documents it is usually read beside — `README.md`, `tasks.md` and
the ADRs — do not. This repository tracks 107 markdown files; "the three other
documents" was this sentence's first version, and it meant the three it is read
beside rather than the three that exist.

| # | The claim | Wrong since | Days |
|---|---|---|---|
| 1 | Phase table: phase 4 "one criterion left" | 17 Aug, when phase 4 closed | 9 |
| 2 | Phase table: phase 5 status empty | 24 Aug, when phase 5 closed | 2 |
| 3 | "Module 1 … is published: `barbican@0.2.0`" as the published state | 17 Aug, `0.3.0` | 9 |
| 4 | "what phase 4 still lacks is its exit criterion" | 17 Aug | 9 |
| 5 | "28 combinations" | 18 Aug, when the gate went to 29 | 8 |
| 6 | Phase 2 item 3: "Juice Shop — on leftover time" | 18 Aug, when it was built and run | 8 |
| 7 | "a conflict … needs an ADR … structurally out of reach" | 24 Aug, ADR-0071 — and the second half was never measured at all | 2 |
| 8 | "none of them is fixed for anyone who runs `npm install barbican` today" | 17 Aug | 9 |
| 9 | "`0.4.0` … is what `latest` points at today" | 22 Aug, `0.5.0` | 4 |
| 10 | "What that leaves for this phase" | 24 Aug | 2 |
| 11 | Rendering as an open choice between `pdfkit` and HTML | 24 Aug, ADR-0068 | 2 |
| 12 | "`pdfkit` (active, released 2 months ago)" | 23 Aug, `0.20.1` | 3 |
| 13 | "This is the next phase" | 24 Aug | 2 |
| 14 | Leftovers: "Juice Shop — the one still open" | written wrong on 24 Aug | 2 |
| 15 | Leftovers: `tools/oracle` shared by "all three polygons", "most of what the question asked for" | written wrong on 24 Aug — four oracles, and all of what it asked for | 2 |
| 16 | Open question 2: "to be decided in phase 2" | 12 Aug, ADR-0012 | 14 |
| 17 | "REST and OpenAPI only, until Module 1 is stable" | the OpenAPI half since phase 1; the condition has now arrived | — |
| 18 | Directory boundaries: four of six `src` directories, and a column promising phases already past | 23 Aug, when `src/cli` and `src/runner` appeared | 3 |
| 19 | Risks: three risks written before phase 3, none marked settled | 17 Aug | 9 |

Eighteen of the nineteen carry a day the claim stopped being true and a count
of days it stood. Row 17 carries neither, and the dash is the honest entry: a
scope line saying "until Module 1 is stable" did not become false on a date —
its condition arrived, which is a different thing, and picking a day for it
would be inventing one to fill a column.

**`tasks.md` is a log and rots harmlessly.** Every entry is past tense and carries
the date it was measured on, so an entry that no longer describes the tree is simply
an old entry — which is what it always was. Its Juice Shop entry still says ten
defects and twenty-five findings; the oracle has held eleven and twenty-eight
since 19 August, over the same sixty-nine cells it walked then and walks today —
the cell count never moved, and calling twenty-five a count of cells was this
document's own slip, corrected 26 August; nothing there is wrong, because the
entry never claimed to be about now.
**`README.md` has a gate** — `tests/docs/release-readme.test.ts`, which holds the
`### Unreleased` section and asserts that the sentence naming a current release names
the version in `package.json`. **ADRs are dated records that are not supposed to
move**, and ADR-0065 makes the rule explicit: where an earlier version claimed too
much, the correction stays visible rather than being edited away.

`plan.md` is written in the **present tense** about a tree that changes daily,
and nothing gates what it *claims*. `CLAUDE.md` is in the same position and is
not an exception to be quiet about — no test reads its assertions either, and it
carried "crAPI, which never ran" for part of 24 August because a session copied
this file's error into it.

This file is not ungated: `tests/docs/language.test.ts` holds its language and
`tests/docs/links.test.ts` holds its links — which is why all twenty of its link
targets resolve today and none of the nineteen failures in the table above is a
dead link.
"Every link in it" is what this sentence said until the review measured it: a
link whose target is carried onto the next line is not collected, so the gate
holds every link written on one line.
What no gate reads is the sentences. Present tense plus no gate over the claims is
the whole mechanism, and it explains the direction as well as the fact:
eighteen of the nineteen drifted **towards claiming less had been done** — the
nineteenth is the freshness of somebody else's package in a registry, which is
not about work done here at all. "Next",
"on leftover time", "one criterion left", "this is the next phase", "to be decided
in phase 2" — a sentence written while something is open stays written when it
closes, because closing it is work somewhere else and nobody's checklist ends at
this file. The cost was not confusion but wasted work: a session was told to re-do
crAPI, a session was told Juice Shop was unbuilt, and one of them copied the error
into `CLAUDE.md`, where it survived eleven days.

**Is it worth a gate? Mostly no, and the "mostly" is worth being precise about.**
Fifteen of the nineteen are, by inspection, not mechanically checkable by anything
short of reading the repository — inspection, and not a gate written and run
against them, which is the weaker kind of evidence and is named as such because
ADR-0065 asks for exactly that distinction elsewhere in this document: no scan
can know that a phase closed, that a choice was made, or that
a sentence describing an intention should now describe a record. A gate that cannot
see fifteen of nineteen, described as guarding this file, would be the exact defect
ADR-0065 was written against — a rule that tells the reader not to look while no
longer holding.

Four are mechanically checkable — 3, 5, 8 and 9 — and all four have one shape:
**this file restated a fact whose home is another file that already has a gate.** The
current release lives in README's Install section, under a gate, and this file named
`0.2.0` and then `0.4.0` — the gate is a file away, and it was never pointed
here. The combination count lives in `polygon/ground-truth.json`,
gated in CI by `verify.mjs --check-readme`, and this file kept its own copy of the
number — a copy that then survived a search-and-replace because a line wrap split the
phrase in two. That is not a gap in the gates. It is a second home for a decision,
which is the failure `src/core/keys.ts`, `path-parameters.ts` and `identifiers.ts`
each have a gate against, and which ADR-0065 says is held not by the scan but by the
owning module refusing to hand out its raw material.

**So the fix is the one this repository already made in code, applied to prose: a
roadmap that cites instead of restating cannot go stale, because there is nothing in
it to go stale.** The corrections above are written that way where they could be —
no version is named as current here any more, the combination count says which
command measured it and when, the closed questions point at the ADRs that closed
them. The phase table keeps its status column, because a roadmap without one is not a
roadmap, but every cell now carries the date it became true, which is the cheapest
thing that makes a stale cell look stale.

**One gate would be worth writing, and it is not written.** Ten lines asserting that
`plan.md` names no version as current, or that any version it calls current equals
`package.json` — the assertion `release-readme.test.ts` already makes about README,
pointed at a second file. On this round's evidence it would have caught number 9
outright and number 3 depending on how the sentence is worded; not 5, which needs a
different gate reading the oracle, and not 8, which says "today" without naming a
version at all. **No claim is made here about what such a gate holds, because it has
not been written or run** — that is rule 2 of ADR-0065, and it is why this paragraph
stops rather than describing the reach of something that does not exist.

What would have caught the other fifteen is duller, and is what actually happened:
somebody opening the file and checking every claim against the tree, on a date, and
writing the date down. That is not a gate and does not become one by being scheduled.
It is the same answer this repository gave the dependency thresholds — "check on
every update, and at least once a quarter" — and the honest version of it here is
that **a roadmap read once a quarter is a roadmap wrong for up to three months**,
which is tolerable for a plan and was not tolerable for the two lines that cost a
session each. The cheaper habit, and the one this round actually recommends: when a
phase closes or a question is answered, the commit that closes it edits this file
too. Six of the nineteen would never have existed.

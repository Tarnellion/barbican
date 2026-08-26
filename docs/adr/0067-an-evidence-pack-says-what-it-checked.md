# 0067. An evidence pack says what it checked, and what it did not

- **Status:** accepted
- **Date:** 2026-08-24
- **Corrected:** 2026-08-26 — this line read `2026-08-25`. The work was
  committed on 24 August and shipped in `0.7.0`, tagged the same day; the
  session that wrote it dated it a day forward. A date in an ADR is what a
  reader anchors everything else in it to.

## Context

Module 2 in `CLAUDE.md` is "an evidence pack against external standards. Added by
registering checks, not by rewriting the core". Most of the machinery for it was
already in the tree, built one piece at a time and for its own reason:

| what exists | where | which ADR |
| --- | --- | --- |
| the catalogue of clauses, per instance | `src/core/standards/catalog.ts` | [ADR-0043](0043-a-catalogue-of-clauses.md) |
| the three public standards as data | `src/core/standards/bundled.ts` | [ADR-0043](0043-a-catalogue-of-clauses.md) |
| a finding cites its clauses | `findings[].standards` | [ADR-0041](0041-a-matrix-discrepancy-answers-for-a-clause.md) |
| a clause names what exercised it | `coverage.clauses` | [ADR-0052](0052-a-clause-can-be-reported-as-exercised.md) |
| the qualifications that travel with a claim | `clauseReservationsOf` | [ADR-0052](0052-a-clause-can-be-reported-as-exercised.md) |
| a clause nothing covers | `findUncoveredClauses` | [ADR-0043](0043-a-catalogue-of-clauses.md) |
| a saved report is a document | `toComparableRun` | [ADR-0066](0066-an-identifier-has-a-grammar.md) |

So the data was there and nothing assembled it. What was missing is not a
structure — that is an afternoon's work — but the decision this ADR is:
**which sentence this tool is willing to say to a third party about a clause,
given what a run actually did.**

That question has a specific answer here because the failure it guards against is
recorded in this repository as a defect. The doc comment on `clauseReservationsOf`
carries it: a run probed two endpoints of eleven and printed "No privilege
escalation found" over the other nine (B-4). Nothing was missing from the file;
the number that mattered was not next to the claim. An evidence pack is where
that costs the most, because a pack is the artifact somebody who was not there
reads **as a conclusion** — and the nine endpoints it says nothing about are the
ones addressed by identifier, where broken object-level authorization lives.

## Decision

`evidencePack({ run, catalog })` in `src/report/pack.ts` takes a saved run and the
catalogue it is to be read against, and returns the structure a document is drawn
from. It is pure: no file system, no clock, no network, no rendering. JSON stays
the single source of truth and the document is drawn from it in a separate step
([ADR-0002](0002-pure-core-and-json-source-of-truth.md)), so a pack is built
**after** a run, from the file the run wrote.

### One row per catalogued clause, whatever the run did

Every clause of the catalogue gets a row, including the ones the run never
touched. A pack built from what a run cited would list what happened to be
checked, and the question a reader has is what was not. That is the whole reason
the catalogue exists as data rather than as a table in a document.

A clause the run cited that the catalogue does not carry gets a row too, in a
separate list. It cannot be given a title, a source or a boundary — the pack does
not have them — and printing those as blank would read as a catalogued clause
with nothing to say. Two ordinary things land there: a report from a machine that
registered a standard whose numbering may not be published (ADR-0043), and a
report from a build whose catalogue has since grown.

### Six claims, and three of them are about the run rather than the platform

`CLAIMS` is the vocabulary and the wording at once. The three that say something
about the platform are `breached`, `upheld` and — weakly —
`answered-without-findings`; the three that say something about **this run** are
`inconclusive`, `unanswered` and `withheld`. The second group is the half a pack
usually lacks and the half a reader mistakes for the first.

The order the rules are applied in is the argument, and it is decreasing
confidence in what the run saw:

1. **A disagreement stands whatever else is true.** It was observed, and no later
   failure of the run unobserves it.
2. **A run that could not be trusted says nothing further** (below).
3. **Cells that concluded** are the only thing `upheld` may rest on, and the
   denominator travels with it on the row.
4. **Cells that concluded nothing** are `inconclusive`, which is not silence.
5. **A check that ran and found nothing** is the weakest row here, because nothing
   in the report says how much it looked at — ADR-0052 refuses to invent a
   denominator for the check channel, and so does this.
6. Whatever is left was answered by nothing at all: `unanswered`.

A clause with no row of its own and no citation is therefore `unanswered` and
never a pass, and its sentence says so in as many words.

### A run that exited 2 may report what it found and may not report a pass

`runVerdict` already draws the line and states it: 2 means the report describes
the state of the network, of the deployment or of the run's own credentials
rather than the platform's access control. Five of the six ways to reach it — a
matrix nobody walked, a walk cut short, credentials gone stale, credentials
nothing confirmed, half the cells failing to answer — leave cells whose *silence*
proves nothing.

**They do not make what was found unfound.** A privilege escalation seen before
the budget ran out is still one, and a 200 under a token that may be dead is
worse rather than better. So the pack's standing is `withheld`, every row that
would have been `upheld` or `answered-without-findings` becomes `withheld`, and
`breached` stands. That is the asymmetry this project reasons by everywhere else:
a positive claim of safety needs a run that answered for itself, a positive
finding of a hole does not.

A verdict code that is neither 0, 1 nor 2 is withheld as well. Reading anything
unrecognised as trustworthy is the failure this whole module is built against.

### The reservations are read, not recomputed

`clauseReservationsOf` computes them while `coverage` is being written, because
that is where the accounts, the canaries and the surface are. The pack lifts them
off the clause row and carries them onto its own row unchanged, including a code
this build has never heard of — dropping one would silently strengthen the claim,
which is the one direction a pack must never move in.

A row with no clause row behind it carries none — a clause reached only by a
finding that cites it, and a clause the run never reached at all. Neither makes a
claim of coverage for a reservation to qualify: one is a disagreement that was
observed, the other is `unanswered`. Nothing is substituted in, because the
substitute would be a second derivation of the thing `clauseReservationsOf`
exists to be the only one of; and the run-level statement is not lost either way,
since `run.warnings` carries it in the tool's own words.

That is visible on a real pack. A run against the reference platform with two of
its defects on reports `OWASP-ASVS-5.0 8.2.1` as breached over 54 conclusive
cells with `endpoints-not-probed` beside it, and `OWASP-API-2023 API5` — the
defect class the same escalation cites — as breached with no reservations and no
cell count, because the defect class reached the pack through the finding and
never had a row of its own (ADR-0052 is why it does not: a clean cell is not
credited with having searched for improper authorization).

### The wording is a decision, not a string

Every sentence a pack prints is an assertion this tool makes to somebody who
cannot check it. `CLAIMS`, `STANDINGS` and `DISCLAIMERS` are the one place those
eleven sentences are written, for the reason `WARNINGS` in `verdict.ts` is one
place: the two copies that were kept level by hand drifted within four days, and
by 18 August 2026 the console and the file said different things about the same
run.

A row carries the **code**; whatever renders it reads the sentence from the
table. Codes on a row and sentences at the top of the document is the same split
the report already makes — `CLAUSE_RESERVATIONS` is a bounded vocabulary that can
be counted and filtered, `report.warnings[]` is sentences a person reads once —
and each half is used where its precedent is.

`tests/invariants/a-claim-has-one-wording.test.ts` is the gate, with its Limits
below.

### `DISCLAIMERS`: what the pack refuses to claim, on every pack

Three standing limits of the method, printed whatever the run did, because none
of them can ever be discharged by running the tool again:

- **The policy is a human declaration** ([ADR-0006](0006-expected-access-declaration.md)),
  never derived from the specification of the system under test. Where the
  platform and the declaration disagree this tool cannot say which is wrong, and
  where they agree, what was agreed with is the declaration. A pack is evidence
  about a declared policy and not an audit of whether that policy is the right
  one — which is the one sentence that keeps the artifact honest about what
  Module 1 actually performs.
- **The observation is black-box.** A deployment that answers 200 with the
  refusal in the body reads as allowed on every cell (L-3), and no row can tell
  that apart from a platform that grants everything.
- **The catalogue is bounded, and no requirement's text is reproduced.** The row
  carries its own standard's `scope`; this says the set of standards is bounded
  too, and that a clause absent from the pack is not thereby absent from the
  standard.

### The door: one reader of a saved report, in one module

`toPackableRun(value, source)` is the tenth door. A saved report is a document the
tool was handed — from another machine, an earlier build, or somebody else — and
ADR-0066 put the identifier grammar on the ninth. A rendered document is a **new
sink**: HTML is a second grammar with its own characters that are not text, and
escaping on the way out is modelling somebody else's parser, which `CLAUDE.md`
names as how the address grammar was wrong the first time. Refusing at the door
leaves the renderer one grammar to be right about instead of two.

The reading half of the comparison's door moved to `src/report/document.ts`
rather than being written a second time in `pack.ts`. That is ADR-0024's rule one
layer up: the decision — *every string lifted out of a saved report goes through
the grammar, and every refusal names the field and the file* — has one home, and
the readers above it name the fields they need. The measurable consequence is in
`tests/invariants/one-decision-one-home.test.ts`: the module allowed to import
`identifier` from the report layer is now `document.ts` instead of `compare.ts`,
one entry rather than two, and a third reader of a saved report needs no entry at
all.

Two places where this reader parts company with `toComparableRun`:

- **`schemaVersion` is enforced.** There a mismatch is a statement the comparison
  makes with both versions named, because there are two files to state it about.
  Here there is one, and a shape this build cannot read would be read as a run
  that answered for no clause — a pack full of `unanswered` over a run that
  answered for every one of them. That is this module's own worst failure pointed
  at itself.
- **A missing `coverage.clauses` is refused by name.** The field arrived in 0.5.0
  and `schemaVersion` deliberately stayed `2`, so a 0.4.0 report passes the check
  above and reaches the same failure. It is refused with the reason rather than
  with "missing or is not an array", because this is the absence a reader will
  actually meet.

### The subcommand, which this change deliberately does not add

The rendering track wires it; naming it here so the two do not collide.

```
barbican pack <report.json> --out <file.html> [--json <file.json>]
```

- `<report.json>` — one saved report, positional, like the two `barbican diff`
  takes.
- `--out <path>` — where the document goes. A document is a file; without this
  the command writes nothing, and printing a rendered page to a terminal is not a
  thing anybody wants.
- `--json <path>` — the pack structure itself, so that the thing the document was
  drawn from is inspectable and diffable. JSON is the source of truth, and a
  reader who wants to check the document against it should not have to re-derive
  it.
- **Exit codes:** 0 when a pack was built, 2 when the report cannot be read
  (`UnreadableReportError`, `UnusableIdentifierError`) **and 2 when the pack's
  standing is `withheld`**. The last one is the recommendation worth arguing
  about: a pack built from a run that exited 2 is a legitimate thing to want to
  look at, and a CI job that ships one as evidence without anybody noticing is
  the B-4 failure with a document wrapped around it.

## What deliberately did not get in

**A percentage, a score, or a count of "clauses passed".** The shape this record
could most easily lie in. ADR-0052 refused it one layer down for hiding its
denominator; a pack that totalled its rows would hide six different meanings
behind one number, three of which are statements about the run rather than about
the platform.

**`contentDigest` on the pack.** The report answers for itself
([ADR-0051](0051-the-report-answers-for-itself.md)) and `checkContentDigest`
recomputes that value from a parsed file. Carrying the digest into the pack
without verifying it would read as an integrity statement the pack never made,
and verifying it is the CLI's job — it holds the file. `runId` and `configDigest`
travel instead, which tie the pack to the run and to the declaration without
claiming anything about the bytes.

**A recomputation of the reservations.** See above; and the pack could not do it
anyway, because the canaries are not in its input.

**`findUncoveredClauses` as the source of the unanswered rows.** It answers a
different question — which clauses no registered *check* covers, against a
catalogue — and it needs `Check[]`, which a saved report does not carry. The pack
asks what this **run** reached, which is a question about a file.

**A CLI subcommand.** Above.

## Alternatives

**Build the pack while the checks run.** Rejected by the architectural invariant
in `CLAUDE.md`: JSON is the single source of truth and everything else is
rendered from it in a separate step. It would also make the pack unable to answer
the question it exists for, since a pack of a run is worth building again a month
later against a catalogue that has grown.

**Put the pack in `src/core/`.** The catalogue is core and the pack reads it, so
this is a fair question. Rejected because the other input is a `RunReport`, which
is the report layer's own shape: the core does not import from `src/report/`, and
inverting that to let it would put the report's shape inside the pure layer.
`ClauseCoverage` is already shaped in the core and carried by the report for
exactly this reason, and the pack is the far end of that arrangement.

**Have the pack take a `RunReport` directly.** Rejected, and this is the sharpest
of the alternatives: a `RunReport` is what `buildReport` returns, and a pack's
input is what came back off disk. Typing the input as `RunReport` would be a
promise made by a cast — `severity` typed as `Severity` over a file that carries a
sixth level, `reservations` typed as `ClauseReservation[]` over a code from a
later build. `PackableRun` narrows every one of those to a plain string for the
same reason `ComparableDefect` does, and `toPackableRun` is what turns a parsed
document into one.

**Reuse `toComparableRun`.** It reads a different eleven fields — defects,
observations, `notProbed` — and none of what a pack needs. Reusing it would mean
widening the comparison's view of a report to cover a second consumer, which is
how a shared reader becomes the union of everything anybody wanted. What was
reused is the layer under it, which is where the decision actually lives.

**One claim status per clause, `pass` or `fail`.** The shape a reader expects and
the one this whole ADR is against. Four of the six statuses exist because "not
failed" covers four different situations that a certifying body would read
differently, and three of them are not about the platform at all.

**Count a matrix finding of an unrecognised kind as inconclusive.** Symmetrical
with counting an unknown verdict code as trustworthy, and wrong in the same
direction: a pack would then read a finding it cannot name as nothing found, and
report the clause upheld over a row that says otherwise. Unrecognised counts as a
disagreement.

## Limits

The rule is [ADR-0065](0065-what-a-source-scan-can-hold.md)'s and applies here
without amendment: a scan of source text catches what somebody writes by accident
or for convenience, not what somebody writes in order to defeat it. Nothing in
this document, in the test's header or in `README.md` says the gate cannot be
walked around.

`tests/invariants/a-claim-has-one-wording.test.ts` holds the eleven sentences to
one module. Every form below was written into `src/cli/screen.ts` — the module a
rendering track would most plausibly put a copy in — applied by a harness that
refuses a replacement which does not land the intended number of times, run, and
seen to do what is recorded. Measured on 25 August 2026 against the tree of this
change.

| form | what happened |
| --- | --- |
| a plain copy of `CLAIMS.unanswered`, continued across lines with `+` as the table itself writes it | **caught**: "is written in one module, and that module is the one that owns it" red, 1 failed of 3 in the file |
| the same copy with one word replaced by a template interpolation — `` `…for this ${WORD}: …` `` | passes; `tests/invariants/` green, 10 files, 201 passed and 1 skipped |
| a paraphrase: `claim === "upheld" ? "PASS" : "FAIL"` | passes; same, 10 files, 201 passed and 1 skipped |
| the sentence rebuilt at run time from the table: `CLAIMS.unanswered.split(":")[0]` | passes; same, 10 files, 201 passed and 1 skipped |
| the copy in an **untracked** module under `src/` | passes; same, 10 files, 201 passed and 1 skipped — the scan reads `git ls-files` |

The paraphrase is the largest of these by a distance, and it is not a spelling
trick. A renderer that prints `PASS` beside an `upheld` row says something the
table never said, and no scan of text will notice. What stands against it is the
shape of the data — a row carries a code, the sentence is only in the table — and
whatever the rendering track's own tests assert about what it prints. This is
worth stating plainly rather than implying the gate covers it.

What actually holds the wording to one place is the same thing ADR-0065 names:
the table is the only source, so a copy has to be written out, and writing it out
makes it a second implementation that will diverge on the day the first one
changes. The scan is what makes that day noisy rather than silent.

## Consequences

The package gains six exported values — `evidencePack`, `toPackableRun`,
`PACK_SCHEMA_VERSION`, `CLAIMS`, `STANDINGS`, `DISCLAIMERS` — and the types
around them. 232 exported names become 238; `docs/library.md` states the count
and `tests/public-surface.test.ts` holds it.

`src/report/document.ts` is deliberately **not** on the published surface. It is
the reading half of two doors, its `stringAt` and `numberAt` are plumbing a
consumer has no use for, and exporting the module would put ten more names on the
surface to keep. `UnreadableReportError` moved into it and is re-exported from
`compare.ts`, which is where a consumer's import already points and where
`docs/library.md` tells them to catch it; its message lost the sentence about
"both arguments", which was a comparison's sentence being said by a class two
readers now throw.

Nothing renders a pack yet, and no subcommand builds one. That is the other
track, and the boundary between the two is this file plus the four lines under
"The subcommand".

`REPORT_SCHEMA_VERSION` does not move. Nothing about the report changes here: the
pack is a reader of it.

**Revisit when** the matrix channel becomes a registered check — ADR-0052 names
the same trigger. At that point `coverage.clauses` and `coverage.checksRun` carry
the same information for both channels, `claimFor`'s split between "cells
concluded" and "a check ran" stops meaning what it means today, and the two
should be reconsidered together rather than left to drift.

# 0052. A clause can be reported as exercised, with its denominator

- **Status:** accepted
- **Date:** 2026-08-22

## Context

`coverage.checksRun` names the clauses a registered check answers for **even
when the check found nothing**. That is the clause-to-coverage direction, and
`docs/report.md` calls it "the whole difference between an evidence pack and a
list of findings".

The matrix channel had no such list. Since ADR-0041 its findings cite clauses, so
the finding-to-clause direction is complete for both channels; the other one
covered the one registered check and nothing else. The consequence is stated in
ADR-0041's own closing section and recorded as unclosed in `plan.md`: a clause
exercised across nine hundred cells that all agreed with the declaration appears
in an evidence pack only if one of them broke. The pack can say "here is what
failed under 8.2.2" and cannot say "8.2.2 was exercised across the surface and
holds" — and the second sentence is the one a certifying body asks for.

The second half of M-11.

### The danger, which is the same class as a falsely clean run

Claiming a clause exercised where the tool could not structurally see anything is
worse than claiming nothing. Nothing about it looks wrong: a row saying "8.2.2 —
covered" reads identically whether nine hundred cells answered or none did.

The ways a run reaches that state are all ordinary, and every one of them has
already been found in this project as a defect of its own:

- a cell the walk declared and no request reached — `not-observed`;
- an endpoint never probed, because the method changes state or because its path
  template had no resource to substitute. That is the object half of the surface,
  where BOLA lives, and the run that probed two endpoints of eleven and printed
  "No privilege escalation found" over the other nine is B-4;
- a request that failed, where the tool has a cell and no answer — `probe-error`;
- a platform that answers `200` with the refusal in the body, where every
  conclusion drawn from a status code is drawn from a document the tool cannot
  read — L-3, whose signature is `outcomes.denied === 0`;
- an account whose credentials nothing confirmed, where a recorded refusal says
  what an unauthenticated request says and a cell that "upheld" a denial upheld
  nothing — ADR-0033;
- a walk cut short, where the tail of the matrix was never reached — ADR-0029.

## Decision

`coverage.clauses` — one row per clause **either** channel reached in this run:

```jsonc
{
  "standard": "OWASP-ASVS-5.0",
  "clause": "8.2.2",
  "checkIds": [],
  "matrixCells": {
    "conclusive": 96,
    "upheld": 84,
    "breached": 12,
    "inconclusive": { "not-observed": 18, "probe-error": 4 }
  },
  "reservations": ["endpoints-not-probed"]
}
```

Three properties of that shape are the decision; the rest is bookkeeping.

### Nothing is a ratio

A percentage is the shape this record could most easily lie in, because it hides
its denominator and the denominator is the whole question. Every row carries the
cells that concluded **and** the cells that concluded nothing, by reason, with
every reason present as a key even at zero — the reasoning `coverage.outcomes`
already stands on, where a missing key would have to be read as a zero by
whoever thought to look. `conclusive` plus the inconclusive counts is the clause's
whole reach in this run, on the row, without arithmetic performed elsewhere.

`upheld + breached === conclusive` is checkable on the spot, and for ASVS 8.1.1 —
which every cell cites — `upheld` is `coverage.cellsMatched`. A reader who wants
to know whether the section is describing the same run as the rest of the file
has two identities to check it by.

### A conclusive cell is one the tool could read

`upheld` and `breached` are only for cells that produced an answer the tool could
draw a conclusion from. A cell with no observation is `not-observed`; a cell whose
request failed is `probe-error`; neither is evidence about anything, and neither
touches `conclusive`.

The "upheld" half is the narrowed verdict, not the walk's: a cell the walk agreed
with and a body check objected to is not upheld (ADR-0022). It is read off the
published observations rather than recomputed, so that this section and
`cellsMatched` cannot disagree.

### Reservations travel on every row

The four codes — `authentication-unproved`, `endpoints-not-probed`,
`no-refusal-observed`, `run-truncated` — say why "exercised" falls short of
"holds across the surface". Every one of them is derivable from elsewhere in the
report, and that is exactly why they are repeated here.

A clause row is what gets pulled out of a report and into a pack about one
requirement. A qualification left behind in another section is a qualification
that did not travel with the claim. The precedent is in this tree:
`UncoveredClause.scope` carries the catalogue's own boundary on every row for the
same reason, because "8.2.3 is covered by nothing" is false the moment it is read
as a statement about ASVS rather than about what was catalogued.

Codes and not sentences, the way `CanaryOutcome.failure` is a code: a bounded
vocabulary can be filtered, counted and rendered, and cannot carry anything it
was not meant to. What each means is in `docs/report.md`.

### The rule is the one ADR-0041 already wrote

`controlClausesForCell(relation)` is the half of `standardsForDiff` that depends
on the cell alone, lifted out and now called by both. So there is still one place
where a clause is spelled and one rule for which control a cell is evidence
about; the coverage direction is a caller of it rather than a copy — which is the
whole of what made ADR-0041's second mapping affordable, and
`tests/report/matrix-findings-carry-clauses.test.ts` reads `src/` to keep it true.

## What deliberately did not get in

**Defect classes.** API1, API5 and CWE-285 never appear with `matrixCells`. A
clean cell shows that a control was exercised and how it came out; "we searched
for improper authorization here and found none" is a claim about the tool's reach
that a comparison against one declared policy does not support. This is ADR-0041's
own refusal seen from the other side — it declines to credit an unexpected denial
with a broken-authorization finding, and this declines to credit a clean cell with
having gone looking for one. Those clauses keep the finding-to-clause direction
they already had, and a row for one exists when a check cites it.

**A denominator for the check channel.** A row a check reached names the check
and stops. What that check examined is `coverage.byCheck`, in the check's own
terms and its own counters (ADR-0025); a cell count invented for it here would be
this record making a claim it cannot support. It is also why a clause reached by
both channels is one row with both halves rather than two rows that a reader has
to add up.

**Clauses the catalogue holds that this run never touched.** That is
`findUncoveredClauses(catalog, checks)`, which already exists, and it is a
different question: it is answered against a catalogue and it is about what the
tool was asked to cover, while this is about what a run reached. Wiring it into
the report needs a catalogue at the report layer and a caller that assembles one,
which is `src/cli.ts` — a change on the other side of this one's boundary. Rows
here come only from what actually cited a clause during the run, and
`docs/report.md` says which of the two questions this section answers.

**A skipped endpoint attributed to particular clauses.** An endpoint nothing was
sent to produces no cells, so it has no relation and there is nothing to place it
under; deriving what its cells *would* have cited means re-deriving the matrix in
the report layer. It is `endpoints-not-probed`, a reservation on every row, with
the count in `coverage.notProbed` beside it. That is a coarser answer than the
per-clause ones and an honest one.

## Alternatives

**Make the matrix channel a registered check.** ADR-0041's own recommendation,
and it produces this list for free because `checksRun` is the list of what ran.
Rejected here for the reason it was rejected there, unchanged: `summary.byKind`
holds diff kinds and check ids in one key space, `summary.verdictInputs`
separates them because `runVerdict` never sees the registry, the exit code is
derived from that separation, and the polygon oracle counts by those same kinds.
All of it moves together or not at all. This change is additive and touches none
of it — and it buys the same time ADR-0041 bought, with the difference that the
sentence a certifying body asks for now exists while that move is being made
carefully.

**A `coveragePercent` per clause.** One number, and the one shape that cannot be
read honestly: it hides the denominator, and every failure in the Context section
inflates it silently. Rejected on the same grounds `runVerdict` states its reason
next to its code.

**Reservations once at the top of `coverage` instead of on each row.** No
duplication, and the qualification stops travelling with the claim the moment a
row is quoted anywhere. See above.

**A row for every catalogued clause, zeroed where the run reached none.** It
looks more complete and it is the false completeness `StandardDefinition.scope`
exists against: a list of eight ASVS clauses reads as an audit of ASVS. The
catalogue's own answer to that question is `findUncoveredClauses`, and it carries
the boundary with it.

## Consequences

`coverage.clauses` is present on every report. `schemaVersion` stays `2`: a
reader written against `2` is not broken by a field appearing, and
`tests/report/report-shape.json` records the new paths with its own version left
alone.

The package gains `clauseCoverage`, `controlClausesForCell`,
`INCONCLUSIVE_REASONS` and `CLAUSE_RESERVATIONS`. The computation is in
`src/core/standards/coverage.ts` and not in the report layer, for the reason
ADR-0041 gave for keeping `standardsForDiff` in the core: which clause a cell is
evidence about is a statement about what a discrepancy means, and the report
carries what a channel declares rather than deciding it.

Nothing renders this yet. The evidence pack is Module 2 and this is the field it
will be built from; what changes today is that a saved report can be asked the
question at all.

**Revisit when** the matrix channel becomes a registered check. At that point
`checksRun` carries what `clauses` carries for it, and this section should be
reconsidered as a whole rather than left to say the same thing twice — which is
the failure `WARNINGS` and `RESOURCE_RELATIONS` were each caught by.

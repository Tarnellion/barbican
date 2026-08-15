# ADR-0022. One verdict per cell, from both channels

**Date:** 15 August 2026
**Status:** accepted. Narrows the meaning of `match` set by
[ADR-0020](0020-verdict-next-to-observation.md).

## Context

ADR-0020 put the verdict next to the observation and closed with a warning about
the risk it left behind: "if a second way to obtain a verdict appears, it must be
deleted, not reconciled". The warning was aimed at the matrix — at someone
recomputing `match` from the findings instead of from the walk — and it held.

What it did not cover is that a cell has always had **two** judges, not two ways
of asking one. The walk compares the outcome against the declared policy, by
status code. A check compares response bodies against
`responseMustDifferByTenant`. Only the first ever reached `match`.

So the report could say both things about one cell at once. On the reference
polygon with every defect switched on, twelve cells were printed as `match:
true` — "tested and agreed" — while sitting in `findings` with a high-severity
cross-tenant leak. `docs/report.md` promised the opposite in as many words, and
offered the reader two arithmetic self-checks that both came out wrong:
`cellsMatched` 100 plus `summary.findings` 98 against `cellsObserved` 180.

The damage is not the arithmetic. A developer who opens the observation for the
endpoint named in a ticket reads "expected allowed, allowed, agreed" and closes
it as works-as-designed — and the observation is the natural place to look,
because it carries the address and the status the finding refers to.

Found by the audit of 14 August 2026 (tracks B and H independently).

## Decision

**A cell is `match: true` only when nothing was found on it, by either channel.**

`responseMustDifferByTenant` is a declaration the same human wrote in the same
configuration as the policy. A cell where the bodies did not differ has not
"agreed with what was declared" — the status code merely has nothing to say
about it. The core is untouched: `CellVerdict.match` remains the walk's verdict,
because the core knows nothing about checks and must not. The narrowing happens
in the report, which is where the word is defined for the reader.

Two things follow, and neither is optional.

**The observation says why.** A body finding leaves a row where the expectation
is `allowed`, the outcome is `allowed`, the status is 200 and `match` is `false`
with nothing to explain it — a reader taking that for a bug in the tool would be
right to. `findingKinds` lists the kinds recorded against the cell, sorted, and
is absent when there are none.

**`coverage.cellsWithFindings` joins `cellsMatched`.** The identity the
documentation offers has to be over cells, because one cell can carry several
findings — a status discrepancy and a body one are two rows and one cell. The
reader gets `cellsMatched + cellsWithFindings === cellsObserved` instead of
deduplicating a list by three fields. Both keys are absent together when no
verdicts were computed: half of an identity is worse than none.

## Alternatives

**Leave `match` as the walk's verdict and document the exception.** The honest
version of the status quo: `match` means "agreed by status code". Rejected — the
field is read by whoever gets sent the report, not by whoever reads the
documentation for it, and "agreed" that means "agreed on one of two counts" is a
trap laid for exactly the person the tool exists to inform.

**Weaken the documented identity to `cellsMatched + summary.findings ≥
cellsObserved`.** Rejected: a self-check that holds trivially checks nothing.

**A separate field — `matchByStatus` and `matchByBody`.** Rejected: it makes the
reader carry the tool's internal division of labour, and the question being asked
is "was anything found here", which has one answer.

## Consequences

- `cellsMatched` drops on any run where a check fires: 80 → 74 on the reference
  polygon with all nine defects. The number was wrong before, not now.
- The two self-checks in `docs/report.md` hold, and the oracle asserts both on
  all 28 combinations plus the contradiction itself, naming the offending cells.
  They were deliberately left out of `checkReportConsistency` while this was
  open; that note is gone.
- `schemaVersion` stays at `1`. It is defined as the shape of the report, and
  the shape only gained two optional keys — no parser breaks. What changed is
  what `match` *means*, and a version number cannot carry that; `docs/report.md`
  states the date instead, so a report from before it can still be read
  correctly.
- A finding that names neither an account nor an endpoint still cannot narrow any
  cell — it has no cell. That case is already reported through
  `coverage.checksWithUnusableFindings` and is not made quieter here.
- The order of computation in `buildReport` is now forced: findings first, then
  verdicts. Merging depends on the raw observations, verdicts depend on the
  merged findings; reversing it silently restores the defect. The oracle catches
  that, which is the reason the assertion belongs there and not only in a unit
  test.

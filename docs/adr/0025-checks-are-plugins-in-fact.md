# ADR-0025. Checks are plugins in fact, not only in the plan

**Date:** 15 August 2026
**Status:** accepted. Makes good what [ADR-0003](0003-check-registry.md) records
and `plan.md` promises.

## Context

`plan.md` says the evidence pack is added by registering checks, without touching
the core. The audit of 14 August 2026 took that sentence apart and found five
places where it was not true (L-4). None of them was a bug in the sense of a
wrong answer; all five were the difference between an architecture and a
description of one.

**`Check.standards` was declared, filled and read by no line of code.** The word
did not occur in a report at all. So the traceability the whole of Module 2 rests
on — from a finding to a clause of an external standard — could not be built out
of a saved artifact by anyone.

**A finding naming no cell was dropped.** `Finding` makes `accountId` and
`endpointId` optional, and `mergeFindings` filtered on both. A run-level finding
is not an edge case for the evidence pack; it is its principal shape — "this
clause is covered by nothing" — and a critical one produced today would have left
the report saying `findings: 0`.

**The report layer imported a specific check.** `src/report/build.ts` took
`BodyComparisonCoverage` from `tenant-isolation.ts`, and the CLI called a second
function exported from that same check by name. A second check with anything to
say about its own reach had nowhere to say it.

**`evidence.otherAccountId` was a cross-layer contract nobody wrote down.** The
report read it to print the other side of a paired finding and to group both
sides as one defect. Typed as "some scalar", documented nowhere, undiscoverable
by whoever writes the next check.

**`CheckContext` carried only the matrix.** So the whole class of statement "this
clause was covered *enough*" was inexpressible rather than merely unwritten: a
check could say what it found and could not say that four of the seven endpoints
the clause is about were never probed.

And the registry was assembled hard-coded, with no way to select: ADR-0003's
"registry assembled for a particular run" was unreachable.

## Decision

**`Check.standards` reaches the report in both directions.** Every finding
carries the clauses of the check that produced it, and `coverage.checksRun` holds
`{ id, standards }` instead of a bare id. The second direction is the one that
matters and the one that is easy to lose: a clause is covered by a check that
found nothing just as much as by one that found something, and a list of findings
cannot say so.

**A finding with no cell is carried like any other.** The filter is gone.
Everything downstream stopped assuming a cell instead: no request is attached
where there is none, and the cell verdict skips it. It is **not** grouped into
`defects` — a defect group answers "how many distinct breakages of the platform",
and a statement about the run is not one — so the identity a reader can check
becomes `sum(defects[].violations) + findings with no cell === summary.findings`.

**A check reports its own reach through `Check.coverage`,** returning
`CheckCoverage`: a check id, an optional endpoint, and counters. Numbers only,
for the same reason `SignalValue` is a number or a boolean — a string there would
be a place for a response body to end up in the report. `coverage.bodyComparison`
becomes `coverage.byCheck`, and the report carries counters it does not
understand, which is what "plugins" has to mean if it means anything.

**`Finding.relatedAccountId` is a field.** `evidence` keeps the key as well, for
whoever is reading one finding rather than the schema.

**`CheckContext.scope` carries what the run touched**: probed endpoints, skipped
ones with reasons, and whether the walk was cut short. Optional, so a check can
still be tested on a fixture without inventing a run.

**`CheckRegistry.select(ids)` assembles the registry for a run,** and `--checks`
exposes it. An unknown id stops the run **before the first request** — the same
place `--report` is checked, and for the same reason — naming the checks that
exist. `--dry-run` prints the selection.

`REPORT_SCHEMA_VERSION` goes to `2`. Four incompatible changes, not one additive
one; a reader written against `1` breaks on all four, which is what the field is
for.

## Alternatives

**Do the four cheap gaps and leave `CheckContext` and run-level findings for when
Module 2 is scheduled.** This was the recommendation, and the owner chose the
whole rework. The argument against it stands and is worth recording: `scope` is
shaped by a guess about a consumer that does not exist yet, and nothing but that
guess tests it. The argument for is that the alternative is two reworks of the
same four files, the second one under schedule pressure.

**Keep `standards` out of the finding and join through `checksRun`.** Smaller
report. Rejected: a finding is what gets pasted into a ticket, and a reference
that needs a second lookup in a file the reader may not have is not traceability.

**Group run-level findings with a placeholder endpoint.** Rejected: `defects`
would then contain something that is not a defect of the platform, and every
count built on it becomes a different number than it claims to be.

**Read the pair from `evidence` but document the key.** Rejected: a convention
documented is still a convention, and this one had a comment already.

## Consequences

- Four defects and one design gap close together: the clauses reach the artifact,
  run-level findings survive, the report layer no longer knows a plugin by name,
  the pair is a contract, and a registry can be assembled per run.
- The oracle gained three assertions and one of them was written because of a
  mistake made while doing this: reverting `tenant-isolation.ts` by accident
  removed `relatedAccountId` from the real check, and **all 28 combinations
  stayed green** while every leak in the report lost the account it leaked to.
  The gate now fails on a finding that names its pair in `evidence` but not as a
  field, and on one that names a pair with no request to reproduce it.
- `--checks` is validated before the first request. Putting the selection next to
  where checks run would have repeated the waste `--report` used to cost: a typo
  discovered after the whole matrix has been walked.
- What is still not done: no registered check produces a run-level finding, and
  no check reads `scope`. The shapes exist and are tested; the first user of them
  is the evidence pack. B-1 closes here — the second half of it was always this
  rework.

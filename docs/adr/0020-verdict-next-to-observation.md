# ADR-0020. The verdict next to the observation

**Date:** 13 August 2026
**Status:** accepted. Supersedes the decision recorded in `docs/report.md` as
"an observation carries no verdict".

## Context

An observation reported what happened: the method, the address, the status, the
redacted headers, the outcome, the duration. What **follows** from that was
reported by the findings. The split was deliberate: an observation is evidence,
a verdict is interpretation, and mixing them seemed wrong.

The third cold read showed the price of that decision. A reader who got the
report and both guides with no access to the project could not answer the
question "which cells were tested and agreed" other than by **rewriting the
core**: the tenant tree, the computation of the relation, the rule "the last
rule that matched wins". He did it — and matched the tool line for line — but
the work he did is exactly the work the report is supposed to take off him.

Something else followed from this, less obvious. "It is clean here" existed in
the report only as a **subtraction**: 144 observations minus 64 discrepancies. A
subtraction cannot be quoted in a review and cannot be pointed at: saying "the
cell `alice-a × orders.read × someone else's order` was tested, a denial was
expected, and a denial is what came back" was not possible from the report. Yet
cells like that are the only thing that tells a working protection from an
untested one.

The operator suffered on the side as well: a mistake in **his own** policy was
invisible to him. A rule that accidentally declared access allowed gave the
absence of a finding — indistinguishable from the absence of a problem.

## Decision

An observation in the report carries the verdict on its own cell: `expected`,
`match`, `relation` and `ruleIndex`.

The verdict comes from **the same walk** that produces the discrepancies.
`describeCells` appeared in the core, and `diffAccess` became a special case of
it: both functions call one internal `walk`, which writes a verdict on every
cell and additionally writes a discrepancy on a cell that did not agree. Two
independent passes would have been the worst possible solution: the report would
claim "tested and agreed" about a cell that landed in the findings at the same
time.

The invariant is covered by a test: the set of cells with `match: false` must
coincide with `diffAccess` cell for cell. The first version of the test was
empty — there was not a single resource in the fixture, and the mutation "a
discrepancy with a resource is declared agreed" passed green. The test was
rewritten onto a matrix with resources and it catches the mutation.

## Alternatives

**A separate `cells[]` array.** The observations stay evidence, the verdicts
live next to them. Rejected on cost and on ergonomics: +23 KB against +13 KB on
a report of 148 KB, the triple account × endpoint × resource is duplicated in
every row, and the reader has to join two arrays by eye — exactly the work this
decision was being taken because of.

**On demand, behind a separate flag.** The report does not change, the verdicts
are written only with `--cells`. Rejected: the report is read by whoever it was
sent to, and it was sent without the flag. The default is what a human sees.

**Leave it as it was.** `coverage.cellsMatched` covers the total. Rejected: a
total answers the question "how many", and the question asked is "which ones".

## Consequences

- The report grew from 148 to 161 KB on a run of the reference polygon (144
  cells). The growth is linear in the number of cells.
- `coverage.cellsMatched` stays and becomes checkable on the spot: the number of
  observations with `match: true` must equal it.
- The principle "an observation passes no verdicts" was overturned deliberately,
  not blurred. The reason it held has not gone anywhere — a verdict depends on
  the policy, and the policy changes — but in the report the policy is
  **frozen** together with the run (`inputs.policy`, `configDigest`), and the
  verdict for that run is determined unambiguously.
- `coverage.cellsMatched` is counted from the verdicts themselves, not by
  subtraction. The first version subtracted the findings from the observations
  and lied: among the findings there are `not-observed` ones, which have no
  observation at all. The equality this ADR promises did not hold — found by an
  adversarial review. The key is absent entirely when no verdicts were counted:
  a zero would read as a statement about the platform.
- The risk that remains: the temptation to count the findings from the
  observations instead of from the diff. The safeguard is the shared walk and
  the test that the sets coincide; if a second way to obtain a verdict appears,
  it must be deleted, not reconciled.

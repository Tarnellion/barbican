# 0053. The walk holds one copy of the matrix

- **Status:** accepted
- **Date:** 2026-08-22

## Context

The measurement of 20 August 2026 (J-10) found the peak resident set growing
linearly with the number of cells, at 11–13 KB per cell, and named the reason:

> the full matrix is materialised three times in a row: `observations` (the
> walk), `cells` (`describeMatrix`) and `ReportedObservation` (`withVerdicts` in
> `build.ts`). None of it is streamed.

[ADR-0038](0038-the-report-is-written-in-chunks.md) had removed the ceiling on
the **file** a month's worth of commits earlier and said in as many words that it
had not touched memory: "the object graph is still built in full, and the matrix
is still materialised three times over the course of a run (J-10). That is a
larger change and it is not this one." This is the part of it that could be done
without touching the report.

### The walk was three of them by itself

The count of three was low. `collectObservations` held the matrix three times
over on its own, and only the last of the three left the function:

1. `tasks` — one object per cell, laid out before the first request and alive
   until after the last, holding the account, the endpoint, the resource, and two
   values derived from the account.
2. `results` — one `CellResult` per cell, filled as the walk went.
3. `observations` — drained out of `results` at the end, in cell order, and
   returned.

All three were alive together at the moment the last cell came back. Beside them,
the resume gate minted one key string per cell before the first request — on
every run, including the overwhelming majority that resume nothing.

Measured on a matrix of 30 000 cells, as live heap after a full collection, the
walk retained **1.478 copies** of what it returned: 401 bytes per cell while it
ran against 271 bytes per cell once it had returned. Repeatable to three decimals
across sizes and runs.

## Decision

**The walk holds one copy of the matrix: the one it returns.**

**The task list is gone.** Everything in a task except the cell is a property of
the account, and there are as many accounts as an operator wrote down. So a
`Walker` holds the account's half once per account — the account, the principal
`principalOf` resolved, the condition attributes — and `cells` holds the cell's
half once per `endpoint × resource` pair. A cell of the walk is a pair of indices
into the two, and the pool's cursor produces it. An account under conditions
exists only on the endpoints those conditions were declared on, and
[ADR-0019](0019-request-contexts.md) makes that declaration mandatory precisely
so that conditions do not multiply the matrix by the whole surface: such an
account carries a short list of the cell indices it walks, and there is one list
per such account rather than one entry per cell.

**The result array is gone.** A worker writes the observation straight into
`observations` at the index of its cell, and the failure into a map keyed by the
same index. A `CellResult` is now a value one worker holds for the length of one
cell. The holes a stop or a terminal error leaves are closed up in one pass at the
end, **in place** — copying into a second array would put two copies of the matrix
in memory at the last step of the walk, which is the thing being removed.

Failures live in a map rather than a second array of the matrix's length: a run
where every cell fails is possible and a run where none does is the ordinary one,
so the cost follows the failures. They are drained in index order together with
the observations, which is what keeps `failures[]` in the order the cells were
laid out.

**The resume gate resolves a record from its own coordinate** — account to
walker, `endpoint × resource` to cell index, cell index to position inside the
account — instead of walking the matrix and asking after every cell of it. It
costs one lookup per resumed record and nothing at all on a run that resumes
none.

### What was not allowed to change, and did not

- **The bytes of the report.** The oracle parses the file and compares it cell
  for cell.
- **The order of the rows.** Observations are written at the index of their cell
  and read back in index order, so the order is the order the cells were laid
  out, not the order the platform answered in — the same guarantee
  [ADR-0036](0036-one-order-on-every-machine.md) rests on, reached the same way.
  `tests/same-order-on-every-machine.test.ts` and the resume test that compares a
  resumed walk against an uninterrupted one hold it.
- **The numbers the verdict is computed from.** Nothing here touches
  `summary.verdictInputs`, which is still taken before the rows are capped
  (the addendum to [ADR-0029](0029-evidence-rows-have-a-budget.md)).

`tests/runner/one-copy-of-the-matrix.test.ts` is the guard. It takes the live
heap twice — at the moment the last cell is handed to `record`, and after
`collectObservations` has returned — and refuses a walk that retains more than
1.2 copies of what it hands back. A ratio rather than a byte count, so that
adding a field to an observation does not send somebody back to re-measure a
threshold.

## Measurements

A matrix of `accounts × endpoints`, a fake client answering 200 with twelve
response headers built fresh per response, a policy that agrees with it so the
run has no findings, concurrency 32, then `buildAccessMatrix`, `describeMatrix`,
`buildReport` and the write — the whole of what the CLI does around the walk.
Peak RSS in MB, median of five readings per rung per build; **walk** is the peak
up to the moment `collectObservations` returns.

| cells   | walk before | walk after |       | peak before | peak after |
| ------- | ----------- | ---------- | ----- | ----------- | ---------- |
| 600     | 67          | 67         | 0%    | 70          | 70         |
| 2 400   | 72          | 71         | −1%   | 82          | 82         |
| 6 960   | 81          | 80         | −1%   | 101         | 101        |
| 16 000  | 96          | 91         | −5%   | 115         | 133        |
| 33 100  | 113         | 104        | −8%   | 146         | 137        |
| 72 000  | 135         | 120        | −11%  | 200         | 180        |
| 127 760 | 179         | 137        | −23%  | 267         | 343        |
| 279 120 | 241         | 194        | −20%  | 556         | 463        |
| 576 000 | 388         | 302        | −22%  | 1019        | 916        |

The absolute numbers are lower than J-10's because that measurement ran the CLI
against a platform answering with far more header material; the shape — linear,
and dominated by the same three structures — is the same.

**The walk's peak came down by up to a quarter and the reduction grows with the
matrix**, which is what removing two of three copies from that phase should look
like. The retained-copies ratio went from 1.478 to 1.010.

**The peak of the whole run did not move.** It is set during
`buildReport`, after the walk's own memory is already garbage, and at that moment
the live set is the observations, the `describeMatrix` cells and the
`ReportedObservation` rows — the three J-10 named. The `peak` column above is
also bimodal in **both** builds at the two largest rungs: repeated readings of
one build land on either side of a V8 heap-growth threshold (before: 808–1119 at
576 000 cells; after: 913–918). The column is reported for honesty, not as a
result; the walk column is the result.

## Alternatives

**Rebuilding the observations out of the observation stream.** The stream of
[ADR-0047](0047-a-walk-that-survives-its-run.md) already carries every finished
cell to disk, and it is tempting to read it back instead of keeping the array.
Rejected, and it was rejected once already, in that ADR's own alternatives: the
stream must not become a second source of truth. It would also make a normal run
depend on a file that deliberately does not exist without `--report`, and put a
file system inside a runner that has none by design.

**Making `CollectResult.observations` lazy.** A getter, an iterable, anything
that is not an array. It buys nothing: `withVerdicts` maps over the observations
and materialises the result whatever the input was, so the copy reappears one
layer down — and the type is the contract `src/cli.ts` and every library consumer
read through.

**Compacting the holes into a fresh array.** One line shorter and it puts a
second full array beside the first at the end of the walk, which is the thing
this ADR removes.

**A packed array instead of a holey one.** `new Array(total)` leaves holes, and a
holey array is the slower shape in V8. Tried and measured: 918 MB against 915 at
576 000 cells — no difference outside the noise, and it needs a cast through
`unknown` to type. Not taken.

**Shrinking the observation itself.** Measured and there is nothing there: 344
bytes per cell at 576 000 cells, against roughly 320 for the object, the header
record, the URL and the timestamp counted by hand. The shape is already what it
has to be.

## Consequences

**What is left, and why it is left.** The three materialisations J-10 named all
survive, and each is behind a file this change could not touch:

- **`observations`** is `CollectResult.observations`, read by `src/cli.ts` three
  times and typed as an array. Removing it is a change to the library's public
  surface and to its only consumer, not a change to the walk.
- **`cells`** is what `describeMatrix` returns (`src/core/diff.ts`), and
  [ADR-0020](0020-verdict-next-to-observation.md) is why it exists as one walk
  producing both the verdicts and the discrepancies.
- **`ReportedObservation`** is `withVerdicts` in `src/report/build.ts`. It is a
  shallow copy — the header record is shared with the observation, so it costs
  the object and not the response — which is why it is 168 bytes per cell rather
  than 344.

Their live cost, measured at 576 000 cells: 198 MB, 61 MB and 97 MB. Removing any
of them means changing the shape of what `collectObservations` returns and how
`buildReport` consumes it, in one change across `src/runner.ts`, `src/cli.ts`,
`src/core/diff.ts` and `src/report/build.ts`. That is the next piece of this, and
it is not this one.

**The ceiling on the run is therefore still where J-10 left it**, at roughly
620 bytes per cell of live data and about twice that in peak resident set. The
ceiling that moved is the one on the walk.

**The walk's cursor is subtler than the counter it replaces.** `next++` needed no
lock because nothing awaits between the read and the increment; `take` needs the
same argument over three variables instead of one, and it is written down beside
it. A suspension point introduced into `take` would hand one cell to two workers.

**An unreachable branch was added.** `cells[…]` reads as `Cell | undefined` under
`noUncheckedIndexedAccess`, and the index is always in range by construction.
It is answered with a `continue` rather than a `!`: `noNonNullAssertion` is on,
and this would be the one place in the walk where the checker was told to stop
looking. The walk it replaced carried the identical guard on `tasks[index]`.

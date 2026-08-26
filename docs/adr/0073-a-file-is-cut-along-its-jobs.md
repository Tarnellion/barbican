# 0073. A file is cut along its jobs, not along its length

- **Status:** accepted
- **Date:** 2026-08-24

## Context

On 23 August 2026 four modules were cut into directories — `report/build`,
`io/config`, `cli` and `runner` — each behind a barrel that kept every import
path intact. ADR-0054 is the largest of them: `build.ts` was 3 012 lines doing
five things, and it became five files along lines the code already drew.

Those cuts left five files over 800 lines standing, and three of them are the
report layer. The obvious next round is to cut them for the same reason, and this
document is the record that the reason does not carry over. The four were
measured before anything was decided:

| module | total | prose | blank | code |
| --- | ---: | ---: | ---: | ---: |
| `src/report/shape.ts` | 1 129 | 873 | 22 | 234 |
| `src/report/compare.ts` | 984 | 316 | 55 | 613 |
| `src/report/pack.ts` | 855 | 353 | 40 | 462 |
| `src/report/findings.ts` | 793 | 342 | 24 | 427 |

Taken before this round's own change. `src/report/compare.ts` is **1 020** lines in the tree
this document lands in: the paragraph it grew is the one on `ProbedEndpoints`, and
the change that wrote this sentence also removed two lines net, so the first
version of it said 1 023 and was wrong by the time it was committed. A file that
gets longer by being explained is the thing this table is about — and a count of a
file, written into that file's own commit, is the thing ADR-0065 is about.

The `total` and `blank` columns above are each one line high, for the reason a
line count usually is: the split on newline yields an empty string after the last
one. `code` and `prose` are exact. Left as measured rather than silently adjusted,
because the correction is the interesting part.

The first row is the whole argument about `shape.ts`: **77% of it is prose.** It
is a type graph with the reasoning written beside each field, and the reasoning
is what makes it worth reading. Splitting a type graph puts a field on one side
of a seam and the paragraph explaining why the field exists on the other. The
1 128 lines that make it look like the biggest problem in the tree are the
measure of how much was written down, not of how much is happening.

## Decision

**None of the four is cut.** A file is cut when it holds more than one job, at a
seam a decision already names — which is what ADR-0054 did — and not because a
line count is large. The jobs each holds, which is the reading the decision rests
on:

- **`shape.ts` — one job: what a report is.** 234 lines of code, all of it
  interface declarations plus `nothingLeftUnnamed`. There is no second job in it
  to take out.
- **`findings.ts` — one job: the two channels merged, and everything keyed by a
  cell.** Its own header already argues the seam and argues against cutting it:
  merging the channels, marking what an acceptance holds, counting, capping the
  evidence and carrying the result back onto the observations are one order of
  one job, and splitting them would put `cellKey` on two sides of a seam. The
  comment on what happens when a key is written in two places is in
  `src/core/keys.ts` for exactly that reason.
- **`pack.ts` — the pack, and the reading of a saved report into one.** The
  second of these looks like the seam `document.ts` was cut along on 25 August,
  and it is not the same seam. `document.ts` owns the sentence every reader has
  to make true — every string out of a saved report goes through the identifier
  grammar — and its header says what stays with each reader above it: *"Each
  reader above it names the fields it needs and stops there."* Naming the fields
  a pack needs is the pack's business: 156 lines, 114 of them code, and every one
  of them a field name and the type it must be.
- **`compare.ts` — comparing, rendering the comparison, and reading a saved
  report.** This is the one with a defensible second seam: the directory already
  pairs a builder with a renderer twice, `build.ts` with `write.ts` and `pack.ts`
  with `page.ts`, and the render half is 197 lines — 149 of them code — that
  decide nothing. It is still not cut, for two reasons. The file is six commits old and nothing has
  gone wrong in it that a seam would have prevented; and the render half reads
  the comparison types and writes none of them, so a reader following a sentence
  back to the number it prints would cross a module boundary that buys them
  nothing. The seam is worth taking the day something is written twice across it.

## Alternatives

**Cut `compare.ts` at the render seam anyway, for symmetry with `pack.ts` /
`page.ts`.** Rejected on the evidence above, and recorded rather than dropped
because it is the one of the four that will come back. Symmetry is a reason to
look, not a reason to cut.

**Give the standard-and-clause index one home.** The two-level
`Map<string, Map<string, T>>` keyed by a standard and then a clause is written
four times — `matrixClauses` and `clauseAnswers` in
`src/core/standards/answers.ts`, `rowFor` in `src/core/standards/coverage.ts`,
and `ByClause` in `src/report/pack.ts` — and the reasoning beside it ("a
separator would be a character both halves may legally contain") is written
three times in three wordings. It looks exactly like the shape ADR-0064 took six
tables for, and it was measured before it was believed: the four copies are 37
lines of index code, and one module owning them plus four imports is about the
same. **Net zero lines, and it would not hold the decision it appears to hold** —
the defect would be a fifth site that *joined* the two coordinates, and a site
that joined them would not import the shared module. The rule in `CLAUDE.md` is
about a decision whose copies can drift; these four cannot, because each
independently does the only thing the structure allows. Named here so the next
reader does not have to measure it again.

**Memoise `controlClausesForCell`.** It allocates a three-element array per cell
over a domain of four relations. Measured at 16 000 cells: 0.07 ms of the
1.32 ms `clauseCoverage` costs — 5% of a function that is already linear.
Rejected as a change no number supports.

**Compute `unconfirmedCredentials` once per `buildReport` instead of three
times.** It is called from `clauseReservationsOf`, from `warningsFor` and from
`verdictOfRun`. Its own doc block argues that being one function with three
callers is the point — the pair that was written twice drifted within four days
— and the input is the account list, which is tens of rows, not thousands.
Threading a result through three signatures to save microseconds would trade the
argument for nothing.

## Consequences

- The report layer keeps four files over 800 lines, and this document is the
  answer to "why has nobody cut these".
- Line count stops being evidence on its own in this repository. The number that
  decides is how many jobs a file holds; `shape.ts` at 1 128 lines and 234 of
  code is the example to reach for.
- The `compare.ts` render seam is written down as *not taken*, with the condition
  that would take it: something written twice across it.
- Two things were changed in the same round, both measured, neither a cut: the
  probed-endpoint sets in `compareRuns` are built once instead of twice
  (5.16 ms → 2.43 ms over a pair of runs of 80 000 observations), and `pathTo` in
  `src/report/document.ts` became module-private, having been exported by the
  25 August cut and never read from outside.

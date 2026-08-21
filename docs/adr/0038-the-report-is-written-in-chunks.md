# 0038. The report is written in chunks, through a file beside it

- **Status:** accepted
- **Date:** 2026-08-21

## Context

`JSON.stringify(report, null, 2)` builds the whole document in memory before a
byte reaches the disk, and a string in node stops at 536 870 888 characters.

The project met that wall once already and answered it in one place.
`MAX_ROWS_PER_DEFECT` exists because 2 000 accounts on one endpoint produced
1 999 000 evidence rows and `RangeError: Invalid string length` at the last step
of a run; the reasoning is written beside the constant. The cap bounds
`findings`.

It does not bound `observations`, which carries one row per cell whether
anything was found there or not — around 680 bytes of it even on a run with no
findings at all. So the wall stayed reachable from the other side, and the audit
of 20 August 2026 (J-1) walked into it: 57 826 cells against a platform that
answers with 196 headers gave

    Run aborted: Invalid string length

with every request sent, every finding discarded, no file on disk, and an error
naming a string length rather than anything the operator did. The threshold is
not the operator's to predict either — it moves with how many headers the target
sends: 692 000 cells at six headers, 74 000 at 126.

## Decision

The report is serialised in chunks (`src/report/write.ts`) and piped to its
destination. The largest string the process holds is one observation.

The output is byte-for-byte what `JSON.stringify(report, null, 2)` produced.
Things read this file: the polygon's oracle parses it and compares it cell for
cell, `tests/docs/report-example-numbers.test.ts` reads numbers out of it, and an
operator diffing two runs would otherwise see every line move.
`tests/report/write.test.ts` asserts that equality over the shapes that break a
hand-written serialiser — nesting, empty arrays, `undefined` values that
`JSON.stringify` drops, escaping, unicode, `-0` — rather than trusting this
paragraph.

A write spread over time is a write that can be interrupted halfway, so the file
goes to `<path>.partial` first and is renamed onto the destination. The rename is
atomic: the path holds either the previous run or this one, never half of this
one. The permissions are set twice, on the staging file and again after the
rename, because `mode` on an open applies to a file being **created** — a report
written a second time into the same path used to keep whatever permissions it
already had (L-10).

## Alternatives

**Cap `observations` the way `findings` is capped.** The cap on evidence rows
works because those rows are redundant: the report already collapses them into
one defect group, and the counts, the severities and the exit code all survive.
Observations are not redundant — dropping them drops the record of what was
tested, which is the half of the report that says a cell was looked at.

**Write NDJSON and assemble the document afterwards.** It would also remove the
ceiling, and it changes the format for every reader to solve a problem inside the
writer.

**Stream the observations during the walk, rather than at the end.** The larger
change, and the one that would also bound memory (J-10: the matrix is
materialised three times over a run, ~11 KB of peak RSS per cell) and make
`--resume` possible for a run that died halfway. It needs its own ADR and its own
tests; this one removes the ceiling on the file and nothing else.

## Consequences

A run whose report exceeds 512 MB now finishes. Measured while deciding this:
1 700 000 observation rows throw `RangeError: Invalid string length` through
`JSON.stringify` and write 598.3 MB through the chunks.

Memory is unchanged: the report object is still built in full before it is
written, and a report that large still needs gigabytes to hold. The ceiling that
moved is the one on the **file**, and the practical limit on a run is still the
one the audit measured at around 30 000 cells — where a 30 MB report needs
1.3 GB to parse back.

An interrupted run can leave a `<path>.partial` beside the report. That is
litter, and it is the trade for never leaving a truncated document where a good
report used to be.

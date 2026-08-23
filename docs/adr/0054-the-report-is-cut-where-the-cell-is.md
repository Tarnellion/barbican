# 0054. The report is cut where the cell is

- **Status:** accepted
- **Date:** 2026-08-23

## Context

`src/report/build.ts` was 3 012 lines. It was the largest file in the project by
a wide margin — `src/report/compare.ts` next to it is 971 — and it was doing five
different jobs:

1. declaring the report's shape and the shape of the call that produces it;
2. building the sections that describe the run — accounts, contexts, target,
   coverage, canaries;
3. merging the two channels a finding can arrive by, marking the ones an
   acceptance holds, grouping and counting them, capping the evidence;
4. concluding — the verdict, the exit code, the warnings;
5. serialising canonically, and taking the two digests over that serialisation.

Density of decisions per line is highest here, and it is measurable rather than
felt: one session against this file alone found a tautological check of the
schema version, a canonical serialiser writing `"tenant":null` for a key
`JSON.stringify` drops — which made every honest report fail its own digest — and
two counters that counted the same rows twice. All three are closed. What they
say about the file is that a reader has to hold five vocabularies at once to
review one change to it, and that is the cost being paid down here.

The size alone would not be an argument. `compare.ts` is 971 lines and does one
thing. The argument is the five vocabularies.

## Decision

**Cut along the cell, not along the line count.** The file becomes five modules,
and `src/report/build.ts` stays as the import path.

- **`shape.ts`** — `RunReport`, `BuildReportOptions` and everything they are made
  of, plus `nothingLeftUnnamed`. Both halves of the declaration in one file:
  what a consumer parses and what a consumer passes are the same contract read
  from its two ends, and both are on the package's surface.
- **`findings.ts`** — the two channels merged into one list, and everything else
  keyed by a cell: the acceptance marks, the counters, the evidence cap, and the
  projection of the finished list back onto the observations (`withVerdicts`) and
  onto the judged cells (`judgedCells`).
- **`sections.ts`** — who took part and how much of the surface was reached.
  Nothing here is keyed by a cell.
- **`verdict.ts`** — what the run concluded, and the warnings. Both read a
  finished `VerdictInputs` and nothing else.
- **`canonical.ts`** — one serialisation whose result depends on meaning, and the
  two digests over it. It knows nothing about a report.

### Why the seam runs where it does

`cellKey` decided it. The comment on that function records that the key had been
written out by hand in five places and that a sixth had to agree with all five
for a verdict and a finding to meet on the same cell. Any cut that leaves
`cellKey` on two sides of a seam recreates that state with a module boundary in
the middle, where drift is harder to see rather than easier. So everything keyed
by a cell went into one file — which is why `withVerdicts` and `judgedCells` sit
beside `mergeFindings` rather than under "coverage", where a table of contents
would have put them. The reward is visible in a comment that did not have to be
edited: `judgedCells` says that a second reading of `match` "in this file" would
be the two-sources-of-verdict defect `withVerdicts` exists to avoid, and after
the cut that sentence is still true of the file it is in.

Two helpers cross a seam on purpose, and both were already single-source-of-truth
functions with the drift they prevent written on them:

- `nothingLeftUnnamed` has six call sites across `findings.ts` and `sections.ts`.
  It lives in `shape.ts` because it is a statement about what a published field
  costs, not about either mapping.
- `unconfirmedCredentials` lives in `verdict.ts`, where two of its three readers
  are, and `clauseReservationsOf` in `sections.ts` imports it. Its own comment
  already named that third reader: the pair was written twice once and drifted
  within four days.

The dependency graph is acyclic and one-way: `shape` ← `findings` ← `verdict` ←
`sections`, with `build.ts` above all four and `canonical.ts` beside them.

### The import path does not move

`src/report/build.ts` re-exports, **by name**, the twenty-seven values and types
it exported before — eight values and nineteen types — so no import anywhere in
this repository or in anybody else's changed, and `src/index.ts` is untouched.

A list rather than `export *`. The four modules export a good deal more to each
other than the package ever promised a consumer: `canonical`, `cellKey`'s
neighbours, `warningsFor`, `nothingLeftUnnamed`. `export *` would put every one
of them on the published surface, which the next release is then answerable for —
and `tests/public-surface.test.ts` exists because a surface nobody enumerated is
a surface nobody noticed changing.

Under `verbatimModuleSyntax` a type re-exported without the `type` modifier is
emitted as a runtime re-export of a name that does not exist at runtime, and the
package fails at import. Every type in that block therefore goes through
`export type`.

## Alternatives

**Leave it.** The file works and is well commented. Rejected because the comments
are the asset: they are the record of what each audit found, and a file nobody
will open in full is a file whose comments are not read before the next change to
the line above them.

**Cut by section of the report** — one module per top-level field of `RunReport`.
Rejected: it puts `cellKey` on both sides of the observations/findings boundary
and splits `withVerdicts` from `mergeFindings`, which is where "a cell is
`match: true` and carries a finding" came from once already.

**Cut into more, smaller files.** Rejected on the same grounds: a 300-line module
that does one thing beats four 80-line modules with five functions travelling
between them, and the traffic between modules is what a reader has to hold in
their head.

## Consequences

- Behaviour is unchanged, and it is proved rather than asserted: every moved line
  is the original text, and the whole diff of the moved code is the added
  `export` keywords, the signatures Biome rewrapped because `export ` pushed them
  past 100 columns, and three comment edits. The 29 polygon combinations produce
  reports that are byte for byte what they were once the run identifier, the
  timestamps, the per-request durations, the platform's `Date` header and the
  per-run digest salt are folded — and `contentDigest`, which hashes all of them.
- The report layer's coverage thresholds are per directory (`src/report/**/*.ts`),
  so the split does not move the gate.
- `nothingLeftUnnamed` and `canonical` are exported where they were file-private.
  Both are exported no further than this layer, and the reason is written on each.
- A pointer went stale and was fixed with the move: the failure message in
  `tests/report/report-shape.test.ts` told the author to raise
  `REPORT_SCHEMA_VERSION` in `build.ts`, where there is now a re-export.

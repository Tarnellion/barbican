# 0050. A comparison is of defects, not of files

- **Status:** accepted
- **Date:** 2026-08-22

## Context

The two questions an operator asks of a second run are "what changed since
yesterday" and "is this the platform regressing, or did I edit the declaration".
Both halves of both answers were already in the report, and nothing read either.

`configDigest` exists for exactly the second question — `docs/report.md` says it
is there "to tell 'the platform changed' from 'we changed the declaration'" — and
`defects[].key` was made readable and stable across runs (H-10, ADR-0030) so that
a ticket could cite one defect by name a month later. Between them they are the
whole vocabulary a comparison needs.

There was no `diff` subcommand. The CLI knew `run` and `schema`; the
documentation had no section and no example about comparing two runs; and the
obvious fallback does not work. A plain `diff` of two report files reports a
difference on every line that matters least: `runId`, `startedAt`, `finishedAt`,
`at` and `durationMs` on every observation, and every `signals.digest` — the
digest salt is drawn per run on purpose. Two runs of one matrix against one
unchanged platform produce two files that differ almost everywhere and agree on
everything worth knowing. Found as M-17.

Three things make the obvious implementation of the subcommand wrong, and each
of them is a way of handing an operator a false clean:

1. **The finding row is the wrong unit.** A single defect is one row or fifty,
   depending on the evidence budget of ADR-0029 and on how wide the matrix is;
   `violations` moves the moment an account or a resource is added to the
   declaration. Comparing rows means a comparison that is loud on every run and
   informative on none — and, worse, that reports a *reduction* in rows as
   progress.
2. **A disappearance is not a fix.** A defect is absent from the second report
   both when the platform was repaired and when nothing went looking. The two
   are byte-for-byte identical in the `defects` array, and only `coverage` and
   the observations distinguish them.
3. **An acceptance looks exactly like a repair.** ADR-0048 keeps an accepted
   finding in the report and takes it out of the verdict. So a run whose exit
   code fell from 1 to 0 because somebody signed for the defect is, to every
   counter and to the exit code beside it, a run against a platform that was
   fixed.

## Decision

`barbican diff <before> <after>`, over two saved reports. `src/report/compare.ts`
holds it: `compareRuns` is pure and takes the two documents, `renderComparison`
turns the result into lines carrying a tone, and `src/cli.ts` reads the files and
chooses the colours — the same split `WARNINGS` and `WARNING_STYLE` have, for the
same reason. `--json` writes the comparison to stdout while the summary goes to
stderr, as `run` already does with the report, and both come out of one
`compareRuns` so the file and the terminal cannot disagree.

**The declaration is the first thing it says.** A changed `configDigest` produces
a line before coverage and before a single defect: part of what follows may be
the reader's own edit. It is deliberately *not* a difference in its own right and
does not move the exit code — two runs finding the same defects over the same
surface under two declarations describe a platform in the same state — but a
reader who is not told will read an edit as a regression.

**The unit is the defect**, joined on `defects[].key`. A defect is *changed* along
three axes and no others: the set of `kinds`, the `severity`, and whether an
acceptance holds it out of the verdict. `violations`, `accountIds` and
`resourceIds` are printed and compared by nothing — they describe the matrix that
was walked, not the platform under it.

**Every appearance and disappearance is attributed.** For each defect present in
one run and not the other, the comparison asks whether the *other* run probed
that endpoint at all, taking the answer from `observations[].endpointId` — what a
run really asked about, not what it was handed. A disappearance on an endpoint
the second run never touched says "nothing was fixed, nothing was looked at". An
appearance on an endpoint the first run never touched says the opposite
reassurance: this may be newly covered rather than newly broken.

**A difference in coverage is a difference.** Cells observed, endpoints probed,
the endpoints each run asked about, and `coverage.notProbed` by reason. Coverage
that grew is news and exits 1; coverage that *shrank* is a blocker and exits 2,
because every disappearance below it is then unexplained.

### The exit codes

The CLI's convention is 0 clean, 1 checked and it disagrees, 2 the result cannot
be trusted, 64 the command line was wrong. Each keeps its meaning one level up:

- **0** — the same defects, over the same surface. The only clean answer.
- **1** — the two runs do not describe the same platform: a defect appeared,
  went or changed, or the surface probed is not the same.
- **2** — the comparison cannot be trusted, and it outranks 1 for the reason it
  does in `runVerdict`: what was not tested is never clean. Six ways to get it.
  Two stop the comparison before it starts — the two files carry different
  `schemaVersion`s, so a field-by-field reading would compare fields that moved
  between the shapes; or they agree with each other on a version this build does
  not read. Four let it run and print in full, because the reader still wants to
  see it: the two files record the same `runId`; either run is `truncated`;
  either run's own verdict was 2; or coverage shrank.
- **64** — what the argument parser rejects, and nothing else. The line is where
  `docs/report.md` already draws it: 64 is decided before the command does any
  work, so a path that is not there, a file that is not JSON and a document that
  is not a report are all **2** — conclusions the tool refuses to draw, not
  mistakes in the invocation.

A truncated run is compared rather than refused, and this is the deliberate part:
its report is honest as "here is what we managed to look at", and refusing it
would leave an operator whose CI job was killed on its timeout with no way to see
what the half-run did find. The exit code says the comparison settles nothing;
the screen still shows everything.

## Alternatives

**Compare finding rows.** Rejected above: the row count is a property of the
matrix and of the evidence budget. It also inverts the sign — a narrower run
produces fewer rows, which reads as improvement.

**Hash the report with the volatile fields stripped, and compare hashes.** Cheap,
and it answers only "something changed", which is the one thing a reader can
already see. It cannot say *what*, and it cannot distinguish the platform from
the declaration — which is the whole question.

**Make `run` compare against a previous report itself, with a `--baseline` flag.**
Rejected: the comparison would then only exist where a run is being made, and the
common case is comparing two artifacts that already exist — in CI, from two
pipeline runs, often on a machine that is not going to touch the platform at all.
A subcommand that takes two files needs neither credentials nor a scope.

**Refuse a truncated report.** Rejected: see above. Refusing hides the half that
was walked, and the operator who most needs to look at a partial run is the one
whose job was killed.

**Make a changed `configDigest` a blocker (exit 2).** Rejected. Comparing two runs
across a deliberate change of declaration is a normal thing to want — "I widened
the policy, what does that do to the findings" — and answering 2 to it would
train people to ignore the code. The caveat is loud and it is first; that is the
right weight for it.

**Derive "probed" from `endpoints` minus `skipped` instead of from the
observations.** Rejected: those describe the plan, and a run cut short executes
less of the plan than it made. `observations[].endpointId` is what was really
asked.

## Consequences

An operator gets the two answers the report was already carrying the ingredients
for, and CI gets a code it can act on: 1 means the platform moved, 2 means do not
draw a conclusion from this pair. `defects[].key` acquires a second consumer,
which is worth noting — it was already documented as stable, and it is now
load-bearing in a way a change to `citableDefectKey` would break loudly rather
than quietly.

The comparison reads a narrow structural view of a report, not `RunReport`. That
keeps a report parsed off disk honest — it is unchecked JSON until
`toComparableRun` has looked at it — and it means a field added to the report
does not reach the comparison by itself. That is the cost: a future field worth
comparing has to be added here on purpose. It is the same trade `buildReport`
makes by naming its fields one at a time, and `tests/report/compare.test.ts`
carries hand-written fixtures while `tests/invariants/cli-surface.test.ts` runs
the tool twice against one stub and diffs the two real reports, so a shape that
drifts apart from what `buildReport` writes fails there.

**Revisit when** a second consumer wants the comparison at a finer grain than the
defect — an evidence pack of Module 2 asking which *clauses* stopped being
covered is the likely one. `findings[].standards` and `coverage.checksRun` are
where that would come from, and both are in the report already; they are left out
here because a first version that compares everything comparable is a version
whose output nobody reads.

## Note, 24 August 2026: the unit is the defect, and the key was not the defect

Two sentences above are narrowed by ADR-0067, and one of them is the sentence
this note exists for.

"**The unit is the defect**, joined on `defects[].key`" — the unit is what it
was and the join is not. That key is `citableDefectKey`: the three coordinates
joined **with a space**, for a person to paste into a ticket. ADR-0066 made a
space a legal character in an identifier, deliberately, so the string names two
defects at once —

```
A = { endpointId: "a",       relation: "own",         contextId: "b same-tenant d" }
B = { endpointId: "a own b", relation: "same-tenant", contextId: "d" }
```

— both printed `a own b same-tenant d`, and merged into one entry by the `Map`
this ADR describes. The comparison joins on the coordinates now, through
`defectSignature`, which is what `groupDefects` decided the two were groups by in
the first place.

And in Consequences: "`defects[].key` acquires a second consumer … load-bearing
in a way a change to `citableDefectKey` would break loudly rather than quietly."
The second consumer prints the key beside every row and no longer joins on it, so
less depends on the citable form than that sentence claims — which is the safe
direction for it to be wrong in, and it was wrong all the same.

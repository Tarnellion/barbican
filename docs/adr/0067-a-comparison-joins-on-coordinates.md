# 0067. A comparison joins on coordinates, not on the citable key

- **Status:** accepted
- **Date:** 2026-08-24

## Context

`src/report/compare.ts` indexed two saved reports on `defects[].key`:

```ts
const beforeByKey = new Map(before.defects.map((one) => [one.key, one]));
```

That string is `citableDefectKey` — the three coordinates of a defect joined
with a **space**, made readable so that a ticket can cite one defect by name a
month later.

ADR-0066 gave identifiers a grammar, and a space is legal in one deliberately: a
name is a name, and refusing a space would refuse half the endpoint ids a
document can carry. So the citable form names two defects at once. Measured
against the built tree on 24 August 2026:

```
A = { endpointId: "a",       relation: "own",         contextId: "b same-tenant d" }
B = { endpointId: "a own b", relation: "same-tenant", contextId: "d" }
citableDefectKey(A) === citableDefectKey(B)   // true,  "a own b same-tenant d"
defectSignature(A)  === defectSignature(B)    // false
```

Every string in both is a legal identifier. Nothing slipped past a grammar here —
this is the separator being a character that occurs in the parts, which is the
whole reason `defectSignature` does not use one.

**It does not take two files.** `groupDefects` keys on the signature, so a report
this tool wrote carries **both** rows, under one `key`; the `Map` above kept the
last of them before the pair was compared with anything. The reading an operator
got: a first run finds both defects, a second run has one of them fixed, and the
comparison says one defect changed its `kinds` and its `severity` — a sentence
about a platform that had done neither, with the fix it did make nowhere in the
output, and the surviving defect matched against the wrong twin.

It was named under `Limits` in ADR-0066 and left open there, because closing it
means deciding what `defects[].key` is for. It is three things: written into the
report by `groupDefects` (`src/core/defects.ts`), pasted into a ticket by an
operator, and printed back by `accepted[].defect` (`src/report/findings.ts`).
None of the three is "index two reports on".

This is the note of 24 August on ADR-0048 one layer further out. There a form
written for people was used to decide whether two acceptances were one; here it
was used to decide whether two defects were one.

## Decision

**The comparison joins on the coordinates.** `defects[].key` stays exactly what
it is — the citable form, read out of the file, printed beside every row it
belongs to.

`defectIdentity` in `src/report/compare.ts` asks `defectSignature`, which is the
function that decided these were two groups when the report was written. The run
that wrote the file and the comparison that reads it back therefore agree by
construction rather than by two authors agreeing, and there is no second notion
of "the same defect" to drift. Its parts go through the identifier grammar, which
refuses the separator, so that joining is injective where a space is not.

**Nothing is added to the report.** The coordinates are already in it —
`endpointId`, `relation` and `contextId` on every defect group — and
`toComparableRun` already lifted all three out of the document.

`ChangedDefect.key` is now the citable key **as the second run wrote it**, rather
than the map key it used to be: a signature is NUL-joined and has no business on
a terminal. The two runs agree on that string whenever both were written by this
tool; where they do not, the row is about what is there now, which is also the
run `changed` is sorted by.

## Alternatives

**A machine key beside the citable one, written into the report.**
`defects[].signature` from `groupDefects`, indexed by the comparison. Rejected on
the thing this subcommand is for: it compares yesterday's file with today's, and
yesterday's file has no such field. The comparison would need a fallback to
`defects[].key` — the ambiguous string — so the defect would survive in exactly
the case the feature exists for, and would go on surviving for as long as anyone
keeps a report. It also puts two keys for one defect into a document a person
reads, and a reader then has to know which of the two is the one to cite;
ADR-0059 is titled against precisely that.

**Make `citableDefectKey` unambiguous** — quote the parts, or join with a
character an identifier may not carry. Rejected twice over. The string is the
operator's: it is in tickets already written, in the `accepted[].defect` of every
report this tool has produced, and in the message `src/io/config/parse.ts` prints
when it refuses a duplicate acceptance. Changing its bytes breaks a citation that
has already been made. And the second half reopens a grammar decision: ADR-0066
admits a space on purpose, and a citable form that escapes is a second grammar to
keep in step with the first — the duplicate ADR-0024 exists against.

**Refuse a report whose defects share a `key`.** It is a legal report that this
tool wrote, so this is the tool refusing its own output. The two rows are correct
and the index over them was not.

**Compare by coordinates spelled out here** — a template literal over the three
fields, glued with a separator written into `compare.ts`. That is a second
implementation of a defect's identity, in the layer furthest from the one that
owns it, and it drifts the day a fourth coordinate is added to a defect. `defectSignature` is exported for
callers with this exact need (ADR-0029 made it so for the evidence budget).

## Consequences

Two reports are joined on the identity the core assigns, so the comparison counts
the defects the run counted. The pair above is two rows in each file and two rows
in the comparison.

`defects[].key` stops being load-bearing for identity. ADR-0050's Consequences
say it "acquires a second consumer … load-bearing in a way a change to
`citableDefectKey` would break loudly rather than quietly"; that sentence is
narrowed by this one — the second consumer prints the key and no longer joins on
it. Both halves move in the safe direction: less depends on the citable form, and
what the comparison depends on is the thing that already decided the grouping.

No change to the report shape. `schemaVersion` stays `"2"`, and a report already
on disk — including one written before this change — compares correctly, because
what the comparison now reads is what those files already carry.

The output changes only where the old key was ambiguous. Everywhere else the
coordinates and the citable key are in bijection, so `gone`, `appeared`,
`changed` and `unchanged` are what they were.

**`compareRuns` can now throw `UnusableIdentifierError`, and only through the
library door.** `joinKey` refuses a part that is not an identifier, and indexing
on a string read out of the file did not. From the CLI nothing changes:
`toComparableRun` put every string through the same grammar before it built the
value, so such a file was already refused at the door with the field and the file
named. `compareRuns` is exported on a structural type that a consumer's own
`RunReport` satisfies without passing `toComparableRun` — documented that way in
`docs/library.md` — and that call now meets the seam ADR-0066 put under the doors
for exactly this. A report `buildReport` wrote cannot reach it: `groupDefects`
builds the same signature and would have thrown first.

## Limits: what this does not hold

Written the way ADR-0065 asks for: each of these was run before it was written
down.

- **`citableDefectKey` is still ambiguous, and nothing about it changed.** This
  ADR moves what depends on the string, not the string. A *new* index on
  `defects[].key` added tomorrow is this defect again, and no gate would see it:
  the ambiguity is in a legal grammar, so there is no character to scan for and
  no owned name being reached into. What holds is one sentence, and it is the
  only thing holding: identity in this repository is `defectSignature`, and a
  caller with a tuple to index by asks for it rather than rebuilding it.

- **Three tests hold the comparison to asking, and they are the only three.**
  Measured on the amended tree, 119 files, 1831 passed and 1 skipped: with
  `defectIdentity` returning `defect.key`, **3 failed, 1828 passed, 1 skipped** —
  the merge inside a single report, a fixed defect read as a changed one, and the
  seam. Measured in the other direction *before* they were written: the change to
  `compareDefects` alone left the whole suite green, 1828 passed and 1 skipped, so
  nothing had pinned the old behaviour either. All three are in
  `tests/report/compare.test.ts`, and they hold `defectIdentity` rather than the
  index: a second `Map` on `defects[].key`, built beside the first for some other
  question, is past all of them.

- **Two reports can disagree about the citable key of one signature**, and the
  comparison then prints the second run's and says nothing about the difference.
  It cannot happen between two files one build wrote; it can between two builds,
  if `citableDefectKey` ever changes its spelling. A fourth axis for it was not
  added, because a citable form that moves between builds is a release note
  rather than a per-defect row.

- **The two rows still print the same key.** A report carrying the pair above
  shows `a own b same-tenant d` twice, in `defects[]` and on two lines of a
  comparison, and a reader cannot tell them apart by eye. The coordinates beside
  each row are what distinguish them, and `relation` and `contextId` are printed
  by neither `defectLine` nor the report's own summary. Left as it is: a form
  that disambiguated on screen is the rejected alternative above wearing a
  different hat, and the pair needs an endpoint id containing a relation word to
  arise at all.

- **Arity is still the caller's**, unchanged from ADR-0066. `defectSignature`
  refuses a part carrying the separator; it does not know how many parts a defect
  has, so this rests on `groupDefects` and `defectIdentity` handing it the same
  three — which they do by handing it the same object type, `DefectCoordinates`.

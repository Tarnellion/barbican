# 0075. A count of this tree is measured where it is written

- **Status:** accepted
- **Date:** 2026-08-26

## Context

On 24 August 2026 four documents stated a count of this repository and were wrong
by the commit that stated it.

- `tests/docs/links.test.ts` gave a figure for the citations its own scan
  collects. The branch that wrote the sentence added seven more citations in the
  same commit.
- `README.md` gave the size of the published surface twice while a section
  describing that surface was being merged, and the merge moved it.
- `tasks.md` gave a commit count over "the range between the commit that last
  touched this file and this one" — a range whose right-hand end moves every time
  the file is touched, so the number was wrong within the hour.
- `docs/adr/0073` gave a line count for a module in the commit that took two lines
  out of that module.

Reading them as four instances of carelessness misses what they have in common,
which is that care is not what was missing. Each is a **self-referential
measurement**: the author counts the tree, writes the number into the tree, and
the writing is what makes the number wrong. Measuring more carefully first makes
the result *more* certain, not less. The four are separated by hours and by
authorship and they came out identical, which is what a structural defect looks
like from the outside.

The repository already had one instance of the cure and did not generalise it.
`tests/public-surface.test.ts` holds the two figures `docs/library.md` states
about the library surface against `Object.keys` over the namespace, and says why:
a number in prose is a claim like any other, and this is the cheapest place to
hold it. Those two numbers had been wrong since before `0.4.0` when that guard
was written. Every other number in every other document was still a claim nobody
checked.

## Decision

**A count of this repository, written into this repository, is measured against
the tree it is read on.** `tests/docs/a-count-of-this-tree.test.ts` is the gate.
It reads tracked markdown and the comments of tracked modules, finds the counts
the prose states about the repository, and measures each one. Run before a commit
— `pnpm run check` is where it runs — the tree it measures is the tree that commit
will have, the line stating the number included. That is the whole of the cure for
the self-reference: the measurement is not taken before the writing, it is taken
after it, by something that reads the writing.

Three things make it a gate rather than a pattern that flags numbers.

### 1. A population belongs in the table when something can enumerate it

Four do, and each is a question a command answers:

| the claim                          | what answers it                                   |
| ---------------------------------- | ------------------------------------------------- |
| the lines of a named file          | the newlines in that file                          |
| the files directly under a named directory | the tracked children of that directory     |
| the values the package exports     | `Object.keys` over the namespace of `src/index.ts` |
| the commits between two named commits | `git rev-list --count`                          |

That is the whole admission rule, and it is the boundary. "Eleven point fixes",
"eight doors", "nine shapes" are counts of this repository in every sense except
the one that decides — nothing enumerates them, so nothing can adjudicate them,
and a gate that flags what it cannot adjudicate is a gate people learn to
silence. "Five relations", "three layers", "two rules" are counts of a design and
not of a tree; they are out for the same reason and would be out even if
something could count them.

### 2. The tense is the claim, and only one tense drifts

The tense lives in the grammar rather than in a judgement made afterwards:

```text
`src/report/shape.ts` is 1 128 lines      — a claim about the tree now
`src/report/build.ts` was 3 012 lines     — a record of a measurement
```

A count in the past tense was true when it was taken and stays true; there is
nothing in it to drift. A count in the present tense is a claim about the tree
now, and the tree moves under it. Drift is the entire defect, so the gate reads
the second kind.

The counterpart falls out of it, and it is the more useful half: **a document
that records a decision speaks about the tree it was decided on, in the past
tense.** An ADR that says a module *is* a size is making a claim it has no way to
keep, and it will go red on the day the tree moves. That is not a nuisance; it is
the document being asked whether it meant a claim or a record.

One form has no tense of its own:

```text
`walk.ts` at 801 lines
```

That is an apposition, and the sentence's verb decides. For that form only, the
gate reads the sentence for a past auxiliary. The asymmetry is deliberate and it
runs in the conservative direction: a claim with a present-tense verb of its own
is read even inside a sentence otherwise about the past, because the verb is what
makes the claim.

This paragraph is itself the evidence, and it was not planned that way: the
example above stood in a code span rather than in a fence, and the gate failed on
its own ADR the first time the file was tracked. A code span is not a fence, and
nothing about the prose around it said "example".

### 3. A commit is an anchor; a date is not

A sentence that names exactly one commit is measured **at that commit**, whatever
tense it is in. That is what turns a record back into a question with an answer:

```text
`src/report/compare.ts` was 971 lines at `7531bff`
`docs/adr/` held 71 files, 0000 through 0070, at `29f99d7`
```

Both are checked, forever, because a commit is a tree and a tree does not move.
Two named commits in a sentence are a range and not an anchor — that is the fourth
population. A commit this clone does not carry is said to be unreachable rather
than failed, because a shallow clone is nobody's fault; a name that is no commit
at all fails, in the same words a link to a file that is not there fails.

**A date is refused as an anchor.** A day holds many commits and a population
moves inside it, so "there were 195 of them on 23 August 2026" names no tree to
measure against and cannot be argued in either direction. That sentence is the
first of the four defects above, and it is the shape this decision has the least
to offer: the gate does not read it, and the answer for an author who wants such
a sentence held is to name the commit instead of the day.

The published surface is the one population an anchor cannot help. Reading it
means running the code, and the code that runs here is this tree's — so an
anchored claim about it is left alone rather than answered against the wrong
tree.

### What this cost the documents

Eleven claims failed on the tree the gate was first run against, and every one is
fixed rather than excused. Three ADRs and one README release section gave the
size of the published surface in the present tense where all four are records.
`README.md` gave `shape.ts` as one line longer than it is. Four ADRs gave a line
count for a module that was exact at that ADR's own commit and is not exact now —
`compare.ts`, `parse.ts`, `run.ts` and `walk.ts` — and all four are anchored to
that commit rather than restated, so the argument each ADR made still has the
number it was made with. The census in `tasks.md` gave `docs/adr/` as one file
more than `29f99d7` holds, because the ADR it counted was on a branch that commit
does not carry.

One correction was found beside them and not by the gate. ADR-0055's note of
23 August said the split had left `parse.ts` containing the string `Error` not
once; at the commit that note was written in, the file held sixteen exported
error classes of its own and the string eighty-four times. ADR-0063 repeated it.
Both now carry a dated correction. It is a count of zero, in a document about a
gate, checked by nobody — the same family, and outside the table because a count
of a string in a file is a fifth population nobody but these two sentences needs.

## Alternatives

**Measure every claim at the commit that introduced its line, from `git blame`.**
The most attractive rejected option, and the one that would have caught all four
defects including the dated one, because all four were wrong at their own commit.
Rejected on two grounds, and the second is decisive. Blame re-dates a line on any
edit, including a reflow: a paragraph rewrapped in ADR-0054 would move its line
count to today's commit and the gate would then demand a number that makes the
ADR's argument false — a gate that forces a lie is worse than no gate. And blame
needs history a shallow clone does not have, so the verdict would depend on how
the reader cloned.

**Require an anchor on every count of the tree.** This would have caught the
dated shape as well. Rejected: it makes every ADR's ordinary sentence about a
module's size a red test until somebody does archaeology for a commit, and the
number that comes out of that archaeology is one nobody measured at the time. The
past tense already carries the meaning "this was true then", and asking for
provenance on top of it buys accuracy the reader was not missing.

**Flag every number that sits next to a noun.** Rejected on ADR-0065's evidence:
a gate that flags "five relations" is one people learn to silence, and a silenced
gate is worse than an absent one because the next reader believes it.

**Parse instead of scan.** Same answer as ADR-0065, for the same reasons, and the
same paragraph is the reason to reconsider if these scanners grow again.

## Consequences

- A present-tense count of one of the four populations is now a checked claim.
  Writing one costs nothing; getting one wrong is a red test naming the file, the
  line, the number and the measurement.
- A count in an ADR goes red on the day the tree moves past it, and the edit it
  asks for is one word — the tense — or one anchor. That is the intended loop and
  not an accident of the design.
- `tests/public-surface.test.ts` still holds `docs/library.md`'s two figures by
  name. The two gates agree by construction, because both count the same
  namespace, and they fail together rather than one covering for the other.
- **A commit cannot name itself.** The right-hand end of a range that includes the
  commit writing it is unnameable, and so is an anchor for a census taken in the
  commit that records it. Measured: at `29f99d7` `tasks.md` does not contain the
  string `29f99d7`; the sentence that names it was written two days later, in
  `04c2acc`. An anchored census therefore takes two commits, and this document's
  own verification figures below are unanchored records for exactly that reason.
- The gate reads `git ls-files`, so a document written but not yet added is not
  read, and the count it states is judged for the first time by the commit that
  adds it. That is the same consequence `tests/docs/language.test.ts` carries and
  it is deliberate: what ships is what git tracks.

## Limits

ADR-0065 is the reasoning for this section and it applies here without amendment.
Every form below was written into a tracked document, the whole suite was run, and
the outcome is what is recorded — no entry here is reasoned about rather than
executed. Seventeen mutations were run in all; the suite stood at 127 test files
and 1 966 passing, 1 skipped, so a green run below is that figure and a red one is
one failure against it.

**Green — these get past the gate:**

- **The past tense.** `is` changed to `was` on a live claim leaves the suite
  green. This is the largest way past, one word wide, and it is named in the test
  header as well as here. It is also not quite an evasion: the sentence now says
  something different, and something that was true.
- **A date instead of a commit.** "`run.ts` was 663 lines on 23 August 2026" is
  green. The refusal of the date as an anchor is what makes it green, and that
  refusal is the decision above rather than an oversight.
- **A pair of double quotes.** The wrong count inside them is green, because a
  quotation is somebody else's sentence — which is why ADR-0063 can quote
  ADR-0055's pointer without being asked to falsify it.
- **A fenced block.** Green, and this document leans on it: the example shapes
  above are in fences.
- **A population outside the table.** "The suite is 4 test files and `src/` holds
  9 directories" is green, both figures wrong.
- **A number written as a word.** "`src/report/shape.ts` is nine hundred lines" is
  green.
- **An untracked document.** Green. So is a tracked document whose extension the
  scan does not read — the same wrong sentence in a `.txt` file, added to the
  index, is green.
- **A bare past-tense record with a wrong number.** "`run.ts` was 1 lines", with
  the anchor removed, is green. A record is not read, and a false record is
  therefore not caught.

**Red — these the gate sees:**

- A wrong present-tense count, unanchored.
- The same, with a non-breaking space for the thousands separator, and the same
  again with a line break running through the number: the paragraph is flattened
  before it is read, so both are one count.
- An anchor moved to a commit where the file is a different size.
- An anchor that names no commit at all.
- A claim whose subject the tree does not carry, or carries twice: `compare.ts`
  answers for two files, and a reader following it has the same problem the gate
  does.
- A subject whose letter case is wrong, on every operating system, because the
  comparison is against what `git` records and not against what the file system
  will forgive.

One mutation was written, run, and turned out not to be an attack at all: moving
ADR-0056's anchor from `339fd42` to `8e12a1e` left the suite green, and the reason
is that `src/cli/run.ts` was 663 lines at both. It is recorded because a `Limits`
section that only lists the mutations that behaved is a section somebody edited
afterwards.

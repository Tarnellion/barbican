# 0062. A comment describes the symbol under it

- **Status:** accepted
- **Date:** 2026-08-23
- **Amended:** 2026-08-23, after adversarial review of this document and of both
  gates it describes. Every count below is measured on the tree at the amending
  commit; the ones that were not are listed in the addendum with what they said.

## Context

A comment in this repository is not a restatement of the code. It carries the
*reasoning* — what was tried, what it cost, why the decision went one way — and
for most of the invariants in `CLAUDE.md` it is the only record of the argument
that produced them. That is what makes a detached comment expensive in a way a
stale comment usually is not. A stale comment is a sentence that has stopped
being true; a detached one is a true sentence filed under the wrong name, and
the reader who acts on it acts on a fact about a different piece of code.

A sweep on 22 August 2026 found twelve of them by reading, and one was about a
security guarantee that had moved.

### The one that mattered

Above `sanitizeLocation` in `src/adapters/http.ts` stood:

> `location` is useful for digging into a 3xx, but its query and fragment carry
> tokens (…). We keep only the address without parameters.

That was true until 17 August 2026, when adversarial review found that a
password-reset link, a magic link and a device-code flow all carry their token
in the **path** — so
`https://sso.example.com/reset/PASSWORD-RESET-TOKEN?[REDACTED]` went into the
report with the redaction mark sitting next to the secret. The function was
changed to keep the origin and nothing else, and the block explaining that was
written directly under the old one rather than in place of it.

A reader who stopped at the first block concluded that the redirect path reaches
the report intact — and treats the artifact accordingly, which is the wrong way
round from every point of view: the artifact is *safer* than the comment claimed,
and a reader who does not trust it stops attaching it to tickets, which is the
one thing it is for. In the other direction the same shape is worse: had the
change gone from "origin only" to "path kept", the stale block would have told a
reader the file was safe to hand over.

### The other eleven, and the twelve nobody was looking for

Ten were a doc block separated from its subject by something inserted between the
two — `ResourceRelation`'s reasoning standing over `RESOURCE_RELATIONS`,
`relationOf`'s fifteen lines about [ADR-0013](0013-tenant-hierarchy.md) and
[ADR-0017](0017-account-tenant-set.md) standing over the three-line
`principalOf`, `SignedRequest`'s "there is no body here" standing over
`ContextAttributes`. The eleventh was a superseded block left above the symbol
whose replacement sits below it: the sentences the console and the report share,
in `src/report/verdict.ts`. `sanitizeLocation` above was that same shape, which
makes the sweep ten separated and two superseded.

One of them was wrong twice over: `ResourceRelation`'s block said the relation is
"three-valued on purpose", and the list it had come to stand over has had five
values since [ADR-0013](0013-tenant-hierarchy.md). The tenant hierarchy exists
precisely against the three-valued state — with three values a holding reading
its own brand and a holding reading a stranger's are both `foreign-tenant`, which
is the one relation a platform is usually meant to allow and the one it must
never allow, given the same answer.

Writing the gate for the class turned up twelve more that were not in the sweep:
two in `src/runner/canaries.ts`, one whose subject had ended up in another file
entirely when `runner.ts` was cut on 23 August, seven in the test suite
(`tests/report/exit-code.test.ts` three; `tests/adapters/signals.test.ts`,
`tests/invariants/cli-surface.test.ts`, `tests/public-surface.test.ts` and
`tests/report/write.test.ts` one each), and two in the polygons. That is the
argument for the gate in one line — the sweep was done by reading, and reading
found half of it.

Twelve and twelve is twenty-four, and twenty-four is what the tree says: at the
commit this work started from the gate as it now stands finds **twenty-six**
detached blocks, and at the commit that closed the sweep it finds **two** — the
permanent exception in `src/core/checks/clauses.ts`, and one in
`src/core/checks/registry.ts` that another track was holding open.

### Two ADR links whose number does not match the document

`docs/library.md` labelled the catalogue-of-clauses decision `ADR-0041` while
linking `0043-a-catalogue-of-clauses.md`; `README.md` labelled `ADR-0044` while
linking `0045-a-consented-run-says-who-it-is.md`. `tests/docs/links.test.ts`
missed both because the target exists — only the label lies.

An ADR number is working currency here. Comments cite one, commit messages cite
one, `CLAUDE.md` cites nine of them twelve times, and none of those citations is
a link anything can follow. A reader who takes "ADR-0041" out of a sentence and
goes looking for it lands on a decision about matrix discrepancies answering for
a clause, when the sentence was about a catalogue of clauses. The link was the
one place the two numbers sat side by side, and nothing compared them.

## Decision

**A doc block describes the symbol it stands on, and two gates hold the parts of
that which are checkable.**

### 1. `tests/docs/detached-comments.test.ts`

A `/** … */` block followed, after nothing but blank lines and `//` comments, by
another `/** … */` block. Only the second attaches — TypeScript, an editor's
quick-info and every documentation tool read the nearest one — so the first is
prose no tool will show beside any symbol.

The scan reads every tracked file in the JavaScript family (`.ts`, `.tsx`,
`.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`), not the two extensions the
repository happens to hold.

Two shapes are let through, and neither is an allowlist:

- **A block carrying a `@typedef`.** It declares a type in its own body, so it is
  not a comment that failed to attach: there is nothing under it that it was
  meant to describe. `tools/oracle/index.mjs` and `tools/release-gate.mjs` write
  their type declarations that way.
- **A block that is nothing but tags.** The `.mjs` tools are typed by JSDoc and
  keep `@param`/`@returns` in a block of their own under the prose. A block whose
  first line is a tag is the tag half of the comment above it. A block that opens
  with prose is a comment for a symbol, whatever tags it ends with — that
  distinction is the correction of 23 August, and the addendum says why.

A third shape — the pair that opens a file, a module header over the first
symbol's comment — is **not** skipped. It is counted separately and held to a
named list of seven files, because nothing in the layout tells a module header
apart from a block detached at the top of its module.

One occurrence is named in the test as a knowing exception, counted rather than
located, and asserted **exactly** — so an entry that is fixed and not deleted
fails the gate, the property an exception list needs in order not to become a pin
nobody notices. The module-header list is asserted the same way and in both
directions.

### 2. `tests/docs/links.test.ts`, extended

The population is a **link**; the label is what is judged. Collected: every
inline markdown link whose target is an ADR document, and every inline link whose
label claims an ADR number. Judged: each number the label claims, padded to four
digits, against the number in the filename.

A label claims a number when the word `ADR` is followed, within three characters
of dash, space, underscore, dot or colon, by two to four digits — which reads
`ADR-0043`, `**ADR-0043**`, `` `ADR-0043` ``, `see ADR-0043`,
`ADR-0043: a catalogue`, `ADR 0043`, `ADR–0043`, `adr-0043` and `ADR-43` alike —
or when the label is the ADR's own filename. A link to an ADR under a label that
names no number is collected and has nothing to judge; there are none in the
repository today.

A link whose label names an ADR but whose target no number can be read from is a
failure of its own, not a skip. A gate that passes over what it does not
understand is green about exactly the cases nobody thought of. Absolute GitHub
addresses read the same way as relative paths — half the ADR links in
`docs/guide.md` and `docs/report.md` are absolute — and a title after the address
or a `#section` on the end is part of neither the filename nor the label.

## Alternatives

**Leave it to review.** This is what was in place. It found twelve of twenty-four
in one deliberate sweep, and the twelve it missed had been in the tree for as
long as the twelve it found.

**A linter rule.** Biome has no rule for this shape, and none of the plugins that
do is worth a dependency for one layout check: the vetting bar in `CLAUDE.md`
costs more than the lines the test needed.

**Parse the source instead of the lines.** A parser is right about a `/**` inside
a string literal, and the shape being looked for is a layout, not a syntax tree.
The only file that prints comment tokens as data is the test itself, and it
assembles them from pieces so they never appear in its text — the trick
`language.test.ts` learnt when it flagged its own source.

**Ban a section header over a group of declarations**, which is the one false
positive the layout rule produces (`src/core/checks/clauses.ts`). Rejected: the
cure is a blank line, and a gate people satisfy with a blank line teaches them
that the gate is the point rather than the comment.

**Judge the label with the target's own grammar** — require every ADR link to be
labelled `ADR-NNNN` and nothing else. Rejected: it turns a gate about accuracy
into a gate about house style, and the shapes it would forbid — a code span, a
gloss after the colon — are how a sentence reads best. The number has to be
right; the sentence around it is the writer's.

## Consequences

- Twenty-four detached blocks are attached to their subjects or deleted where
  the symbol they described is gone, one of them moved across a file boundary.
  `ResourceRelation`'s count is corrected from three to five.
- Two stale cross-references are fixed: `canonical()` lives in
  `src/report/canonical.ts`, not `src/report/build.ts`, and the readers of
  `WARNINGS` are `src/cli/screen.ts` and `src/cli/run.ts` since
  [ADR-0056](0056-the-entry-point-is-only-a-command-line.md) cut `src/cli.ts`
  down to the command line. A third, in `src/report/compare.ts`, names
  `src/cli/compare.ts` as the place the sentences do *not* live.
- `src/adapters/ports.ts` no longer says the implementations will arrive in
  session 3. All seven have been there for months.

## Addendum, 23 August 2026 — the review of this document

Adversarial review went around both gates and through the prose of this ADR. What
follows is what it found, and what was done about each.

### The link gate collected on the label it was there to judge

`ADR_LINK` was `\[ADR-(\d{4})\]\(([^)\s]+)\)`. That is a condition on the
**label**, so a label spelled any other way was never collected — and a link that
is not collected cannot be judged, while this document and the test's own header
both said that nothing is passed over. Nine ordinary shapes went through: emphasis
marks around the label, a code span, a lower-case prefix, a word in front of the
number, a gloss after it, a space instead of the hyphen, an en dash instead of
the hyphen, an unpadded number, and the ADR's filename used as the label. A tenth,
a title after the address, hid the link from the target half of the pattern
instead. Every one of them is now collected and judged, and each has a test.

### The JSDoc exception was justified by a claim the same diff refuted

This document said the exclusion "costs the gate nothing it could have judged:
the two blocks in such a pair are one comment written in two registers". The
counterexample was in the branch's own diff. At the commit this work started
from, `src/runner/canaries.ts` had `probeCanaries`' prose —

> Checks that the accounts really are authenticated.

— standing over the block for `assertCanariesUsable`, whose last five lines are
`@throws`. A detached block of exactly the kind this ADR exists for, and one the
committed gate was structurally green about. It is one of the twelve the gate
turned up, and by the time the gate was committed the gate could no longer see
it.

The exclusion is therefore two narrower rules, each with a reason that survives
being read: a block carrying a `@typedef` declares something itself, and a block
whose *first* line is a tag is the annotation half of the comment above it. A
block that mixes prose with tags is judged like any other comment. The eight
pairs in the `.mjs` tools that the old rule excused are all still excused, each by
one of the two narrower rules; the canaries pair is not.

### Three more ways around the detached-comment gate

- **A line comment between the two blocks.** The check required the gap to be
  empty, so one `// still true` line made the pair invisible. A line comment
  attaches nothing either. Closed: the gap may hold blank lines and `//` lines.
- **A pair at the top of a file.** The module-header rule skipped it wherever it
  met it — which means the finding this ADR was written for would have been
  invisible had `sanitizeLocation` been the first thing in `http.ts`. Closed as
  far as it can be: the shape is not a defect and not distinguishable from one by
  layout, so it is counted rather than skipped and held to a named list of seven
  files, asserted exactly in both directions. A new file that opens this way
  costs one line and a reader's glance; a detached block landing at the top of
  one of those seven makes the count two and fails.
- **A file extension outside the scan.** `trackedSources()` collected `.ts` and
  `.mjs`, which is everything the repository holds and therefore a gate one `.js`
  file walks around. Closed by widening the filter to the whole JavaScript family
  rather than by listing what is here.

### The counts in this document contradicted each other

The tree was measured; the document was not. It said "fourteen" in the opening,
gave a 12 + 2 = 14 breakdown, said the gate turned up twelve more (making
twenty-six), headed that paragraph "the six nobody was looking for", said "it
found fourteen of twenty … and the six it missed" under Alternatives, said
"Twenty-four detached blocks" in the consequences, and said "the fourteen found
by reading" at the end. Six numbers for one quantity. Twenty-four is right and
the commit message had it right: twelve by reading, twelve by the gate. Measured
with the gate as it now stands, the tree held twenty-six detached blocks at the
commit this work started from and two at the commit that closed it.

The enumeration of the gate's twelve said "six in the test suite" and summed to
eleven. There are seven in the test suite, and with seven it sums to twelve.

The link count said "178 of them". That was the number at the commit the work
started from, written after the branch had added three links of its own; it was
181 when the branch was committed. On the tree at this amendment it is 195, and
the test now carries that number with the date it was taken.

`relationOf`'s block was described as fourteen lines. It is fifteen.

### What no gate here catches, said plainly

Both gates read source text, and what that can hold at all is stated once, for
the whole family, in [ADR-0065](0065-what-a-source-scan-can-hold.md). What
follows belongs to these two in particular.

**The detached-comment gate.** A block whose subject is the group of declarations
below it — a section header — has the same layout as a detached one, and only a
reader can tell them apart; `src/core/checks/clauses.ts` is the standing example.
So does a comment sitting directly on the wrong symbol with nothing between them:
`/** what A does */` above `B`, with no second block anywhere, is invisible to
this rule and to any rule short of understanding the prose. Every one of the
twelve found by reading happened to leave a second block behind; that is a fact
about how they were made, not a property of the class. Beyond those two:

- A detached block whose lower neighbour is a pure `@param` block is still
  excused. The rule is narrower than it was, and it is still a rule about layout.
- A module header is excused by name. The list is the review, and the review
  happens once, when the file is added.
- A non-doc block comment — `/* … */` — between the two blocks still breaks the
  pair. Only blank lines and `//` lines are treated as no separation at all.
- A doc comment inside a fenced block in a markdown file, or inside a JSON
  string, is not scanned. Neither is source, and neither is shown beside a symbol
  by anything.

**The link gate.** It judges links, and most ADR citations in this repository are
not links: of 1160 citations in the tracked text, 195 sit inside a link label and
965 are bare prose that nothing can check. Of the links themselves, three shapes
are not collected at all — a reference-style link whose target is defined
elsewhere on the page, a raw `<a href>`, and a label containing a `]` of its own.
A fourth, an address with a bracket in it, is only half a hole: the label's claim
is still read, so such a link fails loudly as a target no number can be read
from — but under a label that claims nothing it is simply not recognised as
pointing at an ADR. The repository holds none of the four today, which is a fact
about today and not a property of the gate. And a label that names no number at
all is collected with nothing to judge: a link can still open the wrong decision
under a description that says nothing checkable.

# 0062. A comment describes the symbol under it

- **Status:** accepted
- **Date:** 2026-08-23

## Context

A comment in this repository is not a restatement of the code. It carries the
*reasoning* — what was tried, what it cost, why the decision went one way — and
for most of the invariants in `CLAUDE.md` it is the only record of the argument
that produced them. That is what makes a detached comment expensive in a way a
stale comment usually is not. A stale comment is a sentence that has stopped
being true; a detached one is a true sentence filed under the wrong name, and
the reader who acts on it acts on a fact about a different piece of code.

A sweep on 22 August 2026 found fourteen of them, and one was about a security
guarantee that had moved.

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

### The other thirteen, and the six nobody was looking for

Twelve were a doc block separated from its subject by something inserted between
the two — `ResourceRelation`'s reasoning standing over `RESOURCE_RELATIONS`,
`relationOf`'s fourteen lines about ADR-0013 and ADR-0017 standing over the
three-line `principalOf`, `SignedRequest`'s "there is no body here" standing over
`ContextAttributes`. Two were a superseded block left above the symbol whose
replacement sits below it.

One of them was wrong twice over: `ResourceRelation`'s block said the relation is
"three-valued on purpose", and the list it had come to stand over has had five
values since [ADR-0013](0013-tenant-hierarchy.md). The tenant hierarchy exists
precisely against the three-valued state — with three values a holding reading
its own brand and a holding reading a stranger's are both `foreign-tenant`, which
is the one relation a platform is usually meant to allow and the one it must
never allow, given the same answer.

Writing the gate for the class turned up twelve more that were not in the sweep:
two in `src/runner/canaries.ts`, one whose subject had ended up in another file
entirely when `runner.ts` was cut on 23 August, six in the test suite, and two in
the polygons. That is the argument for the gate in one line — the sweep was done
by reading, and reading found half of it.

### Two ADR links whose number does not match the document

`docs/library.md` labelled the catalogue-of-clauses decision `ADR-0041` while
linking `0043-a-catalogue-of-clauses.md`; `README.md` labelled `ADR-0044` while
linking `0045-a-consented-run-says-who-it-is.md`. `tests/docs/links.test.ts`
missed both because the target exists — only the label lies.

An ADR number is working currency here. Comments cite one, commit messages cite
one, `CLAUDE.md` cites nine, and none of those citations is a link anything can
follow. A reader who takes "ADR-0041" out of a sentence and goes looking for it
lands on a decision about matrix discrepancies answering for a clause, when the
sentence was about a catalogue of clauses. The link was the one place the two
numbers sat side by side, and nothing compared them.

## Decision

**A doc block describes the symbol it stands on, and two gates hold the parts of
that which are checkable.**

### 1. `tests/docs/detached-comments.test.ts`

A `/** … */` block followed, after nothing but whitespace, by another
`/** … */` block. Only the second attaches — TypeScript, an editor's quick-info
and every documentation tool read the nearest one — so the first is prose no tool
will show beside any symbol.

Two shapes are excluded, and neither is an allowlist:

- **A block that opens the file.** Nothing precedes it, so it cannot have been
  detached from anything; it is the module header, and the block under it is the
  first symbol's. Most files escape the rule only by having imports in between.
- **A block carrying a JSDoc tag.** The `.mjs` tools are typed by JSDoc and keep
  `@typedef` and `@param` in a block of their own beside the prose. A `@typedef`
  is a declaration in its own right and needs no symbol under it.

Two occurrences are named in the test, counted rather than located, and asserted
**exactly** — so an entry that is fixed and not deleted fails the gate, the
property an exception list needs in order not to become a pin nobody notices.

### 2. `tests/docs/links.test.ts`, extended

For every ADR link in a tracked file — a label reading `ADR-NNNN` over a target
ending in `NNNN-….md` — the number in the label equals the number in the
filename. All 178 of them, in every tracked file rather
than the markdown ones, and absolute GitHub addresses read the same way as
relative paths — half the ADR links in `docs/guide.md` and `docs/report.md` are
absolute.

A link whose target the gate cannot read a number from is a failure of its own,
not a skip. A gate that passes over what it does not understand is green about
exactly the cases nobody thought of.

## Alternatives

**Leave it to review.** This is what was in place. It found fourteen of twenty in
one deliberate sweep, and the six it missed had been in the tree for as long as
the fourteen.

**A linter rule.** Biome has no rule for this shape, and none of the plugins that
do is worth a dependency for one layout check: the vetting bar in `CLAUDE.md`
costs more than the twelve lines the test needed.

**Parse the source instead of the lines.** A parser is right about a `/**` inside
a string literal, and the shape being looked for is a layout, not a syntax tree.
The only file that prints comment tokens as data is the test itself, and it
assembles them from pieces so they never appear in its text — the trick
`language.test.ts` learnt when it flagged its own source.

**Ban a section header over a group of declarations**, which is the one false
positive the layout rule produces (`src/core/checks/clauses.ts`). Rejected: the
cure is a blank line, and a gate people satisfy with a blank line teaches them
that the gate is the point rather than the comment.

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
- **What no gate can catch, said plainly.** A block whose subject is the group of
  declarations below it — a section header — has the same layout as a detached
  one, and only a reader can tell them apart. So does a comment sitting directly
  on the wrong symbol with nothing between them: `/** what A does */` above `B`,
  with no second block anywhere, is invisible to this rule and to any rule short
  of understanding the prose. Every one of the fourteen found by reading happened
  to leave a second block behind; that is a fact about how they were made, not a
  property of the class. The gate closes the shape that leaves a trace. The rest
  is still review.

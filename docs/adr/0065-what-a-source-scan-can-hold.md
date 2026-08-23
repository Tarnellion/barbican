# 0065. What a source scan can hold

- **Status:** accepted
- **Date:** 2026-08-23

## Context

Between 22 and 23 August 2026 this repository grew a family of gates that read
its own source text and refuse a second copy of a decision: the separator and
the cell key (ADR-0059, ADR-0060), the `{name}` grammar of a path template (the
note of 23 August on ADR-0024), the address grammar and the terminal-error and
`not-found` sets (ADR-0061), the doc block that stands over the wrong symbol and
the ADR link whose label lies (ADR-0062), the files the coverage gate measures
(ADR-0063), and six tables that had been written twice (ADR-0064).

Five rounds of adversarial review ran against them. Every round found a way
around every gate, and every round found the document describing the gate
claiming more than the gate held. The list is worth reading as one list, because
what it shows is not a series of oversights:

- a copy under another name, importing the owner's constant;
- the same, with the import renamed — `import { joinKey as glue }`;
- the same, with a local rebinding — `const glue = joinKey`, an idiom already in
  this tree;
- the separator written `\x00`, `\u{0}`, `\0`, `String.fromCharCode(0x0)`;
- the separator not written at all — `decodeURIComponent("%00")`;
- the grammar's braces written `{` and `}`;
- the grammar built with `new RegExp`, and then with `const Expression = RegExp`,
  and then reachable as `/x/.constructor` without the word `RegExp` anywhere;
- a rule hoisted out of the table it is counted in, and referenced by name;
- a table entry written on one line, or with quoted keys;
- a back door inside a predicate the gate holds by its exact text, rather than in
  the seam the gate reads;
- a coverage gate switched off by `coverage.exclude`, by `all: false`, by
  thresholds set to zero, by a blanket threshold, by narrowing `test.include` so
  the guard never runs, and by one line inside the guard's own source;
- a module the scan does not enumerate: untracked, or named `.mts`, or under a
  directory the scan does not walk;
- a link split across two lines, which CommonMark accepts and a single-line
  regular expression does not see.

Two answers were tried and both fail. Adding a pattern per evasion produces a
gate nobody can read and a new evasion the same afternoon — the list above is
what that looks like after five rounds. Claiming completeness in the ADR and
being refuted the next day produces something worse: eighty sentences across the
ADRs, `README.md`, `CLAUDE.md` and the headers of the tests themselves that
asserted more than the code did. CLAUDE.md already names that pairing as the
dangerous one — a rule that tells the reader not to look while no longer holding.

## Decision

**A gate that reads source text catches what a person writes by accident or for
convenience. It does not catch what a person writes in order to defeat it, and no
version of it will.** The language has too many ways to spell a value, and the
gate is written in the same language.

Three things follow, and they apply to every gate of this family.

**1. The test of whether an evasion is worth closing is whether somebody could
write it without meaning to.** A renamed import and a local rebinding are how
people write code; they are closed. `decodeURIComponent("%00")` in place of a
separator is not something anybody writes by accident; it is named and left. The
question is never "is this reachable" — everything is reachable — but "is this on
a path somebody is walking anyway".

**2. Every gate of this family carries a `Limits` section naming the forms that
are open, and each one is measured rather than reasoned about.** A form is listed
only after it has been written, run, and seen to pass; the report says which
suite it passed and with what count. A limit nobody has executed is a guess, and
a guess in a Limits section is the same defect as a claim in a Decision section.

**3. No document about a gate of this family asserts that the gate cannot be
walked around.** Not the ADR, not the test header, not `README.md`, not the
title. This is what the rename of ADR-0060 was about — a title is a claim like
any other. Where an earlier version made such a claim, the correction stays
visible in the document rather than being quietly edited away.

What actually holds a decision to one place is therefore not the scan. It is that
the owning module **does not hand out its raw material**: the separator is not
exported, no `RegExp` leaves the grammar, and the forbidden lists stopped being
exported. A copy that cannot borrow has to write the thing out — and writing it
out is what makes it a second *implementation* rather than a second reference,
so it will diverge on the day the first one changes, and the scan is what makes
that day noisy rather than silent. The scan is a smoke alarm, not a lock.

## Alternatives

**Parse instead of scan.** A TypeScript AST would close the spelling evasions as
a class rather than one at a time. Rejected for now on three grounds: it needs a
dependency, and a dependency here needs vetting under the rules in `CLAUDE.md`;
the value of these gates is that a reader can hold one in their head, and the
hand-written scanners are already at the edge of that; and it does not change the
decision above, because a program can still compute a value the AST reads as
opaque. It would move the boundary, not remove it. If the scanners grow again,
this is the thing to reconsider, and this paragraph is the reason to.

**Claim nothing and delete the Limits sections.** Rejected: the sections are the
part with the most value per line. They are where the next person learns what
they are actually protected from, and they are the record that somebody tried.

**Keep chasing.** Rejected on the evidence above.

## Consequences

- An ADR in this family that says a gate "cannot be walked around" is a defect in
  that ADR, reportable as one.
- A new evasion is not an emergency. It is measured, and then either closed —
  if a person could fall into it — or added to `Limits` with the measurement.
- The gates keep their exact counts in both directions. A gate that has stopped
  seeing fails rather than passes, which is the one property that does not
  depend on how completely the scan reads the language.
- This document is the single place the limit is stated. ADR-0060 through
  ADR-0064 point at it rather than each restating it, so there is one sentence to
  keep true instead of five.

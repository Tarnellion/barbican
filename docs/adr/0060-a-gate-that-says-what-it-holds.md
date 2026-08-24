# 0060. A gate that says what it holds

- **Status:** accepted
- **Date:** 2026-08-23
- **Amended:** 2026-08-23, after a second adversarial review — of the gate this
  document is about, and of this document. The file was
  `0060-a-gate-that-cannot-be-walked-around.md` and is renamed, because the gate
  was walked around six more ways inside the day and a title is a claim like any
  other. Two sentences in this document were false as first committed, and so
  were five more it caused to be written — in the test file, in `README.md`, in
  `CLAUDE.md`, in `src/core/path-parameters.ts` and in the correction note this
  ADR added to ADR-0057. All seven are corrected in place and listed under
  "Corrections to this document" at the end, because leaving a false statement of
  fact standing in the record is the thing this whole track is about.

## Context

Two duplicated decisions were collapsed on 23 August 2026, each into one module,
each with a test to keep it collapsed:

- `cellKey` and the separator it glues with, into `src/core/keys.ts` (ADR-0059);
- the `{name}` grammar of a path template, into `src/core/path-parameters.ts`
  (the note of that date on ADR-0024).

An adversarial review the same day walked around both, against the full
`pnpm run check`, exit 0 every time:

1. **By renaming.** A function called `keyOfCell` in `src/report/compare.ts`,
   importing `KEY_SEPARATOR` from the owning module and rebuilding exactly the
   string `cellKey` builds. `tests/invariants/one-key-one-source.test.ts` matched
   the literal names `cellKey` and `objectKey`, so it saw nothing — while ADR-0059
   claimed of that same assertion that it "catches a copy that imports the
   constant and rebuilds the string". The claim was false the day it was written.
2. **By another spelling of one character.** `const SEPARATOR = "\x00"` plus a
   function under any other name. The gate's second assertion looked for the
   exact six-character escape, and `\x00`, `\u{0}`, `\0` and the four-digit form
   are the same character.
3. **Into the module with no gate at all.** A fourth copy of the `{name}` grammar
   put back into `src/runner/address.ts` — and a second spelling of it inside
   `path-parameters.ts` itself — passed lint, tsc and all 1550 tests.

Two more things were wrong in the record.

**The raw byte was still in the repository.** ADR-0059's "noticed and not fixed"
item 4 said that ADR-0057 "renders the two `walk.ts` keys with a space". It does
not. `docs/adr/0057-the-runner-is-cut-at-the-address.md` held the **raw NUL byte
itself**, and a raw NUL makes a whole file binary to `grep`, so the search that
went looking for the separator across the repository printed no matches in it —
and the silence was read as a space and written up as a rendering choice. That is
precisely the failure ADR-0059's own first assertion had just found twice in
`src/`, repeated in the paragraph recording it, because the gate scanned `src/`
and the byte was in `docs/`.

**A contract was widened without a word.** `cellKey` and `objectKey` take
`resourceId?: string | undefined` where both replaced copies took
`resourceId?: string`. Under `exactOptionalPropertyTypes` those are different
types, and narrowing it back produces three compiler errors — two call sites in
`src/runner/walk.ts` and one in the gate's own test — which means the widening was
driven by the new test rather than decided.

### The second review, the same day

The gate below was written, committed, and then attacked in its turn. It gave way
six ways, each verified against a full green `pnpm run check`:

1. **A renamed import.** `import { joinKey as glue }` in `src/report/compare.ts`,
   plus a `keyOfCell` copy calling `glue`. The caller table was read by counting
   the text `joinKey\s*\(` per module, so it counted zero.
2. **A local rebinding.** `import { joinKey }` and then `const glue = joinKey;`.
   Not a hypothetical idiom — `src/core/defects.ts` already writes
   `const keyOf = defectSignature;`.
3. **A zero in another base.** `String.fromCharCode(0x0)`. The one enumerated
   needle required `0+` before the closing parenthesis.
4. **A character with no zero written at all.** `decodeURIComponent("%00")`.
5. **A grammar that is not a literal.** A fourth `{name}` in
   `src/runner/address.ts`, built by `new RegExp` out of a non-foldable argument.
   The brace scan reads regular-expression literals. (Biome's `useRegexLiterals`
   folds `new RegExp("a literal")` back into a literal and so covers *that* form
   already; the gate is not credited with it.)
6. **A declaration the pattern could not cross.** A second `cellKey` with a
   different key shape, written as an object method whose parameter list contains
   a `)` — `esc: (part: string) => string`. The member pattern read
   `\([^)]*\)`.

Five of the six are closed by this amendment. **4 is not**, and 5 is closed only
outside the two modules already allowed to construct an expression. The judgement
behind that split: 1, 2 and 6 are shapes somebody writes by accident or for
convenience and were worth real work; 3 was one alternation of a regular
expression; 5 needed a table and one more reading; 4 is a shape nobody reaches
for except on purpose, which is the criterion
[ADR-0065](0065-what-a-source-scan-can-hold.md) later stated for the whole
family. What 4 gets instead of a check is a sentence saying it works, in three
places — here, in the mutation table as a row that says *not caught*, and in the
header of the test file itself.

## Decision

### The raw material does not leave its module

`KEY_SEPARATOR` is **not exported**. `joinKey(...parts)` is exported in its place.

This is the whole of the answer to evasion 1, and it is a stronger statement than
any test that recognises imitations. While the constant was exported, a copy under
any name could import it and rebuild the string, and a gate could only ever chase
the names such a copy might use. With the constant private, a copy elsewhere has
to produce the character itself — and a character *written into a source literal*
is checkable in every spelling a literal can give it, which is what the next
section does. A character *computed* is not, and the next section says where that
line falls.

`src/core/path-parameters.ts` already had this shape and it is where the shape was
taken from: that module deliberately hands out no `RegExp`, only answers. The
reason recorded there is `lastIndex`, but the second effect is the same one —
there is no material for a caller to copy.

Four modules glued a key by hand with the constant, and each builds a **different**
key. They call `joinKey` now:

| module | calls | key |
| --- | --- | --- |
| `src/core/defects.ts` | 1 | endpoint, relation, conditions — a defect signature |
| `src/core/accepted.ts` | 1 | signature and kind — the acceptance index |
| `src/report/findings.ts` | 1 | kind and signature — the per-defect evidence budget |

That table is in the gate. **The first version of this ADR said that a fifth
caller "fails it whatever the function is called", and that was false the day it
was written** — the same defect it accused ADR-0059 of, one document later. The
assertion counted the text `joinKey\s*\(` per module, and both
`import { joinKey as glue }` and `const glue = joinKey` count zero. The sentence
is made true by the mechanism in "Reaching in is enumerated at the import" below,
which keys the table on the import: an import names `joinKey` however the local
binding is spelled.

The **count** is what makes it true of a module already on the list. Without it,
the reviewer's `keyOfCell` moved one file over into `src/report/findings.ts`
would sit inside an allowance granted for a different key and be invisible again.
One entry is one key; a module that comes to need two has to convince a reader
first.

`joinKey("", "")` returns the separator, and that is not a hole: an expression
that reads the character out of the one implementation moves when the one
implementation moves, which is the entire property being defended.

### The gate decodes a spelling instead of matching one

The sources under `src/` are tokenised — a scanner in the test file: words,
punctuation, strings, templates and regular expressions, comments skipped — and
the escapes inside each literal are **decoded**. `\x00`, `\u{0}`, `\0`, the
four-digit form and the byte itself are then one thing, because they are one
character, and a spelling nobody has thought of yet is covered the day somebody
writes it.

The scanner is hand-written rather than a parser dependency: a new package needs
vetting (CLAUDE.md) and this gate's value is being short enough to read. The cost
is that a hand-written tokeniser can lose its place, so it throws on anything it
cannot finish. A scan that has lost its place must never report "nothing found",
and the same principle puts exact counts on both sides of every allowance — the
owner spelling the character *fewer* times than expected fails too.

One needle is still enumerated: `String.fromCharCode` and `String.fromCodePoint`
of a **numeric zero written in a base** — `0`, `0x0`, `0b0`, `0o0`. The first
version read `0+` and nothing else, so `0x0` walked past it; the other three bases
are one alternation and were worth adding.

It stops there, and the stopping place is exact. `decodeURIComponent("%00")` makes
the same character out of a literal this scanner reads as `%00`, and
`String.fromCharCode(one - one)` makes it out of no literal at all. Neither is
caught. Both are in the mutation table below, one of them as the row that says
**not caught**.

The needle is a courtesy and not what holds. What holds is the unexported
constant, and it holds differently than a check does: a copy that computes the
character is a second *implementation* of the separator rather than a second
reference to the one implementation, so it does not track the one implementation
and will disagree with it the day that one changes. That is a weaker guarantee
than "this cannot be written" and it is the true one.

### The `{name}` grammar gets the same gate, in the same file

A brace in a regular expression means one of two things: a repetition count, or a
grammar. The gate reads regular-expression literals, removes the quantifiers, and
counts what is left. Three modules may hold one:

| module | expressions | why |
| --- | --- | --- |
| `src/core/path-parameters.ts` | 1 | the owner |
| `src/adapters/postman.ts` | 3 | Postman's doubled braces, and the check that a path's braces are all well-formed before the collection is handed on |
| `src/core/selectors.ts` | 1 | the table of metacharacters to escape, in which the two braces are two entries |

And the owning module holds exactly one expression, asserted by its source rather
than by its count — the second half of evasion 3 was a second spelling inside the
owner, which every assertion of the first gate allowed.

A scan of literals is blind to `new RegExp`, which is how a fourth copy of the
grammar came back in the second review: `new RegExp(\`${OPEN}([^}]+)\\}\`, "g")`
in `src/runner/address.ts`, with lint, tsc and this gate all green. Two things
answer it, and both are needed:

- **Every literal handed to a `RegExp` call is read as a pattern**, so the
  fragments of a constructed expression count towards the brace table exactly as
  a written expression does.
- **Construction itself is enumerated.** Two modules build a `RegExp` at runtime
  and each is pinned to one construction; a third fails.

| module | constructions | why |
| --- | --- | --- |
| `src/core/path-parameters.ts` | 1 | recompiling its one source under `g`, fresh per call because `lastIndex` is per object |
| `src/core/selectors.ts` | 1 | anchoring an already-escaped path pattern with `^…$` |

Biome's `useRegexLiterals` folds `new RegExp("a literal")` back into a literal, so
that form never reaches the gate and the gate is not credited with it. What the
two rules above add is the form the linter cannot fold — a pattern assembled out
of a variable — which is the one that walked past.

One gate covers both decisions rather than two gates covering one each. The
mechanism is the same in both halves — an owner, an exact allowance table with a
reason per entry, and a name that may not be redeclared — and two files would be
two places for the next such decision to be added to, one of which would be
forgotten. The file is `tests/invariants/one-decision-one-home.test.ts`;
`one-key-one-source.test.ts` is gone.

### Reaching in is enumerated at the import, not at the call

The caller table was read by counting the text `joinKey\s*\(` in each module.
That counts one spelling of a use, and a use has as many spellings as the
language has ways to bind a name: `import { joinKey as glue }`,
`const glue = joinKey`, `keys.joinKey` behind a namespace import,
`export { joinKey } from …` re-exported through a third module. Each reduces the
count to zero while the copy goes on building keys.

What the gate enumerates instead is the **import**: which module may reach into an
owning module, and for which names.

| module | names | for |
| --- | --- | --- |
| `src/core/defects.ts` | `joinKey` | a defect signature |
| `src/core/accepted.ts` | `joinKey` | the acceptance index |
| `src/report/findings.ts` | `cellKey`, `joinKey` | the cell a finding names, and its evidence budget |
| `src/runner/walk.ts` | `cellKey`, `objectKey` | the cells walked, and the objects behind them |
| `src/core/matrix.ts` | `pathParameterNames` | whether a cell exists |
| `src/runner/plan.ts` | `hasPathParameters` | what a run can address |
| `src/runner/canaries.ts` | `hasPathParameters` | a canary is not templated |
| `src/runner/address.ts` | `fillPathParameters` | substitution into a path |

An import names what it imports whatever it calls the result locally, so no
rename hides from this table. Three further rules close the ways around the
table itself:

- **A renamed import of an owned name is refused outright.** The gate could
  follow the local binding instead, and does not: a reader who greps for
  `joinKey` should find every use of it, and that is worth more than the freedom
  to alias.
- **A namespace import of an owning module is refused.** `keys["joinKey"]`
  reaches an export through a string, which no scan of identifiers sees.
- **An owning module's path may be written only in an import of it.**
  `export … from` is not an import, and it would put the owner's names into a
  module this table has never heard of.

The **call count** stays for `joinKey` and for nothing else, because there it
means something: one entry is one key, and the reviewer's `keyOfCell` moved into
`src/report/findings.ts` would otherwise sit inside an allowance granted for a
different key. How many times `findings.ts` happens to ask for a cell key is not
a decision anybody should have to defend, and a number with no reason under it is
a number the next contributor deletes — which is one of the ways a gate stops
holding.

### An owned name outside its owner is an import of it or a call of it

`declares()` matched a list of shapes: `function name(`, `const name =`, `let`, a
class member, an object method. **The first version of this ADR said a
declaration whose parameters run over several lines is "caught by the two checks
above", and that was false**: the two checks above look for `function` and for
`const`/`let`/`var`, and a class member is neither of those. Worse, the member
pattern read `\([^)]*\)`, which cannot cross a `)`, so a parameter typed
`(part: string) => string` ended the match — and a second `cellKey` with a
different key shape passed the gate.

Listing shapes was the mistake, not the length of the list. The gate now
classifies **every** occurrence of an owned name out of the token stream, into
four roles:

- inside an import declaration;
- a **declaration**: the name follows `function`, `const`, `let`, `var`, `class`,
  `interface`, `enum` or `type`, or its parentheses close onto a `{` or a `:`;
- a **call**: its parentheses close onto anything else;
- none of those — `const glue = joinKey`, `export { joinKey }`, `keys.joinKey`, a
  name in a type position.

Outside the owning module only the first two are allowed, and a call must be of a
name that module imported from the owner. Nothing in that depends on how a
declaration is written: a class member, an object method, a getter, an interface
member, an overload signature, a parameter list holding parentheses, a parameter
list holding newlines — all are declarations, because the classification reads
the tokens around the name instead of a pattern the name has to sit inside.

The one shape it misreads is a ternary whose consequent is a call —
`x ? cellKey(a) : b`, whose parentheses close onto a `:` — which reads as a
declaration and fails. Nothing under `src/` writes one. A gate that fails loudly
on a shape it misreads is the trade this file makes throughout; the alternative
is a parser, which is a dependency to vet for a check whose value is being short
enough to read.

### The raw byte is refused in every tracked file

Not `src/` alone. The point of writing the separator as an escape is that the
repository can be searched for it, and a search does not stop at `src/`. The byte
in `docs/adr/0057-…md` is now the escape `\u0000`, under a correction note in that
file: an ADR is a record of a decision on a date and is not edited to match later
code, but a byte that makes the file unsearchable is not reasoning. ADR-0059's
item 4 is corrected in place and marked as corrected, because leaving a false
statement of fact standing in the record is the thing this whole track is about.

### `resourceId` keeps the wider type, and here is why

`?: string | undefined`, deliberately.

A cell either has a resource or has none. The two ways a caller can say "none" —
omitting the property, and passing `undefined` — are one fact to a key function:
both produce the same string, and a test pins that they do. `?: string` would make
the distinction meaningful to the type checker while the function goes on ignoring
it, and it would do so exactly where callers hold a `Resource | undefined` and
write `resourceId: resource?.id`. The two call sites in `src/runner/walk.ts` would
each need a conditional spread, so the caller of a key would be made to think
about a difference the key does not have.

`CellRecord` in `src/runner/stream.ts` keeps `?: string` and is unchanged: a record
on disk really does either carry the field or not.

## What was tried against the gate

A gate nobody has attacked is a gate nobody has tested, and a gate attacked once
is a gate tested against the imagination of one afternoon. Twenty-two mutations
were applied to the committed tree, each by a harness that refuses to run
anything unless every replacement lands the number of times it was declared to
land — a mutation that did not apply is a green run that proves nothing — and
each was restored from a byte copy taken before the edit. Every mutation is
written the way somebody landing it would write it: `pnpm exec biome check` on
the file it touched comes back clean for all twenty-two, so the question put to
the tree is the gate and not the indentation.

| # | mutation | caught by |
| --- | --- | --- |
| 1 | the reviewer's `keyOfCell` in `compare.ts`, importing `KEY_SEPARATOR` | the compiler: `TS2459 … declares 'KEY_SEPARATOR' locally, but it is not exported`; and the import table |
| 2 | the same copy, importing `joinKey` into a module the table does not list | the import table, and the `joinKey` count |
| 3 | `import { joinKey as glue }` into a module the table does not list | the import table: the rename, and the module |
| 4 | the same rename inside `findings.ts`, which the table *does* list | the import table: the rename; and the `joinKey` count |
| 5 | `const glue = joinKey;` inside `findings.ts` | the occurrence rule: a reference that is not a call |
| 6 | `import * as keys` and `keys.joinKey(…)` | the import table: the namespace; and the occurrence rule |
| 7 | `export { joinKey } from "../core/keys.js";` | the owner's-path rule, and the occurrence rule |
| 8 | the copy moved into `findings.ts`, which is already allowed to call `joinKey` | the `joinKey` **count** |
| 9 | a separator of its own, `"\x00"` | the spelling scan |
| 10 | the same, `"\u{0}"` | the spelling scan |
| 11 | the same, `"\0"` | the spelling scan |
| 12 | the same, `String.fromCharCode(0)` | the one enumerated needle |
| 13 | the same, `String.fromCharCode(0x0)` | the same needle, widened — it read `0+` and missed this |
| 14 | the same, `decodeURIComponent("%00")` | **nothing. Not caught.** See "What this gate cannot see" |
| 15 | `KEY_SEPARATOR` exported again | the export check on the module |
| 16 | a fourth copy of the grammar in `src/runner/address.ts`, as a literal | the brace table |
| 17 | the same, built with `new RegExp` out of a non-foldable argument | the brace table, through the literal inside the call; and the construction table |
| 18 | a second `{name}` expression inside the owning module | the brace count, and the exact-source assertion |
| 19 | the owning module's expression assembled out of pieces, so that it spells nothing | the construction count and the exact-source assertion: the counts are exact in both directions |
| 20 | a second `cellKey` as an object method whose parameter list holds a `)` | the occurrence rule: a declaration |
| 21 | a second `cellKey` as a class member with a multi-line parameter list | the occurrence rule: a declaration |
| 22 | the raw NUL byte put back into ADR-0057 | the repository-wide byte scan |

Mutation 1 does not compile, which is the seam rather than the scan. Every other
mutation passes `pnpm run typecheck` and Biome untouched, and every one of 2 to
13 and 15 to 22 fails this gate.

For three of them the whole of `pnpm run check` was run rather than the gate
alone, and the numbers are worth quoting exactly, because one of them is not the
clean "only this test" the first version of this ADR claimed:

- **17**, the constructed grammar: `Tests  2 failed | 1703 passed | 1 skipped`,
  both failures in this file — the brace table and the construction table. One
  test file, nothing else in the tree.
- **3**, the renamed import: `Tests  2 failed | 1703 passed | 1 skipped` in two
  files — this gate, and `tests/public-surface.test.ts`, which counts 228
  exported names where `docs/library.md` says 227. That second failure is a
  property of the mutation being written as `export function keyOfCell` in a
  module `src/index.ts` re-exports; any new exported helper would move the same
  counter, and it says nothing about the separator. It is quoted here rather than
  filtered out because the first version of this ADR wrote `1 failed` for a
  mutation of exactly this shape.
- **14**, the one that is not caught: `Tests  1 failed | 1704 passed | 1 skipped`
  — and the one failure is that same exported-name count. Every assertion in this
  gate passes over a module that builds keys with the separator.

A twenty-third names a needle no file contains. The harness prints

> REFUSED. The needle was expected 1 time(s) in `src/report/compare.ts` and is
> there 0. Nothing was run: a mutation that did not apply is a green run that
> proves nothing.

and restores the files without running a suite, which is what stops a harness
from reporting a gate as effective when it never mutated anything.

## Alternatives

**Add two more patterns to the old gate.** The shape that had just failed twice:
each evasion answered with a longer list of things to look for, and the list can
only ever name the spellings somebody has already thought of. Removing the export
removes the class. The second review taught the same lesson again, and the
amendment answers it the same way: the caller count was not lengthened with
`glue(`, it was replaced by the import; `declares()` was not given a sixth
pattern, it was replaced by a classification of every occurrence.

**A lint rule.** Biome has no rule of this shape, and a custom plugin would put
the reasoning in a configuration file rather than next to the history that
explains it — ADR-0059's own answer, and it still holds.

**Follow the local binding instead of banning the rename.** The gate reads
`import { joinKey as glue }` and could go on to count `glue(`. Rejected: a reader
who greps for `joinKey` would still find nothing at the place it is used, and the
whole subject of these two ADRs is a decision being findable from any of its
uses. Refusing the rename costs a contributor one alias and keeps the search
honest.

**Parse the sources instead of tokenising them.** A real parser answers every
question this file asks, and answers correctly the one it gets wrong — the
ternary above.
Rejected on the dependency rule (CLAUDE.md) and on the gate's own value being
that a reader can finish it. The cost is written into the file: the tokeniser
throws rather than guessing, and the shapes it misreads are named.

**Keep two test files, one per decision.** Rejected: the two are one mechanism,
and the next decision with one home would be added to whichever file its author
happened to open.

**Move `defectSignature` and the other three keys into `keys.ts` so that even
`joinKey` need not be exported.** Rejected: it would put defect semantics,
acceptance semantics and a report's evidence budget into a module about string
joining, and `defectSignature` is on the published surface where it is. The
enumerated caller list buys the same guarantee without moving anybody's subject.

**Narrow `resourceId` and fix the three call sites.** Considered seriously,
because the widening was undeclared. Rejected on the merits above: the conditional
spread makes two call sites read as though the difference mattered.

## Consequences

`src/core/keys.ts` exports three functions and no values; the gate asserts exactly
that, so re-exporting the separator fails a test rather than a review.

The public surface is unchanged — 227 exported names, `src/index.ts` and
`docs/library.md` untouched. `keys.ts` is not re-exported from
`src/core/index.ts`, as ADR-0059 decided.

No behaviour changes. `joinKey` produces the same strings the four inline
expressions produced, so every key, every acceptance match and every digest is
byte-for-byte what it was; the polygon oracle answers as it did over all 29
combinations. The amendment of the second review changes the test file and six
comments and nothing that runs.

### What this gate cannot see

Not "noticed and not fixed", which reads as a backlog. These are ways past the
gate that are **known to work**, and a reader deciding how much to trust it
should read this list before the tables above. The same list is in the header of
`tests/invariants/one-decision-one-home.test.ts`, because the person about to add
an allowance is reading that file and not this one.

Why a gate of this family has such a list at all, and why the entries in it are
measured rather than reasoned about, is stated once in
[ADR-0065](0065-what-a-source-scan-can-hold.md) instead of in each of these
documents. What is below is this gate's own measurements.

- **A separator obtained without writing a zero.**
  `decodeURIComponent("%00")` — mutation 14, which passes every assertion here.
  So is arithmetic
  (`String.fromCharCode(one - one)`) and a code point taken out of data. A copy
  under an unowned name that glues with such a character passes everything here.
  What stands against it is the unexported constant: such a copy is a second
  implementation and will drift.
- **A `{name}` grammar written without a regular expression.** `indexOf` and
  `slice` over a brace is a different implementation rather than a copy, and
  nothing here reads it.
- **A `{name}` grammar inside a module already allowed to construct a `RegExp`.**
  `src/core/selectors.ts` may build one; only the literal fragments of what it
  builds are read for a brace. A pattern assembled there out of variables is
  invisible.
- **A constructor reached without writing the word `RegExp`.** `/x/.constructor`,
  `Reflect.construct`, a lookup on `globalThis` out of an assembled string. The
  alias `const Expression = RegExp` **is** caught since the amendment of 23 August
  2026, because the count is of mentions rather than of calls; the rest of the
  class is the separator's class in another spelling. What stands against it is
  the same thing: the grammar has no exported form to borrow, so a copy is a
  second implementation and will drift.
- **A ternary whose consequent is a call of an owned name.** It reads as a
  declaration and fails the gate. A false positive rather than a false negative,
  and stated so that the next reader fixes the classifier rather than the
  allowance table.
- **`TEMPLATE_ONLY` in `src/adapters/postman.ts` is arguably a fourth reading of
  `{name}`.** `^(?:[^{}]|\{[A-Za-z0-9_.-]+\})*$` asks whether a path's braces are
  all well-formed, with a narrower name class than the owner's `[^}]+` — narrower
  on purpose, because it is Postman's notion of a name. It is a different question
  asked at a different moment about a different document, and folding it into the
  owner would change which collections the adapter accepts. That is a behaviour
  change, and this is not the commit for it. It is in the allowance table with the
  reason attached, which is where the next reader will find the question.
- **Two keys that glue the same coordinates in the other order remain two.**
  `capRows` builds kind-then-signature and `acceptanceKeyOf` builds
  signature-then-kind; ADR-0059 records why they are left as two, and `joinKey`
  changes nothing about it. No gate of this kind can see it: it is a question
  about what is glued, not about how.
- **Anything outside `src/`, except the raw byte.** `tools/oracle/index.mjs` has
  a `cellKey` of its own on purpose, and the tests that split `git ls-files -z`
  split on a NUL that is not a key.
- **The acceptance duplicate check still keys on the citable form.** ADR-0059's
  first "noticed and not fixed" item, unchanged — it changes which configurations
  are accepted.

## Amendment, 23 August 2026: an escaped brace and an aliased constructor

A third review, the same day, went at the two halves of this gate that read a
regular expression. Both were walked around with `pnpm run check` green, and both
are closed here. Nothing in `src/` behaved differently before or after; what
changed is the test file and what this document claims for it.

**The brace scan matched a character where the separator scan decoded one.** The
principle stated above under "The gate decodes a spelling instead of matching
one" was true of half this file. `spellsTheSeparator` resolved `\u0000`, `\x00`,
`\u{0}` and `\0` to the character they stand for and counted that;
`hasABraceGrammar` asked `body.includes("{")` over the text as written. So

```ts
const PARAMETER_NAME = /\u007b([^\u007d]+)\u007d/g;
```

— the owner's grammar byte for byte, and a fourth copy of it in
`src/runner/address.ts` — was a regular expression with no brace in it as far as
the brace table was concerned. There is now one decoder, `decodeEscapes`, and
both scans read it. A quantifier stays a quantifier through the decoding, and a
code point outside the Unicode range is left as it was written rather than
thrown on: `String.fromCodePoint` would raise there, and a scan that raises is a
scan that has stopped answering.

**The construction table counted calls, and an alias is not a call.**

```ts
const Expression = RegExp;
const PARAMETER_NAME = new Expression("\\{([^}]+)\\}", "g");
```

`regexpCalls` classified the occurrence of `RegExp` here as neither an import nor
a call — it is a reference — so the module's count stayed at zero; and
`regexpArguments` reads the literals beside the word `RegExp`, which is not the
word beside this parenthesis, so the pattern was never read for a brace either.
Biome's `useRegexLiterals` does not fold it back to a literal for the same
reason: the callee it knows is the constructor, not a binding of it. Green, and a
fourth copy of the grammar.

What is counted now is **every mention of the word**, in whatever role — a call,
a return type, a binding. The table's counts move from 1 to 2 for both modules
because each writes `RegExp` once as the constructor and once as the return type
of the function that calls it. The cost is that adding a `: RegExp` annotation
anywhere is a red test until the count is updated, which is the trade every table
in that file already makes. The word is what is counted, so `pathPatternToRegExp`
is not one.

Two mutations were run against the amended tree, each by the harness described
above and each restored from a byte copy: the escaped grammar, caught by the
brace table (`src/runner/address.ts (1)`), and the alias, caught by the mention
table (`src/runner/address.ts (1)`). Both were green against the tree before it.

## Corrections to this document

Three statements in the first version of this ADR were false about the code they
described, and one of the notes it wrote into another ADR was false about itself.
They are corrected above; they are listed here because a record that quietly
rewrites itself teaches the next reader nothing.

- "**a fifth caller fails it whatever the function is called**" (the caller
  table). The assertion counted the text `joinKey\s*\(`, which
  `import { joinKey as glue }` and `const glue = joinKey` both reduce to zero.
  This is the same defect this ADR had just accused ADR-0059 of committing, one
  document later — and the same sentence.
- "**a copy has nowhere to take the character from**" (the test-file header, same
  claim). Corrected there too: a copy has the whole language to build a character
  with; what it has nowhere to take is a *reference to this implementation*.
- "**a declaration whose parameters run over several lines … is caught by the two
  checks above it, which is what having three of them is for**". It was caught by
  none of the three. The member pattern could not cross a `)` either.
- "**lists the seven evasions**" (`README.md`). The table had twelve mutations
  and a thirteenth refusal at the time; it has twenty-two and a twenty-third now.
- "**the two gates that preceded this one were walked around by a rename and by
  `\x00`**" (`CLAUDE.md`). There was one gate before this file, and it was walked
  around both ways; the `{name}` grammar had no gate at all, which this ADR's own
  Context says.
- "**no regular expression outside this module may carry a brace that is not a
  quantifier**" (`src/core/path-parameters.ts`). True of literals, false of
  `new RegExp`, and the module's "noticed and not fixed" list named only the
  `indexOf`/`slice` form.
- "**One character of this file has been changed and nothing else**" (the note
  this ADR added to `docs/adr/0057-…md`), written as nine added lines. Reworded
  to describe the file it is in.

## Note, 24 August 2026: one caller fewer

`src/io/config/parse.ts` is gone from both tables above. It glued the citable
form of a defect's coordinates to a kind, as the key of the duplicate-acceptance
refusal, and that key was the wrong one — the refusal now asks
`acceptanceKeyOf`, the function the report matches a finding with, and builds no
key of its own. See the note of the same date on
[ADR-0048](0048-a-finding-can-be-known-and-still-reported.md).

The removal is recorded here because both tables are exact in both directions: a
caller that stops calling fails the gate rather than passing it, which is what
happened — the suite went red on `src/io/config/parse.ts (0)` before this entry
was deleted. That is the property working, and it is the reason an allowance
carries its count.

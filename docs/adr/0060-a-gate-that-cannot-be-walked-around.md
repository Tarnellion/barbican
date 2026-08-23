# 0060. A gate that cannot be walked around

- **Status:** accepted
- **Date:** 2026-08-23

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

## Decision

### The raw material does not leave its module

`KEY_SEPARATOR` is **not exported**. `joinKey(...parts)` is exported in its place.

This is the whole of the answer to evasion 1, and it is a stronger statement than
any test that recognises imitations. While the constant was exported, a copy under
any name could import it and rebuild the string, and a gate could only ever chase
the names such a copy might use. With the constant private, a copy elsewhere has
to **write the character out itself** — and one file spelling one character is
checkable in every spelling of it, which is what the next section does.

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
| `src/io/config/parse.ts` | 1 | citable defect and kind — the duplicate-acceptance refusal |
| `src/report/findings.ts` | 1 | kind and signature — the per-defect evidence budget |

That table is in the gate, and a fifth caller fails it whatever the function is
called — which is the sentence ADR-0059 wrote about its third assertion, made
true by a different mechanism.

The **count** is what makes it true of a module already on the list. Without it,
the reviewer's `keyOfCell` moved one file over into `src/report/findings.ts`
would sit inside an allowance granted for a different key and be invisible again.
One entry is one key; a module that comes to need two has to convince a reader
first.

`joinKey("", "")` returns the separator, and that is not a hole: an expression
that reads the character out of the one implementation moves when the one
implementation moves, which is the entire property being defended.

### The gate decodes a spelling instead of matching one

The sources under `src/` are tokenised — a small scanner in the test file, some
250 lines, strings and templates and regular expressions, comments skipped — and
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

One needle is still enumerated: `String.fromCharCode(0)`, which is not a literal
and cannot be decoded. It is named as the only enumerated thing in the file and
as a courtesy rather than as what holds — what holds is the unexported constant
and the enumerated caller list, and neither depends on how a character is spelled.

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

One gate covers both decisions rather than two gates covering one each. The
mechanism is the same in both halves — an owner, an exact allowance table with a
reason per entry, and a name that may not be redeclared — and two files would be
two places for the next such decision to be added to, one of which would be
forgotten. The file is `tests/invariants/one-decision-one-home.test.ts`;
`one-key-one-source.test.ts` is gone.

### `declares()` reads a declaration in the forms this repository writes one

It matched `function name(` and `const name =`. It now also reads `let`, `var`,
`const name=` with no spaces, `const name: Fn = …`, `function* name`, an object
method in both its forms, and a class member.

The class-member form requires the parameter list to open and close on the line
and to be followed by a body. Without that it fires on `cellKey({` in
`src/report/findings.ts` and on `hasPathParameters(endpoint.path) &&` in
`src/runner/plan.ts`, which are calls; a gate that cries wolf is a gate somebody
edits until it stops. A declaration whose parameters run over several lines is
therefore missed by this check — and is caught by the two above it, which is what
having three of them is for.

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

## What was tried against the new gate

A gate nobody has attacked is a gate nobody has tested. Each of these was written
into the tree, run, and removed.

1. **The reviewer's rename, again.** `keyOfCell` in `src/report/compare.ts`,
   importing the constant. Fails at the compiler now — there is no export to
   import — and, with the import replaced by `joinKey`, fails the caller list.
2. **Another spelling.** `const SEPARATOR = "\x00"` in `src/report/compare.ts`.
   Fails: the escape decodes to the same character.
3. **A third spelling, in a form the old gate could not have had a pattern for.**
   `"\u{0}"`. Fails, for the same reason and without a second pattern.
4. **The character built rather than written.** `String.fromCharCode(0)`. Fails on
   the one enumerated needle.
5. **A fourth copy of the grammar.** `/\{[^}]+\}/` back in
   `src/runner/address.ts`. Fails the brace table.
6. **A second spelling inside the owner.** A `{name}` expression added to
   `path-parameters.ts` itself. Fails both the count and the exact-source
   assertion.
7. **The gate defeated by deletion.** The owning module emptied. Fails: the
   allowance counts are exact in both directions, so the owner must still spell
   what it owns.

Each was applied to the committed tree by a harness that refuses to run the suite
unless the replacement landed the intended number of times — a mutation that did
not apply is a green run that proves nothing — and each was restored from a byte
copy afterwards.

## Alternatives

**Add two more patterns to the old gate.** The shape that had just failed twice:
each evasion answered with a longer list of things to look for, and the list can
only ever name the spellings somebody has already thought of. Removing the export
removes the class.

**A lint rule.** Biome has no rule of this shape, and a custom plugin would put
the reasoning in a configuration file rather than next to the history that
explains it — ADR-0059's own answer, and it still holds.

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
combinations.

### Noticed and not fixed

- **`TEMPLATE_ONLY` in `src/adapters/postman.ts` is arguably a fourth reading of
  `{name}`.** `^(?:[^{}]|\{[A-Za-z0-9_.-]+\})*$` asks whether a path's braces are
  all well-formed, with a narrower name class than the owner's `[^}]+` — narrower
  on purpose, because it is Postman's notion of a name. It is a different question
  asked at a different moment about a different document, and folding it into the
  owner would change which collections the adapter accepts. That is a behaviour
  change, and this is not the commit for it. It is in the allowance table with the
  reason attached, which is where the next reader will find the question.
- **A grammar written without a regular expression is not read.** `indexOf` and
  `slice` over a brace would be a different implementation rather than a copy of
  this one, and the gate has no view on it.
- **Two keys that glue the same coordinates in the other order remain two.**
  `capRows` builds kind-then-signature and `acceptanceKeyOf` builds
  signature-then-kind; ADR-0059 records why they are left as two, and `joinKey`
  changes nothing about it. No gate of this kind can see it: it is a question
  about what is glued, not about how.
- **The acceptance duplicate check still keys on the citable form.** ADR-0059's
  first "noticed and not fixed" item, unchanged — it changes which configurations
  are accepted.

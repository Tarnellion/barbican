# 0066. An identifier has a grammar

- **Status:** accepted
- **Date:** 2026-08-24

## Context

`src/core/keys.ts` described the character it glues keys with as "a character
that never occurs in an identifier". Nothing made that true.

An adversarial review measured it on 24 August 2026. `endpoint`, `context` and
`kind` in an acceptance are `z.string().min(1)` with no character class; YAML
writes a NUL as `\0` inside double quotes; `src/adapters/endpoint-list.ts`
admits one because it asks only that the id not be blank. A key is a **fixed
number of parts joined by that character**, so a part carrying it splits two
ways. The measured pair, both entries legal that morning:

```yaml
accepted:
  - { endpoint: "a",      relation: own, kind: "\0E", reason: r1, until: 2026-11-30 }
  - { endpoint: "a\0own",                kind: "E",   reason: r2, until: 2026-11-30 }
```

One `acceptanceKeyOf`, two different defects. Before the note of 24 August on
[ADR-0048](0048-a-finding-can-be-known-and-still-reported.md) this parsed, and
`indexAcceptances` — a `Map` on that key — kept the last entry, so an operator's
second acceptance replaced the first and decided its deadline. After that note
the configuration door refuses the pair, and refuses it as *one defect declared
twice*, which is the wrong sentence about two.

The same premise carries `cellKey` (account × endpoint × resource) and
`objectKey` (endpoint × resource). The reviewer measured that a hostile OpenAPI
`operationId` alone does not reach a collision there, because the arity is fixed
and only one field of the three is attacker-supplied — but that is an accident of
today's field count, not a property anybody arranged. A resource id and an
account id come from the same kind of document.

### The strings this is about, and how the list was derived

By reading `joinKey`'s callers and what each of them passes, not from the
report:

| key | built in | parts |
| --- | --- | --- |
| `cellKey` | `src/core/keys.ts` | account id, endpoint id, resource id |
| `objectKey` | `src/core/keys.ts` | endpoint id, resource id |
| `defectSignature` | `src/core/defects.ts` | endpoint id, relation, context id |
| `acceptanceKeyOf` | `src/core/accepted.ts` | the three above, and a finding's kind |
| the evidence budget in `capRows` | `src/report/findings.ts` | the same four |

Five distinct strings, then: **an account id, an endpoint id, a resource id, a
context id, and a finding's kind.** The sixth part, `relation`, is not one of
them: it is a member of `RESOURCE_RELATIONS`, a list this tool writes, and no
document chooses it.

Where each of the five is chosen:

- an **account id** is `accounts[].id`, and also the derived
  `alice-a@geo-blocked` that `toAccounts` builds out of an account id and a
  context id;
- an **endpoint id** is an endpoint list's `id`, an OpenAPI `operationId` (or the
  `GET /v1/orders` generated where there is none), a Postman item's folder path
  and name, a record in a resume stream, and an `Endpoint` a consumer of the
  library constructs;
- a **resource id** is `resources[].id`, a record in a resume stream, and a
  `Resource` a consumer constructs;
- a **context id** is `contexts[].id`;
- a **kind** is `accepted[].kind`, a `DiffKind` — a closed union — or the `id` of
  a check, which is registered from code and from nowhere else.

## Decision

**An identifier has a grammar, it lives in `src/core/identifiers.ts`, and
`joinKey` applies it.**

### Where the grammar lives

[ADR-0024](0024-strings-from-outside.md) puts a grammar for a string from outside
in `src/io/untrusted.ts`, **unless the core reads the same grammar** — then it
lives in `src/core` and `untrusted.ts` reaches down for it, because
`untrusted.ts` already imports `isUsablePathSegment` from `src/core/types.ts` and
a core that imported back would close that ring. `isUsablePathSegment` and
`src/core/path-parameters.ts` are the two precedents; this is the third, and it
is the strongest case of the three: the place the rule has to hold is `joinKey`,
which is core.

Its own module rather than more lines in `src/core/types.ts`, following
`path-parameters.ts`: eight doors in four layers import it — six when this was
written and two more the same day — and a module they can import without dragging
the core's whole vocabulary along is the cheaper import.

`src/io/untrusted.ts` does not re-export it. A second address for one grammar is
the shape ADR-0024 is against, and `src/index.ts` does `export * from` on that
module, so a re-export there would put the same three names on the published
surface twice.

### What it refuses

A code point that is not text — **the C0 controls, DEL, the C1 controls, and the
two Unicode line separators** — and the empty string.

Refusing the NUL alone was the obvious answer and is the wrong one. It is the
twelfth point fix ADR-0024 counts: it makes the sentence in `keys.ts` true by
naming one character, and it stays true only until the separator moves. The rule
as written is true of the separator whatever the separator becomes.

The rest of the range is not padding, and the argument is not symmetry. **An
identifier is printed** — into the report a person reads, into an error message,
onto a terminal — so the class that cannot be a name is the class that is not
text:

- a newline in an endpoint id makes one line of console output read as two, with
  the second line's content chosen by the document under test;
- `U+001B` opens an escape sequence a terminal obeys, and this tool prints
  endpoint ids on every run;
- a carriage return rewrites the line already printed;
- the C1 range is the same class in a spelling that survives a search for `\n`;
- `U+2028` is a line terminator to a JavaScript parser, which is what the JSON of
  a report becomes the moment it is embedded in a page.

The empty string is refused because it is the **absence** sentinel: every key in
this repository writes `""` for a coordinate it does not have. A resource whose
id is `""` and no resource at all were two different cells with one key.
`joinKey` takes `string | undefined` now, so absence has a spelling of its own
and the empty string has none.

**Where the line stops is as deliberate.** A space, punctuation, a letter of any
script and an emoji are all admitted — a Postman folder path is somebody's prose,
and an endpoint called `Bestellungen / Übersicht` is a legal id today. So are the
characters that make two different ids *look* alike, a homoglyph or a
bidirectional override: those are a legibility problem and not an identity one. A
key is compared by code points, and two ids that read alike are still two rows.
That is named again under Limits, because it is a decision and not an oversight.

The refusal spells the value out — `a\u0000own` — rather than quoting it. A
message that carried the character would put it on the terminal the refusal
exists to protect.

### The seam, and the doors under it

`joinKey` is the one place a key is built, the way `joinUrl` is the one place an
address is built, and [ADR-0032](0032-the-grammar-sits-at-the-seam.md) is the
record of what the doors alone cost: the guard sat on three adapters and the
fourth door — a consumer of the library calling into the core — had nothing. The
same reasoning applies here without amendment, so the check is at the seam
**and** at the doors, exactly as `isAddressablePath` and `pathTemplate` are.

| door | the strings it hands over | covered by |
| --- | --- | --- |
| `parseRunConfig` | `accounts[].id`, `resources[].id`, `accepted[].endpoint`, `accepted[].kind`, `accepted[].context` | the door, naming the field, and the seam under it |
| `normalizeContexts` | `contexts[].id` | the door, naming the field, and the seam |
| `createEndpointListParser` | `id` | the door, naming the entry number, and the seam |
| `createOpenApiParser` | `operationId`, and the generated `GET /v1/orders` | the door, naming the operation, and the seam |
| `createPostmanCollectionParser` | the `name` of every item | the door, naming the folder, and the seam |
| `CheckRegistry.register` | a check's `id` | the door and the seam |
| `toComparableRun` | every string of a saved report | the door, naming the field and the file, and the seam |
| a resume stream read back off disk | endpoint id, resource id, account id, and the header | the door, naming the cell and the file, and the seam |
| a consumer building `Endpoint[]`, `Resource[]`, `Account[]` or `Acceptance[]` | all five | **the seam only** |

The last row is the point of having a seam: it has no adapter on it and no list
of parsers would ever have named it.

The two rows above it are the amendment of 24 August 2026, and the second was on
this list the first time round with "**the seam only**" beside it. See the two
notes below.

## Note of 2026-08-24: the ninth door

`barbican diff` reads two saved reports. `toComparableRun` lifted every string
out of them and handed it on unasked: `defects[].key` indexes the defect
comparison, `observations[].endpointId` indexes the probed set, and both are
printed straight onto the terminal by `renderComparison`. Measured by adversarial
review against the built tree, the same day this ADR landed:

```
observations[0].endpointId = "orders.list" U+001B "[2K" U+000D "SPOOFED"
      -> erases the line the comparison printed it on
defects[0].key             = U+001B "[31mRECOLOURED own none"
      -> recolours the rest of the screen
```

Both with exit 2 and a report the operator was told they could trust.

**A saved report is a document the tool was handed**, in exactly the sense an
OpenAPI file is: it comes off disk, it may come from another machine, an earlier
build or somebody else, and nothing about `barbican run --report` having written
one yesterday says anything about the file two paths name today. This is the
shape ADR-0032 records twice — a grammar placed on the ways in, and the one door
with no adapter behind it left with nothing. The table above named five parsers,
the library door and the resume stream. It did not name this one.

### Refused, not escaped

Escaping a control character on the way to a terminal is modelling the terminal,
which is the mistake ADR-0032 records about the address and CLAUDE.md states as a
rule. It is also a second grammar to keep in step with the first, and it would
leave the tool holding an id it can never print back. The refusal is
`UnusableIdentifierError`, the shape every other door of this grammar has, and it
names the field and the file:

```
defects[0].key in the report "after.json" carries U+001B, which is a control
character rather than text. Written out, the value is
"\u001B[31mRECOLOURED own none". An identifier names a row of this tool's own
tables: … Change it where it is declared.
```

The path with the index and not the field name alone, because `"key" is wrong` is
unactionable in a file with forty defects in it — the same reasoning that made the
configuration door say `accepted[0].kind`. The existing `UnreadableReportError`
messages gained the same path in the same pass.

**The cost, stated rather than waved at.** A report written before today can
legitimately carry such an id: nothing refused one until this ADR, so a run
against a specification with a newline in an `operationId` produced a report that
`diff` will now refuse. That is a real regression for a real file, and it is
accepted for two reasons. The refusal names the field, the file and the character
and spells the value out, so the operator knows exactly what happened rather than
meeting a blank screen or a mangled one; and the fix is the one they want anyway —
the id came from their own document, and re-running with it corrected produces a
report that compares. The alternative, comparing the file and printing it, is the
measured behaviour above.

### Every string, not only the two that were measured

`stringAt` is the one function that lifts a string out of the parsed document, so
the grammar is applied there, in `optionalStringAt` beside it, and to the keys of
`notProbed`. That covers `schemaVersion`, `runId`, `configDigest`, `startedAt`,
`target.baseUrl`, `target.label`, `verdict.reason`, every skip reason, and every
string of every defect and observation.

Not only the five ADR-0066 calls identifiers, and the reason is that at this door
the distinction does not survive contact: `runId` is printed on the first line of
every comparison, `verdict.reason` is printed inside a blocker, a skip reason is
printed in quotes, and `configDigest` is printed sliced to sixteen characters. A
door that asked about `defects[].key` and not about `runId` would be a point fix
on the two fields somebody happened to measure — the arithmetic ADR-0024 counts to
eleven.

Applying it to all of them is behaviour-preserving on every report this tool
wrote: `target.label` is `z.string().min(1)` in the configuration schema, a digest
is 64 hex characters, `citableDefectKey` writes `any-resource` and `baseline`
where a coordinate is missing, and no `runVerdict` reason is empty. So the empty
half of the grammar refuses documents this tool did not write, and nothing else.

`--json` was never the channel: `JSON.stringify` escapes a control character, so
the machine-readable half of `diff` was safe throughout. The screen was not.

### The other readers, enumerated

Asked rather than assumed. Three functions in `src/` read a file: `readReport`
(the two paths of `diff`), `readNamedFile` (the four paths of `run`, feeding the
four parsers already in the table) and `readObservationStream` (`--resume`).
There is no fourth.

- **The resume stream** was on the table with "the seam only" beside it, which was
  true and is the wrong amount of help. `joinKey` refuses a coordinate that is not
  an identifier, so a hostile stream could never glue two cells into one entry —
  but the sentence arrives as `A coordinate of a key carries U+0000` from inside
  `cellKey`, half a walk after the line was read, naming neither the file nor the
  cell. It has a door now: `asCellRecord` asks about `accountId`, `endpointId` and
  `resourceId`, naming the cell and the stream.

  The **header** is asked too, and before the two comparisons that follow it,
  because those comparisons print what they refuse: `--resume refuses: "…" was
  written by barbican <version>` and the declaration mismatch beside it both quote
  the file's own string onto the terminal. `runId` and `startedAt` are adopted by
  a resumed run — into the report, and `runId` onto the wire in the `run=` marker
  — so a stream decides two strings that outlive it.

- **`toComparableRun` through the library door** is the same function and is
  covered by the same check; `docs/library.md` names it as the entry point for a
  report that came back off disk as JSON.

- **The four run documents** were already doors. One of them was not the door it
  said it was; see the next note.

## Note of 2026-08-24: three sentences that were not true

Written down because CLAUDE.md's rule about this family is that a document
claiming more than the code holds is the defect, not a rounding error.

**1. The OpenAPI door and its generated fallback.** `src/adapters/openapi.ts`
said, over the `identifier` call: *"The generated fallback needs none: the method
comes from a closed set and the path has been through `pathTemplate` two loops
up."* Measured false. The two grammars refuse different classes —
`isNeverInAPath` in `src/io/untrusted.ts` refuses a backslash, everything below
`U+0020` and DEL, and stops; this one refuses those **and** the C1 range and the
two Unicode line separators. So:

```
path "/v1/a" U+0085 "b", no operationId
  pathTemplate      -> admitted
  generated id      -> "GET /v1/a" U+0085 "b"
  isUsableIdentifier-> false
```

The fallback was therefore covered by the seam alone: refused in `joinKey`
mid-walk, as `A coordinate of a key`, with no operation named. The door asks about
it now, and the sentence says what is true.

The refusal for the fallback deliberately does **not** name the path, although
the `operationId` branch beside it does: the value *is* the method and the path,
so the spelled-out form is the location, and quoting the path a second time would
carry into the message the very characters `pathTemplate` admits. See Limits.

**2. `alice-a@geo-blocked` is a composition, and `@` composes ambiguously.** The
Context above names the derived account id as a source of an account id, and the
paragraph over `CONTEXT_SEPARATOR` said a collision with a declared account "will
not pass silently: building the matrix rejects duplicate identifiers". Both
sentences were true and neither was the whole thing. Measured on each path rather
than assumed, with account `a`, account `a@b`, context `b@c` and context `c` —
four legal identifiers, one derived id:

| path | what happened |
| --- | --- |
| `toAccounts` itself | four rows, two of them named `a@b@c`; the `attributes` map held **one** entry for the two, so the second context's headers answered for both |
| `buildAccessMatrix` | `DuplicateIdError: Duplicate account with id "a@b@c"` — the refusal, and it says nothing about the substitution |
| `barbican run` | the canaries and the whole walk first: **4 requests of 4** spent, `x-one` never sent at all, then exit 2 with that sentence |
| `barbican run --dry-run` | builds no matrix, so no refusal at all: `Matrix rows: 4 (declared accounts 2)`, exit 0 |

`@` cannot be taken out of an account id — accounts are named by email addresses,
which is why the paragraph called the case out in the first place — and no other
character is safer, because whatever is chosen an id may carry it. What makes the
composition safe is checking it where it happens, which is before any traffic and
on every path that derives a row. `AmbiguousContextRowError` is that check, and it
names both rows: *Two matrix rows are both named "a@b@c": account "a" under
context "b@c" and account "a@b" under context "c"*. Re-measured after the fix: 0
requests, and `--dry-run` refuses too.

This is the one behaviour change in the pass that grows the published surface,
and it is a decision rather than a side effect — see Consequences.

**3. The new single home had no gate.** CLAUDE.md's rule is that a decision with
one home is held by one, and `src/core/identifiers.ts` was held by nothing.
Measured: a second, independent copy of the grammar plus a new export
`looksLikeAnIdentifier` in `src/report/findings.ts` left the whole suite green —
their measurement, on the tree this ADR landed on. Written against the amended
tree the same copy fails **1 test, 1826 passed, 1 skipped**.
`tests/invariants/one-decision-one-home.test.ts` owns exactly this shape for
`keys.ts` and `path-parameters.ts`, so the third owner joins its tables rather
than getting a mechanism of its own — ADR-0065's "do not chase the next evasion"
is about adding a pattern per evasion, not about applying the existing one.

What was added, and what each part is for:

- **`CLASS_POINTS`** — `U+009F`, `U+2028`, `U+2029`, counted per module as a
  character inside any literal (through the same escape decoder the separator scan
  uses) and as a numeric literal in any base. They are what separates this class
  from the address grammar's, so `0x20` and `0x7f` are deliberately not counted:
  counting them would put `src/io/untrusted.ts` on the list for a reason that is
  not this one, and a copy faithful enough to be a copy writes all three of these.
- **`OWNED_NAMES`** gains the three exported names, so a rename, a rebinding, a
  re-export or a second declaration of any of them is refused.
- **`CONDUITS`** — the new thing, and the one the other two owners did not need.
  `src/core/index.ts` does `export * from "./identifiers.js"` on purpose, because
  the three names are on the published surface; without an entry, seven modules
  could import `identifier` from the barrel and the import table would never see
  the owner named. An import of a watched name through a conduit is held to
  `REACHES_IN` exactly as an import from the owner is, and the conduit is pinned
  to re-exporting its owner exactly once, in both directions.
- **`REACHES_IN`** gains the nine modules that ask the grammar — the seam in
  `keys.ts` first, then the eight doors. The blanket "an owner is not checked"
  skip is now per name, because `keys.ts` both owns names and calls another
  owner's.

Attacked before being trusted, each mutation applied by the harness described at
the foot of this document, each restored from a byte copy:

| written | what went red |
| --- | --- |
| the reviewer's `looksLikeAnIdentifier`, class written out | `writes the identifier class's code points in one module`, naming `src/report/findings.ts (3)` |
| the same class written in decimal — `127`, `159`, `8232`, `8233` | the same, `(3)` |
| the same class as a regex, `/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/` | the same `(3)`, **and** the separator scan `(1)` |
| `import { identifier as check }` through the barrel | `lets the listed modules reach into an owning module`, and the name check |
| `import { identifier }` in a module not in the table, through the barrel | `lets the listed modules reach into an owning module`, naming `through src/core/index.ts` |
| `const check = identifier;` inside a module the table allows | `uses an owned name outside its owner only by calling what was imported` |
| the conduit narrowing to `export { identifier } from` | the same, `src/core/index.ts:13 holds identifier` |
| the conduit dropping the owner entirely | `re-exports src/core/identifiers.ts 0 times rather than once` |
| `export const NOT_TEXT = [0x9f]` in the owner | `hands out the rule and not the class of characters`, **and** the class scan `(4)` |

What it still cannot see is under Limits, measured the same way.

The doors are not redundant with the seam. `A coordinate of a key carries U+0000`
is true and unactionable; `The kind at accepted[0] carries U+0000` is the line of
the file. The seam is what makes the refusal certain, the door is what makes it
useful, and that division is ADR-0032's, not a new one.

### What the seam cost

Measured rather than guessed, because `joinKey` runs on every coordinate of every
cell of every run.

A counter compiled into `dist/core/keys.js` — build output, restored from a byte
copy — over one run against the reference platform: **864 calls and 2448 parts**
with no defect enabled, **1310 calls and 3950 parts** with ten of them on, over
144 cells. The run itself takes about 3.8 seconds.

The check against the implementation it replaced, over coordinates of the shape
that run produces, two readings: 16.3 → 44.4 and 17.2 → 42.1 ns per part, so
**about 25 to 28 ns of added work per part**. For the worst polygon combination
that is **0.1 ms added to a 3.8-second run**, and for a hypothetical run of a
million parts it is about 25 ms. The cost is not a consideration; it was measured
because it might have been.

### Two keys stopped being built out of another key

`acceptanceKeyOf` and the evidence budget in `capRows` each built a key that is a
defect signature and one coordinate more, by handing the finished signature back
to `joinKey` as a part. That cannot stand beside the rule above: a part of a key
is an identifier, and a signature is a key — it carries separators, and the
grammar reading it could not tell those from the ones an operator's `kind` had
smuggled in.

Spelling the coordinates out again in each of them was the alternative, and
ADR-0048 forbids it in so many words. So `defectSignature` takes further parts,
and the two callers ask it to extend its own signature. The bytes are identical:
`a NUL b NUL c` and then `NUL kind` is the same string either way. One reading of
what a defect is addressed by, one joining, and a flat key whose every part has
been through the grammar.

A side effect worth noting, because a document says otherwise elsewhere: those
two keys used to glue the same pair of coordinates in **two orders**, and
`tests/invariants/one-decision-one-home.test.ts` named that in its list of what
it cannot see. They are one string now, and that list is corrected in place.

## Alternatives

**Refuse the NUL and nothing else.** Rejected on ADR-0024's arithmetic: it is a
point fix on the character that happens to be the separator today, and it leaves
a newline in an endpoint id reaching a terminal.

**Escape instead of refuse.** Percent-encode or backslash-escape a coordinate on
the way into a key. Rejected twice over: it is a second grammar to keep in step
with the first — the decoding side would have to agree, and ADR-0032 records what
modelling somebody else's decoding costs — and it would leave the tool holding an
id it can never print. The honest answer to a name that cannot be printed is to
ask for a different name.

**A branded `Identifier` type, the way `HeaderValue` is branded.** The compiler
would then refuse an unchecked string at every call site at once, which is
strictly stronger than a runtime seam. Rejected on reach: `Endpoint.id`,
`Account.id`, `Resource.id`, `Acceptance.kind` and `Check.id` are the published
domain types, and branding them would break every consumer's literal — for a
guarantee the seam already gives at a cost of 25 ns. Reconsider if a second class
of identifier ever appears.

**The doors alone.** This is the state ADR-0032 was written from, twice. The
library door and the resume stream were named here as the two nobody enumerates —
and the list of doors written beside that sentence was itself short by one, which
is the note of 24 August above. The resume stream and the ninth door both have a
door now; the library door still cannot have one, and is the whole argument.

**The seam alone.** Cheaper, and it refuses everything the doors refuse. Rejected
because the message is the difference between a refusal and a fix: the seam
cannot know that the string came from `accepted[0].kind`.

**Applying the check in `cellKey`, `objectKey` and `defectSignature` rather than
in `joinKey`.** Three places instead of one, in one file, three lines apart —
which is exactly the shape that produced this repository's `cellKey` duplication
in the first place, at a smaller radius.

## Consequences

**Behaviour changes, and this is exactly what changes.** Previously accepted,
now refused:

- any of the five identifiers carrying a C0 control, DEL, a C1 control, `U+2028`
  or `U+2029`. The message is `<where> carries U+XXXX, which is a control
  character rather than text`, followed by the value spelled out and by what an
  identifier is for;
- any of them being the empty string. At the configuration doors this was already
  impossible (`z.string().min(1)`); through the library door and the resume
  stream it was not, and `resourceId: ""` shared a key with "no resource";
- a check registered with an id of either shape.

**Nothing that was refused before is accepted now.** The grammar only adds
refusals: every door keeps the checks it had, in the order it had them — the
endpoint list still refuses a blank-but-not-empty id, the schema still refuses an
empty string, and the duplicate checks still run on the values that get past.

**The published surface grows by three**, from 227 to 230:
`UnusableIdentifierError`, `isUsableIdentifier` and `identifier`. That is a
decision and not a side effect.

**And by one more on 24 August, to 231**: `AmbiguousContextRowError`. Argued
rather than slipped in. `toAccounts` is on the published surface, so a consumer
driving the walk from the library meets this refusal, and telling "your
declaration composes two rows into one" from the other things that stop a run is
done with `instanceof` — the reason `docs/library.md` calls the error classes
public on purpose. The alternatives were both worse: `DuplicateIdError` from the
core says `Duplicate account with id "a@b@c"` and nothing about the substitution
that happened first, which is the sentence this refusal exists to replace; and a
bare `Error` would put a configuration mistake in the same catch as a network
failure. `contexts.ts` already exports four error classes of this family, so the
shape is the module's own. `docs/library.md`'s two counts move to 231 and to 98,
and `tests/public-surface.test.ts` reads both out of that file.

The error class has to be there: `tests/public-surface.test.ts` requires every
error class the source declares to be reachable, because `instanceof` is how a
consumer tells a configuration mistake from a network failure, and this one is
thrown from the seam a consumer's own `Endpoint[]` passes through. The other two
are there because the module is exported whole rather than as a hand-picked
subset — the note of 21 August 2026 on ADR-0024 says why in the case that
produced it: a rule a consumer is held to and cannot inspect is a wall, not a
check. `docs/library.md` names all three and says which door they are for; its
two counts move with them, to 230 and to 97 error classes.

`src/core/keys.ts` and `src/core/path-parameters.ts` stay off the surface, and
the difference is worth stating: those hand out mechanics, this hands out a rule
the library door enforces.

**The report is unchanged.** The oracle answers as it did over all 29
combinations of the reference platform, 0 mismatches, with the polygon on port
8901. No key's bytes move: `cellKey`, `objectKey`, `defectSignature` and
`acceptanceKeyOf` produce the same strings for the same coordinates, and a test
pins each of the four.

**`tests/invariants/one-decision-one-home.test.ts` moved with the code.** Two
modules stopped importing `joinKey`, so two entries left `REACHES_IN` and two
left `KEY_BUILDERS`; the counts stay exact in both directions, which is the
property that makes a gate fail rather than pass when it has stopped seeing. The
gate was not weakened: what it enumerates is the same, and there is less to
enumerate.

**`tests/docs/detached-comments.test.ts` moved too**, in both directions:
`src/core/keys.ts` leaves the module-header list because it now has an import
between its header and the next block, and `src/core/identifiers.ts` joins it.

## Limits: what this does not hold

Written down after being run, as [ADR-0065](0065-what-a-source-scan-can-hold.md)
requires. Each entry below was applied to the committed tree by a harness that
refuses to run anything unless every replacement lands the number of times it was
declared to land, and each was restored from a byte copy taken before the edit.
The refusal the harness prints on a needle no file carries is quoted at the end.

The tree they were first run against is the commit this ADR belongs to, whose
suite was **119 files, 1814 passed, 1 skipped**. Every entry below was **re-run
against the amended tree** later the same day, whose suite is **119 files, 1827
passed, 1 skipped**, and each carries the second reading rather than the first —
a Limits section describing a tree that no longer exists is the defect
[ADR-0065](0065-what-a-source-scan-can-hold.md) is about.

- **A back door inside the grammar, keyed on the value.** Measured:
  `if (value.startsWith("legacy:")) { return undefined; }` at the head of
  `refusalOf` passes **the whole suite** — 119 files, 1827 passed, 1 skipped —
  with `pnpm exec biome check src/core/identifiers.ts` clean on the file.
  Nothing pins the text of these three functions the way
  `tests/invariants/written-once.test.ts` pins the address grammar's, and pinning
  them is the blob nobody reads
  ([ADR-0061](0061-a-rule-is-written-in-one-place-and-read-in-two.md) reaches the
  same conclusion about its own predicates).

  The neighbouring form — a code point quietly let out of the class,
  `if (code === 0x0b) { return false; }` inside `isNotText` — is **closed**, and
  it is worth saying which of the two the tests reach. `tests/core/identifiers.test.ts`
  asks the grammar about every code point up to `U+2100` one at a time, so that
  mutation goes red on the code point it exempts: 1 failed, 1826 passed, 1
  skipped, naming `U+000B`. A back door on the *value* is past that scan, because
  the scan varies the character and not the string around it.

- **A key built without `joinKey`.** The seam holds what goes through it, and
  nothing makes a module go through it. Measured: a second index in
  `mergeFindings`, keyed by `` `${accountId}|${endpointId}` ``, passes the whole
  suite — 119 files, 1827 passed, 1 skipped — with Biome clean on
  `src/report/findings.ts`. (The first reading of this entry glued a third
  coordinate; `AccessObservation` carries no `resourceId`, so that spelling is a
  type error and never ran. The two-coordinate form is the one measured, and the
  point is the pipe rather than the arity.) `tests/invariants/one-decision-one-home.test.ts` reads
  for the **separator** and for the owned names, and a pipe is neither. What holds
  against the class is what ADR-0060 says holds: such a key is a second
  implementation rather than a second reference, and it drifts the day the first
  one moves.

- **The doors are a list of tests, not a table.** Measured in the direction that
  can be measured: deleting `identifier(check.id, …)` from `CheckRegistry.register`
  fails exactly one test — 1 failed, 1826 passed, 1 skipped — the one written for
  that door. So a door that stops asking is caught, and a door that never asked is
  caught by nothing except the seam under it: the run still refuses, and the
  operator gets `A coordinate of a key carries U+0000` instead of the line of
  their file. A seventh endpoint source added tomorrow with no `identifier` call
  is safe and unhelpful, and nothing says so.

  For completeness in the other direction: removing the seam itself — `asCoordinate`
  returning the part unchecked — fails three tests, 1824 passed, 1 skipped, all
  three in the `the seam` block. The seam is what an unenumerated door rests on,
  so it is held by more than one witness on purpose.

  Read this entry with the two that follow the heading below. It was written when
  the table named six doors, and a seventh and an eighth were found the same day —
  which is the entry demonstrating itself.

- **`citableDefectKey` is still a map key one layer out, and still ambiguous.**
  This grammar covers the keys `joinKey` builds. The citable form joins the same
  three coordinates **with a space**, and `src/report/compare.ts` indexes two
  saved reports on `defects[].key`, which is that form. Measured against the
  built tree:

  ```
  A = { endpointId: "a",       relation: "own",         contextId: "b same-tenant d" }
  B = { endpointId: "a own b", relation: "same-tenant", contextId: "d" }
  citable A: "a own b same-tenant d"
  citable B: "a own b same-tenant d"      one citable key: true
                                          one signature:   false
  ```

  Every string in both is a legal identifier under this grammar, because a space
  is a legal character in a name and that is a decision, not a gap. Two different
  defects therefore merge into one row when two reports are compared. It is the
  same class as the defect this ADR is about — a form written for people used to
  decide identity, which is the note of 24 August on ADR-0048 — one layer further
  out, and it is left open here rather than fixed in passing, because fixing it
  means deciding what `defects[].key` is for.

- **Two identifiers that read alike are still two identifiers.** A homoglyph, a
  zero-width joiner, a bidirectional override: all admitted, and
  `tests/core/identifiers.test.ts` asserts that `U+202A` and `U+202E` pass. This
  is the decision above and not an omission — a key is compared by code points,
  so nothing merges — but a report can be made to *read* misleadingly, and the
  grammar answers about identity rather than about legibility.

- **Arity is still the caller's.** `joinKey` refuses a part that carries a
  separator; it does not know how many parts a key of a given kind should have,
  so two builders could in principle produce one string. Nothing needs them not
  to today: no map in this repository holds two kinds of key, and `cellKey`,
  `objectKey` and `defectSignature` each own theirs. A gate reading source text
  cannot see this either, which is the same limit
  `tests/invariants/one-decision-one-home.test.ts` states about *what* is glued.

### Added 2026-08-24, against a tree of 119 files, 1827 passed, 1 skipped

- **A door's own sentence can carry a character out of the same document.** The
  grammar spells the value out rather than quoting it, precisely so that a refusal
  does not put an escape on the terminal it is protecting. The `what` a door hands
  it is not spelled out, because the door builds that sentence itself — and two
  doors build it out of the document. Measured against the built tree: an OpenAPI
  path of `/v1/a` `U+0085` `b` with an `operationId` of `orders` `U+0000` `list`
  gives

  ```
  UnusableIdentifierError
  message begins: "The operationId of GET /v1/a<U+0085>b carries U+0000, …"
  characters of the class carried by the message: 1 — U+0085
  ```

  `pathTemplate` admits `U+0085`, the C1 range and the two line separators, so
  what a path can smuggle into that sentence is exactly the difference between the
  two grammars. `createPostmanCollectionParser` has the same shape, naming the
  folder path. It is left open rather than chased: closing it means either
  exporting `spellOut` — a fourth name on the published surface, for a message —
  or a second escaper beside the first, which is the duplicate ADR-0024 exists
  against. The generated OpenAPI fallback, added the same day, is written the
  other way round on purpose: its sentence names no path at all, because the
  spelled-out value already is one.

- **A copy of the grammar that refuses a narrower class.** The class scan reads
  `U+009F`, `U+2028` and `U+2029`, which is what makes it about *this* class and
  not about the address grammar's. A second `looksLikeAnIdentifier` in
  `src/report/findings.ts` refusing only the C0 range and DEL therefore passes:
  measured, **119 files, 1827 passed, 1 skipped**. That is the right answer as far
  as the scan goes — `isNeverInAPath` is exactly such a function and is
  deliberate — and it is a hole all the same, because a narrower copy answering
  "can this be a name" is a second decision with the first one's job.

- **The three code points computed rather than written.** `const LAST_C1 = 0x9e +
  1` and `const LINE = 0x2027 + 1` give a copy that is faithful in every respect
  and writes none of the three: measured, **119 files, 1827 passed, 1 skipped**.
  The same class as the separator built by `decodeURIComponent("%00")`, with the
  same answer — nobody writes that by accident, and what holds against it is that
  the owner exports no class to borrow, so the copy will drift when the class
  moves. A numeric separator (`1_59`) is past the scan for a duller reason and is
  pinned as a limit in the gate's own unit tests.

- **The ninth door is held by two tests, and a tenth door would be held by
  none.** Measured in both directions against the amended tree. Removing the check
  from `readable` in `src/report/compare.ts` fails **2 tests, 1825 passed, 1
  skipped** — the door's own case in `tests/core/identifiers.test.ts` and the
  end-to-end one in `tests/cli/compare.test.ts`; removing
  `identifier(candidate.endpointId, …)` from `asCellRecord` fails **1 test, 1826
  passed, 1 skipped**. So a door that stops asking is caught. A door that never
  asked is caught by nothing but the seam under it, which is the entry three
  bullets up, unchanged: the tenth reader of a saved document, added tomorrow with
  no `identifier` call, is safe and unhelpful and nothing says so. The three
  functions in `src/` that read a file are enumerated in the note above, which is
  the best a list can do.

- **`citableDefectKey` is unchanged, and so is its ambiguity.** The entry above
  stands word for word: the space-joined form is still what `src/report/compare.ts`
  indexes two reports on, and a space is still a legal character in a name. What
  changed on 24 August is that the *characters* of that key are now checked, which
  is a different question — the collision measured there is between two keys both
  made of perfectly legal identifiers.

- **`--json` was never the channel and is not one now.** `JSON.stringify` escapes
  a control character, so the machine-readable half of `diff` printed `\u001B`
  throughout. The check is about the screen, and about the map keys.

Every mutation above was applied by a harness that refuses to run anything unless
each replacement lands the declared number of times, and restores from a byte
copy taken before the edit. On a needle no file carries it prints

> REFUSED. The needle was expected 1 time(s) in `src/core/identifiers.ts` and is
> there 0. Nothing was run: a mutation that did not apply is a green run that
> proves nothing.

and runs no suite, which is what stops a harness from reporting a gate as
effective when it never mutated anything.

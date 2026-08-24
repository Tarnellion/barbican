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
`path-parameters.ts`: six doors in three layers import it, and a module they can
import without dragging the core's whole vocabulary along is the cheaper import.

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
| `createOpenApiParser` | `operationId` | the door, naming the operation, and the seam |
| `createPostmanCollectionParser` | the `name` of every item | the door, naming the folder, and the seam |
| `CheckRegistry.register` | a check's `id` | the door and the seam |
| a consumer building `Endpoint[]`, `Resource[]`, `Account[]` or `Acceptance[]` | all five | **the seam only** |
| a resume stream read back off disk | endpoint id, resource id, account id | **the seam only** |

The last two are the point of having a seam. Neither has an adapter on it; the
resume stream in particular is a document the tool was handed, and it would not
have been on anybody's list of parsers.

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
library door and the resume stream are the two that nobody enumerates.

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

_(the measurements are recorded in the section below, added after they were run)_

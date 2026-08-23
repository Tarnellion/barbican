# 0059. One key, one source

- **Status:** accepted
- **Date:** 2026-08-23

## Context

`cellKey` — the string a verdict and a finding have to agree on to be about the
same cell — was written out twice, character for character:

- `src/runner/stream.ts`, exported, read by the walk;
- `src/report/findings.ts`, private, read by six call sites in that file.

The doc comment over the second copy said what was wrong with the arrangement:

> Written out by hand in five places, and the sixth had to agree with all five
> for a verdict and a finding to meet on the same cell.

That sentence had itself become one of two copies. ADR-0057 recorded the same
thing from the other side while cutting the runner — "they agree today and
nothing makes them" — and left it, because a behaviour change arriving with a
move is a change nobody reviewed.

Nothing forced the agreement. Both functions build
`account NUL endpoint NUL resource`, and either could have been edited alone:
a fourth coordinate added on one side, a `?? ""` dropped on the other. The
failure would not be a crash. It would be a `Map` lookup that misses, which in
`mergeFindings` means a finding with no request attached, and in `withVerdicts`
means a cell going into the report as `match: true` — "tested and agreed" — with
nobody's verdict on it. That is the same shape as the twelve cells ADR-0022 and
the review of 17 August closed, arrived at from a different direction.

Two more keys of a related shape were spelled inline in `src/runner/walk.ts`,
three times between them: `endpoint NUL resource`, with no account.

## Decision

### The cell key is one function, and it lives in `src/core`

`src/core/keys.ts`, holding `KEY_SEPARATOR`, `cellKey` and `objectKey`.

The two consumers are in two layers, and that is precisely why the copies
drifted: the layering rule runs one way — `src/core` may not import from
`runner` or `report`, and both of those may import `core`. A single copy kept in
the runner would have made the report import upwards; one kept in the report
would have done the same to the runner. Core is the only place both can reach,
and a coordinate of the matrix belongs there on its own merits: the matrix is
core's subject, and these are pure functions over three strings.

**Not exported from `src/core/index.ts`**, so the published surface is unchanged
— the same 227 names, and `src/index.ts` untouched. `src/core/order.ts` is here
on exactly these terms already: how this tool arranges its own output, or its own
lookups, is not a promise to a consumer. The `exports` map in `package.json`
names `.`, `./core`, `./schema/*` and `./package.json`, so
`barbican/dist/core/keys.js` is not an import path anybody has.

Under `verbatimModuleSyntax` every import here is a value import and is emitted
as written; nothing in this module is a type, so the trap that ADR-0057 records
— a type re-exported without the `type` modifier, failing at import time rather
than at build time — is not in reach.

### The second key is a real second concept, and it is named

`objectKey` — endpoint and resource, no account. The two places that build it
are each wrong with an account in them:

- placing a resumed record, where `cells` is the endpoint × resource list the
  walk holds once and shares between all accounts (ADR-0053), and the account is
  resolved separately into a walker;
- naming an object this run has already changed, where the whole point is that a
  404 after **anybody's** successful write is this run's own doing. An account in
  that key would report a manufactured 404 as protection observed on the second
  account through — the defect the `changed` set exists against (audit of
  14 August 2026, L-7).

Both keys are in one module so that the difference between them is a paragraph
away rather than a file away.

### The separator is one constant

`KEY_SEPARATOR`. `src/core/defects.ts` had `SEPARATOR` and `src/core/accepted.ts`
had `KIND_SEPARATOR`, with the second's comment pointing at the first. They are
one decision under two names: the same character, chosen for the same reason, in
two keys at two levels. The keys stay two; the character is now one constant, and
the reasoning for it is written once.

This is what makes the gate below exception-free rather than a list of files
allowed to spell the character — and a list of allowed exceptions is the shape
this repository already distrusts.

### The gate is a test, because the comment was not one

`tests/invariants/one-key-one-source.test.ts` reads the tracked sources under
`src/` — `git ls-files`, the exact set that goes public, for the reason
`tests/docs/language.test.ts` gives — and asserts three things:

1. no source carries the separator as a **raw byte**;
2. the escape appears only in `src/core/keys.ts`, and in `src/adapters/signals.ts`
   at an exact count;
3. no module outside `src/core/keys.ts` declares a `cellKey` or an `objectKey` —
   which is what catches a copy that imports the constant and rebuilds the string.

The first assertion is not decoration. It found two keys that no reader had.

> **Correction, 23 August 2026 (ADR-0060).** The clause on assertion 3 was false
> when it was written. That assertion matched the literal names `cellKey` and
> `objectKey`, so a copy called anything else — importing `KEY_SEPARATOR` and
> rebuilding the same string — walked past all three, and a reviewer walked one
> past the whole of `pnpm run check` with exit 0. So did
> `const SEPARATOR = "\x00"`, which is the same character in a spelling
> assertion 2's six-character needle does not read. ADR-0060 is what makes the
> sentence true, by removing what it describes: `KEY_SEPARATOR` is no longer
> exported, so there is no constant to import.

## What the gate found on its first run

`grep` treats a file containing a NUL byte as binary and prints no matches in it.
`src/core/defects.ts` says so in a comment, which is why its own separator is
written as an escape. Two files wrote the byte itself, and every search of this
repository for the separator — including the one that opened this work — had been
answering "no matches" over both:

- **`src/io/config/parse.ts`** built `citable NUL kind` by hand, to refuse two
  acceptances declaring the same defect. A seventh key.
- **`src/adapters/signals.ts`** frames a scoped digest with it, three times.

`parse.ts` takes the constant: it is a lookup key, the same concern. `signals.ts`
keeps its own literal and is named in the gate with its reason — a hash's domain
separation is not a map key, the bytes go into a number the report prints, and
tying them to a constant about lookups would mean that changing how this tool
indexes its tables silently changes a digest. Both files now spell the character
as the escape, so the repository can be searched for it. The strings are
identical, so the digests are identical: all 29 polygon combinations are
unchanged.

## Alternatives

**Leave the two copies and keep the comment.** Rejected: the comment was already
there, and already duplicated. It asked five places to agree and could not tell
anybody when they stopped.

**Export `cellKey` from `src/core/index.ts`.** One name more on the published
surface, forever, for a string this package's own layers pass between themselves
— and 227 would have become 228 for no consumer's benefit.

**Keep it in `src/runner/stream.ts` and let the report import from the runner.**
The shortest diff, and the wrong direction: `src/report` reading a runner module
puts a layering exception in the tree for one function, and the next such
function then has a precedent to point at.

**Fold the second key into the first with an empty account.** Rejected: it would
make two different questions look like one question, and the `changed` set would
be one edit away from being keyed by account — which is the L-7 defect back.

**A lint rule instead of a test.** Biome has no rule of this shape, and a custom
plugin would put the reasoning in a configuration file rather than beside the
history that explains it. The test carries both.

## Consequences

`src/runner/stream.ts` no longer exports `cellKey`, so the runner barrel's list of
names the six modules hand each other is one shorter. Nothing outside this
repository could see it; `dist/runner.d.ts` still names the same twenty-two.

A doc comment that had been stranded is stranded no longer, and not by being
edited. "Attaches to every finding the request that produced it. Joined on the
triple 'account × endpoint × resource'…" sat above the second `cellKey` in
`findings.ts`, describing `mergeFindings` below it; removing the function put the
comment back against the declaration it describes.

### Noticed and not fixed

- **The acceptance duplicate check keys on the citable form.**
  `src/io/config/parse.ts` refuses two acceptances whose `citableDefectKey` and
  kind match, and its comment says this is "exactly what the report matches a
  finding on". It is not: the report matches on `acceptanceKeyOf`, which is
  `defectSignature` — the NUL-joined triple, where an absent `contextId` is `""`.
  `citableDefectKey` joins with **spaces** and spells an absent `contextId`
  `baseline`, which is a form `defects.ts` documents as being for people rather
  than for maps. So two acceptances on one endpoint, one with `context: baseline`
  written out and one with no context, are refused as duplicates although they
  are two different keys at report time. Over-strict rather than permissive, and
  a configuration-time error rather than a wrong verdict — but the comment is
  false and the pair should be one function. Not fixed here: it changes which
  configurations are accepted, and that is a behaviour change.
- **`capRows` and `acceptanceKeyOf` spell one coordinate two ways.**
  `src/report/findings.ts` builds `kind NUL signature` for the per-defect
  evidence budget; `src/core/accepted.ts` builds `signature NUL kind` for the
  acceptance index. The same pair of coordinates in the other order. They are
  left as two because one is a map that never leaves a function and the other is
  a key an operator writes into a configuration file; both take `KEY_SEPARATOR`
  now, so neither can glue two defects into one budget.
- ~~**ADR-0057 renders the two `walk.ts` keys with a space.**~~ **Wrong, and
  wrong in the way this ADR is about — corrected 23 August 2026, ADR-0060.**
  ADR-0057 did not render them with a space. It held the **raw NUL byte itself**,
  and a raw NUL makes a file binary to `grep`, so the search that went looking
  for the separator in `docs/` answered "no matches" and the silence was read as
  a space. That is the same misreading, from the same cause, as the two source
  files this ADR's own gate found on its first run — committed here in the
  paragraph recording it. The byte is now the escape in ADR-0057, under a
  correction note there, and the gate reads **every tracked file** rather than
  `src/` alone, so the next raw byte anywhere in the repository fails a test
  instead of being written up as a rendering choice.

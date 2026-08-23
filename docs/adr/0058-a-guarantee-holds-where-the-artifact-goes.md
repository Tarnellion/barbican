# 0058. A guarantee holds where the artifact goes, not where the test stood

- **Status:** accepted
- **Date:** 2026-08-23

## Context

Three defects surfaced while [ADR-0054](0054-the-report-is-cut-where-the-cell-is.md)
was cutting the report layer into four files. None of them was fixed there — a
change of behaviour riding along with a move of code is unreviewable, because
the diff no longer says which lines changed their mind. They are fixed here,
together, because they are one class and the class is the interesting part.

Each is a guarantee this project already made, in writing, with a test behind
it. Each held at the place it was measured and at no place it was used. In all
three the test was written over the input the author had in hand — a report
still in memory, an ordinary identifier, a pair of cells with no object in them —
while the guarantee's real domain was one step further out: the file on the disk,
the identifier an operator picks, the cell that names a resource.

### 1. `contentDigest` was false on every file the tool has ever written

[ADR-0051](0051-the-report-answers-for-itself.md) gave the report a digest of
itself, and `docs/report.md` sells it as the answer to "is this the file the run
wrote". `buildReport` computes it as the last thing it does, over the finished
document — and the CLI then wrote one more field:

```ts
const report: RunReport = { ...built, runId };
```

That line is [ADR-0045](0045-a-consented-run-says-who-it-is.md): the run's
identifier has to exist before the first request, because it goes out in the
`user-agent` so the owner of the platform can find the traffic in their own logs;
`buildReport` runs after the last response and cannot mint it in time. So the CLI
minted it, and put it on the report **after** the digest had been taken over a
report carrying a different one.

`checkContentDigest` therefore answered `ok: false` for every artifact this tool
has produced. Measured on the 58 reports of the polygon: 58 of 58.

The test that was supposed to hold this — `tests/report/report-answers-for-itself.test.ts`
— builds a report in memory, round-trips it through `JSON.stringify` and checks
the digest of *that*. It was green throughout, and it was green about the one
report that never reaches anybody.

### 2. A set of conditions named `__proto__` vanished from `coverage.contextsProbed`

`countByContext` seeded its record with `counts[context.id] = 0` on a plain
object literal. A condition's id is `z.string().min(1)` and nothing narrower —
the label belongs to the operator — so this is one of the records
[ADR-0024](0024-strings-from-outside.md) is about. Declaring
`__proto__, ordinary` produced `{"ordinary": 0}`. The increment beside it is
worse than a no-op: it reads `Object.prototype`, adds one to it, and assigns the
resulting string back into the same no-op.

What breaks is the field's own promise, the one `docs/report.md` states: every
declared set of conditions has a key, the zero included, because a zero means
"declared and never tested" and an absent key means "nobody declared this". The
neighbouring records over the same kind of key space — `summary.byKind` and
`summary.accepted.byKind` in `findings.ts` — were already built with
`openRecord`, with a comment saying why. Two files away, the same record was not.
Two records of one kind guarded differently is precisely the state ADR-0024 was
written against.

### 3. `relatedRequestOf` dropped the resource out of the cell key

`cellKey` exists so that the six places that identify a cell agree on what a cell
is. `withRequest` passes it all three coordinates. `relatedRequestOf` — the
lookup that finds the other side of a paired finding — passed two, and left the
resource empty.

The comment on the check mapping lists who needs the third coordinate so that
"`withVerdicts` and `withRequest` find the observation instead of missing it".
`relatedRequestOf` was not on that list and was not fixed with them, which is the
whole story: the rule was written down as a list of call sites rather than
enforced at the key.

Latent today, and only just. The one check in the registry pairs observations
that name no resource (`pairsOn` filters on `resourceId === undefined`), so the
short key happened to be the right one. An object-level check with a
`relatedAccountId` — a BOLA read against a body, the first check Module 2 will
have — gets either no `relatedRequest` at all or the request from whichever other
cell of that account shares the first two coordinates. Both were reproduced.

Fourth time this class is closed. [ADR-0022](0022-one-verdict-per-cell.md) closed
it for the walk, [ADR-0039](0039-a-finding-names-the-whole-cell.md) for the
finding's own coordinate, `relatedAccountId` for the field the other side travels
in. This was the one lookup none of the three reached.

## Decision

**One ADR, because the three share a cause and the fixes share a shape.** They
are not three careless lines; they are three places where the thing that proves a
guarantee stood closer to the code than the guarantee does.

### The digest is last in the document's life, not last in a function

`runId` is now a field of `BuildReportOptions`. The CLI passes the identifier it
minted before the first request, `buildReport` uses it where it used to call
`randomUUID()`, and the digest — still the last statement of that function — is
taken over a document that already carries it. `randomUUID()` remains the
fallback for a caller that walked nothing and has no identifier of its own.

Both guarantees survive, and they are compatible only in this order. Making the
digest check out by letting the report mint its own `runId` would have left the
owner of the platform holding traffic marked with an identifier no artifact
carries, which is the whole of what ADR-0045 bought.

The rule the comment now states at the foot of `buildReport`: **anything a caller
writes onto the returned report is outside the digest.** Whatever belongs in the
document comes in through the options.

### The record for the conditions is built with `openRecord`

`countByContext` uses `openRecord` and `lookup`, like its two neighbours in
`findings.ts`. `countByReason` beside it keeps its plain literal and now says
why: `SkippedEndpoint["reason"]` is a closed union of four names this tool wrote
down, so there is nothing there for ADR-0024 to guard — and the comment names the
condition under which that stops being true.

One more site was found while looking: `resolveContextValues` in
`src/io/config/environment.ts` spelled out `Object.create(null)` by hand instead
of calling `openRecord`. Identical at runtime, and a second spelling of a rule is
how the eleven point fixes ADR-0024 counted came to disagree with each other.

### The related lookup asks for the whole cell

`relatedRequestOf` passes `check.resourceId` into `cellKey`. A pair is two
accounts asking for the **same object**, so the other side's cell differs from
this one in the account and in nothing else.

### What each of the three is proved by

This is the part worth carrying forward, and it is why the three are one record:

- The digest is proved by **running the command and reading the disk**
  (`tests/cli.test.ts`), on both channels the artifact leaves by — `--report` and
  stdout. A report assembled in the test process passes with the defect in place;
  that is exactly what happened for a day.
- The conditions record is proved with an id **the tool did not choose**, which is
  what the key space actually is, alongside an ordinary one so the two keys have
  to come out different.
- The related lookup is proved on a pair **that names an object**, with the other
  account observed on more than one cell — so that "found nothing" and "found the
  wrong cell" are separate failures and both are red without the fix.

## Alternatives

**Three ADRs.** Defensible: the three touch three files and three invariants, and
someone reading only about the cell key does not need the digest. Rejected
because the common cause is the finding. Filed separately, each reads as a slip;
filed together, they are a measurement of where this project's tests habitually
stand, and that is the thing that changes what gets written next.

**Recompute the digest in the CLI after setting `runId`.** Two lines, no change
to any signature, and it puts a second site that knows how the document is
sealed. The next field written on after the build — and there will be one — is
then a coin flip on whether whoever writes it remembers the recompute. The seal
belongs to the one function that finishes the document.

**Freeze the returned report so a later write throws.** `Object.freeze` would
have turned this defect into a crash on the first run rather than a quiet
`ok: false`, which is strictly better failure behaviour. Not done here: the type
is `readonly` throughout and a spread — which is what the CLI did — is not
blocked by freezing anyway, so it would have caught nothing in this case while
adding a runtime cost on a large document. Revisit if a caller is ever found
mutating a report in place.

**Validate the digest at the end of the run and refuse to exit 0.** The tool
would check its own artifact before reporting success. Attractive, and a
different decision from this one: it needs a policy for what happens when the
check fails after a walk that is already paid for in traffic, and the honest
answer is probably a warning rather than a refusal. Left for whoever wires
`--verify`, which ADR-0051 already deferred.

**Narrow the type of a condition's id so `__proto__` cannot be one.** It would
close this record and no other, and it would refuse a label an operator is
entitled to pick. ADR-0024's answer is the record, not the key.

## Consequences

`BuildReportOptions` gains an optional `runId`. Additive: every existing caller
compiles and gets the behaviour it had. `schemaVersion` stays `2` — nothing about
the shape of the report changed.

**Every report written before this change fails its own check**, and there is no
way to tell such a file from one that was edited. `checkContentDigest` on a
0.5.0 artifact answers `ok: false` with `declared` present, and that is now the
documented meaning of an artifact from that version rather than a mystery for
whoever runs the check first. `docs/report.md` says so.

`coverage.contextsProbed` gains a key on any run declaring a condition whose id
is one of the names a prototype carries. No existing polygon or example
configuration uses one; the 29 combinations of the reference platform produce the
same bytes as before.

A paired finding that names a resource now carries `relatedRequest` where it
carried none. Nothing in the registry produces one today, so no report changes;
the first object-level check of Module 2 is the caller this was fixed for.

**Revisit when** a fourth defect of this shape is found. Three is a class; four
would mean the class needs a mechanism rather than an ADR — most likely a rule
that a guarantee about an artifact is proved by a test that produces the artifact,
enforced somewhere a reviewer cannot forget it.

# 0064. A table written twice is made to agree

- **Status:** accepted
- **Date:** 2026-08-23

## Context

Six facts in this repository were written down in two places each. None of them
was a live defect: every copy agreed on the day this was written, and the tool
behaved correctly in all six cases.

That is the whole reason to open them. A copy that disagrees is a bug report; a
copy that agrees is a bug that has not been asked for yet. This project has the
history to say so — [ADR-0024](0024-strings-from-outside.md) was
written after eleven point fixes of one shape across four files, **two of which
had already drifted apart**, and [ADR-0032](0032-the-grammar-sits-at-the-seam.md)
after a rule written into three adapters turned out to have a fourth door with no
adapter on it.

The six:

1. `RESERVED_CHECK_IDS` in `src/core/checks/registry.ts` hand-listed the four
   members of `DiffKind` as `readonly string[]`. The compiler promised nothing:
   a fifth kind would not have been reserved, and the first thing that goes
   wrong then is a plugin registering under a matrix-kind name — its findings
   counted as privilege escalations and read by the exit code as such, which is
   the defect the constant exists against (audit of 14 August 2026, B-4).
2. `SEVERITY_ORDER` was exported from `src/core/defects.ts` and duplicated byte
   for byte, privately, in `src/cli/screen.ts`. `Record<Severity, number>`
   catches an added level in both copies at once — which is why nothing had gone
   wrong — and catches a **re-ranking** in neither.
3. The cost of a canary in requests was the literal `3`, twice, in
   `src/cli/preview.ts`, while the implementation is two passes plus one
   anonymous control request spread across `src/runner/canaries.ts` and
   `src/cli/canaries.ts`. The comment beside the literal names the cost of
   getting it wrong: a preview that undercounts calls a `--max-requests` ceiling
   sufficient that stops the second pass, and a run whose authentication is never
   confirmed a second time reads as clean.
4. The `YYYY-MM-DD` grammar existed three times as two different expressions:
   `accepted[].until` in the schema, `isCalendarDate` behind it, and
   `acceptanceExpiresAt` in the core.
5. The composite header rule — "forbidden if the exact map names it **or** if it
   starts with a forbidden prefix" — was copied expression for expression into
   `src/io/config/contexts.ts` and `src/io/config/basis.ts`, with the query-key
   composition and its refusal sentence copied alongside. The *lists* were
   already single-source; the *composition of the layers* was not.
6. `src/adapters/http.ts` sanitises a URL in two functions with two different
   rules, and the fix of 17 August 2026 — a path carries secrets too — reached
   only one of them. The junior one also wrote the `REDACTED` string out by hand.

## Decision

**Each of the six is made to hold by the strongest mechanism available to it, in
this order: the compiler, then a test, then a comment. Where the duplicate is
justified it stays, and the justification is written next to both copies.**

| # | fact | now held by |
| - | ---- | ----------- |
| 1 | the reserved check ids | the compiler: `Readonly<Record<DiffKind, true>>` |
| 2 | the severity ranks | the compiler: one exported table, imported |
| 3 | the cost of a canary | a test that counts the requests both passes issue |
| 4 | the date grammar | the compiler: one exported `RegExp` and one parser |
| 5 | the composition of the header layers | the compiler: one function, two callers |
| 6 | the two URL rules | a comment inside each, because they are two rules |

**1.** A mapped type over the union is the one spelling that fails in *both*
directions: a missing key does not compile, and a key that is not a `DiffKind`
does not compile either. `satisfies readonly DiffKind[]` on the array would have
held only the second half, which is the half that was never going to break. The
table is read through `Object.keys` and `.includes` rather than by indexing it
with an id from outside — indexing an object literal with a foreign string
answers for `constructor`, which is ADR-0024's rule, and the core may not import
the `lookup()` that normally settles it.

**3.** The number cannot be made a type, so it is made a sum of its two named
reasons — `CANARY_PASSES + CONTROL_REQUESTS_PER_ACCOUNT` — and then measured:
`tests/runner/canary-cost.test.ts` drives `probeBeforeWalk` and
`confirmAfterWalk` exactly as the run drives them, against a counting client, and
compares what went out with the constant the preview does its arithmetic with.
Arithmetic in a constant is still a claim about code in another file; the test is
what makes it true.

**4.** One `RegExp` and one parser in `src/core/calendar.ts`, off the `core`
barrel and so off the public surface, the same standing `src/core/order.ts` has.
The layering decides where it lives: the core may not import `src/io`, and
`acceptanceExpiresAt` is core, so the schema reaches down to it and nothing
reaches up. The expression keeps its shape without capture groups because it is
copied verbatim into `schema/barbican.run.schema.json`, which ships.

**6.** Two rules, kept. `sanitizeLocation` drops the path of a `location` header
because that address came from the platform and everything after the origin is
content nobody here has audited — that is where the 17 August fix belongs.
`safeUrl` keeps the path because that address is one the tool built out of its
own configuration, and the same address is already printed whole in
`observations[].url`; dropping it would make `failures[].reason` less useful than
the row beside it without keeping any secret out of the file. The reasoning is
inside each function rather than above it, so a reader comparing the two cannot
conclude that one was missed.

## Alternatives

**Leave them.** All six agreed. Rejected on the record of this repository: the
two ADRs cited above were both written after a duplicate that had agreed for
months stopped agreeing, and in both cases the failure was silent — a report that
said `match: true`.

**A test for each instead of a type.** A test is a second artifact that has to be
kept pointed at the right thing; a type is checked by every build, including a
consumer's. Where a type was available it was preferred. Where it was not — the
canary cost, which is an integer, and the schema's agreement with the core, which
crosses a layer — a test was written, and written against the *answers* rather
than against the spelling of the two expressions, so that rewriting either side
does not turn the guard into a formality.

**Make `acceptanceExpiresAt` tolerant of the schema's shape only.** It was: the
shape check and the calendar check were separate, and a day that does not exist —
`2026-11-31` — rolled over in `Date.UTC` into 1 December, so an acceptance
outlived the date the file named by a day. The schema refuses that string, but
the schema is one of two doors; a consumer of the library building an
`Acceptance` by hand comes through the other. It now reads as no deadline at all,
which is the direction that function already chose for everything else it cannot
read: `NaN` compares false, the acceptance lapses, the finding is reported again.

**Merge the two URL rules in `http.ts`.** Merging up to `sanitizeLocation`'s
strictness would blank the path in every transport-failure message while the same
path sits in `observations[].url` two fields away. Merging down to `safeUrl`'s
would re-open the password-reset link that adversarial review found on
17 August. They answer different questions about differently-sourced strings.

## Consequences

The compiler now refuses four edits it used to accept: a `DiffKind` added without
being reserved, a check id reserved that is not a `DiffKind`, a second severity
table, and a second date grammar in `src/io/config/schema.ts`. Two tests refuse a
fifth: a change to what a canary costs that does not reach the preview, and a
schema that admits a deadline the expiry arithmetic cannot read.

The cost is three indirections a reader has to follow — `screen.ts` to
`core/defects.ts`, `preview.ts` to `runner/canaries.ts`, `schema.ts` to
`core/calendar.ts` — and two imports that reach past a barrel on purpose. Both of
those are documented at the import, because a deep import with no reason beside
it reads as a mistake.

Revisit if a `DiffKind` is ever added that a check *should* be allowed to take as
its id — the mapped type would then be the wrong shape, and the right one is an
explicit list of exceptions beside it rather than a return to `string[]`.

One thing deliberately left: `assertAttributesKeepTheBasis` and the door in
`normalizeContexts` still ask the third layer — the check by value — separately,
because it depends on `--unsafe-methods` and the door's version does not run at
all. `WRITE_METHOD_WORDS` is its single source and the composition there is one
`has` call, so there is nothing yet to compose. If a second condition joins it,
it joins `forbiddenHeaderReason`'s neighbourhood and not both call sites.

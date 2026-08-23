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
| 2 | the severity ranks | the compiler for a level **added** to `Severity`; a source scan for a second table |
| 3 | the cost of a canary | one test counts what the two passes issue; a second compares the preview's bill with what a run of the same declaration sends, in the safe mode and under `--unsafe-methods` alike, and once more for a resumed run |
| 4 | the date grammar | one exported `RegExp`, plus a source scan for a second one and a comparison with the shipped schema |
| 5 | the composition of the header layers | the compiler for a copy that **borrows** the lists, which are module-private; a source scan for one that writes them out |
| 6 | the two URL rules | a comment inside each, because they are two rules |

Three of those cells said "the compiler" and named edits the compiler does not
refuse. Each was tried with a mutation before this table was rewritten; what was
tried and what happened is in **Corrections** at the foot of this document.

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

That test holds the **constant** to the implementation. It does not hold the
**preview's arithmetic** to either, and the first version of this ADR did not
tell the two apart: the preview multiplies, subtracts what `--resume` carries and
adds cells, and each of those steps is a second computation of the number the
walk then spends. `tests/cli/preview-bills-what-the-run-sends.test.ts` is the
link — one declaration, previewed and then walked against a counting client, with
the bill compared to the count. It runs on the reference polygon, where the two
numbers are 144 and 24, and on a hand-written declaration carrying an account
with a token and no canary: the polygon has none, and without one "accounts that
declare a canary" and "accounts that have credentials" are the same set, so a
preview billing either would agree with the walk.

**It ran one command line, and the command line is half of what a run sends.**
The first version of that file hardcoded the safe mode on both sides — no
`--unsafe-methods` on the flags it handed the preview, `allowUnsafeMethods:
false` written into the walk — so `flags.unsafeMethods === true` in
`src/cli/preview.ts` could be replaced by the literal `false` and the whole suite
stayed green. Adversarial review, 23 August 2026; the mutation and its output are
in the second **Corrections** section below.

That is the worst place in this tool for an undercount, which is why it is the
one that got closed rather than described. With `--unsafe-methods` the run
issues writes. The operator reads the bill, picks a `--max-requests` ceiling the
preview called sufficient, and the ceiling truncates a run that has already
changed objects on somebody else's deployment: a truncated read is a gap in a
report, a truncated write is a platform left half-modified. The polygon has one
write endpoint, `orders.cancel`, so the two modes are two different matrices —
144 cells and 180, with the same 24 canary requests — and each mode is now
previewed and walked on its own.

The other switches that move the traffic were looked at in the same pass, and
one more was in the same position. `--resume` subtracts the carried cells from
the bill and the walk skips them, which is two computations of one number like
the canary passes; it is covered now, with the carried records taken from a real
walk of the same declaration, because a hand-written record that fits no cell is
refused before the first request and would test the refusal instead. `--checks`
is not in that position and does not need to be: it selects what is compared once
a response is in hand, and neither side counts requests by it. A declared context
set was already covered — the polygon has two, and both halves read their
`endpointIds`.

The seventh copy of the same number was in shipped prose. `docs/guide.md`
printed `Cells a run would probe: 144, plus 8 canary requests` where the command
it quotes prints 24 — true when it was written, and read by exactly the person
deciding what `--max-requests` to allow on somebody else's deployment. A
transcript pasted into a document is a copy of program output that nothing
re-runs, so `tests/docs/dry-run-transcript.test.ts` re-measures the two
arithmetic lines of every such quotation in every tracked markdown file against
this polygon's own preview. Its header says what it leaves alone: the endpoint
rows, which the documents abridge and hand-align, and anything that is not
markdown.

It re-measured **one** of those two lines until the review of 23 August:
`Matrix rows:` was read only when it sat on the line immediately above the bill,
so the same line with a blank line under it was in no quotation at all and could
say anything. Both lines are anchors now. The listing of blocks that quote some
*other* declaration was keyed on the file as well, which is an exemption the size
of a document — a polygon transcript with wrong numbers pasted into
`docs/adr/0042-a-canary-the-run-will-not-send.md` was excused along with the one
the entry was written for, and the test that checks the exemptions are still in
use saw a file that still quoted something and said nothing. An entry names the
transcript it excuses now, so every other block in that file is measured.

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

**Leave them.** All six agreed. Rejected on the record of this repository, which
is short and already has two entries. [ADR-0024](0024-strings-from-outside.md)
was written after eleven point fixes of one shape across four files, **two of
which had already drifted apart** by the time anyone counted them.
[ADR-0032](0032-the-grammar-sits-at-the-seam.md) was written two days after the
rule it is about: the address grammar went into three adapters on 17 August 2026,
and on 19 August a fourth door with no adapter on it — `collectObservations`,
taking `Endpoint[]` straight from a consumer of the library — turned out to have
nothing between it and the wire.

Neither failure was a report that said `match: true`, and an earlier draft of
this paragraph said both were. ADR-0032's were a `..` that reached a different
endpoint past an exclusion list working on ids, and a `?_method=DELETE` that
performed a write with `--unsafe-methods` absent. The repository is twelve days
old; nothing in it has agreed for months.

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

The compiler now refuses three edits it used to accept, and each of the three
was tried:

- a `DiffKind` added to the union without being reserved (`TS2741`);
- a check id reserved that is not a `DiffKind` (`TS2353`);
- a second composition of the header layers that **imports** the two lists
  (`TS2724`, `TS2459`). They are module-private since this change, which is
  ADR-0059's move applied here: the raw material does not leave its module, so a
  copy has to write the decision out rather than borrow it.

It refuses neither a second severity table nor a second date grammar. Those, and
a header composition that writes the lists out by hand, are refused by
`tests/invariants/a-table-written-twice.test.ts` — a source scan with an exact
count per file in both directions, so that the owner losing its own copy fails as
loudly as a second one appearing.

**What that scan reads, it reads whole, and it did not at first.** The severity
probe was anchored on `:\s*\d`, which is three characters of a key that has more
shapes than three: `critical: +0 … info: +4`, and the same table with quoted
keys, both passed Biome, `tsc` and the run. The header probe read three
remembered members — `proxy-authorization`, `x-original-`, `x-http-method` — so a
second composition carrying six *other* members went through green. A scan keyed
on remembered strings answers about those strings. The severity probe now reads
the key with the spellings a formatter can produce from the plain one; the header
scan takes **every** member of both layers out of the owner's own source and
counts, per file, how many times one is written out — occurrences and not
distinct members, which is a later correction the test file's own header
records — case-folded, exact in both directions. A member added to `basis.ts` is
covered the moment it is added.

What that scan cannot see is listed in its header, and the list is longer than it
was: a table or a list **built** rather than written — `Object.fromEntries`, a
loop, a name assembled out of pieces or computed at run time — a grammar spelled
some other way, anything outside `src/`, a **re-ranking** of the one severity
table that is left, which nothing anywhere holds, and a second header composition
carrying no member of either list.
[ADR-0065](0065-what-a-source-scan-can-hold.md) is where what a scan of source
text can hold at all is stated, once, for every gate of this family.

Four tests hold what no type can: `tests/runner/canary-cost.test.ts` (a change to
what a canary costs that does not reach the constant),
`tests/cli/preview-bills-what-the-run-sends.test.ts` (a preview whose bill is not
what the run sends — in the safe mode, under `--unsafe-methods`, and for a
resumed run), `tests/docs/dry-run-transcript.test.ts` (a transcript in the
documentation that has stopped being the output of the command above it), and the
schema test that refuses a deadline the expiry arithmetic cannot read.

The cost is three indirections a reader has to follow — `screen.ts` to
`core/defects.ts`, `preview.ts` to `runner/canaries.ts`, `schema.ts` to
`core/calendar.ts` — and two imports that reach past a barrel on purpose. Both of
those are documented at the import, because a deep import with no reason beside
it reads as a mistake.

Revisit if a `DiffKind` is ever added that a check *should* be allowed to take as
its id — the mapped type would then be the wrong shape, and the right one is an
explicit list of exceptions beside it rather than a return to `string[]`.

One thing deliberately left: the third layer — the check by **value** — is asked
in three places rather than folded into `forbiddenHeaderReason`, because it
depends on `--unsafe-methods` and that function does not.
`assertAttributesKeepTheBasis` asks it at the seam; `assertContextsCannotWrite`
asks it of a context's **resolved** values, called from `src/cli/run.ts`, because
at parse time a value may still be `{ env: NAME }`; and `normalizeResources` in
`src/io/config/parse.ts` asks it of a resource's query. `normalizeContexts` — the
door — does not ask it at all, and an earlier draft of this paragraph and of
`forbiddenHeaderReason`'s own doc block said it did: `WRITE_METHOD_WORDS` does
not occur in `src/io/config/contexts.ts`. The set is still the single source of
the words, and the composition at each of the three sites is one `has` call, so
there is nothing yet to compose. If a second condition joins it, it joins
`forbiddenHeaderReason`'s neighbourhood and not three call sites.

## Corrections — the first pass

Every "the compiler now refuses …" sentence in the first version of this document
was tried with a mutation, under `npx tsc --noEmit` and `npx vitest run`. Three
were false, and this is what was done with each.

| claimed | mutation | before | now |
| ------- | -------- | ------ | --- |
| a second severity table does not compile | a private `Readonly<Record<Severity, number>>` with the same ranks, back in `src/cli/screen.ts` | compiled, suite green | the claim is narrowed to what the type holds — a level **added** to `Severity` — and a source scan refuses the second table. The scan then had to be corrected in turn; see the second pass below |
| a second date grammar in `src/io/config/schema.ts` does not compile | the literal `/^\d{4}-\d{2}-\d{2}$/` in place of the imported `CALENDAR_DATE` | compiled, suite green | the claim is replaced; the same scan refuses it, and the shipped `schema/barbican.run.schema.json` is compared with `CALENDAR_DATE.source` |
| the header layers are held by "the compiler: one function, two callers" | the composition re-inlined into `normalizeContexts`, importing both lists | compiled, suite green | the lists are module-private, so that mutation no longer compiles; a copy that writes them out is refused by the scan |

Two further sentences were false about history rather than about the compiler,
and are corrected above: that the two ADRs cited in **Context** followed
duplicates which "had agreed for months" and failed as a report saying
`match: true`, and that both callers of `forbiddenHeaderReason` ask
`WRITE_METHOD_WORDS` in the same breath as it.

The preview's own arithmetic was the fourth. This document said the cost of a
canary was held by "a test that counts the requests both passes issue" — true of
the constant, and nothing at all about the multiplication in `src/cli/preview.ts`
that spends it. `tests/cli/preview-bills-what-the-run-sends.test.ts` is that
link, and it is described under **3** above.

## Corrections — the second pass

The tests written in the first pass were then attacked, on 23 August 2026, and
five ways past them were found. Each is closed here, and each closure was
re-attacked with the mutation that had walked past its predecessor.

| what was claimed | the way past it | now |
| ---------------- | --------------- | --- |
| the preview's bill is compared with what the run sends | the link drove one command line: no `--unsafe-methods` on the flags, `allowUnsafeMethods: false` written into the walk. `allowUnsafeMethods: flags.unsafeMethods === true` in `src/cli/preview.ts` → `false`, whole suite green | both halves take a `RunMode`; the polygon is previewed and walked in each mode, and the walk reads the flag the way `src/cli/run.ts` does at the canary passes and at `collectObservations` |
| — (nothing claimed) | `--resume` was in the same position: the preview subtracts the carried cells and the walk skips them, and no test compared the two | a fourth case carries records from a real walk of the same declaration into a resumed one |
| a source scan refuses a second severity table | `critical: +0 … info: +4`, or the same keys quoted, passed `\b(?:critical\|…)\s*:\s*\d` | the probe reads an optional quote on each side of the key, an optional bracket for a computed key, and a sign on the number |
| a second header composition that writes the lists out is refused | it read three members. A second composition in `src/io/config/contexts.ts` carrying `authorization`, `cookie`, `host`, `x-method`, `x-rewrite-`, `x-forwarded-host` and a second `.find` was green through the whole run, `tsc` included | every member of both layers is parsed out of the owner's own source and counted per file, case-folded, exact in both directions |
| the two arithmetic lines of every quoted transcript are re-measured | `Matrix rows:` was read only when it sat immediately above the bill; with a blank line between them it was in no quotation at all | both lines are anchors, and a quotation runs from the first anchor of a code run to the end of that run |
| an exception names a transcript this run does not produce | `NOT_THE_POLYGON` excused a **file**, so a polygon transcript with wrong numbers pasted into ADR-0042 was excused with it — and "has no listed exception that no longer quotes one" saw a file that still quoted something | an entry names the block it excuses; every other block in that file is measured, and an entry matching no block fails |

Each mutation was applied by a harness that refuses to write anything when the
replacement does not apply the number of times asked for, and each was reversed
from a byte copy rather than with `git checkout --`. Shown once on a deliberately
wrong needle:

    REFUSED: the needle applies 0 time(s) in …/src/cli/preview.ts, 1 asked for.
    Nothing was written and nothing was run.

The two that matter, run against the work above, with the tree at 118 test files
and 1778 passing:

    FAIL  tests/cli/preview-bills-what-the-run-sends.test.ts > … > sends exactly what it promised with --unsafe-methods
    AssertionError: expected [ { method: 'GET', …(2) }, …(203) ] to have a length of 168 but got 204
    …
    Test Files  1 failed | 117 passed (118)
         Tests  3 failed | 1775 passed | 1 skipped (1779)

    FAIL  tests/invariants/a-table-written-twice.test.ts > the forbidden-header lists are written in one place > has no second composition, whichever members it carries
    AssertionError: expected { …(6) } to deeply equal { 'src/io/config/basis.ts': 20, …(4) }
    +   "src/io/config/contexts.ts": 6,
    …
    Test Files  1 failed | 117 passed (118)
         Tests  1 failed | 1777 passed | 1 skipped (1779)

### What is still open

Why this section exists, and why nothing goes into it that has not been run, is
[ADR-0065](0065-what-a-source-scan-can-hold.md)'s subject rather than this
document's.

- **The unsafe comparison is of totals, per mode.** It says the preview's number
  and the walk's demand agree; it says nothing about *which* cells were written,
  and nothing about the throttle, the retries or the `--max-requests` ceiling,
  none of which the preview models. Those are the polygon oracle's subject.
- **What the scans do not read.** A severity table built in a loop, a forbidden
  header assembled out of pieces, a transcript in something that is not markdown:
  none of them is read, and the header of each test file says so.
- **A second header composition written out of full header names.** The scan
  counts, per file, the occurrences of a member of either layer written as a
  string literal, and a member is the string the owner writes: `x-http-method`,
  `x-original-`, `x-forwarded-host`. A composition spelling those out in full —
  `["x-http-method-override"]`, `["x-method-override"]`, `["x-original-url"]`,
  `["x-rewrite-url"]`, `["x-forwarded-host-name"]` — contains no member with a
  quote on both sides of it, so the count for the file stays 0 and the file stays
  out of the table the assertion compares. Measured on 23 August 2026 in
  `src/io/config/contexts.ts`, with a real `.find(([p]) => lower.startsWith(p))`
  under it: 118 test files, 1795 passed, 1 skipped, `tsc --noEmit` at 0 and
  `pnpm exec biome check` clean on the file. The count per file was
  `{ credentials.ts: 6, http.ts: 3, basis.ts: 21, schema.ts: 1, sections.ts: 3 }`
  with the composition in the tree and without it. The second pass above changed
  this scan from three remembered members to every member of both layers, and
  from distinct members to occurrences; neither change reaches this shape,
  because the shape writes no member at all.
- **The exemption in the transcript gate is still a copy of a number.** It names
  the excused block word for word, so editing that block fails the test rather
  than passing silently — but the words themselves are re-derived by nobody.
  The transcript it names is asserted against the code in
  `tests/runner/unsafe-canary.test.ts`, which is what makes the copy affordable.
- **The endpoint rows of a quoted transcript are still not compared**, for the
  reason the test's header gives: the documents abridge and hand-align them.
- **`--checks` is argued about rather than measured.** It changes no request
  count in either half today; a check that issued a request of its own would
  make that argument false, and nothing would fail.

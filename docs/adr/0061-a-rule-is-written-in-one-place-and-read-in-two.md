# 0061. A rule is written in one place and read in two

- **Status:** accepted
- **Date:** 2026-08-23

## Context

ADR-0024 says a grammar for a string from outside is written once, and
`src/io/untrusted.ts` opens with the count that produced the rule: eleven point
fixes of one shape across four files, two of which had already drifted apart —
the same header-value rule written twice, the copies differing by one character.
The principle the file states is that **a duplicate the compiler cannot check
drifts apart sooner or later**.

A sweep of 22 August 2026 went looking for that shape in the places this
repository has grown since. It found three, and the first of them is inside the
file the rule was written in.

### The address grammar was written twice, seven lines apart

`isAddressablePath` returned the conjunction of five predicates. `pathTemplate`
re-listed the same five by hand as four `if` blocks, each with its own
`UnusablePathTemplateError` message.

The duplication was not gratuitous, which is why it survived: the boolean form
answers "is this addressable" for the seam, and the throwing form answers "which
rule refused, and why, in a sentence an operator can act on" for the door. Those
sentences are the most valuable text in the file — several were written from a
specific audit finding, and a generic "unusable path" in their place would cost
more than the duplication ever did.

What it cost instead is that the two lists could diverge, and the divergence is
not symmetric:

- a sixth rule added to `pathTemplate` alone never reaches `joinUrl`.
  `isAddressablePath` is the seam ADR-0032 moved the grammar to precisely because
  `pathTemplate` is called by three adapters and the fourth door — a consumer of
  the library handing `Endpoint[]` straight to `collectObservations` — has no
  adapter on it. A rule that reaches only the three doors is a rule the library
  door does not have;
- a sixth added to `isAddressablePath` alone refuses a document with no sentence
  saying which line of it to fix.

This has happened. The comment above the third `if` records it: that branch read
`value` where the three around it read `decoded`, for the first half-hour of its
life, and `%2f%2fhost/x` threw nothing while `isUsablePathTemplate` — one
function above, over the same string — answered false.

### The refusal of a scheme-relative path was written three times

`//api.test/v1/x` is an address, not a path: `joinUrl` strips the leading
slashes, so it arrives as `/v1/api.test/v1/x` — a request the endpoint does not
name, reported as if it were the one it does. `isAddress` in the grammar refuses
it, under a comment saying "One rule, in the grammar" and noting that the
endpoint list and the Postman parser had each refused it in their own way
before.

Both of those copies were still in the tree. Worse, one of them was **dead**:
`normalizePath` in `src/adapters/postman.ts` checked `converted.startsWith("//")`
where `converted` is what `pathTemplate` returned, and `pathTemplate` throws for
exactly that input. The comment above it said the check kept the scope from being
widened by a notation, so it read as load-bearing to anyone who met it. v8 had it
at zero hits across the whole suite, and the parser's own test had been changed
on 19 August to expect the grammar's wording instead of this one's.

The endpoint list's copy is not dead: it runs *before* `pathTemplate` and is what
answers there.

### Two sets that must agree, agreeing by inspection

**Terminal errors.** `TERMINAL_ERROR_NAMES` in `src/runner/outcome.ts` and
`TERMINAL_FAILURES` in `src/cli/canaries.ts` held the same two members under two
names in two layers, and a third reading of the same fact sits in
`src/adapters/http.ts` as `cause instanceof RunBudgetExhaustedError || cause
instanceof CircuitOpenError`. A fourth terminal error added to the runner's set
alone makes `terminalCause` mark the walk `truncated` while the canary summary
calls the same refusal a dead platform and sends the reader after a port that is
up; added to the CLI's alone, the walk records its own ceiling as an ordinary
transport failure and the report comes back complete over a tail nobody probed.

**The `not-found` statuses.** `classifyStatus` folds 404 and 410 into
`"not-found"`. `src/runner/walk.ts` re-wrote `status === 404 || status === 410`
by hand in the self-inflicted-404 guard — in a file that already imports and
calls `classifyStatus`. ADR-0046 moved this list once already, by hand, when 410
joined 404, and the comment beside the guard records that it had to be moved
here too. The next status added to the classifier and not to the guard means a
404 the run caused with its own `DELETE` is no longer recognised as
self-inflicted: it folds into a denial, agrees with a policy of denial, and the
run reports "tested and agreed" about a protection it manufactured itself. That
is the L-7 false negative, and the polygon is blind to it by construction.

## Decision

**One place states each of the three; everything else derives from it, and a test
goes red when a member is added to one side and not the other.**

### The grammar is a table of (predicate, sentence)

`ADDRESS_RULES` in `src/io/untrusted.ts` holds one entry per rule: an `id`, a
`refuses` predicate, and a `because` that returns the sentence following
`The endpoint path "…"`. `isAddressablePath` reduces over the table;
`pathTemplate` finds the first entry that refuses and throws its sentence. No
message was reworded and no predicate changed, so the order of the entries is the
order the `if` blocks were in — which is behaviour, because it decides which
sentence a path breaking two rules at once gets.

Behaviour, and held as behaviour — but not by the first version of this gate. See
the first amendment of 23 August 2026 below: every witness in the witness list breaks
exactly one rule, which is the property that makes "which rule fired" readable
from outside the module and also the property that made permuting the table
invisible to all of them.

`because` is handed the string as the document spelled it rather than the decoded
one, because one rule's advice differs between a backslash that is in the file
and a `%5c` the platform will turn into one.

The table is **not exported**: `src/index.ts` does `export * from` on this
module, so a new export here is a new promise in the published surface. The gate
reads the ids out of the source instead, the way
`tests/invariants/transport.test.ts` reads the response-header allowlist out of
`http.ts`.

### The dead copy goes; the live one stays and says why

The Postman copy is removed, with the reason it was unreachable written where it
stood — `pathTemplate` returns its argument unchanged and throws when the decoded
form is an address, and decoding replaces `%2e`, `%2f` and `%5c` with one
character each without deleting anything, so a string starting with `//` still
does and never comes back from that call.

The endpoint list's copy **stays**. It is reachable, it answers first, and it
answers about the entry rather than about the template. It is a strict subset of
the grammar's `address` rule and cannot go stale into permitting anything: if it
stopped firing, the `pathTemplate` call eleven lines below would refuse the same
string with the grammar's own wording.

One sentence stood here in the first version of this ADR — "The gate holds it to
that subset, and to being the only file in the tree that words the refusal" — and
both of its claims were false when written: the gate checked one string, and it
read five file names of the sixty-five in the tree. What holds them now is
described in the two amendments of 23 August 2026 below.

### `TERMINAL_ERROR_NAMES` is exported and the CLI imports it

From `src/runner/outcome.ts`, where `terminalCause` reads it, and directly from
that module rather than through `src/runner.ts` — the barrel is what
`src/index.ts` re-exports whole, and this is an agreement between two layers, not
a promise to a consumer.

`src/adapters/http.ts` keeps its `instanceof` pair. An adapter sits below the
runner and must not import from it, and where the classes are in hand
`instanceof` is the stronger test — a foreign error that happens to be named
`CircuitOpenError` should not stop the client's own retry loop. The agreement
between the pair and the set is therefore held by the gate, which parses the
class identifiers out of the retry guard, constructs one of each, and compares
the resulting names to the set in both directions.

### The self-inflicted guard asks `classifyStatus`

`classifyStatus(status) === "not-found" && changed.has(objectKey)`. The guard was
never about the two numbers; it is about the classification, because it is the
fold into a denial that turns a 404 we caused into evidence we did not gather.

## Alternatives

**Leave the grammar as two lists and add a test comparing them.** A test can
compare two lists only over inputs it thinks of. The failure mode here is a rule
nobody thought of yet, which is exactly what such a test cannot enumerate.

**Collapse the two entry points into one that always throws, and catch.** It
would remove the duplication and cost the seam: `joinUrl` asks a boolean per
request, and `isUsablePathTemplate` is read by the core, where a throw is not
what a predicate is for. Exceptions as control flow inside the hot path of a walk
is also a change nobody asked for.

**One generic message for the whole grammar.** The duplication disappears and so
does the most useful text in the file. Refused explicitly: the brief for this
work named those sentences as the thing not to lose.

**Remove the endpoint list's copy too.** It is reachable, so removing it changes
which sentence an operator gets for `//host/x` in an endpoint list, and
`tests/adapters/endpoint-list.test.ts` pins that sentence. Behaviour was to stay
identical; a copy that is live, correct, first, and a proven subset is not the
defect this ADR is about.

**Move `TERMINAL_ERROR_NAMES` down to `src/adapters/ports.ts` so the client can
import it too.** That would make all three readings one, and would replace the
client's `instanceof` with a name comparison — weakening the one check that has
the classes in hand, and adding a name to the published surface for it.

**Have `walk.ts` import a `NOT_FOUND_STATUSES` set.** A second name for what
`classifyStatus` already answers. The guard's question is "does this fold into a
denial", and the function that folds it is the honest thing to ask.

## Consequences

- A rule can no longer be added to one half of the address grammar. The table is
  the only place a predicate and a sentence exist, and
  `tests/invariants/written-once.test.ts` demands a witness per rule, refused by
  both entry points, with that rule's sentence. "A rule" means an entry with an
  `id` that is a literal this gate can read, quoted or bare, and the count of
  entries is structural; the two amendments below say what that does and does not
  reach.
- `src/adapters/postman.ts` loses a branch v8 never reached; its statement
  coverage goes up rather than down.
- `src/cli/canaries.ts` imports one submodule of the runner directly. That is a
  deviation from the barrel every other CLI module goes through, and the comment
  at the import says why it is preferred to a second copy of the set.
- Nothing a consumer can observe changes: no message, no exit code, no report
  field. The exported names and their count are unchanged — the two new exports
  are `TERMINAL_ERROR_NAMES`, from a module the barrel re-exports by name, and
  nothing at all from `src/io/untrusted.ts`.
- A fourth terminal error now costs three edits — the class, the set, and the
  client's retry guard — and the gate names the one that was forgotten.
- A third `not-found` status now costs two: the classifier, and the list spelled
  out in the gate, which is where the decision is made visible.

## First amendment, 23 August 2026: the gate was walked around

Adversarial review the same day this ADR was accepted went at the gate rather
than at the code. Four of its assertions were walked around with `pnpm run check`
green, and a fifth claim — that the order of `ADDRESS_RULES` is behaviour — turned
out to have no assertion behind it at all.

One sentence of this ADR carried two false claims; it is quoted where it stood,
under "The dead copy goes; the live one stays and says why", and answered below.
The test file's header carried a third, "a rule added to the table without being
thought about is a red test". Writing this amendment turned up a sixth way in
that the review had not tried — a whole array spread into the table — and it is
closed with the rest.

Nothing in `src/` behaved differently before or after this amendment; what
changed is the gate, and what this document and that header claim about it.

### The two assertions read a hardcoded list of files

`is worded in exactly one adapter` filtered a list of **5** file names written
into the test by hand. `is spelled where the class is defined and in the set,
nowhere else` filtered a list of **15**. `git ls-files src` returns **65**
TypeScript files.

So 60 files went unread by the shorter list and 50 by the longer one. Among them
were `src/cli/stream.ts`, `src/runner/stream.ts`, `src/report/findings.ts`,
`src/runner/plan.ts` and `src/cli.ts` — the plausible carriers, not the
implausible ones. Demonstrated: the sentence "addresses another host" placed in
`src/runner/walk.ts` — green; a second
`new Set(["RunBudgetExhaustedError", "CircuitOpenError"])` placed in
`src/runner/stream.ts` — green.

Both now read every tracked file under `src/`, from `git ls-files`, the way
`tests/docs/language.test.ts` does and for the reason it gives: `.gitignore`
already answers "does this go public", and walking the disk from a test would
descend into `.claude/worktrees/`. A gate that reads a list somebody has to
remember to update is the defect this ADR is about, one layer up.

This is what makes the second struck sentence true, in a narrower form than it
was written: the endpoint list is the only file **under `src/`** that carries
that substring. `tests/`, `polygon/` and `tools/` are out of scope, and the tool
does not read a refusal from any of them.

### A one-line entry in the table has no id, as far as the gate is concerned

The ids came out of the source with `/^\s*id: "([^"]+)",$/gm`, which needs `id`
on a line of its own. Biome at `lineWidth: 100` leaves a short entry exactly as
it was written, so

```ts
{ id: "bang", refuses: (p) => p.includes("!"), because: () => "carries a bang" },
```

appended to `ADDRESS_RULES` was a fifth rule with no id the gate could see, no
witness demanded, and a green suite. "A rule added to the table without being
thought about is a red test" was therefore false for the shape a person in a
hurry actually writes.

Three things hold it now. The id regex no longer anchors to a line. The count of
ids is compared to the count of `refuses` keys, so an entry whose id is a
constant or a template literal fails loudly instead of passing unnamed. And a
spread — `...MORE_RULES` — is refused outright rather than followed: entries this
gate cannot count are entries no witness is demanded for, and following one would
mean parsing the module.

### The order was declared to be behaviour and nothing held it

Every witness breaks exactly one rule. That is deliberate — distinct sentences
are what make "which rule fired" observable from outside a module that exports
neither the table nor the predicates — and it is exactly why permuting the table
changed nothing any witness could see. Moving `navigates` above `address` was
green, while changing the sentence `//api.test/v1/../danger` is answered with.

Held now by a pair of paths per adjacent pair of entries, and the pairs must
cover every adjacent pair of the table:

| earlier                   | later                     | breaks both             | later alone            |
| ------------------------- | ------------------------- | ----------------------- | ---------------------- |
| `query-or-fragment`       | `unaddressable-character` | `/v1\reports?_method=…` | `/v1\reports`          |
| `unaddressable-character` | `address`                 | `//api.test/v1\danger`  | `//api.test/v1/danger` |
| `address`                 | `navigates`               | `//api.test/v1/../…`    | `/v1/../danger`        |

The second path is the first with the earlier rule's trigger taken out, and it
must be answered with the *later* rule's sentence. That is what makes the first
path a path which really does break two rules, rather than one the test believes
breaks two — an assertion about precedence that never checks the later rule fires
at all would pass over a table with the later rule deleted.

### The live copy in the endpoint list was held by one string

`agrees with the grammar at the endpoint list` fed one path,
`//evil.test/v1/users`, and asserted the copy still refuses it. That proves the
copy fires. It says nothing about how far it reaches, which is the whole of the
subset claim: widening the condition to
`path.startsWith("//") || path.includes("@")` left the gate green while the copy
turned away `/v1/u@example.com/orders`, which the grammar admits.

Held two ways now, and the first is the strong one:

- **as source text.** The condition is extracted from `endpoint-list.ts` and must
  be one of the disjuncts of `isAddress`, character for character, modulo the one
  rename `path` → `value`. Any edit to that condition is red, including a
  behaviourally identical one. That is the cost of the strength and it is the
  right way round here: this block's entire justification is that it says nothing
  the grammar does not;
- **as behaviour, over a corpus.** For every path in a corpus, if the endpoint
  list refuses it then `isUsablePathTemplate` must refuse it too. One-way on
  purpose — the grammar refuses far more than the copy does, and the copy is not
  meant to have an opinion about a query string or a `..`. The corpus is a
  corpus; it is there because the source-text half cannot see a widening made
  inside `isAddress` and mirrored here, and this half can. As the first amendment
  left it, this half asked only about the refusals worded the way *this* copy
  words them, which is a population selected by the thing on trial; the second
  amendment below is where that was found and changed.

### Limits, as the first amendment left them

Attacked before being trusted, per the rule in CLAUDE.md. These got through the
first round and were left open, with the reason. Two of them turned out to be
understatements — the second amendment below says which, and its own limits
section is the current one:

- **A copy that words the refusal differently.** "points at another host" in a
  second file is green. Both file-scanning assertions match an exact substring,
  and the alternative — a list of paraphrases — is the hardcoded list again in
  another spelling. The same applies to a class name assembled at runtime:
  `"Circuit" + "OpenError"` is a copy this cannot see.
- **A disjunct added inside an existing predicate.** `isAddress` growing
  `|| value.includes("@")` is green: it changes what the grammar refuses without
  adding an entry to the table, so no witness is demanded and no sentence is
  reviewed. Left open deliberately — the direction is strictness, and a disjunct
  *removed* is caught, because the witness for that rule stops being refused.
  What is not caught is a widening nobody wrote a sentence for.
- **Scope is `src/`.** A refusal worded in `tools/`, `polygon/` or `tests/` is
  invisible to these two assertions. Nothing under those paths is on the path a
  request takes, which is why the scope is where it is rather than everywhere.
- **The order is held, not justified.** The pairs make a permutation red. Nothing
  here says the current order is the right one; it is the order the `if` blocks
  were in, preserved because behaviour was to stay identical.
- **The source-reading halves are regexes over text, not a parse.** Each is
  written to fail closed — a shape it cannot read fails the assertion that finds
  it rather than returning an empty list — and `declared()`, `retried()` and the
  endpoint-list extraction each carry that guard-on-the-guard. A rewrite that
  happens to still match while meaning something else is not covered.

## Second amendment, 23 August 2026: the seam could decide something of its own

A second adversarial review, the same day and against the amended tree, went at
the address half of the gate again. Four walk-arounds across three of its
assertions were demonstrated with `pnpm run check` green, and two more against
the sibling gate for the `{name}` grammar, which the amendment of 23 August 2026
on ADR-0060 answers.

Three places were wrong about them, in the two ways this repository keeps
finding — a sentence that claims more than the check under it, and a limits list
presented as complete:

- the gate's own doc comment said "**And neither entry point decides anything of
  its own**" over an assertion that held neither of them to it. The heading below
  is that sentence.
- `README.md` said "**That gate could be walked around, and the ways in are
  closed**". Two doors were open when that was written. It now says four of the
  ways in are closed and carries the second round beside the first.
- the "Limits" section of the first amendment above is presented as the result of
  attacking the gate before trusting it, and it named none of the four. One of
  its bullets came close — "a copy that words the refusal differently … is green"
  — and was true of the two assertions it was written about, the ones that scan
  files for a substring. What nobody noticed is that the same copy also walked
  past the corpus assertion one screen below, whose *name* promises it does not.
  A limit written about one assertion does not cover another that claims the
  opposite.

The four are closed; what is not closed is written under "Limits" at the end of
this amendment, and that list — not the one in the first — is the current one.

Nothing in `src/` behaves differently before or after this amendment.

### "And neither entry point decides anything of its own" was false of both

The assertion under that sentence was two substring checks: the seam contains
`ADDRESS_RULES.every` and does not contain `&&` — the shape of the conjunction
the table replaced — and the door contains `ADDRESS_RULES.find` and words a
refusal once. A conjunction is not the only way to reach a verdict without
asking the table:

```ts
export function isAddressablePath(value: string): boolean {
  return value.startsWith("/internal") ? true : ADDRESS_RULES.every((rule) => !rule.refuses(value));
}
```

is green, and so is `if (value.startsWith("/internal")) return value;` written
above the `find` in `pathTemplate`. Each is a back door into `joinUrl`, which is
the one place an address is built and the only grammar between a consumer of the
library and the wire (ADR-0032). A gate that names the spellings it refuses is
the wrong shape here: the list of spellings has no end.

The other direction does. The three exported functions of this grammar —
`isAddressablePath`, `isUsablePathTemplate` and `pathTemplate` — are six
statements between them, they have not changed behaviour since they were written,
and there is exactly one text each of them is allowed to be. So the text is what
the gate holds — comments stripped, whitespace flattened, compared for equality.
Every edit is red, including a behaviourally identical one, which is the same
trade the endpoint list's disjunct already makes one assertion further down and
for the same reason: a body that may say only this cannot reach a verdict the
table did not give it.

The third was not in the review's findings and is pinned with the other two: a
carve-out in `isUsablePathTemplate` passes every witness in the list, because a
witness only asks that the function refuses the paths it is handed, and that
function is in the published surface — a consumer guarding with it would be told
a path is usable by the same tool that would refuse it at the wire.

It stops at the three. The four predicates the table names, and the `decodePathish`
the door runs before consulting them, are a longer text that is legitimately
edited — three times in the week before this was written — and a pinned blob that
large is regenerated rather than read, which is a gate that costs and holds
nothing. A back door written inside a predicate is therefore open; it is the first
entry under "Limits".

### The endpoint list's corpus was selected by the wording it was judging

`turns away nothing at the endpoint list that the grammar would admit` asked the
grammar only about the refusals whose message contained `addresses another host`.
So a second, differently worded `if` in the same file was outside the population
the test drew from:

```ts
if (path.includes("@")) {
  throw new InvalidEndpointError(index, "path", `path "${path}" points at another host`);
}
```

turns away `/v1/u@example.com/orders`, which `isUsablePathTemplate` admits, with
the whole suite green and the test's name saying otherwise. This is the same
defect as the link gate that collected its population on `[ADR-NNNN]` — a
condition on the very thing being judged — and one document later.

**The decision is that the adapter must not refuse what the grammar admits.** Two
doors that disagree about one string is what ADR-0032 is about, and this door has
no seam under it: whatever it turns away, nothing downstream is ever asked. So
the population is now every refusal of the entry, whatever words it uses, and the
corpus is grown with the shapes a widened copy would plausibly reach for. The
corpus is paths and only paths — the adapter's rules about the shape of an
*entry*, that an id is not empty and that a path starts with a slash, are not
what this holds, because they are not about the address.

### An entry the gate cannot name is now an entry it can count

A fifth rule spelled with quoted keys —
`{ "id": "bang", "refuses": …, "because": … }` — was read as no keys at all by
regexes looking for a bare `id:` and a bare `refuses:`. Both counts came back
zero together, so the count-against-count guard the first amendment added had
nothing to say. What actually stopped that entry from reaching a commit was
Biome's `quoteProperties: asNeeded`, which unquotes the key on format. That is
the formatter holding a security invariant, and a gate credited with what the
formatter holds is exactly the pairing this repository keeps finding.

Two changes. The id regex reads a quoted key as well as a bare one. And the
number of entries is counted as **structure** — one brace at the top level of the
table is one rule, whatever its keys are called — so
`{ ["id"]: "bang", ["refuses"]: … }`, which no key regex reads either, is five
entries against four readable ids and a red test. The compiler is what guarantees
an entry has the three fields; the gate's question is only how many entries there
are and which of them it can name.

### What was run

Twelve mutations, each applied by a harness that refuses to run when a
replacement does not land exactly as many times as declared — shown once against
a deliberately wrong needle, which printed
`REFUSED: the needle applies 0 time(s) in src/io/untrusted.ts, 1 intended` and
ran nothing — and each restored from a byte copy whose SHA-256 was compared after
the restore. "Green before" means the whole gate file passed with the mutation in
the tree; the two rows marked "green before, run afterwards" were not in the
review's list and were run against the previous revision of the gate on purpose,
rather than being asserted from the shape of the code.

| mutation | before this amendment | caught after it by |
| --- | --- | --- |
| a ternary in `isAddressablePath` | green | the pinned seam text |
| an early `return` in `pathTemplate` | green | the pinned door text |
| a carve-out in `isUsablePathTemplate` | green, run afterwards | the pinned text of the boolean door |
| a second, differently worded refusal in the endpoint list | green | the corpus, over every refusal |
| a fifth rule with quoted keys | green | the id regex, and the witness list |
| a fifth rule with computed keys | green, run afterwards | the structural entry count |
| a brace written `\u007b` in a fourth copy of the `{name}` grammar | green | the brace table (ADR-0060) |
| `const Expression = RegExp` and `new Expression(…)` | green | the mention table (ADR-0060) |
| `refuses: (path) => isAddress(path) && !path.startsWith("/internal")` | green | **nothing. Not caught.** 118 files, 1776 passed, 1 skipped |
| the backslash removed from the address grammar | — | 8 tests in 3 files |
| `joinUrl` no longer asking `isAddressablePath` | — | 4 tests in 3 files, one of them the query string handed straight to `collectObservations` |
| `navigates` returning false | — | 6 tests in 2 files |

The ninth row is the standing limit, run rather than reasoned about: an
exemption written into an entry of the table passes the whole suite, before this
amendment and after it. It is the first bullet under "Limits" below.

The last three are the invariant itself rather than the gate, and they are here
because a gate can be strengthened until it holds only itself: `pnpm run check`
was green for each of the first eight before this amendment, and the tool would
still have refused a backslash, a `..` and a query string at the wire.

### Limits: what this gate does not catch

The current list. It supersedes the one in the first amendment, which stands
above as the record of that round.

- **A back door written inside a predicate.** Measured, not reasoned about:
  `refuses: (path) => isAddress(path) && !path.startsWith("/internal")` in the
  table's third entry passes **the whole suite** — 118 files, 1776 passed, 1
  skipped. Every witness stays refused, because each breaks exactly one rule and
  none of them starts with `/internal`, while the grammar admits a path it used
  to refuse. The same goes for the same conjunct written inside `isAddress`
  itself, and for `decodePathish`, which the door calls before it consults the
  table. The three entry points are pinned; the four predicates and the decoding
  are not, and pinning those is the blob nobody reads. This is the widest thing
  on this list.
- **A widening with no rule added.** The first amendment's version of this entry
  said `|| value.includes("@")` inside `isAddress` is green and called the
  direction "strictness". Half right: a *disjunct* added is strictness, and a
  *conjunct* added is the entry above. Both are invisible for the same reason —
  no entry in the table, so no witness demanded and no sentence reviewed.
- **A copy that words the refusal differently.** Both file-scanning assertions
  match an exact substring, so "points at another host" in a second file is still
  invisible to *them*. What is no longer invisible is that copy's effect at the
  endpoint list, which the corpus now reads. A class name assembled at runtime,
  `"Circuit" + "OpenError"`, is unchanged and uncaught.
- **The corpus is a corpus.** The endpoint list is held to admitting the paths in
  it. A refusal of some shape nobody wrote down is not caught.
- **Scope is `src/`.** A refusal worded in `tools/`, `polygon/` or `tests/` is
  invisible to the two file-scanning assertions. Nothing under those paths is on
  the path a request takes.
- **The order is held, not justified.** Unchanged from the first amendment: the
  pairs make a permutation red, and nothing here says the current order is the
  right one.
- **The source-reading halves are text, not a parse.** The comment stripper the
  pinned bodies go through is two regular expressions; a `//` inside a string in
  either body would cut the text short, which fails the comparison rather than
  passing it. The direction is deliberate and it is the only guarantee offered.
- **And a scan of source text is not a sandbox.** It catches what a person writes
  by accident or for convenience. Someone writing in order to defeat it has the
  whole language, and this document names the ways in that are known rather than
  claiming there are none.

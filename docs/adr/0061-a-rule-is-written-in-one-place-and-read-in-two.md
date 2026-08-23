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
the amendment of 23 August 2026 below: every witness in the witness list breaks
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
described in the amendment of 23 August 2026 below.

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
  `id` that is a double-quoted literal and a `refuses` key; the amendment below
  says what that does and does not reach.
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

## Amendment, 23 August 2026: the gate was walked around

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
  list refuses it with this sentence then `isUsablePathTemplate` must refuse it
  too. One-way on purpose — the grammar refuses far more than the copy does, and
  the copy is not meant to have an opinion about a query string or a `..`. The
  corpus is a corpus; it is there because the source-text half cannot see a
  widening made inside `isAddress` and mirrored here, and this half can.

### Limits: what this gate does not catch

Attacked before being trusted, per the rule in CLAUDE.md. These got through and
are left open, with the reason:

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

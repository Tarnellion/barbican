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
string with the grammar's own wording. The gate holds it to that subset, and to
being the only file in the tree that words the refusal.

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
  both entry points, with that rule's sentence.
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

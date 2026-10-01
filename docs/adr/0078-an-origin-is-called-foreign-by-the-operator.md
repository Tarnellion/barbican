# 0078. An origin is called foreign by the operator, so a reflection can be judged

- **Status:** accepted
- **Date:** 2026-10-01

## Context

[ADR-0076](0076-a-permissive-cross-origin-policy-is-a-registered-check.md) left the
common and more dangerous cross-origin defect out of `permissive-cors`: a platform
that copies the `Origin` it was sent into `Access-Control-Allow-Origin` and allows
credentials. It named two reasons, and they are different reasons.

- **The response alone does not settle it.** An echoed `https://app.example.com`
  with credentials is one string in one header, and it is exactly what a platform
  that trusts that origin on purpose sends. Reporting it would be a guess, and
  this tool does not guess about access.
- **The core does not carry the origin that was sent.** An observation holds the
  response. A request condition is a `contextId` label in the core and its
  attributes live in the adapters ([ADR-0019](0019-request-contexts.md)).

[ADR-0077](0077-what-a-check-may-be-admitted-to-find.md) gave the rule such a
case is held to: a check's verdict is conclusive from the response alone, **or it
says it cannot be**. Reflection was its worked example of the second half.

Closing the gap needs one fact the tool cannot find out for itself, which is
*which origin the platform must not trust*. A partner's origin and an attacker's
look the same on the wire; they differ only in what the platform's owner intends.
That is not a new kind of problem in this repository. It is the premise of
[ADR-0006](0006-expected-access-declaration.md): **the expectation is declared by
a human and never derived**, because deriving it from the thing under test is
comparing an implementation against itself. An expected-access rule says who must
not reach an endpoint. This says which origin must not be trusted with credentials.

## Decision

**A context may mark the `origin` it sends as foreign.**

```yaml
contexts:
  - id: foreign-origin
    description: a request from a page the platform has no reason to trust
    headers: { origin: "https://attacker.example" }
    originIsForeign: true
    endpoints: [orders.list]
```

**It is a marker and not a second place to write an origin.** The value sent is
still `headers.origin`, so what went over the wire and what was called foreign
cannot be two different strings. A field that took the origin itself and set the
header would have been one more way to write a header, with its own rule for what
happens when `headers` also names it.

**It is refused at startup unless it marks something the check can compare.**

- There is no `origin` header to mark.
- The `origin` comes from the environment (`{ env: NAME }`). The report has to say
  which origin was called foreign, and a value that lives only in a variable
  cannot be said.
- The value is not an origin **in the form a browser sends it**. The rule is that
  the string equals its own serialization (`isWebOrigin` in `src/io/untrusted.ts`,
  asked of the platform's own `URL`): a trailing slash, an upper-case host, the
  default port written out, a path or credentials are all refused. The check
  compares the declared origin byte for byte with what the platform echoed, and a
  near-miss would still match a platform that reflects whatever it receives, while
  the finding claimed a browser at that origin had been shared with. Nothing is
  normalised toward the right form; modelling somebody else's parser is how the
  first version of the address grammar was wrong ([ADR-0032](0032-the-grammar-sits-at-the-seam.md)).
  `null` is refused as well: the check already reports an echo of it whatever was
  asked.

**It reaches the check as data, at registration.** `normalizeContexts` resolves the
marker to the origin and carries it as `foreignOrigin` on the parsed context, once,
so nothing downstream re-reads a header to learn which origin was called foreign.
`src/cli/run.ts` hands the check a map from context id to that origin, the way
`identical-response-across-tenants` is handed its digest signal. The core types do
not change: a check learns only that context X was declared to send origin O, which
is a declared fact and not a piece of HTTP.

**The verdict.** For a cell under a context declared foreign, an
`Access-Control-Allow-Origin` equal to the declared origin with
`Access-Control-Allow-Credentials: true` is a finding of **high** severity, with
`foreignOriginDeclared: true` in its evidence. `*` and `null` are settled first, so
a wildcard under a foreign context is one finding and not two. It is silent for
the same echo under any other context, for a different origin than the declared
one (an allowlist that was sent the foreign origin and answered with its own), and
without credentials.

**The report says it was asked.** `coverage.byCheck` gains `foreignOriginCellsAnswered`
for `permissive-cors`: how many cells under a context declared foreign got an
answer, a probe that failed excluded. An endpoint with the counter above zero and
no finding was asked whether it trusts the declared origin and said it does not,
which an endpoint without the counter was never asked. The counter is absent when
no origin was declared foreign, as `skippedDifferentContextPairs` is absent when no
conditions are declared: a zero would claim a question was put. The parsed context
is published as `inputs.contexts[].foreignOrigin`, because "declared foreign" is a
marking and a reader of a saved report never saw the declaration.

## Alternatives

- **Carry the sent origin on every observation and decide what is foreign by rule.**
  Rejected. Carrying it removes the second reason above and leaves the first: an
  echo is still an echo, and a rule for what counts as foreign — anything but the
  target's own host? — calls a partner an attacker. That is the derivation
  ADR-0006 refuses.
- **Send two different origins and call it a reflection when both come back.** This
  one is a better argument than it first looks, and it is **not** rejected on the
  merits. An allowlist cannot echo two origins nobody put on it, so the comparison
  is conclusive with no human judgement about which origin is foreign. It is not
  chosen because it needs the sent origin in the matrix, which is a change to the
  core's types and to the observation, where this needs neither; and because it
  answers a narrower question, whether the platform reflects, and not whether it
  trusts the one origin the operator cares about. The two are not exclusive. If it
  is built, it supplies the same finding with evidence that does not rest on a
  declaration.
- **A field that takes the origin and sets the header.** Rejected above: a second
  way to write a header, and a rule for the collision.
- **Accept an origin from the environment.** Rejected above: the report could not
  say what was marked.
- **Correct a near-miss origin instead of refusing it.** Rejected above, for the
  reason ADR-0032 gives about every other grammar here.
- **Refuse a foreign origin equal to the target's own.** Not done. It would take the
  address of the target into `normalizeContexts`, which does not have it, to catch
  a mistake the operator is in a better position to see. The guide says it
  instead: an origin the platform is meant to trust is not foreign.

## Consequences

- The largest limit ADR-0076 wrote down is closed **under a declaration**: a
  platform that trusts the origin the operator said it must not is now a finding,
  where before it was a clean run. It is not closed in general. A reflection of an
  origin nobody declared foreign is still not found, and the guide says so.
- **The marking is the oracle, and it can be wrong.** An operator who marks a
  partner's origin foreign turns the platform's correct answer into a finding. This
  is the same exposure as an expected-access rule that says a role must not reach an
  endpoint it legitimately reaches, and it has the same remedy: the declaration is
  the operator's and the report prints it.
- The configuration gains one optional field, `originIsForeign`. The JSON Schema in
  `schema/` gains it, and the report's `inputs.contexts[]` gains an optional
  `foreignOrigin`, which is additive and does not move `schemaVersion`.
- The package surface gains two values: `isWebOrigin` and `ForeignOriginError`.
  `createCorsCheck` takes an optional `CorsCheckOptions`.

### Limits

Written down after each was run against the tree, as ADR-0065 asks.

- **It judges the one origin the operator wrote.** A platform that trusts every
  `*.example` origin and was sent only `https://attacker.example` is found; one that
  trusts a pattern the declared origin happens not to match is not. One declared
  origin is one question.
- **It reads every response that carried the headers, whatever the status.** A CORS
  layer that is global middleware also decorates a 401, and a finding on an endpoint
  where only the 401 reflected is a true statement about the response and a weaker
  one about the data. The finding carries `status`, so a reader can tell.
- **Reflection with credentials under a different case is not matched.** The
  declared origin is canonical and a platform echoes what it received, so this does
  not arise from a browser's request; a platform that re-cases the value it echoes
  would be missed, and that is accepted rather than guessed at.
- **No preflight.** As for the rest of the check: the answer to the request itself
  is what is read.
- **The marker is held by its tests and by the shape of the data, not by a gate that
  reads the declaration.** Nothing checks that a context marked foreign is one the
  policy mentions beyond the rule every context already has, which is that some rule
  must reference it.

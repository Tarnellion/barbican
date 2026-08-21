# 0044. The body channel compares what a human named

- **Status:** accepted
- **Date:** 2026-08-21

Extends [ADR-0011](0011-response-body-signals.md), which opened the body channel
and defined the digest as 48 bits of salted SHA-256 over the raw response bytes.
The invariants that ADR set stand unchanged: the body is read in transit and
stored nowhere, and `SignalValue` is a number or a boolean. Nothing here needs a
third variant, and nothing here reads more of a body than that ADR already
allows.

## Context

`identical-response-across-tenants` is the one check the "response bodies are not
read" invariant was relaxed for. It compares one number per cell — the digest —
and it was wrong in both directions at once. Both were reproduced.

**It found what was not there.** Two tenants with no records answer
`{"orders":[],"total":0}`, byte for byte the same. The digests match, the check
reports a `high` cross-tenant leak. On a fresh deployment, where half the tenants
have nothing yet, that is a wall of findings and exit 1 on the first run against
a healthy platform. `plan.md` names this risk first, and in the same words the
sibling failure was named in: a tool that finds things that do not exist loses
trust on the first run.

**It missed what was there.** Two responses carrying the records of **both**
tenants — a complete leak — differ by one `requestId` in the envelope. The bytes
differ, the digests differ, the check finds nothing. `requestId`, `serverTime`,
`generatedAt`, a pagination cursor, an echoed ETag: an envelope field that moves
between requests is the normal shape of a list endpoint on a real platform, and
any one of them switches this check off entirely.

**And the report could not tell the two apart from a correct run.** In both
cases the coverage read `comparedPairs: 1, skippedRelatedPairs: 0`. Identical
numbers for "we compared, and they honestly differed", "we compared, the
difference was in a request identifier, and the leak went past us", and "we
compared two empty responses and called it a leak". A reader with the saved
artifact had nothing to go on.

## Decision

Three changes, and the third is the one the other two are worth little without.

### An empty response is evidence of nothing

A pair where **every `count` signal the operator declared is zero on both sides**
is not compared. It produces no finding, and it is counted as
`skippedBothEmptyPairs`.

The signal for it already existed: `count` at a path, declared by a human, read
out of the body that is being read anyway. No new kind of signal, no new
`SignalValue`, and not one extra byte of anybody's response.

Three details this is deliberate about:

- **Emptiness is a property of the pair.** One account seeing nothing while
  another sees four records under the same digest is still a finding — the digest
  is then the thing that needs explaining, and suppressing it would be the
  blindness the channel was opened to remove.
- **A count must be present and zero, not merely absent.** A count is absent when
  the path was not an array or the body was not JSON, and reading that absence as
  emptiness would be a claim nothing measured.
- **Where no count is declared, the tool does not guess.** It has nothing that
  means "empty" on that endpoint and says so: `emptinessSignalsDeclared: 0` in
  the endpoint's coverage. The false positive is still reachable there, and the
  report names the reason rather than leaving the reader to infer it.

### The digest may be scoped to a declared subtree

`bodySignals.compareSubtree` declares which part of the body to compare:

```yaml
bodySignals:
  responseMustDifferByTenant: [orders.list]
  compareSubtree:
    - { endpoints: [orders.list], path: data.orders }
```

The path is declared by a human, like everything else in this model. It is never
derived from a response — "compare the fields that happen to agree" is the tool
choosing its own answer, the mistake [ADR-0006](0006-expected-access-declaration.md)
exists against. It is refused on an endpoint that is not under
`responseMustDifferByTenant` (no digest is computed there, so the scope would
scope nothing and the declaration would be silently dead), and one endpoint may
carry only one scope.

The mechanics are worth writing down because two of them decide behaviour:

- **A scoped digest hashes a canonical text, not a byte range.** The subtree is
  reached by parsing, and the bytes it came from are not addressable afterwards.
  Object keys are sorted by code units, array order is kept. Both halves are
  decisions: a platform that serialises one record's fields in another order
  between requests has not leaked anything, while two tenants shown the same
  records in a different order have — sorting the array away would answer a
  question nobody asked.
- **A scope that cannot be resolved yields no digest at all.** Not the whole-body
  digest as a fallback: that would compare something other than what the
  configuration asked for, under the same field name, in silence. The observation
  carries `digestScopeMissing: true` instead, a reserved name like `digest` and
  `bodyOverLimit`, and the pair is counted as `pairsWithoutDigest`.
- **Depth is bounded by the tool, at 100.** Past that there is no digest and the
  flag says so. The bound exists for reproducibility rather than safety: the
  depth at which an engine's own recursion gives out is not a number anyone can
  name in advance and it moves with the runtime, and a body that yielded a digest
  on one machine and none on another would be [ADR-0036](0036-one-order-on-every-machine.md)
  broken.

### The coverage counters tell the outcomes apart

`comparedPairs` stays, as the total it always was, and splits into `matchedPairs`
and `differedPairs`, with `comparedPairs === matchedPairs + differedPairs` for a
reader to check on the spot. Beside them: `skippedBothEmptyPairs`,
`pairsWithoutDigest`, `emptinessSignalsDeclared`, and the two that were already
there, `skippedRelatedPairs` and `skippedDifferentContextPairs`.

`pairsWithoutDigest` closes a silence one layer above the one D-5 closed. The
walk used to filter observations to those carrying a digest **before** pairing,
so a body over the size ceiling took its pair out of every number in the report
and nothing said why — the flag on the observation existed and no counter read
it.

Findings and coverage now walk the same `pairsOn`. The note beside `comparable`
already warned that two loops would drift into describing different things; with
the outcome of a comparison becoming part of the coverage, two loops would have
been the same fact derived twice by two pieces of code.

**And the boundary is written into `docs/report.md`, held by a test.** Differing
digests do not prove isolation. They prove the bytes were different — an envelope
field, a subtree comparison that skips the field the leak is in, the same records
in another order. This is the structural sibling of "a platform that refuses with
200", it has no code to fix, and it is guarded the same way: a warning nothing
checks survives exactly until the next edit.

## Alternatives

**Strip envelope fields automatically — drop anything that looks like an
identifier or a timestamp.** It is the tool deciding what a response means. The
first platform whose tenant id is called `requestId`, or whose leak sits in a
field matching the heuristic, gets a clean report. Everything in this model that
says what a response ought to be is declared by a human, and this is not the
place to start guessing.

**Compare digests pairwise per field, so no declaration is needed.** That is a
different check — property-level, OWASP API3 — and the note on `standards` in
this check says why it is not credited with that class today: it compares the
response as a whole and knows nothing about fields. Building it is a separate
piece of work with its own findings and its own clause mapping, not a
modification of this one.

**Treat "the digests differed" as proof of isolation and say nothing.** That is
the state this ADR is written from. The number was already being read that way.

**Suppress the empty-pair finding by digest instead of by count** — hardcode the
digests of `{"items":[]}` and its neighbours. It would depend on the exact bytes
of one platform's empty response, and the salt is random per run, so there is
nothing stable to hardcode. The operator's own count is the declaration that
already exists.

**Let `count` mean emptiness only when the operator marks it so.** A fourth
field, `meansEmpty: true`, on a signal whose whole purpose is counting a
collection. Every declared count that is zero on both sides already says what
there is to say, and a flag would mostly be a way to forget it.

## Consequences

A run against a platform whose list endpoints are wrapped in an envelope needs
`compareSubtree` to find anything by body — and until 0.4.0 it found nothing
there while reporting that it had compared. Nothing about that run's numbers was
false; what was missing is that `differedPairs` did not exist to be looked at.

A configuration that declares `compareSubtree` on an endpoint outside
`responseMustDifferByTenant` now fails to parse. That is a declaration that never
did anything.

`coverage.byCheck[].counters` gains five keys for this check. Additive: the
report's `schemaVersion` stays `2`, and a consumer written against the old shape
still finds `comparedPairs` where it was, meaning what it meant.

A pair where both sides are empty stops producing a finding. On a platform whose
tenants genuinely share one empty collection, this check can no longer say so —
correctly: two empty responses look the same whether or not a filter exists, and
the finding it used to produce was not evidence of anything. Where an operator
wants that pair examined, the answer is a matrix cell with a resource in it,
which is the channel where a shared record shows up by status.

What is still not covered: a leak confined to a field inside a scoped subtree
that the scope excludes, and two tenants shown identical records in different
orders. Both are named in `docs/report.md` beside the boundary, because a
limitation a reader can recognise in their own platform is the only kind that
gets acted on.

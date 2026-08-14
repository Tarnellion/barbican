# 0011. Signals over the response body

- **Status:** accepted
- **Date:** 2026-08-12

## Context

A whole class of defects is currently out of the tool's reach as a matter of
principle, and that is not a gap in the implementation but a consequence of a
deliberate invariant: the response body is never read.

The boundary runs where a denial is distinguishable by status. "200 where a denial
was declared" — visible. "200 with a list that someone else's orders got into" —
not visible: a correct and a defective implementation answer with the same code, and
the whole difference is in the body.

This is not a hypothetical case. It is documented twice:

- In [crAPI](../polygons/crapi.md) — "what the tool will never find without reading
  bodies": excessive data exposure, attribution of a leak, mass assignment.
- In our own reference platform `polygon/`, on `GET /v1/orders` **no defect is set
  up deliberately**, with a comment in the code: the difference between tenants is
  visible only in the body, that is, for the tool it does not exist.

The second one is particularly unpleasant. A missing tenant filter on a list
endpoint is not an exotic case but the most common way to break isolation in a
multi-tenant platform. A tool that calls itself a check of tenant isolation and does
not see exactly this checks something other than what it claims.

The invariant is load-bearing, though. Half of the others stand on it: the report
cannot contain PII because there is physically nowhere to put the data —
`HttpResponse` has no field for a body, and the stream is cancelled without being
read. It cannot be removed wholesale.

## Decision

Allow reading the body **inside the adapter** in order to compute the **irreversible
scalar signals** declared by a human, and store only those. The body itself is not
stored, does not cross the port boundary and does not get into the report under any
circumstances.

The invariant is not cancelled but made more precise: it was "the body is not read",
it is now **"the body is not stored"**. It is read in transit, in the adapter's
memory, and dies there.

The key part is the type of a signal's value:

```ts
export type SignalValue = number | boolean;
```

`string` is deliberately not in it. A string can carry away the whole body, and then
the guarantee would rest on the discipline of the caller rather than on the
construction. Here the body **structurally does not fit** — exactly the same device
by which the original invariant was provided through the absence of a field.

From this the shape of the digest follows. Comparing "did two accounts get the same
response" requires a digest, but a hex string would bring back the string type. So
the digest is **the first 48 bits** of `SHA-256(salt ‖ body)` as a number. 48 bits
fit into a JavaScript safe integer, and the probability of a collision over a run of
a thousand responses is on the order of `10⁻⁹` — three orders of magnitude smaller
than the probability that the operator makes a mistake in the configuration.

The salt is **random for every run**. This is not decoration: without it the digest
of a response with a predictable body (`{"error":"forbidden"}` and the like) can be
found by brute force, and the report starts confirming guesses about content. With a
random salt the digest is meaningful only inside its own run — where it is needed —
and useless outside it.

The kinds of signal, all three irreversible reductions:

| Kind | Value | Which question it answers |
|---|---|---|
| `digest` | a number, 48 bits with salt | Did the response match for two accounts — up to a 48-bit collision? |
| `count` | the number of elements of the array at the declared path | How many records did the account see? |
| `present` | boolean, whether the path exists | Is the field present in the response? |

There is no kind that returns content, and there will not be. `value` is not added:
it would turn the configuration into a means of dumping arbitrary fields into the
report.

**Off by default.** Without an explicit section in the configuration the stream is
cancelled unread — behaviour byte for byte the same as today's.

**A hard size ceiling.** No more than `maxBodyBytes` is read (256 KiB by default).
If it is exceeded, signals are not computed at all and are marked unavailable.
Computing a digest over a prefix would be worse than not computing it: two different
responses with the same first 256 KiB would look identical, and the tool would
assert a match that does not exist.

### The signal path comes from the configuration — and that does not contradict the redaction rule

It looks like a violation of the invariant "redaction paths for sensitive data are
hardcoded only, never from user input". The difference is in **the direction of
failure**.

A wrong redaction path fails **open**: the secret is not redacted and travels into
the report. A wrong signal path fails **closed**: the signal is not computed, there
is no finding. The first silently does harm, the second silently does nothing. That
is why the redaction path stays hardcoded while the signal path is declared by a
human — like the rest of the expected picture under
[ADR-0006](0006-expected-access-declaration.md).

The path syntax is minimal: segments separated by dots, no substitutions, no
wildcards, no expressions. A full JSONPath means both a new dependency and an
evaluator of expressions over untrusted data; neither pays off here.

### The check that uses this

One, `identical-response-across-tenants`: two accounts from **different** tenants
got the same digest of a 200 response on one endpoint.

The check does not derive itself: for an endpoint a human must declare
`responseMustDifferByTenant`. Otherwise `GET /v1/health`, which hands out
`{"status":"ok"}` to everyone, would become a finding — and the tool, having only
just learned to see real leaks, would start drowning in false positives. This
declaration is the same statement of expectation as the access policy, and it is
made by a human for the same reason.

## Alternatives

**Leave it as it is.** An honestly drawn scope: "we check what is visible by
status". Rejected — the scope turns out narrower than the tool's name. The most
common tenant isolation defect stays outside it.

**Store the whole body with redaction by hardcoded paths.** Gives the most
information. Rejected: redaction by path works as long as the shape of the response
is known in advance. On someone else's platform it is not known, and any field that
did not make the list travels into the report as is. That makes the guarantee "there
is no PII in the report" depend on the completeness of a list that cannot be ensured.

**Store a hash of the body without a salt.** Simpler. Rejected: bodies with low
entropy are recovered by brute force, and the report becomes an oracle for
confirming guesses about content.

**Compare the length of the body instead of a digest.** Requires no reading —
`content-length` is already among the allowed headers. Rejected as a solution on its
own: matching lengths are too often accidental, and a mismatch says nothing about
whose data is inside. As an extra cheap signal — possibly later.

**Full JSONPath through a library.** Rejected: a new dependency plus an evaluator of
expressions over a response body from someone else's deployment. For `count` and
`present` a path of segments is enough.

## Consequences

The tool gains its first class of findings invisible by status. Accordingly
`GET /v1/orders` in the reference platform stops being an endpoint "deliberately
without a defect" and gets a fourth switchable flag — with the oracle extended.

The price is that the body is read after all, and that changes the nature of the
risk for good: previously a PII leak into the report was impossible by construction,
now it is impossible on the condition that the type of a signal's value is not
extended with a string. Therefore:

- extending `SignalValue` with a string or an object requires **a separate ADR**,
  not an edit made in passing;
- the test proving that the body appears neither in `HttpResponse` nor in the report
  is mandatory and cannot be marked `skip`.

The decision should be revisited if a need appears for a signal that cannot be
expressed as an irreversible reduction. That would mean the task has gone beyond
"check access" and moved into "check content" — a different tool with different
storage guarantees.

## Clarification of 13 August 2026: two names

The decision did not change, the names did — both promised something other than what
stands behind them. This is exactly the class of defect the tool looks for in other
people's platforms, and it was found by a cold read of the report by a person with
no access to the project.

**`identicalBody` → `bodyDigestsEqual`** in a finding's evidence. What was compared
were digests, not bodies: bodies are not stored, there is nothing to compare them
with. A collision is unlikely, but the report becomes the basis of an incident, and
"the bodies matched" is a stronger claim than the one that was verified. For the same
reason the finding's title now says "the response digest matched", not "the
responses are identical".

**`tenantScoped` → `responseMustDifferByTenant`** (and the key of the same name in
`bodySignals`). The old name read as a property of the API under test — "the
endpoint is scoped to a tenant" — while it encoded a setting of the tool: "a human
declared that bodies must be compared here". The discrepancy was plain to see:
`orders.read` had no marker although it is tenant-scoped by its meaning and was in
fact leaking — it is just that its defect is visible by status and needs no body
comparison. The new name is in the imperative, as befits a declared expectation
(ADR-0006): it does not describe the API, it states a requirement on it.

# 0005. Safety invariants of the tool itself

- **Status:** accepted
- **Date:** 2026-08-11

## Context

A tool that walks the "role × endpoint" matrix on someone else's API is mechanically the
same thing as a vulnerability scanner. Three risks have to be closed by construction rather
than by operator discipline: taking down someone else's deployment with load; issuing a
destructive request; dragging a client's personal data into reports and logs. A separate
class is an untrusted OpenAPI spec on the input, which can lead the parser into an internal
network or into the file system.

## Decision

The invariants are built into the types and the construction, so that violating one takes a
deliberate change to the code rather than a forgotten flag.

**Safe by default.** Without an explicit `--unsafe-methods` only GET and HEAD are performed.
The list is fixed by the `SAFE_METHODS` constant in `src/core/types.ts` and covered by a
test; extending it goes only through an ADR.

**Throttling is always on.** A concurrency limit, a requests-per-second limit, an overall
ceiling on requests per run, exponential backoff, a circuit breaker on runs of 5xx/429,
respect for `Retry-After`. The defaults are conservative. Throttling is the `Throttle`
port, not a call option, so it cannot be bypassed without replacing the adapter.

**Response bodies are not stored.** The `HttpResponse` port holds only the status and the
headers — there is no body in it at all, so smuggling PII into the report "by accident" is
impossible. If storing them is ever needed, that is a separate field under an explicit flag
and a separate ADR.

**External `$ref`s are not resolved.** Neither over http nor through the file system —
protection against SSRF (including cloud metadata addresses and RFC-1918) and against path
traversal. The requirement is written into the contract of the `SpecParser` port; an
implementation is accepted only together with a test proving that http and file `$ref`s are
not resolved.

**Redaction along hardcoded paths.** The redaction paths are set in code and are never
taken from user input.

**Scope is mandatory.** Without an explicitly set allowlist of hosts the tool refuses to
work.

**Secrets only through environment variables.** Nothing into the repository, nothing into
the logs.

## Alternatives

- **Allow all methods and rely on the operator's care:** one mistake in the arguments leads
  to a destructive request on someone else's production.
- **Store response bodies to make analysis easier:** it noticeably simplifies diagnosis, but
  makes the report file a carrier of personal data with all the obligations that follow.
- **Resolve external `$ref`s like an ordinary OpenAPI tool:** more compatible with other
  people's specs, but it turns parsing a specification into an SSRF primitive.

## Consequences

Some convenience has been sacrificed: specs with external `$ref`s have to be bundled into a
single file beforehand, and diagnosing from statuses and headers alone is less telling than
from bodies.

In exchange, the tool is safe to run against a client environment, and its reports hold no
data that must not be stored. The invariants are expressed in the types, so violating them
shows up in review as a change to a contract.


## Addendum of 2026-08-12: results of the adversarial review

The invariants above were checked by the author, who knew what they were meant to do. A
separate adversarial review found three breaches that this view did not see.

**Response headers were carried into the report in full.** The list of forbidden names was
structurally wrong: enumerating everything that will ever carry a secret is impossible.
`x-auth-token`, `authentication-info`, `x-amz-security-token` and a client's email in
`x-user-email` went straight past it, and `location` brought in an OAuth token in the
fragment. The invariant "we do not read bodies" held, but PII came in through the next door.
Replaced with an allowlist of names; `location` is stored without the query string and the
fragment.

**A path from the specification controlled the scheme and the port.** `new URL(path, base)`
gives priority to an absolute address, so a path of the form `http://same-host:9999/x`
overrode the base URL entirely — it downgraded https to http and led to an arbitrary port.
The allowlist check let that through: it compared only the host name. The specification
comes from the system under test and is not trusted. Now the origin of the result is
compared against the origin of the target, and a path that leads outside it becomes a skip
with a reason.

**`Retry-After` from the server removed the delay.** The value had no upper bound, and
`setTimeout` clamps values above 2³¹−1 ms down to one millisecond — three attempts went
through in milliseconds instead of exponential backoff. Bounded by a ceiling of our own:
the server's instruction takes priority over our formula, but not above our limit.

Separately it came out that "nothing was checked" was indistinguishable from "everything is
clean": a specification with no endpoints, a deployment that was down and an exhausted
request budget all gave exit code 0. Now such runs return 2, and the number of canaries
checked goes into the report.

Held with no remarks: the ban on external `$ref`s (17 bypass attempts, zero network
requests and zero file reads), the ban on unsafe methods, the throttling limits, the
allowlist by host name and the absence of a body in the report.


## Addendum of 2026-08-12, second pass: a regression and its cause

The second adversarial review and a run against crAPI independently found one and the same
thing, and it was **a regression introduced by ADR-0010**.

`findUnauthenticated` called `resolveExpected` without a relation, and rules with a `scope`
do not apply without a relation. So for the policy that ADR-0010 introduces and recommends,
the counter of declared access stayed at zero and the safeguard **never** fired. An
end-to-end run against a deployment that answers 401 to every request gave "no escalations
found" and exit code 0.

This is the third case of one and the same class — "the tool reports 'clean' having checked
nothing" — and the first one we introduced ourselves while adding a capability. The lesson
for the future: every extension of the expectation model must go through the safeguard,
otherwise the safeguard is checking a model that no longer exists.

Closed along the way:

- **A run cut short gave exit code 0.** An exhausted ceiling on requests and a tripped
  circuit breaker cut the walk short in the middle of the matrix; the tail is not checked,
  and there are no findings there for exactly that reason. Now such a run is marked and
  returns 2.
- **An unknown endpoint identifier was accepted silently** — both in a resource and in a
  policy rule. The run against crAPI showed both outcomes: a typo in a resource silently
  lost four BOLA findings, while a typo in a rule **fabricated** findings — a user reading
  their own order was declared a privilege escalation. References are now checked against
  the parsed list of endpoints.


## Addendum of 2026-08-12, third pass: the remaining findings are closed

**A typo in a tenant name hid a finding.** The relation was computed by comparing raw
strings: "tenant-a " with a space gave `foreign-tenant`, the rule with a `scope` stopped
applying, and a real cross-tenant leak fell through to `fallback` and did not reach the
report at all. Spaces are now trimmed, and the optional `tenants` list turns on a strict
name check — for accounts and for resources. The strictness is optional on purpose: a
resource of a tenant that has no accounts at all is a legitimate case when checking
isolation.

**A resource value took the request above the base path.** The mechanism is subtler than it
looks: `encodeURIComponent` encodes the slash but **not dots**, so a single `..` climbs
exactly one level up, and if the parameter stands at the start of the path, that is enough.
And the scope check was made over the **template**, before substitution. Now the address is
assembled before the check, and not only the origin is compared but the prefix of the base
path as well.

**`{constructor}` in a template matched any object.** Parameter coverage was checked as
`params[name] !== undefined`, and the names come from an untrusted specification — the
prototype answers to such a name on any object. Replaced with `Object.hasOwn`.

**Credentials leaked into the report by two paths.** A login and password in `baseUrl` were
copied verbatim, and `RequestFailedError` put the full URL with the query string into the
text that lands in `failures[].reason`. The first is forbidden on input, the second is
redacted.

**The canary bypassed the exclusion list.** It performed an endpoint that the run honestly
skipped — that is, it could hit `GET /createdb`, the very thing the list exists for.

Closed along the way: `allowedHosts` with a port is understood by the configuration too, not
only by the HTTP client.

## Addendum, 17 August 2026: which barrier holds the `$ref` invariant

The invariant holds — no http `$ref` is fetched, and that is proved by tests that
count requests on a loopback server rather than by catching an error. What was
wrong is the account of **why**.

`src/adapters/openapi.ts` described three barriers and called the third,
`resolve.external = false`, "the defence against SSRF proper", verified
separately by removing the second and observing that no request went out. That
observation is true and establishes nothing: no request goes out with the option
**on** either. Measured over six configurations — the document as an object, as a
file path, and as an object with a base path, each with the option both ways — and
swagger-parser 12.1.0 never fetches an http `$ref` at all. With the option off the
reference is silently left in place, which is exactly the silent degradation the
second barrier exists to catch; with it on, the call throws "Unable to resolve
$ref pointer". Neither opens a socket.

So what holds today is the first barrier: this adapter is handed text and never a
location, so nothing has a base to resolve from. The option stays, because a
version of the library that does resolve is precisely what it is for.

Two consequences worth stating plainly. A hand verification that cannot separate
two mechanisms has not verified either — the earlier check was a real experiment
with a wrong conclusion attached. And a guarantee that currently rests on a
dependency's inability rather than on our own configuration needs a tripwire, not
a comment: `tests/adapters/openapi.test.ts` asserts that the option-on case makes
no request either, which is a thing the project does not want to be true and will
fail the day it stops being.

Found by the audit of 14 August 2026, which noted only that the mutation
`resolve: { external: true }` breaks no test.

## Note of 2026-08-21: two of these invariants were narrowed elsewhere

This file is the one a reader opens for "the safety invariants", so it has to
say where they stopped being what it describes.

**"The `HttpResponse` port holds only the status and the headers — there is no
body in it at all"** was narrowed by [ADR-0011](0011-response-body-signals.md)
on 12 August 2026. The body is read in transit where a human declared
`bodySignals.responseMustDifferByTenant`, and irreversible scalars — `SignalValue`
is a number or a boolean, nothing else — reach the report. It is still never
stored, which is what the paragraph was defending; the sentence as written is
stronger than the code, and the difference is exactly the surface where PII
would live.

**The throttling guarantee** was narrowed by
[ADR-0026](0026-the-rate-is-a-shape-not-only-a-count.md): above 500 requests a
second the pacing between starts is switched off and only the sliding window
holds, so the shape of the traffic is not what this file implies at any rate.

Two more moved after this file was last amended: the address grammar sits at the
seam rather than at the doors ([ADR-0032](0032-the-grammar-sits-at-the-seam.md)),
and a canary is owed per account rather than per run
([ADR-0033](0033-a-canary-is-per-account.md)).

Found by the audit of 20 August 2026 (K-9).

# 0040. A canary has to tell somebody from nobody

- **Status:** accepted
- **Date:** 2026-08-21

## Context

[ADR-0033](0033-a-canary-is-per-account.md) made a canary the thing that says
"these credentials work", and made a run without one exit 2. Three ways past that
rule have been closed since, each in a day: a dead token on an account the policy
denies everywhere, which needed the rule to be per account rather than per run; a
typo in the `tokenEnv` key, which made the account anonymous and so excused from
the rule; and a request ceiling that ate the second canary pass while the first
one's `authenticated: true` stayed in the report.

The fourth needs no mistake at all. `authenticated` was
`status >= 200 && status < 300`, and a 2xx says the endpoint answered — not that
it answered *this account*. `/health`, `/version`, `/api/status` answer 2xx to
anybody, and they are the first thing an operator reaches for when the guide asks
them to name "an endpoint this account can reach".

Adversarial review, 21 August 2026 (V-2). A stand where `/health` returns 200 to
everyone and everything else refuses without a token; `bob` with
`TOKEN_BOB=DEAD-TOKEN-THAT-DOES-NOT-WORK` and `canary: health`:

    canaries: [{ accountId: bob, endpointId: health, status: 200, authenticated: true }]
    staleCredentials: []   unverifiedAfterWalk: []
    bob/orders.list → 401, expected "denied", match: true
    Exit code 0: no discrepancy with the declared policy

Every guard in the tool agreed the run was trustworthy, and the one sentence a
run like this exists to produce — "this account reaches nothing it should not" —
was said about credentials nothing had ever shown to work.

## Decision

A canary sends a second request: the same endpoint, the same address, with no
credentials at all. Where that request also comes back 2xx, the run refuses to
start with `UndiscerningCanaryError`, naming the account, the endpoint and the
status the endpoint gave to nobody.

The result is in the report as `canaries[].anonymousStatus`, so a reader sees
what was checked rather than taking the refusal on trust.

Two limits on the traffic, and they are deliberate. The control goes out only
where the credentialed request succeeded — where it did not, the run is stopping
anyway and this would be a request spent on a platform that is not ours to spend
requests on. And it goes out only on the pass before the walk: what it
establishes is a property of the endpoint, and that does not change while the
walk runs. One extra request per account with a canary, and `--dry-run` counts
it.

An unauthenticated request that fails on the wire counts as distinguishing: the
endpoint refused loudly, which is the answer being asked for.

## Alternatives

**Warn instead of refusing.** The warning would sit on exactly the runs whose
report says nothing and reads as clean, which is the shape ADR-0033 exists to
prevent. A canary that proves nothing is not a canary, and a run that cannot
confirm its credentials has not tested what it claims.

**Require the operator to declare that the canary needs credentials.** One more
line to get wrong, and it would be believed rather than checked: the tool can ask
the platform instead of asking the human.

**Infer it from the policy** — treat an endpoint the policy allows the anonymous
account as an unfit canary. It needs an anonymous account to be declared, most
configurations have none, and it asks the declaration rather than the platform.
The declaration is what a canary is there to check.

## Consequences

Configurations that name a public endpoint as a canary stop working, and stop
loudly. That is the point: they were producing the report described above.

A canary now costs three requests per account rather than two, and the preview
says so.

`CanaryResult` and `CanaryOutcome` carry `anonymousStatus`, which is additive for
a reader of schema 2.

What this does not check: that the endpoint requires *this* account's
credentials rather than any credentials at all. An endpoint that accepts every
token would pass both requests. Closing that needs a second set of credentials to
compare against, which the tool has — but the cost is a third request per
account and the failure it catches is rarer than the one this ADR closes.
Revisit if a platform is met that authenticates without authorising.

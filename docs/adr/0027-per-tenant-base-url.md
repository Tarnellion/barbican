# ADR-0027. A base address per tenant, not a second target

**Date:** 16 August 2026
**Status:** accepted. Answers the revision condition named in
[ADR-0008](0008-run-configuration-format.md), in a different shape from the one
that ADR predicted.

## Context

The decision described here was taken and shipped on 12 August 2026 (`6eb4c97`),
and this record is four days late. It is written now because ADR-0008 ends with
"revisit if a need appears for several targets in one run" — the need appeared,
the code changed, and the ADR that named the condition was never told. A reader
of ADR-0008 today concludes that one run reaches one host. That has not been true
since the third day of the project.

**Brands sit on different hosts.** A multi-brand platform gives each brand its
own subdomain far more often than it gives it a path prefix, and the tenant tree
of [ADR-0013](0013-tenant-hierarchy.md) already says which brand a resource
belongs to. What the run configuration could not say was where that brand lives.

The consequence was not a missing convenience. It was that **the main claim about
such a platform could not be stated at all**: "brand A's token does not work on
brand B's host". With one address per run, a cell pairing account `op-a` of
`brand-a` with resource `r-b` of `brand-b` went to A's host and got a perfectly
lawful denial — from the wrong server. The cell reads as tested and says nothing.
Multiply that by every cross-tenant cell and the report is clean because the
requests never arrived.

The workaround was one run per brand, stitched together by hand. It loses exactly
the thing the tool exists for: the account × resource matrix **across** brands.
That is the same argument [ADR-0016](0016-per-account-auth-schemes.md) makes for
several authentication surfaces in one run, one layer lower down.

## Decision

**A tenant may carry a `baseUrl` of its own.** Not a second `target`, and not a
list of targets.

```yaml
target:
  baseUrl: https://api.example.test
  allowedHosts: [api.example.test, a.example.test, b.example.test]

tenants:
  - { id: holding-1 }
  - { id: brand-a, parent: holding-1, baseUrl: "https://a.example.test" }
  - { id: brand-b, parent: holding-1, baseUrl: "https://b.example.test" }
```

**The address is chosen by the resource's tenant, not the account's.** That one
sentence is the whole decision; `baseUrlForTenant` in `src/runner.ts` is ten
lines around it. We are asking for somebody else's data, it lives on somebody
else's host, and the token stays ours — that is what the check consists of. An
address chosen by the account would send every request home and answer a question
nobody asked.

The fallbacks are ordered and each one is a statement:

| The cell has | The request goes to |
|---|---|
| a resource | the host of the **resource's** tenant |
| no resource, and the account has a tenant | the host of the **account's** tenant |
| no resource, and the account has no single tenant | `target.baseUrl` |

The third row covers two different accounts and deliberately treats them alike:
an account outside of tenants (an anonymous one) has nothing to choose a host by,
and an account in a **set** of tenants ([ADR-0017](0017-account-tenant-set.md))
has no single home among them. The tool will not guess which brand is home.

**Canaries go to the account's own brand.** A canary asks "does this token work
at all", and on a spread-out platform the common address answers it with a
denial — which would stop the run on the false alarm "the credentials do not
work" before the first cell was probed.

**The scope does not widen.** A tenant's host must be in `allowedHosts`, checked
at startup by the same `hostAllowed` that checks `target.baseUrl`, and
credentials in a tenant address are refused by the same `CredentialsInUrlError`.
There is one scope per run: declaring a tenant is not permission to leave it.

One consequence inside `planEndpoints`: an endpoint counts as `escapes-target`
only when its path escapes **every** declared address. Filtered against the
default address alone, a path legitimate for a brand on a subdomain would be
skipped, and the skip would look like a property of the endpoint.

## Alternatives

**`target` becomes a list, as ADR-0008 predicted.** Rejected, and the reason is
worth stating because that ADR expected this shape. A list of targets says
nothing about *which* target a given cell belongs to, so the binding "brand →
host" would have to be written a second time — once in `tenants`, once in
`target[]` — and two places holding one fact drift apart. This project has a
standing rule against that, and a drifted binding here fails silently: requests
go to the wrong brand and every verdict is wrong at once. The tenant node is
already the thing that says which brand something belongs to; the address belongs
on it.

**The address chosen by the account's tenant.** Simpler to explain and wrong. It
makes the cross-host claim unstateable — every request lands on the account's own
host, and "brand A's token does not work on brand B's host" is never asked.
`tests/multi-brand.test.ts` is written against this alternative: brand A's token
must be seen arriving at `https://b.example.test/v1/orders/2`.

**A host per account (`accounts[].baseUrl`).** Rejected for the reason ADR-0016
rejected an inline scheme on the account, applied to addresses: a host is a
property of the surface, not of the account. Written out on every account it
drifts through a typo, and there is nothing to catch a typo in a *host* with —
`a.exmaple.test` is as valid a name as `a.example.test`. What it produces is 401
or a connection error everywhere, which agrees with a policy of denials, which
reads as a clean run. That is the failure mode this whole tool is built against.

**Widen `allowedHosts` implicitly from the declared tenant addresses.** It would
save a line of configuration and it is precisely what ADR-0008 forbids: trusting
a host because it appeared in an address means a typo silently widens the scope.
The allowlist stays one explicit list that a human wrote.

**Several runs, one per brand, stitched together.** The state of affairs before
this decision. It loses the cross-brand matrix — that is, everything the tool can
do that a per-brand run cannot.

**Derive the host from the tenant name** (`{tenant}.example.test`). Rejected
outright: it invents a convention on somebody else's platform, and the first
platform that names a brand differently from its subdomain gets a run against
hosts that do not exist.

## Consequences

The claim "brand A's token does not work on brand B's host" is stateable and
tested. On a platform spread across hosts the cross-tenant half of the matrix
starts arriving at the servers it is about.

`allowedHosts` grows: it now lists every brand host, and a run against a
spread-out platform has a longer, more explicit scope. That is the intended
price — the scope is the one thing in this configuration that must never be
implicit.

A finding by body carries `relatedRequest` and not only `request`: the other side
of a compared pair may sit on a different host, and a second request put together
by eye from the first would go to the wrong place. That field exists because of
this decision.

**The reference polygon does not exercise this.** It is a single `node:http`
server on `127.0.0.1:8787`, so all 28 oracle combinations run with no tenant
address declared, down the `?? fallback` branch. The behaviour is covered by
`tests/multi-brand.test.ts` (six cases: the resource's host, the account's host
with no resource, an account outside of tenants, both canary paths, and the
unchanged single-address run) and by three cases in `tests/io/config.test.ts` (it
is read, a host outside `allowedHosts` is refused, credentials in it are
refused). Named plainly rather than left to be discovered: end-to-end this path
is unproven, and a polygon on two ports would prove it.

Revisit if a tenant needs more than an origin — a path prefix per brand, or a
brand reachable on one host for reads and another for writes. Both are expressible
by making the value an object rather than a string, and neither should be added
before a real platform asks for it.

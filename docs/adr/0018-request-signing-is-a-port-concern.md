# ADR-0018. Request signing is a library case, but the port must allow for it

**Date:** 13 August 2026
**Status:** accepted

## Context

The four built-in authentication schemes (`bearer`, `header`, `cookie`, `basic`,
[ADR-0008](0008-run-configuration-format.md), [ADR-0016](0016-per-account-auth-schemes.md))
cover presenting a **static** secret. They do not cover signing a request: an
HMAC over the method, the path and a timestamp is the norm in fintech and in
payment callbacks.

In `tasks.md` this was recorded as a blocker for a run on someone else's
platform, and the same entry carried a caveat: a common signature format must
not be invented blind — canonicalization differs between SigV4, Stripe-like
schemes and homegrown ones, and a configuration describing "signing in general"
would not match a single real one.

The same entry claimed that a consumer of the **library** can implement a scheme
of its own, since the `CredentialProvider` port is exported. **That claim was
false.** The port looked like this:

```ts
headersFor(accountId: string): Readonly<Record<string, string>>;
```

Signing the method and the path knowing only the account identifier is
impossible in principle. Worse: `runner` computed the headers **once per
account** and reused them across every cell — even a provider that somehow
obtained the address would have signed one cell with it and sent that signature
to all of them.

The cost of the mistake is the same as with tokens that do not work: the
platform rejects the signatures, every cell gives 401, the report says "there is
no access anywhere" — and that is indistinguishable from a healthy platform with
access closed. Canaries would catch such a run, but only if the canary request
were signed too.

## Decision

The port receives a description of the request it issues headers for:

```ts
headersFor(accountId: string, request: SignedRequest): Readonly<Record<string, string>>;

interface SignedRequest {
  readonly method: string;
  /** The full address of the request, with path parameters already substituted. */
  readonly url: string;
}
```

`runner` calls the provider **for every request**, the canary one included.

There is no body in `SignedRequest`: the tool does not send them. Should sending
appear, the body will be added here by a separate decision, not by a silent
extension.

The signature format is still **not described** in the configuration. The
boundary is drawn like this: the tool is responsible for making signing
**expressible**, and its concrete shape is for whoever knows the platform under
test.

## Alternatives

**A `signature` scheme in the configuration.** The algorithm, the header name,
the list of parts of the canonical string, the separator, the timestamp.
Rejected: this is a mini-language designed without a single real target. It will
either miss a real platform on a detail (the order of the parts, the encoding of
the query, the format of the time), or start growing special cases and become a
bad templating engine. It is worth returning to this decision once **two**
platforms with signing appear: one will not show what is common.

**Leave the port as it is, admitting that signing is impossible.** Rejected:
this cuts a whole class of platforms off from use as a library, while the reason
for cutting them off is the shape of one method, not anything substantial.

**Pass the whole `HttpRequest` to the provider.** Rejected: it includes
`headers` and `signals`, that is, the provider would get the ability to
influence the reading of the body and the redaction of headers. The port must
receive exactly what is needed for signing and nothing beyond that.

## Consequences

- A scheme with signing is implementable on top of the exported port, and the
  claim about that in `tasks.md` has finally become true; it has to be checked
  against the built package, not against the code.
- The headers are computed for every request instead of once per account. For
  the built-in schemes that is one extra call of a pure function per cell —
  against a network request it goes unnoticed.
- The regression "hoist the headers out of the loop to save work" is covered by
  a test: the provider records the addresses it was asked about, and they must
  differ. A mutation that brings the hoisting back fails the test.
- The built-in schemes ignore the argument, and that is written in their
  documentation: otherwise the next reader will decide there is a dependency on
  the address somewhere.

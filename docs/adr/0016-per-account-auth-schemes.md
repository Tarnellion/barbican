# 0016. A per-account authentication scheme

- **Status:** accepted
- **Date:** 2026-08-13

## Context

There was one authentication scheme for the whole run: `auth` at the root of the
configuration (ADR-0008), and `createCredentialProvider` applied it to every
account alike.

That does not hold up against a real surface. A multi-brand platform has several
surfaces, and they authenticate differently: the customer API by a Bearer JWT,
the operator console by a session cookie, the affiliate cabinet by a key in a
header of its own. This is not a guess: the direction and the means of
authentication of the surfaces already diverge in the public integration
documentation (`docs/research/igaming-contours.md`, §1.2, §3.1, §3.2).

A run covering several surfaces at once was **inexpressible** — even though that
is the run the tool exists for. You would have had to make several runs and
stitch the reports together by hand, losing the main thing: the surface ×
surface matrix, where an account of one surface asks for the resources of
another. That is exactly where BFLA lives ("an affiliate reaches an
administrative endpoint of a brand") and cross-surface leaks.

A separate constraint is, as usual, about silence. An account that went into the
run with the wrong scheme gets 401 everywhere. The denial matches the policy
everywhere access is not meant to be granted, no findings arise, and the report
looks clean. A canary stops such a run, but a canary is optional, and a mistake
in the scheme is not.

## Decision

**Named schemes at the root, a reference by name on the account.**

```yaml
auth: { kind: bearer }              # the default scheme

authSchemes:
  operator-console: { kind: cookie, name: opsid }
  affiliate-cabinet: { kind: header, header: X-Affiliate-Key }

accounts:
  - { id: olga-op, role: operator, tenant: brand-a,
      tokenEnv: TOKEN_OLGA, authScheme: operator-console }
```

The root `auth` stays the default value: an account that named no scheme goes by
it, and a run against a single surface does not change by a single character.

A reference rather than the whole scheme on the account, because **the
parameters of a scheme belong to the surface, not to the account**. The cookie
name `opsid` is one and the same for all operator accounts; written out on each
of them, it will sooner or later drift apart through a typo. And here the
difference matters: there is nothing to catch a typo in a *parameter* with —
`opsi` is as legitimate a cookie name as `opsid`, and there is nothing to check
it against. A typo in a *reference* is caught every time: a name is either
declared or it is not.

Three errors fail at startup, before the first request:

| Error | What would happen otherwise |
|---|---|
| the reference does not resolve (`UnknownAuthSchemeError`) | the account goes with the default, 401 everywhere, the report is clean |
| the scheme is used by nobody (`UnusedAuthSchemeError`) | a forgotten `authScheme`: the same 401, the same silence |
| a scheme on an account without `tokenEnv` (`AuthSchemeWithoutTokenError`) | the reference "uses" the scheme, and a forgotten `authScheme` on a real account stops being visible |

The second is the same class as an endpoint pattern that matched nothing
(ADR-0008): a declaration that never applied looks like a checked statement
without being one.

There are no secrets in a scheme in any form: it describes the transport, and
the value comes from the environment variable the account names. Scheme objects
are strict — an extra key is rejected, not silently dropped, otherwise
`{ kind: bearer, token: "…" }` would pretend to work while leaving a secret in a
file that is meant to be committed.

## Alternatives

- **A full override on the account** (`accounts[].auth: { kind: cookie, name: opsid }`).
  One entity shorter and it needs no reference resolution. Rejected: it repeats
  the parameters of the surface on every account, and a typo in a parameter is
  caught by nothing and gives exactly the silent run that this whole thing was
  started to prevent. The class of error here is not hypothetical — it is the
  same one that once hid a real leak through a typo in a tenant name.
- **Both ways at once**: a reference or an inline scheme. More flexible, but it
  keeps the uncatchable typo as an allowed path and gives two ways to say the
  same thing. Checkability in this project is worth more than convenience of
  writing.
- **A scheme derived from the specification** (`securitySchemes` in OpenAPI).
  Rejected by ADR-0006: the spec is generated from the same code, and deriving
  from it would mean comparing an implementation against itself. Besides, it
  describes what one *may* present, not what a particular account presents.
- **Several runs and stitching the reports together.** The existing state of
  affairs. It loses the surface × surface matrix entirely — that is, exactly
  what the tool can do and nothing else can.
- **A scheme per role rather than per account.** Tempting: surface and role
  often coincide. But not always — one and the same administrator turns up both
  in the console and in the customer API — and a coincidence built into the
  model cannot be pulled apart later.

## Consequences

A run covers several surfaces at once. The surface × surface matrix becomes
expressible, and with it BFLA between surfaces.

The price is one more entity in the configuration and the duty to declare a
scheme before referring to it. For a single-surface run there is no price: both
`authSchemes` and `authScheme` are optional.

The report still records only the default scheme (`inputs.auth`): the overrides
do not reach it yet. This is worth fixing — the reader of the report cannot see
which surface an account went through — but it touches the report format and is
done separately.

Revisit if schemes appear that require state: OAuth redirects, a refresh token
exchange, an RSA signature over the body (§3.2 of the research). None of them
fits the current "token from the environment → header" model, and they should
not be added here: a login is a POST, that is, outside safe mode, and the
operator logs in outside the tool.

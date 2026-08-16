# ADR-0019. Request conditions as a dimension of the matrix

**Date:** 13 August 2026
**Status:** accepted

## Context

The matrix described a cell as the triple account × endpoint × resource. That is
enough for RBAC and for tenant isolation, but not for a whole class of
restrictions that the tool is taken up for in fintech and iGaming in the first
place:

- a bet is not accepted from a prohibited jurisdiction;
- a withdrawal is closed until KYC is passed;
- an operation is closed from an unverified device;
- a limit depends on the amount, the time or the channel of the request.

They have one thing in common: **the role, the tenant and the resource are the
very same ones**, and the outcome must be different. "alice sees her own order"
is true and stays true; "alice sees her own order having made the request from a
prohibited country" is already a defect. The tool could not tell these two cells
apart: it had no coordinate along which they differ.

This is the minimal useful piece of ABAC written down in `tasks.md`: declare two
sets of conditions and compare the outcomes, **without modelling the platform's
decision logic**. The tool does not know and must not know how the platform
makes its decision; it compares observed outcomes against the declared
expectation.

## Decision

A cell gets a fourth coordinate — **request conditions**.

In the configuration, conditions are a named set of attributes with a mandatory
scope:

```yaml
contexts:
  - id: geo-blocked
    description: a request from a prohibited jurisdiction
    headers: { cf-ipcountry: AQ }
    endpoints: [orders.list, orders.read]
    accounts: [alice-a]        # optional: applies to all by default
```

A policy rule names the conditions explicitly:

```yaml
- roles: "*"
  endpoints: [orders.list, orders.read]
  context: geo-blocked
  outcome: denied
```

Seven decisions, every one of which could have been made otherwise:

**1. A missing `context` in a rule means the baseline conditions, not "any".**
Otherwise declaring new conditions would silently extend every previous
expectation to them, and a platform that lawfully closes a bet from a prohibited
country would give an "unexpected denial" on every endpoint. An expectation
under conditions is declared explicitly — or `fallback` fires.

**2. Conditions are a label in the core, attributes live in the adapters.** The
core knows nothing about HTTP (ADR-0002), so `Account.contextId` is a string,
while the headers and the query parameters live in `ContextAttributes` next to
the ports.

**3. An account under conditions is a separate matrix row** with the identifier
`alice-a@geo-blocked`. A collision with an actually declared account (if
accounts are named, say, by email addresses) does not pass silently: building
the matrix rejects duplicate identifiers.

**4. `endpoints` on conditions is mandatory.** Conditions without bounds would
multiply the matrix by the entire API surface, and the cost of a run on someone
else's deployment is not a small matter. An account under conditions exists only
on the declared endpoints; on the rest the cell **does not exist**, and "not
observed" cannot be said about it — that would be an invented hole in coverage.

**5. Attributes cannot replace the basis of the request.** The first version of
this decision was **wrong**, and an adversarial review broke it the same day in
three ways. A ban list of six exact names closed off the credentials and the
host, but did not close off the main thing: conditions with
`x-http-method-override: DELETE` made the deployment **delete a resource** while
a GET went out on the wire — and the report wrote `writeMethodsProbed: false`.
The `SAFE_METHODS` gate looks at the request method and does not see such a
bypass by construction.

The rule was rewritten into three layers:

- **Exact names** — credentials, the host, transport headers;
- **Family prefixes** of the ones that change the meaning of the request:
  `x-http-method*`, `x-method*`, `x-original-*`, `x-rewrite-*` and those
  `x-forwarded-*` that change the addressee. By prefix, not by name: method
  override has a dozen spellings, and a list of exact names will fall behind the
  next framework. `x-forwarded-for` is allowed deliberately — it is the typical
  attribute of geo conditions;
- **A check by value**: an attribute whose value equals the name of an HTTP
  method is rejected until `--unsafe-methods` is set. This also catches a vendor
  header nobody has heard of: override has many names, but its value is always
  one and the same.

The query string gets a rule of its own: keys that present credentials
(`access_token`, `api_key`, `token` and the like) are forbidden, and so are keys
by which resources identify themselves. The first, because a token in the
address means **a different account**: the platform will serve the request as
that account, while the report writes the original `baseAccountId`, and half the
matrix goes to the wrong place. The second, because an attribute that rewrote a
resource's key makes the verdict false in both directions: a cross-tenant leak
lands in the report as "own resource, tested and agreed".

The residual risk is named directly: no complete list exists of the headers
someone else's platform may honor. The tool closes off the known families and
checks the value; everything beyond that is the responsibility of whoever
declares the conditions. For the same reason the guide says: a context attribute
is an arbitrary header sent into someone else's system, and it has to be treated
as exactly that.

**6. Conditions are part of the defect signature.** The country check and the
permission check are different mechanisms, they break independently and are
fixed in different places.

**7. Bodies are compared only under matching conditions.** What the
`identical-response-across-tenants` check asserts is "different tenants get
different responses **all else being equal**". A pair in which both the tenant
and the attributes differ says nothing, yet would look like a finding.

Along the way, **451 is recognized as a denial** on a par with 401 and 403. It
is never ambiguous: "unavailable for legal reasons" is a decision not to serve,
not a failure and not a missing resource. Geo and jurisdiction restrictions
answer with exactly that, and without this a healthy platform would give a wall
of `probe-error` right where it behaves correctly.

## Alternatives

**Attributes as a property of the account.** Set up "alice from a prohibited
country" as a separate account in the configuration. Rejected: it would have the
same token and the same role, but the policy could not tell it from the real
alice by anything other than the name — that is, the expectations would have to
be written by account identifiers rather than by roles. This is exactly the
coupling that the role × endpoint model leads away from.

**Conditions as a filter over rules, with no new cells.** Probe nothing anew and
merely interpret the already collected observations differently. Rejected: an
observation under conditions **does not exist** until a request has been made
with the attributes. There is nothing to interpret.

**Model the decision logic (a full ABAC engine).** Declare the attributes of the
subject, the resource and the environment and compute the decision. Rejected:
that is a second PDP next to the one under test, and a discrepancy between them
would mean an error in the model exactly as often as a defect in the platform.
The tool compares outcomes, not decisions.

## Consequences

- The matrix grows: every set of conditions adds (accounts × their endpoints ×
  resources) cells. On the reference polygon 90 → 144 with two declared sets of
  conditions. That is exactly why bounding the scope of conditions is mandatory.
- `coverage.contextsProbed` names the number of observed cells for each set of
  conditions, including a zero: "conditions declared but not tested" would
  otherwise read as "everything is in order under these conditions".
- The trustworthiness safeguard (`findUnauthenticated`) takes conditions into
  account. Without that, an account for which everything is declared forbidden
  under conditions would look like an account with credentials that do not work,
  and a **healthy** run would return code 2. Found by checking against the
  oracle: 25 combinations out of the 25 it held then, and 28 out of 28 since the
  write defects were added on 14 August 2026.
- The policy rule schema became strict (`strictObject`). Found in the same
  place: the old build silently dropped the unrecognized `context` key, and the
  rule "deny under these conditions" turned into "deny always" — 19 findings on
  a healthy platform. The same typo in `scope` works the other way round and
  **hides** a finding.
- **The tool does not check the delivery of the attributes and cannot check
  it.** A header stripped on the way gives requests indistinguishable from the
  baseline ones, and the report will say "the restriction does not work" where
  it was not tested. This is the one place in the report where "was not tested"
  is not distinguishable from "does not work"; it is named directly in
  `docs/report.md` and in the guide.
- The identity of a matrix row rests on `baseAccountId`, not on parsing the
  identifier. The first version did not have it, and ownership of a resource was
  lost: `order-a-1001` stopped being its own for `alice-a@geo-blocked`, the
  relation slid to `same-tenant`, the severity from medium to high, and the
  `own` defect group disappeared. Printing the authentication scheme broke in
  the same place: the row looked it up by its own identifier and printed the
  root one. Found by a cold read of the report by a person with no access to the
  project.
- **A run without a single canary is declared untrustworthy (code 2).** Found in
  the same place and belongs to the same class: the deployment answered 401 to
  everything, the tokens were stale, the policy consisted of denials only — and
  the `findUnauthenticated` safeguard stayed silent **by construction**, because
  nothing was declared accessible. The report came out clean with code 0 and
  with `match: true` on every cell. Accounts without credentials are excluded
  from the rule: an anonymous run has nothing to authenticate.
- Two flags appeared on the polygon: `POLYGON_DEFECT_GEO_BYPASS` — the first
  defect that permissions cannot express at all — and
  `POLYGON_DEFECT_SCOPE_ALL_HONORED`, where the conditions are given by a
  **query parameter** rather than by a header: their paths differ, and without
  the second cell the claim "the parameter arrives" would rest on a single unit
  test.
- A defect visible in the baseline conditions is usually visible under the
  declared ones too, and it is grouped separately: one breakage in the platform
  gives two groups differing only by `contextId`. Merging them is not the tool's
  job: from the outside "leaks with the attribute" and "leaks without it" may be
  different paths in the code, and conditions were introduced for exactly that
  case. The reader is told this directly in `docs/report.md`.

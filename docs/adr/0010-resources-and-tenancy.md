# 0010. Resources, ownership and the three-dimensional matrix

- **Status:** accepted
- **Date:** 2026-08-12

## Context

The project is declared as a tool for checking RBAC **and tenant isolation**. The
second half is still not implemented: `tenantId` is read from the configuration,
put into a domain type and used nowhere else — not in forming the request, not in
the policy, not in the diff. It is a field in the report with nothing behind it.

The reason is that the matrix is two-dimensional: "account × endpoint". Such a
matrix answers the question "who has which endpoint open" and cannot answer "can an
account of tenant A read a resource of tenant B" — because there is no resource in
it at all.

Hence the second limitation too: endpoints with parameters in the path are skipped,
since there is nothing to substitute into them. On VAmPI that is 9 endpoints out of
14, on crAPI four out of the sixteen available GETs. BOLA and IDOR live exactly
there.

## Decision

**The matrix becomes three-dimensional: account × endpoint × resource.**

Resources are declared by a human in the configuration together with the owner and
the parameter values:

```yaml
resources:
  - id: profile-of-a
    tenant: tenant-a
    owner: player-a
    params: { playerId: "1001" }
  - id: profile-of-b
    tenant: tenant-b
    params: { playerId: "2002" }
  - id: report-1
    tenant: tenant-a
    query: { report_id: "1" }
```

An endpoint without parameters is probed as before — once per account, with no
resource. An endpoint with parameters is probed once per "account × resource" pair
that has values for all of the path parameters.

### Ownership instead of a single "own or someone else's"

The relation of an account to a resource has three values, because two are not
enough:

| Relation | Condition | Which defect it catches |
|---|---|---|
| `own` | the owner of the resource is the account itself | basic access to one's own |
| `same-tenant` | same tenant, different owner | BOLA inside a tenant |
| `foreign-tenant` | a different tenant | a leak between tenants |

Separating `same-tenant` and `foreign-tenant` matters: a tenant administrator is
usually meant to have access to every resource of their own tenant and to none of
anyone else's. A single "not one's own" flag cannot express that.

### The policy gets a scope

```yaml
rules:
  - { roles: [player], endpoints: [profile.read], scope: own,            outcome: allowed }
  - { roles: [player], endpoints: [profile.read], scope: same-tenant,    outcome: denied }
  - { roles: [admin],  endpoints: "*",            scope: foreign-tenant, outcome: denied }
```

`scope` is optional: a rule without it applies to any relation, including endpoints
with no resource. This keeps compatibility with policies already written.

### Identifiers are declared, not fished out of responses

This closes a question that has been hanging since phase 2: how to obtain an
identifier for BOLA without reading response bodies. The answer is **do not obtain
it**. The statement "resource 1001 belongs to player A, and 2002 to tenant B" is a
claim of intent, exactly like the access policy itself (ADR-0006). A human declares
it, the tool checks it.

Response bodies stay unread, and the invariant stays untouched.

### The anonymous account

`tokenEnv` becomes optional. An account without it makes its requests with no
credentials. Without that you cannot check the claim "this address must not be
public", and reconnaissance of crAPI showed that one order there is handed out with
no token at all — a finding that a two-dimensional model with a mandatory token
misses.

## Alternatives

**Fish identifiers out of the bodies of previous responses.** That is how
general-purpose scanners work, and that is how defects a human did not know about in
advance become reachable. Rejected: it requires reading bodies, that is, cancelling
the invariant the project was started for. The price is that the tool will not find
what a human did not declare; this is a deliberate narrowing.

**One "someone else's resource" flag instead of three relations.** Shorter in the
configuration, but it does not express the difference between "someone else's
resource in my tenant" and "a resource of a different tenant", and for a
multi-tenant platform those are different classes of defect with different severity.

**The resource as a fourth dimension on top of the tenant.** A resource's tenant is
part of its description, not an axis of its own: a resource belongs to exactly one
tenant, and introducing a dimension for that would mean breeding cells known to be
empty.

**Extract parameter descriptions from the specification.** It would allow telling
path parameters from query ones automatically. Rejected for now: the specification
comes from the system under test, while the values are declared by a human anyway —
it is simpler and more honest for the same human to name where they get substituted.

## Consequences

The matrix grows as a product: with three accounts, ten endpoints with parameters
and four resources that is 120 requests instead of 30. Throttling and the ceiling on
requests per run become more substantial, not more decorative.

The configuration gets more complicated: resources are added to accounts and the
policy. That is the price of the tool checking what its own name claims.

The report gains a third dimension: a finding now says not only "who and where" but
also "against which resource", without which a conclusion about broken isolation
cannot be verified.

Revisit if a source of identifiers appears that is independent of the system under
test and does not require manual declaration — for example read access to its
database in a test environment.

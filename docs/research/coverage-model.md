# What barbican's model expresses, and what it does not

The analysis was done against the code, not against intentions: the sources are
`src/core/types.ts` and `src/core/expected.ts`. The claims about gaps are confirmed
by running it.

## The model today

Three entities and one relation function:

```ts
Account  = { id, roleId, tenantId }
Resource = { id, tenantId, ownerAccountId?, params, query? }

relationOf(account, resource):
  account.tenantId !== resource.tenantId  -> "foreign-tenant"
  resource.ownerAccountId === account.id  -> "own"
  otherwise                               -> "same-tenant"
```

A policy rule is `(role, endpoint, relation) -> allowed | denied`. The last rule
that matched wins; anything uncovered falls through to `fallback`.

From this follows directly **what** is checkable: statements of the form "role R on
endpoint E, under a given relation to resource X, has / does not have access". And
**by what means**: by comparing the response code, and since ADR-0011 by an
irreversible scalar over the body as well.

## The key limitation: `tenantId` is flat

A tenant is a string, and exactly one relation between two tenants is defined:
"they do not match". There is no hierarchy. This is not a small matter of
implementation but a boundary of expressiveness, and here is its price.

### The experiment

Holding H1 owns brands A and B. Holding H2 owns brand C. The correct behaviour: an
account of holding H1 sees A and B and does **not** see C.

There is nothing to express that with: an account has one `tenantId`. We attribute
the holding to brand A — the model gives no other option — and allow it
`scope: foreign-tenant`, otherwise brand B is unreachable. After that the
deployment hands the holding all three resources, the foreign one included.

```
relation of holding H1 to the resources:
  r-a (brand-a) -> same-tenant
  r-b (brand-b) -> foreign-tenant
  r-c (brand-c) -> foreign-tenant

  finding: r-a same-tenant privilege-escalation
real leak (foreign holding C) found: false
false positive on its own brand A: true
```

**The tool is wrong twice in one run.** A lawful read by the holding of its own
brand A is declared a privilege escalation. The real cross-holding leak — the read
of brand C — is not noticed at all, because "a foreign tenant" is indistinguishable
to the model from "a foreign tenant inside my own holding".

The second is worse than the first. A false positive is visible and irritating; a
miss looks like a clean run.

## By contour

The six-level breakdown (platform → aggregator → holding → brand operator →
affiliate → player) maps onto the model unevenly.

| Contour | Expressible? | By what exactly |
|---|---|---|
| Brand operator ↔ brand operator | **yes** | different `tenantId`, `foreign-tenant` |
| Player ↔ player inside a brand | **yes** | `ownerAccountId`, `own` against `same-tenant` |
| Roles inside a brand (support, finance, risk) | **yes** | `roleId` × endpoint |
| Anonymous ↔ any contour | **yes** | an account without `tokenEnv` |
| Holding → its own brands, not foreign ones | **yes** (ADR-0013) | `descendant-tenant` |
| Platform → all holdings | **yes** (ADR-0013) | the same, one tier up |
| Affiliate → its own statistics, not the player database | **yes** (ADR-0013) | a tenant under a brand |
| Support or an affiliate over a **set** of brands with no common ancestor | **yes** (ADR-0017) | a set of memberships on the account, the relation taken from the nearest |
| Aggregator / provider (callbacks inward) | **no** | the tool walks from the outside in, and this contour walks from the inside out |

The last row is not about the tree but about what the tree does not express: an
account whose reach is a **set** of nodes with no common ancestor. The tree answers
the question "who is above whom", but not the question "how many nodes does an
account have", and there was nowhere to seat such an account: into one of its own
brands — and a lawful read of the second becomes an escalation; into the common
root — and along with its own it gets the foreign ones too. Closed by a set of
memberships (ADR-0017): the relation is computed for every membership and the
nearest one wins. No sixth `ResourceRelation` value appeared in the process.

The three upper contours all ran into the same thing — the flat tenant — and were
closed by a single change: ADR-0013. The section "The key limitation" above
describes the behaviour **without a declared tree**: it stayed as it was for
compatibility, which is why on a platform with a holding the tree must be declared.

The aggregator contour is a separate case: there the checkable statement reads "a
callback from a provider with someone else's signature is rejected", that is, what
is checked is not the access matrix but the handling of an incoming request. That
is a different tool.

## By access model

**RBAC** — the core of what the tool does. The role × endpoint matrix is its
original task.

**Tenant Isolation** — covered within a single tier. BOLA/IDOR inside a tenant
(`same-tenant`) and cross-tenant leaks (`foreign-tenant`) are found by the status;
since ADR-0011 also list leaks that do not change the status.

**ABAC** — not expressible at all, and that is not an implementation gap. A policy
rule has no place for an attribute: not the time, not the address, not the state of
the session, not the flag "the player contacted support". Part of ABAC is checkable
from the outside in principle — if the tool can **change** an attribute and compare
the outcomes (making requests from different addresses, for instance). Part of it
is not checkable by any means: "access is allowed because the ticket is open"
requires creating a ticket, and that is a write, forbidden by default.

**Segregation of Duties** — not expressible, and it will not be expressed by this
model. SoD is a statement about a **sequence** and about a **pair of actors**:
whoever created the payout does not confirm it. The model is stateless and
considers one request at a time; there is no order in it. On top of that,
confirming a payout is a POST, that is, outside safe mode. Checking SoD from the
outside requires changing the state of the system under test, and it should not be
assigned to this tool without a separate decision.

## What of this is worth doing

In decreasing order of benefit to cost:

1. **A tenant hierarchy.** One capability closes three contours at once and removes
   the "false positive plus miss" pair demonstrated above. The form requires an ADR:
   a path (`holding-1/brand-a`) against explicit parent links. The relation stops
   being three-valued — at the very least "a foreign tenant inside my own subtree"
   against "a foreign subtree" appears.
2. **Request attributes as a dimension of the matrix.** The minimal useful step is
   not full ABAC but the ability to declare two sets of request conditions
   (different origin headers, for instance) and compare the outcomes. It checks the
   statement "this access must depend on the attribute" without trying to model the
   decision logic.
3. **SoD — do not do it in this module.** It requires writes and state; it belongs
   to a different class of tools.

## Added after the industry research

The analyses: [igaming-contours.md](igaming-contours.md), [tenancy-models.md](tenancy-models.md).

**Which contour counts as the tenant is a convention, not a given.** Two affiliates
of one brand give `same-tenant`, and the response-match check will not fire on
them. Declaring an affiliate a tenant is possible — but then the pair "an operator
and its own affiliate" becomes `foreign-tenant`, which is wrong. This is the same
lack of a hierarchy seen from the side, and one more argument for it.

**A brand by subdomain — closed.** A tenant got a `baseUrl` of its own, and the
address of the request is chosen by the resource's tenant. "The token of brand A on
the host of brand B" is now expressible and is covered by a test.

**Field visibility for an affiliate is flags on the account, not a role.** An extra
column in a report does not change the status of the response, so it is BOPLA by
construction. Hence the fix in `resolvePath`: before it, `present` answered `false`
for a field that is in fact in the response — a wrong signal, indistinguishable
from an honest "no".

**The regulatory standards are silent about isolation of one brand from another.**
MGA regulates the isolation of the platform from other tenants of the cloud, UKGC
the licensee's end-to-end view across all white-label domains. The requirement
"brand A does not see brand B's data" is not set by any industry document: it comes
from GDPR and from common sense, but not from the licensing rules. The practical
conclusion for module 2: the anchor for mapping here will be ASVS 8.4.1, not a
gambling standard.

## A caveat

This analysis describes the boundaries of what the model can express, not the
quality of coverage inside them. Inside its own boundaries the tool is verified: 0
false positives on crAPI (17 findings), 0 discrepancies against the oracle on 10
combinations of the reference platform, 0 discrepancies on both modes of VAmPI.

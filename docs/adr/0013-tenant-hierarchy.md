# 0013. Tenant hierarchy

- **Status:** accepted
- **Date:** 2026-08-12

## Context

`tenantId` is a flat string, and exactly one relation between two tenants is
defined: "they do not match". For a platform where a holding stands above the brands
and a platform above the holdings, that is not enough, and the shortfall is not
harmless.

An experiment (fixed by the test `tests/core/tenant-hierarchy.test.ts`): holding H1
owns brands A and B, holding H2 owns brand C. There is nothing to express this with,
so the holding is attributed to one of its own brands and gets
`scope: foreign-tenant`, otherwise the second brand is unreachable. The result of
one run:

```
real leak (someone else's holding C) found: false
false positive on its own brand A: true
```

**The tool is wrong twice at once.** It declares a lawful read an escalation and
misses the real leak between holdings. The second is the heavier one: the run looks
clean. This is the fifth instance of the class "clean ≠ tested" the project has been
fighting from the very start — and the first one built into the model itself rather
than into its use.

Separately: without a hierarchy an affiliate cannot be expressed either. Two
affiliates of one brand give `same-tenant`; an affiliate can be declared a tenant,
but then the pair "an operator and their own affiliate" becomes `foreign-tenant`,
which is wrong. This is the same shortfall seen from the side.

## Decision

Tenants form a forest: a tenant may have a parent. The link is declared
**explicitly**, in a separate field, not encoded inside the identifier.

```yaml
tenants:
  - { id: holding-1 }
  - { id: brand-a, parent: holding-1 }
  - { id: brand-b, parent: holding-1 }
  - { id: holding-2 }
  - { id: brand-c, parent: holding-2 }
```

The old form — `tenants: [tenant-a, tenant-b]` — keeps working and means a forest of
roots with no links.

`ResourceRelation` is extended from three values to five:

| Value | When | Typical intent |
|---|---|---|
| `own` | the owner of the resource is the account itself | access exists |
| `same-tenant` | same tenant, different owner | BOLA inside a tenant |
| `descendant-tenant` | the resource is **lower** in the tree | a holding reads its own brand — usually allowed |
| `ancestor-tenant` | the resource is **higher** in the tree | a brand reads the holding level — usually not allowed |
| `foreign-tenant` | there is no kinship at all | someone else's holding — never allowed |

Three reasons to separate `descendant` and `ancestor` rather than reduce them to
"related": the intents are opposite (downward is usually allowed, upward usually
not); a leak upward and a leak downward are different defects with different cost;
and by merging them we would get exactly the loss of distinction this ADR is being
written about.

**Compatibility is complete.** With no links declared all tenants are roots,
`descendant` and `ancestor` never arise once, and the behaviour matches the old one
byte for byte. The existing polygon configurations do not change.

### Why explicit links and not a path in the identifier

The form `holding-1/brand-a` is shorter and needs no new section. Rejected.

It turns the identifier into a structure that has to be parsed — and identifiers
come from configuration written by a human. A typo in the prefix silently re-parents
a tenant: `holding-l/brand-a` (a Latin `l` instead of a one) becomes a separate root,
`descendant-tenant` turns into `foreign-tenant`, the rule stops applying, and the
finding disappears. This scenario has already happened: a stray space in a tenant
name hid a real leak, which is why the strict check against the `tenants` list
appeared. A path in the identifier multiplies that same risk and gives no way to
check it — any string with a `/` is syntactically valid.

An explicit link is checkable: the parent must exist in the list, a cycle must be
detected. A typo becomes an error at startup rather than a quiet change of meaning.

On top of that, it agrees with the project's principle: structure is not derived
from strings that came from outside.

## Alternatives

**Keep the flat model and describe the limitation in the documentation.** Done as a
temporary measure (README), but rejected as a decision: a tool that gives false
reassurance on a whole class of platforms is not fixed by documentation.

**An arbitrary graph instead of a forest** — a tenant with several parents (a brand
jointly owned by two holdings). Rejected for now: the case is rare, and a graph turns
"above/below" into "reachable by some path", and `ancestor`/`descendant` stop being
mutually exclusive. Come back to it if a real case appears.

**A role instead of a hierarchy** — declare a `holding` role and allow it
everything. Rejected: that is exactly what the current workaround does, and it is
exactly what misses the leak between holdings. A role answers "what may be done",
not "over what".

**Depth as a separate field** (`level: holding | brand`). Rejected: a level does not
establish kinship. Two brands of different holdings have the same level and must not
be kin.

## Consequences

The class the ADR was written for is closed: a holding, a platform above holdings
and an affiliate under a brand become expressible. `unexpected-denial` acquires a
meaning it did not have: "the holding did not see its own brand" is now a statement
that can be formulated, and for multi-brand gambling a regulatorily significant one
as well (see `docs/research/igaming-contours.md` on the UKGC requirement for a
licensee's end-to-end view).

The price: the policy becomes richer, and it is easier for a human to make a mistake
in it. Five `scope` values instead of three is five ways to miss. The mitigation is
the strict check of the tree at startup and the rule "anything uncovered falls
through to `fallback`", which stays conservative.

Revisit if several parents for one tenant become necessary.

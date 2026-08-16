# 0017. An account in a set of tenants

- **Status:** accepted
- **Date:** 2026-08-13

## Context

ADR-0013 gave tenants a tree, and an account one node in it. That is enough when
the account's reach coincides with a subtree: a holding over brands, the
platform over holdings, an affiliate under a brand.

It is not enough where the reach is a **set** of nodes with no common ancestor
other than the root. Support staff over brands A and C from different holdings;
an affiliate working with two brands of a group of three; a partner cabinet
where the boundary of "his brands" runs inside a reporting endpoint rather than
along the address.

### First: is the case real

Checked against `docs/research/`, and the answer came out narrower than the
question. Three things have to be separated, because the tree covers two of them.

**A person belongs to several tenants — yes, but that is not our case.** Auth0
Organizations explicitly allow membership in several organizations with roles
inside each; the token, however, carries **one** `org_id`, and the requirement
on the API is phrased as segmentation by it (`tenancy-models.md` §2.3). From the
outside that means: one set of credentials, one surface. Such a person is
already expressible as several accounts, one per set, and that produces no false
findings. The same with Okta and a separate org per tenant (§2.4).

**One set of credentials over a subtree — also covered.** A Stripe Connect
platform reaches connected accounts with its own key (§2.1), a program manager
in BaaS sees the clients of its own program (§3.1), a PayFac sees its sponsored
merchants (§3.2), agent networks are nested recursively
(`igaming-contours.md` §1.2). These are subtrees, and ADR-0013 expresses them.

**One set of credentials over a set that is not a subtree — that is the gap.**
It is confirmed by two sources of different kinds. The first: among Okta's
standard configurations there is "one org, groups as the tenant abstraction"
(§2.4) — group membership is a set by construction. The second, domain-specific:
the affiliate report in TheAffiliatePlatform carries a `Brand` column, that is,
one cabinet covers several brands of a program, and the boundary runs inside an
endpoint (`igaming-contours.md` §3.1). In our model an affiliate sits **under** a
brand; an affiliate on two brands out of three is not expressible even inside a
single holding.

What the sources do **not** have is confirmation that arbitrary sets are
widespread. No public account of support staff over a subset of brands could be
found; ADR-0013 rejected an arbitrary graph as a rare case, and that rejection
stands for a **tenant** with several parents. The subject here is different: a
set on an **account**.

### What is wrong with the workaround

What decides is not the rarity of the case but the cost of working around it.
All three ways of expressing such an account with a tree were checked by running
them (`tests/core/tenant-set.test.ts`; the platform hands support staff all four
brands, A and C are what it is meant to get, and there must be two findings):

```
seat it on brand-a, allow same-tenant
  findings: r-b, r-c, r-d
  real leak (b and d) found: true
  false positive on the legitimate brand: true

seat it on brand-a, open up foreign-tenant (to remove the false alarm on C)
  findings: r-a
  real leak (b and d) found: false
  false positive on the legitimate brand: true

seat it at the common root platform, allow descendant-tenant
  findings: —
  real leak (b and d) found: false
  false positive on the legitimate brand: false
```

The first way lies visibly: one of the three findings is invented, and the
reader has nothing to tell it from the real ones. The second — the way this
false alarm is removed in practice — lies silently: both real leaks disappear,
while the nitpick about the account's own brand remains. The third gives a clean
run with a live leak.

This is exactly the pair of errors ADR-0013 was written for, and the same
"clean ≠ tested" class. The only difference is that now it shows up not on a
holding but on an account whose reach a holding does not describe.

## Decision

An account gets a **set of memberships**: `tenants` instead of `tenant`.

```yaml
accounts:
  - id: sara
    role: support
    tenants: [brand-a, brand-c]
```

In the core this is a union, not two optional fields: `SingleTenantAccount`
(`tenantId?`) or `MultiTenantAccount` (`tenantIds`). Writing both at once is
impossible by type, not by convention.

`relationOf` computes the relation for **every** membership and returns the
nearest one, in the same order the checks have stood in until now: `own` →
`same-tenant` → `descendant-tenant` → `ancestor-tenant` → `foreign-tenant`. On a
set of one element the result matches the old one byte for byte — that is the
compatibility mechanism, not a separate branch "for old configurations".

**No sixth `ResourceRelation` value is introduced.** A set is a property of the
account, not a new kind of kinship; the resource still lies in one tenant, and
the question "what is this to me" has the same five answers. A value like
`multi-tenant` would silently narrow the existing rules: cells that answered to
`scope: same-tenant` would stop falling under it, would go to `fallback` — and a
legitimate read would become a finding, while a finding would slip out from
under the rule. The same argument is written in ADR-0013 against merging
`descendant` with `ancestor`, and in the code of `relationOf` against a separate
value for an account outside of tenants.

Two checks at startup, both against a silent substitution of meaning:

- **a duplicate in the set** is rejected: it does not affect the relation, but
  it hides the second, real tenant that was meant to be written;
- **a nested membership** (`[holding-1, brand-a]`) is rejected: the brand's
  resources would stop being `descendant-tenant` and become `same-tenant`, the
  rule written for the top-down view would stop applying, and the cell would go
  to `fallback`. Membership in the ancestor already covers the subtree — the
  second entry does not refine the classification, it changes it.

The configuration does not accept a set of one element: that is `tenant`, and
two ways of writing one and the same meaning would diverge in the reading and in
the report.

The `identical-response-across-tenants` check is generalized by the same move:
instead of equality of tenants, a non-empty intersection of the sets; instead of
kinship of two nodes, kinship of at least one pair. Support staff over brands A
and B legitimately sees the rows of a user of brand A, and a match of responses
on that pair says nothing about isolation — just as a match between two
neighbors inside one tenant said nothing.

## Alternatives

**Do nothing, limiting ourselves to documentation.** Rejected on the results of
the experiment above: the tool does not merely "fail to express" the case, it
produces false findings or false silence on it. This is the very argument with
which ADR-0013 rejected the same alternative.

**Several "memberships" each with a role of its own** (`[{tenant: a, role: support},
{tenant: c, role: viewer}]`). The shape is more honest: in Auth0 roles really
are assigned inside an organization. Rejected for now, because the role stops
being a property of the account and becomes a function of the cell:
`resolveExpected` takes a `roleId`, and it would have to be chosen by the
resource's tenant — in the diff, in the trustworthiness check, in defect
grouping and in the report. The price is out of proportion: from the outside an
account has one set of credentials, and the tool cannot tell "denied by role"
from "denied by tenant" anyway (`tenancy-models.md` §7.2). Come back to this if
a platform appears where the roles of one set of credentials in different
tenants differ observably.

**A separate declaration "this account sees these tenants" next to the policy.**
Rejected: an account's membership already lives in the account's description,
and a second place for it means two sources of truth about one and the same
thing. On top of that, a declaration next to the policy would read as a
permission ("sees"), and this is not a permission but a fact about the platform:
what an account is meant to get is decided by the rules.

**Collapse the set to the first tenant in the core, keeping it only in the
configuration.** Rejected outright: this is exactly the `PRIMARY_TENANT_ONLY`
defect, which now stands on the polygon as a switch.

## Consequences

An account whose reach is a set of nodes becomes expressible: support staff over
brands of different holdings, an affiliate over part of a group's brands, a
partner in two programs. The converse statement also becomes sayable — "the
second brand must be accessible": before the set there was nothing to write it
with, so a denial on the second brand matched the expectation and did not count
as a defect. On the polygon this is a switch of its own, the only one that gives
`unexpected-denial`.

Compatibility is complete and was checked by running it: before the polygon was
extended, all 19 previous combinations agreed with the old oracle without a
single edit.

The price is the same as ADR-0013's, and it grows in the same place. A set of
memberships written wider than the account's reach really is quietly widens what
is expected, and a finding disappears. The only things working against that are
the checks at startup (duplicate, nesting, unknown name) and the fact that the
set is declared by a human, not derived by the tool. A separate ADR is not
needed here: this follows from ADR-0006 and is common to the whole policy.

Two places behave differently for such an account, and both are worth knowing in
advance:

- **No base address of its own is chosen.** The host is taken from the
  resource's tenant; where there is no resource (a list endpoint, a canary), an
  account with a set has no single "own" host, and the request goes to the
  common address. The tool will not guess which of the brands to count as home.
- **The names of the set are not printed in the evidence of a finding.** The
  `tenant` and `otherTenant` fields are filled in only for an account with a
  single tenant: names joined by commas would stand in a field of real
  identifiers and would be read as a name. The names are given by the finding's
  title.

A debt remains in the report, and this ADR does **not** close it: the `accounts`
section in `src/report/build.ts` prints only the `tenant` field for an account,
so for an account with a set the tenant is missing from the report entirely. For
now that looks like "an account outside of tenants", though it is in two. The
fix is one line — carry `tenants` over next to `tenant` — but the file is being
edited in parallel, and doing it here would mean creating a conflict. Until
then, a report on such a run is incomplete in its inputs, though every verdict
in it is correct.

Revisit if different roles in different memberships of one account are needed,
or a tenant with several parents (the latter is still an open question from
ADR-0013; a set on an account does not solve it and does not try to).


## Addendum of 2026-08-16: the report prints the set

The Consequences section above ends on a debt: "the `accounts` section in
`src/report/build.ts` prints only the `tenant` field for an account, so for an
account with a set the tenant is missing from the report entirely. For now that
looks like 'an account outside of tenants', though it is in two."

It is paid. `src/report/build.ts` writes `tenants` beside `tenant`, taken from
the parsed account, so `sara-ac` — declared on the reference platform as
`tenants: [tenant-a, tenant-b]` — reaches the report carrying both names, and a
row for it under request conditions carries them too, since such a row is built
from the original account. The paragraph is kept because that is how this repository records a
change of state — the debt was real, it was named here, and it is closed here —
but a reader reaching that paragraph today would otherwise conclude that an
account in a set of tenants is indistinguishable in a report from an anonymous
one. It is not, and the difference matters: `anonymous: true` is the mark that
makes "the anonymous account was denied everywhere" provable, and an account with
a set carries no such mark.

The other two consequences named above are unchanged and still hold: such an
account chooses no base address of its own, and the names of its set are not
written into `evidence.tenant` / `evidence.otherTenant` — those fields are filled
in only for an account with a single tenant.

Found by the audit of 14 August 2026 (J-11).

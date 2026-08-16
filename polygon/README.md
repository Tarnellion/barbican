# The reference platform as an oracle

A minimal multi-tenant API with switchable defects. It exists to test `barbican`
itself: without it, tenant isolation — half of what the tool is for — was tested
only against synthetic fixtures, while the public polygons (VAmPI, crAPI) are
**single-tenant**, and "another tenant" cannot be modelled in them.

Zero dependencies, `node:http` only. It listens on `127.0.0.1` and nowhere else.

## The main requirement

**Every defect must be distinguishable by the tool.** A defect that gives
nothing away tests the reader's patience, not the tool. That is what burned the
VAmPI switch: the `vulnerable=0/1` modes differed by body, and the reports
matched byte for byte (ADR-0009).

**Ten defects out of twelve** are **visible in the response status**: 200 where a
correct implementation answers 403 or 451, or — in one of them — 403 where a
correct one answers 200. Two of those ten live on a **write** and are reached only
with `--unsafe-methods`; without the flag `orders.cancel` is skipped, and the skip
appears in the report with its reason.

The remaining two work differently. `POLYGON_DEFECT_LIST_NO_FILTER` on
`GET /v1/orders` changes no status at all — 200 both with the defect and without
it. It is distinguishable only through a **signal over the body** (ADR-0011): a
correct implementation gives different tenants different lists, a defective one
gives the same list, and the digests match. The second one is the same kind —
`POLYGON_DEFECT_SCOPE_ALL_HONORED`: there the filter is in place, but a hidden
query parameter removes it, and again the status does not change.

Before ADR-0011 this endpoint was deliberately left without a defect, on the
grounds that "the difference is visible only in the body, that is, for the tool
it does not exist". Now it does.

The requirement has a second half, less obvious: **two different defects must be
distinguishable from each other**. A defect whose findings match another's cell
for cell tests no more than that other one does — and a platform on which they
match testifies not to the defects but to its own poverty. That is exactly what
happened with visibility disclosed up the tree while the tree had two levels:
see "The defect that only depth catches".

## What is inside

### Tenants

Two holdings, a brand under each, and under one of the brands an affiliate
(ADR-0013):

```
holding-1 ── tenant-a ── affiliate-a1
holding-2 ── tenant-b
```

The anonymous account is deliberately absent from this tree: it is declared
**outside of tenants**, and it has no `tenant` field. A service root named
something like `none` would sit in the same value space as real tenants, and on
a platform where a tenant really is called that, it would silently make the
anonymous account its neighbor.

The second holding is there precisely as a **foreign branch**. Without it
`tenant-b` would just be a root, "a leak into a foreign holding" would be no
different from "a leak to a tenant with no kinship", and the new defect would be
testing the old relation.

The third level is there for a related reason, but it is about the tree's
**depth**, not its width. In a two-level tree every account has exactly one
ancestor, so "the direct parent" and "any ancestor" are the same set, and an
implementation that walks up one step instead of the whole chain behaves
indistinguishably from one that walks the chain. `affiliate-a1` has **two**
ancestors: `tenant-a` one step away and `holding-1` two.

Kinship is declared as a separate field in both `server.mjs` and
`barbican.run.yaml`. The form `holding-1/tenant-a` is shorter, but it turns an
identifier into a structure to be parsed: a typo in the prefix silently makes the
brand a root of its own, `descendant-tenant` becomes `foreign-tenant`, the rule
stops applying — and the finding disappears.

### Accounts

| Account | Role | Tenant | Token from variable | How it is presented |
|---|---|---|---|---|
| `alice-a` | user | tenant-a | `POLYGON_TOKEN_ALICE_A` | `Authorization: Bearer` |
| `bob-a` | user | tenant-a | `POLYGON_TOKEN_BOB_A` | `Authorization: Bearer` |
| `carol-b` | user | tenant-b | `POLYGON_TOKEN_CAROL_B` | `Authorization: Bearer` |
| `dave-b` | user | tenant-b | `POLYGON_TOKEN_DAVE_B` | `Authorization: Bearer` |
| `admin-a` | admin | tenant-a | `POLYGON_TOKEN_ADMIN_A` | the `opsid` cookie |
| `helen-h1` | holding | holding-1 | `POLYGON_TOKEN_HELEN_H1` | `Authorization: Bearer` |
| `ivan-af1` | affiliate | affiliate-a1 | `POLYGON_TOKEN_IVAN_AF1` | the `X-Affiliate-Key` header |
| `sara-ac` | support | tenant-a **and** tenant-b | `POLYGON_TOKEN_SARA_AC` | `Authorization: Bearer` |
| `anonymous` | anonymous | — outside of tenants | no token | — |

Two users per brand, and not for symmetry: without a second user of the same
tenant there is no telling **BOLA inside a tenant** from a **cross-tenant leak**,
both would look like "access to something not one's own". The anonymous account
tests the claim "this endpoint is not public".

`helen-h1` sits **on the holding itself**, not on one of its brands.
Attributing the holding to a brand is possible — that is what had to be done
before ADR-0013 — but then the holding's own brand becomes a "foreign tenant",
and the tool is wrong twice at once: it picks on a lawful read of its own
brand and misses a real cross-holding leak. There is deliberately no second
holding account: `holding-2` is needed as a branch of the tree, not as another
set of cells.

`ivan-af1` sits **on the third level** and exists for exactly the reason the
third level itself exists: it is the only account with two ancestors, and
therefore the only one on which you can see whether the implementation walks the
whole chain or a single step. It is meant to get its own statistics only; the
brand surface — both the order list and the brand's settlement statement — is
closed to it, and the holding level all the more so. There is no second
affiliate: it would give ten cells and not one new claim — the first one already
carries them all.

`sara-ac` is the only account that sits **not in a node of the tree but in a set
of nodes** (ADR-0017): the brands `tenant-a` and `tenant-b` lie under different
holdings, and on this platform they have no common ancestor at all. A tree
cannot express such an account in any way, and that has been tested by a run —
see "The mutation the account was created for". It is meant to get the orders of
both of its brands and the brand's settlement statement; the holding level it is
not, and that is an `ancestor-tenant` derived **not from a single** tenant:
`holding-1` stands above the membership in `tenant-a` and has no kinship with
the membership in `tenant-b`. There is no second account like it: a set of three
brands would give cells, but not one new claim.

### Resources

| Resource | Tenant | Owner |
|---|---|---|
| `A-1001` | tenant-a | alice-a |
| `A-1002` | tenant-a | bob-a |
| `B-2001` | tenant-b | carol-b |
| `B-2002` | tenant-b | dave-b |
| `H1-0001` | holding-1 | — the holding's summary statement |
| `A-0001` | tenant-a | — the brand's summary statement |

The summary statements have no owner, and that is **not an oversight**: a
settlement statement belongs to the tenant as a whole, and it is nobody's own —
not even `helen-h1`'s, for whom `H1-0001` is `same-tenant`, not `own`. These are
the resources that bring the `ancestor-tenant` relation into the matrix: for
`alice-a`, `bob-a` and `admin-a` the holding's statement lies **higher** up the
tree. Without them, of the two relations introduced by ADR-0013, only
`descendant-tenant` was tested by an end-to-end run.

For `carol-b` and `dave-b` both statements are `foreign-tenant`: `holding-1` is
not their ancestor, and neither is `tenant-a`. These four cells work as a control
and must stay a denial under any flag. A second statement, on `holding-2`, is
deliberately absent: it would add eight cells and not one new claim — the control
already exists.

`A-0001` was added for the sake of depth, and it carries four different relations
at once: `same-tenant` for the brand accounts (allowed), `descendant-tenant` for
the holding (allowed — the licensee's consolidated view goes downwards),
`foreign-tenant` for the other brand (never allowed) and `ancestor-tenant` for
the affiliate — **one step away**, whereas `H1-0001` is `ancestor-tenant` two
steps away for it. The relation in these two cells is one and the same while the
distance differs, and the whole difference between the two upward-disclosure
defects lives exactly here.

### Endpoints

| id | Method and path | Correct behaviour |
|---|---|---|
| `health` | `GET /v1/health` | 200 to everyone, the anonymous account included |
| `orders.list` | `GET /v1/orders` | 200 to an authenticated account, 401 to the anonymous one |
| `orders.read` | `GET /v1/orders/{orderId}` | 200 to the owner, to the admin of its own tenant, to the holding — on resources of its brands, and to support — on resources of the brands in its set; 403 to the affiliate always; 403 otherwise |
| `statements.read` | `GET /v1/statements/{statementId}` | 200 to an account of the same tenant as the statement, and to any tenant above it; 403 to everyone else |
| `affiliate.stats` | `GET /v1/affiliate/stats` | 200 to the affiliate, 403 to every other role, 401 to the anonymous one |
| `admin.accounts` | `GET /v1/admin/accounts` | 200 to the admin, 403 to a user, 401 to the anonymous one |
| `orders.cancel` | `POST /v1/orders/{orderId}/cancel` | 200 to the owner, to the admin of its own tenant, and to support — on the orders of the brands in its set; 403 to the affiliate and to the holding always; 403 otherwise; 401 to the anonymous one |

`orders.cancel` is the seventh endpoint and the only **write** one. Without
`--unsafe-methods` the tool does not touch it: it lands in `skipped` with the
reason `unsafe-method`, and that skip is itself a claim the oracle checks. With
the flag the same matrix machinery walks it — a write cell is not a special case,
it is a cell whose method changes state.

The holding is denied here while it is allowed on `orders.read`, and that is the
point of the endpoint rather than an inconsistency: a licensee's sweeping read of
its brands is not a right to act on their orders. `authorizeCancel` is a branch of
its own for exactly that reason — on a platform where reading and writing shared
one rule, the difference would be unstateable.

The write is deliberately inert: `cancelled` is set and never consulted. The tool
probes each cell once, but the cells share resources, and a write whose outcome
depended on which cells were probed before it would make the oracle a function of
the traversal order rather than of the platform.

The parameter of `statements.read` is named differently from the one of
`orders.read`, and that is not cosmetic: a resource is bound to an endpoint by
matching path parameter names, so orders are not substituted into statements,
nor a statement into orders. The sets of cells of the two endpoints do not
intersect by construction.

Both statements live on **one** endpoint, even though the brand one would ask
for its own by name. A separate endpoint would spread the two upward-disclosure
defects across different addresses, and they would become distinguishable by
endpoint — that is, the check would stop being a check of the tree's depth,
which is what it exists for. Here both statements are read by one authorization
function, and the only thing by which "a step up" differs from "the whole chain"
is a single cell.

`affiliate.stats` has no switch at all and works in two ways at once: it is the
affiliate's canary — the one place where its token must give 200, so a wrong
token will stop the run instead of passing itself off as a lawful denial — and a
control, on which an extra finding would mean a false positive. Neither `health`
(it answers 200 without a token too, that is, it tests nothing) nor `orders.list`
(declared closed to it, and a canary on it would stop the run with a false
alarm) will do as its canary.

Authentication is static tokens from the environment. There is no login:
`barbican` does not obtain tokens, the operator puts them into the variables
himself (ADR-0008).

### Three surfaces, three schemes

The platform accepts a token **not in one way for everyone**, but by the
account's surface: the customer API takes `Authorization: Bearer`, the operator
console the session cookie `opsid`, the affiliate cabinet a key in the
`X-Affiliate-Key` header. That is how multi-brand platforms are built
(`docs/research/igaming-contours.md`, §1.2, §3.1), and that is how it is declared
in `barbican.run.yaml` through `authSchemes` (ADR-0016).

What matters is that the platform does not accept a token presented over the
**wrong** transport: `authenticate` finds the account by value and separately
verifies how it was presented. Without that verification the check would be a
stage prop — a tool that sends everything as Bearer would sail straight through
it, and the polygon would be confirming that something works which the tool does
not do.

The canaries catch this, and not in theory: with a configuration where the
overrides are removed (that is, one expressible before ADR-0016), the run stops
at startup —

```
Accounts are not authenticated, the run stopped:
  admin-a: orders.list returned 401
  ivan-af1: affiliate.stats returned 401
```

— while with the full configuration on the same deployment it gives the same 80
cells and zero findings.

That the transport verification is not decorative has been tested by mutation.
`matchesScheme` is replaced with `return true` — the platform starts accepting
any token in any way — and the same trimmed configuration passes **clean**: 80
cells, zero findings, exit code 0. That is, without this verification the polygon
would be confirming that scheme overrides work on a tool that ignores them.

## Defects

All twelve are off by default. The last two live on a write endpoint and are
reached only when the tool runs with `--unsafe-methods`; the oracle carries that
flag on the variant rather than on the command line, because whether a write is
probed is a property of the claim being checked, not of how the script was called.

A value of `1` or `true` turns one on; `0`/`false`/
absence turns it off. **Any other value is a refusal at startup**: a silently
accepted typo like `=yes` would give a run with no findings, indistinguishable
from a check of a correct platform.

| Variable | What it breaks | Cells |
|---|---|---|
| `POLYGON_DEFECT_CROSS_TENANT` | no tenant filter in `orders.read` for the brand accounts: another tenant is served 200 instead of 403 | 10 |
| `POLYGON_DEFECT_NO_ROLE_CHECK` | the role is not checked in `admin.accounts`: any non-administrator gets 200 instead of 403 | 7 |
| `POLYGON_DEFECT_IDOR_SAME_TENANT` | IDOR inside a tenant in `orders.read`: another user's order in one's own tenant is served 200 instead of 403 | 4 |
| `POLYGON_DEFECT_CROSS_HOLDING` | the holding rollup is not limited to its own subtree: `orders.read` serves the holding a resource of a foreign holding with 200 instead of 403 | 2 |
| `POLYGON_DEFECT_ANCESTOR_LEAK` | visibility of the summary statements is disclosed upwards along the **whole chain of ancestors**: `statements.read` serves an account the statement of any tenant above it | 6 |
| `POLYGON_DEFECT_PARENT_LEAK` | the same upward disclosure, but **exactly one level**: the direct parent's statement is visible, not the whole chain's | 5 |
| `POLYGON_DEFECT_PRIMARY_TENANT_ONLY` | the set of memberships is collapsed to the first tenant: support over two brands is denied the second one — 403 where access is meant to be granted | 2 |
| `POLYGON_DEFECT_LIST_NO_FILTER` | no tenant filter in the brand list `orders.list`; the status does not change, it is visible only by body | 6 pairs |
| `POLYGON_DEFECT_GEO_BYPASS` | the jurisdiction of the request is not checked: orders are served from a prohibited country too — 200 instead of 451 | 19 |
| `POLYGON_DEFECT_SCOPE_ALL_HONORED` | a hidden `?scope=all` removes the tenant filter in the brand list; the status does not change, it is visible only by body | 6 pairs |
| `POLYGON_DEFECT_WRITE_CROSS_TENANT` | no tenant filter on a **write**: `POST /v1/orders/{orderId}/cancel` cancels an order of another tenant — 200 instead of 403 | 10 |
| `POLYGON_DEFECT_WRITE_NO_OWNER_CHECK` | no owner check on a **write**: a player cancels the order of a neighbour inside their own tenant — 200 instead of 403 | 4 |

`primary-tenant-only` stands apart in this list: it is the **only defect of the
platform that shows itself as a denial** rather than as excess access, and
therefore the only one that gives `unexpected-denial` instead of
`privilege-escalation`. It is as plausible as `parent-leak`: the token carries a
single "tenant" field because everyone used to have one tenant, and the set of
memberships never reaches authorization. Before ADR-0017 such a defect would have
been indistinguishable from correct behaviour — there was nothing to declare the
second brand one's own with, and a denial on it would have matched the
expectation.

The sets of cells do not intersect — **except for one pair**, and that exception
is exactly what is under test here. `PARENT_LEAK` is wholly contained in
`ANCESTOR_LEAK`: disclosure one step up is a special case of disclosure along the
whole chain. So `all-seven` must match `all-six` cell for cell, and that too is a
testable claim, not a coincidence of numbers. For the other flags the rule is
unchanged: composite combinations must be the union of the single ones, `all-six`
gives exactly 10+7+4+2+6+6 = 35, and `all-eight` the same 35 plus the two cells
of `primary-tenant-only` = 37.

`cross-holding` is a separate flag rather than a special case of `cross-tenant`,
because it is a separate path in the code: "my orders" and "my group's orders"
are different queries with different filters, and they break independently. In
`server.mjs` the holding surface is pulled out into a separate branch of
`authorizeOrder` in its entirety, so the brand branch stayed untouched and the
previous combinations stayed as they were.

`ancestor-leak` is the mirror of `cross-holding`, and a separate flag for the
same reason. That one breaks the view **top-down** (the holding sees a foreign
branch), this one **bottom-up** (a brand sees the level of its group). ADR-0013
separates `descendant-tenant` and `ancestor-tenant` precisely because these are
different defects with different costs; merging them into one flag would put back
on the polygon a distinction the tool was taught to make. It is implemented as a
plausible mistake, not as "serve it to everyone": the platform asks "a statement
of my tenant **or of any of its ancestors**?" instead of "of my tenant?" — the
classic case of resolving a scope in the wrong direction.

Role has no effect on `ancestor-leak`: `admin-a` is hit exactly like the users of
its brand, because the defect is in the relation to the resource, not in the role
check. The other brand is not hit at all — `holding-1` is not its ancestor.
Tested by mutation: an implementation that serves the statement to all comers
immediately produces findings beyond the oracle.

The anonymous account is hit by no flag: authentication is checked before
authorization, and without a token the answer is 401 in any mode.

The administrator is not hit by `idor-same-tenant`: resources of its own tenant
are allowed to it by policy, and it gets 200 on a correct platform too.
`cross-tenant`, on the other hand, hits it as well — another tenant is not
allowed to an admin.

The holding is hit neither by `cross-tenant`, nor by `idor-same-tenant`, nor by
the two upward-disclosure defects: it has an order authorization branch of its
own, and the summary statements are those of its own tenant and of its brand,
that is, allowed to it on a correct platform (above `holding-1` the tree does not
go at all). `no-role-check`, on the other hand, hits it as well: it is just as
much a non-administrator.

The affiliate is not hit by `cross-tenant`, `idor-same-tenant`, `cross-holding`
or `list-no-filter`: the brand order surface is closed to it by a separate branch
that stands before all the flags. That is not over-caution but the condition on
which the previous sets survive — tested by mutation: remove that branch and
`cross-tenant` gets four cells beyond the oracle, and `list-no-filter` three.
`no-role-check`, on the other hand, hits the affiliate as well (it is just as
much a non-administrator), and so do both upward-disclosure defects — each
differently, which is the very reason it exists.

Support over two brands is not hit by `cross-tenant`, `idor-same-tenant`,
`cross-holding` or `list-no-filter`, and for the same reason: it has its own
branch in `authorizeOrder` and in the list. The branch is not a concession but a
necessity — the brand one below asks "is the order's tenant equal to the
account's tenant?", and this account does not have one tenant, so a shared branch
would either serve too much or deny the second brand, that is, it would build a
defect into the correct mode. `no-role-check`, on the other hand, hits it as
well, and both upward-disclosure defects give it one and the same cell — the
`holding-1` statement lies exactly one step above its membership in `tenant-a`.
It deliberately has no branch in `authorizeStatement`: the statement visibility
rule for support is the same one, and a branch of its own would mean that the
upward-disclosure defects do not hit it — a claim nobody has tested.

## The defect that only depth catches

`parent-leak` is not one more flag in the list but a test of a claim about the
platform itself: **a two-level tree does not tell "walked up a level" from
"walked up the chain"**.

Both implementations answer one question — "is a statement lying above the
account visible to it" — and differ by one line:

```
ancestor-leak:  isBelow(account tenant, statement tenant)      the whole ancestor chain
parent-leak:    parentOf(account tenant) === statement tenant  exactly one step
```

While the tree has two levels, a brand account has exactly one ancestor, and both
lines give the same result on every cell. The third level breaks that
coincidence: `ivan-af1` has two ancestors, and the holding's statement lies
**two** steps away from it.

| Cell | steps up | `ancestor-leak` | `parent-leak` |
|---|---|---|---|
| `alice-a` × `H1-0001` | 1 | 200 | 200 |
| `bob-a` × `H1-0001` | 1 | 200 | 200 |
| `admin-a` × `H1-0001` | 1 | 200 | 200 |
| `ivan-af1` × `A-0001` | 1 | 200 | 200 |
| `ivan-af1` × `H1-0001` | **2** | 200 | **403** |
| `carol-b`, `dave-b` × both | no kinship | 403 | 403 |

One single cell tells them apart — the last row, the one with the two. It does
not exist in a two-level tree, and there the two defects are indistinguishable.

### Ablation: the same by a run, not by reasoning

The claim has been tested by a run. The account `ivan-af1` and the tenant
`affiliate-a1` are removed from the configuration — nothing else — and the same
two flags are run against the resulting two-level tree and against the full one:

```
cp polygon/barbican.run.yaml /tmp/two-level.run.yaml
# cut the ivan-af1 account block and the affiliate-a1 tenant line out of the copy

# on the two-level tree
POLYGON_DEFECT_ANCESTOR_LEAK=1 node polygon/server.mjs &
node dist/cli.js run -c /tmp/two-level.run.yaml -e polygon/endpoints.yaml \
  -r /tmp/two-al.json --rps 50 --concurrency 4
# the same with POLYGON_DEFECT_PARENT_LEAK=1 -> /tmp/two-pl.json
# then both runs with the full polygon/barbican.run.yaml
```

The result:

```
=== two-level tree (affiliate removed) ===
  ancestor-leak: 3 cells, exit code 1
  parent-leak:   3 cells, exit code 1
  THE SETS ARE IDENTICAL — the defects cannot be told apart
    admin-a × statements.read × statement-h1-0001
    alice-a × statements.read × statement-h1-0001
    bob-a   × statements.read × statement-h1-0001

=== three-level tree (affiliate in place) ===
  ancestor-leak: 5 cells, exit code 1
  parent-leak:   4 cells, exit code 1
  THE SETS DIFFER
    only in ancestor-leak: ivan-af1 × statements.read × statement-h1-0001
```

On two levels the sets match cell for cell — that is, a platform carrying only
one of these defects would give no way of telling which one it is. On three they
diverge, and they diverge on exactly the cell that is two steps up.

That is the answer to the question of what the polygon needs a third level for.
Not "for the completeness of the model": without it a whole class of scope
mistakes — resolving one step instead of walking the tree — would be tested for
nothing, while the run would look substantive all the same.

## How to run

### Automatically: verification against the oracle

```
pnpm run build            # verify.mjs runs the built dist/cli.js
node polygon/verify.mjs   # all twenty-five flag combinations
node polygon/verify.mjs ancestor-leak parent-leak  # only the named ones
```

The script brings the platform up for each combination itself, generates random
tokens, runs the tool, verifies the findings against `ground-truth.json` and
prints the discrepancies in both directions — what was missed and what was extra.
The exit code: 0 — everything matched, 1 — there are discrepancies, 2 — the run
could not be made.

Before every run the script verifies that the platform came up with exactly the
flags that were requested (`/v1/health` serves their state). A flag that did not
arrive would otherwise look like a miss by the tool.

The run goes with `--rps 50 --concurrency 4`: the tool's defaults are meant for
someone else's deployment, and here the deployment is our own and runs in a loop.

### Manually

```
export POLYGON_TOKEN_ALICE_A=$(openssl rand -hex 24)
export POLYGON_TOKEN_BOB_A=$(openssl rand -hex 24)
export POLYGON_TOKEN_CAROL_B=$(openssl rand -hex 24)
export POLYGON_TOKEN_DAVE_B=$(openssl rand -hex 24)
export POLYGON_TOKEN_ADMIN_A=$(openssl rand -hex 24)
export POLYGON_TOKEN_HELEN_H1=$(openssl rand -hex 24)
export POLYGON_TOKEN_IVAN_AF1=$(openssl rand -hex 24)
export POLYGON_TOKEN_SARA_AC=$(openssl rand -hex 24)

POLYGON_DEFECT_PARENT_LEAK=1 POLYGON_LOG=1 node polygon/server.mjs &

node dist/cli.js run \
  --config polygon/barbican.run.yaml \
  --endpoints polygon/endpoints.yaml \
  --report /tmp/polygon.report.json \
  --rps 50 --concurrency 4
```

There are no tokens in any file and there must not be: the configuration names
the environment variable, not the value. `POLYGON_PORT` sets the port (8787 by
default) and must match `baseUrl` in `barbican.run.yaml` — `verify.mjs` checks
that, on a manual run watch it yourself. Once they diverge, they would give a
solid wall of denials and a report saying "all clean".

## How to read ground-truth.json

The oracle is written by hand from the access model. That matters on principle: a
reference taken from the tool's own output would be testing the tool for
consistency with itself.

```
tenancy              — in words: who is whose parent and what follows from it
ancestry             — in words: the relation of every account to the summary
                       statements, and which cells work as a control
depth                — in words: how ancestor-leak differs from parent-leak
                       and which single cell tells them apart
combinations[]
  id                 — the name of the combination, also the verify.mjs argument
  flags              — the state of all ten switches
  expectedExitCode   — 0 with no defects, 1 with any of them on
  findings[]         — the cells that must produce a finding
    account          — the account id from barbican.run.yaml
    endpoint         — the endpoint id from endpoints.yaml
    resource         — the resource id; null on endpoints without path parameters
    other            — the second account of the pair, for findings by body checks
    kind             — privilege-escalation (the policy declared a denial, the
                       platform answered 200), unexpected-denial (the other way
                       round: access is declared allowed, the platform denied it)
                       or identical-response-across-tenants
```

A cell is the triple "account × endpoint × resource" (ADR-0010). The comparison
runs over sets, the order in the file does not matter. A finding that is not in
the list is just as much a discrepancy as a missed one: a false positive
devalues the tool no less than a miss.

## The defect that permissions cannot express

`geo-bypass` stands apart more than the rest. The other nine are about
permissions: who is meant to get what. This one is about **request conditions**:
the role, the tenant and the resource in its cells are the very same as in the
base ones, and "alice-a sees her own order" is true in both cases. The defect is
that it is true when the request is tagged with a prohibited country too.

Two consequences follow from that, and the polygon tests them:

- in the correct mode the same cells give **451**, and there are no findings. The
  tool reads 451 as a denial rather than as "no conclusion can be drawn" —
  otherwise a correct platform would give a wall of `probe-error` exactly where
  it behaves correctly;
- `all-nine` must be a union: the base cells are the same as in `all-eight`, plus
  the same picture of permissions seen under conditions. With one substantive
  exception — the collapsed set of memberships (`primary-tenant-only`) is visible
  in the base conditions as a denial, and under the geo conditions it is not
  visible at all: there a denial is the declared expectation.

## Two kinds of attributes and why both are needed

There are two sets of conditions on the polygon, and not for symmetry.
`geo-blocked` tags the request with a **header**, `wide-scope` with a **query
parameter**. Their paths differ: a header reaches the platform through the set of
headers, a parameter through the building of the address, next to the resource's
parameters. Without the second cell the claim "the parameter arrives" would rest
on a single unit test.

Their defects differ in nature too:

- `geo-bypass` changes the **status**: 200 instead of 451, and it is visible
  through the matrix;
- `scope-all` does not change the status at all and is visible **only by
  comparing bodies within one and the same set of conditions**. The pair "a base
  request against a request with the parameter" is deliberately not compared:
  two variables would change there at once, and a match would say nothing.

And one observation that cost me a wrong oracle. A defect visible in the base
conditions is usually visible under the declared ones as well: `list-no-filter`
leaks both with the added parameter and without it, so seven combinations out of
ten got six pairs each beyond what I expected. The mistake was in the reasoning,
not in the tool — and that is exactly what the oracle is written by hand for. The
price of the decision is named plainly: one breakage of the platform gives two
defect groups that differ only by their conditions.

## The result of the verification

The numbers below come from the run of **13 August 2026**, all twenty-five
combinations, 144 cells, 8 canaries. There are more cells not because the
platform grew: 54 of them are the same endpoints under declared request
conditions (ADR-0019).

Tested separately earlier and still true: when the accounts spread across three
authentication surfaces (ADR-0016), the previous nineteen combinations gave the
same cells and the same numbers. This is a testable claim — **the transport
changes not a single verdict**; had even one number changed, the scheme would be
affecting the result, and it must not.

<!-- verify:begin -->

Cells probed per combination: 144. Combinations: 28.

| Combination | Findings | Oracle expects | Verdict | Exit code |
|---|---|---|---|---|
| `clean`                          | 0 | 0 | match | 0 |
| `cross-tenant`                   | 10 | 10 | match | 1 |
| `no-role-check`                  | 7 | 7 | match | 1 |
| `idor-same-tenant`               | 4 | 4 | match | 1 |
| `cross-holding`                  | 2 | 2 | match | 1 |
| `ancestor-leak`                  | 6 | 6 | match | 1 |
| `parent-leak`                    | 5 | 5 | match | 1 |
| `primary-tenant-only`            | 2 | 2 | match | 1 |
| `cross-tenant+no-role-check`     | 17 | 17 | match | 1 |
| `cross-tenant+idor-same-tenant`  | 14 | 14 | match | 1 |
| `no-role-check+idor-same-tenant` | 11 | 11 | match | 1 |
| `cross-tenant+cross-holding`     | 12 | 12 | match | 1 |
| `ancestor-leak+cross-holding`    | 8 | 8 | match | 1 |
| `ancestor-leak+parent-leak`      | 6 | 6 | match | 1 |
| `all`                            | 21 | 21 | match | 1 |
| `list-no-filter`                 | 12, of them by body 12 | 12 | match | 1 |
| `geo-bypass`                     | 19 | 19 | match | 1 |
| `write-cross-tenant`             | 10 | 10 | match | 1 |
| `write-no-owner-check`           | 4 | 4 | match | 1 |
| `all-four`                       | 33, of them by body 12 | 33 | match | 1 |
| `all-five`                       | 35, of them by body 12 | 35 | match | 1 |
| `all-six`                        | 41, of them by body 12 | 41 | match | 1 |
| `all-seven`                      | 41, of them by body 12 | 41 | match | 1 |
| `all-eight`                      | 43, of them by body 12 | 43 | match | 1 |
| `scope-all`                      | 6, of them by body 6 | 6 | match | 1 |
| `all-nine`                       | 82, of them by body 18 | 82 | match | 1 |
| `all-ten`                        | 82, of them by body 18 | 82 | match | 1 |
| `both-writes`                    | 14 | 14 | match | 1 |

<!-- verify:end -->

**`all-ten` matches `all-nine` cell for cell, and that is a claim, not a
coincidence.** The tenth defect — the hidden `?scope=all` — removes the tenant
filter in the brand list, but with `list-no-filter` on there is no filter there
any more: nothing to remove. A defect invisible in the presence of another one is
a normal thing, and it is good that this is visible as a number rather than as an
argument.

**The table above is written by the run, not by a human.** It sits between
`verify:begin` and `verify:end` markers and is regenerated by
`node polygon/verify.mjs --update-readme`; CI runs `--check-readme`, which fails
when the table and the run disagree. The numbers had already drifted apart twice
before that existed — and the second time the neighbouring paragraph itself
explained why the counts were higher: the explanation got updated, the number
did not.

Compatibility was tested separately and **before** the polygon was extended: the
previous oracle of nineteen combinations agreed with the new core without a single
edit in `ground-truth.json`, `barbican.run.yaml` and `server.mjs` — 0
discrepancies. The set of memberships appears in the model, but on an account
with one tenant it changes nothing.

Findings on `statements.read` carry `"relation": "ancestor-tenant"` — the relation
is not merely declared in the configuration, it travelled through parsing, the
matrix and the diff all the way to a line of the report. And the affiliate's cells
carry it too, both of them: `ancestor-tenant` does not count steps, and the same
relation at different distances is exactly the place where the tool and the
platform diverge differently under different defects.

A separate pair of combinations, `cross-holding` and `ancestor-leak`, gives a leak
in each direction of the tree apart, while `ancestor-leak+cross-holding` gives
both at once; their findings do not intersect in a single cell. The pair
`ancestor-leak+parent-leak` is built the other way round and tests the opposite:
the sets are nested, so the union must match the larger of them — 5, not 9. The
same claim in full is given by `all-seven`, which matches `all-six` cell for cell.

Zero findings with the flags off matters more than detection: a tool that
fabricates findings on a correct platform is as useless as one that misses
defects. Unlike VAmPI, this zero does not come for free — turn a flag on and the
findings appear, which means the criterion works rather than being satisfied
trivially.

With the arrival of the holdings this zero gained weight. It now also asserts
that a lawful read by a holding of its own brand is **not** declared an
escalation — and before ADR-0013 it was, while the run looked substantive all the
same.

With the arrival of the affiliate it gained more: the zero asserts that a lawful
denial to the affiliate on the brand surface is not confused with a defect in any
of the seven modes, and that its own statistics are declared neither a leak nor
an unexpected denial.

### The oracle has been tested for its ability to fail

A defect was planted **in the platform itself**, and the oracle was left
untouched: it states what to expect, and if the platform behaves otherwise the
discrepancy must surface. A mutation the verification would not notice would mean
that the corresponding cell is tested by nobody.

| What is broken in `server.mjs` | Combination | What the verification said |
|---|---|---|
| a leak into a foreign holding always, the flag is ignored | `clean` | found beyond the oracle (2), exit code 1 instead of 0 |
| the `CROSS_HOLDING` flag breaks nothing | `cross-holding` | not found (2), exit code 0 instead of 1 |
| the holding's own brand is closed to it | `clean` | found beyond the oracle (2), both `unexpected-denial` |
| a leak up the tree always, the flag is ignored | `clean` | found beyond the oracle (3), exit code 1 instead of 0 |
| the `ANCESTOR_LEAK` flag breaks nothing | `ancestor-leak` | not found (3), exit code 0 instead of 1 |
| the holding's statement is served to everyone, not only to descendants | `ancestor-leak` | found beyond the oracle (2): `carol-b` and `dave-b` |
| the holding's own summary statement is closed to it | `clean` | found beyond the oracle (1), `unexpected-denial`, exit code 0 |

With the third level of the tree eight more mutations were tested — all about
depth and about the affiliate surface:

| What is broken in `server.mjs` | Combination | What the verification said |
|---|---|---|
| `PARENT_LEAK` walks up the whole chain (`isBelow` instead of `parentOf`) | `parent-leak` | found beyond the oracle (1): `ivan-af1 × statements.read × statement-h1-0001` |
| the `PARENT_LEAK` flag breaks nothing | `parent-leak` | not found (4), exit code 0 instead of 1 |
| `ANCESTOR_LEAK` walks up one step (`parentOf` instead of `isBelow`) | `ancestor-leak`, `all-seven` | not found (1) in both: `ivan-af1 × statement-h1-0001` |
| the affiliate's statistics are open to every role | `clean` | found beyond the oracle (6), exit code 1 instead of 0 |
| the statistics are closed to the affiliate itself | `clean` | the run stopped: the `ivan-af1` canary returned 403, no report, code 2 |
| the separate affiliate branch in `authorizeOrder` is removed | `cross-tenant` | found beyond the oracle (4): `ivan-af1` on all four orders |
| the separate affiliate branch in the `/v1/orders` list is removed | `clean`, `list-no-filter` | found beyond the oracle (1 and 3): an escalation on the list itself was added to the by-body pair with `carol-b` and `dave-b` |
| the brand's statement is not visible to the holding (downward visibility removed) | `clean` | found beyond the oracle (1): `helen-h1 × statement-a-0001`, `unexpected-denial` |

The rows about `unexpected-denial` deserve a word of their own. The tool returns
exit code 0: an unexpected denial does not count as a hole in access, and the run
on its own would look successful. The discrepancy is caught by the comparison
over sets, not by the exit code — which is what the comparison runs in both
directions for. This is also the very `unexpected-denial` that ADR-0013 made
statable: "the holding did not see what it is meant to see" was inexpressible
before the tenant tree.

**The note about exit code 0 is historical.** This very run became the argument
for ADR-0014: a discrepancy is a discrepancy whichever way it points, and today
`unexpected-denial` gives exit code 1. The table rows are left as they are — they
describe what was observed then, not what will be observed now.

The row about the statement served to all comers tests not the presence of the
defect but its **boundary**. The mutation leaves the findings in place and adds
two: the other brand gets a statement it is not meant to have in any mode.
Without this check the oracle would confirm only "something leaked", not "it
leaked exactly up the tree" — and telling those two claims apart is what the tool
was taught to do.

The first three rows of the second table are the main ones. They test neither
that the defect exists nor even its boundary, but that the platform **tells one
step from the chain**: swapping `parentOf` for `isBelow` and the reverse swap are
both caught, and caught on exactly one cell — the one that is two steps away. In
a two-level tree none of these three mutations would have been noticed at all.

The two rows about the affiliate branches test that the new account did not widen
the sets of the previous flags. Both mutations look like harmless simplifications
("why a separate branch if the shared one does the same"), and both immediately
break the previous combinations.

### The mutation the account was created for

With the arrival of `sara-ac` three more mutations were tested. The first breaks
the **platform**, the other two the **tool**, and that matters more here: the
polygon exists to test the tool, not itself.

| What is broken | Combination | What the verification said |
|---|---|---|
| the `PRIMARY_TENANT_ONLY` flag breaks nothing (`server.mjs`) | `primary-tenant-only` | not found (2), exit code 0 instead of 1 |
| `relationOf` computes the relation from the first membership only (`src/core/types.ts`) | `clean` | found beyond the oracle (2), both critical, exit code 1 instead of 0 |
| `identical-response-across-tenants` does not skip related pairs (`src/core/checks/tenant-isolation.ts`) | `primary-tenant-only` | found beyond the oracle (1): `helen-h1 × orders.list × sara-ac` by body |

The second row is the same thing the workaround without a set of memberships
does, only from inside the core. It is here because from the outside it looks
plausible: "take the first tenant, the rest later" — and it gives two
**critical** findings on a correct platform.

The third row explains why the check over the body was generalized to sets. Under
`primary-tenant-only` the `sara-ac` list collapses to the orders of `tenant-a`
and — because the rows have the same shape — matches the `helen-h1` rollup byte
for byte. The pair is related by kinship (`tenant-a` is below `holding-1`), and
the check must stay silent. Remove that rule and a leak that does not exist
appears on the polygon.

The main claim of ADR-0017 — that a tree cannot express such an account — was
tested separately as well. In `barbican.run.yaml` the set
`tenants: [tenant-a, tenant-b]` is replaced with `tenant: tenant-a` (the former
way of describing such an account), the platform untouched:

```
=== clean === flags: all off
  cells probed: 90, canaries: 8, findings: 2 (of them by body 0) (oracle expects 0)
  MISMATCH: found beyond the ground truth (2):
    sara-ac × orders.read × order-b-2001 [privilege-escalation]
    sara-ac × orders.read × order-b-2002 [privilege-escalation]
  MISMATCH: exit code 1, expected 0
  ... Rows by severity: critical 2, high 0, medium 0, low 0
```

Two critical findings on a **correct** platform — a lawful read by support of its
own second brand. There was exactly one way to remove them: open
`scope: foreign-tenant` to the role — and then the real cross-tenant findings
would disappear. The three ways and what each of them breaks are walked through
in ADR-0017.

### Regression of the previous combinations

The previous sixteen combinations gave the previous results on the previous cells
— not "roughly the same", but **the same set of cells and the same exit code**,
checked programmatically against `git show HEAD:polygon/ground-truth.json`. 186
previous finding cells were verified; 0 discrepancies.

A "previous cell" here means literally: an account out of the previous seven, an
endpoint out of the previous five, a resource out of the previous five. Cells
that did not exist before the third level are excluded from the verification —
not because nobody tests them, but because their appearance is not a regression;
the verification against the oracle tests them.

The previous cells survived for a reason. The brand and holding order surfaces
are untouched entirely, and the affiliate has been given branches of its own —
both in `authorizeOrder` and in the list — that stand **before** all the
switches. The new statement lies on the previous endpoint, but for the brand
accounts it is `same-tenant` and allowed to them by policy, while for the other
brand it is `foreign-tenant` and closed, so it produces no finding in any mode.
The new flag takes part in none of the previous code paths.

The number of probed cells became 80 instead of 56. 24 were added: ten are the
affiliate's row across all addresses, seven the new `affiliate.stats` endpoint on
the previous accounts, seven the new statement on the same accounts. In the
previous combinations these cells produce findings three times — and that is
worth naming plainly rather than hiding behind the words "there is no regression":

| Combination | What was added |
|---|---|
| any with `no-role-check` (7 of them) | `ivan-af1 × admin.accounts` — it is just as much a non-administrator |
| `ancestor-leak`, `ancestor-leak+cross-holding` | the affiliate's two cells on the statements |
| `all-six` | the same two |

With the arrival of `sara-ac` the story repeated for the third time, and it is
worth naming just as plainly. The number of probed cells became 90 instead of 80;
ten were added — the support row across all addresses. The tenant tree did not
change at all: the account sits in a **set** of nodes that already exist, and a
set creates no new nodes. The previous cells — an account out of the previous
eight, an endpoint out of the previous six, a resource out of the previous six —
did not change a single outcome: before the polygon was extended the previous
oracle agreed with the new core without edits, the previous surfaces in
`server.mjs` are untouched, and support has branches of its own in
`authorizeOrder` and in the list.

The new cells produce findings in the previous combinations twice:

| Combination | What was added |
|---|---|
| any with `no-role-check` (8 of them) | `sara-ac × admin.accounts` — it is just as much a non-administrator |
| any with `ancestor-leak` or `parent-leak` (6 of them) | `sara-ac × statements.read × statement-h1-0001` — the holding's statement stands one step above its membership in `tenant-a` |

Support deliberately has no branch in `authorizeStatement`: access to the summary
statements is computed for each of its memberships by the shared code. A branch
of its own would mean that the upward-disclosure defects do not hit it — and that
would be a claim nobody has tested.

This repeats what already happened when the holding account arrived: a new
account hits the previous flags right across the matrix, while a new resource or
endpoint hits nobody. The difference between "the previous cells did not change"
and "the numbers in the previous combinations did not change" runs exactly here:
the first must hold, the second need not.

## Boundaries

The platform tests what the tool can see, and does not pretend to be more.
Outside its area is the whole class of defects that require reading bodies:
excessive data exposure, attribution of a leak, mass assignment. The platform
does not implement unsafe methods at all (405): there is no reason to keep a
state-changing endpoint on a deployment that is run in a loop.

### Both ADR-0013 relations are closed (was: only one)

There used to be a note about a debt here: `ancestor-tenant` was covered by no
cell, because it needs a resource belonging to the holding itself, and there was
no such resource on the platform. The debt is closed by the resource `H1-0001`
and the flag `ANCESTOR_LEAK`: both relations introduced by ADR-0013 are now
tested by an end-to-end run, not only by unit tests.

The note is left rather than erased for exactly the reason it was made: for a
polygon, telling "tested" from "not mentioned" is half the point.

### An affiliate under a brand is modelled (was: not modelled)

There used to be a second note about a debt here: the tree had two levels, and
the third case of ADR-0013 — an affiliate under a brand — remained inexpressible
on the platform, although it is expressible in the tool (`isAncestor` walks a
chain of arbitrary length). It was put like this: "the difference shows only on
an implementation that looks at the direct parent instead of the whole chain —
this platform would not catch such a defect".

The debt is closed by the tenant `affiliate-a1`, the account `ivan-af1`, the
statement `A-0001` and the flag `PARENT_LEAK`. The defect named there is now not
only caught but also distinguishable from `ANCESTOR_LEAK` — which is what the
ablation tested, see "The defect that only depth catches".

The note is left rather than erased for the same reason as the previous one: for
a polygon, telling "tested" from "not mentioned" is half the point.

### The set of memberships is modelled, but a leak outside it only goes upwards

An account in a set of nodes exists on the platform (`sara-ac`, ADR-0017), and
the main thing has been tested on it: on a correct platform lawful access to both
brands is not declared a finding, while a denial on the second brand is.

What the platform does **not** show: a leak into a brand that is not in the set.
Orders here lie in exactly two brands, and support has both of them in its set —
among the orders there is no "other brand" for it. A third brand would give such
a cell, but it would cost cells across the whole matrix and would hit the
previous flags (`cross-tenant` and `cross-holding` would get new resources),
while the claim under test — "a tenant outside the set stays `foreign-tenant`" —
is already tested on the summary statements: `holding-1` is not in the set, and
both upward-disclosure defects produce a finding on it.

The limitation is written down rather than worked around: for a polygon, telling
"tested" from "not mentioned" is half the point.

### Depth is tested on three levels, not on arbitrary ones

Three levels tell "a step" from "a chain", but they do not tell "two steps" from
"any number of steps": an implementation that walks up exactly two levels is
indistinguishable from a correct one on this platform. A fourth level would tell
them apart, a fifth the next class, and so on.

We stop at three deliberately. Every level costs cells across the whole matrix,
and the "step versus chain" distinction is the only one of this series that
occurs in code: it comes from a denormalized "parent" field in the token. Nobody
writes an "exactly two levels" bug — there is nothing to make it out of.

### The check over the body and the tree

A holding with a **single** brand sees in its rollup exactly the same orders as
the brand itself. Should the bodies match byte for byte,
`identical-response-across-tenants` would declare a lawful rollup a leak on a
clean platform — that is, it would produce a finding where there is no defect.

This used to be described here as a limitation. That is out of date: the check
has been taught the tree and does not compare pairs related by kinship — see
`src/core/checks/tenant-isolation.ts`, commit `f60bb12`. There will be no false
positive even on a platform where the bodies match.

The second safeguard is kept and remains useful: the rows of the holding rollup
carry the brand (`tenant`) and the brand rows do not, so the bodies differ in
every mode. One protection is in the tool, the other in the shape of the
response; neither cancels the other.

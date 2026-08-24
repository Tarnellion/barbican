# Operator guide

How to declare what gets checked and how to start a run. How to read the result —
see [report.md](report.md).

Most of this document is `barbican run`, which is the subcommand that makes the
traffic. Two more read back what a run left behind and send nothing at all:
[`barbican diff`](#what-changed-since-the-last-run) compares two saved reports,
and [`barbican pack`](#evidence-for-somebody-who-was-not-there) draws an evidence
pack from one. The fourth, `barbican schema`, prints the configuration's JSON
Schema — see [Completion in the editor](#completion-in-the-editor).

**Running against a platform you do not own?** Read
[first-run.md](first-run.md) first: the eleven things to settle before the first
request, in the order they have to be settled. This document explains each of
them; that one is the order.

## The model in one paragraph

You declare **who is meant to get what**. The tool walks the API as each account
and records what came back. A finding is a discrepancy between your declaration
and the observed behaviour.

The main consequence: **an empty policy produces a run without a single finding**,
and that will mean "nothing was declared", not "everything is clean". Expected
access is deliberately not derived from the specification of the API under test —
the spec is generated from the same code, and deriving from it would mean
comparing an implementation against itself
([ADR-0006](https://github.com/Tarnellion/barbican/blob/main/docs/adr/0006-expected-access-declaration.md)).

## What a declaration is made of

### Accounts

```yaml
accounts:
  - id: alice
    role: user
    tenant: brand-a
    tokenEnv: TOKEN_ALICE     # the environment variable name, not the token itself
    canary: orders.list

  - id: anonymous             # no tenant, no tokenEnv
    role: anonymous
```

`tokenEnv` names a variable, not a value: the configuration can be committed and
reviewed. An account **without** `tokenEnv` makes its requests anonymously — that
is how you check the claim that an endpoint is not public. It was the anonymous
account that found the broken authentication in crAPI: a two-dimensional model
with a mandatory token missed that.

**Two accounts may not present the same token.** If they do, the run stops before
the first request and names both accounts and both variables. There is no way for
the tool to notice it afterwards: the platform sees one principal, answers it its
own data with its own rights, every canary passes, every status is what the policy
expects, and the report comes back clean. That clean report is the tool comparing
an account with itself and calling the result isolation — the one failure that
turns the whole run into evidence of the opposite of what happened. Anonymous
accounts are exempt: they present nothing, and any number of them is legitimate.

`tenant` is optional too, and its absence is a statement, not an omission:
**the account is declared outside of tenants**. That is exactly what an anonymous
account is. For such an account every resource comes out as `foreign-tenant`: it
cannot be the account's own (ownership is a relation inside a tenant), nor a
neighbor inside the same tenant, and it has no kinship along the tree, because
there is no node to count that kinship from. It takes no part in the strict name
check and needs no entry in `tenants`.

A reserved name like `tenant: none` must **never** be introduced. It sits in the
same value space as real names: on a platform where a tenant really is called
`none`, that would silently make the anonymous account a neighbor inside that
tenant — and a leak of that tenant's own data would stop being a finding.

`canary` is an endpoint this account is known to have access to. It is checked
before the main run, and without it you cannot tell "access really is absent"
from "we failed to authenticate".

**Every account with credentials needs one.** A run where no canary was checked
ends with exit code 2 — the result cannot be trusted — because authentication is
then confirmed by nothing. This is not pedantry: a deployment answering 401 to
everything, with a policy made only of denials, produces a report with no findings
at all, and every cell in it says "tested and agreed". An adversarial review built
exactly that run.

The canaries are probed **twice**: once before the walk and once after it. A
token that expires in the middle turns every remaining cell into a 401, which
reads as a denial, agrees with a policy of denial and is counted as "tested and
agreed". At the conservative default of five requests a second a matrix of any
real size takes longer than a short-lived token lives, so this is the ordinary
case. An account whose canary passed before and fails after ends the run with
exit code 2 and is named in `staleCredentials`.

Accounts declared without credentials are exempt: an anonymous run has nothing to
authenticate, and demanding a canary of it would forbid a legitimate scenario —
"check that nobody at all can get in here".

### Authentication

The default scheme is declared at the root, surfaces with their own scheme are
declared by name, and an account refers to them:

```yaml
auth: { kind: bearer }              # the default; can be omitted

authSchemes:
  operator-console: { kind: cookie, name: opsid }
  affiliate-cabinet: { kind: header, header: X-Affiliate-Key }

accounts:
  - id: olga-op
    role: operator
    tenant: brand-a
    tokenEnv: TOKEN_OLGA
    authScheme: operator-console   # a reference by name, not the scheme again
```

| `kind` | What goes out | What the variable holds |
|---|---|---|
| `bearer` | `Authorization: Bearer <token>` | the token |
| `header` | `<header>: <token>` as-is, no prefix | the key |
| `cookie` | `Cookie: <name>=<token>` | the cookie value |
| `basic` | `Authorization: Basic <base64>` | `login:password` |

**There are no secrets in the configuration in any form** — no values, no
defaults. A scheme describes the transport only; the token itself comes from the
variable the account names. An extra key in a scheme is an error, not a silently
dropped field: otherwise `{ kind: bearer, token: "…" }` would pretend to work
while leaving a secret in a file that is meant to be committed.

One run covers several surfaces at once, and that is the point of it: on a
multi-brand platform the affiliate cabinet, the operator console and the customer
API authenticate differently, and by splitting the run into three you lose the
surface × surface matrix itself and end up stitching reports together by hand.

Schemes are **named** rather than written out on every account, because the
cookie name and the header name are properties of the surface, not of the
account. Repeated across five operator accounts, they will drift apart through a
typo, and a typo in a cookie name is indistinguishable from the correct name: the
platform answers 401, the denial matches the policy everywhere access is not
meant to be granted, and the report comes out clean. A typo in a **reference**
cannot do that — a name is either declared or it is not
([ADR-0016](https://github.com/Tarnellion/barbican/blob/main/docs/adr/0016-per-account-auth-schemes.md)).

The run stops at startup, before the first request, if:

- an account refers to a scheme that does not exist — including through a typo in
  the name;
- a declared scheme is used by no account (usually a forgotten `authScheme`: the
  account would have gone out with the default and said nothing);
- a scheme is referred to by an account without `tokenEnv` — there is nothing to
  present with it.

#### Request signing (HMAC) — from code only

The four schemes present a **static** secret. Signing — an HMAC over the method,
the path and a timestamp — is not described by configuration, and that is a
decision, not a gap: canonicalization differs between SigV4, Stripe-like schemes
and homegrown ones, and a common format invented without a real target would
match a real platform halfway at best. And a half-correct signature gives 401
everywhere — that is, a report saying there is no access anywhere,
indistinguishable from a platform that works correctly.

From code, signing is expressible: `barbican` is not only a CLI, and the
`CredentialProvider` port receives a description of the request it issues headers
for.

```ts
import { createHmac } from "node:crypto";
import { safeHeaders } from "barbican";
import type { CredentialProvider } from "barbican";

const signing: CredentialProvider = {
  headersFor(accountId, request) {
    const secret = process.env[`BARBICAN_SECRET_${accountId.toUpperCase()}`] ?? "";
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const { pathname, search } = new URL(request.url);
    const canonical = `${request.method}\n${pathname}${search}\n${timestamp}`;
    // `safeHeaders` is how a header becomes one: it checks the name against
    // RFC 9110 and the value against what `fetch` will carry, and it is the only
    // constructor of the `HeaderValue` this port returns. An object literal does
    // not type-check here, and that is the point — the grammar for a string from
    // outside is written once and applies to the library door as well as to the
    // CLI (ADR-0024). The same call is in `tests/runner.test.ts`.
    return safeHeaders([
      ["x-timestamp", timestamp],
      ["x-signature", createHmac("sha256", secret).update(canonical).digest("hex")],
    ]);
  },
};
```

The provider is called **for every request**, the canary one included: a
signature computed once per account would fit one cell out of ninety
([ADR-0018](https://github.com/Tarnellion/barbican/blob/main/docs/adr/0018-request-signing-is-a-port-concern.md)).
The canary stays the main safety net here: wrong canonicalization shows up on it
right away, instead of as a clean report.

#### Request conditions: geo, KYC, device

The four preceding sections describe **who** makes the request. Conditions
describe **how**: the same account with the same role, but the request is tagged
with attributes. A bet from a prohibited jurisdiction, a withdrawal before KYC is
passed, an operation from an unverified device — restrictions that permissions
cannot express at all: the role, the tenant and the resource in them are the very
same.

```yaml
contexts:
  - id: geo-blocked
    description: a request from a prohibited jurisdiction
    headers: { cf-ipcountry: AQ }
    endpoints: [orders.list, orders.read]   # required
    accounts: [alice-a]                     # optional: applies to all by default

policy:
  rules:
    - roles: "*"
      endpoints: [orders.list, orders.read]
      context: geo-blocked
      outcome: denied
```

Every set of conditions gives its own matrix rows — `alice-a@geo-blocked` — and
in the report they stand next to the baseline ones. The credentials are the same:
what changes is the request, not the account.

**An attribute value may come from the environment**, exactly like an account
token. A device signature or a partner key belongs in a variable, not in a file
that is meant to be committed:

```yaml
contexts:
  - id: partner
    headers:
      x-partner-key: { env: PARTNER_KEY }   # the variable name, not the value
      x-channel: mobile                     # a literal, when there is no secret
    endpoints: [orders.list]
```

What goes into the report is the declaration — `{ "env": "PARTNER_KEY" }` — never
the value. **A secret goes in a header, never in `query`:** a query
attribute is substituted into the address, and addresses are printed in the report
as they were sent, so `{ env: … }` is not accepted there at all — the schema
refuses it. A literal in `query` is fine; it is in the configuration already. An unset variable, or a value that cannot be sent in a request, is a
refusal at startup rather than an empty header mid-run.

**A context attribute is an arbitrary header sent into someone else's system, and
it has to be treated as exactly that.** At startup the tool rejects the ones that
change the meaning of the request rather than its conditions: method override
(`x-http-method-override` and the whole family), address override
(`x-original-url`, `x-rewrite-url`), routing (`x-forwarded-host` and the like),
credentials — and, separately, any attribute **whose value equals the name of an
HTTP method**, until `--unsafe-methods` is set. The last rule exists because
platforms that honor method override will perform a write on such a request even
though a GET goes out on the wire: the safe-method gate looks at the request
method and does not see that bypass.

In the query string, keys that present credentials (`access_token`, `api_key`,
`token`…) and keys by which resources identify themselves are forbidden. The
first, because a token in the address means **a different account**: the platform
will serve the request as that account, while the report will name the original
one. The second, because such an attribute would rewrite the resource's address
while the verdict would still come from the declared one.

No list exists that closes everything off: the tool does not know which header a
particular platform honors. Check what you declare.

**A rule without `context` applies in baseline conditions only.** That is the
main thing to remember. A missing field means "baseline", not "any": otherwise
declaring new conditions would silently extend every previous expectation to
them, and a platform that lawfully closes an endpoint for a prohibited country
would produce an unexpected denial on every cell. An expectation under conditions
is declared explicitly — or `fallback` applies.

**`endpoints` is required.** Conditions without bounds multiply the matrix by the
entire API surface; on someone else's deployment that is not a small matter. A
side effect, and a useful one: on endpoints outside the list the cell under these
conditions **does not exist**, so it will not turn up in the report as unchecked.

The run stops at startup if conditions are declared but no rule refers to them:
with no rule, all of their cells fall through to `fallback`, and the report fills
up with discrepancies nobody claimed.

Attributes cannot replace the basis of the request: `authorization`,
`cookie`, `host`, transport headers and the name of any header that presents
credentials are rejected at startup. Conditions that quietly rewrote
`Authorization` would give a run where some cells go out as a different account —
and it would look like findings about the platform
([ADR-0019](https://github.com/Tarnellion/barbican/blob/main/docs/adr/0019-request-contexts.md)).

What the tool **does not** do here: it does not model the platform's decision
logic. It compares the outcomes of two declared sets of conditions — and that is
all.

**What it cannot check: whether the attributes arrived.** A proxy or a load
balancer can strip a condition header, and then the requests under conditions
simply repeat the baseline ones — while the report says the restriction does not
work. The tool has no way to tell that apart from a real defect. If the run goes
through someone else's perimeter, confirm attribute delivery separately: with a
gateway log, an echo endpoint, anything outside the tool.

#### A role is a group of accounts, and a status is not a condition

`role` is a label for a group of accounts **expected to have the same access**,
and that is the whole of it. It is not read out of a token, it is not matched
against the platform's own role names, and it need not resemble them: two
platform roles whose expected reach is identical may share one label, and one
platform role has to be split in two where it is not. A brand administrator and
a holding administrator are frequently one word in the platform's own table and
two labels here — they differ by an entire subtree, and under a single label
every rule about one of them is a rule about the other.

Nothing outside your file defines the set, so the accounts in it are the set:
`roles: [custommer]` in a rule, against accounts that say `customer`, stops the
run and names what the accounts actually declare. That is the same treatment an
endpoint identifier, a context name, an authentication scheme name and — once
`tenants` is declared — a tenant name have always had.

It was the one reference that failed in silence, until 18 August 2026. Worth
knowing what it cost, because it says what the check is for: on the reference
platform a single wrong letter in `roles: [admin]` turned a clean run into one
privilege escalation that was not there — the rule stopped applying, the cell
fell through to `fallback: denied`, the platform allowed it, and nothing said a
rule had matched nothing. The other direction is quieter still. Misspell the
role on a rule that declares `outcome: denied` and the expectation simply
disappears; the cell agrees with the fallback, and a finding you wrote the rule
to catch is not reported.

The second question follows from the first, because both answers are ways of
declaring that two outcomes should differ — and only one of them is a group of
accounts. **A persistent state of the account is; a property of one request is
not.** A blocked customer, one who has not passed KYC, a VIP tier — those are
accounts, one per state, each under a role label of its own and each backed by a
real account on the platform in that state. A customer connecting from a
prohibited jurisdiction, from an unrecognised device, through a partner channel —
that is one account with a `context` over it.

The same platform and the same endpoint, modelled both ways. A state:

```yaml
accounts:
  - { id: alice, role: customer, tenant: brand-a, tokenEnv: TOKEN_ALICE, canary: orders.list }
  - { id: boris, role: customer-blocked, tenant: brand-a, tokenEnv: TOKEN_BORIS, canary: profile.read }

policy:
  fallback: denied
  rules:
    - { roles: [customer], endpoints: [orders.list], outcome: allowed }
    - { roles: [customer-blocked], endpoints: [orders.list], outcome: denied }
    # The block leaves this one open, which is what makes it usable as a canary.
    - { roles: [customer, customer-blocked], endpoints: [profile.read], outcome: allowed }
```

And a condition — one account, alice above, and the same request tagged:

```yaml
contexts:
  - id: geo-blocked
    description: the same customer, connecting from a prohibited jurisdiction
    headers: { cf-ipcountry: AQ }
    endpoints: [orders.list]

policy:
  fallback: denied
  rules:
    - { roles: [customer], endpoints: [orders.list], outcome: allowed }
    - { roles: [customer], endpoints: [orders.list], context: geo-blocked, outcome: denied }
```

**A state written as a condition invents a finding.** An attribute like
`x-account-status: blocked` is accepted — it presents no credentials, overrides
no method and rewrites no address — and it is still a header you made up, sent
into someone else's system. The platform does not honour it, so the request is
the baseline request under another name: it is served, the rule said `denied`,
and the cell becomes a `privilege-escalation` against a platform whose blocking
works correctly. Nothing downstream separates that from a real one, because the
tool never sees whether an attribute arrived. Meanwhile the blocked customer was
asked nothing at all: there was no blocked account in the run.

**A condition written as a state cannot be obtained.** No account is permanently
in Antarctica — the country is a property of the request, and `tokenEnv` names a
variable holding a credential, not a place. Declaring `alice-from-aq` as a second
account leaves nothing to put in that variable but alice's own token, and the run
stops before the first request: two accounts presenting one credential are
refused by name, because every check across them would compare an account with
itself. That refusal is the good outcome. Given two genuinely different tokens
the run does start, and then it compares two customers and reports the difference
as a country.

**A state modelled as accounts needs one door the state leaves open.** Declare
`customer-blocked` denied everywhere and a token that never worked produces
exactly the report a block that works produces: every cell refuses, every refusal
agrees with the policy, and the run reads as "tested and agreed". The canary is
half the answer — without one, nothing confirms that account authenticated at
all. The safeguard that catches a dead token is the other half, and against a
label denied everywhere it is silent by construction: it counts the cells the
policy declares accessible and asks whether any of them was granted, and a label
with no `allowed` rule has none to count. Hence the third rule above and
`canary: profile.read` — one endpoint the block does not close, declared open and
probed before the walk and after it. If the state really closes everything,
nothing the tool has can tell that account from a wrong token, and that is worth
knowing before the report is read rather than after.

#### An account in several tenants at once

When an account's reach is not a subtree but a **set** of nodes, write `tenants`
instead of `tenant`:

```yaml
accounts:
  - id: sara
    role: support
    tenants: [brand-a, brand-c]     # brands of different holdings
    tokenEnv: TOKEN_SARA
    canary: orders.list
```

This is support staff over some of the brands, an affiliate on two brands of a
group of three, a partner in two programs. A tree cannot express such an account:
its tenants have no common ancestor other than the platform root — and by seating
it at the root you hand it the whole remaining subtree as well, and the run goes
silent on a real leak
([ADR-0017](https://github.com/Tarnellion/barbican/blob/main/docs/adr/0017-account-tenant-set.md), which also walks through all
three workarounds and what each of them breaks).

The relation is computed for every membership, and the nearest one wins: for such
an account a resource of brand A is `same-tenant`, a resource of the holding
above A is `ancestor-tenant`, a resource of a brand that is not in the set is
`foreign-tenant`. No sixth `scope` value appears, and the existing rules keep
applying as they are.

Two constraints on the set:

- **Fewer than two names is not accepted.** A set of one is `tenant`.
- **Memberships must not nest inside one another.** `[holding-1, brand-a]` is
  rejected at startup: membership in the holding already covers the brand, and
  the extra line silently moves the brand's resources from `descendant-tenant` to
  `same-tenant` — and a rule written for the top-down view stops applying.

Such an account has no `baseUrl` of its own: the address is chosen by the
resource's tenant, and where there is no resource (a list endpoint, a canary),
the request goes to the target's common address.

### Tenants

A flat list — if there is no hierarchy:

```yaml
tenants: [brand-a, brand-b]
```

A tree — if a holding stands above the brands and an affiliate below a brand:

```yaml
tenants:
  - { id: holding-1 }
  - { id: brand-a, parent: holding-1, baseUrl: "https://a.example.test" }
  - { id: affiliate-a1, parent: brand-a }
  - { id: holding-2 }
  - { id: brand-c, parent: holding-2 }
```

The tree is mandatory once tenancy has more than one tier. Without it the holding
has to be attributed to one of its own brands, and the tool is **wrong twice at
once**: it declares a lawful read of its own brand an escalation, and it does not
notice a leak into a brand of a different holding. The second is the heavier one —
the run looks clean
([ADR-0013](https://github.com/Tarnellion/barbican/blob/main/docs/adr/0013-tenant-hierarchy.md)).

A tenant's `baseUrl` is needed when brands are spread across subdomains. The
address of the request is chosen by the **resource's** tenant: we ask for someone
else's data, it lives on someone else's host, and the token stays ours — that is
exactly what the check consists of.

The tenant list is optional, but by declaring it you get a strict name check.
This is not a formality: a stray space in a tenant name once **hid a real leak** —
the resource moved into `foreign-tenant`, the rule stopped applying, and the
finding vanished.

### Resources

```yaml
resources:
  - id: order-a-1
    tenant: brand-a
    owner: alice
    params: { orderId: "1001" }
  - id: report-7
    tenant: brand-a
    query: { report_id: "7" }
    endpoints: [reports.read]   # when the identifier is in the query string
```

Resources are declared by a human, not fished out of responses. The statement
that resource 1001 belongs to alice is a claim of intent, exactly like the policy.

The `endpoints` field is required when the identifier sits in the **query
string**: such an endpoint has no path parameters, so it cannot be tied to a
resource by matching names.

### Policy

```yaml
policy:
  fallback: denied
  rules:
    - roles: [user]
      endpoints: [orders.read]
      scope: own
      outcome: allowed

    - roles: [holding]
      endpoints: [{ method: GET, path: "/v1/reports/**" }]
      scope: descendant-tenant
      outcome: allowed
```

The **last rule that matched** wins. Anything uncovered falls through to
`fallback`; it deliberately has no default value — a silent "everything is
allowed" and a silent "everything is denied" are equally dangerous when the
verdict depends on it.

Endpoints are given as identifiers, as `{ method?, path }` patterns, or as `"*"`.
Inside a pattern `*` does not cross a segment boundary, `**` does. A pattern that
matched no endpoint **stops the run**: the rule would never have applied, the
pairs would have fallen through to `fallback`, and the report would have stayed
clean.

`scope` is the account's relation to the resource:

| Value | When |
|---|---|
| `own` | the owner of the resource is the account itself |
| `same-tenant` | same tenant, different owner |
| `descendant-tenant` | the resource is lower in the tree: a holding reads its own brand |
| `ancestor-tenant` | the resource is higher in the tree: a brand reads the holding level |
| `foreign-tenant` | no kinship: a different holding, and also an account outside of tenants |

A missing `scope` means "under any relation", including requests without a resource.

For an account with a set of tenants the relation is computed for every
membership, and the nearest one lands in the table — top to bottom down this
same list.

### Findings you already know about

A first run against a platform that has never been checked finds things. Some of
them are being fixed next quarter, and until then the run fails — which is a
problem, because the usual response to a CI step that fails every day is to
delete the step.

The wrong way to quiet one is to declare the cell allowed. That does not say "we
know"; it says "this is meant to work", and the finding leaves the report
altogether — no row, no defect group, no trace that anyone ever looked. Use
`accepted:` instead:

```yaml
accepted:
  - endpoint: orders.get
    relation: same-tenant
    kind: privilege-escalation
    reason: the order service has no tenant filter; PLAT-1234 replaces it
    until: 2026-11-30
    ticket: PLAT-1234
```

The finding stays in the report, at its own severity, with its request and its
clauses, marked `accepted`. What it leaves is the **verdict**: the run stops
failing over it until 30 November 2026, and on 1 December it fails again.

**Copy the coordinates out of the report.** `defects[].key` prints them in this
order:

```jsonc
"key": "orders.get same-tenant baseline",
"kinds": ["privilege-escalation"]
```

— that is `endpoint`, then `relation`, then `context`. The words `any-resource`
and `baseline` mean the field is absent: `any-resource` is a defect on cells with
no resource at all, `baseline` is a request with no declared conditions. Leave
the corresponding key out rather than writing the word.

`kind` is one of the entries in `kinds` beside it: a kind of matrix discrepancy,
or the identifier of the check that found it. It is part of the address on
purpose. One endpoint can be broken two ways at once — no authorization *and*
the same body for every tenant — and accepting the one you have read must not
silence the one you have not.

Four things to know before writing one.

- **`reason` and `until` are required, and `until` is a real date**,
  `YYYY-MM-DD`, inclusive of its last day, in UTC. There is no "forever". An
  entry that carries no condition for its own removal is a pin nobody notices,
  which is the same rule this project applies to a dependency override.
- **The account and the resource are not part of the address.** One entry covers
  every account and every resource of that defect, so declaring one more resource
  next month does not silently take the acceptance apart.
- **An entry that covered nothing is reported**, as `accepted[].matched: 0` and
  in `summary.accepted.unused`. Usually that means the platform was fixed and the
  line should go; sometimes it means the run never reached those cells, and
  `coverage.notProbed` says why. It does not fail the run either way.
- **`not-observed` and `probe-error` cannot be accepted.** They say the run did
  not reach the cell or the cell did not answer — nothing about the platform — and
  a run cannot buy its way out of saying so.

The full shape in the report, and the identity the counters keep, are in
[docs/report.md](report.md); the reasoning is
[ADR-0048](adr/0048-a-finding-can-be-known-and-still-reported.md).

### Signals over the body

```yaml
bodySignals:
  responseMustDifferByTenant: [orders.list]
  signals:
    - { name: orderCount, kind: count, path: orders, endpoints: [orders.list] }
```

Off when the section is absent: the body is not read at all, the stream is
cancelled.

`responseMustDifferByTenant` lists the endpoints whose response **must differ
between tenants**. A match means a missing filter — a defect that does not change
the status and is therefore invisible any other way. This is your declaration,
not a property of the API: without it `GET /v1/health`, which returns the same
`{"status":"ok"}` to everyone, would become a finding.

The converse is true too, and it matters: the absence of an endpoint from the
list does **not** mean it is not tenant-scoped. An endpoint like
`GET /v1/orders/{orderId}` is tenant-scoped by its very nature, but there is no
point declaring it here — cross-tenant access to a specific resource is visible
from the status and lands in `findings`. The list answers exactly one question:
where to compare bodies.

`signals` are extra scalars (`count`, `present`). They produce no findings; they
are there when you dig in. "The responses matched for alice and carol" is the
alarm, and digging in starts with the question of how many records each account
saw.

**Declare a `count` over the collection the endpoint returns.** It is not only
for digging in. Two tenants with no records return the same bytes, so their
digests match and the endpoint reports a `high` leak that is not there — on a
fresh deployment, where half the tenants have nothing yet, that is a wall of
findings and exit 1 on your first run. The count is what tells an empty response
from a full one: where every declared count is zero on both sides, the pair is
not compared and the report says `skippedBothEmptyPairs`. Without a count on the
endpoint the tool has nothing that means "empty" and says so —
`emptinessSignalsDeclared: 0` in that endpoint's coverage.

#### The envelope, and `compareSubtree`

```yaml
bodySignals:
  responseMustDifferByTenant: [orders.list]
  compareSubtree:
    - { endpoints: [orders.list], path: data.orders }
```

By default the digest is over the whole response, and on a real list endpoint
that is usually the wrong thing. If your API answers

```json
{ "requestId": "01J8...", "generatedAt": "2026-08-21T09:12:44Z", "data": { "orders": [] } }
```

then **every response differs from every other one**, the digests never match,
and this check finds nothing — including the case where `data.orders` holds both
tenants' orders. A `serverTime`, a pagination cursor, an echoed ETag do the same.
Nothing in the report looks wrong when this happens: `differedPairs` counts the
pairs and the endpoint reads as compared.

`compareSubtree` names the part of the body to compare instead. The path is
dotted, the same syntax the signals above use, and you declare it — the tool will
not work it out from responses, because "compare the fields that happen to agree"
is the tool picking its own answer.

Three things to know:

- The endpoint must also be under `responseMustDifferByTenant`. A scope anywhere
  else is refused rather than ignored: no digest is computed there, so the
  declaration would sit in your file doing nothing.
- One scope per endpoint.
- If the path is not in a response — or that response is not JSON — there is **no
  digest for that cell**, and the observation carries `digestScopeMissing: true`.
  It does not quietly fall back to comparing whole bodies. The pair shows up as
  `pairsWithoutDigest`.

**And the boundary, which no declaration removes: a difference in digests is not
proof of isolation.** It proves only that the bytes were different. A scope that
excludes the field the leak is in, or two tenants shown the same records in a
different order, both come back as `differedPairs`. This channel finds leaks; it
never clears an endpoint of them. `docs/report.md` has the long version under "A
difference in digests is not proof of isolation".

### Scope

```yaml
target:
  baseUrl: https://api.example.test
  allowedHosts: [api.example.test, a.example.test]
  label: staging, release 2026.08   # what the system under test is called
exclude: [dangerous.reset]
```

**`label` is declared by a human, and its absence is meaningful.** The tool
cannot name the system under test: `https://api.example.test` does not tell a
production-like deployment from a demo polygon. A report without a label does not
name the platform, and you cannot file a ticket from it — the CLI warns about
this on every run.

`allowedHosts` is mandatory: without an explicitly drawn scope, a run against an
undeclared host is not a check but a scan of someone else's system. An entry
without a port allows any port, an entry with a port allows exactly one. Tenant
hosts must be in this same list.

`exclude` is needed because a GET is not obliged to be safe in practice: an
address like `/createdb` resets the database while remaining a GET. One like that
was actually called by the tool on the VAmPI polygon — hence the list.

## Carrying over a matrix you already have

This is the usual way in. The matrix exists — a spreadsheet of ticks down
"role × endpoint", or a table in a wiki — and the question is what it becomes.

Take one row of such a sheet:

| Endpoint | player | support | admin |
|---|---|---|---|
| `GET /v1/orders/{orderId}` | ✅ | ✅ | ✅ |

Three ticks, and every one of them carries an invisible asterisk: **own, or
anyone's?** A player who may read *their own* order and a player who may read
*any* order produce the same tick, and the second is a BOLA. The sheet cannot
tell them apart, and neither can a run that is configured from it as written —
which is the whole reason this tool asks for a relation and not for a permission.

So the row becomes three rules, and writing them is the moment somebody has to
say out loud what the tick meant:

```yaml
policy:
  fallback: denied
  rules:
    # A player reads their own order and nobody else's. The second half is the
    # claim worth testing, and the sheet never made it.
    - { roles: [player], endpoints: [orders.read], scope: own, outcome: allowed }
    # Support reads anything inside its own tenant, and nothing outside it.
    - { roles: [support], endpoints: [orders.read], scope: same-tenant, outcome: allowed }
    - { roles: [support], endpoints: [orders.read], scope: foreign-tenant, outcome: denied }
    # An admin of a holding reads down the tree, not sideways into another one.
    - { roles: [admin], endpoints: [orders.read], scope: descendant-tenant, outcome: allowed }
    - { roles: [admin], endpoints: [orders.read], scope: foreign-tenant, outcome: denied }
```

Two things are worth noticing about what just happened.

**The denials are not redundant.** `fallback: denied` already refuses everything
unstated, so the two `outcome: denied` rules above change no verdict. They change
what the report can say: a rule that matched is named in `basis` and `ruleIndex`,
so a finding on that cell cites the line somebody wrote, rather than "no rule
matched". On a matrix of any size that is the difference between a ticket a team
accepts and one they argue with. Write them where the sheet's tick was ambiguous
and you resolved it — those are exactly the cells worth being explicit about.

**A missing `scope` is not the same as `own`.** It means "under any relation",
which is the widest reading of a tick and the one that hides BOLA. If you are
transcribing a sheet quickly and honestly do not know, leave the scope off and
**write down that you did not know** — the run will then agree with a broken
platform and a healthy one alike, and at least the configuration says so.

### A matrix generated from the code is worth nothing here

If the sheet was exported from the source — from decorators, from a permissions
table, from the same OpenAPI document you are about to feed in — then comparing
the platform against it compares an implementation with itself. It will pass. It
would pass with every check removed, because both sides move together.

The declaration has to come from somewhere the code cannot reach: a requirement,
a contract, a regulator's clause, or a person saying what is supposed to be true.
That is the reason `ExpectedAccessPolicy` is written by hand and never derived —
see [ADR-0006](https://github.com/Tarnellion/barbican/blob/main/docs/adr/0006-expected-access-declaration.md).

### What to do about a sheet with hundreds of rows

Do not transcribe all of it. The tool is at its most useful on the rows where the
asterisk is unresolved, and those are a small share: endpoints that take a
resource identifier. A row with no `{param}` in the path has no relation to get
wrong, and `fallback` plus a handful of `allowed` rules covers it.

Start with the endpoints that read somebody's data by id, declare the relations
for those, and let everything else fall through. A run over twenty well-declared
endpoints says more than one over two hundred where every scope was guessed.

## Running

```bash
barbican run --config barbican.run.yaml --endpoints endpoints.yaml --report run.json
```

There is exactly one source of endpoints: `--spec` (OpenAPI), `--endpoints` (a
manual list) or `--postman`. Two of them would diverge silently; none of them
would give a report with no findings, indistinguishable from a successful one.

**Where the identifiers come from.** Policy, resources, conditions and canaries
refer to an endpoint by its `id`, and where that `id` comes from depends on the
source:

| Source | `id` |
|---|---|
| `--endpoints` | the `id` you wrote |
| `--spec` | `operationId`, and where the operation has none — `"GET /v1/orders"` |
| `--postman` | the trail of folders and the request name: `"Orders/List orders"` |

A specification without `operationId` therefore gives identifiers with a space
in them, and a rule has to quote them: `endpoints: ["GET /v1/admin/users"]`.
Referring to an endpoint that is not among the parsed ones stops the run — the
alternative is a rule that silently never applies. The error names the parsed
identifiers, nearest first, so a typo answers itself.

### Where the report goes

`--report run.json` writes the report to that path, and creates it `0600` — owner
only. **Without `--report` the report goes to stdout.** In a pipeline that is the
build log: readable by everyone who can see the build, kept as long as the build
is kept, and copied into whatever collects logs.

The file is worth that much care. It holds no response bodies and no credentials
— those are kept out by construction — but it does hold every request address,
the identifiers of every account, tenant and resource, and a list of the places
where the platform's authorization does not hold. On somebody else's platform
that is a map of their unlocked doors, and it is yours to keep until they have
it.

So redirect it or name a path:

```bash
barbican run -c barbican.run.yaml -e endpoints.yaml --report run.json
barbican run -c barbican.run.yaml -e endpoints.yaml > run.json   # the same, minus the 0600
```

Any real run started without `--report` says this on stderr. A dry run does not:
it produces no report to misplace.

### A run that was interrupted

The expensive part of a run is not the time it takes. It is the traffic against a
deployment that is not yours, inside a window somebody agreed to in writing — and
that window may not open again this week.

So a run with `--report` streams what it observes to `<report>.stream.ndjson`
beside it, one line per cell, as each cell finishes, created `0600` like the
report and holding the same data. Two things come out of that
([ADR-0047](adr/0047-a-walk-that-survives-its-run.md)):

**A run stopped by a signal still leaves a report.** Ctrl-C — often because the
owner of the platform asked you to stop — and SIGTERM, which is how CI kills a
job past its timeout, both stop the walk, write out what was observed, and then
end the process the way the signal would have: `130` and `143`, unchanged. The
report says `truncated: true` and comes back with exit code `2`: the tail was
never probed, and the absence of findings in it means nothing. A second Ctrl-C
goes straight through.

**A run can be continued where it stopped.**

```bash
barbican run -c barbican.run.yaml -e endpoints.yaml --report run.json --resume
```

The cells already in the stream are not probed again — the number is printed
before the walk, and `--dry-run --resume` will tell you it in advance. The
resumed run adopts the interrupted run's `runId` and start time, so both halves
of the traffic carry one identifier in the platform's logs and lead to one
report. When the walk completes, the stream is deleted; the report is the
artifact.

**`--resume` refuses to continue a different run.** Before the first request it
compares a digest of the declaration — the configuration file, the endpoint
document, the values your request conditions take from the environment,
`--unsafe-methods` and `--no-identify` — with the one the stream was written
under. Anything different and the run stops with exit `2`, having sent nothing.
Half a matrix walked under one declaration and half under another is not one run,
and a report presenting them as one would carry a single digest and a single
verdict over both.

Two things it cannot see, and they are yours to hold:

- **the token behind an account.** The digest covers the names of the environment
  variables, never their values — a value hashed into a file is still a secret in
  a file. Resume as the same principals. The canary confirms the token in force
  works, which is not the same as confirming it is the same token.
- **the platform.** A digest of your declaration says nothing about what was
  deployed on the other side in between. Resuming across a deploy gives one
  report about two platforms, and only you know whether that happened.

Without `--report` there is no stream: the report goes to stdout, and choosing
where a document of that sensitivity lives is not a decision the tool makes for
you. Such a run says so before the walk, and an interruption costs it everything.

### The run says who it is

Every request carries a `user-agent` naming the tool, its version and the run:

```
barbican/0.4.0 (+https://github.com/Tarnellion/barbican#readme; run=3f2a…)
```

`run=` is the `runId` of the report the run produces, and that is the whole
point. The owner who agreed to this can find the run in an access log or a SIEM,
filter it out of an availability graph, show an anti-fraud rule what it was — and
tie all of it to the specific JSON document you hand them. Without it the only
thing connecting your report to their records is the clock.

`user-agent` rather than a header of this tool's own, because it is the field
their logging already keeps: a custom header would need a change on their side
first, and asking for that is asking the wrong person to do the work.

**`--no-identify` turns it off**, and there is one honest reason to reach for it:
you are deliberately measuring what an unannounced sweep looks like, WAF reaction
included. A marked run may be answered differently from an unmarked one, and then
what is being tested is partly the WAF's opinion of a known tool. That is a
decision to make on purpose and to write down in the agreement — say there how
the traffic is to be recognised instead. The run's summary prints which of the
two happened.

If a set of request conditions declares a `user-agent` attribute of its own, the
run stops at the first request rather than sending both values folded together.
Rename the attribute, or use `--no-identify`.

### Seeing the plan before running it

```bash
barbican run --config barbican.run.yaml --spec openapi.json --dry-run
```

Parses and validates everything, prints the endpoint identifiers with what will
happen to each, the number of matrix rows and the exact number of cells a run
would probe — and **sends nothing**. On someone else's deployment that is the
answer to "what exactly are you going to touch", given before the first request
rather than after the last. It is also the fastest way to learn the identifiers
of a specification you did not write:

```
Endpoints (7):
  orders.list    (GET /v1/orders)                    probe
  orders.cancel  (POST /v1/orders/{orderId}/cancel)  skip: a write method, and --unsafe-methods was not given
Matrix rows: 27 (declared accounts 9)
Cells a run would probe: 144, plus 24 canary requests (8 accounts, probed before
the walk and again after it, plus one request each with no credentials to show
the canary tells them apart)
```

Two of the seven endpoint rows are shown above; the run prints one for every
endpoint, unaligned. The skips come from the same function the run uses, so the
preview cannot drift away from what actually happens. A test proves the silence
the hard way: the run is made against a platform that is not up, where a single
request would fail. The two arithmetic lines are re-measured against this
polygon by `tests/docs/dry-run-transcript.test.ts`, because a transcript pasted
into a document is a copy of program output that nothing else re-runs.

**It also says what the run will not manage to do**, which until 15 August 2026
it did not:

- a canary pointing at an excluded endpoint, or at one with path parameters, or
  at no endpoint at all, or at an endpoint the policy denies to that account's
  own role — refused here rather than after the accounts have authenticated;
- **any account with credentials and no canary of its own** — named one by one.
  The run would walk the whole matrix and then exit 2, because nothing would
  confirm it authenticated as that account. It used to be enough for one account
  somewhere in the run to have a canary; see
  [ADR-0033](adr/0033-a-canary-is-per-account.md);
- a policy rule naming a role no account carries, and a resource that fits no
  endpoint — each is a declaration that would silently do nothing;
- `--max-requests` below the number of cells on the same command line — the run
  would stop part-way and report `truncated`;
- `--report` — a dry run does not write it, so anything reading the file
  afterwards reads the previous run's report.

Every one of those was a way for the preview to promise a run that could not
happen. The last is the one that bites in a pipeline: nothing failed, and
yesterday's report got published.

### Completion in the editor

```bash
barbican schema > barbican.run.schema.json
```

Prints the JSON Schema of the configuration, derived from the same validator the
run uses. The published copy lives at
[`schema/barbican.run.schema.json`](https://github.com/Tarnellion/barbican/blob/main/schema/barbican.run.schema.json);
with the YAML language server a file picks it up from a comment on the first
line:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/Tarnellion/barbican/main/schema/barbican.run.schema.json
```

### Manual endpoint list

The `--endpoints` format is the same YAML, with one top-level key:

```yaml
endpoints:
  - id: orders.list          # the name policy and resources refer to it by
    method: GET
    path: /v1/orders
  - id: orders.read
    method: GET
    path: /v1/orders/{orderId}   # a path parameter in curly braces
  - id: admin.accounts
    method: GET
    path: /v1/admin/accounts
```

Three fields, all of them required. The `id` is yours, not the platform's: policy
rules, resources, conditions and canaries refer to the endpoint by it, so a typo
here stops the run at startup instead of changing the verdict silently.

The parameter name in `path` must match the key in the resource's `params` — that
match is what binds the resource to the endpoint. YAML requires a value with a
colon or braces to be quoted: `path: "/api/tickets/{ticketId}"` is safer written
in quotes always.

The list is written by hand when there is no specification, or when it does not
reflect reality. It is a human declaration, exactly like the policy: the tool
does not check that the listed endpoints exist — it checks what happens with them.

Tokens are passed through the environment:

```bash
TOKEN_ALICE=… TOKEN_CAROL=… barbican run --config barbican.run.yaml --spec openapi.json
```

Throttling: `--concurrency`, `--rps`, `--max-requests`. The defaults are
conservative — you are running across someone else's deployment. Throttling
cannot be turned off: it is a port, not an option.

### Write methods

Without `--unsafe-methods` a write endpoint is not requested at all. It is not
dropped quietly either: it lands in `coverage.skipped` with the reason
`unsafe-method`, and `coverage.writeMethodsProbed` stays `false`. That pair is
the whole point — a report from a safe run says out loud that the write half of
the matrix is untested, so its "no findings" cannot be read as "writes are fine".

With the flag a write cell is an ordinary cell: same accounts, same resources,
same comparison against the declared policy. What changes is the cost of being
wrong. Before passing it, three things are worth having:

- **Permission from whoever owns the deployment.** A cancelled order stays
  cancelled after the report is written; barbican does not undo what it did.
- **Rules for the write endpoints.** Under `fallback: denied` an endpoint with
  no rule is expected to be refused, and every account that gets through is a
  finding. That is a usable default, but it is a declaration either way — write
  it down rather than inherit it.
- **A run against a stand, not production**, until the policy has been through
  one clean pass.

The asymmetry between reading and writing is the part a read-only matrix cannot
express, and it is where real platforms leak. A holding account that legitimately
reads a rollup across its brands is not thereby entitled to act on their orders;
an owner may cancel their own order while a colleague in the same tenant may not.
Both are separate rules over the same endpoint, and neither follows from the read
rules:

```yaml
    - roles: [user]
      endpoints: [orders.cancel]
      scope: own
      outcome: allowed

    - roles: [holding]
      endpoints: [orders.cancel]
      scope: descendant-tenant
      outcome: denied      # reading a rollup is not a right to act on it
```

The reference platform in `polygon/` carries this as a pair of switchable
defects — a write that ignores the tenant, a write that ignores the owner — and
the oracle
pins the cells they light up. That is what keeps the flag honest: without those
cells `--unsafe-methods` would be a code path nothing had ever walked.

## Before a run against something you do not own

Get the owner's agreement, in writing, naming the deployment and the window.
Everything in this guide describes how to keep a run small and honest; none of
it makes a run permitted. From the other side — the logs, a WAF, whoever is on
call — several accounts sweeping the surface for places where one reaches
another's data is indistinguishable from the thing this tool is used to find.

`--unsafe-methods` deserves its own sentence in that agreement: it changes
state, and the change outlives the report.

So does the way they will recognise the traffic. By default every request names
the tool, its version and the run in `user-agent`, and the `run=` part is the
`runId` of the report you will hand over — that pair is what lets them separate a
run they agreed to from an intrusion in their own logs, and match their records
against your findings. Put the identifier in the agreement, or in the message
that says the run has started. If you intend to use `--no-identify`, say that
instead, and agree on what will stand in for it.

And agree where the report is going to live before it exists. It names the places
their authorization does not hold; until they have it, it is a document about an
unfixed vulnerability in somebody else's system.

A checklist of everything to settle before the first request —
[first-run.md](first-run.md).

### The run's own blast radius

Two costs of running that are not about the platform's defects at all. Both are
easy to meet for the first time in the middle of a run.

**The job that runs barbican holds every role's live credentials at once.** The
tool does not obtain tokens: a login is a POST, that is, outside safe mode, and
"does not log in" is on the list above. So somebody puts working credentials for
every declared account into the environment of one process — the customer, the
affiliate, the support agent, the **tenant administrator**, the **operator
console** — and keeps them there for the length of the walk. On a platform where
those roles are deliberately held by different people, that process is a
concentration of privilege the platform never grants anybody.

`barbican.run.yaml` is the other half. It is meant to be committed and reviewed,
and `tokenEnv` names a variable rather than a value exactly so that it can be —
which makes the committed file an accurate map of which variable holds which
role. That map plus read access to the job's environment, or the right to
restart it, is every role at once.

Nothing in the tool changes this, so it is a decision about the job: where it
runs, who can read its environment or its process list, whether the CI variables
are masked and scoped to one protected branch, and — the part that is usually
forgotten — how soon the tokens are revoked after the window closes. A run is an
hour; a token minted for it lives as long as nobody rotates it.

**And the run is shaped like the thing it is looking for.** By construction it
sends a long run of `401` and `403` from one subject in a few minutes: every cell
the policy expects to be refused, back to back, on one account. That is the
signature an account lockout, a step-up challenge or an anti-fraud rule is hung
on, and a platform that has one is usually a platform worth testing.

What happens then is the part worth knowing in advance:

- the account is locked mid-walk, and every remaining cell of it answers `401` —
  a denial, which agrees with a policy of denial and is counted as tested and
  agreed;
- the canary probed after the walk fails, so the run does end in exit code 2 and
  names the account. It names it in **`staleCredentials`**, which is worded for a
  token that expired on its own. The run caused this one, and nothing in the file
  says so;
- the real account, belonging to a real person on the platform, is locked after
  the run has finished. Support hears about it from them.

`--rps` and `--concurrency` lower the rate, not the ratio: a matrix whose cells
are mostly denials produces mostly refusals however slowly it is walked. The
things that actually help are agreed with the platform's owner rather than
configured here — an exemption for the accounts named in the run, a lockout
counter reset afterwards, or accounts created for the run and disabled with it.
Put the account identifiers in the same message as the window; they are the ones
that will need unlocking.

## Choosing which checks run

Every registered check runs unless you say otherwise. `--checks` narrows that to
a list, which is the shape ADR-0003 always described and the CLI never offered:

```bash
barbican run -c barbican.run.yaml -e endpoints.yaml --checks identical-response-across-tenants
```

A name nobody registered stops the run **before the first request**, naming the
checks that do exist. Quietly running the rest would leave the typo's only trace
in `coverage.checksRun` — an entry missing that nobody is looking for — and the
run would read as "checked, and clean here".

`--dry-run` prints the selection along with the endpoint list, so what will be
checked is answerable before anything is sent.

**A check left out is coverage left out**, and the report says which ones ran.
That is the reason to leave the flag off unless you have one.

## What changed since the last run

```bash
barbican diff yesterday.json today.json
```

Two saved reports, read against each other. It answers the two questions a
*second* run is made for — what moved since the last one, and was that the
platform or was it me — and both halves of both answers were sitting in the file
long before anything read them: `configDigest` exists to tell an edit of the
declaration from a change on the platform, and `defects[].key` was made readable
and stable across runs precisely so that a ticket could cite one
([ADR-0050](adr/0050-a-comparison-is-of-defects-not-of-files.md)).

You reach for it in three places. After a ticket comes back "fixed, please
verify". In a pipeline that walks the matrix nightly, where the useful question
is never "are there findings" but "is this the same set as yesterday". And before
handing a second report to the owner of the platform, because "the two we agreed
on, minus one, and nothing new" is a sentence somebody can act on, and two JSON
files are not.

**A text diff of the two files answers none of it.** They differ almost
everywhere and agree on everything worth knowing: `runId`, both timestamps, the
`at` and `durationMs` of every observation, and every `signals.digest` — the
digest salt is drawn afresh per run on purpose. Two runs of one matrix against
one unchanged platform produce two documents `diff(1)` calls entirely different,
which is a long way of saying nothing.

Against the reference platform, with one of its defects switched off between the
two runs:

```
before: run 60007f96-abd1-45c2-8890-1200007bc3bf started 2026-08-24T16:05:21.137Z against barbican reference polygon (a demonstration deployment, not a platform)
after:  run aa3bc10b-a378-4c49-a87e-196c0361e569 started 2026-08-24T16:05:24.915Z against barbican reference polygon (a demonstration deployment, not a platform)
The declaration is the same in both runs (configDigest 001c9b98149497b7), so what follows is about the platform.
Coverage: 144 cells over 6 of 7 endpoints, unchanged.
Defects: 2 → 1 — 0 new, 1 gone, 0 changed, 1 unchanged.
Gone (1):
  orders.read same-tenant baseline — was privilege-escalation, high, 4 cells
      the second run probed orders.read and found nothing there.
Run verdicts: 1 → 1.
Exit code 1: the two runs do not describe the same platform: 1 gone
```

The comparison itself is a few of those lines; the rest is what makes them worth
reading: whether the declaration moved, whether the surface is the same one, and
— on the indented line under each disappearance — whether the second run went
looking at all. How to read the whole of it is in [report.md](report.md), under
"Comparing this report with an earlier one". What belongs here is what you have
to know **before** any of it means anything.

**The two paths are positional, and the order is a claim**: the earlier report
first. Hand them over the other way round and every "new" below is something that
went away. The run notices — a report carries `startedAt` — and says so on its own
line, before the comparison rather than after it:

```
The second report is older than the first. Every "new" below is something that went away and every "gone" is something that appeared — swap the two arguments, or read it inverted on purpose.
```

A sentence and not a refusal, because reading a repair backwards is a legitimate
thing to want and the tool cannot know which of the two you meant.

**`--json` writes the same conclusion to stdout** while the summary stays on
stderr, so a redirect gives you the document and not the document with a
paragraph in front of it. Both come out of one comparison and cannot disagree.
Note the shape of the flag: here it is a switch and the destination is your
redirect, whereas `barbican pack --json <path>` takes a path. The two commands
write different kinds of thing and the difference is deliberate — a comparison is
read on a screen, a pack is a file that gets sent somewhere.

### What "the same defect" means across two runs

A comparison is a join, and a join is worth exactly what its key is worth. Two
things about this one are worth the space before you trust a line of the output.

**The unit is the defect, not the finding row.** One defect is fifty rows or one,
depending on the per-defect evidence budget and on how wide your matrix happens
to be, so a difference in the number of rows is news about the shape of your run
and not about the platform. `violations`, `accountIds` and `resourceIds` move the
moment you add an account, and the comparison prints and compares none of them. A
defect counts as **changed** along three axes only: its set of `kinds`, its
`severity`, and whether an `accepted:` declaration now holds it out of the
verdict — that last one because a defect somebody signed for looks, to the exit
code and to every counter beside it, exactly like a defect that was fixed.

**A defect is its coordinates**: the endpoint, the relation the resource stood in
(`own`, `same-tenant`, `foreign-tenant`, and the rest), and the set of request
conditions it was seen under. Those three are what the report grouped the
findings by when it was written, and the comparison asks the same function the
same question — so the run that wrote the file and the reading that comes back to
it a month later agree by construction, and there is no second notion of "the
same defect" in the tree for the two to drift apart on
([ADR-0070](adr/0070-a-comparison-joins-on-coordinates.md)).

**It is deliberately not `defects[].key`**, and that distinction cost a real
reading. The key is those same three coordinates printed for a person to cite,
joined with a **space** — `orders.read same-tenant baseline` in the transcript
above, where a defect carrying no resource prints `any-resource` and one seen
under no declared conditions prints `baseline`. A space is a legal character in
an identifier, on purpose: refusing it would refuse half the endpoint names a
specification can carry. So one such string names two different defects whenever
the parts line up, and they do:

```
{ endpointId: "a",       relation: "own",         contextId: "b same-tenant d" }
{ endpointId: "a own b", relation: "same-tenant", contextId: "d" }
```

Both print `a own b same-tenant d`. It does not take two files to meet this — a
report this tool writes carries both rows under that one key. Indexed on the key,
a second run that had fixed one of the two was reported as a single defect whose
kinds and severity had changed: a sentence about a platform that had done
neither, with the fix nowhere in the output and the surviving defect matched
against the wrong twin.

Nothing about the key moved when this was fixed. It is the same string in the
same place, it is what an `accepted:` entry names a defect by, and it is what you
paste into a ticket; what changed is what the comparison joins on. A report
already on disk compares correctly, including one written before the change,
because the coordinates were always in it.

### What the comparison exits with

| Code | Meaning |
|---|---|
| `0` | the same defects, over the same surface |
| `1` | the two runs do not describe the same platform: a defect appeared, went or changed, or the surface probed is not the same |
| `2` | **this comparison cannot be trusted** |
| `64` | the command line was wrong; nothing was read |

`2` outranks `1` for the reason it does on a run: what was not tested is never
clean. There are six ways to reach it, and [report.md](report.md) lists them with
their reasons. One is worth naming here, because it is the one you can do by
accident:

```
Cannot be trusted: both files record the same run, aa3bc10b-a378-4c49-a87e-196c0361e569. Every difference below is zero because there is only one run here, which reads exactly like "nothing changed".
Run verdicts: 1 → 1.
Exit code 2: this comparison cannot be trusted: both files record the same run, aa3bc10b-a378-4c49-a87e-196c0361e569. Every difference below is zero because there is only one run here, which reads exactly like "nothing changed"
```

A file compared with itself differs from itself in nothing, which on a screen is
indistinguishable from a quiet week. In a pipeline that names its reports from a
variable, that is one wrong variable away, and it is the most expensive false
clean this subcommand can produce.

`64` is what the argument parser rejects and nothing else — the same line `run`
draws. A path that is not there, a file that is not JSON and a document that is
not a report are all `2`: conclusions the tool refuses to draw rather than
mistakes in the invocation, and the message says which of the two arguments it
was about.

```
Comparison aborted: the second report cannot be read from "nosuch.json": ENOENT: no such file or directory, open 'nosuch.json'. The system error names neither the argument nor the path
```

## Evidence for somebody who was not there

```bash
barbican pack run.json --out evidence.html --json evidence.json
```

Everything above this section is written for **you**: you declared the policy,
you chose the matrix, and you can read `coverage.notProbed` and know what it
costs. An evidence pack is for the other reader — the one who was not there, who
opens the document once, months later, and takes it as a conclusion. An auditor,
a certifying body, the security team of whoever is buying your company, your own
compliance officer.

It draws **one row per clause of a catalogue of external standards**. The three
this package ships as data — `OWASP-ASVS-5.0`, `OWASP-API-2023` and `CWE` —
carry sixteen clauses between them. The pack is built *after* the run, from the
file the run wrote, because JSON is the single source of truth here and a
document is rendered from it in a separate step; which is also what makes a pack
of a six-month-old run worth building again today against a catalogue that has
grown since ([ADR-0067](adr/0067-an-evidence-pack-says-what-it-checked.md),
[ADR-0068](adr/0068-a-pack-is-drawn-from-the-json.md)).

**Every clause gets a row, including the ones the run never touched.** A pack
assembled out of what a run happened to cite would be a list of what was checked,
and the question its reader has is what was not. That is the whole reason the
catalogue exists as data rather than as a table inside a document.

**A catalogue of your own is a library concern, not a flag.** The CLI builds
against the three above and there is no option to point it elsewhere: a standard
whose numbering may not be republished cannot live in a public repository, and
this is one. A machine that holds such a catalogue registers it beside its own
checks and calls `evidencePack` directly — [library.md](library.md).

Against the reference platform, from the second of the two reports compared
above:

```
Evidence pack for barbican reference polygon (a demonstration deployment, not a platform)

This run walked its matrix and answered for its own trustworthiness — it exited 0 or 1 — so the rows below are evidence about the platform it ran against, within the reservations each row carries.

Clauses in the catalogue: 16. 5 breached, 1 upheld, 0 inconclusive, 0 answered-without-findings, 10 unanswered, 0 withheld
Cited outside the catalogue: 0

Written: pack.html
Pack: pack.json

Exit code 0: the pack was built.
```

Read the tally, not the exit code. That run found five breached clauses and
upheld exactly one — and **ten of the sixteen were answered by nothing at all**.
It was a real walk of 144 cells over six endpoints of a seven-endpoint platform,
and it still leaves most of the catalogue untouched. A document that did not say
so is the failure this whole subcommand is written against: a run once probed two
endpoints of eleven and printed "No privilege escalation found" over the other
nine.

The last line of the tally is the other half of that. `Cited outside the
catalogue` counts clauses the run named that this catalogue does not carry —
ordinarily a report from a machine that registered a standard of its own, or one
from a build whose catalogue has since grown. They get rows of their own, in a
list of their own, with no title and no boundary, because printing those blank
would read as a catalogued clause with nothing to say.

### The six claims, and which three are not about the platform

| Claim | What it says |
|---|---|
| `breached` | the platform and the declared policy disagree under this clause: this run recorded at least one cell or check finding here |
| `upheld` | every cell that reached a conclusion under this clause agreed with the declaration — over the cells counted on that row, and no others |
| `answered-without-findings` | a registered check answers for this clause, it ran, and it reported nothing. What it examined is its own to state |
| `inconclusive` | the clause was reached and nothing was concluded: every cell counted here failed to answer or was never asked |
| `unanswered` | nothing in this run answers for this clause — no check cited it, and no cell of the matrix was evidence about it |
| `withheld` | this run could not be trusted on its own terms, so no claim is made under this clause |

**Three of the six say something about the platform** — `breached`, `upheld`,
and weakly `answered-without-findings`. **Three say something about this run and
nothing whatever about the platform**: `inconclusive`, `unanswered`, `withheld`.
That second group is the half a pack usually lacks, and the half a reader
mistakes for the first.

So the sentence to be certain of before you send one to anybody: **a clause
nothing answered is never a clause that passed.** `unanswered` is not a quiet
`upheld`, and no absence of findings elsewhere in the document applies to it. The
page says exactly that, in as many words, on every such row.

The order the rules are applied in is the argument, and it descends by confidence
in what the run actually saw. A disagreement stands whatever else is true — it
was observed, and no later failure of the run unobserves it. Then a run that
could not be trusted says nothing further. Then the cells that reached a
conclusion, which are the only thing `upheld` may rest on, and their denominator
travels with them on the row. Then cells that concluded nothing, which is
`inconclusive` and is not silence. Then a check that ran and found nothing, which
is the weakest row on the page, because nothing in the report says how much that
check looked at. Whatever is left was answered by nothing at all.

**The qualifications ride on the row they qualify**, not in a footnote at the
end: an account whose credentials were never proved, endpoints the run did not
probe, a walk that was cut short, a platform not one observation came back denied
from. A qualification left in another section is one that did not travel with the
claim, and a claim that outran its own numbers is what this is all for.

### There is no percentage in it anywhere, and that is a decision

No score, no "clauses passed", no bar across the top. Six meanings do not add up
to one number, and three of the six are not about the platform at all — a total
would hide precisely the half that matters. So the tally the CLI prints, and the
one at the head of the document, names **all six** claims whatever the run
reached, zeros included. A line listing only the statuses with something in them
would be a score with the inconvenient half rounded off, and the line it would
drop is how many clauses nothing answered for.

If a reader takes "green means compliant" away from a pack, the pack has failed,
and no amount of correct rows elsewhere repairs that.

### A run that exited 2 gives a pack that withholds

The same platform, walked under a `--max-requests` budget that ran out part-way:

```
Evidence pack for barbican reference polygon (a demonstration deployment, not a platform)

This run exited 2: it describes the state of the network, of the deployment or of its own credentials rather than the platform's access control. A row recording a disagreement still stands — what was found was found — but no clause below is reported as upheld, because a cell that agreed may have agreed for a reason that has nothing to do with access.

Clauses in the catalogue: 16. 5 breached, 0 upheld, 0 inconclusive, 0 answered-without-findings, 0 unanswered, 11 withheld
Cited outside the catalogue: 0

Written: cut-short.html

Exit code 2: the standing of this pack is "withheld" — see above.
```

The breaches stand and **every other row on the page becomes `withheld`**,
whatever it would otherwise have been — the clauses cells agreed under and the
clauses nothing reached alike. The asymmetry is deliberate and is the one this
project reasons by everywhere else: a
positive claim of safety needs a run that answered for itself, a positive finding
of a hole does not. An escalation seen before the budget ran out is still an
escalation, and a `200` under a token that may already be dead is worse news
rather than better.

**Exit `2` here does not mean the pack failed to build.** The file was written
and is worth opening — it says on its own face that no clause in it is reported
as upheld. The exit code is the only part of this a pipeline reads, and a job
that ships such a pack as evidence with nobody noticing is the defect above with
a document wrapped around it.

### The document, and the two things it will not do

One self-contained HTML file: no script, no external stylesheet, no font, no
image, and no attribute a browser dereferences. That is structural rather than a
policy anybody has to keep — the element and attribute names the renderer is able
to write are closed lists with no `script`, no `href` and no `on…` in them. A
`javascript:` URL in a clause's published address is therefore not a special
case; it is printed as text, because there is no element that could make it
anything else.

Two consequences to expect rather than to be surprised by:

- **The address of a clause's published wording is printed, not linked.** An
  auditor with a network would have clicked it, and that is a real cost. It is
  paid because the catalogue may be one a machine registered from a source this
  tool never saw, so the tool is not in a position to vouch for the string — and
  because a scheme allowlist would be one more grammar in here modelling somebody
  else's parser, which is how the address grammar was wrong the first time.
- **It is meant to be printed.** A PDF is usually the deliverable, and a
  browser's print dialogue is the PDF writer every auditor already has; producing
  one directly would mean taking on a PDF library. The page carries print rules —
  a margin, black on white, a clause row that does not split across a page
  boundary. Those rules are **declared and not measured**: no browser runs in
  this repository's test suite, so what is checked is that the properties are in
  the document, not that any engine honoured them.

`--json <path>` writes the structure the document was drawn from, so a reader who
wants to check the page against it does not have to re-derive it. Both come out
of one call, so the file and the page cannot come to different conclusions.

### The flags and the exit codes

| Flag | |
|---|---|
| `-o, --out <path>` | **required.** Where the document goes. A document is a file: printing a rendered page to a terminal is not a thing anybody wants, and a command that could produce the structure without the document would be `barbican pack` meaning two different things depending on the flags |
| `--json <path>` | also write the pack structure the document was drawn from |

| Code | Meaning |
|---|---|
| `0` | a pack was built |
| `2` | the report cannot be read: the path, a file that is not JSON, a `schemaVersion` this build does not read, or a report written before `coverage.clauses` existed |
| `2` | the pack's standing is `withheld` — above |
| `64` | the command line was wrong; nothing was read |

```
Pack aborted: not-a-report.json is not a barbican report this tool can read: "schemaVersion" is not a string. A report file is what `barbican run --report` writes.
```

**This subcommand sends nothing.** It reads a file and writes a file; a wrong
`--out` costs a failed local write and no traffic at all. Worth saying out loud,
because everything else in this guide is about a tool that touches somebody
else's deployment — and because the thing a pack *does* leave is a document that
goes to a third party. Where it is allowed to go is item 9 of
[first-run.md](first-run.md), settled before the run rather than after it.

## What the tool does not do

- **Does not issue write methods** without `--unsafe-methods`. GET and HEAD only.
- **Does not follow redirects.** Following a 3xx to another host would take the
  request outside the scope.
- **Does not resolve external `$ref`s** in OpenAPI — neither over http nor
  through the file system.
- **Does not store response bodies** and does not put secrets in the report: an
  account names an environment variable, sensitive headers are redacted.
- **Does not obtain tokens itself.** A login is usually a POST, that is, outside
  safe mode. The operator logs in outside the tool.
- **Does not read the body to decide whether access was granted.** The status
  code is the whole of it, and on some platforms that is not enough — see below.

### What the model does not express

The list above is what the tool declines to **do**. This one is what the
declaration cannot **say**, which is the harder kind of limit: it does not
announce itself, and a run against a platform whose access rules need one of
these comes back clean and means less than it looks.

Found by walking a real multi-tenant platform through this format in August 2026,
and written here rather than left in a working note, because the operator who
needs to know is the one modelling their own platform for the first time.

**A contour has no address of its own.** A base address can be declared on a
tenant — brands do get their own subdomains — and never on an authentication
scheme. So a platform whose administrative contour lives on `admin.example.com`
beside `api.example.com` needs two runs, and two runs cannot ask the question the
contours were introduced for: whether the operator's cookie opens a customer
endpoint, and whether the customer's token reaches an administrative one. That
matrix is exactly what one run gives and two do not.

Do not reach for the obvious workaround. Declaring a contour as a tenant to
borrow its `baseUrl` would make `own`, `same-tenant` and `foreign-tenant` mean
something other than what they mean everywhere else, and the findings would come
out as noise rather than as errors — harder to discount than a gap.

**Granted access is not a relation.** The five relations describe belonging:
whose the resource is, and how the two tenants are related. None of them can say
"Anna shared this document with Boris". On a platform with sharing, an ACL or
guest links, a legitimate share and a leak are the same `same-tenant` cell, and
the tool has no way to tell them apart. If that is how access is granted where
you work, this module answers a smaller question than it appears to.

**Permissions that depend on the resource's state** — a draft may be edited, a
published one may not — are expressible, and the way is not obvious enough to
find by accident. Declare two resources with different identifiers, one in each
state, and write a rule for each. It costs a line per state and it is honest: the
report then names the draft and the published document separately, which is what
a reader needs anyway.

**Permissions that depend on the request body** are not expressible. Request
conditions carry headers and query parameters, and nothing else — a deliberate
boundary, and the one a platform reaches the moment an endpoint decides by a
field in the payload. There is no workaround here; a rule that needs the body is
outside what this declaration can state.

### With `--unsafe-methods`, the order of the walk starts to matter

A run without the flag is a read: whatever order the cells are probed in, each
answer is about the platform. With it, the walk changes the thing it is
measuring. The first account to `DELETE /v1/orders/1` gets 200 and the order is
gone; every later account asking about that same order gets 404.

A 404 normally means "not there", which satisfies a policy of denial — so
without care those later cells would read as **tested and agreed** about a
protection nobody ever observed, and the report would depend on which account the
walk reached first.

The tool refuses to draw that conclusion. A 404 on a state-changing endpoint
whose object this run has already changed is recorded as `error` — no conclusion —
with the reason in `failures`, rather than as a denial. It is deliberately narrow:

- only state-changing methods, so an ordinary 404 still means the resource is
  absent, which `coverage.resourcesNotFound` is for;
- only after a **2xx** on the same endpoint and resource in the same run;
- a 403 is untouched, because that is the platform answering rather than us.

**It is best effort, and the limit is worth knowing.** The walk is parallel, so
two accounts can be inside the same cell at once and neither sees the other's
write. What this removes is the silent conclusion, not the race. If the answer
for a write endpoint has to be exact, give each account a resource of its own.

### A platform that refuses with 200

Some APIs answer every request with `200 OK` and put the outcome in the body:

```json
{ "success": false, "error": { "code": "FORBIDDEN" } }
```

**barbican reads the status code and nothing else.** Against such a platform every
cell comes back `allowed`, so every cell your policy declared `denied` turns into
a `privilege-escalation` finding. Not some of them — all of them. The report is
then wrong from end to end while looking exactly like a catastrophic result, and
that is the worse of the two ways to be wrong: a tool that finds things which do
not exist is not trusted again.

**Check it before you believe a bad report, and it takes one look.** Pick a cell
you are certain about — an ordinary account against an admin endpoint — and read
its observation:

```jsonc
{ "accountId": "alice", "endpointId": "admin.users", "status": 200, "outcome": "allowed" }
```

A `200` where you expected a `403` means the tool is misreading the platform, not
finding a hole in it. The `--dry-run` will not show this; nothing but a real
response will.

There is no way to declare "a refusal looks like this" today. If your platform
answers this way, the role × endpoint matrix is not something this tool can check
for you yet, and the honest thing is to say so rather than to filter the findings
by hand afterwards.

**The body checks are poisoned too, and that is worth spelling out** — the
opposite is the natural guess, since they compare digests rather than statuses.
They only run on cells that came back `allowed`, and here every cell does. Two
accounts in different tenants both **refused** receive the same envelope, so the
digests match and the tool reports a cross-tenant leak.

Measured, on a six-cell platform that answers 200 to everything with the outcome
in the body:

```
cells 6, all status 200
findings 5 — privilege-escalation 4, identical-response-across-tenants 1
exit code 1
```

Four is every cell the policy denies. The fifth is two refusals mistaken for one
shared record. The exit code says "checked, and reality does not match what you
declared", which is exactly what it would say about a real catastrophe.

### The statuses this tool cannot read

The section above is one member of a family, and the loudest. The rest are
quieter and fail the other way round: instead of a report full of findings that
are not there, they give a report with cells **missing** from it, and a run that
ends in `0`.

The conclusion about access is drawn from the status code, and only where it is
unambiguous:

| Answer | Read as |
| --- | --- |
| `2xx` | access granted |
| `401`, `403`, `451` | refused |
| `404`, `410` | not served — folded into a refusal by the diff |
| anything else | no conclusion: `outcome: "error"`, a `probe-error` cell |

A `probe-error` is low severity, it does not enter the exit code, and while
fewer than half the cells are one, the run finishes with `0`. Four kinds of
platform land there, and each of them can make a real refusal invisible.

**A refusal that redirects.** An operator console on a session cookie —
`kind: cookie` above, and the case that scheme exists for — does not answer a
refused caller with `403`. It answers `302 Location: /login`. barbican does not
follow redirects (deliberately: the target of one can be off the allowlist
entirely), so what stands behind it was never fetched, and every denied cell of
that surface becomes a `probe-error`. Nothing in the report says the refusals
were dropped; the counters simply do not include them.

The warning that looks like it should catch this does not. `nothingRefused`
fires on `coverage.outcomes.denied == 0` — the whole run, not one surface — so a
configuration covering an API that answers `401` beside a console that answers
`302` never earns it, and the sentence it prints names the other cause anyway.

What it takes to fix is a declaration: *on this platform, a refusal looks like
this*. There is no such field today, and the tool will not guess from a
`Location` header — that is somebody else's convention, and deriving the
expectation from the system under test is the mistake
[ADR-0006](adr/0006-expected-access-declaration.md) exists against. Until then,
if your denied cells come back as `probe-error` with a 3xx status, read them as
uncounted refusals rather than as a healthy run.

**An outcome that is not final.** `202 Accepted` means the request was taken,
not that it was allowed. A platform that queues the work and refuses it in a
worker answers `202` to a caller who has no right to it, and this tool reads
that as access granted: the cell becomes a `privilege-escalation` finding where
the truth is a refusal arriving a second later. Nothing in the response says
which of the two it is. If a write endpoint of yours is asynchronous, the
verdict on it is about admission to the queue, not about the operation.

**A delete that only hides the object.** Under soft delete, an object that is
hidden answers `404` or `410` to everyone — the accounts that should reach it
included. The diff folds both into a refusal, so a cell reads as protected when
it is only empty, and an account that genuinely lost access is indistinguishable
from one looking at a tombstone. `coverage.resourcesNotFound` is where to look:
a resource missing for *every* account is usually this rather than authorization.

**An answer about the endpoint rather than the account.** `405 Method Not
Allowed` says this endpoint does not offer this method. It says nothing about
who asked, and a matrix cell asks about who asked. It stays a `probe-error`; a
wall of them usually means the endpoint list and the platform disagree about
methods, which is worth fixing in the list.

**What the run does say.** Every cell whose status is not read leaves a row in
`failures` naming the status and why nothing follows from it, and the CLI prints
`Requests that failed: N (reasons in the report)` in yellow. That is not a
verdict — the run can still end in `0` — but it is the thread to pull, and it is
the difference between a boundary you can see and one you cannot.

### One probe per cell

The sections above are about statuses the tool reads wrongly. This one is about
how many times it reads them, which is **once**.

A cell is one request, asked once. A finding is not re-probed to see whether it
holds; a cell that agreed is not re-probed either; and nothing the run writes
distinguishes a result seen twice from one seen once, because no result was.

Requests are repeated, and the difference is the whole point of this section.
The retry loop fires on `429`, on `5xx` and on a request that failed on the wire
— conditions that say the answer never arrived. **An unexpected outcome is not
one of them**, deliberately: a `200` where the policy said `denied` is the
finding the run exists to produce, and asking again would be the tool choosing
between two answers it has no grounds to choose between.

So a matrix cell is a coin tossed once, and both faces are expensive.

**One `200` makes a `critical`.** A stale replica behind a cache, still answering
from before a permission was revoked. A permissions rollout part-way through a
fleet, one node updated and another not. An A/B branch or a feature flag, and the
account landed on the arm that has not been fixed. Each of those gives one
`privilege-escalation` at `foreign-tenant` — severity `critical`, and identical
in the report to a hole that is always open. Before such a finding goes into a
ticket, repeat the request by hand: the finding carries the `request` line to do
it with, and that is the confirmation the tool cannot perform for you.

**One `403` hides a hole**, and this is the direction nobody checks. The cell
comes back refused, agrees with the policy, and is counted in
`coverage.cellsMatched` — "tested and agreed", where what happened is "asked
once, and once it was refused". A leak open on two nodes out of three reads as
protection.

What follows for the declaration: on a platform behind a cache, a rolling deploy
or a flag system, cut the matrix rather than widen it. Twenty endpoints probed
during a quiet window, with the interesting cells repeated by hand, are worth
more than two hundred whose every row is a single sample. `docs/report.md` says
the same thing to whoever is reading the file afterwards.

## Working example

`polygon/` in the repository root is a multi-tenant test platform with twelve
switchable defects, a three-level tenant tree, an account with a set of tenants,
declared request conditions and a machine-readable oracle:

```bash
pnpm run build
node polygon/verify.mjs
```

A minimal configuration template — [`examples/minimal/`](https://github.com/Tarnellion/barbican/blob/main/examples/minimal/).

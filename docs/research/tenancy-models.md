# Multi-tenancy and access-control models

A survey of public sources: how isolation contours are arranged in multi-tenant
platforms, which access-control models stand behind them, and what of that can be
checked at all by a black box over HTTP.

**The rules of this document.** Every claim comes with a link to a public source.
Claims without a link are marked explicitly as **[not confirmed]** and are the
author's conclusion, not a quotation. No internal sources of the employer were used.

**A caveat about the availability of the texts.** The texts of ISO/IEC 27001:2022,
ISO/IEC 27002:2022, COSO Internal Control — Integrated Framework and AICPA Trust
Services Criteria are behind a paywall or hidden behind a download form. Where the
primary source could not be read, this is said at the point of citation and a
secondary source is named.

---

## 1. Tenancy models: silo, bridge, pool

### 1.1 AWS's definitions

The AWS Well-Architected SaaS Lens splits architectures into three categories —
[silo, pool and bridge](https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/silo-pool-and-bridge-models.html):

- **silo** — "an architecture where tenants are allocated separate resources": a
  separate infrastructure stack or a separate database per tenant. An essential
  caveat from AWS: even with dedicated resources, a silo "still relies on a shared
  identity, onboarding and operational experience" — otherwise it is not SaaS but a
  managed service.
- **pool** — tenants share resources. This is "the more classic understanding of
  multi-tenancy".
- **bridge** — a mixed mode: part of the system is silo, part is pool. AWS ties the
  choice directly to the profile: the regulatory profile of a service's data and its
  exposure to noisy neighbors push towards silo, while flexibility and cost push
  towards pool.

The key point for a checking tool is what AWS says about
[pool isolation](https://docs.aws.amazon.com/whitepapers/latest/saas-tenant-isolation-strategies/pool-isolation.html):

> We can't lean on the typical networking and IAM constructs to create boundaries
> between tenants.

and in the same place — that shared infrastructure "increases the chance of
cross-tenant access" rather than reducing the requirements on isolation. The list of
pool's downsides names noisy neighbors, per-tenant consumption accounting, blast
radius and "compliance pushback".

### 1.2 Isolation is neither authentication nor authorization

The most important claim in the whole section, from
[AWS SaaS Architecture Fundamentals](https://docs.aws.amazon.com/whitepapers/latest/saas-architecture-fundamentals/tenant-isolation.html):

> These constructs provide security, but not isolation. In fact, a user could be
> authenticated and authorized, and still access the resources of another tenant.
> Nothing about authentication and authorization will necessarily block this access.

In the same place: "tenant isolation focuses exclusively on using tenant context to
limit access to resources". So isolation is a separate axis, orthogonal to the role.
A two-dimensional role × endpoint matrix structurally does not cover it; that is
exactly the justification for the third dimension in
[ADR-0010](../adr/0010-resources-and-tenancy.md).

How the tenant context gets into a request —
[AWS, "Identity and isolation"](https://docs.aws.amazon.com/whitepapers/latest/saas-tenant-isolation-strategies/identity-and-isolation.html):
on authentication the system returns a tenant context, the user's binding to a tenant
plus policies, and that context flows through every interaction. The scope can be
bound to a service at deployment time or obtained at runtime.

### 1.3 The same three models at Microsoft

[Azure Architecture Center, "Tenancy models"](https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/considerations/tenancy-models)
calls them differently but splits them the same way: automated single-tenant
deployments, fully multitenant deployments, vertically partitioned, horizontally
partitioned. Isolation there is presented as a continuum rather than a binary
property ("instead of viewing isolation as a discrete property, consider it a
spectrum").

A phrasing that directly describes the leak surface in a pool:

> When multiple tenants share a single deployment (a set of infrastructure), you
> typically rely on your application code and a tenant identifier that's in a database
> to keep each tenant's data separate.

So in a pool the boundary rests on the application code and on a discriminator
column — on the things that break silently.

[The section on data storage](https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/approaches/storage-data)
adds two points that matter in practice:

- A table per tenant is declared an anti-pattern; the recommendation is "a single set
  of multitenant tables with a tenant identifier column" or separate databases per
  tenant.
- On row-level security: "you need to ensure that the user's identity and tenant
  identity are propagated through the application and into the data store with each
  query. This approach can be complex to design, implement, test, and maintain. Many
  multitenant solutions don't use row-level security because of those complexities."

And a direct requirement to test isolation empirically (in the same place, "Test your
isolation model"): "be sure to test your solution to verify that one tenant's data
isn't accidentally leaked to another".

### 1.4 The same at Google

[Google Cloud, multi-tenancy in Spanner](https://docs.cloud.google.com/spanner/docs/implement-multi-tenancy)
gives a finer scale — four patterns: instance, database, table, row. The extreme
points are described this way:

| Pattern | Isolation, in Google's own words |
|---|---|
| instance | "Greatest level of data isolation", storage is physically separated |
| database | "Complete logical isolation on the database level" |
| table | "Moderate level of data isolation", the data may sit in one file |
| row | "Lowest level of data isolation", "No tenant level security" |

The phrase "no tenant level security" for the row pattern is exactly what makes a
check from the outside the only available way to be sure of isolation: at the storage
level there is no guarantee at all, all of it is in the code of the query.

### 1.5 How the model changes the leak surface

**[not confirmed — the author's conclusion]** Bringing the above together:

| Model | Where the boundary lives | What the defect looks like | Visible in the status? |
|---|---|---|---|
| silo | the network, IAM, a separate database | an error in tenant routing: the request went to the wrong stack | yes, usually a 200 on a foreign contour with foreign data |
| bridge | shifts into the shared layer | a leak in exactly those services that are pooled | depends on the service |
| pool | a predicate in the database query | a missing filter on the discriminator | **no**: 200 in both cases |

The last row is the reason scalar signals over the response body exist
([ADR-0011](../adr/0011-response-body-signals.md)): a missing tenant filter on a list
endpoint does not change the response code, and no status will tell it apart.

---

## 2. The hierarchy of contours in B2B2C

The chain declared in the task — "platform → partner → customer organization →
division → end user" — is almost nowhere expressed by five tiers in real APIs. Two or
three are expressed, and the rest is nesting inside a single tier.

### 2.1 Stripe Connect: the contour in a header

The platform calls the API on behalf of a connected account, substituting
[the `Stripe-Account` header](https://docs.stripe.com/connect/authentication) with an
identifier of the form `acct_…` and **its own** secret key. The same effect is implied
when the account identifier is present in the URL.

This is the form most convenient for a check from the outside: the contour is a single
scalar in a header, and the credentials do not change. Substituting someone else's
`acct_…` while keeping your own key is a direct test of isolation.

[The types of connected account](https://docs.stripe.com/connect/accounts) (Standard,
Express, Custom — Stripe marks them as deprecated in favour of controller properties)
differ, among other things, in the owner's access to the dashboard (full / Express /
none) and in who carries the responsibility for fraud and chargebacks: the connected
account under direct charges, the platform under destination charges. So the depth of
the platform's visibility into the affairs of a connected account is a configuration
parameter, not a constant of the product.

### 2.2 AWS Organizations: a ceiling, not a grant

[Service control policies](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_scps.html)
behave in a fundamentally different way:

> SCPs do not grant permissions to the IAM users and IAM roles in your organization.
> No permissions are granted by an SCP. An SCP defines a permission guardrail, or sets
> limits, on the actions that the IAM users and IAM roles in your organization can
> perform.

Inheritance: "Any account has only those permissions permitted by *every* parent above
it". And a separate asymmetry: SCPs do not apply to the management account.

For a check from the outside this matters because **a denial received from the outside
does not let you establish its cause**: a 403 caused by an identity policy, by an SCP
ceiling or by a permissions boundary all look the same. AWS itself points out that
where a boundary and an SCP are both in place "the boundary, the SCP, and the
identity-based policy must all allow the action".

### 2.3 Auth0 Organizations: the contour in the token

[Auth0 Organizations](https://auth0.com/docs/manage-users/organizations/organizations-overview)
model B2B customers inside a single Auth0 tenant; a user can belong to several
organizations, and roles are assigned within an organization.

[Working with tokens](https://auth0.com/docs/manage-users/organizations/using-tokens):
the `org_id` claim (and optionally `org_name`) lands in the ID and access tokens, and
the requirement on the API is stated directly: "Your API servers must also segment
access to data and resources based on the `org_id`".

Here the contour is baked into a signed token, so it cannot be substituted from the
outside. Checking isolation requires **two sets of credentials**, not the substitution
of an identifier.

### 2.4 Okta: the contour as a separate org

[Okta, multi-tenant solutions](https://developer.okta.com/docs/concepts/multi-tenancy/)
lists four configurations: a single org with Universal Directory and groups as the
tenant abstraction; a separate org per tenant (hub-and-spoke); a hybrid; a single org
without Universal Directory. The motives for splitting orgs are data residency,
delegated administration and branding.

### 2.5 Salesforce: the contour is implicit, out of record ownership

Salesforce is an example where the horizontal boundary "tenant" does not exist in the
API at all; what exists is ownership of records.
[The sharing model](https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_bulk_sharing_understanding.htm):
the administrator sets an organization-wide default, and from there access is
**added** through record ownership, the role hierarchy, sharing rules and manual
sharing. The owner gets Full Access. Access through the role hierarchy is "derived at
runtime" rather than stored as records; the bulk of sharing, meanwhile, is "maintained
in a related sharing object, similar to an access control list (ACL)". Where several
grants apply, the most permissive one wins.

This is effectively ReBAC (see §4) and from the outside it can be checked only by
enumerating account × record pairs.

### 2.6 Atlassian: the organization as the top container

[Cloud Admin Vocabulary](https://developer.atlassian.com/cloud/admin/cloud-admin-vocabulary/):
an organization is "the highest level of hierarchy and container for Atlassian sites
and products"; a managed account is an account with an address from a verified domain.
Management goes through the
[Organizations REST API](https://developer.atlassian.com/cloud/admin/organization/rest/).

### 2.7 What the form of API access has in common

**[not confirmed — the author's generalization over §2.1–2.6]** A contour is carried
in exactly four ways, and the way determines how it can be checked at all:

| Way | Example | Substitutable from the outside? | What a test of isolation needs |
|---|---|---|---|
| A request header | `Stripe-Account` | yes | one account + someone else's identifier |
| Path/query | `/organizations/{id}/…` | yes | one account + someone else's identifier |
| A claim in a signed token | Auth0 `org_id` | no | two sets of credentials |
| A separate host / IdP | Okta org-per-tenant | no | two sets + two addresses |
| Implicitly, out of record ownership | Salesforce | — | enumeration of account × resource pairs |

The first two cases are checked with one account, the rest only with a pair of
accounts. The resource model in [ADR-0010](../adr/0010-resources-and-tenancy.md)
(`own`, `same-tenant`, `foreign-tenant`) covers both modes, because the relation is
computed between the account and a declared resource, not between the account and a
string in the URL.

---

## 3. Fintech: where exactly the boundary runs

### 3.1 BaaS and program managers

The regulatory frame is the joint guidance of three agencies
([Interagency Guidance on Third-Party Relationships: Risk Management](https://www.federalreserve.gov/supervisionreg/srletters/sr2304.htm),
June 2023; the same publication as
[OCC Bulletin 2023-17](https://www.occ.gov/news-issuances/bulletins/2023/bulletin-2023-17.html)
and [FDIC FIL-29-2024](https://www.fdic.gov/news/financial-institution-letters/2023/fil23029.html)):
engaging third parties "does not diminish or remove a banking organization's
responsibility to perform all activities in a safe and sound manner".

Where the data boundary runs is clearest in
[the FDIC's proposal on requirements for custodial deposit accounts with transactional
features](https://www.federalregister.gov/documents/2024/10/02/2024-22565/recordkeeping-for-custodial-accounts)
(RIN 3064-AG07,
[the FDIC's own summary](https://www.fdic.gov/news/financial-institution-letters/2024/requirements-custodial-deposit-accounts-transactional)):
the fintech companies "maintained the ledgers of their customers, including the deposit
amounts attributed to each individual customer", while the bank holds an omnibus
account. The proposed requirement is that the bank must keep records identifying the
beneficial owners and the balance attributable to each, reconciled no less often than
as of the end of the business day.

**[not confirmed — the author's conclusion]** From this follows the shape of the
contours in a BaaS API: bank → program (program manager) → end customer. A leak
"between programs" is a full analogue of cross-tenant: two different fintechs on one
bank API. The split between `same-tenant` and `foreign-tenant` is not decorative here:
a program's operator usually has lawful access to every customer of its own program
and none to someone else's.

### 3.2 PSP, payment facilitator, sub-merchant

The [Visa Payment Facilitator and Marketplace Risk Guide](https://usa.visa.com/content/dam/VCOM/regional/na/us/partner-with-us/documents/visa-payment-facilitator-and-marketplace-risk-guide.pdf)
(April 2021, Visa Public) gives the roles explicitly:

- **acquirer** — a Visa client licensed to provide card acceptance services;
- **third party agent** — an entity providing payment services on behalf of a Visa
  client, including those who "store, process, or transmit Visa transaction data";
- **payment facilitator** (PayFac, merchant aggregator) — an agent that contracts with
  an acquirer and in turn signs agreements with **sponsored merchants**;
- **marketplace** — an agent bringing buyers and retailers together on one venue; it is
  the marketplace, not the retailer, that is "the merchant of record".

The flow of money sets the flow of data as well: "An acquirer will deposit settlement
funds directly to the payment facilitator. The payment facilitator subsequently settles
those funds to its sponsored merchants". The responsibility sits with the acquirer: it
is "responsible for all acts, omissions, and other adverse conditions caused by the
payment facilitator and its sponsored merchants".

**[not confirmed — the author's conclusion]** Who sees whose transactions: a PayFac
sees the transactions of all its sponsored merchants (otherwise it could not settle
them); a sponsored merchant must see nobody's but its own; the acquirer sees the
aggregate per agent. The boundary worth checking from the outside is exactly "sponsored
merchant → someone else's sponsored merchant", and that is a pool boundary inside a
single PayFac.

On the PCI perimeter: PCI SSC notes that moving the processing outside "does not remove
the merchant's responsibility to ensure account data is properly protected by the third
party" and requires written agreements and annual monitoring of the provider's status
([PCI SSC FAQ](https://www.pcisecuritystandards.org/faqs/does-pci-dss-apply-to-merchants-who-outsource-all-payment-processing-operations-and-never-store-process-or-transmit-cardholder-data/)).

### 3.3 Resellers

No public normative description of reseller contours comparable in quality to the Visa
guide could be found. The nearest checkable analogy is Stripe's model of a platform and
connected accounts (§2.1), where the depth of the platform's visibility is set by the
account's configuration. **[not confirmed]**

---

## 4. Access-control models and how checkable they are from the outside

### 4.1 Definitions

**RBAC.** [NIST SP 800-162](https://csrc.nist.gov/pubs/sp/800/162/upd2/final)
describes RBAC as a model with predefined roles that carry a set of privileges; at
request time the mechanism "evaluates the role assigned to the subject requesting access
and the set of operations this role is authorized to perform on the object".

**ABAC.** In the same place, the definition: authorization is "determined by evaluating
attributes associated with the subject, object, requested operations, and, in some cases,
environment conditions against policy, rules, or relationships". And a remark of
principle: "ACLs and RBAC are in some ways special cases of ABAC in terms of the
attributes used. ACLs work on the attribute of 'identity'. RBAC works on the attribute
of 'role'. The key difference with ABAC is the concept of policies that express a
complex Boolean rule set that can evaluate many different attributes."

NIST's motive for moving to ABAC is "role explosion": an attempt to express multi-factor
decisions in roles "would require the creation of numerous roles that are ad hoc and
limited in membership".

**ReBAC.** Its pedigree is [Zanzibar](https://research.google/pubs/zanzibar-googles-consistent-global-authorization-system/)
(USENIX ATC '19): a single data model and configuration language, relations stored as
tuples, consistency provided by "zookies". The implementations:
[OpenFGA](https://openfga.dev/docs/authorization-concepts) and
[SpiceDB](https://authzed.com/docs/spicedb/concepts/schema), where the schema defines
object types, the relations between them and the permissions computed from those
relations (union, intersection, exclusion, arrow).

OpenFGA states the difference compactly: ReBAC makes access conditional on relations
between users and objects and between objects — "a user can view a document if they
have access to its parent folder"; RBAC, meanwhile, "fits flat, single-tenant access
models but breaks down with hierarchy, sharing, or multi-tenancy".

**PBAC.** In the same place: policies are moved out of the application code, and "most
ABAC implementations are also PBAC".

### 4.2 What fundamentally separates ABAC and ReBAC from RBAC when it comes to checking

The difference is not in expressiveness but in **what the decision depends on** and,
therefore, **whether the experiment is reproducible**.

**RBAC is a function of (subject, role, operation).** Its domain is finite and fully
enumerable from the outside: so many accounts, so many endpoints. Repeating a request
gives the same answer. The role × endpoint matrix is not a heuristic but an exhaustive
enumeration.

**ReBAC is a function of a graph of relations.** The graph is the state of the system
under test, and from the outside it is not visible. But it has a property that rescues
checkability: it changes only through explicit actions and is stable between requests.
So ReBAC **is checkable on the condition that the set of relations is fixed and
declared**: "resource 1001 belongs to player A, 2002 to tenant B". That is exactly the
device chosen in [ADR-0010](../adr/0010-resources-and-tenancy.md) — the relations are
declared by a human, not fished out by the tool. The price is that the tool checks only
the declared edges of the graph.

**ABAC is a function of attributes, environment attributes included.** That is what
really breaks reproducibility. OWASP ASVS lists such attributes explicitly: "time of
day, user location, IP address, or device"
([ASVS 5.0, 8.1.3](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x17-V8-Authorization.md)).
OpenFGA describes the mechanics of supplying those values:
[contextual tuples and conditions](https://openfga.dev/docs/best-practices/modeling-abac)
— the context values "provide the context values at request time", and the sources are
"the current time, client IP address, or the user's current session context".

The consequence: **the same HTTP request with the same token can lawfully give different
answers at different times and from different addresses.** The observation "got a 200"
stops being a statement about the policy and becomes a statement about one particular
run.

The strongest confirmation that ABAC is not checkable comes from NIST itself, section
3.1.2.3 "Need to Review Privilege and Monitor Authorizations"
([SP 800-162](https://csrc.nist.gov/pubs/sp/800/162/upd2/final)):

> there are some requirements to know what access each individual has before the
> requests are made. This is sometimes referred to as "before the fact audit". <…>
> An ABAC system may not lend itself well to conducting these audits efficiently. <…>
> Evaluating the set of subjects that have access to a given object requires a
> significant data retrieval and computation effort — possibly requiring every object
> owner to run a simulation of the access control request for every known subject in
> the enterprise.

A tool like barbican performs exactly that simulation, only empirically and from the
outside. NIST calls it expensive from inside the system; from the outside it is more
expensive still by the cost of the network, and it is bounded by throttling.

### 4.3 The decision point as a leak surface of its own

A separate matter worth recording: the PDP itself can leak between tenants.
[AWS Prescriptive Guidance](https://docs.aws.amazon.com/prescriptive-guidance/latest/saas-multitenant-api-access-authorization/devops-isolation-privacy.html)
recommends not storing role-mapping data inside OPA and warns that in the model of a
single shared multi-tenant policy store in Amazon Verified Permissions "role mapping
data should not reside within Verified Permissions to maintain tenant isolation". From
the outside this class of defect is not visible at all — it is not about the answer to a
data request but about the contents of the policy engine.

---

## 5. Segregation of Duties

### 5.1 How the standards phrase it

**NIST SP 800-53 Rev. 5, AC-5 "Separation of Duties"** — the control consists of two
parts: "Identify and document [Assignment: organization-defined duties of individuals]"
and "Define system access authorizations to support separation of duties". From the
discussion: separation of duties addresses "the potential for abuse of authorized
privileges" and reduces the risk of malicious action **without collusion**; the examples
are splitting functions and forbidding the staff who administer access to administer the
audit as well. It is implemented through AC-2, AC-3, IA-2/IA-4/IA-12.
([the publication](https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final); the text was
checked against a [mirror of the catalogue](https://csf.tools/reference/nist-sp-800-53/r5/ac/ac-5/),
because NIST's machine-readable catalogue is served only as PDF/OSCAL.)

**NIST SP 800-53 Rev. 5, AC-3(2) "Dual Authorization"** — the direct normative form of
the four-eyes principle: "Enforce dual authorization for [Assignment:
organization-defined privileged commands and/or other actions]", and explicitly in the
discussion: "Dual authorization, also known as two-person control, reduces risk related
to insider threats"
([mirror](https://csf.tools/reference/nist-sp-800-53/r5/ac/ac-3/ac-3-2/)).

**PCI DSS v4.0.** The text of the requirements was checked against the public
[SAQ D for Merchants v4.0](https://listings.pcisecuritystandards.org/documents/PCI-DSS-v4-0-SAQ-D-Merchant.pdf)
(April 2022), which reproduces the wording of the requirements verbatim:

- **6.5.4** — "Roles and functions are separated between production and pre-production
  environments to provide accountability such that only reviewed and approved changes
  are deployed." The applicability notes allow a replacement by procedural controls
  where the staff is small — separate accounts for the different roles of one person,
  for instance.
- **7.2.1** — an access control model is defined, including "the least privileges required
  (for example, user, administrator) to perform a job function".
- **7.2.2** — access is assigned "based on: job classification and function; least
  privileges necessary to perform job responsibilities".
- **7.2.3** — "Required privileges are approved by authorized personnel."
- **7.2.4** — a review of all accounts and privileges, third-party accounts included, no
  less often than once every six months.

**ISO/IEC 27001:2022, Annex A 5.3 "Segregation of duties"** — the control requires
conflicting duties to be separated; where that is impossible (small organizations), it is
compensated by activity monitoring, audit logs and management oversight. The text of the
standard itself is behind a paywall; the summary is taken from a secondary source
([ISMS.online, on Annex A 5.3](https://www.isms.online/iso-27001/annex-a-2022/5-3-segregation-of-duties-2022/)).
**[the primary source was not checked]**

**COSO.** The primary source is behind a paywall. A publicly available document with the
same structure of 17 principles is the [GAO Green Book, GAO-14-704G](https://www.gao.gov/assets/gao-14-704g.pdf),
where Segregation of Duties is an attribute of Principle 10 "Design Control Activities":

> Management divides or segregates key duties and responsibilities among different
> people to reduce the risk of error, misuse, or fraud. This includes separating the
> responsibilities for authorizing transactions, processing and recording them,
> reviewing the transactions, and handling any related assets so that no one individual
> controls all key aspects of a transaction or event. (fig. 6, p. 47)

Paragraphs 10.12–10.14 add: incompatible duties are separated, and where that is
impractical, alternative controls are designed; SoD addresses the risk of management
override but "cannot absolutely prevent it because of the risk of collusion". Whether the
Green Book corresponds to the 2013 edition of COSO specifically was not verified against
the primary source. **[not confirmed]**

**SOC 2.** In the AICPA Trust Services Criteria, criterion CC5.1 corresponds to COSO
principle 10 and carries a point of focus about separating incompatible duties:
management "segregates incompatible duties, and where such segregation is not practical,
management selects and develops alternative control activities". The official PDF is
served only through a download form on aicpa-cima.com
([the resource page](https://www.aicpa-cima.com/resources/download/2017-trust-services-criteria-with-revised-points-of-focus-2022)),
and the wording is taken from secondary sources. **[the primary source was not checked]**

### 5.2 How SoD is expressed in an API

Three common names for one and the same thing — maker-checker, the two-person rule, the
four-eyes principle. The normative wording is AC-3(2) above. No public standard
describing the **API form** of this pattern (resource names, state transitions, response
codes) could be found: only industry commentary turns up. **[not confirmed]**

**[the author's conclusion]** The observable form is nevertheless always the same: the
action is split into creating a request and approving it, between them the resource
lives in the `pending` state, and the invariant reads "the approver is not the creator".

### 5.3 Is SoD checkable from the outside

It is, but only under three conditions at once, and all three conflict with the tool's
current invariants:

1. **Unsafe methods are needed.** Creating a request and attempting to approve it are a
   POST or a PUT. By default only GET and HEAD are performed (`SAFE_METHODS`), so SoD is
   out of scope without an explicit `--unsafe-methods`.
2. **Two accounts and an order between them are needed.** The check is not a single cell
   of the matrix but an ordered pair of requests: A created it, A tries to approve it (a
   denial is expected), B approves it (success is expected). The account × endpoint ×
   resource matrix does not express such an order.
3. **The run changes the state of the system under test.** After the test an approved or
   rejected resource stays in the system. That is no longer reconnaissance but
   interference.

What is checkable **without** breaking the invariants: reading only — whether an account
sees a queue of approval requests it is not meant to see. That is ordinary BFLA, not SoD.

---

## 6. Identifiers for mapping findings

### 6.1 OWASP API Security Top 10 2023

[The full list of the 2023 edition](https://owasp.org/API-Security/editions/2023/en/0x11-t10/).
Three items are relevant:

| Identifier | Name | CWE per the OWASP text |
|---|---|---|
| **API1:2023** | [Broken Object Level Authorization](https://owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/) | CWE-285, CWE-639 |
| **API3:2023** | [Broken Object Property Level Authorization](https://owasp.org/API-Security/editions/2023/en/0xa3-broken-object-property-level-authorization/) | CWE-213, CWE-915 |
| **API5:2023** | [Broken Function Level Authorization](https://owasp.org/API-Security/editions/2023/en/0xa5-broken-function-level-authorization/) | CWE-285 |

Two OWASP phrasings bear directly on how the checks are built:

- API1: "Attackers can exploit API endpoints that are vulnerable to broken object-level
  authorization by manipulating the ID of an object that is sent within the request."
- API5: the diagnostic questions are phrased as tests — "Can a regular user access
  administrative endpoints?", "Can a user perform sensitive actions … by simply changing
  the HTTP method (e.g. from `GET` to `DELETE`)?", "Can a user from group X access a
  function that should be exposed only to users from group Y, by simply guessing the
  endpoint URL and parameters (e.g. `/api/v1/users/export_all`)?" And a warning:
  "Don't assume that an API endpoint is regular or administrative only based on the URL
  path."

### 6.2 OWASP ASVS 5.0, section V8 Authorization

[Chapter V8](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x17-V8-Authorization.md).
The items that matter for multi-tenancy:

| Item | Level | Requirement (abbreviated) |
|---|---|---|
| 8.1.1 | L1 | the documentation defines the rules of function-level and data-specific access |
| 8.1.3 | L3 | the environment and context attributes that influence decisions are documented |
| 8.2.1 | L1 | function-level access is restricted to explicit permissions |
| 8.2.2 | L1 | data-specific access is restricted to explicit permissions — against IDOR/BOLA |
| 8.2.3 | L2 | field-level access is restricted to explicit permissions — against BOPLA |
| 8.3.1 | L1 | the rules are enforced on a trusted server-side layer |
| 8.3.3 | L3 | access is based on the rights of the originating subject, not of an intermediary acting on its behalf |
| **8.4.1** | **L2** | **"multi-tenant applications use cross-tenant controls to ensure consumer operations will never affect tenants with which they do not have permissions to interact"** |

8.4.1 is the only requirement known in ASVS that states exactly what the tool checks.
8.1.1 is worth noting separately: ASVS requires the rules to be **documented** — an
independent confirmation of the approach in
[ADR-0006](../adr/0006-expected-access-declaration.md), where expected access is declared
by a human.

8.3.3 matters for B2B2C: a platform acting on behalf of a connected account (§2.1) must
not extend that account's rights with its own.

### 6.3 CWE

| CWE | Name | Abstraction level | MITRE's wording |
|---|---|---|---|
| [284](https://cwe.mitre.org/data/definitions/284.html) | Improper Access Control | Pillar | "does not restrict or incorrectly restricts access to a resource from an unauthorized actor" |
| [285](https://cwe.mitre.org/data/definitions/285.html) | Improper Authorization | Class | "does not perform or incorrectly performs an authorization check" |
| [862](https://cwe.mitre.org/data/definitions/862.html) | Missing Authorization | Class | "does not perform an authorization check" |
| [863](https://cwe.mitre.org/data/definitions/863.html) | Incorrect Authorization | Class | "performs an authorization check …, but it does not correctly perform the check" |
| [639](https://cwe.mitre.org/data/definitions/639.html) | Authorization Bypass Through User-Controlled Key | Base | "does not prevent one user from gaining access to another user's data or record by modifying the key value identifying the data" |

The hierarchy: 284 → 285 → {862, 863}; 639 is a child of 863.

**[the author's conclusion]** The practical consequence for mapping: from the outside 862
and 863 cannot be told apart. "There is no check" and "there is a check, but it is wrong"
give an identical answer. The honest mapping for a finding obtained from a single
response code is 285 (the class), or 639 where the defect was reproduced specifically by
substituting someone else's identifier into a parameter.

---

## 7. What is checkable by a black box over HTTP

This section answers the question honestly, that is, in both directions.

### 7.1 A summary by model

| Model / boundary | Visible from the outside | By which observation | What is fundamentally not visible from the outside |
|---|---|---|---|
| **RBAC**, role × endpoint | yes, fully | the response code: 2xx against 401/403 | which role or permission exactly fired; the name of the permission |
| **A hierarchy of contours**, the identifier in a header or a path | yes | substituting someone else's identifier while keeping your own credentials | whether the identifier belongs to an existing contour |
| **A hierarchy of contours**, the identifier in a signed token | yes, with two sets of credentials | comparing the responses of two accounts on one resource | the contents of the claims in someone else's token |
| **BOLA / IDOR**, a resource by identifier | yes, if the resource's owner is declared | a 200 where a denial was declared | resources the human did not declare |
| **BFLA**, an administrative function | yes | a 200 on an administrative address from a non-administrative account | whether the address is administrative (OWASP warns directly against inferring it from the URL path) |
| **the pool discriminator**, a missing filter on a list | partially | **only** through a scalar over the body: the size of the selection or an irreversible digest; the response code is not enough — 200 in both cases | the leaked data itself, whose it is, the volume of the leak in records |
| **ReBAC** | yes, within the declared graph | enumeration of account × resource pairs | the shape of the schema, the computed permissions, the edges of the graph the human did not declare |
| **ABAC** | no, in the general case | — | environment attributes (time, IP, device, session flags) that are fed into the PDP at request time; the result is not reproducible |
| **PBAC / a ceiling from above** (SCP and the like) | no | — | the cause of the denial: an identity policy, a parent's guardrail or a boundary all give one and the same 403 |
| **BOPLA**, the fields of an object | no | — | which fields were handed out and which were accepted for writing; that requires reading the body |
| **SoD / maker-checker** | no in safe mode | requires POST/PUT, a pair of accounts and an order between the requests; changes the state of the system | everything except reading the approval queue (and that is BFLA already) |
| **Isolation inside the PDP** (a shared policy store) | no | — | a leak of role mappings between tenants inside the policy engine |

### 7.2 Four honest caveats

**A denial does not explain itself.** Every cause of a denial looks like one and the same
code. From the outside you cannot tell "the role is wrong", "the tenant is foreign",
"forbidden by a parent's policy" and "the time condition was not met" apart. The tool can
state only "there is access" or "there is no access", never "why".

**A 404 instead of a 403 is recommended practice and a blind spot at the same time.**
Hiding the very fact that a resource exists makes "the resource is absent" and "the
resource exists, but is not yours" indistinguishable. Observing a 404 on someone else's
resource is **not** proof of isolation. **[the author's conclusion]**

**The absence of a finding is not evidence of isolation.** Only what was declared is
checked: the declared resources, the declared accounts, the declared relations
([ADR-0010](../adr/0010-resources-and-tenancy.md)). This is a deliberate narrowing, not a
temporary limitation. The report's claim is "there are no discrepancies on the declared
set", and it does not scale up to "there are no leaks".

**A single run is a statement about the run, not about the policy.** For RBAC and ReBAC
the difference is immaterial: the decision is stable between requests. For ABAC it is
fundamental, because the context is supplied at request time
([OpenFGA](https://openfga.dev/docs/best-practices/modeling-abac),
[ASVS 8.1.3](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x17-V8-Authorization.md)),
and a repeat run at another time will lawfully give another result. A report on a system
with ABAC must record the time of the run and must not pass an observation off as a
statement about the policy.

### 7.3 The bottom line for the tool

A check from the outside fully covers RBAC and the boundaries of contours, covers ReBAC
to the extent of the graph declared by a human, covers pool isolation only through
irreversible scalars over the body, and does not cover ABAC, PBAC ceilings, BOPLA or SoD.

That is not a defect of the method. In SP 800-162 NIST describes the "before the fact
audit" — the question "who has access to what before the request is made" — as something
ABAC handles badly even from inside the system, with full access to the attributes and
the policies. From the outside the task does not get easier; it gets more honest, in the
sense that what is checked is behaviour and not the intent declared by the configuration.

---

## Sources

**Tenancy models:**
[AWS SaaS Lens: Silo, Pool, and Bridge Models](https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/silo-pool-and-bridge-models.html) ·
[AWS SaaS Lens: Tenant isolation](https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/tenant-isolation.html) ·
[AWS: SaaS Tenant Isolation Strategies — Pool isolation](https://docs.aws.amazon.com/whitepapers/latest/saas-tenant-isolation-strategies/pool-isolation.html) ·
[AWS: Identity and isolation](https://docs.aws.amazon.com/whitepapers/latest/saas-tenant-isolation-strategies/identity-and-isolation.html) ·
[AWS SaaS Architecture Fundamentals: Tenant isolation](https://docs.aws.amazon.com/whitepapers/latest/saas-architecture-fundamentals/tenant-isolation.html) ·
[AWS Prescriptive Guidance: tenant isolation and privacy of data](https://docs.aws.amazon.com/prescriptive-guidance/latest/saas-multitenant-api-access-authorization/devops-isolation-privacy.html) ·
[Azure: Tenancy models](https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/considerations/tenancy-models) ·
[Azure: Storage and data approaches](https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/approaches/storage-data) ·
[Google Cloud: multi-tenancy in Spanner](https://docs.cloud.google.com/spanner/docs/implement-multi-tenancy)

**The hierarchy of contours:**
[Stripe Connect: authentication](https://docs.stripe.com/connect/authentication) ·
[Stripe Connect: account types](https://docs.stripe.com/connect/accounts) ·
[AWS Organizations: SCPs](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_scps.html) ·
[Auth0 Organizations](https://auth0.com/docs/manage-users/organizations/organizations-overview) ·
[Auth0: tokens and organizations](https://auth0.com/docs/manage-users/organizations/using-tokens) ·
[Okta: multi-tenant solutions](https://developer.okta.com/docs/concepts/multi-tenancy/) ·
[Salesforce: understanding sharing](https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_bulk_sharing_understanding.htm) ·
[Atlassian Cloud Admin Vocabulary](https://developer.atlassian.com/cloud/admin/cloud-admin-vocabulary/)

**Fintech:**
[Fed SR 23-4 / Interagency Guidance on Third-Party Relationships](https://www.federalreserve.gov/supervisionreg/srletters/sr2304.htm) ·
[OCC Bulletin 2023-17](https://www.occ.gov/news-issuances/bulletins/2023/bulletin-2023-17.html) ·
[FDIC: Recordkeeping for Custodial Accounts (NPR, RIN 3064-AG07)](https://www.federalregister.gov/documents/2024/10/02/2024-22565/recordkeeping-for-custodial-accounts) ·
[Visa Payment Facilitator and Marketplace Risk Guide (2021)](https://usa.visa.com/content/dam/VCOM/regional/na/us/partner-with-us/documents/visa-payment-facilitator-and-marketplace-risk-guide.pdf) ·
[PCI SSC FAQ: outsourcing the processing](https://www.pcisecuritystandards.org/faqs/does-pci-dss-apply-to-merchants-who-outsource-all-payment-processing-operations-and-never-store-process-or-transmit-cardholder-data/)

**Access models:**
[NIST SP 800-162 (ABAC)](https://csrc.nist.gov/pubs/sp/800/162/upd2/final) ·
[Zanzibar, USENIX ATC '19](https://research.google/pubs/zanzibar-googles-consistent-global-authorization-system/) ·
[OpenFGA: authorization concepts](https://openfga.dev/docs/authorization-concepts) ·
[OpenFGA: modeling ABAC](https://openfga.dev/docs/best-practices/modeling-abac) ·
[SpiceDB: schema](https://authzed.com/docs/spicedb/concepts/schema)

**Segregation of Duties:**
[NIST SP 800-53 Rev. 5](https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final) ·
[PCI DSS v4.0 SAQ D for Merchants](https://listings.pcisecuritystandards.org/documents/PCI-DSS-v4-0-SAQ-D-Merchant.pdf) ·
[GAO Green Book (GAO-14-704G)](https://www.gao.gov/assets/gao-14-704g.pdf) ·
[AICPA Trust Services Criteria (resource page)](https://www.aicpa-cima.com/resources/download/2017-trust-services-criteria-with-revised-points-of-focus-2022) ·
[ISO/IEC 27001:2022 Annex A 5.3 — secondary source](https://www.isms.online/iso-27001/annex-a-2022/5-3-segregation-of-duties-2022/)

**Standards for mapping:**
[OWASP API Security Top 10 2023](https://owasp.org/API-Security/editions/2023/en/0x11-t10/) ·
[OWASP ASVS 5.0, V8 Authorization](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x17-V8-Authorization.md) ·
[CWE-284](https://cwe.mitre.org/data/definitions/284.html) ·
[CWE-285](https://cwe.mitre.org/data/definitions/285.html) ·
[CWE-639](https://cwe.mitre.org/data/definitions/639.html) ·
[CWE-862](https://cwe.mitre.org/data/definitions/862.html) ·
[CWE-863](https://cwe.mitre.org/data/definitions/863.html)

All sources were read on 2026-08-12.

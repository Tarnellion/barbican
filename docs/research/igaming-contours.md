# Access contours in multi-brand iGaming platforms

- **Status:** research over public sources, not a decision
- **Date:** 2026-08-12

## Why

`barbican` has one tenant axis: `Account.tenantId`, `Resource.tenantId` and the
three-valued relation `own | same-tenant | foreign-tenant` (ADR-0010). The model was
adopted without being tied to any particular domain. This document checks how many
isolation contours multi-brand iGaming really has, and which of them do not fit on one
axis.

The practical output is the section ["What of this is checkable by HTTP responses"](#what-of-this-is-checkable-by-http-responses):
which of the defects described here the tool is capable of seeing at all, and which it
is not, and why.

## About the sources

Only public materials were used. They are of three different kinds, and they must not
be mixed:

1. **Regulatory documents and standards** (MGA, UKGC, GLI, N.J.A.C., GDPR) — they say
   what *must* be. The hardest kind.
2. **Public technical documentation of integrations** (Hub88, Praxis, Sumsub,
   TheAffiliatePlatform) — it says how the *interface between contours* is arranged. It
   describes the format and the duties of the parties firmly; it says nothing about how
   any particular operator has implemented it.
3. **Marketing materials from platform vendors** — good only as evidence of what is
   sold under the word "multi-tenancy". Marked explicitly.

Where a claim is not confirmed by a source, it is marked as a general observation. No
internal sources of the employer were used — neither as a source of facts nor as a
source of examples.

---

## 1. Contours

### 1.1 What the regulation confirms

The regulator cuts the industry along a different seam than the architect does. The key
split is between whoever **holds the licence and answers to the player** and whoever
**supplies the software**.

Malta issues two different types of authorization: B2C and B2B. B2B is "critical gaming
supply", a licence to supply and manage software, "to generate, capture, control or
otherwise process any essential regulatory record"
([MGA, B2B licences](https://www.mga.org.mt/licensee-hub/applications/b2b-licences/game-providers-and-back-office/)).
So the platform (PAM, back office) and the game supplier are licensed separately from
the operator that takes bets from the player.

Britain describes multi-brand operation directly and calls it white label: the licensee
provides gambling under a third party's brand, and "responsibility for compliance
will always sit with the licence holder"
([UKGC, Compliance and enforcement report 2019–20, White label partnerships](https://www.gamblingcommission.gov.uk/report/raising-standards-for-consumers-compliance-and-enforcement-report-2019-20/white-label-partnerships)).
From the same document — a list of what broke at the licensees: responsibility handed
to partners without oversight, no "live access to customer records",
an inability to track a player's behaviour across all partners and to detect
"multiple accounts across all white label domains". The regulator requires "a holistic
view of customer activity" instead of a per-domain one.

This matters more than it seems: **in the UK model the brand owner is not licensed at
all**, it has no regulatory status of its own, and all of its access to player data is
a delegation from the licensee.

GLI-19, the standard for interactive gaming systems, notices multi-brand operation in
one place only — in testing: "where testing is requested for a "white-label"
version of the system, a specific configuration will be tested and reported"
([GLI-19 v3.0, §1.5.2](https://gaminglabs.com/wp-content/uploads/2024/06/GLI-19-Interactive-Gaming-Systems-v3.0.pdf)).
There are no requirements on isolation *between brands* in the standard: it is all about
one instance of the system. This is the first gap between the industry standard and the
real architecture.

### 1.2 The breakdown of contours, and what it clarifies

| Contour | Who this is | Confirmation |
|---|---|---|
| Platform supplier (PAM) | holder of the player accounts, the wallet, the back office | [MGA B2B](https://www.mga.org.mt/licensee-hub/applications/b2b-licences/game-providers-and-back-office/), [GLI-19 §2.5](https://gaminglabs.com/wp-content/uploads/2024/06/GLI-19-Interactive-Gaming-Systems-v3.0.pdf) |
| Game aggregator / content supplier | calls the operator's wallet, holds no account | [Hub88 Wallet API](https://docs.hub88.io/developer-docs/operator-api-reference/wallet-api) |
| Payment gateway | sends notifications about deposits and withdrawals | [Praxis Cashier, notification](https://doc.cashier-test.com/integration_docs/3.4/payment_api/notification) |
| KYC provider | stores the documents, sends webhooks about the status | [Sumsub, Webhook manager](https://docs.sumsub.com/docs/webhook-manager) |
| Licensee (operator) | answers to the regulator for everything above | [UKGC white label](https://www.gamblingcommission.gov.uk/report/raising-standards-for-consumers-compliance-and-enforcement-report-2019-20/white-label-partnerships) |
| Brand / skin / white label partner | a trade mark and a domain, may have no regulatory status | the same |
| Affiliate | brings traffic, sees a report on "its own" players | [TheAffiliatePlatform, Affiliate Account](https://help.theaffiliateplatform.com/affiliate-platform/affiliate-account) |
| Player | own account, own history | [GLI-19 §2.5.2, §A.3](https://gaminglabs.com/wp-content/uploads/2024/06/GLI-19-Interactive-Gaming-Systems-v3.0.pdf) |

Clarifications to the original breakdown:

**"Platform / software provider" is two different contours, not one.** The PAM holds the
accounts, the balances and the PII; the game aggregator holds nothing, it calls someone
else's wallet. Their direction of call is opposite and, therefore, so is their trust
model (see §3.2). Merging them into one contour means losing exactly the boundary the
money runs through.

**The aggregator and the payment gateway do not fold into one contour either.** The
aggregator is a consumer of the operator's API (`POST /transaction/bet` is implemented
by the operator); the payment gateway, on the contrary, is a sender of notifications
towards the operator. All they have in common is that both arrive from the outside
without a user session.

**"A holding / group of brands" is not a regulatory entity.** A licence is issued to a
legal entity; a group can hold several licences, and the regulator does not merge them.
The William Hill case (2023) is telling: the record package of £19.2 million was broken
out across three licensees of the group separately — WHG (International) £12.5 million,
Mr Green £3.7 million, William Hill Organization £3 million
([UKGC](https://www.gamblingcommission.gov.uk/news/article/william-hill-group-businesses-to-pay-record-gbp19-2m-for-failures)).
The group contour exists in reporting and in BI, but not as a subject of law. Any access
by the group to the player data of a particular licensee is a transfer of data between
controllers, not "looking at one's own" (see §4).

**What the breakdown lacks and the sources have:**

- **The jurisdictional contour.** One and the same trade mark under different licences
  is different contours with incompatible requirements. New Jersey: "all servers
  utilized for internet gaming … shall be located in Atlantic City", in a restricted area
  ([N.J.A.C. 13:69O-1.2](https://www.law.cornell.edu/regulations/new-jersey/N-J-A-C-13-69O-1-2),
  [the text of chapter 69O](https://www.nj.gov/oag/ge/docs/Regulations/CHAPTER69O.pdf)).
  Malta requires the critical components to be in Malta / the EEA or in a jurisdiction
  recognized by the Authority, plus a live replica of the regulatory data in Malta
  ([MGA, Technical Infrastructure](https://www.mga.org.mt/app/uploads/Technical-Infrastructure-hosting-Gaming-and-Control-Systems-Remote-Gaming.pdf)).
  This is an axis of isolation orthogonal to the brand: two brands of one jurisdiction
  may share infrastructure, one brand in two jurisdictions may not.
- **The regulator as an access contour.** MGA requires "immediate and unhindered access"
  to the replica for inspections, physically and electronically (in the same place). The
  regulator has an access level of its own to production data — that is not an
  abstraction but an account.
- **Agent networks.** Multi-tier trees of agent → sub-agent → player with commissions by
  tier are a standard product from platform vendors
  ([PartnerMatrix, Agent Management System](https://partnermatrix.com/agent-system/),
  vendor material). This is a contour with recursive nesting, which neither brands nor
  affiliates have.
- **Curaçao: the domain as an object of regulation.** Since the LOK, domains are managed
  through the CGA portal or through its API, and the seal and the certificate are bound
  to a specific authorized domain, with a public check of the form `https://cert.cga.cw/certificate?id=DOMAIN_TOKEN`
  ([CGA License Management Portal](https://portal.gamingcontrolcuracao.org/)).
  The mapping "brand → licence" is public here by design — which, incidentally, is a
  ready external source for an oracle, independent of the system under test.

### 1.3 Terminology

"Skin", "brand", "white label" and "turnkey" are interchangeable in industry texts and
mean substantively different things: with white label the licence stays with the
provider, with turnkey the operator gets its own (the difference is described in vendor
surveys, e.g.
[SOFTSWISS](https://www.softswiss.com/knowledge-base/what-is-white-label-solution/),
marketing material). Only one thing matters for the access model: **whether the boundary
of the brand coincides with the boundary of the licence**. If it does not, the data
boundary runs along the licensee, and the brand stays merely a label in the request.

The word "operator" is overloaded: to the regulator it is the licensee, in integration
APIs it is the party implementing the wallet (Hub88's `operator_id` is an identifier of
an integration, not of a legal entity). This is not pedantry: if `operator_id` is issued
per brand while one licence covers all the brands, then two "operators" in the
aggregator's terms have one owner of the data — and the other way round as well.

---

## 2. Isolation between brands

### 2.1 Models

The industry vocabulary here is not a gambling one but the general SaaS one: silo (a
stack per tenant), pool (shared resources, isolation by policies), bridge (a mixture).
Two things matter, stated in the AWS SaaS documentation more precisely than in any
gambling standard:

> Authentication and authorization are not equal to isolation … a user could be
> authenticated and authorized, and still access the resources of another tenant.

> Isolation enforcement should not be left to service developers — … it's unrealistic
> to expect that they will never unintentionally cross a tenant boundary.

([AWS, The isolation mindset](https://docs.aws.amazon.com/whitepapers/latest/saas-tenant-isolation-strategies/the-isolation-mindset.html),
[AWS, Tenant isolation](https://docs.aws.amazon.com/whitepapers/latest/saas-architecture-fundamentals/tenant-isolation.html)).

That is exactly the thesis `barbican` exists for: RBAC and isolation are different
properties, and a role × endpoint matrix without a third dimension checks only the first.

Gambling regulation approaches the topic from one side only — the infrastructural one.
MGA: an architecture is deemed to satisfy the principles "when the critical components
are hosted on a private cloud environment which is not shared with other tenants on
the same cloud"; a virtual private cloud is permitted subject to a risk assessment.
An annex to the same document lists the risks, among them, in so many words,
"isolation failure" and "malicious activities by other tenant(s) of the cloud"
([MGA, Technical Infrastructure](https://www.mga.org.mt/app/uploads/Technical-Infrastructure-hosting-Gaming-and-Control-Systems-Remote-Gaming.pdf)).
Among the critical components MGA names player database servers, financial database
servers and gaming database servers — that is, exactly the stores where the cross-brand
boundary lives.

Note the asymmetry: the regulator regulates the isolation of **the platform from other
tenants of the cloud** and is silent about the isolation of **one brand from another
inside the platform**. The second is entirely on the conscience of the operator and its
supplier.

### 2.2 What it looks like in the request

Three ways of identifying a brand are publicly documented, and all three occur in
integration APIs:

- **An explicit identifier in the body or the parameters.** `operator_id` at the game
  aggregator
  ([Hub88](https://docs.hub88.io/developer-docs/operator-api-reference/getting-started));
  `merchant_id` ("Merchant API client account identifier") plus `application_key`
  ("Identifier of your application (website)") at the payment gateway
  ([Praxis](https://doc.cashier-test.com/integration_docs/3.4/payment_api/notification)).
  It is telling that at Praxis the identifier of the **site** is separated from the
  identifier of the merchant: the brand there is a first-class entity, separate from the
  legal entity.
- **A domain / subdomain.** At Curaçao the domain is a regulated entity bound to a
  certificate ([CGA portal](https://portal.gamingcontrolcuracao.org/)); at UKGC
  supervision explicitly requires not stopping at a per-domain view
  ([white label partnerships](https://www.gamblingcommission.gov.uk/report/raising-standards-for-consumers-compliance-and-enforcement-report-2019-20/white-label-partnerships)).
  So the domain both routes and carries the meaning of the contour.
- **Inheritance from the account.** A player belongs to a brand by the fact of
  registration; GLI-19 requires "A player shall only be permitted to have one active
  player account at a time unless specifically authorized by the regulatory body"
  ([GLI-19 v3.0, §2.5.2](https://gaminglabs.com/wp-content/uploads/2024/06/GLI-19-Interactive-Gaming-Systems-v3.0.pdf)),
  but that is about one instance of the system: on a multi-brand platform one person
  normally has an account per brand.

Hence the typical defect that follows from the construction: **the brand is taken from
the request, not from the credentials.** If `brand_id` is a parameter, then the
reliability of isolation equals the reliability of the check "this `brand_id` is the same
as the token's", performed in every handler. This is exactly the case AWS writes
"should not be left to service developers" about. I found no direct public analysis of
such a defect in iGaming specifically (see §5), so here this is a consequence drawn from
general sources, not a documented incident.

### 2.3 Where it breaks: the evidence

Public evidence that the pool model is applied to brands exists, and it is unpleasant:
in January 2019 the researcher Justin Paine found an open ElasticSearch with roughly
108 million records of bets, deposits and withdrawals, with names, addresses and phone
numbers; among the domains in the data were `kahunacasino.com`, `azur-casino.com`,
`easybet.com`, `viproomcasino.net`, which belonged to one group
([Security Affairs](https://securityaffairs.com/80173/data-breach/online-casinos-data-leak.html);
the primary source is Catalin Cimpanu's note in ZDNet). Several brands, one index, one
hole. In itself this is not a defect of access control in an API, but it is direct proof
that the brands' data sits together — and therefore that the only thing separating it is
code.

The second and rarer class: **isolation where there should be none**. In 2017 the UKGC
fined 888 £7.8 million; in the commission's wording — "over 7,000 customers who had
chosen to self-exclude from their casino/poker/sport platform were still able to
access their accounts on their bingo platform", because of a technical fault that went
unnoticed for 13 months
([UKGC](https://www.gamblingcommission.gov.uk/news/article/gambling-firm-888-to-pay-over-gbp7-8million-for-failing-vulnerable-customers)).
The product silos did not exchange self-exclusion state.

This makes the domain fundamentally harder than ordinary SaaS: **the boundary is
constrained from both sides**. PII and commercial data must not flow between brands;
self-exclusion status, limits and signs of multiple accounts must. The LCCP requires the
licensee to have procedures for self-exclusion and for removal from the marketing
databases used "by the company or group"
([LCCP 3.5.3](https://www.gamblingcommission.gov.uk/licensees-and-businesses/lccp/condition/3-5-3-remote-sr-code)),
and beyond that there is the cross-operator self-exclusion scheme GAMSTOP
([LCCP 3.5.5](https://www.gamblingcommission.gov.uk/licensees-and-businesses/lccp/condition/3-5-5-remote-multi-operator-sr-code)).

A design error here is possible in both directions, and the second is punished with a
fine just as the first is.

---

## 3. What is specific to the domain

### 3.1 Affiliate cabinets

An affiliate is an outside party with access to reports about **other people's**
players, the ones it brought in. The reward model (CPA, RevShare, hybrid) determines
which fields it needs: RevShare requires showing NGR and therefore the player's losses.

What the cabinet actually shows is visible from the public documentation. The
registrations report in TheAffiliatePlatform contains "External user ID, TAP user ID +
Registration Date + Brand + Username (if sent to TAP by the platform) + Affiliate",
and it says directly: "The fields available to the affiliate in the registration report
are controlled by the "additional permissions" list in the Affiliate Account"
([TAP, Reporting interfaces / BI](https://help.theaffiliateplatform.com/reporting/reporting-interfaces-bi.md),
[TAP, Affiliate Account](https://help.theaffiliateplatform.com/affiliate-platform/affiliate-account)).
The same at Affilka: an affiliate sees only those fields, filters and groupings that
were opened to it by the report-visibility settings
([Affilka, Features](https://affilka.com/features/), vendor material).

Three consequences, each of them a potential defect:

1. **Field visibility is flags, not a role.** The set of columns is determined by a list
   of permissions on a particular affiliate account. This is literally authorization at
   the level of an object's property, that is,
   [API3:2023 Broken Object Property Level Authorization](https://owasp.org/API-Security/editions/2023/en/0xa3-broken-object-property-level-authorization/)
   by construction. An error in one flag does not change the status of the response — it
   adds a column.
2. **`Brand` is present in an affiliate's report.** An affiliate usually works with
   several brands of one program, and the boundary "its brands" runs inside the
   reporting endpoint, not along the URL.
3. **`Username` goes outside if the platform handed it over.** The phrase "if sent
   to TAP by the platform" means that the volume of PII at the affiliate is determined
   by an export setting on the operator's side. GLI-19 is categorical about this:
   "Unauthorized third-party service providers shall be prevented from viewing or
   altering PII and other sensitive information", and when PII is passed to third
   parties, formal data processing agreements are required
   ([GLI-19 v3.0, §B.5.3](https://gaminglabs.com/wp-content/uploads/2024/06/GLI-19-Interactive-Gaming-Systems-v3.0.pdf)).

What an affiliate must not see does not follow line by line from the sources; the
general frame is GDPR (minimization) and §B.5.3 of GLI-19. The claim "an affiliate is
not entitled to passport data, payment details and support correspondence" is a general
observation, not confirmed by any separate document.

### 3.2 Game providers and the seamless wallet

The direction of the call here is the reverse of the usual one, and that changes
everything. In the seamless model **the operator implements the endpoints and the
aggregator calls them**: `/user/info`,
`/user/balance`, `/transaction/bet`, `/transaction/win`, `/transaction/rollback`
([Hub88, Wallet API](https://docs.hub88.io/developer-docs/operator-api-reference/wallet-api)).

How it is authenticated: "RSA-SHA256 is used to sign the request body using the
private key. The signature is validated using the public key associated with the
provided `operator_id`", the signature is passed in `X-Hub88-Signature` and is verified
against the raw body, without deserialization
([Hub88](https://docs.hub88.io/developer-docs/operator-api-reference/wallet-api)).

Three features critical for the access model:

- **There is no user session.** The request carries `user` ("The unique User ID in the
  Operator's system") and `token` ("The game session token that was passed within
  `/game/url` endpoint response"). So the player is identified by an identifier from
  the operator's system, and their right to act by the game session token that the
  operator itself issued. The documentation explicitly makes the operator responsible
  for checking the token's validity and idempotency by `transaction_uuid`.
- **The binding "token ↔ player ↔ brand" is the operator's duty, and it is not
  expressed in the protocol.** If the operator debits by the `user` from the body
  without checking it against the owner of the `token`, the result is a BOLA with
  consequences measured in money. This follows from the structure of the API; I found
  no publicly documented case of such an error.
- **A denial costs dearly.** If no 200 arrives within the timeout, the transaction is
  deemed unsuccessful and a rollback is generated (in the same place). An authorization
  error that answers with the wrong code turns into a financial discrepancy rather than
  a 403 in the log.

The second mode is the transfer wallet, where the balance is moved to the provider and
back ([Hub88, TransferWallet API](https://docs.hub88.io/developer-docs/operator-api-reference/transferwallet-api)):
the contour is the same, but the state temporarily lives on someone else's side.

### 3.3 Payment callbacks

Arranged the same way — an incoming call with no session, trust resting on a signature.
At Praxis the notification carries `merchant_id`, `application_key`, `pin` ("Unique
customer id in your system"), `trace_id`, `transaction_id`, `order_id`, a status and a
signature; the merchant is instructed to verify the signature, wait for the final
status, check `charge_amount` and `charge_currency` (rather than the amount requested),
match `order_id` against its own record and take the validity window into account
([Praxis, notification](https://doc.cashier-test.com/integration_docs/3.4/payment_api/notification);
the current documentation has moved to [docs.praxis.tech](https://docs.praxis.tech/)).

What matters here is that **the brand is identified by a field in the signed body**. So
isolation between brands on this contour rests on the signing key being bound to the
merchant and on the handler not taking `application_key` at face value.

### 3.4 KYC providers

The same pattern, with data of the highest sensitivity. Sumsub signs webhooks with HMAC
using a per-webhook secret; the algorithm is passed in `X-Payload-Digest-Alg`
(`HMAC_SHA256_HEX` by default), and the recipient checks `x-payload-digest` against the
digest it computed
([Sumsub, Webhook manager](https://docs.sumsub.com/docs/webhook-manager)).

A feature of this contour: the player's documents are physically stored at the
processor, while the operator keeps the status and the applicant's identifier. That is
good for isolation (PII is not smeared across brands) and bad for auditing: brand staff
access the documents through the provider's console, that is, **outside** the platform's
access matrix — and therefore outside any check that walks the operator's API.

### 3.5 What the three contours have in common

The game provider, the payment gateway and KYC all arrive from the outside, without a
user, by POST, with a signature, and their calls change state. This is a separate class
of surface to which the model "an account with a role and a tenant" is inapplicable in
principle: there is no account there, there is a key. For a tool that works on behalf of
accounts and by default only with GET/HEAD, this class lies outside the scope — and
should stay there (see §6).

---

## 4. Regulation and access to PII between tiers

### 4.1 The requirements that are confirmed

- **Malta.** The critical components — RNG, jackpot, player/financial/gaming database
  servers — are hosted in Malta, the EEA or a recognized third jurisdiction; the
  information security level is ISO/IEC 27001, and PCI DSS Level 1 for payment data; a
  live replica of the regulatory data is required in Malta, with a procedure for
  immediate access by inspectors. "Player Data" is defined extremely broadly: "Any data
  which contributes or may contribute to the identification of a player"
  ([MGA, Technical Infrastructure](https://www.mga.org.mt/app/uploads/Technical-Infrastructure-hosting-Gaming-and-Control-Systems-Remote-Gaming.pdf)).
- **Britain.** The RTS security requirements are a subset of Annex A of ISO/IEC
  27001:2022, and the controls are named one by one: 5.15 Access control, 5.16 Identity
  management, 5.17 Authentication information, 5.18 Access rights, 8.2 Privileged access
  rights, 8.15 Logging, 8.22 Segregation of networks, 8.24 Use of cryptography
  ([UKGC, RTS section 4](https://www.gamblingcommission.gov.uk/standards/remote-gambling-and-software-technical-standards/4-remote-gambling-and-software-technical-standards-rts-security-requirements)).
  This is probably the most useful handle for the future module 2: a list of items the
  checks can be mapped onto.
- **GLI-19.** Logical access control (§B.2.3), an access policy with the principle of
  least privilege and formal registration/deregistration of users (§C.2.3), a
  prohibition on changing credentials without supervised access controls that log the
  previous and the new value (§B.3.2), a prohibition on unauthorized third parties
  viewing or altering PII (§B.5.3), mandatory recording of significant events on a
  player's account — balance adjustments, "changes made to PII and other sensitive
  information recorded in a player account", deactivation of the account (§2.8.8).
  A separate annex covers
  the operational audit of service providers
  ([GLI-19 v3.0](https://gaminglabs.com/wp-content/uploads/2024/06/GLI-19-Interactive-Gaming-Systems-v3.0.pdf)).
- **New Jersey.** Servers in Atlantic City, in a restricted area
  ([N.J.A.C. 13:69O-1.2](https://www.law.cornell.edu/regulations/new-jersey/N-J-A-C-13-69O-1-2)).

### 4.2 What the sources do not have

**I found no gambling regulator that directly prescribes "the holding sees the
aggregate but not the PII of a particular brand".** The wording is plausible and
probably describes common practice, but I have no confirmation of it in a regulatory
document. The constraint comes from another side — from data protection:

- A group of companies has no access privilege. GDPR merely acknowledges that
  controllers within a group "may have a legitimate interest in transmitting personal
  data within the group of undertakings for internal administrative purposes"
  ([Recital 48](https://gdpr-info.eu/recitals/no-48/)) — that is a basis that has to be
  justified and balanced, not a default permission.
- How far this is from a formality is visible in the cross-operator project for sharing
  data about harm (single customer view / GamProtect): the participants chose
  "legitimate interest" as the legal basis and went through a separate clearance with
  the ICO before starting the exchange ([iGaming Business](https://igamingbusiness.com/sustainable-gambling/ico-greenlights-financial-data-sharing-with-operators/),
  [NEXT.io](https://next.io/news/technology/ico-approves-data-sharing-for-gambling/) —
  industry press, not a primary source). If end-to-end sharing requires such a procedure
  between operators, then inside a group it is not free either.
- That the data regulator punishes flows outside their purpose is shown by the ICO's
  reprimand of Sky Betting and Gaming (September 2024): advertising cookies were set
  before consent was obtained, and personal data went to third parties without a legal
  basis
  ([ICO](https://ico.org.uk/about-the-ico/media-centre/news-and-blogs/2024/09/action-taken-against-sky-betting-and-gaming-for-using-cookies-without-consent/)).

**The resulting balance of forces:** the UKGC requires the licensee to have an
end-to-end view of the player across all of its white label domains; data protection
requires that this view not be extended beyond the licensee without a basis. The design
boundary runs between the **licensee** and the **group**, not between brands. A
breakdown where the holding stands one tier above the operator and "sees the aggregate"
is a reasonable implementation of that, but not a requirement of the regulator.

---

## 5. Public vulnerability classes and incidents

### 5.1 Classes

There is no specialized taxonomy for iGaming; everything described is
[OWASP API Security Top 10 2023](https://owasp.org/API-Security/editions/2023/en/0x11-t10/)
in a particular setting:

| Class | What it looks like on a multi-brand platform |
|---|---|
| [API1:2023 BOLA](https://owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/) | substituting `brand_id`/`operator_id`/`player_id` in the path or query of a reporting endpoint |
| [API3:2023 BOPLA](https://owasp.org/API-Security/editions/2023/en/0xa3-broken-object-property-level-authorization/) | extra columns in an affiliate's report; PII in an export where only the amounts are needed |
| [API5:2023 BFLA](https://owasp.org/API-Security/editions/2023/en/0xa5-broken-function-level-authorization/) | an affiliate account reaches a brand's administrative endpoint |

BOLA in OWASP's wording describes exactly the case of interest: the user has access to
the endpoint itself by design, and the violation happens at the level of the resource —
by manipulating an identifier.

### 5.2 Incidents confirmed publicly

- **A group of brands, one open index (January 2019).** ~108 million records of bets
  and transactions with full names, addresses and phone numbers; the data features the
  domains of several casinos of one group
  ([Security Affairs](https://securityaffairs.com/80173/data-breach/online-casinos-data-leak.html)).
- **The backend of a casino's mobile app with no password (February 2024).** A database
  with customers' names, phone numbers, email addresses and home addresses was reachable
  from the internet without authentication
  ([TechCrunch](https://techcrunch.com/2024/02/09/winstar-hotel-casino-app-exposed-customer-personal-data/)).
- **Compromise of a platform supplier (March 2020).** Ransomware at SBTech: the company
  "immediately shut down its data centers", and the services of its operator clients
  were interrupted; as part of the deal with DEAC a $30 million escrow was created
  against the consequences
  ([BleepingComputer, from an SEC filing](https://www.bleepingcomputer.com/news/security/draftkings-discloses-sbtech-ransomware-attack-in-sec-filing/)).
  This is not an access-control defect, but it is an exact illustration of the blast
  radius of the platform contour: one incident means unavailability at every brand at
  once.
- **An incident at a B2B supplier (August 2025).** Bragg Gaming Group reported an
  intrusion into its internal IT systems, stating that the gaming services were
  unaffected and that, according to early forensics, PII was not touched
  ([The Register](https://www.theregister.com/2025/08/19/bragg_attack/)).
- **Isolation instead of connectedness (August 2017).** 888: self-exclusion did not
  propagate from casino/poker/sport to bingo, 7,000+ players kept their access, a fine
  of £7.8 million
  ([UKGC](https://www.gamblingcommission.gov.uk/news/article/gambling-firm-888-to-pay-over-gbp7-8million-for-failing-vulnerable-customers)).
- **Supervisory findings on white label (2019–20).** The absence of live access to
  customer records and the inability to detect multiple accounts across all white label
  domains — a publicly recorded defect of cross-brand visibility specifically
  ([UKGC](https://www.gamblingcommission.gov.uk/report/raising-standards-for-consumers-compliance-and-enforcement-report-2019-20/white-label-partnerships)).

### 5.3 What could not be found

An honest negative result, because it determines how far the rest can be trusted:

- **There is no public analysis of a BOLA on `brand_id` in an iGaming platform.**
  Nothing turned up on these queries — not in HackerOne's disclosed reports, not in CVE,
  not in research publications. The class is real (OWASP), the domain is vulnerable by
  construction (§2.2), but I have no specific public case.
- **There is no publicly documented "affiliate → operator" escalation.** Not a single
  case. Vulnerabilities in general-purpose affiliate products (not iGaming) do exist in
  CVE — for example, an authentication bypass with account takeover and privilege
  escalation in a WordPress plugin for an affiliate program
  ([CVE-2024-9289](https://wpscan.com/vulnerability/20327eff-4132-4159-a96b-a2edab0f3776/)) —
  but carrying that over to iGaming cabinets as a fact is not permissible.
- **I did not find leaks through reporting endpoints as a classified incident.** The
  known leaks in the industry are open stores, not broken authorization in an API.
  Perhaps it is a matter of observability: an open ElasticSearch is found by a scanner,
  while a BOLA in a private cabinet is found only by someone who has an account.

---

## What of this is checkable by HTTP responses

From here on, "the tool" means `barbican` in its present model: accounts with a role and
a tenant, resources with a declared owner and tenant (ADR-0010), an observation = the
status + filtered headers + irreversible scalars over the body (`digest`,
`count`, `present` — ADR-0011), by default GET and HEAD only.

### Visible

| Defect | How it is visible |
|---|---|
| Brand A's cabinet reads a resource of brand B by an identifier in the path or query | the status: `foreign-tenant` + `allowed` instead of `denied`; a classic BOLA |
| An affiliate account reaches a brand's administrative endpoint (BFLA) | the status: the policy rule `roles: [affiliate] → denied`, a 200 observed |
| A reporting endpoint is reachable without authentication | the status: an anonymous account (`tokenEnv` is optional, ADR-0010) |
| A list endpoint does not filter by brand | `digest`: two accounts of different tenants got a matching digest of the 200 response on an endpoint from `responseMustDifferByTenant` — the `identical-response-across-tenants` check |
| A list endpoint filters incompletely | `count`: the number of elements at the declared path is the same for accounts of different tenants, or is plainly larger than expected |
| An endpoint that should not exist in this contour at all | the status: 200 instead of 404/403 |

It matters that the fourth and fifth rows are the only way to see the most frequent
defect of isolation. A correct and a defective implementation of a list answer with the
same 200, and without signals over the body the difference does not exist (ADR-0011).

### Not visible, and why

1. **The contours of the game provider, the payment gateway and KYC — entirely.** These
   are POSTs, incoming from the outside, authenticated by a signature rather than a
   session, and they change the balance. Three invariants are against it at once: safe
   by default (GET/HEAD only), the absence of any notion of a "signing key" in the
   account model, and the prohibition on actions with irreversible consequences. The
   tool cannot check that the operator matches `user` against the owner of the `token`,
   and must not: the only way to check it is to perform a debit.
2. **The correctness of an aggregate.** "The holding sees the aggregate for brand A
   instead of its own" — a 200 and a number in both cases. `count` does not save it:
   aggregation collapses the rows, and the number of elements does not change. A
   fundamentally invisible class.
3. **Attribution of a leak.** `digest` answers "are the bytes the same", not "whose data
   is inside". The tool is capable of stating "two tenants saw one and the same thing";
   the conclusion "brand A saw brand B's players" is drawn by a human.
4. **A field inside an element of a list.** `present` resolves a path through objects
   only: `resolvePath` returns `undefined` as soon as it meets an array
   (`src/adapters/signals.ts`). So "an `email` column appeared in the affiliate's
   report" — which is exactly §3.1 and API3:2023 — is not checked today. Only a field at
   the top level of the response object is visible. This is a limitation of the
   implementation, not of an invariant: an index segment in the path does not require
   extending `SignalValue`.
5. **A cell that passed proves almost nothing.** A 403 does not distinguish "denied
   because the tenant is foreign" from "denied because the role is wrong" and from
   "there is no such resource". The wording for the report is "no violations were found
   on the declared resources", not "isolation works". For a future evidence pack this is
   the difference between evidence and an imitation of it.
6. **Everything about state over time.** The propagation of self-exclusion between
   brands (§2.3), deduplication of accounts across domains, retention — this is not
   access but the behaviour of the system after a write. Outside the tool's scope by
   definition.
7. **Access that goes around the operator's API.** The KYC provider's console, the
   payment gateway's portal, BI over the replica, an MGA inspector's access to the
   replicated data. The platform's access matrix knows nothing about them.

### What the domain says about the tool's model

Three discrepancies, recorded as observations — with no proposal to change the code.

**The contours are nested, and the tenant axis is one.** `relationOf` compares the
`tenantId` of the account and of the resource (`src/core/types.ts`), giving three
values. The real hierarchy is group → licensee → brand → affiliate → player, and the
role of "the foreign one" depends on which tier you look from. Two affiliates of one
brand are `same-tenant`, which means `identical-response-across-tenants` will not fire
on them, although a leak between affiliates is no less serious than one between brands.
Declaring an affiliate a separate tenant is possible, but then the pair "a brand's
operator ↔ its own affiliate" becomes `foreign-tenant`, which is wrong: the operator is
entitled to its affiliate. One axis does not express the domain — at least not without a
convention about which contour exactly counts as the tenant in a given run. Such a
convention is worth writing down explicitly, at least in the examples.

**A brand is often determined by the host, while the target is one.** The configuration
has one `target.baseUrl` and one `allowedHosts` list (ADR-0008, in its consequences:
"revisit if a need for several targets in one run appears"). Meanwhile a brand by
subdomain is the typical case (§2.2), and the most interesting request — "brand A's
token, brand B's Host" — is not expressible today. This is probably the cheapest way to
bring the tool closer to the domain: the host as part of the description of a resource,
not only of the target.

**There is already somewhere to map onto items of standards.** `CheckRegistry` requires
a check to carry a mapping onto items of external standards, and a suitable list has
been found: RTS section 4 names the ISO/IEC 27001:2022 controls one by one (5.15, 5.16,
5.17, 5.18, 8.2, 8.15), and GLI-19 gives §B.2.3, §C.2.3, §B.3.2, §B.5.3. For module 2
these are ready anchors that do not require buying a standard.

---

## Sources

Regulators and standards:

- [MGA — Technical Infrastructure hosting Gaming and Control Systems (Remote Gaming)](https://www.mga.org.mt/app/uploads/Technical-Infrastructure-hosting-Gaming-and-Control-Systems-Remote-Gaming.pdf)
- [MGA — B2B licences: game providers and back office](https://www.mga.org.mt/licensee-hub/applications/b2b-licences/game-providers-and-back-office/)
- [UKGC — RTS section 4, security requirements](https://www.gamblingcommission.gov.uk/standards/remote-gambling-and-software-technical-standards/4-remote-gambling-and-software-technical-standards-rts-security-requirements)
- [UKGC — White label partnerships (compliance and enforcement report 2019–20)](https://www.gamblingcommission.gov.uk/report/raising-standards-for-consumers-compliance-and-enforcement-report-2019-20/white-label-partnerships)
- [UKGC — LCCP 3.5.3 (remote self-exclusion)](https://www.gamblingcommission.gov.uk/licensees-and-businesses/lccp/condition/3-5-3-remote-sr-code), [LCCP 3.5.5 (multi-operator)](https://www.gamblingcommission.gov.uk/licensees-and-businesses/lccp/condition/3-5-5-remote-multi-operator-sr-code)
- [GLI-19 v3.0 — Standards for Interactive Gaming Systems](https://gaminglabs.com/wp-content/uploads/2024/06/GLI-19-Interactive-Gaming-Systems-v3.0.pdf)
- [N.J.A.C. 13:69O-1.2](https://www.law.cornell.edu/regulations/new-jersey/N-J-A-C-13-69O-1-2), [NJ DGE, Chapter 69O](https://www.nj.gov/oag/ge/docs/Regulations/CHAPTER69O.pdf)
- [Curaçao Gaming Authority — License Management Portal](https://portal.gamingcontrolcuracao.org/)
- [GDPR Recital 48](https://gdpr-info.eu/recitals/no-48/)
- [ICO — action against Sky Betting and Gaming (2024)](https://ico.org.uk/about-the-ico/media-centre/news-and-blogs/2024/09/action-taken-against-sky-betting-and-gaming-for-using-cookies-without-consent/)

Technical documentation of integrations:

- [Hub88 — Wallet API](https://docs.hub88.io/developer-docs/operator-api-reference/wallet-api), [Getting started](https://docs.hub88.io/developer-docs/operator-api-reference/getting-started), [TransferWallet API](https://docs.hub88.io/developer-docs/operator-api-reference/transferwallet-api)
- [Praxis Cashier — payment notification](https://doc.cashier-test.com/integration_docs/3.4/payment_api/notification), [current documentation](https://docs.praxis.tech/)
- [Sumsub — Webhook manager](https://docs.sumsub.com/docs/webhook-manager)
- [TheAffiliatePlatform — Reporting interfaces / BI](https://help.theaffiliateplatform.com/reporting/reporting-interfaces-bi.md), [Affiliate Account](https://help.theaffiliateplatform.com/affiliate-platform/affiliate-account)

Isolation models:

- [AWS — SaaS Tenant Isolation Strategies: the isolation mindset](https://docs.aws.amazon.com/whitepapers/latest/saas-tenant-isolation-strategies/the-isolation-mindset.html)
- [AWS — SaaS Architecture Fundamentals: tenant isolation](https://docs.aws.amazon.com/whitepapers/latest/saas-architecture-fundamentals/tenant-isolation.html)
- [OWASP API Security Top 10 2023](https://owasp.org/API-Security/editions/2023/en/0x11-t10/)

Incidents:

- [Security Affairs — data leak at a group of online casinos (2019)](https://securityaffairs.com/80173/data-breach/online-casinos-data-leak.html)
- [TechCrunch — an open database of a casino app (2024)](https://techcrunch.com/2024/02/09/winstar-hotel-casino-app-exposed-customer-personal-data/)
- [BleepingComputer — ransomware at SBTech, per an SEC filing (2020)](https://www.bleepingcomputer.com/news/security/draftkings-discloses-sbtech-ransomware-attack-in-sec-filing/)
- [The Register — incident at Bragg Gaming Group (2025)](https://www.theregister.com/2025/08/19/bragg_attack/)
- [UKGC — the 888 fine (2017)](https://www.gamblingcommission.gov.uk/news/article/gambling-firm-888-to-pay-over-gbp7-8million-for-failing-vulnerable-customers), [the fine on the William Hill group (2023)](https://www.gamblingcommission.gov.uk/news/article/william-hill-group-businesses-to-pay-record-gbp19-2m-for-failures)

Vendor materials (marketing, not a source of facts about particular implementations):

- [SOFTSWISS — what is a white label solution](https://www.softswiss.com/knowledge-base/what-is-white-label-solution/)
- [PartnerMatrix — agent management system](https://partnermatrix.com/agent-system/)
- [Affilka — features](https://affilka.com/features/)

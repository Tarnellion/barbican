# How to read the report

This document is written from the questions of a person who saw the report for
the first time with no explanation at all, not from the structure of the JSON.
He gave the report 2 out of 5 and refused to file tickets until he had settled
three things. Everything he asked is answered here — and what the report really
does not have yet is named honestly.

The ADR links point to GitHub rather than to a neighbouring file: this document
usually arrives attached to a report, without the rest of the repository. An ADR
is a short note about a non-obvious decision: context, decision, rejected
alternatives. No conclusion here requires following a link — the links are for
people who want to dispute a decision, not to understand the report.

## What actually happened

The tool probed **cells** and compared what it observed against what you declared.

A cell is **account × endpoint × resource × request conditions**. Endpoints
without path parameters have no resource, and that coordinate drops out;
conditions are usually absent entirely, and then a cell is the familiar triple.
So the number of probed cells is not "accounts × endpoints": it is larger.

```
Cells probed: 144 (matrix rows 27, of them accounts 9 and the same accounts
under contexts, endpoints 6, resources 6)
```

Every number quoted in this document comes from one run — the reference polygon
with all defects switched on, 13 August 2026. They illustrate the shape of the
output; yours will be different, and a difference is not a discrepancy.

**There are more matrix rows than accounts** when request conditions are
declared: one account gives a row per set of conditions. Count cells from
`accountRows`, not from `accounts` — otherwise the arithmetic will not add up.
Conditions have a section of their own below.

Every cell's response reduces to one of four outcomes:

| Response code | Outcome | Meaning |
|---|---|---|
| 2xx | `allowed` | access granted |
| 401, 403, 451 | `denied` | access refused |
| 404 | `not-found` | **not** a denial: the resource is absent, or it is being hidden |
| everything else | `error` | no conclusion can be drawn |

451 stands next to 401 and 403 not for the sake of completeness: "unavailable
for legal reasons" is a decision not to serve, not a failure and not a missing
resource. That is how geo and jurisdiction restrictions answer, and without this
row a healthy platform would give a wall of `probe-error` exactly where it
behaves correctly.

404 is set apart deliberately. Returning 404 instead of 403 is a legitimate
defensive move, but it is indistinguishable from "the resource does not exist",
and recording it as a successful denial would pass ignorance off as proof of
protection. For the same reason 3xx, 5xx and 400 land in `error`, not in `denied`.

## One list of findings

`findings` holds everything that was found, whatever the means of detection. The
`source` field says which one:

| `source` | Found by | What it carries |
|---|---|---|
| `matrix` | comparison against the declared policy | `expected`, `actual`, `relation` |
| `check` | a check from the registry | `title`, `evidence` |

Both share `kind`, `severity`, `accountId`, `endpointId` and `request`. For
matrix discrepancies `kind` is the kind of discrepancy (`privilege-escalation`
and others); for check findings it is the check's identifier.

**There used to be two lists, and that turned out to be an expensive mistake.**
The same cross-tenant leak landed in a different list depending on whether it
was visible by status or by body — that is, a difference in the **means of
detection** was passed off as a difference in the nature of the finding. The
cost: `bySeverity` counted only the first list and showed half the real number,
`byKind` did not count the second at all, and grouping by signature did not
extend to checks — six clones of one finding inflated the picture sixfold. Three
symptoms, one cause.

The practical consequence for the reader: **the most exploitable defect may well
carry `source: "check"`**. A list endpoint with no tenant filter answers 200 both
in a correct and in a leaky implementation; to make use of it you do not need to
guess identifiers — logging in is enough.

## Summary fields

| Field | What it means |
|---|---|
| `observations` | how many cells were probed |
| `findings` | finding rows — **not** the number of defects; equals the length of the array |
| `checkFindings` | how many findings were found by body rather than by status |
| `byKind` | by kind; the keys are kinds of discrepancy and check identifiers |
| `bySeverity` | by severity |
| `defectGroups` | distinct defect signatures — a **lower bound** |
| `defectsBySeverity` | the same by severity, but counting **defects**, not rows |
| `defects[].violations` | how many rows this defect produced — **not** "probes performed". For findings by body a row is a **pair of accounts**, not a cell |
| `skipped` / `failures` | what was not probed and what failed, with reasons |

### Why "at least N defects"

One defect in the platform touches as many cells as there are. One missing
tenant filter gives ten rows; three BOLAs, seen by a user and by an
administrator, give six.

Rows collapse to the signature "endpoint × kind × relation". Role is not part of
the signature: an endpoint open to a user and to an admin alike is one defect,
not two. Relation is part of it: BOLA inside a tenant and a cross-tenant leak
live on the same endpoint and break independently.

The tool **does not know the exact number of defects and cannot know it**: two
different bugs with the same signature are indistinguishable from the outside.
The number of signatures is the lower bound, the number of rows the upper one.
Details and an example — [ADR-0015](https://github.com/Tarnellion/barbican/blob/main/docs/adr/0015-defect-grouping.md).

### Severity

It is computed from the kind of discrepancy and the relation to the resource,
not declared:

| Discrepancy | Relation | Severity |
|---|---|---|
| `privilege-escalation` | `foreign-tenant` | critical |
| `privilege-escalation` | `ancestor-tenant`, `same-tenant`, `descendant-tenant`, no resource | high |
| `privilege-escalation` | `own` | medium |
| `unexpected-denial` | any | medium |
| `not-observed`, `probe-error` | — | low |

**Read `defectsBySeverity`, not `bySeverity`, when you answer the question "how
many problems do we have".** `bySeverity.critical: 10` is one missing filter that
touched ten cells. The same count over defects gives 1. Rows are for working
through, defects are for deciding.

Findings by body (`source: "check"`) have no `relation` field and do not fall
under the table above: the check itself assigns their severity. For the single
check that exists today it is `high`.

**A set of tenants on an account lowers the severity, and that is not a bug.** A
support account declared in `tenant-a` and `tenant-b` at once, reaching for a
resource of the second tenant, gets the relation `same-tenant`, not
`foreign-tenant` — and a finding on the same endpoint comes out `high` where a
single-tenant account would have made it `critical`. You declared the
membership; the tool compares behaviour against that declaration, not against a
guess about what the membership ought to be. If a set is declared wider than it
really is, the report weakens silently — there is nobody but you to check what
the sets contain.

`own` is lowered deliberately: an account's access to its own resource, declared
forbidden, is almost always a mistake in the policy, not a hole in the platform.
The reasoning — [ADR-0014](https://github.com/Tarnellion/barbican/blob/main/docs/adr/0014-severity-and-exit-codes.md).

## Exit codes

| Code | Meaning |
|---|---|
| 0 | tested, no discrepancies |
| 1 | tested, there are discrepancies |
| 2 | **the result cannot be trusted** |
| 64 | the command line was wrong; nothing was sent |
| 130 | interrupted from the keyboard part-way through the walk |

The last two are about the invocation, not about the platform. **64** is
`EX_USAGE`, and it is separate for one reason: until 15 August 2026 an unknown
flag exited 1, which is this table's "tested, there are discrepancies" — a typo
reported as a privilege escalation, in the one place where the exit code is the
whole interface. The line is drawn at the start of the run: what the argument
parser rejects is 64, and anything failing after that is 2. **130** is the
ordinary `128 + SIGINT`; a run that ends this way has written no report.

A 2 outranks a 1: what was not tested is never clean. It is returned when any of
these holds:

| Reason | What it means |
|---|---|
| no observations at all | the source gave no endpoints, or every cell was skipped |
| `truncated: true` | the request budget ran out or the circuit breaker tripped, and the tail of the matrix was never reached |
| an account got no access anywhere it was declared to have some | the credentials do not work, or the address is wrong |
| **no canary was checked**, while at least one account carries credentials | authentication is confirmed by nothing. A policy made only of denials leaves the safety net above with nothing to say: nothing is declared accessible, so "no access anywhere" never triggers |
| **half or more of the requests failed** | the report describes the state of the network or the deployment, not the platform. Fewer failures are ordinary partial failures: they are visible in `failures` and in `byKind`, and they do not cancel the verdicts on the cells that survived |

An unexpected denial also gives **1**. The tool compares the declared intent
against observed behaviour, and a discrepancy is a discrepancy whichever way it
points. It cannot tell which side is wrong — the platform or your declaration —
and since it cannot, it has no right to stay silent.

## How to tell "clean" from "nothing was tested"

This is the main question to ask of any report like this, and there is something
in it to stand on.

**Canaries.** `canaries` lists by name which account confirmed authentication on
which endpoint. If `authenticated: false`, the run stops before any observations
are collected: a 401 reads as a denial, a denial agrees with the expectation
wherever access is not meant to be granted, and the report would come out
spotless having tested nothing. An empty list means no canaries were declared;
then "clean" rests on nothing.

**`byKind["not-observed"]`.** A cell the policy declared but which could not be
observed. A non-zero value is a hole in coverage.

**`byKind["unexpected-denial"]` with observations that are not empty.** Indirect
but strong evidence: if the tokens had gone stale, cells expected to be allowed
would have given unexpected denials, and a zero here would be impossible.

**`truncated`.** The run was cut short: the ceiling on requests was used up, or
the circuit breaker tripped. The tail of the matrix was not tested, and there are
no findings there precisely because it was never reached.

## How to tell a broken platform from a misread one

The mirror of the question above, and the one worth asking **before** you forward
a report full of findings. There is a way for every cell to be wrong at once, and
it does not look like an error.

barbican decides whether access was granted from the **status code alone**. A
platform that answers `200 OK` and puts the outcome in the body —
`{"success": false, "error": {"code": "FORBIDDEN"}}` — reads as "allowed"
everywhere. Every cell the policy declared `denied` then becomes a
`privilege-escalation` finding, and the report describes a catastrophe that is
not there.

Two things in the report say it, and neither of them is a field of its own:

- **`byKind["privilege-escalation"]` is roughly the number of cells your policy
  denies.** A real platform fails in places. One that fails everywhere, in the
  same direction, on every account including the anonymous one, is more likely
  being misread than uniformly broken.
- **Every observation carries `status: 200`.** Open one cell you are certain
  about — an ordinary account against an admin endpoint — and read it. A `200`
  where a `403` was expected settles it in one look.

If that is your platform, **no** part of this report can be believed, and there
is no flag that fixes it. Not the matrix, and not the body checks either — the
natural guess is that comparing digests is safe from a status-code problem, and
it is wrong: those checks run only on cells that came back `allowed`, which here
is all of them, and two accounts both **refused** get the same envelope and the
same digest. On a six-cell demo platform of this kind the report came out with
four privilege escalations — every cell the policy denies — and one
`identical-response-across-tenants` that is two refusals, not a shared record.

See `docs/guide.md`, "A platform that refuses with 200".

## What was tested and what was not

The `coverage` section answers the question without which the numbers above mean
nothing. The numbers in this example come from one particular run — the reference
polygon with all nine defects switched on, 15 August 2026 — and they are here to
show the shape of the section, not to be compared with yours. Your run will
differ in every one of them:

```jsonc
"coverage": {
  "endpointsTotal": 7,          // how many the source gave
  "endpointsProbed": 6,         // how many were actually probed
  "cellsObserved": 144,
  "cellsMatched": 74,           // observed, and nothing was found on them
  "cellsWithFindings": 70,      // observed, and something was
  "cellsNotObserved": 0,        // declared by the policy, but not observed
  "notProbed": { "unsafe-method": 1 },   // why an endpoint was not probed, by reason
  "bodiesComparedOn": ["orders.list"],    // where bodies were compared
  "writeMethodsProbed": false,
  "checksRun": ["identical-response-across-tenants"],
  "bodyComparison": [
    {
      "endpointId": "orders.list",
      "comparedPairs": 24,
      "skippedRelatedPairs": 39,          // shared tenant or kinship in the tree
      "skippedDifferentContextPairs": 147 // different conditions — cannot compare
    }
  ],
  "contextsProbed": { "geo-blocked": 45, "wide-scope": 9 }
}
```

**`cellsMatched` is "tested and agreed".** It used to be something you had to get
by subtraction, and "it is clean here" existed in the report only as the reader's
own arithmetic. As a number it is checkable:

    cellsMatched + cellsWithFindings === cellsObserved

If that does not hold, the report is lying. **Note that the second term is not
`summary.findings`:** that counts rows, and one cell can produce several of them
at once — a discrepancy over the status code and a body one on the same cell are
two findings and one cell. This document offered the sum over
`summary.findings` until 15 August 2026, and on the run above it gave 156 against
144 observed.

**`bodiesComparedOn` matters more than it looks.** On every other endpoint the
absence of a finding means "no comparison was made", not "nothing matched".
Without this list you cannot see the difference.

**`checksRun` lists the checks that ran, including the ones that found nothing.**
Without it, a check that someone forgot to register, or that crashed, would give
a report indistinguishable from a clean one: its key shows up in `byKind` only
once it has found something.

**`skippedDifferentContextPairs` — pairs under different conditions.** They are
not compared on purpose: in such a pair the tenant and the context attributes
differ at once, and equal digests would say nothing about either. What the check
asserts is "different tenants get different responses **all else being equal**".

**`bodyComparison` answers the question "was this pair compared at all".**
`bodiesComparedOn` names the endpoint but stays silent about a particular pair of
accounts, and that silence reads as "nothing matched". Yet not every pair is
compared: accounts of the same tenant are skipped (a match between them is
legitimate), and accounts related in the tree — parent and descendant — are
skipped in the same way, because a holding is supposed to see its descendant's
data. On the reference-platform run 8 pairs out of 21 were compared and 13 were
skipped as related; without these numbers "there are no findings on the pair" and
"the pair was not compared" are indistinguishable.

**`contextsProbed` answers the question "did anything go out under these
conditions at all".** Every declared set of conditions has a key, including with
a zero: its endpoints may have gone into `skipped`, and then the absence of
findings means "it was not tested", not "everything is in order under these
conditions".

**`endpointsTotal` is the denominator of the source, not of the whole API.** If
you gave the tool a list of six endpoints while the platform has a hundred, the
report does not know that and cannot know it.

## Resources nobody could reach

`coverage.resourcesNotFound` names the resources every account was answered 404
for. Their cells settle nothing: a missing object refuses exactly like a
protected one, and `not-found` counts as a denial, so every one of those cells
agrees with a policy of denial and reads as "tested and agreed".

Two situations produce the same list and cannot be told apart by status: the
object is not there, or the platform hides its existence from everyone. For a
reader they mean the same thing — no conclusion about isolation follows from
those cells.

Where an owner **is** granted access this surfaces on its own: that account's
cell expects `allowed`, gets a denial and lands in `findings` as an unexpected
denial. The field is for the other half, where the declaration grants nobody
anything and there is nothing to contradict.

## What the tool did not test

- **Write methods.** Without `--unsafe-methods` only GET and HEAD are performed;
  `coverage.writeMethodsProbed` says whether it was otherwise. "Clean" applies
  to reading.
- **Endpoints outside the list.** Exactly what you declared was tested.
- **Response bodies.** They are not stored. They are read in transit only where
  you declared `bodySignals`, and only for the sake of irreversible scalars ([ADR-0011](https://github.com/Tarnellion/barbican/blob/main/docs/adr/0011-response-body-signals.md)).
  Which means a whole class — extra fields in an otherwise legitimate response —
  is out of reach.
- **Whether the context attributes reached the application.** The tool sends the
  declared headers and parameters, but cannot make sure a proxy or a load
  balancer did not strip them on the way. If they were stripped, requests under
  conditions repeat the base ones, and the report will say "the restriction does
  not work" where it simply was not tested. This is the one place where "was not
  tested" is not reliably distinguishable from "does not work", and on someone
  else's perimeter it is worth keeping in mind: confirming that the attributes
  were delivered has to happen outside the tool.
- **Checks by body run only on the declared endpoints.** If an endpoint is not
  named in `bodySignals.responseMustDifferByTenant`, the absence of a finding
  means "no comparison was made", not "clean".

## What the report has about signals

`signals` in an observation are scalars computed over the body. `digest` is the
first 48 bits of SHA-256 over the body with a **salt that is random for every
run**. Comparing digests across runs is meaningless; within a run it is
meaningful.

An observation is identified by the triple **`accountId` + `endpointId` +
`resourceId`**; on endpoints without path parameters `resourceId` is absent, and
the key degenerates into a pair. The same triple links a finding to the
observation it came from — observations have no identifier of their own. The
observation itself carries `method`, `url`, `status`, `at` (the moment of the
request), the redacted headers, `outcome`, `durationMs` and, where `bodySignals`
are declared, `signals`.

**And the verdict on its own cell:**

```jsonc
{
  "accountId": "alice-a", "endpointId": "orders.read", "resourceId": "order-b-2001",
  "status": 403, "outcome": "denied",
  "expected": "denied",       // what the human declared
  "relation": "foreign-tenant",
  "match": true,              // tested and agreed
  "ruleIndex": 11             // which rule gave the expectation; absent — the fallback fired
}
```

`match: true` is **the only place in the report where a positive result is
visible cell by cell and not as a total**. It was absent on principle before, and
"it is clean here" had to be obtained by subtraction: a reader checking a single
cell was rewriting the tool's core in his own language
([ADR-0020](https://github.com/Tarnellion/barbican/blob/main/docs/adr/0020-verdict-next-to-observation.md)).

**A cell cannot be listed as agreed and appear in `findings` at the same time.**
Two things judge a cell: the walk over the matrix, by status code, and the checks
over response bodies. Both have to be satisfied, and it is worth knowing that
until 15 August 2026 only the first reached this field — on the reference run
twelve cells were printed as agreed while carrying a high-severity leak.

Which is why a `false` here sometimes has no visible cause on the row. This one
is a real cell from that run:

```jsonc
{
  "accountId": "alice-a", "endpointId": "orders.list",
  "status": 200, "outcome": "allowed",
  "expected": "allowed",      // declared allowed, and allowed is what happened
  "match": false,             // and still it did not agree
  "findingKinds": ["identical-response-across-tenants"],
  "ruleIndex": 1
}
```

Access was declared allowed and was allowed; by status code there is nothing
here. What failed is the other declaration — `responseMustDifferByTenant` on this
endpoint — and `findingKinds` names it. **Without that field the row would be
unreadable**, and reading it as a bug in the tool would be the reasonable
conclusion.

Checkable on the spot: the number of observations with `match: true` must equal
`coverage.cellsMatched`, and the number carrying `findingKinds` must equal
`coverage.cellsWithFindings`.

The same field makes a mistake in **your** policy visible, as opposed to one in
the platform: a rule that accidentally declared access allowed used to give the
absence of a finding — indistinguishable from the absence of a problem. Now you
can see what exactly was declared, and by which rule.

**A check finding carries the values, not only their comparison.** The most
convincing number in the report is not `bodyDigestsEqual: true` but what stands
behind it:

```jsonc
"evidence": {
  "digest": 166203521785331,
  "own.orderCount": 4,        // how many orders admin-a saw
  "other.orderCount": 4,      // how many carol-b from another tenant saw
  "otherAccountId": "carol-b",
  "tenant": "tenant-a", "otherTenant": "tenant-b",
  "status": 200, "bodyDigestsEqual": true
}
```

The scalars of both sides are held apart by the prefixes `own.` and `other.`; you
define which ones there are in `bodySignals.signals`, so the names in `evidence`
are yours, not ours.

`bodyDigestsEqual: true` means strictly "the body digests matched". The
probability of a collision over a run of a thousand responses is on the order of
10⁻⁹, but the tool never made a claim about the bodies being identical byte for
byte — which is why the field is named this way and not `identicalBody`, as it
was before. For the same reason the finding's title says "the response digest
matched", not "the responses are identical".

## Accounts with an at-sign in the name

`alice-a@geo-blocked` is not a separate platform account but **the same account
under declared request conditions**: the same credentials, the same role, the
same tenant, but the request is marked with attributes — a country from the CDN,
a device flag, a KYC status. What changes is the request, not who makes it.

Conditions are the fourth coordinate of a cell, and they exist for restrictions
that permissions cannot express at all: a bet from a forbidden jurisdiction, a
withdrawal before KYC is passed. The role, the tenant and the resource there are
the very same ones, and without a separate coordinate "alice sees her own order"
and "alice sees her own order from a forbidden country" are one and the same cell.

What to look for in the report:

| Where | What it says |
|---|---|
| `inputs.contexts` | which conditions are declared and with which attributes — without them there is nothing to reproduce a finding with |
| `accounts[].contextId` | that this row is an account under conditions, not a separate account |
| `accounts[].baseAccountId` | who this really is: the same account, the same credentials, the same scheme |
| `findings[].request.contextHeaders` | the attributes without which the row reproduces the **base** case, not the one that was found |
| `findings[].contextId` | that the discrepancy was found under conditions, not in the base ones |
| `coverage.contextsProbed` | how many cells were observed under each set of conditions; **zero means "not tested"** |

A policy rule without a `context` field applies **only in the base conditions**.
So a discrepancy under conditions always rests on an explicitly written rule or
on the `fallback` — and never on an expectation declared for base requests.

A defect under conditions and the same defect in the base ones are **two
different defects** in `defects`, not one. The country check and the permission
check live in different places in the platform, break independently and are
fixed separately.

**The flip side of this decision is double counting, and it is worth knowing
about.** A defect visible in the base conditions is usually visible under every
declared set as well: a list with no tenant filter leaks both with the added
attribute and without it. In `defects` that is two groups, while in the platform
it is one breakage. **Two groups that differ only by `contextId` are almost
certainly one defect.** The tool does not merge them itself, and that is
deliberate: from the outside "leaks with the attribute" and "leaks without it"
may be different paths in the code, and conditions exist for exactly that case.
Details — [ADR-0019](https://github.com/Tarnellion/barbican/blob/main/docs/adr/0019-request-contexts.md).

## Identifying the run and the target

`target.label` names the system under test — the environment, the version,
anything that identifies it. A human declares it, because the tool cannot know
it: a `baseUrl` like `http://127.0.0.1:8787` does not tell a production-like
stand from the demo reference platform.

**A missing `label` is meaningful.** A report without one does not name the
platform, and you cannot file a ticket against the platform from it — first find
out from whoever ran it which system was tested. The CLI warns about this at
startup.

| Field | What for |
|---|---|
| `schemaVersion` | the shape of the report has changed and will change again; without a version a parser breaks silently |
| `runId` | otherwise two reports cannot be told apart |
| `configDigest` | to tell "the platform changed" from "we changed the declaration" |

The fingerprint is computed over the **parsed** configuration, not over the text
of the file: comments and indentation do not affect the result of a run, while
they would affect a hash of the text.

## Inputs: what the conclusions rest on

The `inputs` section holds everything without which a finding can neither be
filed as a ticket nor disputed:

```jsonc
"inputs": {
  "policy":  { "fallback": "denied", "rules": [ /* with patterns expanded */ ] },
  "tenants": [ { "id": "tenant-a", "parentId": "holding-1" } ],
  "auth":    { "kind": "bearer" }
}
```

**`policy`** — already expanded: patterns like `/v1/admin/**` are replaced with
concrete identifiers. This is exactly the policy that produced the verdicts, not
the one written in the file — the difference shows when a pattern captured
something other than what you thought.

**`tenants`** — the tree on which `foreign-tenant`, `ancestor-tenant` and
`descendant-tenant` are computed. Without it there is nothing to explain the
relation in a finding with.

An account declared without credentials carries `anonymous: true`, and the `auth`
field is not written at all: it has nothing to present. Without that mark the
report's only positive conclusion — "the anonymous account was denied everywhere"
— is unprovable, because an account whose token was passed wrongly would look
the same.

**`exclude`** — endpoints the operator excluded by hand. An empty list means
"nothing was excluded"; saying nothing about it would read the same way, but mean
something else.

**`throttle`** — the limits that were actually in force: concurrency, rate, the
ceiling on requests per run. Otherwise the invariant "throttling is always on"
has to be taken on trust.

**`auth`** — the **default** scheme: the kind and, for `header`/`cookie`, the
name of the header or the cookie. There are no values here and there cannot be:
they live only in environment variables.

The scheme of a particular account sits next to it in `accounts[].auth`. On a
platform with several authentication surfaces they differ, and without this field
the reader cannot tell "the endpoint is closed" from "we knocked with the wrong
transport": both give 401.

## How to reproduce a finding

Every finding carries the request that produced it:

```jsonc
{
  "accountId": "alice-a",
  "relation": "foreign-tenant",
  "severity": "critical",
  "request": { "method": "GET", "url": "http://127.0.0.1:8787/v1/orders/B-2001" }
}
```

Parameter values are substituted. Credentials in the URL are forbidden by
configuration, so the line can be pasted into a ticket as is — adding the
authentication header of the account named in `accountId`.

**For a finding under request conditions the URL alone is not enough.**
Attributes that are parameters are visible right in the URL, attributes that are
headers are not, and a request without them reproduces the base case instead of
the one that was found. That is why they are printed next to it:

```jsonc
"request": {
  "method": "GET",
  "url": "http://127.0.0.1:8787/v1/orders/A-1001",
  "contextHeaders": { "cf-ipcountry": "AQ" }
}
```

There are no credential headers here and there never will be: they come from the
environment, and that is the only place for them. `contextHeaders` is what the
human declared in `contexts`.

**A finding by body has two requests.** The second one is in `relatedRequest`: on
a platform where brands are spread across subdomains the other side has a
different host, and a request put together by eye would have gone to the wrong
place.

**With which token.** `accounts[].tokenEnv` names the environment variable — the
name, not the value. It is in the configuration anyway, the one you are supposed
to commit, and without it "add the authentication header of account alice-a" does
not say where to get that token.

**When it happened.** Every observation has `at` — the moment of the request in
ISO-8601. Without it there is nothing to match the finding against the platform's
log, and that is the first thing the team that receives the ticket will ask for.
Correlation headers (`x-request-id`, `traceparent` and the like) are kept
unredacted for the same reason: they are not credentials but a handle for
matching.

## Which rule gave the verdict

Two fields answer this, and the second exists because the first could not.

`basis` says what declared the expectation: `"rule"` or `"fallback"`. `ruleIndex`
is the rule's position in `inputs.policy.rules`, present only when `basis` is
`"rule"`.

The absence of `ruleIndex` used to be the whole answer, and it was not a good
one: on the reference run 37 of 80 matrix findings carried no index, and 22 of
the 34 critical ones. On most of the most expensive findings the grounds for
"access was not expected" were expressed by a missing key — and a missing key
cannot be told from a field the tool failed to fill in. That is the point where
a ticket comes back.

A finding from the matrix has `ruleIndex` — the number of the rule in
`inputs.policy.rules` that declared the expectation:

```jsonc
{ "kind": "privilege-escalation", "ruleIndex": 11 }
// inputs.policy.rules[11]:
// { "roles": ["user","admin","affiliate","support"],
//   "endpoints": ["statements.read"], "scope": "ancestor-tenant",
//   "outcome": "denied" }
```

**A missing field is a meaningful answer, not an omission:** no rule matched, and
the `fallback` fired. For a cross-tenant leak that is normal — it is forbidden by
the default, not by a rule of its own.

The number points at the **last rule that matched**: that is the one that wins,
and pointing at the first match would name the wrong source of the verdict.

## What the report still does not have

- **a coverage denominator** — how many cells the policy declared, and how many
  endpoints the API has in total;

Recorded in [tasks.md](https://github.com/Tarnellion/barbican/blob/main/tasks.md) as open.

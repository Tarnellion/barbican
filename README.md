# barbican

A CLI tool and library for testing RBAC and tenant isolation in multi-tenant APIs.

Given a set of accounts across different roles and tenants, barbican walks the
role × endpoint matrix, records the access each account actually gets, compares it
against a policy you declare, and reports the discrepancies: privilege escalation,
BOLA/IDOR, and cross-tenant leaks.

## Status

Early development, but end-to-end: `barbican run` walks a live API and writes a report.
Validated against four targets — [crAPI](docs/polygons/crapi.md),
[VAmPI](docs/polygons/vampi.md), [Juice Shop](docs/polygons/juice-shop.md), and a
[reference platform](https://github.com/Tarnellion/barbican/tree/main/polygon) with switchable defects and a hand-written oracle.

- **Works today** — OpenAPI/Postman/manual endpoint sources, throttled probing across
  accounts and roles, path and query parameter substitution, cross-tenant and BOLA
  detection, scalar signals over response bodies, request conditions as a fourth
  coordinate of a cell (geo, KYC, device — the part of ABAC that permissions cannot
  express), write methods behind `--unsafe-methods` with the skip recorded when the
  flag is absent, a `--dry-run` that shows the plan without sending anything, a JSON
  Schema for editor completion, a per-cell verdict in the report, JSON report and
  exit codes.
- **Not yet** — see the limitation below, plus [tasks.md](https://github.com/Tarnellion/barbican/blob/main/tasks.md).

### Declare your tenant tree, or the old failure mode is still yours

Tenants form a forest: a tenant may declare a parent, and the relation between an
account and a resource is one of five — `own`, `same-tenant`, `descendant-tenant`,
`ancestor-tenant`, `foreign-tenant`. Holdings above brands and affiliates below them
are expressible, and the three-level case is proven end-to-end against the reference
platform, not argued.

**But the tree is something you declare.** Omit it and every tenant is a root, which is
exactly the flat model — and on a holding structure that model fails silently in both
directions at once: it flags the holding's legitimate read of its own brand as privilege
escalation, *and* misses a real leak into a brand owned by a different holding, because
"another tenant" and "another tenant inside my own holding" are then indistinguishable.

A clean run against a holding-structured platform with no declared tree is not evidence
of isolation. This is demonstrated, not theorised — see
[tests/core/tenant-hierarchy.test.ts](https://github.com/Tarnellion/barbican/blob/main/tests/core/tenant-hierarchy.test.ts), which pins
both behaviours side by side, and [docs/guide.md](docs/guide.md) for how to declare it.

An account whose reach is a *set* of tenants rather than a subtree — support staff
covering brands under two different holdings, an affiliate working two of a group's
three brands — declares `tenants: [brand-a, brand-c]` instead of `tenant`. The relation
is then computed against every membership, and the nearest one wins; there is no sixth
relation value. Forcing such an account into a single node fails in the familiar way,
and [tests/core/tenant-set.test.ts](https://github.com/Tarnellion/barbican/blob/main/tests/core/tenant-set.test.ts) pins all three
workarounds and what each of them gets wrong. See
[ADR-0017](docs/adr/0017-account-tenant-set.md).

### A platform that refuses with 200 cannot be checked this way

barbican decides whether access was granted from the **status code**. An API that
answers every request with `200 OK` and puts the outcome in the body —
`{"success": false, "error": {"code": "FORBIDDEN"}}` — reads as "allowed" on every
cell, so every cell your policy denies becomes a privilege escalation. Not some:
all of them.

The body checks do not save you either, though the opposite is the natural
guess: they run only on cells that came back allowed, and two accounts both
*refused* get the same envelope and the same digest, which reads as a
cross-tenant leak. Measured on a six-cell demo of such a platform: four false
privilege escalations and one false leak, exit code 1.

That is the worse of the two ways to be wrong. One look settles it — open a cell
you are sure about, an ordinary account against an admin endpoint, and see
whether it says `200`. There is no flag that fixes it today, and the honest
answer for such a platform is that this tool cannot check it yet.

See [docs/guide.md](docs/guide.md), "A platform that refuses with 200".

### The statuses this tool cannot read

The section above is the loud way to be wrong. Four more are quiet ones: cells
dropped out of the verdict instead of added to it, and a run that ends in `0`.

Access is concluded from `2xx`, from `401`, `403` and `451`, and from `404` and
`410`. Anything else is `outcome: "error"` — a low-severity `probe-error` that
does not enter the exit code.

- **A refusal that redirects.** An operator console on a session cookie answers a
  refused caller `302 Location: /login`, not `403`. Redirects are not followed,
  so every denied cell of that surface is discarded. The `nothingRefused` warning
  does not catch it in a mixed run — it needs *no* denials anywhere in the run.
- **An outcome that is not final.** `202 Accepted` reads as access granted, so a
  platform that queues the request and refuses it in a worker produces a
  privilege escalation that is really a refusal arriving later.
- **A delete that only hides the object.** Under soft delete, `404` and `410`
  answer everybody alike and both fold into a refusal, so an empty cell reads as
  a protected one.
- **An answer about the endpoint rather than the account.** `405` is about the
  method, not about who asked.

Fixing any of them takes a declaration from the operator — *a refusal on this
platform looks like this* — and there is no such field yet; guessing it from the
platform's own answers is the mistake
[ADR-0006](docs/adr/0006-expected-access-declaration.md) exists against. What the
run does do is leave a row in `failures` for every cell whose status it could not
read, so the boundary is visible instead of silent. See
[docs/guide.md](docs/guide.md), "The statuses this tool cannot read".

## Documentation

The repository is English throughout: this README, both guides, every polygon
write-up, every design record in `docs/adr/`, the working notes, the
comments and test names inside the source, and every message the CLI prints. A
test enforces it — the rule survives exactly as long as it is checked. Russian
copies live outside the repository and are a snapshot, not a second version;
where two language versions disagree, the English files are the source of truth.

- **[docs/first-run.md](docs/first-run.md)** — the eleven things to settle before
  the first request against a platform you do not own: permission, scope, a
  canary per account, how many requests this actually is, and what the result
  will not cover. Start here.
- **[docs/guide.md](docs/guide.md)** — declaring accounts, tenants, resources and
  the access policy; running a scan; what the tool deliberately does not do.
- **[docs/report.md](docs/report.md)** — reading the report: every summary field,
  exit codes, and how to tell *"checked and clean"* from *"nothing was checked"*.
- **[docs/library.md](docs/library.md)** — using the package as a library: the
  four entry points, which of the exported names are a contract and which are
  there because the CLI is built from the same modules.

See [plan.md](https://github.com/Tarnellion/barbican/blob/main/plan.md) for the roadmap and [docs/adr/](docs/adr/) for the reasoning
behind each design decision.

## Install

```bash
npm install barbican
barbican run --help
```

`0.6.0` is the current release, and the one to install. Publishing goes through
CI with provenance, so `npm audit signatures` verifies it against this repository
and the workflow that built it.

Of the four versions before it, none is worth having. **`0.1.0` is a stub whose
CLI registers no commands**, published by hand before the release pipeline
existed; `0.2.0` ships a tarball with no guide and no examples, and a CLI that
speaks Russian around English documentation; `0.3.0` and `0.4.0` both answer
`0` — "tested, and clean" — to runs that tested nothing, by the six roads the
section below closes.

### What changed in 0.3.0

**The report schema is `2`, and a reader written against `1` breaks on four
counts.** `coverage.checksRun` holds `{ id, standards }` where it held bare ids;
`coverage.bodyComparison` became `coverage.byCheck`, generic over checks;
`coverage.checksWithUnusableFindings` is gone; and `findings[].accountId` and
`.endpointId` are optional, because a finding can now be about the run rather
than about a cell.

**`match` on an observation narrowed.** It is `true` only when nothing was found
on that cell by *either* channel — the walk over the matrix and the checks over
response bodies. Before this, twelve cells of a reference run were printed as
agreed while carrying a high-severity leak.

**A usage error exits `64`** instead of `1`, which used to be
indistinguishable from "a privilege escalation was found".

**`--concurrency` is honoured by the walk**, where it had no effect, and `--rps`
now spaces requests rather than releasing them in a burst. Both change how much
traffic a run makes and when — read "How much traffic it makes" below before
raising either.

**`--checks` selects which checks run**, and a check finding fails the run at any
severity but `info`, where it used to need `high` or `critical`.

**`defects[].kind` became `defects[].kinds`**, an array. A defect is grouped by
`endpoint × relation × conditions` and no longer by how it was noticed, so one
endpoint broken in two ways is one entry naming both. A reader written against
`kind` gets `undefined`. This was in 0.3.0 and this paragraph was not — it went
out described only in [ADR-0030](docs/adr/0030-a-defect-is-not-its-channel.md),
which is exactly the omission this section exists to prevent. Two more of the
same release: `findingsOmitted` says how many evidence rows the file left out,
and `coverage.checksRun[]` carries a `description` beside the id.

### What changed in 0.4.0

**`configSchema` is no longer exported.** It put 100 lines of `z.ZodObject<…>`
into the published types, naming zod's internal namespace, so a zod major would
have broken every consumer's build. Use `parseRunConfig` to validate and
`configJsonSchema()` for the JSON Schema — the two things the raw schema was ever
used for. No shipped declaration imports from any package now, and a CI step
keeps it that way.

**`createSignalExtractor` and `SignalExtractor` are exported at last.** Every
other adapter already was, and `createHttpClient` takes a
`signalExtractor?: SignalExtractor` whose type a consumer could not write down.

**`basis` is on observations, not only on findings**, and `AccessDiff` declares
it. It says whether a rule or the fallback decided a cell — a missing `ruleIndex`
could not be told from a field the tool failed to fill in, and on rows that
*agreed* there was nothing to go on at all.

**[docs/library.md](docs/library.md) says what the public API is** — the four
entry points, and which of the exported names are a contract.

An adversarial review on the day of the 0.3.0 release found fourteen more, and
thirteen are fixed here. The ones that change what you see:

**A run where nothing answered could exit `0`.** The evidence cap introduced in
0.3.0 made `findings` the abridged array, and the verdict was derived by filtering
it against a denominator that is not abridged — so 101 cells that all failed to
answer read as "checked, and clean". It needs a little over a hundred accounts on
one endpoint, which is inside the default `--max-requests`. The counts the verdict
is made of now travel in `summary.verdictInputs`, taken before the cap; that is
the field to read if you recompute a verdict from a saved report.

**A query string in an endpoint path is refused.** `?_method=DELETE` written into
an OpenAPI `paths` key, an endpoint list or a Postman collection used to travel to
the platform verbatim, so a run without `--unsafe-methods` performed a write and
exited 0. `..` in a path is refused for the same reason: it reached a different
endpoint, past the exclusion list. `resources[].query` is now guarded the way
`contexts[].query` always was.

**The cell that received a leak is no longer printed as agreed.** A finding by
body is about a pair, and only one side narrowed the cell verdict — twelve cells
on the reference run.

**`location` keeps only its origin**, and `www-authenticate` only its scheme.
Both used to carry more: a password-reset token lives in a path, and RFC 6750
puts `error_description` in a challenge.

**`--checks ""` is an error** rather than a silent way to disable the body
channel, and `coverage.bodiesComparedOn` is empty when no check ran instead of
naming every declared endpoint.

**Two accounts presenting the same token are refused even if one has trailing
whitespace**, `Retry-After` can no longer shorten the backoff below the tool's own
formula, and `--dry-run` no longer refuses configurations that run.

### What changed in 0.5.0

The largest release so far, and most of it came out of an adversarial audit of
20-21 August 2026 rather than out of the roadmap: six ways a run could come back
`0` about something it had not tested, four doors that carried more than a path,
and twenty-four invariants that were held by a comment and by nothing else. Read
the first four paragraphs before upgrading — three of them stop a configuration
that used to start.

**A canary has to tell this account from nobody at all**
([ADR-0040](docs/adr/0040-a-canary-has-to-tell-somebody-from-nobody.md)). A 2xx
said the endpoint answered, not that it answered *this* account, and `/health`,
`/version`, `/api/status` answer everybody — which is what an operator reaches
for when asked to name an endpoint the account can reach. A dead token passed
such a canary, every cell of the account came back 401, the policy declared it
denied, and the run said `match: true` on all of them with exit `0`. Each canary
now sends one request with no credentials at all; if that answers 2xx the run
refuses to start and names the account, the endpoint and the status. Three
requests per account with a canary instead of two, counted by `--dry-run`, and
`canaries[].anonymousStatus` is in the report.

**A check that throws takes only itself out of the run.** `runChecks` had no
`try`, and it runs after the walk and before the report is built: one check
meeting a shape it did not expect discarded an hour of traffic against somebody
else's deployment with "Run aborted" and no file. The failure is a run-level
finding now — the class of the error, never its message — because a check that
crashed and a check that found nothing are otherwise the same report, and the
second reads as good news.

**A check finding can name the resource it is about.** A cell is
account × endpoint × resource × conditions and `Finding` carried three of the
four, so a finding about an object could not be matched to its observation: the
cell came out `match: true` with the finding standing on it, counted in
`cellsMatched`, with an empty `resourceIds` on the defect group and no request to
reproduce it with. Latent while the registry holds one check that judges whole
endpoints; the first check of Module 2 that judges an object is where it stops
being latent.

**`resources[].query` is checked where the request is assembled**, like
`contexts[].query` beside it. It was left at the configuration door, so the
library door still put `?_method=DELETE` on the wire with
`allowUnsafeMethods: false` and printed a credential into `observations[].url`.

**The report is written through a staging file that cannot be a symlink**, and a
platform that stops answering after the walk is no longer reported as credentials
going stale. The staging path is removed and created exclusively; a symlink there
used to take the report — every address, every account identifier — wherever it
pointed.

**An unknown key in the configuration is refused.** `z.object` accepted what it
did not know and said nothing, in eight sections out of ten — only `policy.rules[]`
and `contexts[]` were strict. A single letter turned a run into a false zero:
`tokenENV` made the account anonymous, which also excused it from the canary rule;
`bodySignal` removed the body channel; `resouces` cut a matrix of six cells to two;
`excludes` disarmed the exclusion list and the run went on to knock at the address
declared untouchable. The guards inside each section are good, and none of them can
fire when the section itself is gone. **A configuration carrying a stray key stops
now where it used to run**, and the published JSON Schema carries
`additionalProperties: false`, so an editor bound to `$schema` marks the typo too.

**A canary that could not be probed after the walk is named.** The canaries are
probed twice — before the walk and after it — and `--dry-run` counted them once, so
a ceiling the preview itself called sufficient was exhausted by the second pass.
Every result of that pass carried a terminal failure, the loop reading them skipped
exactly those, `truncated` stayed false because the matrix *was* walked, and a run
whose token died halfway came back `0` carrying the first pass with
`authenticated: true`. `report.unverifiedAfterWalk[]` is the new field and its own
reason for exit `2`, kept apart from `staleCredentials`: our own ceiling and a dead
token send the reader to different places. The preview counts the canary requests
twice and says so.

**A resource value carrying `/` or `\` is refused**
([ADR-0035](docs/adr/0035-a-separator-in-a-value-is-refused.md)).
`encodeURIComponent` turns the separator into `%2F`, which is one ordinary segment
here and `../../admin` to Spring with `urlDecode` at its default or Tomcat with
`ALLOW_ENCODED_SLASH` — both decode before they route. The template grammar had
already decided this question the strict way; the value grammar had not, so the two
halves of one rule disagreed. The price is in the ADR: a hierarchical identifier
is no longer declarable as one value.

**Condition attributes are checked where the request is assembled**
([ADR-0037](docs/adr/0037-the-rest-of-the-request-sits-at-the-seam.md)). The
address grammar moved to the seam; the three checks over attributes did not, and
`collectObservations` called none of them — so through the library door, with
`allowUnsafeMethods: false`, a run put `?_method=DELETE`, an
`x-http-method-override` header and a credential in a query parameter on the wire.
The merge order is reversed with it: attributes went in *after* the credentials
under a comment calling that the second line of the same defence, and a later
spread wins — `authorization` declared as an attribute replaced the account's own
header while the report named the original account.

**The report is written in chunks, through a file beside it**
([ADR-0038](docs/adr/0038-the-report-is-written-in-chunks.md)). `JSON.stringify`
builds the document in memory first, and a string in node stops at 536 870 888
characters: 57 826 cells against a platform answering with 196 headers spent every
request and then lost the lot to `Invalid string length`. Where that wall stands is
the target's to decide, not the operator's — 692 000 cells at six response headers,
74 000 at 126. The bytes are unchanged. The file goes to `<path>.partial` and is
renamed, so an interrupted write no longer replaces a good report with half of one,
and the mode is set again after the rename: `mode` on an open applies to a file
being *created*, so a report written twice into the same path used to keep the
permissions it already had.

**A run that did not reach every endpoint says so**, in the file and on the
screen. Eleven endpoints with nine of them templated and no `resources` declared
gave `endpointsProbed: 2`, `warnings: []`, no findings, exit `0` and a green "No
privilege escalation found" — over the object half of the surface, the endpoints
addressed by identifier, which is where BOLA and IDOR live and which drops out on
the most ordinary mistake there is. Nothing read `coverage`: every other counter
answers "was anything found", and none of them answers "was anything looked at".
`report.warnings[]` has a fifth sentence for it, and the headline no longer stands
alone on such a run.

**The order in the report, and `configDigest`, no longer depend on the machine's
locale** ([ADR-0036](docs/adr/0036-one-order-on-every-machine.md)). Eleven
comparisons went through `localeCompare()` with no locale argument, which sorts
by whatever `LC_ALL` says: `sv_SE` and `en_US` ordered the finding rows, the
defect groups and a check's compared pairs differently, and hashed one
declaration into two different digests. `configDigest` is offered in
`docs/report.md` as the way to tell "the platform changed" from "we changed the
declaration", and evidence rows are cut *after* the sort — so two machines
walking one matrix did not merely print the same file in two orders, they kept
different rows of the same defect. Everything compares by UTF-16 code units now,
which is what the plain `.sort()` calls standing beside them already did.

**A canary is required per account, not per run.** A run where one account has a
canary and another with a `tokenEnv` does not now exits `2` and names the accounts.
It used to be enough for the run to have one canary anywhere: an account carrying a
dead token, denied everywhere by the policy, produced `match: true` on every cell
and exit `0` — "tested and clean" about credentials nothing had ever shown to work.
`findUnauthenticated` cannot reach that case by construction, because a policy that
declares nothing accessible to an account gives it nothing to be refused. The text
of the `noCanary` warning in `report.warnings[]` changed with it.

**A backslash or a control character in an endpoint path is refused**, and the
grammar now also sits where the address is built rather than only at the three
adapters that read a document. `/v1/reports\..\..\danger` was one segment to a
guard that splits on `/` and three to the URL parser, which reads `\` as a
separator for http and https: the request arrived at `/danger` — an endpoint the
configuration had excluded — and the verdict for `reports` was computed from its
answer. Tab, newline and carriage return go the same way: the parser removes them
before reading, so `.` newline `.` becomes `..` after approval. Percent-encoded
`%5c` too.

**The same refusals now apply to the library.** `collectObservations` takes
`Endpoint[]` from whoever calls it, and `Endpoint.path` is a plain string: every
refusal written for the adapters was open through that door, including
`?_method=DELETE` performing a write with `allowUnsafeMethods: false`.

**Navigation is refused in the spellings the receiver collapses**, not only the
one written out. `%2e%2e`, `.%2e` and `%2e.` are double-dot segments to `new URL`
itself — the tool's own parser, before any platform sees them — and `..;` is `..`
to a servlet container, which strips `;params` from a segment before normalising
the path.

**An absolute or scheme-relative URL is refused as an endpoint path.** The
endpoint list and the Postman parser each refused one in their own way; an
OpenAPI `paths` key did not, and `https://user:secret@host/x` there kept the
origin check happy — origin does not carry userinfo — and printed the credentials
into `observations[].url`.

**`runVerdict` and `exitCodeFor` accept a report saved by an older version.**
They read the canary outcomes now, and a 0.4.0 report has no `canaries` field: it
answers 2, where it had started throwing a `TypeError`.

**The registered methods that write are refused in request conditions and
resource queries.** The check by value knew the methods this tool can issue; a
platform honouring an override is not limited to them, and `MOVE` deletes the
source. The WebDAV, versioning, binding, calendar, redirect-reference and ACL
methods are in the set now, with `PURGE`.

**Three configurations that used to start now stop at `--dry-run`**: a policy rule
naming a role no account carries, a resource that fits no endpoint, and a canary
the policy denies to the account's own role. Each was a rule or a check that
silently did nothing.

**The preview names the accounts owed a canary** instead of saying "not one
account declares a canary", which was false whenever one did, and prints it in the
colour the finished run uses for the same warning.

**The build is TypeScript 7.0.2** ([ADR-0031](docs/adr/0031-typescript-7.md)). No
API change; the emitted declarations keep doc comments 6.x dropped.

**The grammar for a string from outside is exported.** `src/io/untrusted.ts` was
re-exported by no index, so from outside the package `HeaderValue` was a branded
type with no reachable constructor: the signing provider
[ADR-0018](docs/adr/0018-request-signing-is-a-port-concern.md) describes did not
compile, and the only spelling that did was a cast — the grammar skipped rather
than applied. `safeHeaders`, `headerValue`, `headerName`, `pathSegment`,
`pathTemplate`, the predicates, `openRecord`, `lookup` and the four error classes
beside them are on the surface now, `UnusablePathTemplateError` among them: the
class a run's refusal of a hostile path arrives as, which could previously be
recognised only by comparing `err.name` to a string.

**Three quadratic walks are gone**, with no change to what any of them answers.
The untrustworthy-run check read every observation of the run once per account
and discarded the ones belonging to somebody else: 37.51 ms at 640 accounts,
0.82 ms now, and the growth is linear in the accounts instead of squared. The
matrix walk and the run's own asked an account's list of declared endpoints with
`includes` once per endpoint, which only bites where request conditions are
declared — and that is exactly where the matrix is largest: `describeMatrix` at
1600 endpoints went from 18.96 ms to 7.58 ms.

**The body channel compares what a human named**
([ADR-0044](docs/adr/0044-the-body-channel-compares-what-a-human-named.md)). The
one check the "bodies are not read" invariant was relaxed for was wrong in both
directions at once, and both were reproduced. Two tenants with no records answer
`{"orders":[],"total":0}` byte for byte, so the digests matched and a `high`
cross-tenant leak was reported — on a fresh deployment, where half the tenants
have nothing yet, a wall of them and exit `1` against a healthy platform. And two
responses carrying the records of *both* tenants, differing by one `requestId` in
the envelope, produced no finding at all: a `serverTime`, a `generatedAt`, a
pagination cursor or an echoed ETag switches the check off entirely, which is the
ordinary shape of a list endpoint. **A pair where every declared `count` is zero
on both sides is no longer compared**, and `bodySignals.compareSubtree` declares
which part of the body to compare — `{ endpoints: [orders.list], path: data.orders }`
— so the envelope may move. A scope that cannot be resolved yields no digest
rather than falling back to the whole body; the observation says
`digestScopeMissing`. Both readings were also invisible in the report:
`comparedPairs` grew by one whether the digests matched, differed, or were
compared when there was nothing to compare, so it splits into `matchedPairs` and
`differedPairs`, with `skippedBothEmptyPairs`, `pairsWithoutDigest` and
`emptinessSignalsDeclared` beside them. `docs/report.md` states the boundary none
of this removes, held by a test: **a difference in digests is not proof of
isolation** — it proves only that the bytes were different.
**A run now says who it is on the wire**
([ADR-0045](docs/adr/0045-a-consented-run-says-who-it-is.md)). Every request
carries `user-agent: barbican/<version> (+<homepage>; run=<runId>)`, where `run=`
is the identifier of the report the run produces. It was `user-agent: node`
before, and the `runId` never left the file. README has asked for the platform
owner's written agreement since the beginning and says why — "someone has to know
that the traffic in their logs is yours" — and nothing made that possible. Now
they can pick the run out of an access log or a SIEM, keep it out of an
availability graph, and tie their own records to the exact report they were
handed: the other direction of the correlation `x-request-id` off the response
already served. `--no-identify` sends the run unannounced, for the deliberate
case of measuring what an unmarked sweep looks like; the summary and `--dry-run`
both print which of the two a run was. A set of request conditions declaring a
`user-agent` attribute of its own stops the run instead of sending both values
folded into one.

**A run without `--report` now says where the report is going.** It goes to
stdout, which in a pipeline is the build log — while the same document written to
a path is created `0600` on purpose, because it names every request address,
every account and resource, and the places the platform's authorization does not
hold. The weaker of the two paths was the default and no document said so;
`docs/report.md` and the guide now do.
**`410 Gone` is read as a refusal, and the statuses that stay unreadable are
named** ([ADR-0046](docs/adr/0046-410-is-a-refusal-and-the-rest-is-named.md)).
410 says what 404 says and says it harder — the resource was not served, and it
will not be — and it used to be an `error`, so a refusal the platform had
actually issued left a low-severity `probe-error` outside the exit code and
vanished from the verdict. It now folds into a denial the way 404 does, which
changes verdicts in both directions, and the guard against a 404 this run caused
with its own `DELETE` covers 410 with it, since a platform that soft-deletes
answers "gone". Beside it, a cell whose status the tool does **not** read leaves
a row in `failures` giving the status and why nothing follows from it, so
`summary.failures` and the CLI's yellow "Requests that failed" line stop staying
silent about discarded cells. The four classes that stay unreadable — a refusal
that redirects, an outcome that is not final behind `202`, a soft delete, and
`405` answering about the endpoint rather than the account — are written into the
README, the guide and the report document, held by a test in all three. The
redirect case is the one that costs most: an operator console on a session cookie
refuses with `302 Location: /login`, and every denied cell of it is discarded
today. Fixing it needs a declaration of what a refusal looks like on that
platform, and that is deliberately not half-built.

**A walk now survives the run that made it**
([ADR-0047](docs/adr/0047-a-walk-that-survives-its-run.md)). Nothing reached disk
until the last response was in, and nothing in `src/` mentioned SIGINT — so
Ctrl-C, the OOM killer, a CI job cancelled on its timeout and a dropped network
each took the whole run with them: every request already spent against somebody
else's deployment, inside a window that may not open again this week. And an
operator whose run met `--max-requests` on the 1900th cell of 9000 had one
answer, which was to spend those 1900 again. A run with `--report` now streams
each finished cell to `<report>.stream.ndjson` beside it, `0600` like the report.
**A signal stops the walk, writes the report it has and then ends the process the
way the signal would have** — `130` for SIGINT and `143` for SIGTERM are
unchanged, and the report says `truncated: true` with the exit code `2` that
belongs to it. **`--resume` continues where the run stopped**, adopting its
`runId` and start time so both halves of the traffic lead to one document, and
refusing before the first request if the declaration is not the one the stream
was written under — the configuration, the endpoint list, a value a condition
takes from the environment, `--unsafe-methods` or `--no-identify`. A completed
walk deletes its stream. The bytes of the report are unchanged, which is why it
still cannot say *which* of the three ways a run was cut short; the terminal and
the stream can. Without `--report` there is no stream, and the run says so.
**A finding can be known and accepted without leaving the report**
([ADR-0048](docs/adr/0048-a-finding-can-be-known-and-still-reported.md)). There
was one channel for intent and it carried two statements: the only way to stop a
finding failing a build was to declare the cell allowed, after which the finding
is gone from the artifact entirely — no row, no defect group, `match: true`, exit
`0`, and nothing recording that anybody knew. That is also what a team with forty
findings on the first run has to do to forty cells before the tool can go into
CI, and the usual answer to that is to take the step out of CI instead. The new
`accepted:` section names a defect the way `defects[].key` prints it — endpoint,
relation, conditions — plus the kind it showed itself by, and requires a reason
and a real `until` date: the row keeps its severity, its request and its place in
every counter, and only `summary.verdictInputs` loses it. Past the date it counts
again and says so; a declaration that covered nothing is reported as
`matched: 0`; and `not-observed` and `probe-error` cannot be accepted at all,
because a run may not buy its way out of saying it reached nothing.

**`barbican diff` compares two saved reports**
([ADR-0050](docs/adr/0050-a-comparison-is-of-defects-not-of-files.md)). The two
questions a second run is made to answer — "what changed since yesterday" and
"is this the platform regressing or did I edit the declaration" — had both
halves of both answers sitting in the file and nothing reading either:
`configDigest` exists to separate those two causes, `defects[].key` was made
readable and stable across runs so a ticket could cite one, and a plain `diff` of
two report files is useless, because `runId`, the timestamps, `durationMs` on
every observation and every `signals.digest` differ on two runs of one matrix
against one unchanged platform. The comparison says the declaration first — a
moved `configDigest` means part of what follows may be your own edit — and joins
on the defect rather than the finding row, since one defect is fifty rows or one
depending on the evidence budget and the width of the matrix. **A disappearance
is attributed**: a defect gone from a run that never probed that endpoint is
reported as nothing fixed and nothing looked at, and a new one on an endpoint the
earlier run never probed may be newly covered rather than newly broken. A defect
now held out of the verdict by an `accepted:` declaration is a change and not a
fix, which is otherwise indistinguishable from one. Coverage that shrank exits
`2` along with a truncated run, a run whose own verdict was `2`, a report
compared with itself and two reports of different `schemaVersion`; `1` is a real
difference, `0` is the same defects over the same surface, and `64` stays what
the argument parser rejects. `--json` writes the same conclusion to stdout.
**The walk holds one copy of the matrix instead of three**
([ADR-0053](docs/adr/0053-the-walk-holds-one-copy-of-the-matrix.md)). The
measurement that named three materialisations of the matrix in a run counted the
walk as one of them; the walk was three by itself — a task per cell laid out
before the first request, a result per cell filled during it, and the
observations drained out of that at the end, all alive together when the last cell
came back. It also minted a key string per cell before the first request to
resolve `--resume`, on every run, including the ones resuming nothing. The task
list is now a cursor over the accounts and the `endpoint × resource` pairs, a
worker writes its observation straight into the array the walk returns, and the
holes an interrupted run leaves are closed up in place. Measured on the same
ladder as before: the walk's peak resident set is down by up to 22% at 576 000
cells and the reduction grows with the matrix, and the walk now retains 1.010
copies of what it hands back where it retained 1.478. **The peak of the whole run
is unchanged** — it is reached while the report is being built, where the three
materialisations still stand; the ADR says which they are, what each costs and
what moving them would take.
**A checklist for the first run against a platform you do not own**, and two
assumptions that were nowhere in writing. [docs/first-run.md](docs/first-run.md)
is the eleven things to settle before the first request — permission, scope,
`exclude`, a canary per account, the request arithmetic `--dry-run` prints, the
walk against a token's lifetime, how large a matrix stays practical, how the
owner will recognise the traffic, where the report goes, `--resume`, and what the
result will not cover. It is linked from here and from the guide, because a
document nothing points at is one nobody reads. The assumptions are **the run's
own blast radius** — the job holds every role's live credentials at once, and a
run is by construction a burst of `401`/`403` from one subject, which is what a
lockout or an anti-fraud rule is hung on, and which the report then names
`staleCredentials` — and **one probe per cell**: every row is a single sample,
retried only on `429`, `5xx` and a failure on the wire, so one `200` off a stale
replica is a `critical` that is not there and one `403` off a node that has the
rule hides one that is. Both are in the guide and in `docs/report.md`, held by a
test.
**The report carries a digest of itself**
([ADR-0051](docs/adr/0051-the-report-answers-for-itself.md)). `runId`,
`configDigest` and `tool.version` identified the run, the declaration and the
build; nothing identified the artifact, so a row could be deleted from `findings`
and a sentence rewritten in `verdict.reason` with nothing inside the file
objecting — and since HTML and PDF are rendered from the JSON, the edit reaches
every form of the document. `contentDigest` is a sha256 over the report with that
field taken out, and `checkContentDigest()` recomputes it from a parsed file.
**It catches a careless edit and not a deliberate one**, because whoever changed
the row can recompute the value: the ADR records the signature that would, along
with the questions — where the key lives, who holds the verifying half, what a
signed report even claims — that have to be answered before there is one.

**`coverage.clauses` says which clauses the run exercised, not only which ones
broke** ([ADR-0052](docs/adr/0052-a-clause-can-be-reported-as-exercised.md)).
`checksRun` had that for registered checks; the matrix channel — privilege
escalation and cross-tenant access, which is what this tool is for — had nothing,
so a clause exercised over nine hundred agreeing cells reached an evidence pack
only if one of them broke. Each row carries the cells that concluded, the cells
that concluded nothing by reason (`not-observed`, `probe-error`), and the
reservations that stop "exercised" from meaning "holds": an endpoint never
probed, a walk cut short, credentials nothing confirmed, a platform whose
refusals this tool cannot recognise. **Nothing in it is a percentage** — a
percentage hides its denominator, and claiming a clause covered over a surface
the tool could not see is the same class of lie as a falsely clean run.

### What changed in 0.6.0

Most of the work below changes nothing a consumer can observe; the entries that
do say exactly what, and there are four of them.

**The modules that were half the source are split by what they do.**
`report/build`, `io/config`, `cli` and `runner` were 3012, 2832, 1872 and 1726
lines, and the four cuts produced five, seven, nine and six modules. That is
also the number of jobs the file held for `io/config` and `runner`, which came
out of it as barrels of re-exports and nothing else; the other two kept a job of
their own, `build.ts` the assembly of a report and `cli.ts` the command line, so
those two files held six and ten. Each is now a directory of modules behind the
path it always had, so every import in this repository and in a consumer's code
is the import it was.

Each cut is made at a seam a decision already named, not at the table of
contents. The runner is cut at the address, because
[ADR-0032](docs/adr/0032-the-grammar-sits-at-the-seam.md) is a decision
about a *place* — the grammar lives in `joinUrl` because that is the one place an
address is built, and a cut that put `substitute` on the other side of a module
boundary would rebuild the state that ADR was written from. The report is cut at
the cell key, for the same kind of reason.

The guarantee is checked rather than claimed: the exported names and their count
are unchanged, the report is the same bytes over all 29 combinations of the
reference platform, the oracle answers as it did, and the coverage gate was
re-pointed at the new paths so it still measures code rather than re-exports.

**A gate that only ran after the push now runs before it.** Cutting `cli.ts`
into modules turned a file-local `paint` into an exported one, and its parameter
type — derived from `styleText` — carried `import … from "node:util"` into a
shipped declaration. The published types are supposed to name nothing but
themselves, because a type from outside is a promise about somebody else's
versioning; the check for it existed only as a shell line in CI, so it reported
the leak after the work was pushed rather than preventing it. It is now
`tools/no-dependency-in-declarations.mjs`, run at the end of `pnpm run build`,
and CI calls that same file. The palette is written out as `Ink` and still
checked against Node's own by the compiler — a colour Node stops accepting fails
the build in this repository rather than in a consumer's.

**The coverage gate measures every module the package ships**
([ADR-0063](docs/adr/0063-the-coverage-gate-measures-what-shipped.md)). It did
not: `include` was a list of five directories, and the nine modules the `cli`
cut produced were named by none of them — the run orchestration, the second
canary pass and the gate on `--resume` among them — under an exemption written
about a file that was "argument parsing and printing". The list is now one
pattern over `src/`, and a test reads it and the thresholds out of the
configuration so that neither can lose a file to a move again. Eight of the nine
modules are brought to 100 % of their statements, functions and lines; the ninth
is named on a line of its own for the part of it only a spawned process can
observe.

That test read two keys of a dozen, and a review walked around it three ways with
the whole run green — an `exclude` that took the same nine modules back out, a
group whose numbers were zeroed, a blanket threshold that answered for every
file at once. The rules moved into `tools/coverage-gate.mjs` and now answer for
the whole option set: the names are an allowlist, a number below the project
floor has to be written down with its reason, and `pnpm run test:coverage` reads
the summary the run leaves behind — so a file the package ships that was not
measured is named whatever removed it. Five unreachable fallbacks in `src/cli/`
were deleted rather than described while that was being counted; the behaviour
they described could not happen.

**And the gate is what runs the run.** A fourth round found three holes in it.
The wiring between its two halves was a script string, and a test that asked
that string for two substrings was satisfied by the first of its three commands:
deleting `&& node tools/coverage-gate.mjs` left every test green while the half
that reads the summary never ran again. There is no second command now —
`pnpm run test:coverage` is `node tools/coverage-gate.mjs`, and that module
clears the summary, starts vitest and answers for what it measured — and the
wiring is checked as an effect rather than as text: vitest loads the same module
as a `globalSetup`, and a run measuring coverage that the gate did not start is
refused before the first test. A module written as `.mts` or `.cts` was invisible
to both halves, because `leak.mts` ends in `mts` and neither `endsWith(".ts")`
nor `src/**/*.ts` reads that as a match — one imported by a shipped module built
into `dist/` and the gate said "every module the package ships was measured".
What the compiler compiles is now the definition, held to `tsc --listFilesOnly`.
And a sentence in the guard was simply false about vitest: a global threshold
does apply to every file, glob-matched ones included, so it is now held to the
project floor like any other gate and refused the right to answer for a file.
[ADR-0063](docs/adr/0063-the-coverage-gate-measures-what-shipped.md) carries all
three, and the limits it still has.

**Three defects the refactoring uncovered are fixed.** They are the reason a
refactor is worth reading rather than skimming — each was invisible while the
code sat in one long file.

- The content digest validated no file the CLI had ever written. The run's own
  identifier was substituted into the report *after* the hash was taken, so
  `checkContentDigest` answered `false` for every artifact on disk while the test
  suite stayed green against a report in memory. A guarantee has to be checked
  where the artifact goes —
  [ADR-0058](docs/adr/0058-a-guarantee-holds-where-the-artifact-goes.md).
- A set of request conditions named `__proto__` vanished from
  `coverage.contextsProbed`: the report said it had not been probed when it had.
- `relatedRequestOf` dropped `resourceId` from the cell key, so a finding could
  name a different cell than the one that produced it.

**The key a verdict and a finding meet on is built in one place.** `cellKey` was
written out twice, character for character — once in the runner, once in the
report — under a comment warning that a key written by hand in several places is
a key that stops agreeing with itself. It is `src/core/keys.ts` now, with the
endpoint × resource key the walk builds beside it under a name of its own, and
a test refuses the next copy:
[ADR-0059](docs/adr/0059-one-key-one-source.md). That test found two more keys on
its first run — written with the separator as a raw byte, which makes a file
binary to `grep`, so every search of this repository for it had been answering
"no matches" over the two files that used it. Nothing a consumer can observe
changes: the same 227 exported names, and the same bytes over all 29 combinations
of the reference platform.

**The `{name}` in a path template is read by one rule again.** It was written
three times: twice in `src/runner/address.ts`, where a comment admitted the two
were one grammar in two spellings, and a third time in `src/core/matrix.ts`,
character for character the second, in another layer with nothing pointing at
it. The two in the runner decide what a run walks and the one in the core
decides which cells exist, so a difference between them is a run that probes a
cell the matrix does not contain. All three now call
`src/core/path-parameters.ts`. The core rather than `src/io/untrusted.ts`,
because `untrusted.ts` already imports from the core and a grammar the core
reads cannot live above it — see the note of 23 August on
[ADR-0024](docs/adr/0024-strings-from-outside.md), which is the rule being
applied rather than a new one. Nothing a consumer can observe changes; the
exported names and their count are unchanged, and the oracle answers as it did
over all 29 combinations.

The tidying has a trap in it, and the tests hold it: one shared `RegExp` with
the `g` flag would have been the obvious way to write that module and is a
defect, because `lastIndex` survives between calls — a presence test leaves it
past the first parameter, and the scan that follows reads only the second.

**Both of those gates could be walked around, and so could the one that replaced
them.** An adversarial reviewer put a second cell key under a different name past
the first gate, and a second spelling of the separator — the same character
written `\x00` instead of the four-digit escape — past it as well, both with
`pnpm run check` green; the `{name}` grammar had no gate at all, and a fourth copy
in the runner passed everything. Its replacement was then attacked in turn and
gave way six more times: `import { joinKey as glue }` reduced the caller count it
enumerated to zero, `const glue = joinKey` did the same, a second key builder
written as an object method walked past its declaration check, and a `{name}`
grammar built with `new RegExp` was not a literal for it to read. Five of the six
are closed here; the sixth — the separator built out of `decodeURIComponent`,
with no zero written anywhere — is not, and it is named in the ADR and in the
test file as a way past the gate that still works.

The answer is not more patterns. `KEY_SEPARATOR` is no longer exported, so a copy
elsewhere has to write the character out itself; and what the single test
enumerates is now the **import** — which module may reach into an owning module,
for which name — rather than the text of a call, which any rename defeats. An
owned name used anywhere but the owner has to be an import of it or a call of it,
in whatever syntactic form, so a second declaration is refused without anybody
having to guess how it will be spelled.
[ADR-0060](docs/adr/0060-a-gate-that-says-what-it-holds.md) carries the
twenty-two mutations run against it, what each is caught by, the one that is
**not** caught, and the refusal the harness prints when a mutation does not apply.

The same review found the record wrong in two places, and both are corrected:
ADR-0059 said ADR-0057 rendered a key with a space, where in fact ADR-0057 held
the **raw NUL byte** — the byte that makes a file binary to `grep`, so the search
that went looking for it answered "no matches" and the silence was written up as
a rendering choice. That byte was still in the repository, which is why the gate
now reads every tracked file rather than `src/` alone.

The second review found the record wrong again, in the document written to
correct the first one, and those sentences are gone rather than softened: ADR-0060
claimed that "a fifth caller fails the test whatever the function is called" and
that a declaration spread over several lines was "caught by the two checks above"
— neither was true of the code as committed — and the note it added to ADR-0057
called itself "one character and nothing else" while being nine added lines. A
gate that is described as more than it holds is the pairing this repository's own
security invariants name as the dangerous one: a sentence telling the next reader
not to look, over a check that no longer looks either. Nothing a consumer can
observe changes here either: the same 227 exported names, and the same bytes over
all 29 combinations of the reference platform.

**Twenty-four doc comments now describe the symbol they stand on**
([ADR-0062](docs/adr/0062-a-comment-describes-the-symbol-under-it.md)). One of
them described a security guarantee that had moved: above `sanitizeLocation` it
said the `location` header's path reaches the report, when since 17 August only
the origin does. Nothing a consumer runs changes; what changes is what the source
tells a reader about it. Two gates hold the checkable parts — a doc block
standing over another doc block, and an ADR link whose label names a different
decision from the one it opens.

**Both of those gates were walked around, and the ADR now says what they miss.**
The link gate collected on `[ADR-NNNN]`, which is a condition on the very label
it exists to judge: nine ordinary spellings — emphasis marks, a code span, a word
in front of the number, `ADR 0041`, `ADR-41`, the filename as the label — were
never collected and so were never judged, while the gate's own header said
nothing is passed over. The population is now the link and the label is what is
on trial. The comment gate was walked around by one `//` line between the two
blocks, by putting the pair at the top of a file, and by the extension list; and
its JSDoc exemption was justified with a claim the same branch's diff refuted —
`src/runner/canaries.ts` had exactly the excused shape with the upper block
describing a different function. The exemption is two narrower rules now, module
headers are counted against a named list of seven files instead of being skipped,
and [ADR-0062](docs/adr/0062-a-comment-describes-the-symbol-under-it.md) carries
a measured list of what neither gate catches — starting with the ADR citations
that are prose rather than links, which is most of them.

**Three rules that were written more than once are written once**
([ADR-0061](docs/adr/0061-a-rule-is-written-in-one-place-and-read-in-two.md)).
Nothing a consumer can observe changes — no message, no exit code, no report
field — and each of the three could have changed something later.

- **The address grammar** was two lists seven lines apart: a conjunction of
  predicates for the seam, the same predicates re-listed as `if` blocks with the
  sentences an operator reads. A rule added to the second alone would never reach
  `joinUrl`, which is the only grammar between a consumer of the library and the
  wire. It is one table of (predicate, sentence) now, and the messages are
  unchanged. An entry *written into* that table with no witness in the gate is a
  red test, and so is a permutation of it — the order decides which sentence a
  path breaking two rules at once is answered with. A rule that is not written
  into it, but hoisted into a constant above and referenced by name, is not; that
  is measured further down.
- **The refusal of a scheme-relative `//host/x`** stood in three places under a
  comment saying it stood in one. The copy in the Postman parser had been
  unreachable since the grammar took the rule over — behind a call that throws on
  exactly that input, at zero hits from 1 529 tests — while its comment claimed
  it was holding the scope. It is gone. The endpoint list's copy is reachable,
  answers first, and stays: its condition is held to being one of `isAddress`'s
  own disjuncts, character for character, so a term added to it is a red test
  even when the term is harmless.
- **Two sets that must agree** now have one source each: the names of the errors
  that end a walk, which the runner and the CLI read from opposite ends, and the
  statuses that mean "not found", which the self-inflicted-404 guard had written
  out a second time in a file that already calls `classifyStatus`.

**That gate could be walked around, and four of the ways in are closed.**
Adversarial review the day ADR-0061 was accepted went at the test rather than at
the code.
Four of its assertions were got past with `pnpm run check` green, and a fifth
claim — that the order of the address table is behaviour — had no assertion
behind it at all. Two of the four filtered a list of file names written into the
test by hand — 5 of the 65 tracked sources for the refusal wording, 15 of 65 for
the error names — so the same sentence placed in `src/runner/walk.ts`, and a
second copy of the terminal-error set placed in `src/runner/stream.ts`, were both
invisible; both assertions now read every tracked file under `src/`, from
`git ls-files`. A fifth rule appended to the address table on one line had no
`id` the gate could see, because the regex needed `id` on a line of its own and
Biome leaves a short entry alone; the ids are counted against the entries now,
and a spread into the table — a way in the review had not tried — is refused
rather than followed. The order of that table was called behaviour with nothing
holding it, because every witness breaks exactly one rule and a permutation is
invisible to all of them; it is held by a pair of paths per adjacent pair of
entries. And the endpoint list's copy was held by one string, which proves it
fires and says nothing about how far it reaches; its condition is now held to
being one of `isAddress`'s own disjuncts, character for character. The first
amendment in ADR-0061 says what each closure does and ends with the shapes that
still get through.

**Two doors were still open, and the seam is now held to its own text.** A second
review, the same day and against that amended tree, demonstrated four
walk-arounds across three of its assertions with `pnpm run check` green. The load-bearing one: `And neither entry
point decides anything of its own` was held by "the seam does not contain `&&`",
and a conjunction is not the only way to reach a verdict without asking the
table — a ternary at the seam and an early `return` at the door both got through,
each of them a back door into `joinUrl`, which is the only grammar between a
consumer of the library and the wire. Naming the spellings to refuse is the wrong
shape of check, because that list has no end; those two bodies and the third
exported function beside them are now held to being **one exact text** each,
comments stripped, so any edit is red including a behaviourally identical one. The endpoint list's corpus asked the grammar only
about the refusals worded the way that copy words them, so a second `if` saying
"points at another host" turned away a path the grammar admits and the test whose
name promised otherwise stayed green — the population is every refusal now, and
the decision behind it is that an adapter must not refuse what the grammar
admits. A fifth rule with quoted keys was invisible to the gate and caught only
by Biome's formatter; the entries are counted structurally now, so a computed key
fails too. And in the sibling gate for the `{name}` grammar, a brace written
`\u007b` went through a scan that decoded escapes for the key separator two
functions away, and `const Expression = RegExp` reached the constructor past a
count of calls: one decoder for both scans, and every mention of the name
counted. The second amendment of ADR-0061 and the amendment of ADR-0060 carry the
mutations, and both end with what is still open — starting with a back door
written inside one of the four predicates, which was run rather than reasoned
about and passes the whole suite: 118 files, 1797 passed, 1 skipped, re-measured
on the tree this section describes.

**Six facts written down twice are now written down once**
([ADR-0064](docs/adr/0064-a-table-written-twice-is-made-to-agree.md)). None of
them was broken — every copy agreed, which is the reason to open them rather than
the reason to leave them: this repository is twelve days old and
[ADR-0024](docs/adr/0024-strings-from-outside.md) was already written after
eleven point fixes of one shape across four files, two of which had drifted
apart by the time anyone counted them. The reserved check ids are now a mapped type
over `DiffKind`, so a fifth kind of matrix discrepancy that nobody reserves does
not compile; the severity ranks are one table the console and the report both
read, so a re-ranking cannot sort them differently; the `YYYY-MM-DD` grammar is
one expression instead of three in two spellings; and the two-layer header rule is
composed in one function instead of being copied expression for expression into
two. What a canary costs in requests is no longer the literal `3` in the
`--dry-run` arithmetic but a named constant both sides read. One test counts what
the two canary passes really send and holds the constant to it; a second drives
one declaration through the preview and then through a real walk against a
counting client, and fails when the number `--dry-run` bills is not the number of
requests the run makes. That second one is the link that was missing: holding
each side to a literal of its own leaves a preview free to undercount, and a
preview that undercounts is how an operator picks a `--max-requests` ceiling that
stops the second canary pass. The two URL-redaction rules in the HTTP adapter
turned out to be two justified rules rather than one that drifted, and each now
says so in its own body.

**The same number had a seventh copy, in shipped prose.** `docs/guide.md`
printed `Cells a run would probe: 144, plus 8 canary requests` where the command
it quotes prints 24 — true the day it was written, and read by the person
deciding what traffic to allow on somebody else's deployment. A transcript pasted
into a document is a copy of program output that nothing re-runs, so the two
arithmetic lines of every such quotation in every tracked markdown file are now
re-measured against the reference polygon's own preview.

**Three sentences in ADR-0064 credited the compiler with edits it does not
refuse**, and adversarial review demonstrated each with `npx tsc --noEmit` and
`npx vitest run` both green: a second severity table restored to `src/cli/screen.ts`,
a second `YYYY-MM-DD` expression restored to the schema, and the two-layer header
rule re-inlined into the configuration parser. The ADR now says what the compiler
does hold — a severity level added to the union, and a copy of the header rule
that *imports* the two lists, which are module-private since this change — and a
source scan holds the rest, with its own header naming what it cannot see. Two
further sentences were false about history and are corrected: this repository is
twelve days old, so no duplicate in it has "agreed for months", and neither
ADR-0024 nor ADR-0032 describes a report that said `match: true`.

Three things changed behaviour. Two are in the safe direction: an acceptance whose
`until` names a day that does not exist — `2026-11-31` — used to roll over into
the next day through the library door and now reads as lapsed, and the same
deadline string is refused by one grammar wherever it arrives. The third is one
sentence an operator reads: `UnsafeCanaryError` now interpolates the same
constant the implementation counts by, so it says "up to 3 times" where it used
to say "up to three times". Spelling the word back would put the number in two
places again, which is what this entry is about.

**A configuration that names one defect twice is still refused, and one that
does not is no longer refused with it**
([ADR-0048](docs/adr/0048-a-finding-can-be-known-and-still-reported.md), note of
24 August 2026). The duplicate check keyed on the citable form of a defect's
coordinates — the string meant for a person to paste into a ticket, which joins
with a space and writes `baseline` where there is no context — while the report
matches a finding on the NUL-joined signature. Nothing reserves the word
`baseline` or forbids a space in an id, so a file could be refused for naming one
defect twice when it named two. The check now asks the same function the report
does; the message still prints the citable string, because that is what the
operator wrote.

**Those gates were walked around in turn, and five ways in are closed.** The one
that matters is the link between what `--dry-run` bills and what a run sends: it
drove a single command line, so the preview's own `--unsafe-methods` could be
pinned to `false` and the whole suite stayed green. That is the worst place in
this tool to undercount. With `--unsafe-methods` the run writes, and an operator
who picks a `--max-requests` ceiling the preview called sufficient gets a run
truncated after it has already changed objects on somebody else's deployment. The
polygon is previewed and walked in both modes now — 144 cells and 180, the same
24 canary requests — and `--resume`, which was in the same position, is covered
with the carried cells taken from a real walk. `--checks` is not: it selects what
is compared once a response is in hand and moves no request count, and the test
says so rather than pretending to measure it.

The other four were gates reading less than they claimed. The severity scan was
anchored on `:\s*\d`, so a second rank table written `+0 … +4`, or with quoted
keys, passed; the forbidden-header scan read three remembered names, so a second
composition carrying six *other* members of the same two lists passed — it now
takes every member out of the owning module's own source and counts them per
file; `Matrix rows:` in a documented transcript was compared only when it sat on
the line above the bill, so the same line with a blank line under it could say
anything; and the transcript gate's list of "quotes some other declaration"
excused a whole file, so a polygon transcript with wrong numbers pasted into
ADR-0042 was excused with it. [ADR-0064](docs/adr/0064-a-table-written-twice-is-made-to-agree.md)
carries the mutation for each, the refusal its harness prints when a replacement
does not apply, and a section naming what is still open — starting with the fact
that a source scan reads what a person writes by accident and not what somebody
writes to defeat it. Nothing a consumer can observe changes: the same 227
exported names.

**What a scan of source text can hold is now written once**
([ADR-0065](docs/adr/0065-what-a-source-scan-can-hold.md)). Five of the ADRs
above had grown their own version of the same paragraph, and a sentence that
appears five times is five sentences to keep true — which is how eighty of them
came to claim more than the code did. ADR-0060 to ADR-0064 point at the one
document now and keep only the limits that were measured on their own gate. This
round closes nothing, on purpose: the alternative it rejects is answering the
next evasion with the next pattern, which is what the five rounds before it did.

**And five more ways past those gates are measured and written down rather than
closed.** A back door put into `joinUrl` itself instead of into the seam function
the gate pins — the whole suite green, and
`joinUrl("https://api.test/v1/", "/internal/reports?_method=DELETE")` returning
that address with the query string on it. A fifth address rule hoisted into a
`const` and referenced in the table by name, which moves neither the count of ids
nor the count of entries. A second forbidden-header composition written out of
full header names — `x-http-method-override` rather than the `x-http-method` the
list holds — which carries no member of either layer for the scan to count. The
coverage gate's outcome half switched off by one line inside its own source,
after which `pnpm run test:coverage` still exits 0 and still prints that every
module the package ships was measured. And one spelling of a narrowed `test.include`
— `tests/**/!(coverage-gate).test.ts` — which turns the configuration half off
with every coverage number where it was; a negated second entry is caught
instead. Each was run against the full suite before it was
written down, and the ADR that owns each gate carries what was run.

**An identifier now has a grammar, and this one a consumer can observe**
([ADR-0066](docs/adr/0066-an-identifier-has-a-grammar.md)). `src/core/keys.ts`
described the character it glues keys with as "a character that never occurs in
an identifier" and nothing made that true: an endpoint id, a context id and an
accepted finding's `kind` were `z.string().min(1)` with no character class, and
YAML writes a NUL as `\0` inside double quotes. A key is a fixed number of parts
joined by that character, so a part carrying one splits two ways — two
acceptances of two *different* defects had a single key, and the `Map` that
indexes them kept the last, which then decided the other's deadline.

The five strings a key is made of — an account id, an endpoint id, a resource id,
a context id and a finding's kind — are now held to a rule: no C0 control, no
DEL, no C1 control, neither Unicode line separator, and not the empty string,
which is how a key writes a coordinate it does not have. A space, punctuation,
any script and an emoji are all still names. The rule is applied at `joinKey`,
the one place a key is built, because that is the seam that covers the door
nobody enumerates — a consumer of the library handing `Endpoint[]` straight to
the core — and it is applied again at each of the eight doors that can name the
line of the file to change. Refusing the NUL alone would have been a point fix on
whichever character the separator happens to be.

What changes for a consumer: a configuration or a document carrying one of those
characters in one of those five fields is refused where it used to be accepted,
with a message naming the field and spelling the character out; nothing that was
refused before is accepted now; and the package exports three names more, 230
where it exported 227 — the grammar and the error it throws, because a rule the
library door holds a consumer to and does not let them inspect is a wall rather
than a check. The oracle answers as it did over all 29 combinations of the
reference platform. One key's bytes did change: the evidence budget in
`capRows` used to glue `kind` first and now glues it last, because it asks
`defectSignature` to extend itself rather than handing a finished signature back
as a part. The tuple is the same and the map is the same size, so nothing a
report carries moved — but the sentence "every key's bytes are what they were"
was in this paragraph until an adversarial review measured that one of them was
not.

**A saved report is a document too, and `barbican diff` read two of them without
a grammar between.** The paragraph above counted five parsers, the library door
and a resume stream, and missed the ninth: `toComparableRun` lifted every string
out of a saved report and handed it on — `defects[].key` to index the comparison,
`observations[].endpointId` to index the probed set, and both of them onto the
terminal verbatim. Measured against the built tree: `U+001B` `[2K` and a carriage
return in an endpoint id erase the line the comparison printed it on, and
`U+001B` `[31m` in a defect key recolours the rest of the screen. That file can
come from another machine, an earlier build or somebody else, exactly like an
OpenAPI file, and it is the shape
[ADR-0032](docs/adr/0032-the-grammar-sits-at-the-seam.md) records twice: a guard
on the ways in, and nothing on the door with no adapter behind it.

Every string `toComparableRun` reads now goes through the grammar — not only the
two that were measured, because `runId`, `verdict.reason`, `target.label`, a skip
reason and the digest are all printed too, and none of them is ever empty or
carries a control character in a report this tool wrote. **Refused, not escaped:**
escaping on the way to a terminal is modelling the terminal, which is the mistake
ADR-0032 records about the address. The refusal names the field with its index,
the file it came from and the character, and spells the value out. The cost is
stated in the ADR: a report written before this change can carry such an id, and
it will not compare until the id is fixed where it is declared.

Three more from the same review. The observation stream `--resume` reads has a
door of its own now, so a hostile line is named by its cell and its file rather
than by the seam half a walk later, and the header is asked before the version
and declaration mismatches print it back. The OpenAPI parser said its generated
fallback id needed no check because the path had already been through
`pathTemplate` — measured false, because that grammar admits `U+0085`, the C1
range and the two line separators, so `/a` `U+0085` `b` with no `operationId`
produced an id the seam refused mid-walk with no operation named. And
`alice-a@geo-blocked` is a composition on a character an account id may legally
carry: account `a` under context `b@c` and account `a@b` under context `c` both
give `a@b@c`, the attribute map held one entry for the two rows, `run` spent all
four of its requests before `DuplicateIdError` and `--dry-run` printed `Matrix
rows: 4` and exited 0. It is refused where the id is minted now, before any
traffic, naming both rows — one name more on the published surface, 231 where it
was 230.

`src/core/identifiers.ts` was a decision with one home and no gate, which
CLAUDE.md's rule does not allow: a second copy of the grammar plus a new export
`looksLikeAnIdentifier` in `src/report/findings.ts` left the whole suite green.
`tests/invariants/one-decision-one-home.test.ts` holds the third owner now, by
the three code points that tell this class from the address grammar's and by the
names it owns — including through `src/core/index.ts`, which re-exports it on
purpose and is enumerated as the one conduit that may. Nine ways past it were
written and run before this sentence; what is still open is in the ADR's
`Limits`, measured the same way, and includes a copy whose code points are
computed rather than written.

**A response header the platform chose no longer reaches the report as a control
character** ([ADR-0066](docs/adr/0066-an-identifier-has-a-grammar.md), note of
24 August 2026). A header on the value allowlist is kept whole, because the
verdict needs it — and the platform under test is the untrusted party here by
construction. `JSON.stringify` escapes C0 and leaves C1 alone, so a
`content-type` carrying U+009B, a one-character CSI, reached `report.json`
intact and drove the terminal of whoever opened it: measured, two raw C1
characters in a report this tool wrote. Such a character is now written out as
`\u009B` where the value is kept. Spelled out rather than redacted, because the
value is evidence and a reader has to see what arrived; and at the point the
value is kept rather than on the way to a screen, because the file outlives the
run and the tool does not own the screen it is opened on. The package exports
232 names, one more than before — `spellOut`, so that a consumer building its
own report has the same rendering rather than a second one.

### Unreleased

**A saved report can be turned into an evidence pack: the structure a document
about external standards is drawn from**
([ADR-0067](docs/adr/0067-an-evidence-pack-says-what-it-checked.md)). This is the
first half of Module 2, and it is pure — `evidencePack({ run, catalog })` takes a
report that has already been written and the catalogue it is to be read against,
and returns one row per clause. Nothing renders anything yet and no subcommand
builds one; JSON stays the single source of truth and a document is drawn from it
in a separate step.

The structure is the small half. What the change actually decides is **what such
a pack is allowed to say**, and every rule of it points the same way:

- **A clause no check cited and no cell was evidence about is `unanswered`, never
  a pass**, and the sentence beside it says so. The catalogue is what makes that
  sayable at all: a pack built from what a run happened to cite lists what was
  checked, and the question a reader has is what was not.
- **`upheld` carries its denominator and its reservations on the row** — the cells
  that concluded, the cells that concluded nothing by reason, and why "exercised"
  falls short of "holds across the surface". Those come out of the report's own
  `coverage.clauses` rather than being computed a second time.
- **A run that exited 2 reports what it found and reports nothing as upheld.** It
  describes the network, the deployment or its own credentials rather than the
  platform, so a cell that agreed may have agreed for a reason that has nothing to
  do with access — while a hole found before the budget ran out is still a hole.
- **A pack states, on every pack, that it is evidence about a policy a human
  declared** ([ADR-0006](docs/adr/0006-expected-access-declaration.md)), that every
  conclusion in it is drawn from status codes seen from outside, and that the
  catalogue it was read against is bounded. None of the three can ever be
  discharged by running the tool again.

The eleven sentences a pack prints live in one table, for the reason `WARNINGS`
does: two copies of an assertion become two assertions the day one of them is
improved. `tests/invariants/a-claim-has-one-wording.test.ts` is the gate on that,
and what it does **not** catch — a paraphrase above all — is measured and listed
in the ADR's `Limits`.

Reading a saved report is now one module, `src/report/document.ts`, shared by the
comparison's door and the pack's: every string lifted out of a file still goes
through the identifier grammar
([ADR-0066](docs/adr/0066-an-identifier-has-a-grammar.md)), and a rendered
document is a new sink for one. Six names go onto the published surface —
`evidencePack`, `toPackableRun`, `PACK_SCHEMA_VERSION`, `CLAIMS`, `STANDINGS`
and `DISCLAIMERS`.

**And the pack can be drawn into a document an auditor opens:
`barbican pack <report.json> --out <file.html>`**
([ADR-0068](docs/adr/0068-a-pack-is-drawn-from-the-json.md)). One
self-contained HTML file — no external stylesheet, no font, no image, no script
— because it is read on a machine with no network and printed to PDF through a
browser. `--json <path>` writes the structure the document was drawn from, so the
document can be checked against it rather than taken on trust. It exits 0 when a
pack was built, 2 when the report cannot be read, **and 2 when the run behind it
exited 2**: such a pack is worth reading and says on its face that no clause in
it is upheld, and a pipeline that ships one as evidence unnoticed is the same
defect this whole artifact is written against.

Everything the page says comes out of the pack. The sentences are the pack's
`notes` and `CLAIMS`; the rest is labels, numbers and the reservations, which sit
**on the clause row they qualify** rather than in a footnote — a qualification
left behind in another section is one that did not travel with the claim. The
page has no way to reach anywhere and no way to run anything: the element and
attribute names the renderer can write are closed unions with no `href`, no `src`
and no `on…` in them, so a clause's published address is printed as text and a
`javascript:` URL is never the scheme of anything. Text from outside is spelled
out by the identifier grammar and then escaped for markup — two jobs, composed,
neither rewritten. `tests/report/pack-page.test.ts` feeds a `<script>`, an
`onerror=`, a `</style>`, a `javascript:` URL and a U+2028 through every channel
the page draws from and then asks the rendered bytes which elements and which
attributes are in them.

The print rules — a clause row that does not split across a page boundary, a
margin, black on white — are **declared and not measured**: no browser runs in
this repository's suite, and the test asserts that the properties are in the
document rather than that an engine honoured them.

The package exports 240 names: `renderPack` and `UnrenderableClaimError` beside
the six above. The second is the renderer's one decision — a claim outside the
vocabulary is refused rather than printed as a bare word.

## Example

The CLI runs the whole thing — see [`examples/`](examples/) for a minimal starter config.
It points at a host that does not exist and expects a token in the environment, so it is
a template to edit, not a demo to run:

```bash
barbican run --config examples/minimal/barbican.run.yaml --endpoints examples/minimal/endpoints.yaml
```

The package ships `docs/`, `examples/` and `schema/`, so after an install those files
are under `node_modules/barbican/` — copy the config pair out and edit them in place.
The starter carries a `$schema` line, so an editor with the YAML language server
completes and validates the format as you type.

Add `--dry-run` to any run to see the endpoint identifiers, what will be skipped and
the exact number of cells, **without sending anything**. That is the right first
command against a deployment you do not own.

For something that actually answers, run against the reference platform in
[`polygon/`](https://github.com/Tarnellion/barbican/tree/main/polygon): a multi-tenant target with switchable defects and a hand-written
oracle, needing no Docker, only Node. It comes with a clone rather than with the package —
a deliberately vulnerable server has no business landing in everyone's `node_modules`:

```bash
git clone https://github.com/Tarnellion/barbican && cd barbican
pnpm install && pnpm run build
node polygon/verify.mjs
```

The library is the same machinery without the transport. Note the naming: YAML
configuration says `role` and `tenant`, the TypeScript types say `roleId` and
`tenantId` — same fields, different surfaces. Feed in observations from your
own harness, declare what access you intended, and get back only what disagrees:

```ts
import { ANY, buildAccessMatrix, diffAccess, expandPolicy } from "barbican";
import type { Endpoint, ExpectedAccessPolicy } from "barbican";

// Declared once: `expandPolicy` needs them to turn patterns into names, and a
// pattern that matches nothing has to fail there rather than quietly stop
// applying.
const endpoints: Endpoint[] = [
  { id: "profile.read", method: "GET", path: "/v1/players/{playerId}" },
  { id: "users.list", method: "GET", path: "/v1/admin/users" },
];

const matrix = buildAccessMatrix({
  endpoints,
  accounts: [{ id: "player-1", roleId: "player", tenantId: "tenant-a" }],
  // `headers` and `durationMs` are optional: nothing in the core reads them, and
  // an empty header map would claim the response carried none rather than that
  // none were recorded.
  observations: [
    { accountId: "player-1", endpointId: "profile.read", status: 200, outcome: "allowed" },
    { accountId: "player-1", endpointId: "users.list", status: 200, outcome: "allowed" },
  ],
});

// Anything not granted by a rule falls through to `fallback`.
const policy: ExpectedAccessPolicy = {
  fallback: "denied",
  rules: [{ roles: ANY, endpoints: ["profile.read"], outcome: "allowed" }],
};

const found = diffAccess(matrix, expandPolicy(policy, endpoints));
// found = [
//   {
//     accountId: 'player-1',
//     endpointId: 'users.list',
//     expected: 'denied',
//     kind: 'privilege-escalation',
//     severity: 'high',
//     actual: 'allowed'
//   }
// ]
```

The expected matrix is always declared by a human and never derived from the spec of the
API under test — that spec is usually generated from the same code, so deriving from it
would compare an implementation against itself.

## Exit codes

The exit code is the CI contract, and it distinguishes three things that are easy
to confuse:

| Code | Meaning |
|---|---|
| `0` | checked, and reality matches what you declared |
| `1` | checked, and it does not — a privilege escalation, an unexpectedly denied access, or a high-severity check finding |
| `2` | **the result cannot be trusted** — no observations were made, the run was cut short, or the accounts were not authenticated |
| `64` | the command line was wrong — an unknown flag, a missing required one, a bad value. Nothing was sent |
| `130` | interrupted from the keyboard, part-way through the walk |

`64` is `EX_USAGE` from `sysexits.h`, and it exists because the alternative was
worse: a typo in a flag name used to exit `1`, which in CI is indistinguishable
from "a privilege escalation was found". The line is drawn where the run starts —
what the argument parser rejects is `64`, and anything that fails after that is
`2`.

`barbican diff` keeps the same four meanings one level up: `0` the same defects
over the same surface, `1` the two runs do not describe the same platform, `2`
the comparison cannot be trusted — a truncated run, a report compared with
itself, coverage that shrank — and `64` for the command line alone. The table of
reasons is in [docs/report.md](docs/report.md), "Comparing this report with an
earlier one".

Code `2` takes priority over `1`: an unverified run is never clean. Note that an
*unexpected denial* also fails the run — the tool compares declared intent with
observed behaviour, and a disagreement is a disagreement whichever way it points.
It cannot tell whether your declaration or the platform is wrong, so it does not
stay silent. See [ADR-0014](docs/adr/0014-severity-and-exit-codes.md).

## Permission comes first

**Get the system owner's agreement before you run this against anything you do
not own.** In writing, naming the deployment and the window.

The tool issues authenticated requests as several accounts across a platform's
whole surface, looking specifically for places where one account reaches
another's data. That is what an intrusion looks like from the inside — from the
logs, from a WAF, from whoever is on call. Nothing below changes that: the
defaults keep the traffic small and the report clean, and they are not a
substitute for being allowed.

Two things are worth agreeing separately rather than assuming:

- **`--unsafe-methods`** issues requests that change state. A cancelled order
  stays cancelled after the report is written; barbican does not undo what it
  did. It also makes the walk change what it measures — the first account to
  delete an order leaves every later one a 404 — so those cells are recorded as
  "no conclusion" rather than as denials. See "the order of the walk" in
  [docs/guide.md](docs/guide.md).
- **A shared or production deployment.** Even at the default five requests a
  second, a run appears in somebody's monitoring, and an unannounced one gets
  treated as what it resembles.

This is not legal advice, and the licence disclaims warranty — but the reason to
ask is simpler than the law: someone has to know that the traffic in their logs
is yours.

And they have to be able to *find* it there. Every request names the tool, its
version and the run in `user-agent` — `run=` being the `runId` of the report you
will hand over — so an access log, a SIEM query and an availability graph can all
separate the run they agreed to from the thing it is shaped like. Put that
identifier in the agreement. `--no-identify` sends the run unannounced, which is
worth having when what you are measuring is how an unmarked sweep is received,
and worth saying out loud when it is not.

## Safety defaults

barbican is meant to run against systems you do not own outright, so the defaults are
conservative and enforced by construction rather than by flags you have to remember:

- Only `GET` and `HEAD` are issued unless `--unsafe-methods` is passed explicitly.
- A host allowlist is mandatory; without one the tool refuses to run.
- Response bodies are never stored. By default they are not even read: the stream is
  cancelled. Where you explicitly declare `bodySignals.responseMustDifferByTenant`, a body
  is read in transit to compute an irreversible scalar — a salted 48-bit digest — and
  discarded. The signal type admits numbers and booleans only, so a body structurally
  cannot fit in it. This is what makes a missing tenant filter on a list endpoint visible
  at all: it returns 200 either way, so no status code distinguishes it.
- External `$ref`s in OpenAPI documents are never resolved, over HTTP or the filesystem
  (SSRF and path traversal).
- Throttling is always on: concurrency and rate caps, exponential backoff, a circuit
  breaker, and `Retry-After` is respected.
- The run names itself on the wire, so the owner of the platform can tell it from an
  attack in their own logs and match those logs to the report. `--no-identify` for the
  deliberate case where it must not.
- The report is written `0600` when `--report` names a path. Without it the report goes
  to stdout, and the run says so before it starts.

## Development

```bash
corepack enable pnpm
pnpm install
pnpm run hooks:install   # git hooks; requires gitleaks (brew install gitleaks)
pnpm run check           # lint + typecheck + test + build
```

## How much traffic it makes

Throttling is a port, not an option: there is no way to turn it off. The defaults
are deliberately timid, and the numbers are these:

| Limit | Default | Flag |
|---|---|---|
| Concurrent requests | 2 | `--concurrency` |
| Requests per second | 5 | `--rps` |
| Requests per run | 2000 | `--max-requests` |

Which of the three binds depends on the deployment. At the defaults it is the
rate: 60 cells at `--rps 5` take about 12 seconds whether one request is in
flight or eight. `--concurrency` earns its keep once the rate ceiling is lifted —
610 cells against a target answering in 20 ms go from 14.1 s at 1 to 0.5 s at 64
— which is to say on a deployment you have been allowed to probe faster. It is
honoured by the walk since 15 August 2026; before that it was printed into the
report and had no effect ([ADR-0023](docs/adr/0023-the-walk-is-parallel.md)).

**`--rps` is a shape and not only a count.** Requests are spaced `1000 / rps`
milliseconds apart rather than released in a burst at the top of each second: a
window limiter that lets five go at once and then waits satisfies "five a second"
while putting five requests on your deployment in the same instant. Two things
follow that are worth expecting rather than discovering. The declared rate is a
**ceiling the tool stays under**, so `--rps 50` delivers about 46 a second. And
above 500 a second the spacing is off — a millisecond clock cannot express a
shorter gap, and trying capped the tool at ~850 a second whatever the flag said —
so beyond that the traffic is counted but not shaped
([ADR-0026](docs/adr/0026-the-rate-is-a-shape-not-only-a-count.md)).

One cell is one request. A run costs roughly `accounts × endpoints × resources`
requests — the reference polygon with 9 accounts, 6 resources and 7 endpoints
comes to 144 cells and finishes in about a minute. One of those endpoints is a
write, so it is skipped unless `--unsafe-methods` is passed; with the flag the
same run walks 180. Declaring request conditions multiplies that by the number of
contexts, which is why a context must name the endpoints it applies to.

When the budget runs out the run stops and the report says so: `truncated: true`
and exit code 2, because the tail of the matrix was never tested and the absence
of findings there means nothing. A run that ends this way is not a clean run.

The effective limits are written into the report (`inputs.throttle`), so "the
throttle was on" is not something you have to take on faith.

## Releasing

Publishing goes through CI, never from a laptop. `publishConfig.provenance` is on,
and provenance needs an OIDC witness that a local machine cannot provide — a manual
`npm publish` fails by design, which is the point.

A release is three edits and a tag, in one commit:

1. Rename the `### Unreleased` section of this README to
   `### What changed in <version>`. It has been written as the changes landed —
   that is [ADR-0034](docs/adr/0034-what-main-carries-beyond-the-release.md), and
   the reason is that reconstructing it from the log at tag time failed twice.
   The section is the **last** of the "What changed" run, because the rename is
   the whole edit: sitting anywhere else it would file the new version among the
   old ones. It spent three hours on 23 August 2026 between `0.4.0` and `0.5.0`,
   one heading above a version it says it is ahead of, and the guard below now
   reads where the section sits — both that it is the last of the run and that
   the run has nothing else in the middle of it — as well as what is under it.
2. Set that version in `package.json`. Between releases it names the last version
   this tree shipped, so this is where it moves.
3. Read the renamed section as a consumer of the previous version would.

```bash
# the tag must match package.json's version — the workflow verifies it
git tag v0.6.0 && git push origin v0.6.0
```

The tag triggers [`release.yml`](https://github.com/Tarnellion/barbican/blob/main/.github/workflows/release.yml): it runs the same
gate as CI, checks that the tag equals `package.json`'s version, and publishes with
short-lived credentials issued over OIDC. No long-lived npm token exists anywhere.

One-time setup on npmjs.com, done by the package owner: add a **trusted publisher**
for `barbican` pointing at this repository and the `release.yml` workflow. Until that
exists, the release job fails at the publish step — which is the safe direction:
not publishing beats publishing without provenance.

## License

Apache-2.0

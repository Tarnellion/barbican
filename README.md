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

## Documentation

The repository is English throughout: this README, both guides, every polygon
write-up, every design record in `docs/adr/`, the working notes, the
comments and test names inside the source, and every message the CLI prints. A
test enforces it — the rule survives exactly as long as it is checked. Russian
copies live outside the repository and are a snapshot, not a second version;
where two language versions disagree, the English files are the source of truth.

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

`0.4.0` is the current release, and the one to install. Publishing goes through
CI with provenance, so `npm audit signatures` verifies it against this repository
and the workflow that built it.

Neither earlier version is worth having. **`0.1.0` is a stub whose CLI registers
no commands**, published by hand before the release pipeline existed; `0.2.0`
ships a tarball with no guide and no examples, and a CLI that speaks Russian
around English documentation.

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

### Unreleased

On `main`, not on npm. `0.4.0` is still what `npm install barbican` gives you, and
none of the following is in it. This section is written as the changes land and is
renamed to name the version when that version is tagged.

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
2. Set that version in `package.json`. Between releases it names the last version
   this tree shipped, so this is where it moves.
3. Read the renamed section as a consumer of the previous version would.

```bash
# the tag must match package.json's version — the workflow verifies it
git tag v0.5.0 && git push origin v0.5.0
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

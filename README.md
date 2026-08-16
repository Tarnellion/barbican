# barbican

A CLI tool and library for testing RBAC and tenant isolation in multi-tenant APIs.

Given a set of accounts across different roles and tenants, barbican walks the
role × endpoint matrix, records the access each account actually gets, compares it
against a policy you declare, and reports the discrepancies: privilege escalation,
BOLA/IDOR, and cross-tenant leaks.

## Status

Early development, but end-to-end: `barbican run` walks a live API and writes a report.
Validated against three targets — [crAPI](docs/polygons/crapi.md), VAmPI, and a
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

See [plan.md](https://github.com/Tarnellion/barbican/blob/main/plan.md) for the roadmap and [docs/adr/](docs/adr/) for the reasoning
behind each design decision.

## Install

```bash
npm install barbican
barbican run --help
```

`0.3.0` is the current release, and the one to install. Publishing goes through
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
  observations: [
    {
      accountId: "player-1",
      endpointId: "profile.read",
      status: 200,
      headers: {},
      outcome: "allowed",
      durationMs: 12,
    },
    {
      accountId: "player-1",
      endpointId: "users.list",
      status: 200,
      headers: {},
      outcome: "allowed",
      durationMs: 15,
    },
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
  did.
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

```bash
# 1. version in package.json is already the one being released
# 2. tag it — the tag must match that version, the workflow verifies it
git tag v0.3.0 && git push origin v0.3.0
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

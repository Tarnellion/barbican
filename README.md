# barbican

A CLI tool and library for testing RBAC and tenant isolation in multi-tenant APIs.

Given a set of accounts across different roles and tenants, barbican walks the
role × endpoint matrix, records the access each account actually gets, compares it
against a policy you declare, and reports the discrepancies: privilege escalation,
BOLA/IDOR, and cross-tenant leaks.

## Status

Early development, but end-to-end: `barbican run` walks a live API and writes a report.
Validated against three targets — [crAPI](docs/polygons/crapi.md), VAmPI, and a
[reference platform](polygon/) with switchable defects and a hand-written oracle.

- **Works today** — OpenAPI/Postman/manual endpoint sources, throttled probing across
  accounts and roles, path and query parameter substitution, cross-tenant and BOLA
  detection, scalar signals over response bodies, JSON report and exit codes.
- **Not yet** — see the limitation below, plus [tasks.md](tasks.md).

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
[tests/core/tenant-hierarchy.test.ts](tests/core/tenant-hierarchy.test.ts), which pins
both behaviours side by side, and [docs/guide.md](docs/guide.md) for how to declare it.

An account whose reach is a *set* of tenants rather than a subtree — support staff
covering brands under two different holdings, an affiliate working two of a group's
three brands — declares `tenants: [brand-a, brand-c]` instead of `tenant`. The relation
is then computed against every membership, and the nearest one wins; there is no sixth
relation value. Forcing such an account into a single node fails in the familiar way,
and [tests/core/tenant-set.test.ts](tests/core/tenant-set.test.ts) pins all three
workarounds and what each of them gets wrong. See
[ADR-0017](docs/adr/0017-account-tenant-set.md).

## Documentation

Everything the tool says and everything you read to use it is in English:
this README, both guides, and every message the CLI prints. Design records
in `docs/adr/` are still Russian — they explain decisions to whoever maintains
the code, and translating them is in progress.

- **[docs/guide.md](docs/guide.md)** — declaring accounts, tenants, resources and
  the access policy; running a scan; what the tool deliberately does not do.
- **[docs/report.md](docs/report.md)** — reading the report: every summary field,
  exit codes, and how to tell *"checked and clean"* from *"nothing was checked"*.

See [plan.md](plan.md) for the roadmap and [docs/adr/](docs/adr/) for the reasoning
behind each design decision.

## Install

```bash
npm install barbican
barbican run --help
```

`0.2.0` is the first release published from CI with provenance: `npm audit signatures`
verifies it against this repository and the workflow that built it. Install `0.2.0`
or newer — **`0.1.0` is a stub whose CLI registers no commands**, published by hand
before the release pipeline existed.

## Example

The CLI runs the whole thing — see [`examples/`](examples/) for a minimal starter config
and [`polygon/`](polygon/) for a working target with deliberate defects and a hand-written
oracle. The starter config points at a host that does not exist and expects a token in
the environment, so it is a template to edit, not a demo to run:

```bash
barbican run --config examples/minimal/barbican.run.yaml --endpoints examples/minimal/endpoints.yaml
```

For something that actually answers, run against the bundled polygon — it needs no
Docker, only Node:

```bash
node polygon/verify.mjs
```

The library is the same machinery without the transport. Note the naming: YAML
configuration says `role` and `tenant`, the TypeScript types say `roleId` and
`tenantId` — same fields, different surfaces. Feed in observations from your
own harness, declare what access you intended, and get back only what disagrees:

```ts
import { ANY, buildAccessMatrix, diffAccess } from "barbican";
import type { ExpectedAccessPolicy } from "barbican";

const matrix = buildAccessMatrix({
  endpoints: [
    { id: "profile.read", method: "GET", path: "/v1/players/{playerId}" },
    { id: "users.list", method: "GET", path: "/v1/admin/users" },
  ],
  accounts: [{ id: "player-1", roleId: "player", tenantId: "tenant-a" }],
  observations: [
    { accountId: "player-1", endpointId: "profile.read", status: 200, headers: {}, outcome: "allowed", durationMs: 12 },
    { accountId: "player-1", endpointId: "users.list", status: 200, headers: {}, outcome: "allowed", durationMs: 15 },
  ],
});

// Anything not granted by a rule falls through to `fallback`.
const policy: ExpectedAccessPolicy = {
  fallback: "denied",
  rules: [{ roles: ANY, endpoints: ["profile.read"], outcome: "allowed" }],
};

console.log(diffAccess(matrix, policy));
// [
//   {
//     accountId: "player-1",
//     endpointId: "users.list",
//     expected: "denied",
//     actual: "allowed",
//     kind: "privilege-escalation",
//   },
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

Code `2` takes priority over `1`: an unverified run is never clean. Note that an
*unexpected denial* also fails the run — the tool compares declared intent with
observed behaviour, and a disagreement is a disagreement whichever way it points.
It cannot tell whether your declaration or the platform is wrong, so it does not
stay silent. See [ADR-0014](docs/adr/0014-severity-and-exit-codes.md).

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

One cell is one request. A run costs roughly `accounts × endpoints × resources`
requests — the reference polygon with 9 accounts, 6 endpoints and 6 resources
comes to 144 cells and finishes in about a minute. Declaring request conditions
multiplies that by the number of contexts, which is why a context must name the
endpoints it applies to.

When the budget runs out the run stops and the report says so: `truncated: true`
and exit code 2, because the tail of the matrix was never tested and the absence
of findings there means nothing. A run that ends this way is not a clean run.

The effective limits are written into the report (`inputs.throttle`), so «the
throttle was on» is not something you have to take on faith.

## Releasing

Publishing goes through CI, never from a laptop. `publishConfig.provenance` is on,
and provenance needs an OIDC witness that a local machine cannot provide — a manual
`npm publish` fails by design, which is the point.

```bash
# 1. version in package.json is already the one being released
# 2. tag it — the tag must match that version, the workflow verifies it
git tag v0.2.0 && git push origin v0.2.0
```

The tag triggers [`release.yml`](.github/workflows/release.yml): it runs the same
gate as CI, checks that the tag equals `package.json`'s version, and publishes with
short-lived credentials issued over OIDC. No long-lived npm token exists anywhere.

One-time setup on npmjs.com, done by the package owner: add a **trusted publisher**
for `barbican` pointing at this repository and the `release.yml` workflow. Until that
exists, the release job fails at the publish step — which is the safe direction:
not publishing beats publishing without provenance.

## License

Apache-2.0

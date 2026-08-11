# barbican

A CLI tool and library for testing RBAC and tenant isolation in multi-tenant APIs.

Given a set of accounts across different roles and tenants, barbican walks the
role × endpoint matrix, records the access each account actually gets, compares it
against a policy you declare, and reports the discrepancies: privilege escalation,
BOLA/IDOR, and cross-tenant leaks.

## Status

Early development. The core is usable as a library; the network layer does not exist yet.

- **Works today** — declaring an access policy, building an access matrix from
  observations, and diffing the two into classified findings.
- **Not yet** — the HTTP client, the OpenAPI parser, and the CLI commands that tie them
  together. The `barbican` binary currently answers only `--help` and `--version`.

See [plan.md](plan.md) for the roadmap and [docs/adr/](docs/adr/) for the reasoning
behind each design decision.

## Install

```bash
npm install barbican
```

## Example

Observations come from your own harness for now. Feed them in, declare what access you
intended, and get back only what disagrees:

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

## Safety defaults

barbican is meant to run against systems you do not own outright, so the defaults are
conservative and enforced by construction rather than by flags you have to remember:

- Only `GET` and `HEAD` are issued unless `--unsafe-methods` is passed explicitly.
- A host allowlist is mandatory; without one the tool refuses to run.
- Response bodies are never stored — only status codes, headers, and whether access was
  granted. Bodies hold your customers' data.
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

## License

Apache-2.0

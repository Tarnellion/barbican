# CLAUDE.md

## Project

`barbican` is a CLI for checking RBAC and tenant isolation in the APIs of multi-tenant platforms.

- **Module 1 (current):** the "role × endpoint" matrix, privilege escalation, BOLA/IDOR, cross-tenant leaks.
- **Module 2 (later):** an evidence pack against external standards. Added by registering checks, not by rewriting the core.

## Stack

Node >=22.12 · TypeScript 6 (`nodenext`, strict) · commander 15 · vitest 4 · Biome 2 · pnpm 11 · lefthook + gitleaks.

The build is `tsc`, no bundler. Exact versions, no ranges.

## Architectural invariants

- `src/core` — pure functions. No HTTP, no file system, no global state. Input: roles, endpoints, observations. Output: the matrix and the diffs (`expected.ts`, `matrix.ts`, `diff.ts`). Tested on fixtures, without the network.
- **Expected access is declared by a human** (`ExpectedAccessPolicy`) and is never derived from the specification of the API under test: the spec is generated from the same code, and deriving from it would mean comparing an implementation against itself. See ADR-0006.
- JSON is the single source of truth. HTML/PDF are rendered from JSON in a separate step, not generated along the way as the checks run.
- Checks are plugins through `CheckRegistry` (`src/core/checks/`). Each one has an `id`, a description, a function, and a mapping onto clauses of external standards.
- A matrix cell is **account × endpoint × resource × request conditions**. Conditions (ADR-0019) are a minimal piece of ABAC: the platform's decision logic is not modelled, the outcomes of declared sets are compared. In the core a condition is a `contextId` label; the attributes (headers, parameters) live in the adapters.
- Adapters (HTTP, spec parser, throttling) sit behind interfaces in `src/adapters/ports.ts`. Replacing an implementation must not touch the core.
- The package works both as a CLI (`bin`) and as a library (`exports`).

## Security invariants

- **Safe by default:** without an explicit `--unsafe-methods` only GET and HEAD are issued (`SAFE_METHODS` in `src/core/types.ts`).
- **Throttling is always on:** a concurrency limit, a requests-per-second limit, an overall ceiling per run, exponential backoff, a circuit breaker on runs of 5xx/429, respect for `Retry-After`. The defaults are conservative.
- **Response bodies are not stored.** The `HttpResponse` port deliberately carries no body. By default the stream is cancelled without being read. Where a human declared `bodySignals.responseMustDifferByTenant`, the body is read in transit for the sake of irreversible scalars (`SignalValue` — a number or a boolean only) and is stored nowhere. `SignalValue` must not be extended with a string or an object without an ADR: the ban on PII in the report rests on this type. See ADR-0011.
- **Redirects are not followed** (`redirect: "manual"`). Following a 3xx to another host would take the request outside the allowlist — that is a bypass of the scope. Proven by a test: with `follow` the request really does go to a host outside the list.
- **Sensitive response headers are redacted** by a hardcoded list (`set-cookie` and the others that carry credentials): otherwise the platform's session token would end up in the report.
- **External `$ref`s in OpenAPI are not resolved** — neither over http nor through the file system. Protection against SSRF and path traversal. A proving test is required.
- **Sensitive data is redacted along hardcoded paths.** Redaction paths are never taken from user input.
- **Request-condition attributes do not replace the basis of the request.** `authorization`, `cookie`, `host`, the transport headers and the header name of any declared authentication scheme are rejected at startup. The list is hardcoded. See ADR-0019.
- **Scope is mandatory:** without an explicitly set host allowlist the tool refuses to work.
- **Secrets only through environment variables.** Nothing into the repository, nothing into the logs.

## Commands

```
pnpm run lint         # Biome: lint + format
pnpm run lint:fix     # autofix
pnpm run typecheck    # tsc --noEmit
pnpm run test         # vitest run
pnpm run test:watch   # vitest in watch mode
pnpm run test:coverage # vitest with coverage and thresholds
pnpm run build        # tsc -> dist, + the executable bit on cli.js
pnpm run check        # everything at once, as in CI
pnpm run hooks:install # git hooks (lefthook)
```

## Repository language

**Everything that goes to GitHub is in English only.** No exceptions: code,
comments, documentation, ADRs, working notes (`tasks.md`, `plan.md`),
tool messages, test names, texts in polygon configurations
and **commit messages**.

The reason is simple: the repository is public. A mixed language means part of
the project is closed to anyone who does not read Russian — and it is closed
exactly where the explanation of why a decision was made this way and not
another one lives.

The Russian versions are kept **locally**, in `/_local/` (in `.gitignore`). That
is a keepsake snapshot for the owner; it is not maintained and it goes stale:
the source of truth is the English files in the repository. Two language
versions do not stay in agreement, and a silent divergence is exactly the class
of problem this whole tool is written against.

Talking to the project owner in chat happens in Russian. This applies only to
what goes into the repository.

## Rules

- A new package only after vetting: the age of the last release, the number of maintainers, the number of transitive dependencies, provenance. Minimize aggressively; whatever Node's built-ins solve, solve with the built-ins.
- `pnpm install --frozen-lockfile`. The settings `minimumReleaseAge: 10080`, `strictDepBuilds` and the empty `allowBuilds` must not be weakened without an ADR entry.
- Every core feature comes with fixtures and tests. The core coverage thresholds (`vitest.config.ts`) are part of the CI gate, not a report to read; they must not be lowered.
- Fixtures are written by hand. A "reference" generated from the policy turns a test into a check that a function agrees with itself.
- A non-trivial decision gets a short ADR in `docs/adr/`: context, decision, alternatives, consequences.
- Conventional commits.
- The employer's MCP tools and internal sources are not used in this project. Nothing from there — no code, no configs, no endpoint names, no data structures. The list of the specific servers is in `.claude/rules/_local/`, which is not versioned: those names have no place in a public repository.

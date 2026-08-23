# CLAUDE.md

## Project

`barbican` is a CLI for checking RBAC and tenant isolation in the APIs of multi-tenant platforms.

- **Module 1 (current):** the "role × endpoint" matrix, privilege escalation, BOLA/IDOR, cross-tenant leaks.
- **Module 2 (later):** an evidence pack against external standards. Added by registering checks, not by rewriting the core.

## Stack

Node >=22.12 · TypeScript 7 (`nodenext`, strict) · commander 15 · vitest 4 · Biome 2 · pnpm 11 · lefthook + gitleaks.

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
- **Response header values are kept by an allowlist**, everything else is redacted; the names are always kept, because a header being present is itself a signal. A denylist stood here first and was replaced (ADR-0005 addendum): the names that will ever carry a secret cannot be enumerated, and `x-auth-token` on an unfamiliar platform would have reached the report. Do not turn this back into a list of forbidden names.
- **External `$ref`s in OpenAPI are not resolved** — neither over http nor through the file system. Protection against SSRF and path traversal. A proving test is required.
- **A string from outside passes through `src/io/untrusted.ts`.** Header names, header values and path segments have grammars, and each grammar is written there once. `HttpRequest.headers` asks for the branded `HeaderValue`, so a raw `Record<string, string>` cannot reach the client from the CLI or from a consumer of the library. Records keyed by names the tool did not choose are built with `openRecord()` and read with `lookup()` — a plain object literal swallows a key named `__proto__`, and indexing answers for `constructor`. Eleven point fixes of this shape across four files preceded the rule, two of them already drifted apart. Do not add a twelfth: add the case to `untrusted.ts`. See ADR-0024. **Unless the core reads the same grammar** — then it lives in `src/core` and `untrusted.ts` imports it, because `untrusted.ts` already imports the core and the ring must not close. Two do: `isUsablePathSegment` in `core/types.ts`, and the `{name}` of a path template in `core/path-parameters.ts`, which `matrix.ts` reads to decide whether a cell exists. That second one was written three times until 23 August 2026; see the note of that date on ADR-0024, and do not collapse it into one shared `RegExp` with the `g` flag — `lastIndex` survives between calls, so a presence test makes the scan that follows it skip the first parameter.
- **Sensitive data is redacted along hardcoded paths.** Redaction paths are never taken from user input.
- **Request-condition attributes do not replace the basis of the request.** Three layers, not one, and the first version of this rule was wrong with only the first (ADR-0019): exact names (`authorization`, `cookie`, `host`, the transport headers, the header name of any declared authentication scheme); family prefixes (`x-http-method*`, `x-original-*`, `x-rewrite-*`, `x-forwarded-*`); and a check by **value**, which is what catches a method override smuggled through an attribute. Query attributes take a literal only — `{ env: NAME }` is refused there, because a query parameter goes into the address and addresses are printed in the report verbatim. All of it is hardcoded.

- **The address is the tool's to build, whichever door a value comes through.** The rule above was written for request conditions and enforced only there — the one channel an operator fills in by hand. Adversarial review of 17 August 2026 found three more into the same address, each fed by a document the tool was handed: a query string in an OpenAPI `paths` key, in an endpoint list's `path` and in Postman's array form of `url.path` travelled to the platform verbatim, so `?_method=DELETE` performed a write with `--unsafe-methods` absent and exit 0; and `..` in a template reached a different endpoint, past an exclusion list that works on ids. `resources[].query` — the twin of `contexts[].query` — had no guard at all. A path template is a path: `pathTemplate` in `src/io/untrusted.ts` is the grammar, written once as ADR-0024 requires, and a resource's query lives by the two rules a context's already did.
- **The grammar for the address sits at the seam, not only on the doors.** The rule above was written into `pathTemplate` and called from the three adapters that read a document. Adversarial review of 19 August 2026 went through it twice: a backslash is a path separator to the URL parser and was one ordinary character to a guard that splits on `/`, so `reports\..\..\danger` arrived at `/danger` past an exclusion list — and `collectObservations` takes `Endpoint[]` straight from a consumer of the library, a fourth door with no adapter on it, through which `?_method=DELETE` went on the wire with `allowUnsafeMethods: false`. `isAddressablePath` is now applied in `joinUrl`, the one place an address is built. Tab, newline and carriage return are refused with the backslash: the parser removes them before reading, so `.` newline `.` is `..` by the time the request exists. Do not "normalise" any of these — modelling somebody else's parser is how the first version was wrong. See ADR-0032.
- **The run confirms authentication per account.** A canary is an endpoint an operator declares as needing credentials, and every account with a `tokenEnv` needs one that passed; without it the run exits 2 naming the accounts. The rule was per run until 19 August 2026, when one canary on one healthy account cleared a second account whose token was dead: every cell of it answered 401, the policy declared it denied everywhere, and the report said `match: true` with exit 0. `findUnauthenticated` cannot cover that case — it needs a cell the policy declares accessible, and such an account has none. See ADR-0033.
- **Scope is mandatory:** without an explicitly set host allowlist the tool refuses to work.
- **Secrets only through environment variables.** Nothing into the repository, nothing into the logs.

## Commands

```
pnpm run lint         # Biome: lint + format
pnpm run lint:fix     # autofix
pnpm run typecheck    # tsc --noEmit
pnpm run test         # vitest run
pnpm run test:watch   # vitest in watch mode
pnpm run test:coverage # the coverage gate: it runs vitest and answers for what it measured
pnpm run build        # tsc -> dist, + the executable bit on cli.js
pnpm run schema       # regenerate schema/barbican.run.schema.json (needs a build)
pnpm run deps:behind  # what is behind, and what the cooldown is holding (needs the network)
pnpm run check        # lint + typecheck + test:coverage + build. Not everything CI runs
pnpm run hooks:install # git hooks (lefthook)
```

`check` is the contributor's gate and it is four of CI's steps, not all of them.
CI additionally runs, and each of these is CI-only for a reason worth knowing
before moving one of them:

| step                                        | why it is not in `check`                                        |
| ------------------------------------------- | --------------------------------------------------------------- |
| `node polygon/verify.mjs --check-readme`     | brings the reference platform up 29 times; about two minutes      |
| `gitleaks git` over the full history         | needs the whole history, which a contributor's clone may not have |
| `osv-scanner scan source --lockfile`         | needs the network and a downloaded scanner binary                 |
| `pnpm audit --audit-level moderate`          | needs the network, and its verdict changes without the tree doing |
| `publint`, `are-the-types-wrong`             | needs the network (`pnpm dlx`), and asks about the tarball        |
| pack, install from the tarball, drive the CLI | asks about the artifact, which only `pack` produces              |
| the CLI on the declared Node floor           | needs a second Node version installed beside this one             |

**And the largest difference is not a step at all: it is how many times the four
run.** `check` runs them once, on the contributor's machine. CI runs the same
four on `ubuntu-latest` with Node 22, 24 and 26 — the maintenance LTS, the
current LTS, and the open end of what `engines` claims — and once on
`windows-latest` with Node 22. Windows is there because the gate could not run
there at all: `build` is the last step of `check` and it ended in `chmod`, which
Windows has no command for, and while every job in the file was `ubuntu-latest`
nothing would ever have said so (audit of 14 August 2026, K-7). A green `check`
on one machine is therefore evidence about one of four configurations, and this
repository has already been bitten by the difference.

The one thing on the table above a laptop can run unaided is the oracle:
`node polygon/verify.mjs`. Run it after anything that touches `src/runner/`,
`src/core/` or the report. `node tools/report-bytes.mjs` is the same run reduced
to one digest per combination, for comparing a refactor against the revision
before it — also about two minutes, also not in `check`.

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

**The rule holds from 13 August 2026**, the day the repository was translated.
Before it, 100 of the first 131 commit messages were Russian, and nothing
checked them: the guard in `tests/docs/language.test.ts` reads `git ls-files`,
which is the contents of tracked files, and history is outside it entirely.
That history stays as it is — rewriting it would break every link to a commit
and buy little — and a `commit-msg` hook now guards the next message instead.

Talking to the project owner in chat happens in Russian. This applies only to
what goes into the repository.

## Rules

- A new package only after vetting: the age of the last release, the number of maintainers, the number of transitive dependencies, provenance. Minimize aggressively; whatever Node's built-ins solve, solve with the built-ins.
- `pnpm install --frozen-lockfile`. The settings `minimumReleaseAge: 10080`, `strictDepBuilds` and `allowBuilds` must not be weakened without an ADR entry. `allowBuilds` holds `lefthook: false` rather than nothing at all — an explicit refusal, with the reasoning beside it; the effect is the same as an empty map, and describing it as empty stopped being accurate.
- An entry under `overrides` in `pnpm-workspace.yaml` carries the condition for its own removal. It is a standing decision about somebody else's dependency tree, and one nobody removes is a pin nobody notices — the same failure as an exception in `osv-scanner.toml` with no expiry.
- Every core feature comes with fixtures and tests. The core coverage thresholds (`vitest.config.ts`) are part of the CI gate, not a report to read; they must not be lowered.
- Fixtures are written by hand. A "reference" generated from the policy turns a test into a check that a function agrees with itself.
- **A decision with one home is held by a gate, and a gate is attacked before it is trusted.** `src/core/keys.ts` and `src/core/path-parameters.ts` each own a decision that used to be written out several times; `tests/invariants/one-decision-one-home.test.ts` is what keeps each of them one. Neither module hands out its raw material — the separator is not exported and no `RegExp` leaves the grammar — because a copy that cannot borrow has to write the thing out, and writing it out is what the gate reads. Do not answer the next evasion with another pattern. The gate that preceded this one was walked around by a rename and by `\x00`, and the `{name}` grammar had no gate at all; the file that replaced both was then walked around six ways more — a renamed import, a local rebinding, an object method, `new RegExp`, a zero written in another base, and a character computed rather than written — every one of them with `pnpm run check` green (ADR-0060). What is enumerated is therefore the **import**: which module may reach into an owning module and for which name, since an import survives every rename of the call. An allowance in any of its tables carries its count and its reason, and the counts are exact in both directions so that a gate which has stopped seeing fails rather than passes. Three more decisions live by the same rule since ADR-0064 — the severity ranks, the `YYYY-MM-DD` grammar and the two-layer header rule, whose lists `src/io/config/basis.ts` stopped handing out for exactly this reason — and `tests/invariants/a-table-written-twice.test.ts` is their gate. Its header names what a source scan cannot see; do not read it as more than that.
- **A gate is described by what it catches and by what it misses, and the second list is not optional.** `one-decision-one-home.test.ts` and ADR-0060 each carry a "what it cannot see" section naming the evasions that still work — the separator built by `decodeURIComponent("%00")`, a `{name}` grammar written with `indexOf` and `slice`. Three rounds of work on this repository produced the same defect: the code was right and the prose around it claimed more, in an ADR, in a README line and in the header of the test that was meant to be the record. Narrowing a sentence and deleting one are both fixes; leaving it because the code is morally what it says is not.
- **What main carries beyond the newest tag is written in README's `### Unreleased` section as it lands**, and the release renames that section to `### What changed in <version>`. The version in `package.json` moves in the release commit and not before: between releases it names the last version this tree shipped, and the Install section calls that same version "the one to install". Three releases were damaged by reconstructing the description at tag time instead — see ADR-0034; `tests/docs/release-readme.test.ts` is what holds it, and it needs `fetch-depth: 0`.
- A non-trivial decision gets a short ADR in `docs/adr/`: context, decision, alternatives, consequences.
- Conventional commits.
- The employer's MCP tools and internal sources are not used in this project. Nothing from there — no code, no configs, no endpoint names, no data structures. The list of the specific servers is in `.claude/rules/_local/`, which is not versioned: those names have no place in a public repository.

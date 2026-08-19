# Dependencies, and why each one is here

CLAUDE.md says a new package goes in only after vetting: the age of the last
release, the number of maintainers, the number of transitive dependencies,
provenance. That rule was followed and the results were written down nowhere, so
it could not be checked after the fact — which makes it a habit rather than a
rule. Found by the audit of 14 August 2026 (F-9).

This file is the record. **A package added without a row here has not been
vetted**, whatever anybody remembers.

The figures below were taken on 16 August 2026 from the npm registry. They go
stale; the point of writing them down is that the next reader can see what was
true when the decision was taken, and re-take it if it no longer is.

## Runtime — what ships in the package

| Package | Version | Last release | Maintainers | Direct deps | Why it is here |
|---|---|---|---|---|---|
| `@apidevtools/swagger-parser` | 12.1.0 | 2025-10-14 | 3 | 6 | Parsing OpenAPI. The one place where writing it ourselves is worse than a dependency: the format has a decade of edge cases. **The heaviest thing here** — six direct dependencies, and the oldest release. External `$ref` resolution is switched off at the call site, which is a security invariant with a proving test. |
| `commander` | 15.0.0 | 2026-05-29 | 2 | 0 | The CLI surface. Zero dependencies; the alternative was hand-rolling flag parsing, which is where the exit-code and usage-error defects would have multiplied. |
| `yaml` | 2.9.0 | 2026-05-11 | 1 | 0 | Configuration and specifications. Zero dependencies, and it exposes the alias-expansion limit this project relies on against billion-laughs. **One maintainer** — the risk is named rather than hidden. |
| `zod` | 4.4.3 | 2026-05-04 | 1 | 0 | Configuration validation, and the JSON Schema the editor completes from is generated from the same schema the run validates against. **One maintainer.** |

## Development — not in the tarball

| Package | Version | Last release | Maintainers | Direct deps | Why it is here |
|---|---|---|---|---|---|
| `typescript` | 7.0.2 | 2026-07-08 | 7 | 0 + 20 optional | The compiler. `tsc --noEmit` is a CI gate. Moved off 6.0.3 on 19 August 2026 — ADR-0031. The 20 are platform binaries, resolved by `os`/`cpu`, so one installs. |
| `@typescript/typescript-<os>-<arch>` | 7.0.2 | 2026-07-08 | 7 | 0 | The native compiler itself, prebuilt. Same publishers as the wrapper and published the same day. **No lifecycle scripts**, so nothing runs at install and `strictDepBuilds` has nothing to refuse. Exactly one is installed per machine: `darwin-arm64` locally, `linux-x64` in CI. |
| `vitest` | 4.1.10 | — | — | 20 | Tests. The heaviest development tree, and the source of the one transitive advisory this project has had (nanoid, through vite → postcss). |
| `@vitest/coverage-v8` | 4.1.10 | — | — | 10 | Coverage thresholds, which are a gate rather than a report. |
| `@biomejs/biome` | 2.5.7 | — | — | 0 | Lint and format in one binary, which is why it replaced two tools. |
| `lefthook` | 2.1.10 | — | — | 0 | Git hooks. Its postinstall is refused in `allowBuilds` and the same step is run explicitly instead. |
| `@types/node` | 22.20.1 | — | — | 1 | Pinned to the 22 line by `engines`. Types from a newer Node would smuggle in APIs that do not exist on 22 and the typecheck would stop reflecting reality. |

157 packages in the lockfile in total.

## What was considered and rejected

| Package | Why not |
|---|---|
| `changesets` | 40 transitive packages for a changelog on a project whose version moves by hand every few days. |
| `pdf-lib` | 57 months without a release. Recorded in `plan.md` against the phase 5 rendering decision. |

## The rules this record serves

- **Vetting before adding**, on the four figures above.
- **Minimise aggressively.** Whatever Node's built-ins solve, solve with the
  built-ins — which is why there is no HTTP client, no argument-parsing helper
  beyond commander, and no assertion library.
- **`minimumReleaseAge: 10080`** — nothing younger than seven days is installed.
  This applies to the pinned CI binaries too, by hand: see the note on
  `OSV_VERSION` in `ci.yml`.
- **`strictDepBuilds`** — an install that fails because of a lifecycle script is
  the protection firing, not an obstacle. The right reaction is to read the
  script and do the needed thing explicitly.

See [ADR-0004](adr/0004-supply-chain-hardening.md) for the reasoning behind all
of it.

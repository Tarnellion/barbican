# 0001. Stack and versions

- **Status:** accepted
- **Date:** 2026-08-11

## Context

The project starts from an external technical report that fixed the stack and the verdicts
on packages. Checking against the npm registry, some versions diverged from the report, and
some decisions needed adjusting to the actual environment.

The environment at the start: Node 22.21.0 (Node 24 is not installed), pnpm through
corepack, gitleaks 8.30.1 through Homebrew.

## Decision

The base stack: Node >=22.12.0, TypeScript 6.0.3 (`nodenext`, strict), commander 15.0.0,
vitest 4.1.10, Biome 2.5.6, pnpm 11.20.0, lefthook 2.1.10, gitleaks as a system binary.

Deviations from the report and the reasons for them:

| Item | Report | Accepted | Reason |
|---|---|---|---|
| commander | 13 | **15.0.0** | Zero dependencies in both versions; 15 is the current line and requires Node >=22.12.0, which fits inside `engines`. |
| TypeScript | not pinned | **6.0.3** | 7.0.2 is listed under `latest`, but the project's own README calls the build a preview, the public API is marked `not ready`, and it adds 20 platform packages to the trust boundary. `tsc --noEmit` is a CI gate, and a preview does not go there. |
| Build | tsup | **`tsc`** | tsup pulls in 17 direct dependencies (including `debug`, a package from the September 2025 incident). The package is ESM-only for Node, bundling is not needed; `tsc` is already installed for typecheck and gives `.js` + `.d.ts` + sourcemaps. |
| Node | 24 LTS | **22.21.0 locally** | Node 24 is not on the machine, and `engines` from the report is `>=22` anyway. CI runs a 22 + 24 matrix, so support for 24 stays checkable. |
| YAML parser | js-yaml 4 | **`yaml` 2.9.0** | The deciding factor is built-in protection against billion laughs: the `maxAliasCount` option (100 by default) stops alias expansion with an explicit error. js-yaml has no such mechanism, and a heuristic would have to be piled on top. On top of that: zero dependencies against js-yaml's `argparse`, and JSON is parsed by the same parser as a subset of YAML 1.2. |
| Throttling | p-limit + p-queue | **own implementation** | `p-queue` pulls in three packages (itself, `eventemitter3`, `p-timeout`) and has a single maintainer. Concurrency, a sliding rate window and a ceiling per run are about seventy lines, and an injectable time source is needed for the backoff tests anyway. An own implementation made it possible to check the invariants against facts: the tests measure the real peak concurrency and the pauses requested, instead of trusting a library's settings. |
| zod, pino, fast-redact, picocolors | install | **deferred** | Installed in the session where they are actually needed, and vetted before installation. |

Additionally accepted: `@types/node` 22.20.1 — the types for the Node API, without which
typecheck does not pass. The package is types only, with no runtime code.

Versions are pinned exactly, without ranges (`savePrefix: ''`, `save-exact=true`).

## Alternatives

- **Follow the report literally** (commander 13, tsup): predictable, but it knowingly drags
  in 17 extra transitive dependencies for the sake of bundling the project does not need.
- **TypeScript 7.0.2:** faster on large codebases, but preview status and `API: not ready`
  do not suit a mandatory CI gate at the start of a project.
- **tsdown:** the successor to tsup on Rolldown; come back to the question if a bundle or
  CJS is needed.

## Consequences

The trust boundary at the start is 6 direct dependencies instead of the ones the report
planned. The build is simpler: one tool instead of two, `tsc` has been verified to keep the
shebang in `dist/cli.js`, and the executable bit is set by a separate step.

Revisit if: CJS or bundling is needed (bring back tsup/tsdown); TypeScript 7 leaves preview
and stabilizes its API (migrate); commander stops being zero-dependency (look for a
replacement).

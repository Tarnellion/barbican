# 0031. TypeScript 7, and half a condition set aside on purpose

- **Status:** accepted
- **Date:** 2026-08-19

## Context

ADR-0001 pinned TypeScript 6.0.3 and named the condition for revisiting: 7.x
leaves preview and stabilizes its public API. The same condition is written in
two more places — the threshold table in `plan.md`, and `.github/dependabot.yml`,
which blocks `>=7.0.0` with the comment "Lift the block once 7.x leaves preview".

Three copies of one condition, and nothing checked it. The quarterly review of
18 August 2026 found it had fired, and found the review itself had been claiming
the nearest threshold was April 2027.

## Measurement

Against 7.0.2, published 8 July 2026 — 42 days old, past this project's own
`minimumReleaseAge` of seven.

**It builds this repository unchanged.** No edit to `tsconfig.json`,
`tsconfig.build.json` or any source file. `tsc --noEmit` is clean;
`tsconfig.build.json` emits the same 26 JavaScript files, byte for byte, with one
exception: `core/types.d.ts`, where 7.0.2 keeps the per-element doc comments on
`RESOURCE_RELATIONS` that 6.0.3 dropped. A gain for whoever reads the
declarations.

**Type checking takes 0.2–0.3 s against 2.3–2.4 s.** The whole gate —
lint, typecheck, coverage, build — passes, and the reference polygon reports 29
combinations and 0 mismatches under the new output.

**Preview.** The shipped package's README says "For the latest stable version:
`npm install -D typescript`". No preview warning and no "API: not ready", which
is what ADR-0001 recorded on 11 August. That half of the condition is met, and it
is met by reading the artifact rather than by inferring it: `dist-tags.latest`
proves nothing here, because ADR-0001 shows 7.0.2 was already on `latest` while
still carrying the warning.

**The public API is a different matter, and this is the half being set aside.**
The programmatic surface is exported under `./unstable/sync`, `./unstable/async`,
`./unstable/ast` and so on — Microsoft saying in the export map that it is not
stable yet. Read strictly, the second half of ADR-0001's condition is **not**
met.

It is set aside because it does not describe this repository. Nothing here
imports `typescript`: `tsc` is invoked from the command line in exactly two
scripts, `typecheck` and `build`, and `grep -rn 'from "typescript"' src tools
tests` finds nothing. The API that is unstable is one this project does not
touch. Should that ever change — a codemod, a custom transform, anything reaching
for the compiler as a library — this decision has to be re-taken, and the
`unstable/` prefix is the thing to look at.

## Decision

Move to TypeScript 7.0.2, exact, and lift the dependabot block.

## Alternatives

- **Wait for the public API to stabilize.** Rejected: it would mean waiting on a
  guarantee about something this project does not use, while a CI gate stays ten
  times slower than it needs to be. The condition was written before it was known
  which half would matter here.
- **Wait for 7.1 or a later patch.** Rejected as a rule with no content: there is
  no criterion in it, only a delay, and a delay nobody has attached a condition to
  is how the pins this project keeps finding come about.

## Consequences

**Twenty platform packages enter the lockfile, one installs.** TypeScript 7 is
the native compiler and ships as `@typescript/typescript-<os>-<arch>`, resolved
by `os`/`cpu`, so a machine gets exactly one — `darwin-arm64` here, `linux-x64`
on CI, both present in the lockfile. ADR-0001 already named this as a cost, so it
is not a discovery; what is new is the check. Vetted and recorded in
`docs/dependencies.md`: published the same day as the wrapper, the same seven
Microsoft maintainer accounts, **zero dependencies**, and — the point that
matters most — **no lifecycle scripts**, so `strictDepBuilds` has nothing to
refuse and nothing runs at install time. The binary is fetched as a prebuilt
artifact rather than compiled locally.

**Provenance is unchanged, which is to say absent.** Neither 6.0.3 nor 7.0.2
carries npm attestations. This is not a regression, and it is worth writing down
so that the next reader does not have to check: the trust here rests on the
registry account and the pinned lockfile, as it did before.

**The package is smaller and the tree is wider.** 2.4 MB against 23.2 MB
unpacked for the wrapper, plus one platform binary. The trust boundary gains
publishers it did not have — the same organisation, more artifacts.

**The revisit condition is replaced, not deleted.** `plan.md` now carries: move
off 7.x if this project ever imports the compiler as a library while the API is
still under `unstable/`, or if a platform this project supports stops getting a
binary. A row with no condition is a pin nobody removes.

**`@types/node` stays on the 22 line.** It is a separate pin with a separate
reason — `engines` says `>=22.12.0`, and types from Node 26 would describe APIs
that do not exist there. The dependabot block on `>=23.0.0` stays.

## Addendum of 19 August 2026: the migration was claimed a commit before it happened

The commit that carries this ADR moved `package.json` to 7.0.2. The **next**
commit — a documentation change, staged with `git add -A` — moved it back to
6.0.3 along with the lockfile, and nothing said so. Six documents went on
claiming the migration while the installed compiler was 6.0.3, which means every
figure above had been measured against whatever happened to be in `node_modules`
at the time rather than against a pinned toolchain.

The mechanism was not established. `pnpm run check`, the reference polygon's
verification and `pnpm install --frozen-lockfile` were each tried afterwards and
none of them reverts anything. That is precisely why the answer is a check and
not a resolution to be more careful: a revert that leaves the tree
self-consistent and only the documents wrong survives a full gate, a pre-commit
hook and a reading of the diff — all three of which it did survive.

`tests/tools/pinned-versions.test.ts` now compares what `package.json` pins, what
the lockfile importer resolved, and what is installed, for **every** direct
dependency rather than for the compiler alone: the defect had nothing to do with
TypeScript, and a guard written for one package does not fire for the next. The
compiler additionally has to report its own version when asked, because a stale
binary and a `package.json` can agree while `tsc` runs something else.

The figures above were re-measured under a toolchain the check now holds in
place: `tsc --version` reports 7.0.2, 934 tests pass, the reference polygon
reports 29 combinations and 0 mismatches.

# 0056. The entry point is only a command line

- **Status:** accepted
- **Date:** 2026-08-22

## Context

`src/cli.ts` had grown to 1872 lines and did nine unrelated things: it declared
the option grammar of three subcommands, orchestrated a run from the
configuration file to the exit code, previewed a run without sending anything,
decided the wording and the colour of every sentence an operator reads, wrote the
report through a staging file, read a previous walk off disk and opened the next
one, confirmed authentication at both ends of the walk, handled SIGINT and
SIGTERM, and translated a commander error into an exit code.

It is also the package's `bin`. It carries the shebang, the executable bit
`tools/executable-bit.mjs` sets, and a top-level `parseAsync` — which is what
makes `await import("../src/cli.js")` a way to run the command, the mechanism
`tests/cli.test.ts` is built on. Whatever happened to the file, those three had to
survive intact.

The file is excluded from the coverage thresholds in `vitest.config.ts` on the
grounds that it is "argument parsing and printing, checked by running the built
binary". For most of its 1872 lines that description had stopped being true.

## Decision

**`src/cli.ts` keeps the command line and nothing that happens after it**, and
the work moves into `src/cli/`. The entry point is now 153 lines: the three
subcommand declarations, the translation of a commander error into `EX_USAGE`,
the `exitOverride` wiring and the parse.

The seams are by subject, not by size:

| module                | what it is                                                              |
| --------------------- | ----------------------------------------------------------------------- |
| `src/cli/screen.ts`   | everything the operator reads, and the colour it is said in              |
| `src/cli/run.ts`      | one run, from the declaration to the exit code — the sequence and its reasons |
| `src/cli/canaries.ts` | authentication, confirmed at both ends of the walk                       |
| `src/cli/preview.ts`  | `--dry-run`: what a run would do, told before the first request exists    |
| `src/cli/files.ts`    | the paths a command line names, read and written                         |
| `src/cli/stream.ts`   | the walk on disk: the one a run continues, and the one it leaves behind   |
| `src/cli/flags.ts`    | what a run's flags are, and what a numeric one may say                    |
| `src/cli/compare.ts`  | the `diff` subcommand                                                     |
| `src/cli/version.ts`  | what this build says it is                                                |

Three of those cuts are the point of the exercise and the rest follow from them.

**`screen.ts` exists because every defect its comments recount is the same
defect.** `WARNINGS` was written out a second time in the CLI and the two copies
drifted; `findingsCapped` reached the report and no screen at all; `info` was a
severity the report counted and the screen never named; a green headline cleared
a run that had proved nothing. Each was a disagreement between two places that
had to say the same thing. The colour tables, the severity order, the skip
reasons, the headline and the finished run's summary are now one file, so the
next such change is an edit rather than an agreement.

**`canaries.ts` exists because the two passes are one claim made twice.** They sat
two hundred lines apart in `run()` and had already drifted: the first pass told a
run's own ceiling, a platform that never answered and a refusal apart, and the
second told only two of the three — so a deployment that fell over after the walk
was reported as a stale token (V-6, 21 August). The shared argument bundle is
`CanaryPass`, and the filter that drops the rows under conditions — written out
at both call sites before — is applied once inside the module.

**`stream.ts` exists because the resume gate and the stream it opens are one
decision seen from either end**: what a stream has to prove before its cells may
be counted as this run's, and what this run writes so the next process can prove
the same thing about it. ADR-0047 in one file instead of two halves of a long
function.

`run.ts` is 663 lines and stays one module. Nearly every comment in it is about a
line's **position** — validation before the first request, the report path before
the traffic is spent, the canaries before the preview claims to have checked
everything, the second canary pass after the walk. Cut further, those reasons
would be spread over files that cannot enforce them.

### What was not allowed to change, and did not

- **The bytes.** Three polygon runs (clean; four isolation defects on; the two
  write defects with `--unsafe-methods`), their reports, their stderr summaries
  and their exit codes; four `--dry-run` variants; six refusals; all four help
  screens; `schema`; `--version`; and `diff --json` with its screen and code — 34
  captured artifacts, compared byte for byte with the run identifier, the
  timestamps, the per-run digest salt and the response `date` folded. Identical.
  `node polygon/verify.mjs --check-readme`: 29 combinations, 0 mismatches.
- **The public surface.** `git diff src/index.ts` is empty, `docs/library.md` is
  untouched and `tests/public-surface.test.ts` passes unchanged. `src/cli.ts`
  exported nothing before and exports nothing now, so there was no barrel to
  write: no import anywhere in the repository names it, and the two tests that
  drive the CLI import it for its top-level effect.
- **The artifact.** `dist/cli.js` is still the `bin`, still starts with the
  shebang, still comes out `0755`, and still runs both as `node dist/cli.js` and
  as `./dist/cli.js`. The new modules compile to `dist/cli/`, which coexists with
  `dist/cli.js` on every filesystem this ships to.
- **The coverage gate.** `vitest.config.ts` lists the measured directories by
  name and `src/cli` is not among them, so the split neither adds coverage nor
  removes any: the numbers are the same 2683/2721 statements before and after.

  > **Note, 23 August 2026.** True as arithmetic and misleading as a
  > conclusion, and this is the sentence that let it stand: the nine modules
  > were unmeasured before the split because they were one file carrying an
  > exemption written about argument parsing, and unmeasured after it because
  > the list named no path under `src/cli/`. Among them were the run
  > orchestration, the second canary pass and the gate on `--resume`, none of
  > which is argument parsing. ADR-0057 added a path for its own split a day
  > later, with a comment three lines below this gap calling the alternative
  > "the gate being lowered by a move, not by a decision". Closed by
  > [ADR-0063](0063-the-coverage-gate-measures-what-shipped.md), which also
  > replaces the list with a pattern so that the next split cannot repeat it.

### commander, checked rather than remembered

Two things about commander 15 were verified against its documentation and its
source rather than from memory:

- The documented way to put a subcommand in a module of its own is a factory
  returning a `Command`, added with `.addCommand()`. **Not taken**, because
  `.command()` calls `copyInheritedSettings`, `.addCommand()` does not, and
  `_exitCallback` is one of the eleven settings copied. The subcommands here are
  created before `program.exitOverride()` runs, so nothing is copied either way
  and the explicit loop over `program.commands` is what sets it — but the
  distinction is fragile enough that moving the declarations was not worth it.
  The comment on that loop said commander "does not pass the callback down to
  subcommands"; it is now stated as what it is, a matter of ordering.
- `exitOverride`, `InvalidArgumentError`, `CommanderError.exitCode` and the
  `.command().description().option().action()` chain are all current form in 15.
  Nothing this file uses is deprecated.

## Alternatives

**Leaving the summary in `run()`.** It is the largest single block moved and it
needs eleven values from the run's own locals, which is a wide seam. Taken
anyway: the argument the file's own comments make over and over is that
everything the operator reads has to be in one place, and a summary left behind
would have been the only sentence in the tool not covered by that rule.

**A module per subcommand, with the option grammar inside it.** It reads well for
`run`, and it scatters the answer to "what flags does this tool take" across four
files. The entry point is the surface an operator and a pipeline touch, and every
flag being on one page is worth more than the locality.

**Splitting `run()` by phase** — parse, resume, canaries, walk, report. Rejected:
the phases share a dozen locals, so the seams would be parameter lists rather
than subjects, and the reasons the phases are in that order would end up in
whichever file happened to hold the boundary.

**`src/cli/` under another name**, to avoid a file and a directory sharing a stem.
`dist/cli.js` and `dist/cli/` coexist without trouble, and the name is what makes
the existing coverage exclusion continue to mean what it meant.

## Consequences

**One test moved with the code.** `tests/one-walk.test.ts` asserts on the text of
the entry point — that the run asks `describeMatrix` for the verdicts and the
discrepancies in one call, and never calls `describeCells` or `diffAccess`. It
read `src/cli.ts`. It now reads `src/cli.ts` and every file in `src/cli/`, off the
directory rather than by name, so the next move of this code cannot leave the
guard pointing at a file where the call no longer is.

**`tests/public-surface.test.ts` scans `src/` recursively for
`export class …Error` and skips exactly one path, `cli.ts`.** None of the new
modules declares an error class, which is why it passes untouched. A future error
class under `src/cli/` would be required to appear on the library's public
surface, which is not what that guard means to say. Left as it is rather than
widened in the same change that made it reachable: the guard is what proves the
surface did not move here.

**The redundant `config.exclude === undefined` guards are still redundant.**
`RunConfig.exclude` is `readonly string[]`, required, never absent — so the
`...(config.exclude === undefined ? {} : { exclude: config.exclude })` spreads
read as defensive code against a case the type forbids. Copied across unchanged;
`CanaryPass.exclude` is declared the way `RunConfig` declares it.

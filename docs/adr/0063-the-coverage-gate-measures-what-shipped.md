# 0063. The coverage gate measures what shipped

- **Status:** accepted
- **Date:** 2026-08-23

## Context

`vitest.config.ts` named five directories and carried one exemption:

```
// cli.ts is not included: it is argument parsing and printing, checked by
// running the built binary rather than by unit tests.
```

That sentence was true of a file that no longer exists in the shape it describes.
ADR-0056 cut `src/cli.ts` into `src/cli/`, and the `include` list gained no path
under it. Nine modules — 2 090 lines — were measured by nothing for four days:

| module        | what it is                                                        |
| ------------- | ----------------------------------------------------------------- |
| `run.ts`      | the order every step of a run happens in                            |
| `canaries.ts` | the second canary pass, which is ADR-0033's other half              |
| `stream.ts`   | the gate on `--resume`, which is ADR-0047's                         |
| `screen.ts`   | everything the operator reads, and the headline that clears a run   |
| `preview.ts`  | `--dry-run`: what a run would cost, said before the first request   |
| `files.ts`    | the report's 0600, its atomic rename, and the paths checked early   |
| `compare.ts`  | the whole `diff` subcommand                                        |
| `flags.ts`    | the grammar of `--rps`, which exists so there is no no-limits mode  |
| `version.ts`  | what the build says it is, on the wire and in the report            |

None of them is argument parsing. `compare.ts` was executed by no test in this
process at all — its only exercise was `polygon/verify.mjs`, a CI job of its own.

**This is the second time a split moved code out of a gate's sight, and the first
time it was not noticed.** ADR-0057 cut `src/runner.ts` into a directory a day
later and added `src/runner/**/*.ts` to the same list, with a comment three lines
below the `cli` gap saying why:

> Naming only `src/runner.ts` after ADR-0057 would measure a file of re-exports
> and leave the walk, the address seam and the canaries unmeasured — which is the
> gate being lowered by a move, not by a decision.

The sentence was written above the very list that had already lost nine modules.

And the state was not even unnoticed. ADR-0056 records it, under "what was not
allowed to change, and did not":

> `vitest.config.ts` lists the measured directories by name and `src/cli` is not
> among them, so the split neither adds coverage nor removes any: the numbers are
> the same 2683/2721 statements before and after.

True as arithmetic. What it does not ask is whether the reason the file was out
still applied to the nine files it had become — and it did not, which is the
whole of this. Being right about the class of mistake, in a comment, next to an
instance of it, is what this ADR treats as the finding: the guard cannot be a
sentence.

## Decision

**The gate measures every `.ts` file under `src/`, and a test holds the two lists
to each other.**

### `include` is one pattern

```
include: ["src/**/*.ts"],
```

A list of directories is a record of what somebody remembered; a pattern cannot
be outlived by a move. Everything the package ships is now measured, `src/cli.ts`
and `src/index.ts` included — both of which were outside it before, the barrel
silently and the entry point by an exemption.

### `tests/invariants/coverage-gate.test.ts` holds the other half

`include` alone is not the gate: a file measured against no threshold appears in
the report, contributes to no number anyone checks, and can fall to zero without
failing a build. The test reads both lists out of `vitest.config.ts` and asserts
four things:

1. the configuration is readable and the tree is not empty — a guard that reads
   nothing passes everything;
2. every source file is matched by `include`;
3. every source file is matched by at least one threshold key;
4. every threshold key matches at least one file — vitest checks an empty set of
   files against its numbers and finds no fault with it, which is how a
   re-pointed threshold becomes decoration.

It implements two glob shapes — a literal path, and a directory followed by the
recursive `.ts` pattern — and **throws** on a third rather than approximating it.
Reaching for picomatch, which is what vitest matches with, would make an
unfamiliar pattern quietly match nothing, and quietly matching nothing is the
defect one level up.

### The thresholds say what is true, module by module

Nothing already in the file was lowered. What is new:

| key                  | statements | branches | functions | lines | achieved                  |
| -------------------- | ---------: | -------: | --------: | ----: | ------------------------- |
| `src/index.ts`       |         95 |       90 |        95 |    95 | 100 / 100 / 100 / 100     |
| `src/cli.ts`         |         89 |       50 |        95 |    89 | 89.28 / 50 / 100 / 89.28  |
| `src/cli/**/*.ts`    |         94 |       85 |        92 |    94 | 94.60 / 88.64 / 93.90 / 94.63 |
| `src/cli/run.ts`     |         84 |       84 |        70 |    85 | 84.95 / 84.81 / 70.58 / 85.45 |

Eight of the nine modules behind the entry point are at **100 %** of their
statements, functions and lines. The two figures below the project's 95/90/95/95
are each one thing, named rather than averaged away:

- **`src/cli/run.ts`** is the signal path and nothing else. `onSignal`,
  `endBySignal` and the two promises inside it are 5 of the module's 17 functions
  and 15 of its 113 statements, and they are the whole of the gap. A process
  killed by a signal has no exit code to read from inside itself, and
  `endBySignal` restores the default disposition and re-raises — inside a vitest
  worker that ends the worker, not the test. The path is held from outside by
  `tests/invariants/cli-surface.test.ts`, which spawns the built binary for
  exactly this reason. The module has a threshold of its own so that a drop
  inside it cannot hide behind the eight files at 100 % it would otherwise be
  averaged with.
- **`src/cli.ts`** executes every one of its functions and five of its ten
  branches. The other five cannot be reached without breaking the code around
  them: three are `error instanceof Error ? … : String(error)`, and two are the
  escape hatch under `parseAsync` for something that is not a `CommanderError`,
  which both action handlers already catch. A branch figure of 50 on a
  ten-branch file is what honesty costs here; the alternative was to leave the
  file out, which is how this started.

The branch figure for `src/cli/**` is 85 for the same reason in bulk: this layer
is where the `?? fallback` for a value the type system cannot rule out lives — a
skip reason with no wording, a filesystem error that is not an `Error`, a
`Record` lookup that the compiler cannot prove total. Thirty-one branches in the
layer are unreached: nineteen outside `run.ts`, and every one of those nineteen
is of that shape; twelve inside it, of which four are the signal path and the
other eight the same defensive shape again. Taking any of them needs something
the code above it already rules out — a schema that stopped applying a default, a
filesystem error that is not an `Error`.

### The tests that were owed

95 tests in `tests/cli/`, one file per module, written against what each module
decides rather than against the screen it prints. Eight mutations were made to
confirm they hold, each restored from a byte copy and each run through a harness
that refuses to run the suite when the replacement does not apply the intended
number of times — confirmed against a deliberately wrong needle, which was
refused before anything ran:

| mutation                                                              | result   |
| --------------------------------------------------------------------- | -------- |
| the resume gate stops refusing a stream written by another build       | 5 red    |
| a platform that stopped answering is reported as a stale token (V-6)   | 1 red    |
| the stream is removed although the report never reached disk           | 1 red    |
| the preview counts the canaries once instead of at both ends           | 2 red    |
| a mistyped flag leaves with commander's own code again (C-3/H-5)       | 2 red    |
| the truncation block stops offering the stream to the next run         | 4 red    |
| the coverage-gate test stops reading the thresholds                    | 1 red    |
| the report's second `chmod` after the rename is removed                | survived |

The survivor is recorded under Consequences: it is a redundant line, not a
missing test.

## Alternatives

**Add `src/cli/**/*.ts` to the list and stop there.** The literal instruction, and
it fixes this instance while leaving the mechanism that produced it. Four splits
landed in three days (ADR-0054 through ADR-0057); the fifth will not be
accompanied by a reminder either.

**Keep the exemption for the printing modules and gate the rest.** The original
argument — argument parsing and printing are checked by running the binary — is
real, and `screen.ts` and `preview.ts` are the two files it would still cover.
Rejected on measurement: both reached 100 % of their statements without a spawned
process, and `screen.ts` holds the headline that once printed "No privilege
escalation found" in green over twelve cross-tenant leaks. A module whose defects
are all of the form "the report says one thing and the screen another" is not a
module to exempt from the check that the screen was executed.

**One threshold over `src/cli/**` and no line for `run.ts`.** Simpler, and it
passes: the eight files at 100 % carry the average. That is the property being
refused — a threshold whose numbers can be met while the module they were written
about falls to half.

**Raise `run.ts` by testing the signal path in-process.** There is a way: install
a `SIGINT` handler in the test so the re-raised signal is caught rather than
fatal. Rejected — the signal is delivered to the whole process, vitest listens
for `SIGINT` itself to stop a run, and a test that ends the suite when it
regresses is worse than an uncovered line. `cli-surface.test.ts` spawns a
process, which is the correct shape for this and already exists.

**Lower a threshold somewhere to make the totals tidy.** Not considered. The
project's own rule is that these numbers are a gate and not a report.

## Consequences

**The overall figures move because the denominator did**, not because anything
regressed. Before: 2 684/2 722 statements over 51 files. After: 3 009/3 065
statements, 2 138/2 265 branches, 617/626 functions, 2 931/2 985 lines over 61
files. 108 test files, 1 628 passing, 1 skipped.

**`tests/cli/` is a directory now**, alongside the two entry-point suites that
already existed and stay where they are: `tests/cli.test.ts` (what the operator's
screen says, driven by importing the entry point) and
`tests/invariants/cli-surface.test.ts` (what a parent process observes, driven by
spawning the built binary).

**A defect found by a mutation, and left alone.** `writeReportFile` ends with
`chmod(path, 0o600)` after the rename, and removing it kills no test. The comment
above it explains L-10 — `mode` on an open applies to a file being *created*, so
a report written a second time into the same path kept whatever permissions it
had — and that reasoning stopped applying when the write moved to a staging file
plus a rename: the staging file is created fresh under `wx` with mode 0600 every
time, and the rename carries that inode to the destination. The line is now
belt-and-braces on a security property, unreachable by any test that does not
lie about the filesystem underneath Node. Removing it is a change to how the
report is protected and belongs to whoever wants to argue for it, not to a
coverage pass.

**Two ADRs carry a dated note rather than an edit.** ADR-0056's coverage bullet
above, because a reader meets it as "the gate is unaffected"; and ADR-0055's
closing pointer at "`parse.ts` at 660 lines, nineteen of its error classes",
which sends a reader to a file that contains the string `Error` not once — that
split distributed the classes to the five modules that throw them. Neither
decision is rewritten. A pointer that now misdirects is a different thing from a
decision that was wrong.

**The guard's glob vocabulary is deliberately small.** A pattern shape it does
not know fails the suite with a message naming the pattern. That is a nuisance
exactly once per new shape, and the alternative is the failure mode this whole
ADR is about.

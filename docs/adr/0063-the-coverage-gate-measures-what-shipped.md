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
under it. Nine modules — 2 090 lines — were measured by nothing for **three
hours**: the split is commit `339fd42`, 23 August 2026 at 10:45, and the commit
that put them back under measurement is `c1dc60d`, the same day at 13:45. By the
two ADRs' own dates it is one day, ADR-0056 being dated the 22nd and this the
23rd — and ADR-0056's date is itself a day ahead of its commit. The first
version of this section said four days, and the amendment of 23 August 2026 is
where that was found; nothing in the repository supports the number. Three hours
is the honest one, and it is enough: what matters is that the state was reached
by omission and left by accident, not how long it lasted.

The nine:

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
time it was not noticed.** ADR-0057 cut `src/runner.ts` into a directory
forty-two minutes later — `8e12a1e` at 11:27 against `339fd42` at 10:45 — and
added `src/runner/**/*.ts` to the same list, with a comment three lines below the
`cli` gap saying why:

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

### A guard that answers for the whole configuration, and for the run

`include` alone is not the gate: a file measured against no threshold appears in
the report, contributes to no number anyone checks, and can fall to zero without
failing a build. The first version of `tests/invariants/coverage-gate.test.ts`
read `include` and `thresholds` out of `vitest.config.ts` and asserted four
things — that the lists were readable, that every source file was matched by
`include`, that every source file was matched by some threshold key, and that
every threshold key matched some file.

**That was a guard on two keys of a dozen, and a review of 23 August 2026 walked
around it four ways, each with the whole run exiting 0.** The four are recorded
here because the shape they share is the finding:

| walked around by                                       | what it did                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------ |
| `coverage.exclude: ["src/cli/**"]`                       | the same nine modules leave the report; three thresholds are then checked against an empty set of files and pass |
| `all: false`                                             | **nothing** — `coverage.all` was removed in vitest 4, and on the tree it was tried on (7a13899) the run measured the same 3021/3076 statements with it as without |
| `{ statements: 0, branches: 0, functions: 0, lines: 0 }` | keeps the shape the guard read and stops being a gate               |
| `"src/**/*.ts": { statements: 10, … }`                   | answers for every file at once, so "each file has some threshold" stays true while the numbers stop meaning anything |

None of them touches a number a reader would recognise as a threshold. So the
rules move into `tools/coverage-gate.mjs` and gain two halves the first version
did not have.

**The option names are an allowlist.** Only `provider`, `include`, `reporter`
and `thresholds` may appear; `exclude`, `all`, `excludeAfterRemap`,
`reportsDirectory`, `clean` and whatever vitest adds next fail by name, with a
message asking what the new option does to the set of measured files. This is
the ADR-0005 addendum argument in another place: the names that will ever take a
file out of measurement cannot be enumerated, and the ones that are needed can.
Vitest 4's own option list was read for this (`coverage.all` and
`coverage.extensions` are gone; `excludeAfterRemap`, `thresholds.autoUpdate`,
`thresholds.perFile` and `thresholds['100']` are the ones that change what a
threshold means), and every one of them is refused by being absent from four
names rather than present in a list of forbidden ones.

**Every group declares all four metrics, and none of them is under the floor
without a reason.** Vitest does not let a per-glob group inherit the global
figures, so a group that names only `lines` leaves three metrics ungated — that
is refused. The project floor, 95/90/95/95, lives in `tools/coverage-gate.mjs`
and not in the file it holds up; a number below it must be named in `ALLOWANCES`
at exactly that value with a reason beside it, and the table is exact in both
directions.

**And the run is answered for after it happens.** The outcome half reads
`coverage/coverage-summary.json` and asks what no reading of a configuration can:
is every file the package ships in it, is anything in it that the package does
not ship, and are the four totals above the floor. That half is what makes the
exclusion caught rather than argued about — it does not care which option removed
the file, and it holds the floor even with every threshold in the configuration
deleted. It runs outside the suite because the summary is written after the last
test finishes. This paragraph said it was the third of three commands joined by
`&&` in `test:coverage`; the amendment below is about what that arrangement cost.

The glob vocabulary is still two shapes — a literal path, and a directory
followed by the recursive pattern — and still **throws** on a third rather
than approximating it. Reaching for picomatch, which is what vitest matches
with, would make an unfamiliar pattern quietly match nothing, and quietly
matching nothing is the defect one level up.

### Two of the thresholds were measuring nothing

`src/index.ts` and `src/runner.ts` are re-export barrels. They carry **no
statements at all**, and v8 reports 100 % of zero — so the two lines that gated
them passed for the same reason an empty set of files passes, which is the exact
defect the fourth assertion above was written against, one level down. The
earlier version of this table recorded `src/index.ts` as "achieved
100/100/100/100"; it was 0/0.

Both lines are removed. The two files are named in `BARRELS` instead, a list the
outcome half requires to be **precisely** the set of entries the summary reports
with zero statements — so the day either of them carries code, it is a file
answered for by no threshold and both halves say so. What `src/index.ts` actually
promises is held by `tests/public-surface.test.ts`, which counts the exported
names.

### The next split is asked for in advance

`thresholds` still names two literal files, and `src/cli/run.ts` is one of them.
Cut it into `src/cli/run/` — barrel plus `main.ts`, which is what the four splits
of that morning did to four other files — and the threshold measures the barrel
at 100 % while the signal path it was written about drifts into the
`src/cli/**/*.ts` aggregate. The first version of this guard passed 4/4 on that
tree. So: a threshold naming a literal file that has a directory of the same name
beside it must be joined by a threshold naming the directory. That is the shape
`src/runner.ts` already had, turned from a comment into a check.

### The thresholds say what is true, module by module

Nothing already in the file was lowered.

| key                  | statements | branches | functions | lines | achieved                        |
| -------------------- | ---------: | -------: | --------: | ----: | ------------------------------- |
| `src/cli.ts`         |         89 |       50 |        95 |    89 | 89.28 / 50 / 100 / 89.28        |
| `src/cli/**/*.ts`    |         94 |       85 |        92 |    94 | 94.65 / 90.26 / 93.83 / 94.70   |
| `src/cli/run.ts`     |         84 |       84 |        70 |    85 | 84.95 / 87.01 / 70.58 / 85.45   |

Eight of the nine modules behind the entry point are at **100 %** of their
statements, functions and lines. The two figures below the project's 95/90/95/95
are each one thing, named rather than averaged away:

- **`src/cli/run.ts`** is the signal path and one line that is not. `onSignal`,
  `endBySignal` and the three callbacks inside it are 5 of the module's 17
  functions, 16 of its 17 uncovered statements and 5 of its 10 unreached
  branches. A process killed by a signal has no exit code to read from inside
  itself, and `endBySignal` restores the default disposition and re-raises —
  inside a vitest worker that ends the worker, not the test. The path is held
  from outside by `tests/invariants/cli-surface.test.ts`, which spawns the built
  binary for exactly this reason. The seventeenth uncovered statement is the
  `return []` in the `catch` around `check.coverage?.(context)`, and it has
  nothing to do with signals: the registry is built inside `run` itself
  (ADR-0003 — "a registry assembled for a particular run"), so no test can put a
  check into it whose `coverage` throws. The earlier version of this paragraph
  said "15 of its 113 statements, and they are the whole of the gap"; both
  halves were wrong. The module has a threshold of its own so that a drop inside
  it cannot hide behind the eight files at 100 % it would otherwise be averaged
  with.
- **`src/cli.ts`** executes every one of its functions and five of its ten
  branches. The other five cannot be reached without breaking the code around
  them: **two** are the `: String(error)` arm of
  `error instanceof Error ? … : String(error)` in the two action handlers, and
  **three** are the escape hatch under `parseAsync` for something that is not a
  `CommanderError` — its `else`, and both arms of the same conditional inside it,
  which is unreached because the whole block is. The earlier version of this
  paragraph had the two numbers the other way round. A branch figure of 50 on a
  ten-branch file is what honesty costs here; the alternative was to leave the
  file out, which is how this started.

The branch figure for `src/cli/**` is 85 for the same reason in bulk: this layer
is where the `?? fallback` for a value the type system cannot rule out lives — a
skip reason the core added and this layer has no wording for, a filesystem error
that is not an `Error`, a `Record` lookup the compiler cannot prove total.
Twenty-six branches in the layer are unreached: sixteen outside `run.ts` and ten
inside it. The earlier version of this sentence divided the ten into "five the
signal path and five that same defensive shape", and it put three files in the
wrong column. Counted from `coverage-final.json` rather than from a reading of
the source, the ten are **five, three and two**:

| in `src/cli/run.ts`                                        | branches | what it is                                            |
| ----------------------------------------------------------- | -------: | ------------------------------------------------------ |
| `onSignal` (line 400), the gate at line 639, `endBySignal`'s `128 + (signalNumbers.signals[signal] ?? 0)` (line 678) |        5 | the signal path                                        |
| `...(config.exclude === undefined ? {} : {…})` at 271, and the same shape at 439 and 574 |        3 | input cases no test declares                            |
| `check.coverage?.(context) ?? []` at 511, and `cause instanceof Error ? … : String(cause)` at 597 |        2 | the defensive shape                                    |

The three in the middle row are the shape the paragraph below separates from the
defensive one — a spread that is present or absent according to what the
configuration said, not a fallback for something that cannot happen. Calling
them defensive was the same error, made twice in the same passage, and the
review of 23 August 2026 found it.

**Of the sixteen outside `run.ts`, fourteen are of that shape and two are not.**
The two are input cases no test declares rather than fallbacks nothing can
reach: the `exclude` arm of the plan `--dry-run` builds, and the "no skips at
all" arm of the summary line in `screen.ts`. The earlier version of this
paragraph said "every one of those nineteen is of that shape", and it was
counting a larger number for a worse reason — **at least five of the branches it
described as defensive fallbacks were dead code**, unreachable not because the
code above ruled them out but because nothing could ever take them:

| deleted                                        | why it could not be reached                                     |
| ---------------------------------------------- | ---------------------------------------------------------------- |
| `tenant.baseUrl ?? ""` in `preview.ts`          | the `.filter` two lines above had already excluded `undefined`    |
| `tenant.baseUrl ?? ""` in `run.ts`              | the same five lines, copied                                       |
| `account.canary ?? ""` in `canaries.ts`         | the same shape again, in the canary list                          |
| `cost.get(endpoint.id) ?? 1` in `preview.ts`    | the map is built from the very list being looked up in            |
| `streamPath ?? "the stream"` in `run.ts`        | the stream exists only when the path does                         |

Each was there because `.filter` does not narrow a type and `Map.get` returns
`T | undefined`, and each read to a reviewer as a policy — about tenants with no
base address, about endpoints the cost model does not know, about a stream with
no file. There are no such things. The filters now narrow, the cost map is
filled as it is asked, and the message that names the stream is written where
the compiler can see the path is there. That is five fewer branches and five
fewer sentences that were not true.

### The tests that were owed

95 tests in nine files under `tests/cli/`, written against what each module
decides rather than against the screen it prints. **Nine files and nine modules,
but not one file per module**: there is no `version.test.ts` — `src/cli/version.ts`
is two statements, and it is covered because `src/cli.ts` and `src/cli/run.ts`
both import it — and the ninth file is `entry.test.ts`, which is about
`src/cli.ts`, the module that did not move. The earlier version of this paragraph
said "one file per module", which was a description of the intention.

Nine mutations were made to confirm the tests hold, each restored from a byte
copy and each run through a harness that refuses to run the suite when the
replacement does not apply the intended number of times — confirmed against a
deliberately wrong needle, which was refused before anything ran:

| mutation                                                              | result   |
| --------------------------------------------------------------------- | -------- |
| the resume gate stops refusing a stream written by another build       | 5 red    |
| a platform that stopped answering is reported as a stale token (V-6)   | 1 red    |
| the stream is removed although the report never reached disk           | 1 red    |
| the preview counts the canaries once instead of at both ends           | 2 red    |
| a mistyped flag leaves with commander's own code again (C-3/H-5)       | 2 red    |
| the truncation block stops offering the stream to the next run         | 4 red    |
| the coverage-gate test stops reading the thresholds                    | 1 red    |
| `### Unreleased` is moved back between `0.4.0` and `0.5.0`             | 1 red    |
| the report's second `chmod` after the rename is removed                | survived |

The table had eight rows and the sentence above it said eight; nine were applied,
and the README ordering one was the row that was left out. Its absence is the
same class of thing as everything else in this amendment: a count written beside
a list, agreeing with nothing.

The survivor is recorded under Consequences: it is a redundant line, not a
missing test.

### The mutations of the amendment

The four ways around the first guard, re-attempted against the second, plus what
the second guard added. Eleven in all, through the same harness and the same
refusal on a deliberately wrong needle, which was refused before anything ran:

| mutation                                                                | result   |
| ------------------------------------------------------------------------ | -------- |
| `coverage.exclude: ["src/cli/**"]`                                        | 2 red    |
| `all: false`                                                              | 2 red    |
| `src/cli/**/*.ts` zeroed                                                  | 1 red    |
| a blanket `src/**/*.ts` at 10                                             | 2 red    |
| three metrics dropped from `src/core/**/*.ts`                             | 1 red    |
| the outcome half unwired from `test:coverage`                             | 1 red    |
| `src/index.ts` removed from `BARRELS`                                     | 4 red    |
| an exclusion given on the **command line**, where the configuration half cannot see it | 9 files named by the outcome half |
| `src/cli/run/main.ts` created beside `src/cli/run.ts`                     | 1 red    |
| `### Unreleased` moved to the end of the document, under `## License`     | 1 red    |
| `Object.fromEntries` in `report-bytes.mjs` put back to `out[key] = …`     | 1 red    |

The eighth is the one worth reading, and it is the only one that is not a file
edit. `pnpm exec vitest run --coverage --coverage.exclude='src/cli/**'` exits 0
with the whole suite green, because the configuration half imports
`vitest.config.ts` and a command-line flag is not in it — and then the outcome
half named all nine modules. That is the argument for having two halves, and it
is also the honest boundary of the first: **what it reads is the file, not the
resolved configuration**, so a `--coverage.*` flag or a `VITEST_*` environment
variable is outside it.

### The gate runs the run, so there is no second command to delete

A fourth review, on the tree the amendment above was committed from, found the
two halves held together by a **script string**:

```
"test:coverage": "node tools/coverage-gate.mjs --clean && vitest run --coverage && node tools/coverage-gate.mjs"
```

and the case that kept them together asking that string for two substrings —
`tools/coverage-gate.mjs` and `--clean`. **The first of the three commands
satisfies both.** Delete `&& node tools/coverage-gate.mjs` and all 25 tests of
`tests/invariants/coverage-gate.test.ts` stay green, `pnpm run check` exits 0,
and the half that reads what the run measured never runs again. This is the same
defect as the one this ADR was written about, one level up: a guard that reads a
description has to answer for everything the description can express, and
`toContain` answers for a substring.

Reading the string better is available — split it on `&&`, refuse the other
separators, and require the exact sequence — and it is done, because it fails
with a clear message. But it is still a reading of a description. The seam that
is not:

**`pnpm run test:coverage` is `node tools/coverage-gate.mjs`, one command, and
that module starts vitest.** It clears the previous summary, spawns
`process.execPath` with vitest's own entry point and `--coverage`, hands on any
extra arguments, propagates the exit code, and then — only if vitest succeeded,
because vitest writes no coverage report for a failing run — reads the summary
and answers for it. There is no second command to lose.

**And vitest loads the same module as a `globalSetup`, which refuses a coverage
run the gate did not start.** The module puts a fresh uuid in
`BARBICAN_COVERAGE_GATE` for the child; `setup` looks for it and, when the run
is measuring coverage and the variable is absent, throws before the first test.
That is the wiring checked as an **effect**: not what the script says, but
whether this very process is one whose summary will be read. A test asserting a
script string cannot tell those apart.

Two arrangements were tried and rejected, both by measurement rather than by
argument:

- **The outcome half as a `globalSetup` teardown.** A teardown does run after the
  summary is written — measured on vitest 4.1.10, `existsSync` says true and the
  mtime is this run's. But a throw there prints `error during close` and **the
  process exits 0**. A gate that fails by exiting 0 is the thing this file exists
  about.
- **An artifact for this run, checked by a test.** The obvious shape — the gate
  writes a receipt, a test asserts the receipt belongs to this run — cannot work
  from inside the run: the receipt is written after the last test. The variants
  that do work are cross-run (a pending marker the *next* run refuses to start
  over), and they fail on a fresh checkout, where CI lives, and they turn an
  interrupted run into a broken tree. Being inside the run is the only same-run
  answer, and that is what `setup` is.

The cost is that `pnpm exec vitest run --coverage` by hand is refused, with a
message saying to use `pnpm run test:coverage`. That is the intended reading:
there is no ungated coverage run. `pnpm run test` is untouched — it measures
nothing and needs no gate.

### What the package ships is what the compiler compiles

`shippedSources` took `endsWith(".ts")` and `coverage.include` says
`src/**/*.ts`, and **neither of those reads `.mts` or `.cts`**: the last three
characters of `leak.mts` are `mts`, and picomatch wants the dot in `*.ts` as
literally as `endsWith` does. TypeScript compiles both extensions, so this is a
file a person adds without doing anything unusual.

Demonstrated rather than reasoned about. `src/core/leak.mts` with an uncovered
branch, imported for its side effect from `src/core/keys.ts`:
`pnpm exec tsc -p tsconfig.build.json --listFiles` puts it in the program,
`pnpm run build` emits `dist/core/leak.mjs`, `files` ships `dist` — and
`pnpm run test:coverage` exited **0** with the same `3025/3080` statements as the
run before it and the words "every module the package ships was measured".

So the extensions are a list, `MEASURED_EXTENSIONS`, and anything else under
`src/` is **refused by name** rather than skipped — the allowlist argument again,
one directory down. Names beginning with a dot are the one exception and not a
guessed one: `tsc --listFilesOnly` does not put `src/.hidden.ts` in the program
either, which was checked.

The list is an approximation of a definition that already exists, and the
definition is asked directly: `tests/invariants/coverage-gate.test.ts` runs
`tsc -p tsconfig.build.json --listFilesOnly` — a tenth of a second — and holds
its output under `src/`, declaration files removed, to exactly what
`shippedSources` returns. That is the binding that makes this more than a better
guess: the compiler sees the file an `include` pattern misses but an import pulls
in, which is precisely how `leak.mts` shipped.

The patterns are not widened to cover the new extensions. There is no `.mts` or
`.cts` under `src/` today, and the day there is, the gate names it twice — no
`include` matches it, no threshold gates it — and somebody writes the two lines.
That is the decision being taken rather than a module joining the package
unmeasured.

### A global threshold is a gate, and this guard said it was not

The message refusing a non-object at the top level of `thresholds` said:

> A global threshold applies only to files no glob matched, and every file here
> is matched by one, so it would gate nothing.

**That is false.** Vitest 4's documentation: "Unlike Jest, Vitest counts all
files, including those covered by glob-patterns, into the global coverage
thresholds." Its `resolveThresholds` builds the global map with the comment
"Global threshold is for all files, even if they are included by glob patterns".
Measured on vitest 4.1.10 with a tree where one glob matches every file:
`ERROR: Coverage for statements (66.66%) does not meet global threshold
(99.999%)`.

The sentence was protecting the refusal of a global, and the refusal was right
for the wrong reason — which meant the next person to check would have deleted
both. So the guard treats a global as what it is:

- **held to `PROJECT_FLOOR`**, with the same `ALLOWANCES` mechanism as any group,
  keyed by `(global)`. A global below the floor is a written claim about the
  whole package weaker than the one this project makes;
- **not permitted to answer for a file.** This is the dilution. A global is the
  single overall figure the per-directory groups exist to refuse — a fully
  covered core masking a drop in another layer — and if it counted towards
  "every file is gated by something", the five groups could be deleted under it
  with the question still answering yes. The final loop reads the glob keys and
  nothing else;
- and everything at that level that is neither a metric name nor a readable
  pattern — `autoUpdate`, `perFile`, `100` — is still refused by name, now with a
  reason that is true.

A global would also duplicate what the outcome half already does: the four
totals are held to the floor from outside the configuration. Nothing is added to
`vitest.config.ts`; what changed is what the guard would allow and what it says.

### The mutations of the second amendment

The three holes above, plus the ways round the first guard re-attempted against
the second. Eleven applied, each through a harness that counts the needle before
it edits anything and refuses when the count is not the intended one — shown
first on a deliberately wrong needle, which was refused before anything ran —
and each restored from a byte copy whose digest is compared after the run.

| mutation                                                            | result                                    |
| --------------------------------------------------------------------- | ------------------------------------------- |
| a deliberately wrong needle                                            | refused: 0 applications, not 1; nothing run |
| `test:coverage` changed to `vitest run --coverage`                     | 1 red                                       |
| the same, run through the script itself                                | exit 1 before the first test, from `setup`  |
| `globalSetup` deleted from `vitest.config.ts`                          | 1 red                                       |
| both of those in one edit                                              | 2 red                                       |
| `src/core/leak.mts` imported by `src/core/keys.ts`                     | 3 red                                       |
| `MEASURED_EXTENSIONS` put back to `[".ts"]`                            | 2 red                                       |
| a global threshold of 10 on all four metrics                           | 1 red, naming all four                      |
| `src/core/**/*.ts` replaced by a global at the floor                   | 2 red, 18 faults — every non-barrel file under `src/core/` |
| `coverage.exclude: ["src/cli/**"]`                                     | 3 red                                       |
| a blanket `src/**/*.ts` at 10                                          | 2 red                                       |

## Alternatives

**Add `src/cli/**/*.ts` to the list and stop there.** The literal instruction, and
it fixes this instance while leaving the mechanism that produced it. The four
splits ADR-0054 through ADR-0057 describe landed **within forty-seven minutes of
each other**, all four on 23 August 2026 — `7531bff` at 10:41, `339fd42` at
10:45, `b75afa8` at 10:47, `8e12a1e` at 11:27 — and the fifth will not be
accompanied by a reminder either. The first version of this paragraph said
"three days", which is the span of the four ADRs' dates only if one of them is
misread: they are dated 23, 23, 22 and 23 August, and the 22nd is ADR-0056's date
running a day ahead of its own commit.

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
regressed. Before the gate was widened: 2 684/2 722 statements over 51 files.

This paragraph then said "3 009/3 065 statements … over 61 files. 108 test files,
1 628 passing, 1 skipped", and **`src/` held 62 `.ts` files at the commit that
carried the sentence** — `git ls-tree -r 038f470 -- src` counts them. The 108 is
right. The rest was taken from a run somewhere before the last commit of that
pass and never re-counted, which is the same shape of defect as everything else
this amendment corrects, one turn of the wheel later.

On the tree that amendment was committed from: 3 025/3 080 statements,
2 121/2 241 branches, 631/640 functions, 2 945/2 998 lines over 65 files;
115 test files, 1 733 passing, 1 skipped.

**The second amendment changes no number under `src/`** and it says so having
re-measured rather than having reasoned: nothing it touches is a source file.
On the tree it is committed from, the same 3 025/3 080 statements,
2 121/2 241 branches, 631/640 functions and 2 945/2 998 lines over 65 files —
and 118 test files, 1 790 passing, 1 skipped, the fifteen new cases being the
wiring, the extensions and the global threshold.

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

**Two guards of the same family were corrected in the same pass**, because the
review that found the four ways round this one found them too. Neither is a
decision of its own and neither gets an ADR; the reasoning lives in the file
that does the work.

- `tests/docs/release-readme.test.ts` read the **relative** order of the
  changelog headings and not their place in the document, so moving
  `### Unreleased` below `## License` passed all seven of its cases and a
  release would have renamed a heading underneath the licence. It now asks for
  membership: the changelog headings must be an unbroken run in the document's
  own sequence, with `### Unreleased` last of it. `headingsOf` in
  `tests/docs/markdown.ts` is what reads them, and it cuts fenced blocks out
  first — this README carries `# the tag must match package.json's version`
  inside the snippet under "Releasing".
- `tools/report-bytes.mjs` had no test at all, and its whole guarantee is one
  pure function and a **denylist**. The denylist stays — the inverse list is the
  report schema in full, which already exists once as
  `tests/report/report-shape.json` — but its silent direction is closed: every
  entry carries its reason, the table is held exact in both directions, and the
  manifest now carries a census of how many values each name masked, so a name
  added later changes the manifest even when every digest agrees.
  `tests/tools/report-bytes.test.ts` also caught the tool doing to itself what
  it exists to have caught in the report: `out[key] = …` on an object literal
  walks into the `__proto__` setter, so a set of request conditions called
  `__proto__` disappeared from the normalised document.

## What this does not hold

The gate is stronger and it is not closed. What a reader should not conclude
from it:

1. **The configuration half reads the file, not the resolved configuration.** It
   imports `vitest.config.ts` and asks about that object. A `--coverage.exclude`
   on the command line, a `VITEST_*` environment variable, or a different file
   passed with `--config` never reaches it. That is not hypothetical: it is
   mutation five in the table above, and the outcome half is what caught it.
2. **The outcome half checks presence and the four project totals, not
   per-group numbers.** A per-group threshold lowered from the command line
   (`--coverage.thresholds…`) is refused by neither half as long as the totals
   stay above 95/90/95/95.
3. **Nothing here makes the gate unlowerable.** The floor and the allowances
   live in `tools/coverage-gate.mjs`, and someone who edits both that and
   `vitest.config.ts` has lowered it. What changed is that it takes two files
   and a written reason instead of one line, and that the reason has to be
   exactly as specific as the number.
4. **There is no per-file floor.** Thresholds are per group; a single file can
   fall a long way inside a directory that stays above its number. `src/cli.ts`
   and `src/cli/run.ts` have lines of their own for that reason and no other
   file does — which is a judgement about where the risk is, not a guarantee.
   Branch coverage in particular is gated only per group, because per-file
   branch percentages on small files are dominated by single two-branch
   expressions: `src/core/path-parameters.ts` reads 50 % on one unreached arm.
5. **Coverage is a floor on execution and not on assertion.** A module at 100 %
   is a module every line of which ran during the suite. Nothing here says a
   test looked at what it did. The mutation tables are the only evidence in this
   ADR that goes further, and they cover the cases somebody thought of.
6. **The two halves are not independent observers of the same run.** Vitest
   writes no coverage report when a test fails (`reportOnFailure` is false by
   default), so the outcome half is only ever asked about a run the first half
   agreed with: on a red run the gate returns vitest's exit code and reads
   nothing. That is the right answer — the failure a reader needs is the test's,
   not a missing summary — and it is also the boundary.
7. **`all: false` was never a bypass.** It is refused because the reason it is
   harmless is a fact about vitest 4 and not about the option's name. If a
   future version reintroduces something like it, this guard refuses it until
   somebody adds it to `KNOWN_COVERAGE_OPTIONS` — and that somebody is who the
   guard depends on.
8. **`setup` asks about the environment, and an environment can be arranged.**
   `BARBICAN_COVERAGE_GATE=1` exported in a shell profile satisfies it, and so
   would a wrapper that sets it. This is a guard against the edit somebody makes
   in passing — a script rewritten, a step in CI simplified — and not against
   somebody who has decided to run coverage without the gate. Making it more
   than that would mean the child proving something about its parent, which on a
   machine where the parent is arbitrary is not a thing a test can do.
9. **The seam is in `vitest.config.ts`, and that file can be edited too.**
   Deleting the `globalSetup` line is refused by a test that reads the file —
   which is limit 1 again, in another place: `--config` pointing somewhere else,
   or a `VITEST_*` variable, is outside every one of these. What has changed is
   the number of edits it takes and how loudly each one fails, not that the door
   has no hinges.
10. **"What the package ships" is bound to one build.** The compiler is asked
    about `tsconfig.build.json`, which is the build `pnpm run build` runs and the
    tarball carries. A second build, a bundler, or an entry added to `files`
    would each make it a different question, and nothing here would notice.
    Declaration files are excluded by name because they emit nothing; that is a
    fact about TypeScript today, checked nowhere. And the two lists can disagree
    in the harmless direction as well as the dangerous one: an **orphan** `.mts`,
    which the walk lists and the compiler does not compile because no `include`
    pattern matches it and nothing imports it, fails this case too. The failure
    says so, and the answer is to import the file or delete it — an unreferenced
    module under `src/` is not something to leave lying there either way.
11. **The script is still read as text, in addition.** `commandsOf` splits on
    `&&` and refuses the separators it cannot reason about, which is a better
    reading than `toContain` and is still a reading. What backs it is the effect
    — and the effect covers coverage runs only. A CI step quietly changed from
    `pnpm run test:coverage` to `pnpm run test` takes coverage off the machine
    that runs Windows and three versions of node, and what catches that is an
    assertion that reads `ci.yml`: a file read, with a file read's limits.

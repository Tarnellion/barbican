import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // The coverage gate, on the one seam a `package.json` script cannot be
    // edited around: `setup` refuses a run that is measuring coverage and was
    // not started by `tools/coverage-gate.mjs`. Without it, `test:coverage`
    // could go back to calling vitest directly and the half of the gate that
    // reads the summary would simply stop running — which is what happened to
    // the three-command version of that script, with all of its tests green.
    // Deleting this line is refused by `tests/invariants/coverage-gate.test.ts`.
    // See ADR-0063.
    globalSetup: ["./tools/coverage-gate.mjs"],
    coverage: {
      provider: "v8",
      // Everything the package ships, as one pattern rather than a list of the
      // directories somebody remembered.
      //
      // The list stood here as five entries and an exemption — "cli.ts is not
      // included: it is argument parsing and printing, checked by running the
      // built binary" — which was true of one file and was inherited by nine
      // when ADR-0056 split that file into `src/cli/`. Among the nine were the
      // run orchestration, the second canary pass and the gate on `--resume`.
      // Nobody decided that: the exemption outlived the file it was written
      // about. The comment on the runner split below says what this is — "the
      // gate being lowered by a move, not by a decision" — and it happened to
      // `cli` anyway, three lines above the sentence warning about it.
      //
      // A pattern cannot be outlived by a move.
      //
      // What this file can still be edited to do, and what stops it, is in
      // `tools/coverage-gate.mjs`: the option names below are an allowlist, the
      // numbers below that answer to a floor kept outside this file, and the
      // summary the run leaves behind is read the moment vitest exits, by the
      // same module that started it. See ADR-0063.
      //
      // One pattern and not one for every extension: `*.ts` reads `.ts` and
      // nothing else — `leak.mts` ends in `mts`, and picomatch wants the dot as
      // literally as `endsWith` does. There is no `.mts` or `.cts` under `src/`,
      // and the day there is, the gate says so and asks for a pattern here and a
      // threshold below, which is the decision being taken rather than a module
      // joining the package unmeasured.
      include: ["src/**/*.ts"],
      reporter: ["text", "json-summary"],
      // The thresholds are set per directory on purpose: a single overall
      // threshold would let a fully covered core mask a drop in the other layers.
      //
      // Every group declares all four metrics. Vitest does not let a group
      // inherit the global figures — a group that names only `lines` leaves the
      // other three ungated — so an omitted metric is a hole, and the guard
      // fails on one.
      thresholds: {
        "src/core/**/*.ts": { statements: 95, branches: 90, functions: 95, lines: 95 },
        // Adapters have a lower function threshold: some of them wrap the system
        // clock and are deliberately substituted in tests.
        "src/adapters/**/*.ts": { statements: 95, branches: 90, functions: 90, lines: 95 },
        "src/io/**/*.ts": { statements: 95, branches: 90, functions: 95, lines: 95 },
        "src/report/**/*.ts": { statements: 95, branches: 90, functions: 95, lines: 95 },
        // The six modules behind `src/runner.ts`. Naming the barrel instead
        // after ADR-0057 would measure a file of re-exports and leave the walk,
        // the address seam and the canaries unmeasured — which is the gate being
        // lowered by a move, not by a decision.
        //
        // The barrel itself carries no threshold, and neither does `src/index.ts`.
        // Both had one until 23 August 2026 and both were decoration: a file of
        // re-exports has no statements, and v8 reports 100 % of nothing. They are
        // named in `BARRELS` in `tools/coverage-gate.mjs` instead, which requires
        // that list to be exactly the set of files the run measures as empty — so
        // the day either of them carries code, it needs a threshold again and
        // says so. What `src/index.ts` actually promises is held by
        // `tests/public-surface.test.ts`, which counts the exported names.
        "src/runner/**/*.ts": { statements: 95, branches: 90, functions: 95, lines: 95 },
        // The entry point: the flag declarations, the exit-code contract and the
        // three subcommands. Every function of it is executed, and the numbers
        // are low because the file is small and five of its ten branches cannot
        // be reached without breaking the code around them: two are the
        // `: String(error)` arm of `error instanceof Error ? … : String(error)`
        // in the two action handlers, and three are the escape hatch under
        // `parseAsync` — its `else`, and both arms of the same conditional
        // inside it — for something that is not a `CommanderError`, which both
        // action handlers already catch. The exemption this file used to carry —
        // "checked by running the built binary" — is true of exactly two
        // invariants, a missing `exitOverride` and a signal, and
        // `tests/invariants/cli-surface.test.ts` spawns the binary for them. Two
        // invariants were never a licence for the file, still less for the nine
        // modules that inherited it. See ADR-0063.
        "src/cli.ts": { statements: 89, branches: 50, functions: 95, lines: 89 },
        // The nine modules behind it, taken together. Lower than the rest of the
        // project by one module's worth: eight of the nine are at 100 % of their
        // statements, functions and lines, and `src/cli/run.ts` below is what
        // the difference is made of. The branch figure is lower again because
        // this is the layer where the `?? fallback` for a value the type system
        // cannot rule out lives — a skip reason the core added and this layer has
        // no wording for, a filesystem error that is not an `Error`. Sixteen of
        // the layer's twenty-six unreached branches sit outside `run.ts`, and
        // fourteen of those sixteen are of that shape; the other two are input
        // cases no test declares rather than fallbacks nothing can reach. The
        // ones that were neither — a `?? ""` after a filter that had already
        // excluded `undefined`, twice, and a `?? 1` on a lookup in a map built
        // from the very list being looked up in — were deleted rather than
        // described, on 23 August 2026. See ADR-0063.
        "src/cli/**/*.ts": { statements: 94, branches: 85, functions: 92, lines: 94 },
        // Named on its own so that a drop inside it cannot hide behind the eight
        // files at 100 % it is averaged with. Almost the whole of the gap between
        // this line and the project's 95/90/95/95 is the signal path — `onSignal`,
        // `endBySignal` and the three callbacks inside it: 5 of 17 functions, 16
        // of the 17 uncovered statements and 5 of the 10 unreached branches. A
        // process killed by a signal has no exit code to read from inside itself,
        // and re-raising one in a vitest worker takes the worker with it, so that
        // path is held from outside, by `tests/invariants/cli-surface.test.ts`.
        // The seventeenth uncovered statement is the `return []` in the `catch`
        // around `check.coverage?.(context)`: the registry is built inside `run`,
        // so no test can register a check whose coverage throws. See ADR-0063.
        "src/cli/run.ts": { statements: 84, branches: 84, functions: 70, lines: 85 },
      },
    },
  },
});

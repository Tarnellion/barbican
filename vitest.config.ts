import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
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
      // `tests/invariants/coverage-gate.test.ts` holds the other half: that
      // every file this pattern admits is answered for by one of the thresholds
      // below. See ADR-0063.
      include: ["src/**/*.ts"],
      reporter: ["text", "json-summary"],
      // The thresholds are set per directory on purpose: a single overall
      // threshold would let a fully covered core mask a drop in the other layers.
      thresholds: {
        "src/core/**/*.ts": { statements: 95, branches: 90, functions: 95, lines: 95 },
        // Adapters have a lower function threshold: some of them wrap the system
        // clock and are deliberately substituted in tests.
        "src/adapters/**/*.ts": { statements: 95, branches: 90, functions: 90, lines: 95 },
        "src/io/**/*.ts": { statements: 95, branches: 90, functions: 95, lines: 95 },
        "src/report/**/*.ts": { statements: 95, branches: 90, functions: 95, lines: 95 },
        // The barrel and the six modules behind it. Naming only `src/runner.ts`
        // after ADR-0057 would measure a file of re-exports and leave the walk,
        // the address seam and the canaries unmeasured — which is the gate being
        // lowered by a move, not by a decision.
        "src/runner.ts": { statements: 95, branches: 90, functions: 95, lines: 95 },
        "src/runner/**/*.ts": { statements: 95, branches: 90, functions: 95, lines: 95 },
        // The library's own barrel, held by `tests/public-surface.test.ts`.
        "src/index.ts": { statements: 95, branches: 90, functions: 95, lines: 95 },
        // The entry point: the flag declarations, the exit-code contract and the
        // three subcommands. Every function of it is executed, and the numbers
        // are low because the file is small and five of its ten branches cannot
        // be reached without breaking the code around them: three are
        // `error instanceof Error ? … : String(error)`, and two are the escape
        // hatch under `parseAsync` for something that is not a `CommanderError`,
        // which both action handlers already catch. The exemption this file used
        // to carry — "checked by running the built binary" — is true of exactly
        // two invariants, a missing `exitOverride` and a signal, and
        // `tests/invariants/cli-surface.test.ts` spawns the binary for them. Two
        // invariants were never a licence for the file, still less for the nine
        // modules that inherited it. See ADR-0063.
        "src/cli.ts": { statements: 89, branches: 50, functions: 95, lines: 89 },
        // The nine modules behind it, taken together. Lower than the rest of the
        // project by one module's worth: eight of the nine are at 100 % of their
        // statements, functions and lines, and `src/cli/run.ts` below is what
        // the difference is made of. The branch figure is lower again because
        // this is the layer where the `?? fallback` for a value the type system
        // cannot rule out lives — a skip reason with no wording, a filesystem
        // error that is not an `Error` — and each of those is a branch no test
        // reaches without faking the platform underneath Node.
        "src/cli/**/*.ts": { statements: 94, branches: 85, functions: 92, lines: 94 },
        // Named on its own so that a drop inside it cannot hide behind the eight
        // files at 100 % it is averaged with. The whole of the gap between this
        // line and the project's 95/90/95/95 is the signal path — `onSignal`,
        // `endBySignal` and the two promises inside it: 5 of 17 functions and 15
        // of 113 statements. A process killed by a signal has no exit code to
        // read from inside itself, and re-raising one in a vitest worker takes
        // the worker with it, so that path is held from outside, by
        // `tests/invariants/cli-surface.test.ts`. See ADR-0063.
        "src/cli/run.ts": { statements: 84, branches: 84, functions: 70, lines: 85 },
      },
    },
  },
});

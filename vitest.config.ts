import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // cli.ts is not included: it is argument parsing and printing, checked by
      // running the built binary rather than by unit tests.
      include: [
        "src/core/**/*.ts",
        "src/adapters/**/*.ts",
        "src/io/**/*.ts",
        "src/report/**/*.ts",
        "src/runner.ts",
      ],
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
        "src/runner.ts": { statements: 95, branches: 90, functions: 95, lines: 95 },
      },
    },
  },
});

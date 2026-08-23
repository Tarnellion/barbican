/**
 * Nothing the package ships is outside the coverage gate, and nothing inside it
 * is unanswered for.
 *
 * Twice a file has left a gate's sight by being moved rather than by anyone
 * deciding it should. The first time was caught while it was happening: ADR-0057
 * cut `src/runner.ts` into a directory, and the `include` list gained a
 * recursive pattern over it with a comment calling the alternative "the gate
 * being lowered by a move, not by a decision". The second time was not: ADR-0056
 * cut `src/cli.ts` into nine modules three lines above that same comment, and
 * the `include` list named none of them. The run orchestration, the second
 * canary pass and the gate on `--resume` were measured by nothing for the three
 * hours between the split commit and this file — one day by the two ADRs' own
 * dates — under an exemption whose text, "argument parsing and printing",
 * described none of them.
 *
 * The first version of this file read `include` and `thresholds` out of
 * `vitest.config.ts` and asked whether every source file appeared in both. A
 * review of 23 August 2026 walked around it four ways with the whole run exiting
 * 0, and the four are reproduced below as cases. What they have in common is
 * that a guard reading a configuration has to answer for everything that
 * configuration can express, and `include` and `thresholds` are two keys out of
 * a dozen.
 *
 * The rules live in `tools/coverage-gate.mjs` rather than here, because half of
 * them cannot run in this process: the summary of what the run measured is
 * written after the last test finishes. That half runs from
 * `pnpm run test:coverage`, and the last case in this file is what keeps it
 * wired in. See ADR-0063.
 *
 * **What this file does not hold.** It does not stop the numbers in
 * `vitest.config.ts` from being lowered — only from being lowered quietly: a
 * group below the project floor has to be named in `ALLOWANCES` with a reason,
 * and the number in both places has to be the same. Nor does it read the
 * pattern language vitest actually uses; it knows two shapes and throws on a
 * third.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ALLOWANCES,
  BARRELS,
  configurationFaults,
  KNOWN_COVERAGE_OPTIONS,
  METRICS,
  matches,
  outcomeFaults,
  PROJECT_FLOOR,
  relativeSummary,
  SUMMARY_PATH,
  shippedSources,
} from "../../tools/coverage-gate.mjs";
import configuration from "../../vitest.config.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const coverage = configuration.test?.coverage as Record<string, unknown> | undefined;
const sources = shippedSources(ROOT);

/** A configuration shaped like the real one, with one thing changed. */
function like(change: Record<string, unknown>): Record<string, unknown> {
  return { ...(coverage ?? {}), ...change };
}

/** The thresholds of the real configuration, with one group changed or added. */
function thresholdsLike(change: Record<string, unknown>): Record<string, unknown> {
  return { ...(coverage?.["thresholds"] as Record<string, unknown>), ...change };
}

/** A summary in the shape `json-summary` writes, over the paths given. */
function summaryOf(files: Readonly<Record<string, number>>, total = 100): Record<string, unknown> {
  const figure = (pct: number, size: number) => ({
    total: size,
    covered: Math.round((pct / 100) * size),
    skipped: 0,
    pct,
  });
  const entry = (pct: number, size: number) =>
    Object.fromEntries(METRICS.map((metric) => [metric, figure(pct, size)]));
  return {
    total: entry(total, 1000),
    ...Object.fromEntries(
      Object.entries(files).map(([path, pct]) => [
        resolve(ROOT, path),
        entry(pct, pct === 100 && BARRELS.includes(path) ? 0 : 50),
      ]),
    ),
  };
}

/** Every shipped file at 100 %, which is the shape a clean run leaves. */
const everythingMeasured = (): Readonly<Record<string, number>> =>
  Object.fromEntries(sources.map((path) => [path, 100]));

describe("the configuration the coverage gate is made of", () => {
  it("is there to be read at all", () => {
    // A guard that read nothing would agree with anything.
    expect(coverage).toBeDefined();
    expect(sources.length).toBeGreaterThan(20);
    expect(Object.keys((coverage?.["thresholds"] ?? {}) as object).length).toBeGreaterThan(3);
  });

  it("has nothing wrong with it", () => {
    expect(configurationFaults(coverage, sources)).toEqual([]);
  });

  /**
   * The bypass that started this. `include` and `thresholds` stay exactly as
   * they are, `src/cli` leaves the report, and three thresholds are then
   * checked against an empty set of files and pass.
   */
  it("cannot quietly drop a directory through coverage.exclude", () => {
    const faults = configurationFaults(like({ exclude: ["src/cli/**"] }), sources);

    expect(faults.join("\n")).toContain("coverage.exclude");
  });

  /**
   * `coverage.all` was removed in vitest 4 and setting it changed no number —
   * the run measured the same 3021/3076 statements with and without it. It is
   * refused anyway, because the reason it is harmless is a fact about this
   * version of vitest and not about the option's name.
   */
  it("refuses an option name it has not reasoned about", () => {
    for (const key of ["all", "excludeAfterRemap", "reportsDirectory", "clean"]) {
      expect(configurationFaults(like({ [key]: false }), sources).join("\n")).toContain(
        `coverage.${key}`,
      );
    }
  });

  it("knows which options it has reasoned about", () => {
    // Exact in both directions: an allowlist that has drifted away from the
    // configuration it guards is the shape of the defect above.
    expect([...KNOWN_COVERAGE_OPTIONS].sort()).toEqual(Object.keys(coverage ?? {}).sort());
  });

  /** Zeroing a group keeps the shape the first version of this guard read. */
  it("cannot have a group zeroed", () => {
    const faults = configurationFaults(
      like({
        thresholds: thresholdsLike({
          "src/cli/**/*.ts": { statements: 0, branches: 0, functions: 0, lines: 0 },
        }),
      }),
      sources,
    );

    expect(faults.join("\n")).toContain("the allowance permits exactly");
  });

  /**
   * And a group that is not relaxed at all cannot be lowered below the floor by
   * any amount, allowance or no allowance.
   */
  it("cannot have a group lowered below the project floor without a reason", () => {
    const faults = configurationFaults(
      like({
        thresholds: thresholdsLike({
          "src/core/**/*.ts": { statements: 40, branches: 40, functions: 40, lines: 40 },
        }),
      }),
      sources,
    );

    expect(faults.join("\n")).toContain("below the project floor");
  });

  /**
   * A blanket threshold answers for every file at once, so "each file is
   * covered by at least one threshold" — the question the first version asked —
   * stays true while the numbers stop meaning anything.
   */
  it("cannot be answered for by a blanket threshold", () => {
    const faults = configurationFaults(
      like({
        thresholds: thresholdsLike({
          "src/**/*.ts": { statements: 10, branches: 10, functions: 10, lines: 10 },
        }),
      }),
      sources,
    );

    expect(faults.join("\n")).toContain("below the project floor");
  });

  /**
   * Vitest does not let a group inherit the global figures, so deleting three
   * keys from a group leaves three metrics ungated with the group still there
   * to be read.
   */
  it("cannot have a metric dropped out of a group", () => {
    const faults = configurationFaults(
      like({ thresholds: thresholdsLike({ "src/core/**/*.ts": { lines: 95 } }) }),
      sources,
    );

    expect(faults.join("\n")).toContain("declares no statements, branches, functions");
  });

  /** `autoUpdate` would rewrite these numbers from whatever the run achieved. */
  it("cannot be made to rewrite its own numbers", () => {
    const faults = configurationFaults(
      like({ thresholds: thresholdsLike({ autoUpdate: true }) }),
      sources,
    );

    expect(faults.join("\n")).toContain("not a group of four numbers");
  });

  /**
   * The defect of ADR-0063 happening again inside ADR-0063.
   *
   * `thresholds` still names two literal files. Cut one of them into a
   * directory — the reviewer simulated `src/cli/run.ts` becoming a barrel plus
   * `src/cli/run/main.ts` — and the threshold measures a file of re-exports at
   * 100 % while the signal path it was written about drifts into the layer
   * aggregate. The first version of this guard passed all four of its
   * assertions on that tree.
   */
  it("asks for a second line when a named file becomes a directory", () => {
    const afterASplit = [...sources, "src/cli/run/main.ts"];
    const faults = configurationFaults(coverage, afterASplit);

    expect(faults.join("\n")).toContain('there is no "src/cli/run/**/*.ts"');
  });

  it("is satisfied once the second line is there", () => {
    const afterASplit = [...sources, "src/cli/run/main.ts"];
    const faults = configurationFaults(
      like({
        thresholds: thresholdsLike({
          "src/cli/run/**/*.ts": { statements: 84, branches: 84, functions: 70, lines: 85 },
        }),
      }),
      afterASplit,
    );

    // The new group needs an allowance of its own, and that is the whole point:
    // the numbers move with the code, in a commit that says why.
    expect(faults.join("\n")).toContain("no allowance in tools/coverage-gate.mjs says why");
  });

  /** A threshold naming files that are not there measures nothing and passes. */
  it("refuses a threshold that names nothing", () => {
    const faults = configurationFaults(
      like({
        thresholds: thresholdsLike({
          "src/nowhere/**/*.ts": { statements: 95, branches: 90, functions: 95, lines: 95 },
        }),
      }),
      sources,
    );

    expect(faults.join("\n")).toContain("matches no file in the tree");
  });

  /**
   * And a threshold naming only barrels measures nothing either, which is the
   * same defect one level down: v8 reports 100 % of zero statements. Two of
   * this project's own thresholds were of that shape until 23 August 2026.
   */
  it("refuses a threshold that names only re-export barrels", () => {
    const faults = configurationFaults(
      like({
        thresholds: thresholdsLike({
          "src/index.ts": { statements: 95, branches: 90, functions: 95, lines: 95 },
        }),
      }),
      sources,
    );

    expect(faults.join("\n")).toContain("matches only re-export barrels");
  });

  it("refuses a file that no threshold answers for", () => {
    const withoutCore = Object.fromEntries(
      Object.entries(coverage?.["thresholds"] as Record<string, unknown>).filter(
        ([group]) => group !== "src/core/**/*.ts",
      ),
    );
    const faults = configurationFaults(like({ thresholds: withoutCore }), sources);

    expect(faults.join("\n")).toContain("gated by no threshold");
  });

  it("throws rather than guess at a pattern shape it does not know", () => {
    expect(() => matches("src/**/{a,b}.ts", "src/a.ts")).toThrow(/cannot read/);
  });

  /** Every allowance answers for something, and says why it is there. */
  it("carries no allowance that permits nothing", () => {
    for (const [group, allowance] of Object.entries(ALLOWANCES)) {
      expect(
        (allowance as { why: string }).why.length,
        `${group} has no reason beside it`,
      ).toBeGreaterThan(20);
    }
    expect(configurationFaults(coverage, sources).join("\n")).not.toContain("answers for no");
  });
});

describe("the run the coverage gate answers for", () => {
  it("has nothing wrong with a run that measured everything", () => {
    expect(outcomeFaults(relativeSummary(summaryOf(everythingMeasured()), ROOT), sources)).toEqual(
      [],
    );
  });

  /**
   * The half no configuration can argue with. Whatever the option was called
   * and whatever it did, a file the package ships that is not in the summary
   * was not measured.
   */
  it("names a shipped file the run did not measure", () => {
    const partial = everythingMeasured();
    const { "src/cli/run.ts": _dropped, ...rest } = partial;
    const faults = outcomeFaults(relativeSummary(summaryOf(rest), ROOT), sources);

    expect(faults.join("\n")).toContain("src/cli/run.ts is shipped and the run measured nothing");
  });

  it("names a file in the summary that the package does not ship", () => {
    const faults = outcomeFaults(
      relativeSummary(summaryOf({ ...everythingMeasured(), "tests/helpers.ts": 100 }), ROOT),
      sources,
    );

    expect(faults.join("\n")).toContain("is not a file this package ships");
  });

  /**
   * The floor, held outside `vitest.config.ts` so that it survives every
   * threshold in it being deleted.
   */
  it("refuses a run whose totals are under the project floor", () => {
    const faults = outcomeFaults(
      relativeSummary(summaryOf(everythingMeasured(), 61), ROOT),
      sources,
    );

    for (const metric of METRICS) {
      expect(faults.join("\n")).toContain(`${metric} over the whole package is 61 %`);
    }
  });

  /**
   * `BARRELS` is checked against the measurement rather than against a reading
   * of the source: a file named there that has grown statements is code now,
   * and a file with no statements that is not named there is either a barrel
   * nobody wrote down or a module the run never loaded.
   */
  it("notices a barrel that has become code", () => {
    const grown = { ...everythingMeasured() };
    const faults = outcomeFaults(
      relativeSummary(
        {
          ...summaryOf(grown),
          [resolve(ROOT, "src/index.ts")]: {
            statements: { total: 12, covered: 12, skipped: 0, pct: 100 },
            branches: { total: 0, covered: 0, skipped: 0, pct: 100 },
            functions: { total: 0, covered: 0, skipped: 0, pct: 100 },
            lines: { total: 12, covered: 12, skipped: 0, pct: 100 },
          },
        },
        ROOT,
      ),
      sources,
    );

    expect(faults.join("\n")).toContain("is named in BARRELS and has 12 statements");
  });

  it("notices code that has become a barrel", () => {
    const faults = outcomeFaults(
      relativeSummary(
        {
          ...summaryOf(everythingMeasured()),
          [resolve(ROOT, "src/cli/run.ts")]: {
            statements: { total: 0, covered: 0, skipped: 0, pct: 100 },
            branches: { total: 0, covered: 0, skipped: 0, pct: 100 },
            functions: { total: 0, covered: 0, skipped: 0, pct: 100 },
            lines: { total: 0, covered: 0, skipped: 0, pct: 100 },
          },
        },
        ROOT,
      ),
      sources,
    );

    expect(faults.join("\n")).toContain("src/cli/run.ts carries no statements at all");
  });

  /**
   * And the wiring, because the half above runs outside vitest.
   *
   * A test in the suite is deleted by whoever finds it inconvenient; a step in
   * the script that CI calls is harder to lose by accident. The same reasoning
   * as the release gate's, and the same shape of assertion.
   */
  it("is run after every coverage run", () => {
    const scripts = (
      JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
        scripts: Record<string, string>;
      }
    ).scripts;

    expect(scripts["test:coverage"]).toContain("tools/coverage-gate.mjs");
    expect(scripts["check"]).toContain("test:coverage");
    // Cleaned first: a summary left by an earlier run would otherwise answer for
    // one that never happened.
    expect(scripts["test:coverage"]).toContain("--clean");
    expect(SUMMARY_PATH).toBe("coverage/coverage-summary.json");
  });

  it("keeps a floor worth having", () => {
    // The floor is the project's own 95/90/95/95, and a guard whose floor had
    // been quietly moved to zero would pass everything above.
    expect(PROJECT_FLOOR).toEqual({ statements: 95, branches: 90, functions: 95, lines: 95 });
  });
});

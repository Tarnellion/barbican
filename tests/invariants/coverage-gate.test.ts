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
 * written after the last test finishes. That half runs the moment vitest exits,
 * from the same module that started it. See ADR-0063.
 *
 * **The wiring is checked as an effect and not as a string.** It used to be two
 * `toContain` calls against the `test:coverage` script, and both were satisfied
 * by the first of that script's three commands: deleting
 * `&& node tools/coverage-gate.mjs` left all of this green while the outcome
 * half never ran again. There is no second command now — the script is
 * `node tools/coverage-gate.mjs` and that module spawns vitest — and the
 * question "did the gate start this run" is asked by `setup` below, which vitest
 * loads as a `globalSetup` and which refuses a coverage run the gate is not the
 * parent of. A test can then ask what no reading of `package.json` can: not what
 * the script says, but whether this very process is one the gate will answer
 * for.
 *
 * **What this file does not hold.** It does not stop the numbers in
 * `vitest.config.ts` from being lowered — only from being lowered quietly: a
 * group below the project floor has to be named in `ALLOWANCES` with a reason,
 * and the number in both places has to be the same. Nor does it read the
 * pattern language vitest actually uses; it knows two shapes and throws on a
 * third.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  ALLOWANCES,
  BARRELS,
  configurationFaults,
  GATE_VARIABLE,
  KNOWN_COVERAGE_OPTIONS,
  MEASURED_EXTENSIONS,
  METRICS,
  matches,
  outcomeFaults,
  PROJECT_FLOOR,
  relativeSummary,
  SUMMARY_PATH,
  setup,
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
   * the run measured the same 3021/3076 statements with and without it, on the
   * tree it was tried on (7a13899). It is
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

    expect(faults.join("\n")).toContain(
      "coverage.thresholds.autoUpdate is neither one of the four metric names",
    );
  });

  /**
   * A global threshold, and the sentence this guard used to refuse one with.
   *
   * It said a global "applies only to files no glob matched, and every file here
   * is matched by one, so it would gate nothing". Vitest 4 says the opposite in
   * its documentation and in `resolveThresholds`, and a reviewer demonstrated it:
   * a global of 99.999 fires with every file matched by a glob. So a global is a
   * gate, and one below the floor is a lower gate.
   */
  it("holds a global threshold to the floor", () => {
    const faults = configurationFaults(
      like({ thresholds: thresholdsLike({ statements: 10 }) }),
      sources,
    );

    expect(faults.join("\n")).toContain(
      "coverage.thresholds.statements is 10, below the project floor of 95",
    );
    expect(faults.join("\n")).toContain("vitest counts every file into it");
  });

  it("has nothing against a global threshold at the floor", () => {
    const faults = configurationFaults(
      like({
        thresholds: thresholdsLike({ statements: 95, branches: 90, functions: 95, lines: 95 }),
      }),
      sources,
    );

    // Against the configuration as it stands rather than against `[]`: what is
    // under test is that a global at the floor adds nothing, not that the
    // configuration is clean — which the case above already asks.
    expect(faults).toEqual(configurationFaults(coverage, sources));
  });

  /**
   * And the reason the correction matters. A global counts every file, so it is
   * the single overall figure the per-directory groups exist to refuse — a fully
   * covered core masking a drop in another layer. If it answered for a file, the
   * five groups could be deleted under it and the question "is every file
   * gated?" would stay true.
   */
  it("does not let a global threshold answer for a file", () => {
    const faults = configurationFaults(
      like({ thresholds: { statements: 95, branches: 90, functions: 95, lines: 95 } }),
      sources,
    );

    expect(faults.join("\n")).toContain("gated by no threshold");
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

  it("keeps a floor worth having", () => {
    // The floor is the project's own 95/90/95/95, and a guard whose floor had
    // been quietly moved to zero would pass everything above.
    expect(PROJECT_FLOOR).toEqual({ statements: 95, branches: 90, functions: 95, lines: 95 });
  });
});

const SCRIPTS = (
  JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  }
).scripts;

interface Workflow {
  readonly jobs: Record<string, { readonly steps?: readonly { readonly run?: string }[] }>;
}

const CI = parseYaml(readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8")) as Workflow;

/**
 * A script as the list of commands a shell would run, refusing every join but
 * `&&`.
 *
 * The previous version of the wiring test asked the `test:coverage` string for
 * two substrings, and one command containing both satisfied it — so the third
 * command could be deleted with everything green. Reading the string as a list
 * is what "answer for what the string can express" means here: `;` runs a
 * command whether or not the one before it worked, `||` runs it only when the
 * one before failed, `&` puts it in the background, and a substitution hides a
 * command inside another. None of them appears in this project's scripts, and a
 * guard that cannot read one has to say so rather than approximate — the same
 * refusal `matches` makes about an unfamiliar glob.
 */
function commandsOf(script: string): readonly string[] {
  const commands = script.split("&&").map((one) => one.trim());
  for (const command of commands) {
    if (/[;&|`$()<>]/.test(command)) {
      throw new Error(
        `this guard cannot read the shell construct in "${script}". It knows commands joined ` +
          `by && and nothing else; teach it the shape rather than deleting the case.`,
      );
    }
  }
  return commands;
}

describe("the wiring, as an effect rather than a string", () => {
  /**
   * There is no second command to delete. `test:coverage` is the gate, and the
   * gate is what runs vitest.
   */
  it("makes the gate the whole of `test:coverage`", () => {
    expect(commandsOf(SCRIPTS["test:coverage"] ?? "")).toEqual(["node tools/coverage-gate.mjs"]);
    expect(SUMMARY_PATH).toBe("coverage/coverage-summary.json");
  });

  it("is what `check` runs", () => {
    expect(commandsOf(SCRIPTS["check"] ?? "")).toContain("pnpm run test:coverage");
  });

  /**
   * And what CI runs — which is not the same question: the `check` job calls the
   * four scripts one by one rather than `pnpm run check`, so a step there could
   * drift to calling vitest directly and take the gate off the only machine that
   * runs Windows and three versions of node.
   */
  it("is what CI runs", () => {
    const steps = (CI.jobs["check"]?.steps ?? []).map((step) => step.run?.trim() ?? "");

    expect(steps).toContain("pnpm run test:coverage");
    expect(steps.filter((one) => /\bvitest\b/.test(one))).toEqual([]);
  });

  /**
   * The seam a `package.json` edit cannot reach. `setup` is loaded by vitest
   * itself, so the question it asks is about this process and not about a file.
   */
  it("declares the gate as a globalSetup", () => {
    expect(configuration.test?.globalSetup).toEqual(["./tools/coverage-gate.mjs"]);
  });
});

describe("a coverage run the gate did not start", () => {
  const measuring = { config: { coverage: { enabled: true } } };

  /** Restored rather than left set: the suite's own run is a gated one. */
  function withoutTheVariable(work: () => void): void {
    const kept = process.env[GATE_VARIABLE];
    delete process.env[GATE_VARIABLE];
    try {
      work();
    } finally {
      if (kept !== undefined) {
        process.env[GATE_VARIABLE] = kept;
      }
    }
  }

  it("is refused before the first test", () => {
    withoutTheVariable(() => {
      expect(() => {
        setup(measuring);
      }).toThrow(/the coverage gate did not start it/);
    });
  });

  it("is allowed when the gate is the parent", () => {
    withoutTheVariable(() => {
      process.env[GATE_VARIABLE] = "a-value-the-gate-would-have-set";
      expect(() => {
        setup(measuring);
      }).not.toThrow();
    });
  });

  /** `pnpm run test` measures nothing and needs no gate. */
  it("says nothing about a run that is not measuring coverage", () => {
    withoutTheVariable(() => {
      expect(() => {
        setup({ config: { coverage: { enabled: false } } });
      }).not.toThrow();
    });
  });

  /**
   * And a shape it does not recognise is refused rather than read as "not
   * measuring". This is the seam dying quietly: a vitest that stopped saying
   * whether coverage is on would turn `setup` into a function that returns, and
   * nothing else in this file would notice.
   */
  it("refuses a project it cannot read", () => {
    withoutTheVariable(() => {
      for (const shape of [undefined, {}, { config: {} }, { config: { coverage: {} } }]) {
        expect(() => {
          setup(shape);
        }).toThrow(/not told whether the run is measuring coverage/);
      }
    });
  });
});

/**
 * The compiler's own entry point, from its manifest.
 *
 * The same three lines are in `tests/tools/pinned-versions.test.ts`, and
 * deliberately not shared: it is a `bin` lookup rather than a decision, the two
 * files ask the compiler different questions, and a typescript that moved its
 * entry point would fail both of them by name on the same run.
 */
function compilerEntry(): string {
  const installed = resolve(ROOT, "node_modules", "typescript");
  const bin = (
    JSON.parse(readFileSync(resolve(installed, "package.json"), "utf8")) as {
      bin?: { tsc?: string };
    }
  ).bin?.tsc;
  if (bin === undefined) {
    throw new Error("typescript declares no `tsc` entry under `bin`");
  }
  return resolve(installed, bin);
}

const workspace = mkdtempSync(join(tmpdir(), "barbican-coverage-gate-"));

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("what the package ships", () => {
  /**
   * `.mts` and `.cts` are files a person genuinely adds, and both halves were
   * blind to them: the walk asked `endsWith(".ts")` and the configuration says
   * `src/**\/*.ts`, and `leak.mts` ends in `mts`. A reviewer put
   * `src/core/leak.mts` in the tree with an uncovered branch and a side-effect
   * import from a shipped module; `dist/core/leak.mjs` was built and published
   * and this gate exited 0 with the denominator unchanged.
   */
  it("reads every extension the compiler emits a module for", () => {
    const tree = join(workspace, "extensions");
    mkdirSync(join(tree, "src", "core"), { recursive: true });
    for (const name of ["a.ts", "core/b.mts", "core/c.cts", "d.d.ts", ".hidden.ts"]) {
      writeFileSync(join(tree, "src", name), "");
    }

    expect(shippedSources(tree)).toEqual(["src/a.ts", "src/core/b.mts", "src/core/c.cts"]);
  });

  /** And refuses what it cannot place, rather than skipping it. */
  it("refuses a file under src it has not reasoned about", () => {
    const tree = join(workspace, "unknown");
    mkdirSync(join(tree, "src"), { recursive: true });
    writeFileSync(join(tree, "src", "a.ts"), "");
    writeFileSync(join(tree, "src", "component.tsx"), "");

    expect(() => shippedSources(tree)).toThrow(/src\/component\.tsx is under src\//);
  });

  /**
   * The binding that makes the list above more than a guess. What the package
   * ships is what `tsc` puts in the program and emits under `dist/`, and the
   * compiler is asked rather than modelled — `--listFilesOnly` is a tenth of a
   * second and it sees the files an `include` pattern misses but an import
   * pulls in, which is exactly how `leak.mts` shipped.
   *
   * `process.execPath` plus the resolved entry, so this runs on Windows;
   * `relative` and the separators are normalised on both sides for the same
   * reason.
   */
  it("agrees with the compiler about which files those are", () => {
    const listed = execFileSync(
      process.execPath,
      [compilerEntry(), "-p", "tsconfig.build.json", "--listFilesOnly"],
      { cwd: ROOT, encoding: "utf8" },
    );
    const compiled = listed
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => relative(ROOT, line).split("\\").join("/"))
      .filter((path) => path.startsWith("src/") && !/\.d\.[mc]?ts$/.test(path))
      .sort();

    expect(compiled.length).toBeGreaterThan(20);
    expect(
      [...sources],
      "the walk and the compiler disagree about what src/ ships. A file the walk lists and " +
        "the compiler does not compile is not shipped — an orphan .mts is not matched by the " +
        "`include` in tsconfig.build.json and nothing imports it, so it emits nothing. A file " +
        "the compiler compiles and the walk skips is a module measured by nobody.",
    ).toEqual(compiled);
  });

  /**
   * The tree, as it would be with such a file in it. Written as "the sources
   * without it, plus it" rather than "the sources plus it", so that the case
   * still asks its question while somebody is holding the real thing in the
   * tree to watch the gate fail.
   */
  const A_MODULE = "src/core/leak.mts";
  const withAModule = (): readonly string[] =>
    [...sources.filter((path) => path !== A_MODULE), A_MODULE].sort();

  it("names a module no include pattern covers, and no threshold", () => {
    const faults = configurationFaults(coverage, withAModule()).join("\n");

    expect(faults).toContain(`${A_MODULE} is shipped and matched by no coverage.include`);
    expect(faults).toContain(`${A_MODULE} is measured and gated by no threshold`);
  });

  it("names it in the run as well, whatever the configuration said", () => {
    const measured = Object.fromEntries(
      withAModule()
        .filter((path) => path !== A_MODULE)
        .map((path) => [path, 100]),
    );
    const faults = outcomeFaults(relativeSummary(summaryOf(measured), ROOT), withAModule());

    expect(faults.join("\n")).toContain(
      `${A_MODULE} is shipped and the run measured nothing for it`,
    );
  });

  it("can be written into the configuration once the day comes", () => {
    // Not a hole left open: the patterns are spellable, so adding such a file is
    // a decision with two lines beside it rather than a wall.
    expect(MEASURED_EXTENSIONS).toEqual([".ts", ".mts", ".cts"]);
    expect(matches("src/core/**/*.mts", "src/core/leak.mts")).toBe(true);
    expect(matches("src/core/**/*.ts", "src/core/leak.mts")).toBe(false);
    expect(matches("src/core/leak.mts", "src/core/leak.mts")).toBe(true);
  });
});

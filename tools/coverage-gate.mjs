#!/usr/bin/env node

/**
 * What the coverage gate has to measure, and whether the run measured it.
 *
 * The gate used to be `vitest.config.ts` alone, with
 * `tests/invariants/coverage-gate.test.ts` reading two of its keys — `include`
 * and `thresholds` — and asking whether every source file appeared in both. An
 * adversarial review of 23 August 2026 switched that arrangement off four ways,
 * each with `pnpm run check` exiting 0 and nothing saying anything:
 *
 * 1. `coverage.exclude: ["src/cli/**"]`, with `include` and `thresholds`
 *    untouched. Nine modules left the report; three thresholds were then checked
 *    against an empty set of files and passed.
 * 2. `all: false`. This one turned out **not** to be a bypass: `coverage.all` was
 *    removed in vitest 4, and the run produced the same 3021/3076 statements as
 *    without it. It is held here anyway, as an option name the configuration has
 *    no meaning for.
 * 3. Zeroing the numbers of a group — `{ statements: 0, branches: 0, ... }` —
 *    which keeps the shape the old guard read and stops being a gate.
 * 4. A blanket `"src/**\/*.ts": { statements: 10, ... }`, which answers for every
 *    file at once and so satisfies "each file is covered by some threshold".
 *
 * The common shape is that all four lower the gate **without touching a number a
 * reader would recognise as a threshold**. So this module holds two things a
 * configuration cannot say about itself:
 *
 * - `configurationFaults` reads the coverage options as an **allowlist**. Only
 *   the four keys this guard has reasoned about may appear; `exclude`, `all`,
 *   `excludeAfterRemap`, `reportsDirectory`, `thresholds.autoUpdate` and
 *   whatever vitest adds next all fail by name. The names that will ever remove
 *   a file from measurement cannot be enumerated — the same argument that turned
 *   the response-header denylist into an allowlist (ADR-0005 addendum).
 * - `outcomeFaults` reads `coverage/coverage-summary.json` — what the run
 *   actually measured — and answers for the files that are in it, the files that
 *   are not, and the four totals. That half runs after vitest, from
 *   `pnpm run test:coverage`, because the summary does not exist while the tests
 *   that would read it are running.
 *
 * **What this does not do.** It does not make the gate unlowerable. The numbers
 * in `vitest.config.ts` may still be lowered — but only for a group named in
 * `ALLOWANCES` below, at exactly the value written there, with a reason beside
 * it, and the table is exact in both directions. Lowering a threshold is now a
 * two-file edit that has to be written down; it was one line. See ADR-0063.
 *
 * Zero dependencies, built-in modules only. `tests/invariants/coverage-gate.test.ts`
 * holds both halves.
 */

import { readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Where the `json-summary` reporter leaves what the run measured. */
export const SUMMARY_PATH = "coverage/coverage-summary.json";

/** The four names vitest reports, in the order this project writes them. */
export const METRICS = ["statements", "branches", "functions", "lines"];

/**
 * The figures every threshold answers to.
 *
 * Not read from the configuration: a floor taken from the thing it is meant to
 * hold up is not a floor. Raising a number in `vitest.config.ts` above these
 * needs no permission; going below one does, and the permission is a line in
 * `ALLOWANCES`.
 */
export const PROJECT_FLOOR = Object.freeze({
  statements: 95,
  branches: 90,
  functions: 95,
  lines: 95,
});

/**
 * The coverage options this guard has reasoned about.
 *
 * An allowlist and not a list of forbidden names. `exclude` removes files from
 * the report; `excludeAfterRemap` removes them later; `reportsDirectory` moves
 * the file the other half of this module reads; `clean: false` would let a stale
 * summary answer for a run that never happened. Those are the ones known today,
 * and the point of the shape is the ones that are not: a coverage option added
 * by a future vitest fails here by name rather than by being absent from a list
 * nobody updated.
 *
 * Adding a name is a decision, not a formality: say in the commit what the
 * option does to the set of measured files.
 */
export const KNOWN_COVERAGE_OPTIONS = Object.freeze([
  "provider",
  "include",
  "reporter",
  "thresholds",
]);

/**
 * Group thresholds allowed to sit below `PROJECT_FLOOR`, at exactly the value
 * written here and for the reason written here.
 *
 * Exact in both directions. A group with a number below the floor and no entry
 * here fails; an entry here whose group is gone, or whose number no longer
 * matches the configuration, or whose number is not actually below the floor,
 * fails too. That is what stops a threshold from being zeroed and what stops a
 * blanket `src/**\/*.ts` from being added underneath the real ones.
 */
export const ALLOWANCES = Object.freeze({
  "src/adapters/**/*.ts": {
    functions: 90,
    why: "some adapters wrap the system clock and are deliberately substituted in tests",
  },
  "src/cli.ts": {
    statements: 89,
    branches: 50,
    lines: 89,
    why: "every function runs; five of ten branches are the `instanceof Error` arms and the escape hatch under parseAsync, which both action handlers already close",
  },
  "src/cli/**/*.ts": {
    statements: 94,
    branches: 85,
    functions: 92,
    lines: 94,
    why: "the aggregate carries src/cli/run.ts, whose signal path no in-process test can reach",
  },
  "src/cli/run.ts": {
    statements: 84,
    branches: 84,
    functions: 70,
    lines: 85,
    why: "the signal path: a process killed by a signal has no exit code to read from inside itself, and re-raising one in a vitest worker takes the worker with it",
  },
});

/**
 * The files that carry no statements at all: re-export barrels and files that
 * are only types.
 *
 * They matter because a threshold over one of them measures nothing and passes —
 * v8 reports 100 % of zero. Two thresholds did exactly that before ADR-0063 was
 * amended, and the split this table exists to catch is the next one: cut a
 * module into a directory, leave the threshold pointing at the barrel that
 * remains, and the gate reads 100 % while the code it named moved elsewhere.
 *
 * Exact in both directions, and checked against the measurement rather than
 * against a reading of the source: `outcomeFaults` requires this list to be
 * precisely the set of entries the summary reports with zero statements.
 */
export const BARRELS = Object.freeze([
  "src/adapters/ports.ts",
  "src/core/checks/types.ts",
  "src/core/index.ts",
  "src/core/standards/types.ts",
  "src/index.ts",
  "src/io/config.ts",
  "src/io/config/types.ts",
  "src/runner.ts",
]);

/**
 * The two glob shapes these lists use, and a refusal to guess at a third.
 *
 * Vitest matches with picomatch, which reads far more than this. Reimplementing
 * two cases rather than reaching for the same library is deliberate: an
 * unfamiliar third case must **fail** here, naming the pattern, rather than be
 * approximated. A guard that quietly matches nothing is the defect this whole
 * module exists about, one level up.
 *
 * @param {string} glob
 * @param {string} path
 * @returns {boolean}
 */
export function matches(glob, path) {
  const recursive = "/**/*.ts";
  if (glob.endsWith(recursive)) {
    return path.startsWith(`${glob.slice(0, -recursive.length)}/`) && path.endsWith(".ts");
  }
  if (glob.endsWith(".ts") && !glob.includes("*")) {
    return path === glob;
  }
  throw new Error(
    `the coverage configuration uses a pattern this guard cannot read: "${glob}". ` +
      `Teach it the shape, or use one of the two it knows — a literal path, or a ` +
      `directory followed by /**/*.ts. Do not delete the case: the reason this ` +
      `guard exists is that a file left the gate by omission twice.`,
  );
}

/**
 * Every `.ts` file under `src/`, as the paths the configuration is written in.
 *
 * @param {string} [root]
 * @returns {readonly string[]}
 */
export function shippedSources(root = ROOT) {
  /** @param {string} directory @returns {string[]} */
  const walk = (directory) =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        return walk(path);
      }
      return entry.name.endsWith(".ts") ? [relative(root, path).split("\\").join("/")] : [];
    });
  return walk(resolve(root, "src")).sort();
}

/**
 * The directories that exist under `src/`, as prefixes without a trailing slash.
 *
 * @param {readonly string[]} sources
 * @returns {ReadonlySet<string>}
 */
function directoriesOf(sources) {
  const found = new Set();
  for (const path of sources) {
    const parts = path.split("/");
    for (let at = 1; at < parts.length; at += 1) {
      found.add(parts.slice(0, at).join("/"));
    }
  }
  return found;
}

/**
 * @typedef {{ readonly [metric: string]: unknown }} ThresholdGroup
 */

/**
 * What is wrong with the coverage configuration, as sentences.
 *
 * Pure: the tree is passed in rather than read here, so the test can ask the
 * question of a configuration that does not exist on disk.
 *
 * @param {Record<string, unknown> | undefined} coverage the `test.coverage` object
 * @param {readonly string[]} sources what {@link shippedSources} returned
 * @returns {readonly string[]}
 */
export function configurationFaults(coverage, sources) {
  /** @type {string[]} */
  const faults = [];
  if (coverage === undefined) {
    return ["the configuration has no `test.coverage` section at all"];
  }
  if (sources.length === 0) {
    return ["no source files were found: a guard that reads nothing agrees with everything"];
  }

  for (const key of Object.keys(coverage)) {
    if (!KNOWN_COVERAGE_OPTIONS.includes(key)) {
      faults.push(
        `coverage.${key} is an option this guard has not reasoned about. Work out whether ` +
          `it can remove a file from measurement or make a threshold vacuous, say so in the ` +
          `commit, and add it to KNOWN_COVERAGE_OPTIONS in tools/coverage-gate.mjs.`,
      );
    }
  }

  if (coverage["provider"] !== "v8") {
    faults.push(
      `coverage.provider is ${JSON.stringify(coverage["provider"])}; every number in ` +
        `ALLOWANCES was measured with "v8", and another provider counts differently.`,
    );
  }

  const reporter = coverage["reporter"];
  const reporters = Array.isArray(reporter) ? reporter : [];
  if (!reporters.includes("json-summary")) {
    faults.push(
      'coverage.reporter must include "json-summary": it is the file the other half of ' +
        "this gate reads, and without it the run cannot be answered for at all.",
    );
  }

  const include = coverage["include"];
  const includes = Array.isArray(include) ? include.filter((one) => typeof one === "string") : [];
  if (includes.length === 0) {
    faults.push("coverage.include names nothing, so nothing outside a test file is measured");
  } else {
    const unmeasured = sources.filter((path) => !includes.some((glob) => matches(glob, path)));
    for (const path of unmeasured) {
      faults.push(`${path} is shipped and matched by no coverage.include pattern`);
    }
  }

  const thresholds = coverage["thresholds"];
  if (typeof thresholds !== "object" || thresholds === null) {
    faults.push("coverage.thresholds is not an object, so no group is gated");
    return faults;
  }
  faults.push(...thresholdFaults(/** @type {Record<string, unknown>} */ (thresholds), sources));
  return faults;
}

/**
 * @param {Record<string, unknown>} thresholds
 * @param {readonly string[]} sources
 * @returns {readonly string[]}
 */
function thresholdFaults(thresholds, sources) {
  /** @type {string[]} */
  const faults = [];
  const groups = Object.keys(thresholds);
  if (groups.length === 0) {
    faults.push("coverage.thresholds is empty, so nothing is gated");
    return faults;
  }

  const directories = directoriesOf(sources);
  const barrels = new Set(BARRELS);
  /** @type {Set<string>} */
  const allowancesUsed = new Set();

  for (const group of groups) {
    const numbers = thresholds[group];
    if (typeof numbers !== "object" || numbers === null) {
      faults.push(
        `coverage.thresholds.${group} is not a group of four numbers. A global threshold ` +
          `applies only to files no glob matched, and every file here is matched by one, so ` +
          `it would gate nothing. Write the numbers on the group instead.`,
      );
      continue;
    }
    const declared = /** @type {Record<string, unknown>} */ (numbers);
    const missing = METRICS.filter((metric) => typeof declared[metric] !== "number");
    if (missing.length > 0) {
      faults.push(
        `coverage.thresholds["${group}"] declares no ${missing.join(", ")}. Vitest does not ` +
          `let a group inherit the global figures, so an omitted metric is an ungated one.`,
      );
    }
    const extra = Object.keys(declared).filter((metric) => !METRICS.includes(metric));
    if (extra.length > 0) {
      faults.push(
        `coverage.thresholds["${group}"] carries ${extra.join(", ")}, which this guard has ` +
          `not reasoned about — \`autoUpdate\` rewrites these numbers from the run, and \`100\` ` +
          `and \`perFile\` change what they mean.`,
      );
    }

    const matched = sources.filter((path) => matches(group, path));
    if (matched.length === 0) {
      faults.push(
        `coverage.thresholds["${group}"] matches no file in the tree. Vitest checks an empty ` +
          `set against the numbers and finds no fault with it, which is how a re-pointed ` +
          `threshold becomes decoration.`,
      );
    } else if (matched.every((path) => barrels.has(path))) {
      faults.push(
        `coverage.thresholds["${group}"] matches only re-export barrels (${matched.join(", ")}), ` +
          `which carry no statements. It reads 100 % of nothing. Either it is left over from a ` +
          `split — the code it was written about now lives in a directory — or it should go.`,
      );
    }

    // The next split, caught before it lands: a literal file threshold beside a
    // directory of the same name is the shape `src/runner.ts` already has. Cut
    // `src/cli/run.ts` into `src/cli/run/` and this is what asks for the second
    // line, so the signal path keeps a threshold of its own instead of being
    // averaged into the layer.
    if (!group.includes("*") && group.endsWith(".ts")) {
      const asDirectory = group.slice(0, -".ts".length);
      const paired = `${asDirectory}/**/*.ts`;
      if (directories.has(asDirectory) && !groups.includes(paired)) {
        faults.push(
          `coverage.thresholds["${group}"] names a file that now has a directory beside it, ` +
            `and there is no "${paired}". After a split the file is a barrel and the code is ` +
            `in the directory: the threshold would measure re-exports while what it was ` +
            `written about drifts into an aggregate.`,
        );
      }
    }

    /** @type {Record<string, unknown> | undefined} */
    const allowed = Object.hasOwn(ALLOWANCES, group)
      ? /** @type {Record<string, Record<string, unknown>>} */ (ALLOWANCES)[group]
      : undefined;
    for (const metric of METRICS) {
      const value = declared[metric];
      if (typeof value !== "number") {
        continue;
      }
      const floor = /** @type {Record<string, number>} */ (PROJECT_FLOOR)[metric] ?? 0;
      if (value >= floor) {
        if (allowed !== undefined && typeof allowed[metric] === "number") {
          faults.push(
            `ALLOWANCES["${group}"].${metric} is ${allowed[metric]} but the configuration ` +
              `asks for ${value}, which is not below the floor of ${floor}. Remove the ` +
              `allowance: it is now permission for nothing.`,
          );
          allowancesUsed.add(`${group}.${metric}`);
        }
        continue;
      }
      if (allowed === undefined || typeof allowed[metric] !== "number") {
        faults.push(
          `coverage.thresholds["${group}"].${metric} is ${value}, below the project floor of ` +
            `${floor}, and no allowance in tools/coverage-gate.mjs says why. A threshold under ` +
            `the floor is a decision; write it down with its reason.`,
        );
        continue;
      }
      allowancesUsed.add(`${group}.${metric}`);
      if (allowed[metric] !== value) {
        faults.push(
          `coverage.thresholds["${group}"].${metric} is ${value}; the allowance permits ` +
            `exactly ${allowed[metric]}. Changing the number means changing both, which is ` +
            `the point: the reason beside the allowance has to still be true.`,
        );
      }
    }
  }

  for (const [group, allowed] of Object.entries(ALLOWANCES)) {
    if (typeof allowed.why !== "string" || allowed.why.length < 20) {
      faults.push(`ALLOWANCES["${group}"] carries no reason worth reading`);
    }
    for (const metric of METRICS) {
      if (typeof (/** @type {Record<string, unknown>} */ (allowed)[metric]) !== "number") {
        continue;
      }
      if (!allowancesUsed.has(`${group}.${metric}`)) {
        faults.push(
          `ALLOWANCES["${group}"].${metric} answers for no threshold in the configuration. ` +
            `An allowance nobody uses is a permission left lying about for the next edit.`,
        );
      }
    }
  }

  for (const path of sources) {
    if (barrels.has(path)) {
      continue;
    }
    if (!groups.some((group) => matches(group, path))) {
      faults.push(
        `${path} is measured and gated by no threshold: it appears in the report, ` +
          `contributes to no number anybody checks, and can fall to zero without failing a build`,
      );
    }
  }
  return faults;
}

/**
 * @typedef {{ readonly total: number, readonly covered: number, readonly pct: number }} Figure
 * @typedef {{ readonly [metric: string]: Figure }} Entry
 */

/**
 * The summary as repo-relative paths, with `total` taken out.
 *
 * @param {Record<string, unknown>} raw what `coverage-summary.json` parsed to
 * @param {string} [root]
 * @returns {{ total: Record<string, Figure> | undefined, files: Record<string, Entry> }}
 */
export function relativeSummary(raw, root = ROOT) {
  /** @type {Record<string, Entry>} */
  const files = {};
  /** @type {Record<string, Figure> | undefined} */
  let total;
  for (const [key, value] of Object.entries(raw)) {
    if (key === "total") {
      total = /** @type {Record<string, Figure>} */ (value);
      continue;
    }
    const path = (key.startsWith(root) ? relative(root, key) : key).split("\\").join("/");
    files[path] = /** @type {Entry} */ (value);
  }
  return { total, files };
}

/**
 * What the run failed to measure, as sentences.
 *
 * This is the half a configuration cannot argue with. Whatever the option was
 * called and whatever it did, a file the package ships that is not in the
 * summary was not measured, and the four totals are what they are.
 *
 * @param {{ total: Record<string, Figure> | undefined, files: Record<string, Entry> }} summary
 * @param {readonly string[]} sources
 * @returns {readonly string[]}
 */
export function outcomeFaults(summary, sources) {
  /** @type {string[]} */
  const faults = [];
  const measured = Object.keys(summary.files);
  if (measured.length === 0) {
    return ["the coverage summary holds no files at all"];
  }
  if (sources.length === 0) {
    return ["no source files were found: a guard that reads nothing agrees with everything"];
  }

  for (const path of sources) {
    if (!Object.hasOwn(summary.files, path)) {
      faults.push(`${path} is shipped and the run measured nothing for it`);
    }
  }
  for (const path of measured) {
    if (!sources.includes(path)) {
      faults.push(
        `${path} is in the coverage summary and is not a file this package ships. ` +
          `Anything else in the denominator moves every aggregate.`,
      );
    }
  }

  const barrels = new Set(BARRELS);
  for (const [path, entry] of Object.entries(summary.files)) {
    const statements = entry["statements"];
    if (statements === undefined) {
      faults.push(`${path} has no statement figure in the summary`);
      continue;
    }
    if (statements.total === 0 && !barrels.has(path)) {
      faults.push(
        `${path} carries no statements at all, so any threshold over it reads 100 % of ` +
          `nothing. If it is a re-export barrel, name it in BARRELS; if it is not, the run ` +
          `did not load it.`,
      );
    }
    if (statements.total > 0 && barrels.has(path)) {
      faults.push(
        `${path} is named in BARRELS and has ${statements.total} statements. It is code now, ` +
          `and code needs a threshold.`,
      );
    }
  }

  const total = summary.total;
  if (total === undefined) {
    faults.push("the coverage summary has no `total`, so the run cannot be answered for");
    return faults;
  }
  for (const metric of METRICS) {
    const figure = total[metric];
    const floor = /** @type {Record<string, number>} */ (PROJECT_FLOOR)[metric] ?? 0;
    if (figure === undefined) {
      faults.push(`the coverage summary has no total for ${metric}`);
      continue;
    }
    if (figure.pct < floor) {
      faults.push(
        `${metric} over the whole package is ${figure.pct} %, below the floor of ${floor} %. ` +
          `This figure is checked here and not in vitest.config.ts, so it holds even when ` +
          `every threshold in the configuration has been deleted.`,
      );
    }
  }
  return faults;
}

/**
 * Reads the summary the last coverage run left and answers for it.
 *
 * @param {string} [root]
 * @returns {readonly string[]}
 */
export function faultsOnDisk(root = ROOT) {
  const at = resolve(root, SUMMARY_PATH);
  /** @type {string} */
  let text;
  try {
    text = readFileSync(at, "utf8");
  } catch {
    return [
      `${SUMMARY_PATH} is not there. It is written by the json-summary reporter, so either ` +
        `the run did not happen or the reporter is gone — and a coverage gate whose evidence ` +
        `is missing has to fail rather than shrug.`,
    ];
  }
  return outcomeFaults(
    relativeSummary(/** @type {Record<string, unknown>} */ (JSON.parse(text)), root),
    shippedSources(root),
  );
}

if (isMainModule(import.meta.url)) {
  if (process.argv.includes("--clean")) {
    // So that a summary left by an earlier run cannot answer for this one.
    rmSync(resolve(ROOT, SUMMARY_PATH), { force: true });
  } else {
    const faults = faultsOnDisk();
    for (const fault of faults) {
      process.stderr.write(`  ${fault}\n`);
    }
    if (faults.length > 0) {
      process.stderr.write(
        `\nThe coverage run did not measure what this package ships (${faults.length} ` +
          `${faults.length === 1 ? "fault" : "faults"}). See ADR-0063.\n`,
      );
      process.exitCode = 1;
    } else {
      process.stdout.write("every module the package ships was measured\n");
    }
  }
}

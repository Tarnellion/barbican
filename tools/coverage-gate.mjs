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
 *    removed in vitest 4, and on the tree it was tried on (7a13899) the run
 *    produced the same 3021/3076 statements with it as without. It is held here
 *    anyway, as an option name the configuration has no meaning for.
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
 *   are not, and the four totals. That half runs after vitest, because the
 *   summary does not exist while the tests that would read it are running.
 *
 * **This module is what runs the coverage run.** `pnpm run test:coverage` is one
 * command — `node tools/coverage-gate.mjs` — and it removes the previous
 * summary, spawns vitest, and then answers for what the run measured. It was
 * three commands joined by `&&` until 23 August 2026, and the test that held
 * them together asked the script string for two substrings that a single
 * invocation satisfied: deleting `&& node tools/coverage-gate.mjs` left every
 * test green and the outcome half never ran again. A guard reading a script
 * string has to answer for everything that string can express, and the cheaper
 * answer was to stop having a second command to delete. `setup` below is the
 * other half of that: vitest loads it as a `globalSetup`, and a coverage run
 * this module did not start is **refused there**, so the wiring is checked by
 * the run itself rather than by reading `package.json`. See ADR-0063.
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

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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
 * The extensions under `src/` that `tsc` turns into a file in `dist/`.
 *
 * The walk below took `endsWith(".ts")` and the configuration says
 * `src/**\/*.ts`, and **neither of those reads `.mts` or `.cts`**: the last three
 * characters of `leak.mts` are `mts`, not `.ts`, and picomatch's `*.ts` wants the
 * dot as literally as `endsWith` does. A review of 23 August 2026 put
 * `src/core/leak.mts` in the tree with an uncovered branch and a side-effect
 * import from `src/core/keys.ts`; `pnpm run build` emitted `dist/core/leak.mjs`,
 * the package shipped it, and this file exited 0 with the same 3025/3080
 * statements as the run before and the words "every module the package ships was
 * measured".
 *
 * So the list is the extensions, not the string `.ts` — and anything else under
 * `src/` is **refused by name** rather than skipped, for the reason the option
 * allowlist above exists. What the package ships is decided by the compiler, and
 * `tests/invariants/coverage-gate.test.ts` asks it directly: `tsc
 * --listFilesOnly` against `tsconfig.build.json`, held to exactly what
 * {@link shippedSources} returns. That is the binding this list is an
 * approximation of, and the reason a wrong guess here fails rather than drifts.
 */
export const MEASURED_EXTENSIONS = Object.freeze([".ts", ".mts", ".cts"]);

/**
 * Declaration files: the compiler reads them and emits nothing, so there is
 * nothing for a coverage report to hold. None exists under `src/` today.
 */
const DECLARATION_EXTENSIONS = Object.freeze([".d.ts", ".d.mts", ".d.cts"]);

/**
 * What {@link ALLOWANCES} would name a global threshold, if one were ever
 * allowed below the floor.
 *
 * Not a glob and never passed to {@link matches}: the four metric names sit at
 * the top level of `thresholds` beside the globs, and vitest reads them as a
 * threshold over **every** file.
 */
export const GLOBAL_GROUP = "(global)";

/**
 * What this module puts in the environment of the vitest it starts.
 *
 * `setup` looks for it and refuses a coverage run without it. The value is a
 * fresh uuid rather than `"1"` so that it reads as what it is — a fact about
 * this one process tree — and not as a switch to put in a shell profile.
 */
export const GATE_VARIABLE = "BARBICAN_COVERAGE_GATE";

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
 * Two shapes over three extensions, and the extension is matched as literally as
 * picomatch matches it: `src/**\/*.ts` does **not** cover `src/leak.mts`, here or
 * in vitest. A `.mts` under `src/` therefore needs a pattern of its own in both
 * `include` and `thresholds`, which is the point — it is a decision, taken by
 * whoever adds the file, rather than a module that quietly joined the package.
 *
 * @param {string} glob
 * @param {string} path
 * @returns {boolean}
 */
export function matches(glob, path) {
  for (const extension of MEASURED_EXTENSIONS) {
    const recursive = `/**/*${extension}`;
    if (glob.endsWith(recursive)) {
      return path.startsWith(`${glob.slice(0, -recursive.length)}/`) && path.endsWith(extension);
    }
  }
  if (!glob.includes("*") && MEASURED_EXTENSIONS.some((extension) => glob.endsWith(extension))) {
    return path === glob;
  }
  throw new Error(
    `the coverage configuration uses a pattern this guard cannot read: "${glob}". ` +
      `Teach it the shape, or use one of the two it knows — a literal path, or a ` +
      `directory followed by /**/*${MEASURED_EXTENSIONS.join(", /**/*")}. Do not delete ` +
      `the case: the reason this guard exists is that a file left the gate by omission twice.`,
  );
}

/**
 * Every file under `src/` that the compiler turns into a shipped module, as the
 * paths the configuration is written in.
 *
 * Throws on anything else it finds there. A file under `src/` is either
 * something `dist/` will carry — and then the gate has to measure it — or
 * something this guard has not reasoned about, and guessing is what let
 * `leak.mts` through. Names beginning with a dot are the one exception, and it
 * was measured by hand rather than held by a case: with `src/.hidden.ts` in the
 * tree, `tsc -p tsconfig.build.json --listFilesOnly` lists 65 files under `src/`
 * and that is not one of them (23 August 2026). Nothing in the suite asks the
 * compiler that: in `tests/invariants/coverage-gate.test.ts` the dotted-name case
 * runs this walk over a temporary tree, and the case that compares the walk with
 * the compiler runs over the real one, which has no dotted file in it. See
 * ADR-0063.
 *
 * @param {string} [root]
 * @returns {readonly string[]}
 */
export function shippedSources(root = ROOT) {
  /** @param {string} directory @returns {string[]} */
  const walk = (directory) =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = resolve(directory, entry.name);
      // `.DS_Store`, an editor's swap file, a `.hidden.ts` — outside the program
      // the compiler builds, and so outside what the package ships.
      if (entry.name.startsWith(".")) {
        return [];
      }
      if (entry.isDirectory()) {
        return walk(path);
      }
      const at = relative(root, path).split("\\").join("/");
      if (DECLARATION_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
        return [];
      }
      if (MEASURED_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
        return [at];
      }
      throw new Error(
        `${at} is under src/ and this guard cannot say whether the package ships it. ` +
          `The extensions it has reasoned about are ${MEASURED_EXTENSIONS.join(", ")} — the ones ` +
          `tsc emits a module for — and ${DECLARATION_EXTENSIONS.join(", ")}, which emit nothing. ` +
          `Work out which this is, say so in the commit, and add it to MEASURED_EXTENSIONS in ` +
          `tools/coverage-gate.mjs or move the file out of src/.`,
      );
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
 * One number against {@link PROJECT_FLOOR}, and against the allowance that may
 * stand below it.
 *
 * @param {string} group the name {@link ALLOWANCES} is keyed by
 * @param {string} where how to name this number in a sentence
 * @param {string} metric
 * @param {number} value
 * @param {Set<string>} used allowances this configuration turned out to need
 * @param {string} [context] a sentence appended when the number is below the floor
 * @returns {readonly string[]}
 */
function floorFaults(group, where, metric, value, used, context = "") {
  /** @type {string[]} */
  const faults = [];
  /** @type {Record<string, unknown> | undefined} */
  const allowed = Object.hasOwn(ALLOWANCES, group)
    ? /** @type {Record<string, Record<string, unknown>>} */ (ALLOWANCES)[group]
    : undefined;
  const floor = /** @type {Record<string, number>} */ (PROJECT_FLOOR)[metric] ?? 0;
  if (value >= floor) {
    if (allowed !== undefined && typeof allowed[metric] === "number") {
      faults.push(
        `ALLOWANCES["${group}"].${metric} is ${allowed[metric]} but the configuration ` +
          `asks for ${value}, which is not below the floor of ${floor}. Remove the ` +
          `allowance: it is now permission for nothing.`,
      );
      used.add(`${group}.${metric}`);
    }
    return faults;
  }
  if (allowed === undefined || typeof allowed[metric] !== "number") {
    faults.push(
      `${where} is ${value}, below the project floor of ${floor}, and no allowance in ` +
        `tools/coverage-gate.mjs says why. A threshold under the floor is a decision; write ` +
        `it down with its reason.${context}`,
    );
    return faults;
  }
  used.add(`${group}.${metric}`);
  if (allowed[metric] !== value) {
    faults.push(
      `${where} is ${value}; the allowance permits exactly ${allowed[metric]}. Changing ` +
        `the number means changing both, which is the point: the reason beside the allowance ` +
        `has to still be true.`,
    );
  }
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
  const keys = Object.keys(thresholds);
  if (keys.length === 0) {
    faults.push("coverage.thresholds is empty, so nothing is gated");
    return faults;
  }

  const directories = directoriesOf(sources);
  const barrels = new Set(BARRELS);
  /** @type {Set<string>} */
  const allowancesUsed = new Set();

  /**
   * A key at the top level of `thresholds` is one of three things, and this
   * guard used to read it as one.
   *
   * The four metric names are a **global** threshold. Until 23 August 2026 the
   * message here said a global "applies only to files no glob matched, and every
   * file here is matched by one, so it would gate nothing", and that is not what
   * vitest does. Its own documentation says the opposite — "Unlike Jest, Vitest
   * counts all files, including those covered by glob-patterns, into the global
   * coverage thresholds" — and so does the comment in `resolveThresholds`:
   * "Global threshold is for all files, even if they are included by glob
   * patterns". Measured rather than read: with `src/**\/*.ts` at 10 and a global
   * `statements: 99.999`, vitest 4.1.10 answers `ERROR: Coverage for statements
   * (66.66%) does not meet global threshold (99.999%)`.
   *
   * So a global is a real gate, held to the floor like any other — and it is
   * **not** allowed to answer for a file. That is the dilution: a single
   * aggregate over `src/` is exactly what the per-directory groups exist to
   * prevent, a fully covered core masking a drop in another layer, and if it
   * counted towards "every file is gated by something" the five groups could be
   * deleted under it. The loop at the end of this function reads `groups`, which
   * holds the globs and nothing else.
   *
   * Everything that is neither — `autoUpdate`, `perFile`, `100`, whatever comes
   * next — is refused by name.
   */
  const globals = keys.filter((key) => METRICS.includes(key));
  const groups = keys.filter(
    (key) =>
      !METRICS.includes(key) && MEASURED_EXTENSIONS.some((extension) => key.endsWith(extension)),
  );
  for (const key of keys) {
    if (globals.includes(key) || groups.includes(key)) {
      continue;
    }
    faults.push(
      `coverage.thresholds.${key} is neither one of the four metric names nor a pattern ` +
        `ending in ${MEASURED_EXTENSIONS.join(", ")}. \`autoUpdate\` rewrites these numbers ` +
        `from whatever the run achieved, \`100\` and \`perFile\` change what a group means, ` +
        `and a key this guard has not reasoned about is how a threshold stops being one.`,
    );
  }

  for (const metric of globals) {
    const value = thresholds[metric];
    if (typeof value !== "number") {
      faults.push(
        `coverage.thresholds.${metric} is a global threshold and is not a number, so vitest ` +
          `has nothing to check the whole package against.`,
      );
      continue;
    }
    faults.push(
      ...floorFaults(
        GLOBAL_GROUP,
        `coverage.thresholds.${metric}`,
        metric,
        value,
        allowancesUsed,
        ` A global threshold is not decoration: vitest counts every file into it, the ones a ` +
          `glob already matched included, so this number is what the whole package is held to.`,
      ),
    );
  }

  for (const group of groups) {
    const numbers = thresholds[group];
    if (typeof numbers !== "object" || numbers === null) {
      faults.push(
        `coverage.thresholds["${group}"] names files and is not a group of four numbers. ` +
          `Write the numbers on the group.`,
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
    const extension = group.includes("*")
      ? undefined
      : MEASURED_EXTENSIONS.find((one) => group.endsWith(one));
    if (extension !== undefined) {
      const asDirectory = group.slice(0, -extension.length);
      const paired = `${asDirectory}/**/*${extension}`;
      if (directories.has(asDirectory) && !groups.includes(paired)) {
        faults.push(
          `coverage.thresholds["${group}"] names a file that now has a directory beside it, ` +
            `and there is no "${paired}". After a split the file is a barrel and the code is ` +
            `in the directory: the threshold would measure re-exports while what it was ` +
            `written about drifts into an aggregate.`,
        );
      }
    }

    for (const metric of METRICS) {
      const value = declared[metric];
      if (typeof value !== "number") {
        continue;
      }
      faults.push(
        ...floorFaults(
          group,
          `coverage.thresholds["${group}"].${metric}`,
          metric,
          value,
          allowancesUsed,
        ),
      );
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

/**
 * What vitest's own manifest says to run, resolved rather than spelled out.
 *
 * `node_modules/.bin/vitest` is deliberately not what is spawned: npm writes
 * those as `.cmd` and `.ps1` shims on Windows, there is no `.exe`, and libuv
 * looks for `.com` and `.exe` only — so a bare name works on the machine that
 * wrote it and not on `windows-latest`. `process.execPath` plus a path needs
 * neither a shell nor a per-platform suffix.
 * `tests/workflows/portable-gate.test.ts` is what holds that rule; the same
 * reasoning, and the same `bin` lookup, are in `tests/tools/pinned-versions.test.ts`.
 *
 * @param {string} [root]
 * @returns {string}
 */
export function vitestEntry(root = ROOT) {
  const installed = resolve(root, "node_modules", "vitest");
  const bin = /** @type {{ bin?: string | { vitest?: string } }} */ (
    JSON.parse(readFileSync(resolve(installed, "package.json"), "utf8"))
  ).bin;
  const entry = typeof bin === "string" ? bin : bin?.vitest;
  if (entry === undefined) {
    throw new Error("vitest declares no `vitest` entry under `bin`");
  }
  return resolve(installed, entry);
}

/**
 * The `globalSetup` half: a coverage run this module did not start is refused.
 *
 * This is the wiring check that is not a reading of `package.json`. Whatever the
 * script says, a run measuring coverage either has this module as its parent —
 * in which case the summary it writes will be answered for the moment vitest
 * exits — or it does not, and then it is a report nobody reads. A test asserting
 * the shape of a script string cannot tell those apart; this can, because it is
 * the run.
 *
 * It has to be `setup` and not a teardown. A teardown does run after the summary
 * is written — measured, not assumed — but a throw there is printed as "error
 * during close" and **the process still exits 0**, which is the failure mode
 * this whole file exists about. Refusing before the first test costs nothing and
 * exits 1.
 *
 * An unrecognised shape is refused rather than read as "not measuring". Vitest
 * hands a `TestProject` whose `config.coverage.enabled` is a boolean on both
 * paths — checked, with and without `--coverage` — and if a later version stops
 * saying so, this seam would otherwise become a function that returns and a
 * guarantee nobody notices the loss of.
 *
 * @param {{ config?: { coverage?: { enabled?: boolean } } }} [project] vitest's `TestProject`
 * @returns {void}
 */
export function setup(project) {
  const enabled = project?.config?.coverage?.enabled;
  if (typeof enabled !== "boolean") {
    throw new Error(
      `this globalSetup was not told whether the run is measuring coverage: ` +
        `project.config.coverage.enabled is ${JSON.stringify(enabled)} and not a boolean. ` +
        `Until that is worked out, every coverage run would pass here unexamined, which is ` +
        `the state ADR-0063's second amendment was written from.`,
    );
  }
  if (!enabled) {
    return;
  }
  if (process.env[GATE_VARIABLE] !== undefined) {
    return;
  }
  throw new Error(
    `this run is measuring coverage and the coverage gate did not start it, so the summary ` +
      `it is about to write would be read by nobody and ${SUMMARY_PATH} may be left answering ` +
      `for a run that never happened. Use \`pnpm run test:coverage\`, which is ` +
      `\`node tools/coverage-gate.mjs\`: it clears the old summary, runs this same command, ` +
      `and then holds the result to the floor. See ADR-0063.`,
  );
}

/**
 * Clears the previous summary, runs the suite with coverage, answers for it.
 *
 * One command, because a chain of three joined by `&&` is a chain any one of
 * which can be deleted in an edit nothing reads. Arguments are handed on to
 * vitest, so `pnpm run test:coverage -- tests/report` still works.
 *
 * @param {readonly string[]} extra arguments to hand to vitest
 * @returns {number} the exit code for the process
 */
function gate(extra) {
  // So that a summary left by an earlier run cannot answer for this one.
  rmSync(resolve(ROOT, SUMMARY_PATH), { force: true });
  const ran = spawnSync(process.execPath, [vitestEntry(), "run", "--coverage", ...extra], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, [GATE_VARIABLE]: randomUUID() },
  });
  if (ran.error !== undefined) {
    process.stderr.write(`the coverage gate could not start vitest: ${ran.error.message}\n`);
    return 1;
  }
  if (ran.status !== 0) {
    // Vitest has already said what was wrong, and it writes no coverage report
    // for a failing run (`reportOnFailure` is false by default), so there is
    // nothing here to answer for. A signal leaves `status` null.
    return ran.status ?? 1;
  }
  /** @type {readonly string[]} */
  let faults;
  try {
    faults = faultsOnDisk();
  } catch (error) {
    // `shippedSources` throws rather than guess, and a thrown guard reads as a
    // crashed tool unless somebody prints it. Reachable only in theory — the
    // suite loads the same function and would have failed first — but a gate
    // whose last word is a stack trace is a gate somebody reads as broken
    // rather than as firing.
    process.stderr.write(
      `  ${error instanceof Error ? error.message : String(error)}\n\n` +
        `The coverage gate could not say what this package ships. See ADR-0063.\n`,
    );
    return 1;
  }
  for (const fault of faults) {
    process.stderr.write(`  ${fault}\n`);
  }
  if (faults.length > 0) {
    process.stderr.write(
      `\nThe coverage run did not measure what this package ships (${faults.length} ` +
        `${faults.length === 1 ? "fault" : "faults"}). See ADR-0063.\n`,
    );
    return 1;
  }
  process.stdout.write("every module the package ships was measured\n");
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = gate(process.argv.slice(2));
}

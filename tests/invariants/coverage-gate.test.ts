/**
 * Nothing the package ships is outside the coverage gate, and nothing inside it
 * is unanswered for.
 *
 * Twice now a file has left a gate's sight by being moved rather than by anyone
 * deciding it should. The first time was caught while it was happening: ADR-0057
 * cut `src/runner.ts` into a directory, and the `include` list gained a
 * recursive pattern over it with a comment calling the alternative "the gate
 * being lowered by a move, not by a decision". The second time was not: ADR-0056 cut
 * `src/cli.ts` into nine modules three lines above that same comment, and the
 * `include` list named none of them. The run orchestration, the second canary
 * pass and the gate on `--resume` were measured by nothing for four days, under
 * an exemption whose text — "argument parsing and printing" — described none of
 * them.
 *
 * Reading the two lists instead of trusting them is the only form of this check
 * that keeps working after the next move. It reads `vitest.config.ts` itself, so
 * a threshold deleted or a pattern narrowed is visible here whatever else is
 * edited in the same commit. See ADR-0063.
 */

import { readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import configuration from "../../vitest.config.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const coverage = configuration.test?.coverage as
  | {
      readonly include?: readonly string[];
      readonly thresholds?: Readonly<Record<string, unknown>>;
    }
  | undefined;

const include: readonly string[] = coverage?.include ?? [];

/** The threshold keys that are globs; the numeric ones are the overall figures. */
const thresholdGlobs: readonly string[] = Object.keys(coverage?.thresholds ?? {}).filter(
  (key) =>
    !["statements", "branches", "functions", "lines", "100", "perFile", "autoUpdate"].includes(key),
);

/**
 * The two shapes these lists use, and a refusal to guess at a third.
 *
 * Vitest matches both lists with picomatch, which reads far more than this. The
 * point of reimplementing two cases rather than reaching for the same library is
 * that an unfamiliar third case must **fail** here — loudly, naming the pattern
 * — rather than be approximated. A guard that quietly matches nothing is the
 * defect this file exists about, one level up.
 */
function matches(glob: string, path: string): boolean {
  const recursive = "/**/*.ts";
  if (glob.endsWith(recursive)) {
    return path.startsWith(`${glob.slice(0, -recursive.length)}/`) && path.endsWith(".ts");
  }
  if (glob === "src/**/*.ts") {
    return path.startsWith("src/") && path.endsWith(".ts");
  }
  if (glob.endsWith(".ts") && !glob.includes("*")) {
    return path === glob;
  }
  throw new Error(
    `the coverage configuration uses a pattern this guard cannot read: "${glob}". ` +
      `Teach it the shape, or use one of the two it knows — a literal path, or a ` +
      `directory followed by /**/*.ts. Do not delete the case: the reason this ` +
      `test exists is that a file left the gate by omission twice.`,
  );
}

/** Every `.ts` file under `src/`, as the paths the two lists are written in. */
function sources(directory: string = resolve(ROOT, "src")): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      return sources(path);
    }
    return entry.name.endsWith(".ts") ? [relative(ROOT, path)] : [];
  });
}

describe("the files the coverage gate measures", () => {
  /** The lists are read from the configuration, so an empty read is a failure. */
  it("are described by a configuration this test can see", () => {
    expect(include.length).toBeGreaterThan(0);
    expect(thresholdGlobs.length).toBeGreaterThan(0);
    expect(sources().length).toBeGreaterThan(20);
  });

  /**
   * The `src/cli/` hole, in the form that would have caught it: nine files
   * present in the tree, matched by no pattern in the list, and nothing saying
   * so.
   */
  it("are every source file the package ships", () => {
    const unmeasured = sources().filter((path) => !include.some((glob) => matches(glob, path)));

    expect(unmeasured).toEqual([]);
  });

  /**
   * A file inside `include` and outside every threshold is measured and not
   * gated: it appears in the report, contributes to no number anyone checks, and
   * can fall to zero without failing a build. With `include` written as one
   * pattern over the whole tree, that is now the shape the next hole would take.
   */
  it("are each answered for by a threshold", () => {
    const ungated = sources()
      .filter((path) => include.some((glob) => matches(glob, path)))
      .filter((path) => !thresholdGlobs.some((glob) => matches(glob, path)));

    expect(ungated).toEqual([]);
  });

  /**
   * And in the other direction: a threshold naming files that are not there
   * measures nothing and passes, which is how a gate becomes decoration. Vitest
   * checks an empty set of files against the numbers and finds no fault with it.
   */
  it("include something for every threshold that names them", () => {
    const empty = thresholdGlobs.filter((glob) => !sources().some((path) => matches(glob, path)));

    expect(empty).toEqual([]);
  });
});

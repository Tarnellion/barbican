/**
 * The two facts ADR-0064 collapsed into one home and gave to the compiler that
 * the compiler cannot hold.
 *
 * ADR-0064 put six duplicated facts each under the strongest mechanism available
 * to it. For two of them the decision table said "the compiler" and the
 * Consequences said the compiler "now refuses … a second severity table, and a
 * second date grammar in `src/io/config/schema.ts`". It refuses neither.
 * Adversarial review re-wrote each copy by hand on 23 August 2026 — a private
 * `Readonly<Record<Severity, number>>` back in `src/cli/screen.ts`, a literal
 * `/^\d{4}-\d{2}-\d{2}$/` back in the schema — and `npx tsc --noEmit` and
 * `npx vitest run` were both green over both.
 *
 * What the compiler does hold is real and narrower, and the ADR now says so:
 * `Record<Severity, number>` refuses a level added to `Severity` and left out of
 * the table, in every copy at once, which is the direction B-16 was about. It
 * says nothing about how many tables there are or how they rank.
 *
 * This is what reads the second copy. A third fact rides along: the header lists
 * behind `forbiddenHeaderReason` were made module-private in the same commit, so
 * a second composition that *borrows* them no longer compiles — and this file is
 * what reads a second composition that writes them out instead.
 *
 * ## What holds
 *
 * A source scan over the tracked files under `src/`, with the count exact in
 * both directions for every file allowed to carry the shape. A copy fails; so
 * does the owner losing its own, because a scanner that has stopped seeing
 * anything agrees with everything.
 *
 * Comments are dropped first — a line whose first non-space character opens or
 * continues one. Otherwise `src/report/shape.ts` explaining what `critical: 10`
 * means in a report would read as a severity table.
 *
 * ## What it cannot see
 *
 * - A table built rather than written: `Object.fromEntries`, a `Map`, an array
 *   of pairs, or ranks assigned in a loop. The shape read here is the shape a
 *   person types, which is also the shape the reviewer typed.
 * - A date grammar spelled some other way — `\d\d\d\d-\d\d-\d\d`, or `indexOf`
 *   and `slice` over the hyphens. `[0-9]` is folded to `\d` before the scan
 *   because that substitution is the one a linter suggests; nothing else is.
 * - A trailing comment on a line of code, which is not dropped and so is
 *   scanned. That direction only ever adds a finding, never hides one.
 * - Anything outside `src/`. `tests/` writes severity tables on purpose, and
 *   `tools/oracle/` is meant not to share this tool's code at all.
 * - A re-ranking of the one table that is left. Nothing here or in the compiler
 *   holds that; `tests/report/compare.test.ts` and the exit-code tests are what
 *   would notice, and only through the order they observe.
 *
 * See ADR-0064.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CALENDAR_DATE } from "../../src/core/calendar.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The tracked TypeScript under `src/`, from git rather than from the disk. */
function sources(): readonly string[] {
  return execFileSync("git", ["ls-files", "-z", "src"], { cwd: ROOT, encoding: "utf8" })
    .split("\u0000")
    .filter((one) => one.endsWith(".ts"));
}

/**
 * One file with its comments dropped and `[0-9]` folded to `\d`.
 *
 * A line whose first non-space character opens, continues or closes a comment is
 * not code. That is coarser than a tokeniser and errs the safe way: a comment on
 * the end of a line of code stays, so the scan can only over-report.
 */
function codeOf(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8")
    .split("\n")
    .filter((line) => {
      const trimmed = line.trimStart();
      return !(
        trimmed.startsWith("*") ||
        trimmed.startsWith("/*") ||
        trimmed.startsWith("//") ||
        trimmed.startsWith("*/")
      );
    })
    .join("\n")
    .replaceAll("[0-9]", "\\d");
}

/** Where a shape may appear, and how many times. Exact in both directions. */
type Homes = ReadonlyMap<string, number>;

function found(probe: RegExp): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const path of sources()) {
    const hits = [...codeOf(path).matchAll(probe)].length;
    if (hits > 0) {
      counts.set(path, hits);
    }
  }
  return counts;
}

function expectExactly(probe: RegExp, homes: Homes): void {
  expect(Object.fromEntries(found(probe))).toEqual(Object.fromEntries(homes));
}

describe("the severity ranks are written in one place", () => {
  /**
   * An entry of an object literal giving a severity level a number.
   *
   * Two files carry the shape and only two may. `src/core/defects.ts` is the
   * ranking itself. `src/report/findings.ts` holds `EMPTY_BY_SEVERITY`, which is
   * the same five keys at zero — the identity a count starts from, not an order,
   * and there is no way for all-zero to rank anything differently from all-zero.
   * Both are `Record<Severity, number>`, so a level added to the union reaches
   * both through the compiler.
   */
  const HOMES: Homes = new Map([
    ["src/core/defects.ts", 5],
    ["src/report/findings.ts", 5],
  ]);

  it("has no second table, and has not lost the one it has", () => {
    expectExactly(/\b(?:critical|high|medium|low|info)\s*:\s*\d/g, HOMES);
  });
});

describe("the YYYY-MM-DD grammar is written in one place", () => {
  /** `src/core/calendar.ts` owns it; `src/io/config/schema.ts` imports it. */
  const HOMES: Homes = new Map([["src/core/calendar.ts", 1]]);

  it("has no second grammar under src/", () => {
    expectExactly(/\\d\{4\}-\\d\{2\}-\\d\{2\}/g, HOMES);
  });

  /**
   * And the copy that ships is the same expression rather than a second one.
   *
   * `schema/barbican.run.schema.json` is published and editors complete a
   * configuration from it, so the pattern in it is a copy nobody re-derives —
   * the reason `CALENDAR_DATE` has no capture groups. Compared against the
   * owner's own `source`, so the two cannot drift apart in either direction.
   */
  it("ships the same expression in the published schema", () => {
    const schema = readFileSync(resolve(ROOT, "schema/barbican.run.schema.json"), "utf8");
    const patterns = [...schema.matchAll(/"pattern": "([^"]*)"/g)].map((match) => match[1] ?? "");

    expect(patterns).toContain(JSON.stringify(CALENDAR_DATE.source).slice(1, -1));
  });
});

describe("the forbidden-header lists are written in one place", () => {
  /**
   * The lists themselves are module-private, so a second composition cannot
   * import them — that half is the compiler's since 23 August 2026, and it is
   * the half the reviewer walked through. This is the other half: a copy that
   * writes the entries out instead. Three entries distinctive enough not to
   * occur anywhere else in this tool are read, one from the exact map and two
   * from the prefixes.
   */
  const HOMES: Homes = new Map([["src/io/config/basis.ts", 1]]);

  it.each([
    ["proxy-authorization", /proxy-authorization/g],
    ["x-original-", /x-original-/g],
    ["x-http-method", /x-http-method/g],
  ])("has no second list carrying %s", (_entry, probe) => {
    expectExactly(probe, HOMES);
  });
});

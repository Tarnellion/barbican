/**
 * The tooling is typed from its own source, and not from a description beside it.
 *
 * There were three `.d.mts` files under `tools/`, hand-written next to the `.mjs`
 * they described. They sat outside `tsconfig.include`, and with `skipLibCheck`
 * on, nothing compared them to the code: TypeScript reads the declaration and
 * never looks at the implementation, so the two were free to disagree. Tests
 * typed against the declaration while CI ran the implementation — in
 * `tools/oracle/`, the module that decides whether the strongest gate this
 * project has passed at all. Found by the audit of 14 August 2026 (B-13).
 *
 * The cure is not a better description. It is that `tools/**\/*.mjs` is in
 * `tsconfig.include` with `checkJs`, so the compiler reads the code, and the
 * shapes live in it as JSDoc. One source, and drift has nowhere to happen.
 *
 * This file guards the arrangement rather than the types: the compiler already
 * checks those, and it would go on passing if somebody dropped a `.d.mts` back
 * in — quietly taking over from the source again.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function walk(directory: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    found.push(...(statSync(path).isDirectory() ? walk(path) : [path]));
  }
  return found;
}

const TOOLS = walk(join(ROOT, "tools"));

const TSCONFIG = JSON.parse(readFileSync(join(ROOT, "tsconfig.json"), "utf8")) as {
  include: readonly string[];
  compilerOptions: Record<string, unknown>;
};

describe("the tooling under tools/", () => {
  it("is there to be checked at all", () => {
    // A test that found no modules would agree with any arrangement.
    expect(TOOLS.filter((one) => one.endsWith(".mjs")).length).toBeGreaterThan(2);
  });

  /**
   * The one that closed B-13. A declaration file beside an implementation wins:
   * the compiler stops reading the code and starts believing the description.
   */
  it("carries no hand-written declaration beside a module", () => {
    expect(TOOLS.filter((one) => one.endsWith(".d.mts") || one.endsWith(".d.ts"))).toEqual([]);
  });

  it("is inside what the typecheck reads", () => {
    expect(TSCONFIG.include).toContain("tools/**/*.mjs");
    expect(TSCONFIG.compilerOptions["allowJs"]).toBe(true);
    expect(TSCONFIG.compilerOptions["checkJs"]).toBe(true);
  });

  /**
   * And stays out of what is published. `tsconfig.build.json` compiles `src`
   * alone: this is testing tooling, and `files` carries the build, the
   * documentation, the examples and the schema — nothing that only serves to
   * test the tool. See ADR-0021.
   */
  it("is outside what the build emits", () => {
    const build = JSON.parse(readFileSync(join(ROOT, "tsconfig.build.json"), "utf8")) as {
      include: readonly string[];
    };

    expect(build.include).toEqual(["src/**/*.ts"]);
  });
});

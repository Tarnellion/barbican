/**
 * The sentences an evidence pack says to a third party are written once.
 *
 * `CLAIMS`, `STANDINGS` and `DISCLAIMERS` in `src/report/pack.ts` are the tables
 * a pack's wording comes out of. The reason they are tables at all is the one
 * `WARNINGS` was made a table for: the console and the report said the same
 * thing until somebody improved one of the two, and by 18 August 2026 the two
 * copies of `noCanary` disagreed about the same run — a reader holding the
 * artifact could not tell which of them the tool had meant. A pack is where that
 * costs the most, because its sentences are assertions made to somebody who was
 * not there and cannot check them.
 *
 * This is the gate on that. It reads the tracked TypeScript under `src/` and
 * asks that each sentence occur in exactly one file, and that the file be the
 * one that owns it.
 *
 * ## What it catches
 *
 * A second copy of a sentence, wherever it is written and whatever it is called:
 * the renderer that pastes the claim wording into a template, the CLI that
 * prints a shorter version of it, the module that keeps "its own" table beside
 * this one. The count is exact in both directions, so a sentence that stops
 * being found — a table renamed away, a scan that has stopped seeing — fails
 * here rather than passing.
 *
 * ## What it cannot see
 *
 * ADR-0065 is the reasoning for having this section at all, and it applies here
 * without amendment: a scan of source text catches what somebody writes by
 * accident or for convenience, and not what somebody writes in order to defeat
 * it. Every form below was written, run against this file and seen to pass; the
 * counts are in ADR-0067's Limits section.
 *
 * - **A paraphrase.** The largest one by far, and it is not a spelling trick: a
 *   renderer that prints `PASS` in a column beside an `upheld` row says
 *   something this table never said, and no scan of text will ever notice. What
 *   stands against that is the shape of the data — a row carries a code and the
 *   sentence is only here — and a reader of the rendering track's own tests.
 * - **A sentence assembled at run time**, out of `CLAIMS.upheld.slice(…)` or out
 *   of a list of words. The scan reads literals.
 * - **A sentence in a file the scan does not enumerate**: untracked, named
 *   `.mts`, or outside `src/`.
 * - **A spelling the scan does not normalise.** It folds the one join the table
 *   itself uses — a string literal continued with `+` — and nothing else, so a
 *   copy pasted together with a template interpolation in the middle of it is a
 *   copy this file does not see.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLAIMS, DISCLAIMERS, STANDINGS } from "../../src/report/pack.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The module that owns every sentence below. */
const OWNER = "src/report/pack.ts";

/** The tracked TypeScript under `src/`, from git rather than from the disk. */
function sources(): readonly string[] {
  return execFileSync("git", ["ls-files", "-z", "src"], { cwd: ROOT, encoding: "utf8" })
    .split("\u0000")
    .filter((one) => one.endsWith(".ts"));
}

/**
 * A string literal continued with `+`, joined back into one string.
 *
 * The tables are written that way because a sentence of two hundred characters
 * does not fit in a hundred-column line, so a scan that did not fold this would
 * find none of them — including in the owning module, which is the direction
 * that fails green.
 */
function joined(source: string): string {
  return source.replaceAll(/"\s*\+\s*"/g, "");
}

/** One file as code: comment lines dropped, continued literals joined. */
function textOf(path: string): string {
  return joined(
    readFileSync(resolve(ROOT, path), "utf8")
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
      .join("\n"),
  );
}

/** Every sentence a pack prints, by the name it is written under. */
const SENTENCES: ReadonlyMap<string, string> = new Map([
  ...Object.entries(CLAIMS).map(([key, text]): [string, string] => [`CLAIMS.${key}`, text]),
  ...Object.entries(STANDINGS).map(([key, text]): [string, string] => [`STANDINGS.${key}`, text]),
  ...Object.entries(DISCLAIMERS).map(([key, text]): [string, string] => [
    `DISCLAIMERS.${key}`,
    text,
  ]),
]);

describe("the wording of a claim", () => {
  it("has sentences to answer for, and files to look in", () => {
    // A gate that read no sentence, or no file, is green for the same reason a
    // passing one is.
    expect(SENTENCES.size).toBe(11);
    expect(sources()).toContain(OWNER);
    expect(sources().length).toBeGreaterThan(30);
    for (const text of SENTENCES.values()) {
      // Long enough to be a sentence rather than a word that could occur
      // anywhere by coincidence.
      expect(text.length).toBeGreaterThan(120);
    }
  });

  it("reads a literal the table continues across lines", () => {
    expect(joined('const a = "one " +\n  "two";')).toContain("one two");
    // And the owner really is found through it, which is what stops the
    // assertion below from passing by finding nothing anywhere.
    expect(textOf(OWNER)).toContain(CLAIMS.upheld);
  });

  it("is written in one module, and that module is the one that owns it", () => {
    const wrong: string[] = [];
    for (const [name, text] of SENTENCES) {
      const homes = sources().filter((path) => textOf(path).includes(text));
      if (homes.length !== 1 || homes[0] !== OWNER) {
        wrong.push(`${name} is in [${homes.join(", ") || "nothing under src/"}]`);
      }
    }

    expect(
      wrong,
      `A sentence a pack prints is written somewhere other than ${OWNER}, or is no ` +
        `longer written there: ${wrong.join("; ")}. Every one of them is an assertion ` +
        `this tool makes to somebody who was not there, and two copies of an assertion ` +
        `are two assertions the day one of them is improved — which is what happened to ` +
        `WARNINGS. Read the table; do not restate it. See ADR-0067.`,
    ).toEqual([]);
  });
});

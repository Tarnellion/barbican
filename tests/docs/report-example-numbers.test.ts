/**
 * The run `docs/report.md` illustrates is one this polygon can produce.
 *
 * The document opens with a line of real output — cells, matrix rows, accounts,
 * endpoints, resources — and says every number in it comes from the reference
 * platform with all defects on. It also says a reader's own numbers will differ,
 * and that is fair; what is not fair is a line whose own arithmetic no longer
 * adds up. It said `endpoints 6` while the polygon declares seven, so a reader
 * reconciling 144 cells against six endpoints was reconciling against a number
 * that had drifted.
 *
 * The count of switchable defects has drifted twice before and
 * `polygon-facts.test.ts` next door is the cure for that one. This is the cure
 * for the illustration: the numbers are read out of the polygon's own
 * declarations, so the sentence cannot outlive them.
 *
 * The cell count itself is deliberately **not** asserted here. It depends on
 * which endpoints a run reaches, and pinning it would tie a document to a
 * particular set of flags — the polygon's own verification table, printed by the
 * run, is where a number like that belongs.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseRunConfig } from "../../src/io/config.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPORT_DOC = readFileSync(resolve(ROOT, "docs/report.md"), "utf8");

/** The illustrative line, as one string with its line break removed. */
function example(): string {
  const start = REPORT_DOC.indexOf("Cells probed:");
  return REPORT_DOC.slice(start, REPORT_DOC.indexOf("```", start)).replace(/\s+/g, " ").trim();
}

const CONFIG = parseRunConfig(readFileSync(resolve(ROOT, "polygon/barbican.run.yaml"), "utf8"));

/** Endpoint ids the polygon declares, from the file the run is given. */
const ENDPOINT_IDS = [
  ...readFileSync(resolve(ROOT, "polygon/endpoints.yaml"), "utf8").matchAll(
    /^\s*-\s*id:\s*(\S+)/gm,
  ),
].map((match) => match[1]);

describe("the example output at the top of docs/report.md", () => {
  it("is there to be checked", () => {
    // A test that found no line would agree with any document.
    expect(example()).toMatch(/^Cells probed: \d+ \(matrix rows \d+/);
    expect(ENDPOINT_IDS.length).toBeGreaterThan(3);
  });

  /**
   * The one that had drifted. Six was written when it was true; the seventh
   * endpoint is a write, which a run without `--unsafe-methods` skips — so the
   * cell count stayed where it was and only this number moved.
   */
  it("names as many endpoints as the polygon declares", () => {
    expect(example()).toContain(`endpoints ${ENDPOINT_IDS.length}`);
  });

  it("names as many accounts and resources as the configuration declares", () => {
    expect(example()).toContain(`accounts ${CONFIG.accounts.length}`);
    expect(example()).toContain(`resources ${CONFIG.resources?.length ?? 0}`);
  });

  /**
   * And the row count is the accounts plus the rows their conditions add, which
   * is the arithmetic the paragraph beneath the line exists to explain — a reader
   * who counts `accounts` and expects the cells to follow gets the wrong answer.
   */
  it("names a row count the conditions account for", () => {
    const rows = Number(/matrix rows (\d+)/.exec(example())?.[1]);

    expect(rows).toBeGreaterThan(CONFIG.accounts.length);
    expect((CONFIG.contexts ?? []).length).toBeGreaterThan(0);
  });
});

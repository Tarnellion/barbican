/**
 * One walk over the matrix, for both answers.
 *
 * ADR-0020 makes this a correctness property and not only a cheap one: the
 * verdict on a cell and the discrepancy on that cell come from the same pass, so
 * the report cannot claim "tested and agreed" about a cell that is sitting in the
 * findings. `describeCells` and `diffAccess` are two doors into one `walk`, and
 * each of them walks.
 *
 * The audit of 14 August found the property held in the core and cancelled at the
 * call site (I-2): `src/cli.ts` called both functions on consecutive lines with
 * identical arguments, under a comment promising a shared walk. Nothing was wrong
 * with the report that came out — the walk is pure, so the second pass agreed
 * with the first — and that is exactly why no test noticed. What it cost was the
 * whole walk again, twice the work of the largest computation in a run.
 *
 * Two guards, because the invariant has two halves and neither implies the other:
 * that asking for both answers at once walks once, and that the run asks for them
 * at once. The second is a check on the text of the entry point — the same shape
 * as `tests/docs/envelope-limitation.test.ts`, and for the same reason: what
 * cannot be observed in the output has to be guarded where it is written, or the
 * next edit quietly restores it.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AccessMatrix } from "../src/core/index.js";
import { buildAccessMatrix, describeCells, describeMatrix, diffAccess } from "../src/core/index.js";
import {
  accounts,
  cleanObservations,
  endpoints,
  escalationObservations,
  policy,
} from "./fixtures/scenario.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function matrixWith(observations: Parameters<typeof buildAccessMatrix>[0]["observations"]) {
  return buildAccessMatrix({ endpoints, accounts, observations });
}

/**
 * The same matrix, counting how many times it was walked.
 *
 * `walk` reads `accounts` exactly once — it is the outer loop — so the number of
 * reads is the number of walks. A counter on the input rather than a spy on the
 * function: the walk is not exported, and a test that reached inside it would be
 * asserting the shape of the code instead of what it does to its input.
 */
function counting(matrix: AccessMatrix): { readonly matrix: AccessMatrix; walks(): number } {
  let walks = 0;
  const counted: AccessMatrix = {
    ...matrix,
    get accounts() {
      walks += 1;
      return matrix.accounts;
    },
  };
  return { matrix: counted, walks: () => walks };
}

describe("both answers about the matrix", () => {
  it("come from one walk when asked for together", () => {
    const counted = counting(matrixWith(escalationObservations));

    describeMatrix(counted.matrix, policy);

    expect(counted.walks()).toBe(1);
  });

  /**
   * The cost of asking separately, stated rather than implied: this is what the
   * call site did, and the number is the whole finding.
   */
  it("cost a walk each when asked for one at a time", () => {
    const counted = counting(matrixWith(escalationObservations));

    describeCells(counted.matrix, policy);
    diffAccess(counted.matrix, policy);

    expect(counted.walks()).toBe(2);
  });

  /**
   * The two doors stay doors: a consumer of the library uses them separately and
   * must get exactly what the shared walk gives.
   */
  it("are the same answers the two separate functions give", () => {
    const matrix = matrixWith(escalationObservations);

    const both = describeMatrix(matrix, policy);

    expect(both.cells).toEqual(describeCells(matrix, policy));
    expect(both.diffs).toEqual(diffAccess(matrix, policy));
  });

  /** The invariant of ADR-0020 itself, over the pair that comes out together. */
  it("disagree about no cell: the discrepancies are the cells that did not match", () => {
    const { cells, diffs } = describeMatrix(matrixWith(escalationObservations), policy);
    const key = (cell: { accountId: string; endpointId: string; resourceId?: string }) =>
      `${cell.accountId} ${cell.endpointId} ${cell.resourceId ?? ""}`;

    expect(cells.filter((cell) => !cell.match).map(key)).toEqual(diffs.map(key));
    expect(diffs.length).toBeGreaterThan(0);
  });

  it("are clean together when the platform behaves as declared", () => {
    const { cells, diffs } = describeMatrix(matrixWith(cleanObservations), policy);

    expect(diffs).toEqual([]);
    expect(cells.every((cell) => cell.match)).toBe(true);
  });
});

describe("the run itself", () => {
  /**
   * The whole entry point as one text: `src/cli.ts` and the modules it was split
   * into on 22 August 2026 (ADR-0056).
   *
   * Read off the directory rather than by naming the module the call happens to
   * live in today. What this guard is about is the run, not a file — and a guard
   * that has to be re-pointed by hand every time the code moves is a guard that
   * will one day be left pointing at the wrong file and pass.
   */
  const cli = [
    resolve(ROOT, "src/cli.ts"),
    ...readdirSync(resolve(ROOT, "src/cli"))
      .filter((one) => one.endsWith(".ts"))
      .map((one) => resolve(ROOT, "src/cli", one)),
  ]
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");

  it("asks for the verdicts and the discrepancies in one call", () => {
    expect(cli).toContain("describeMatrix(matrix, policy)");
  });

  /**
   * Not "does not call them twice" but "does not call them": either one alone is
   * a second walk over the matrix the run has already walked, and the pair is the
   * defect the audit found.
   */
  it("does not walk the matrix a second time through describeCells or diffAccess", () => {
    expect(cli).not.toMatch(/\bdescribeCells\s*\(/);
    expect(cli).not.toMatch(/\bdiffAccess\s*\(/);
  });
});

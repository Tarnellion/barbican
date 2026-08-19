/**
 * Every oracle in this repository parses, and says how big its matrix is.
 *
 * The gate for one polygon proves nothing about the others, and on 17 August 2026
 * that stopped being a hypothetical: `expectedCells` was made mandatory in
 * `loadGroundTruth` and added to `polygon/ground-truth.json`, the only file the
 * change was tried against. Both oracles under `polygons/` — VAmPI and crAPI —
 * stopped loading at the first variant, and the whole suite stayed green, because
 * no test opened them. They are run by hand against a polygon in Docker, so the
 * breakage would have surfaced the next time somebody brought one up, which could
 * have been months.
 *
 * The files are found rather than listed. A list is the same defect one level up:
 * a fourth polygon added next year is exactly the file nobody would remember to
 * add to it.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadGroundTruth } from "../../tools/oracle/index.mjs";

const ROOT = resolve(import.meta.dirname, "..", "..");

/**
 * The polygons that may leave `expectedCells` out, and why each may.
 *
 * An explicit refusal with the reason beside it, in the shape `allowBuilds` uses:
 * an empty exemption would be indistinguishable from the guard not being written
 * yet, and a silent one would let the next polygon opt out by accident.
 *
 * crAPI takes its endpoint list from an OpenAPI document inside the crAPI
 * checkout — outside this repository and versioned by somebody else. The cell
 * count there is a property of a file this tree does not hold, so a constant for
 * it would be a number nobody here can maintain or check.
 */
const MAY_OMIT_EXPECTED_CELLS: ReadonlyMap<string, string> = new Map([
  ["polygons/crapi", "endpoints come from an OpenAPI document outside this repository"],
]);

function trackedGroundTruths(): readonly string[] {
  return execFileSync("git", ["ls-files", "-z", "*ground-truth.json"], {
    cwd: ROOT,
    encoding: "utf8",
  })
    .split("\0")
    .filter((file) => file !== "");
}

describe("the oracles in this repository", () => {
  const files = trackedGroundTruths();

  // Without this the suite below would be an empty loop reporting success, which
  // is the failure mode of every test that finds its own inputs.
  it("are found, and there is more than one", () => {
    expect(files.length).toBeGreaterThan(1);
    expect(files).toContain("polygon/ground-truth.json");
  });

  for (const file of files) {
    describe(file, () => {
      it("parses", () => {
        expect(() => loadGroundTruth(readFileSync(resolve(ROOT, file), "utf8"))).not.toThrow();
      });

      it("says how many cells each variant walks, or is excused by name", () => {
        const truth = loadGroundTruth(readFileSync(resolve(ROOT, file), "utf8"));
        // A `Map` and not an object literal: the key comes from `git ls-files`,
        // which is a name this project did not choose, and a plain lookup excuses
        // `constructor` and `toString` (ADR-0024). Improbable here and still the
        // rule — a guard that breaks the rule it guards is a poor guard.
        const excuse = MAY_OMIT_EXPECTED_CELLS.get(dirname(file));
        for (const variant of truth.variants) {
          if (excuse === undefined) {
            // Defined first and positive second: `toBeGreaterThan` on `undefined`
            // throws a TypeError before the message is read, and the missing field
            // is the case this whole file exists for.
            expect(
              variant.expectedCells,
              `${file}: variant "${variant.id}" declares no expectedCells, and ` +
                `${dirname(file)} is not excused from it — a run that walks half the ` +
                `matrix agrees with a comparison of findings`,
            ).toBeDefined();
            expect(variant.expectedCells ?? 0).toBeGreaterThan(0);
          } else {
            expect(variant.expectedCells).toBeUndefined();
          }
        }
      });
    });
  }
});

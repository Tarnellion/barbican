/**
 * Facts about the polygon that the prose repeats.
 *
 * The number of switchable defects is written out in words in four documents.
 * It has drifted twice: `examples/README.md` still said "four" when there were
 * ten, and `docs/guide.md` said "eight". Both were written when they were true.
 *
 * The verification table in `polygon/README.md` is printed by the run itself,
 * which is the right cure — but it does not reach a number woven into a
 * sentence. This test is the cure for those: the count lives in `server.mjs`,
 * and a document that repeats it has to repeat the current one.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const NUMBER_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
] as const;

/** The switches themselves, counted where they are declared. */
function defectCount(): number {
  const source = readFileSync(resolve(ROOT, "polygon/server.mjs"), "utf8");
  return [...source.matchAll(/"POLYGON_DEFECT_[A-Z_]+"/g)].length;
}

describe("the documented number of polygon defects", () => {
  const defects = defectCount();

  it("counts the switches from the source, not from a constant here", () => {
    // A test that counted nothing would agree with any document.
    expect(defects).toBeGreaterThan(5);
  });

  it.each(["docs/guide.md", "examples/README.md", "polygon/README.md", "polygons/vampi/README.md"])(
    "matches what %s says",
    (file) => {
      const text = readFileSync(resolve(ROOT, file), "utf8");
      const claims = [...text.matchAll(/(\w+) switchable defects/g)].map((match) => match[1]);
      const expected = NUMBER_WORDS[defects];

      for (const claim of claims) {
        // A document may leave the number out — "switchable defects" with no count
        // is not a claim and cannot go stale. A wrong count is a different matter.
        if (NUMBER_WORDS.includes(claim as (typeof NUMBER_WORDS)[number])) {
          expect(claim).toBe(expected);
        }
      }
    },
  );
});

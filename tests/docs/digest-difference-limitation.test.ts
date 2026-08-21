/**
 * The boundary of the body channel stays written down.
 *
 * Two digests that differ prove one thing: the bytes were different. They do not
 * prove the tenants are isolated. Everything the tool cannot see lives in that
 * gap — a leak whose envelope carries a `requestId`, a `generatedAt`, a
 * pagination cursor; a subtree comparison that skips the field the leak is in;
 * two responses carrying the same records in a different order. A reader who
 * takes `differedPairs` for a clean bill of health is reading a number that
 * never made that claim.
 *
 * This is the structural sibling of "a platform that refuses with 200", guarded
 * next door in `envelope-limitation.test.ts` and for the same reason: there is
 * no code to fix, the limitation is real, and what can be held is that the
 * document a reader actually opens keeps saying so. A warning nothing checks is
 * a warning that survives exactly until the next edit.
 *
 * See ADR-0044.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path: string) => readFileSync(resolve(ROOT, path), "utf8");

/**
 * Two documents, two audiences.
 *
 * `docs/report.md` is where somebody sits with a saved artifact and decides what
 * the numbers in it are worth. `docs/guide.md` is where "what the tool does not
 * do" lives, and the operator who declares `responseMustDifferByTenant` reads it
 * before the run rather than after.
 */
const DOCUMENTS = ["docs/report.md", "docs/guide.md"] as const;

describe("a difference in digests is not proof of isolation", () => {
  it.each(DOCUMENTS)("is stated in %s", (path) => {
    const text = read(path);

    // The claim itself: differing digests do not establish isolation.
    expect(text).toMatch(/(?:not|never)\s+(?:prove|proof)\s*(?:of\s+)?[^.]{0,40}isolat/i);
    // And it is about digests, not about some other part of the report.
    expect(text).toMatch(/digests?/i);
    // And what it does establish, which is the half that makes it actionable.
    expect(text).toMatch(/only that the bytes|the bytes (?:were|are) different/i);
  });

  /**
   * The concrete shapes, not only the abstract caveat. "A digest is not proof"
   * is a sentence a reader nods at; `requestId` in an envelope is one they
   * recognise in their own platform, which is the difference between a warning
   * read and a warning acted on.
   */
  it.each(DOCUMENTS)("names in %s what makes bytes differ without isolation", (path) => {
    expect(read(path)).toMatch(/requestId|generatedAt|serverTime|cursor/);
  });

  /** And what an operator does about it, or the boundary is a dead end. */
  it.each(DOCUMENTS)("points in %s at the declaration that narrows the gap", (path) => {
    expect(read(path)).toMatch(/compareSubtree/);
  });
});

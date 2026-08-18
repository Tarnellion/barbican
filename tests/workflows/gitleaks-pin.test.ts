/**
 * The gitleaks CI installs is stated once, and the local hook reads that one.
 *
 * `ci.yml` promises beside the pin that "the version matches the local one so
 * that CI and pre-commit never differ in their verdicts". Nothing held it: the
 * local binary comes from Homebrew and moves on its own, the pin is a string
 * somebody has to remember, and the only thing connecting them was that
 * sentence. `tools/gitleaks-pin.mjs` compares them at commit time; what is
 * asserted here is the part a machine can check without a binary installed —
 * that the pin exists, that the workflow builds its download from it rather than
 * from a second copy, and that the hook actually runs the comparison.
 *
 * The last of those is the one worth having. A guard nobody calls is the failure
 * this project has found more than once, and it is invisible precisely because
 * the guard itself is written and passes review.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { pinnedGitleaksVersion } from "../../tools/gitleaks-pin.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CI = readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8");
const LEFTHOOK = readFileSync(resolve(ROOT, "lefthook.yml"), "utf8");

describe("the gitleaks version CI pins", () => {
  it("is stated, and the reader finds the same string the workflow holds", () => {
    const pinned = pinnedGitleaksVersion(CI);

    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    // Not through the parser a second time: the point is that the string is in
    // the file, so that a reader who finds nothing cannot report agreement.
    expect(CI).toContain(`GITLEAKS_VERSION: "${pinned}"`);
  });

  /**
   * The checksum is what makes a bumped version fail loudly instead of quietly
   * installing something else, so the pair has to stay a pair.
   */
  it("comes with a checksum", () => {
    expect(CI).toMatch(/GITLEAKS_SHA256: "[0-9a-f]{64}"/);
  });

  /**
   * A download URL with the number written into it a second time is a version
   * that gets bumped in one place, and this workflow verifies a checksum — so
   * the failure would be a checksum mismatch on a URL nobody changed, which
   * reads as a supply-chain alarm rather than as a typo.
   */
  it("builds its download from that variable and not from a second copy", () => {
    const pinned = pinnedGitleaksVersion(CI);
    const download = CI.split("\n").find((line) => line.includes("releases/download"));

    expect(download).toBeDefined();
    // A pattern and not a string literal: the text is a shell expansion, and
    // written as a literal it reads to the linter as a template gone wrong.
    expect(download).toMatch(/\$\{GITLEAKS_VERSION\}/);
    expect(download).not.toContain(String(pinned));
  });

  it("is compared against the local binary by a pre-commit hook", () => {
    const hooks = parseYaml(LEFTHOOK) as {
      readonly "pre-commit"?: { readonly jobs?: readonly { readonly run?: string }[] };
    };
    const commands = (hooks["pre-commit"]?.jobs ?? []).map((job) => job.run ?? "");

    expect(commands).toContain("node tools/gitleaks-pin.mjs");
  });
});

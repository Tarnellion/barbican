/**
 * The README of the version being released.
 *
 * `v0.2.0` was tagged from a commit whose README still said "build from source
 * until `0.2.0` is published". npm shows that README on the package page, so the
 * page for 0.2.0 talked a reader out of installing 0.2.0 — the release turned the
 * sentence false at the exact moment it became visible, and nobody re-read it.
 *
 * The pattern is not a typo but a shape: the README is written in the future
 * tense about a version that does not exist yet, and tagging makes it the present.
 * This test asks the two questions the release cannot answer for itself — does the
 * README name the version being shipped, and does it describe that version as
 * something you cannot have.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NOTES_MINIMUM, sectionOf, whyNotDescribed } from "../../tools/release-gate.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const README = readFileSync(resolve(ROOT, "README.md"), "utf8");
const VERSION = (
  JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as { version: string }
).version;

/** Ways of saying "this version is not something you can install yet". */
const UNAVAILABLE = /\buntil\b|not yet (?:published|released)|is a stub|from source/i;

describe("the README describes the version being released", () => {
  const mentions = README.split("\n").filter((line) => line.includes(VERSION));

  it("names that version at all", () => {
    // A README that never mentions the version cannot lie about it, and cannot say
    // what changed either. The Install section is where a reader looks first.
    expect(mentions.length).toBeGreaterThan(0);
  });

  it("does not describe it as unavailable", () => {
    // A previous version may well be called a stub — that stays true. The claim
    // that goes stale is the one about the version being shipped right now.
    expect(mentions.filter((line) => UNAVAILABLE.test(line))).toEqual([]);
  });

  /**
   * And does not point the reader at a different one.
   *
   * The two assertions above look only at lines that mention the version being
   * released, so they had nothing to say about a sentence naming an **older**
   * version as the current release — which is what the Install section said while
   * `package.json` had already moved on. That is the v0.2.0 defect in its other
   * form: not a false claim about the new version, but a true claim about the old
   * one left where a reader takes it for the new. Found while cutting 0.4.0, by
   * the release rather than by the guard, on 17 August 2026.
   */
  it("names no other version as the one to install", () => {
    const claims = README.split("\n").filter((line) => /is the current release/.test(line));

    // A guard that matched no sentence would agree with any README.
    expect(claims).toHaveLength(1);
    expect(claims[0]).toContain(VERSION);
  });
});

/**
 * What is on main, and what a reader of the package can have.
 *
 * The three questions above are asked of the README of a version being tagged.
 * They had nothing to say about the state this repository was actually in on
 * 19 August 2026: `package.json` said `0.4.0`, the tag `v0.4.0` had been cut
 * twenty-one commits earlier, and those commits carried three new refusals a run
 * can end on, a changed string in `report.warnings[]`, and the fixes for a path
 * that reached an endpoint the configuration had excluded. All of it was fixed
 * for whoever reads the repository and open for everyone who runs
 * `npm install barbican` — and nothing anywhere said so.
 *
 * That is the third time this shape has cost something: `v0.2.0` shipped a README
 * arguing against its own package, `0.3.0` shipped three report changes described
 * only in ADRs, and this is the same omission with the release not yet made.
 *
 * The rule these two cases enforce: **the difference between main and the newest
 * tag is written down where a consumer reads, as it lands.** Not at release time,
 * when it has to be reconstructed from the log — the reconstruction is what
 * failed twice. `### Unreleased` is that place; the release renames it.
 *
 * The version in `package.json` deliberately stays where it is between releases.
 * Bumping it early was the other candidate and it contradicts the guard above:
 * the Install section would then name a version npm does not have as "the current
 * release, and the one to install", which is the v0.2.0 defect in its original
 * direction. See ADR-0034.
 */
describe("what main carries beyond the newest release", () => {
  const git = (...args: readonly string[]): string | undefined => {
    const result = spawnSync("git", [...args], { cwd: ROOT, encoding: "utf8" });
    return result.status === 0 ? result.stdout.trim() : undefined;
  };

  /** The newest `v*` tag by version order, which is the last release. */
  const newestTag = (git("tag", "--list", "v*", "--sort=-v:refname") ?? "").split("\n")[0] ?? "";

  /**
   * The section, and everything under it up to the next heading of any level.
   *
   * Taken from `tools/release-gate.mjs` rather than written here, and so is the
   * length a section has to reach. The release workflow asks the same question
   * of the same README through the same functions — see the last assertion in
   * this file. Two spellings of one rule drift, and the half that drifts is the
   * half nobody looks at until a release.
   */
  const section = (heading: string): string | undefined => sectionOf(README, heading);

  it("is asked of a checkout that has the tags and the history", () => {
    // A shallow checkout has neither, and then every assertion below passes by
    // knowing nothing — the shape of guard this repository keeps finding in its
    // own CI. `fetch-depth: 0` is set in ci.yml for exactly these three lines.
    expect(newestTag).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(git("rev-list", "-n", "1", newestTag)).toMatch(/^[0-9a-f]{40}$/);
  });

  /**
   * `docs/` and `polygon/` are not in the list on purpose: they change without
   * changing what a consumer runs, and a guard that fires on a typo fix is one
   * people learn to satisfy with an empty line.
   */
  const consumerVisible = (
    git("diff", "--name-only", `${newestTag}..HEAD`, "--", "src", "schema") ?? ""
  )
    .split("\n")
    .filter((name) => name !== "");

  it("is described in an Unreleased section while it is not released", () => {
    const tagged = git("rev-list", "-n", "1", `v${VERSION}`);
    const head = git("rev-parse", "HEAD");
    // On the release commit itself there is nothing unreleased: the section has
    // just been renamed to name the version. Everywhere else, a change under
    // `src/` or `schema/` since the last tag owes a description.
    if (tagged === head || consumerVisible.length === 0) {
      expect(section("### Unreleased")).toBeUndefined();
      return;
    }
    const unreleased = section("### Unreleased");

    expect(unreleased, `changed since ${newestTag}: ${consumerVisible.join(", ")}`).toBeDefined();
    // A heading with nothing under it satisfies the letter and none of the point.
    expect((unreleased ?? "").trim().length).toBeGreaterThan(NOTES_MINIMUM);
  });

  /**
   * And once it is tagged, the renamed section still says something.
   *
   * This assertion used to be `README` contains `### What changed in <version>`,
   * and that is a heading rather than a description: rename `### Unreleased`,
   * delete the paragraphs under it, tag — and `0.3.0` happens again, which is
   * three report changes shipped with nothing said about them anywhere a
   * consumer reads. The length a section has to reach while it is unreleased is
   * the length it has to reach once it is named. Found by the audit of
   * 20 August 2026.
   *
   * The judgement is `whyNotDescribed`, and the release workflow calls that same
   * function on the same file before it publishes (ADR-0049). So this is not the
   * only thing standing between an undescribed release and npm — which is the
   * point, because a test in the suite is deleted by whoever finds it
   * inconvenient, and a step in the gate is not.
   */
  it("is named after the version, with what changed under it, once it is tagged", () => {
    const tagged = git("rev-list", "-n", "1", `v${VERSION}`);
    if (tagged !== git("rev-parse", "HEAD")) {
      // Not a release commit. The assertion that applies here is the one above.
      expect(README).toContain("## Install");
      return;
    }

    expect(whyNotDescribed(README, VERSION)).toBeUndefined();
  });
});

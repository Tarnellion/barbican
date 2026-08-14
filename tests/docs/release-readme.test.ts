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

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
});

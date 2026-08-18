/**
 * Telling "there is nothing newer" from "the threshold is holding it".
 *
 * `pnpm update` says neither. Measured on 18 August 2026: it printed "Lockfile
 * passes supply-chain policies" and "Already up to date" while three
 * dependencies had newer versions, all three past the seven-day cooldown. The
 * cause is not the cooldown — this project pins exact versions, so nothing is
 * ever in range for `update` to move — and the message is true about what it did
 * while reading as an all-clear about what there is.
 *
 * The decision is tested here and the fetching is not. Three states are the
 * thing worth being sure about; a test that asked the registry for a publication
 * date would be checking the registry, and would go red the day a maintainer
 * publishes.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { cooldownPolicy, cooldownVerdict } from "../../tools/dependency-cooldown.mjs";

const WEEK_MINUTES = 10080;
const policy = { windowMs: WEEK_MINUTES * 60 * 1000, excluded: new Set<string>() };
const NOW = new Date("2026-08-18T12:00:00.000Z");

describe("where a candidate version stands against the cooldown", () => {
  it("is available once it is older than the window", () => {
    const verdict = cooldownVerdict({
      name: "typescript",
      version: "7.0.2",
      publishedAt: "2026-08-01T00:00:00.000Z",
      now: NOW,
      policy,
    });

    expect(verdict.state).toBe("available");
  });

  it("is held while it is younger, and says until when", () => {
    const verdict = cooldownVerdict({
      name: "typescript",
      version: "7.0.2",
      publishedAt: "2026-08-17T00:00:00.000Z",
      now: NOW,
      policy,
    });

    expect(verdict.state).toBe("held");
    expect(verdict.eligibleAt?.toISOString()).toBe("2026-08-24T00:00:00.000Z");
  });

  /**
   * The boundary, in the direction that matters: `minimumReleaseAge` is the age a
   * version must reach, so reaching it exactly is enough. An off-by-one the other
   * way would hold a version for a further day and be invisible — the report
   * would simply name tomorrow, every day.
   */
  it("is available at exactly the window, not a moment after", () => {
    const publishedAt = new Date(NOW.getTime() - policy.windowMs).toISOString();

    expect(cooldownVerdict({ name: "x", version: "1", publishedAt, now: NOW, policy }).state).toBe(
      "available",
    );
  });

  /**
   * An emergency patch listed in `minimumReleaseAgeExclude` is not held, and this
   * report must not say it is: the exclusion is written as `pkg@1.2.3`, one
   * version at a time, so it applies to that version and no other.
   */
  it("does not hold a version the workspace excludes by name", () => {
    const excluding = { ...policy, excluded: new Set(["left-pad@1.2.3"]) };
    const publishedAt = NOW.toISOString();

    expect(
      cooldownVerdict({
        name: "left-pad",
        version: "1.2.3",
        publishedAt,
        now: NOW,
        policy: excluding,
      }).state,
    ).toBe("available");
    expect(
      cooldownVerdict({
        name: "left-pad",
        version: "1.2.4",
        publishedAt,
        now: NOW,
        policy: excluding,
      }).state,
    ).toBe("held");
  });

  /**
   * A registry that gives no date for the version is its own answer. Reported as
   * unknown rather than folded into either side: calling it available would let
   * an unaged version through on missing data, and calling it held would name a
   * date that does not exist.
   */
  it("says so when the registry gives no date", () => {
    const verdict = cooldownVerdict({
      name: "x",
      version: "1",
      publishedAt: undefined,
      now: NOW,
      policy,
    });

    expect(verdict.state).toBe("unknown");
  });
});

describe("the report itself", () => {
  /**
   * A tool nobody can run is a tool nobody runs. It is deliberately not part of
   * `check` — it needs the network and would go red the day any maintainer
   * publishes — so the script is the whole of its wiring.
   */
  it("is reachable by name", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../../package.json"), "utf8"),
    ) as { readonly scripts: Readonly<Record<string, string>> };

    expect(manifest.scripts["deps:behind"]).toBe("node tools/dependency-cooldown.mjs");
  });
});

describe("the policy the report measures against", () => {
  /**
   * Read from `pnpm-workspace.yaml` and not retyped. A copy of the threshold in
   * the tool would be a second number to keep level, which is the failure this
   * project has spent the month finding.
   */
  it("comes from the workspace file", () => {
    const read = cooldownPolicy(`
minimumReleaseAge: ${WEEK_MINUTES}
minimumReleaseAgeExclude: [left-pad@1.2.3]
`);

    expect(read.windowMs).toBe(WEEK_MINUTES * 60 * 1000);
    expect(read.excluded.has("left-pad@1.2.3")).toBe(true);
  });

  it("refuses a workspace that declares none, rather than assuming one", () => {
    expect(() => cooldownPolicy("packages: []\n")).toThrow(/minimumReleaseAge/);
  });

  it("reads the number this repository actually declares", () => {
    expect(cooldownPolicy().windowMs).toBe(WEEK_MINUTES * 60 * 1000);
  });
});

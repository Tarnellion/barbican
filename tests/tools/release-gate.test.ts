/**
 * The four facts a release has to answer for, and nothing else can.
 *
 * `release.yml` calls the whole CI gate — that part is held by
 * `tests/workflows/release-gate.test.ts`. CI answers for the *tree*: it lints,
 * types, tests, scans and packs whatever commit it is given. What it cannot
 * answer for is the *tag*, because on a pull request there is no tag: whether it
 * names the version the package declares, whether the commit under it is on
 * `main`, which dist-tag the publish will take, and whether the registry already
 * has that version. The audit of 20 August 2026 found all four open, and the
 * first one open in the way this repository keeps rediscovering — the step
 * comparing the tag with `package.json` could be deleted and the whole suite
 * stayed green.
 *
 * So the decisions live in `tools/release-gate.mjs` as functions, and this file
 * is what holds them. Weaken one and these assertions go red; delete the step
 * that calls the script and the workflow test next door goes red. Neither guard
 * substitutes for the other: one says the answer is right, the other says
 * somebody asks the question.
 *
 * Everything here is pure except the last block, which drives real git in a
 * repository built for the occasion. Nothing touches the network: the registry
 * is a list of version strings passed in, because a guard that needs npm to be
 * reachable is a guard that goes yellow on a bad morning and gets deleted.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  compareVersions,
  distTagOf,
  mainRefIn,
  NOTES_MINIMUM,
  sectionOf,
  versionOfTag,
  whyNoDistTag,
  whyNotDescribed,
  whyNotOnMain,
  whyRegistryRefuses,
  whyTagDisagrees,
} from "../../tools/release-gate.mjs";

describe("the version a tag names", () => {
  it("is the tag without its v", () => {
    expect(versionOfTag("v0.5.0")).toBe("0.5.0");
    expect(versionOfTag("v10.20.30")).toBe("10.20.30");
    expect(versionOfTag("v0.5.0-rc.1")).toBe("0.5.0-rc.1");
  });

  /**
   * The trigger is `v*`, which is a glob and not a grammar: `vnext`, `v0.5` and
   * `v0.5.0.1` all start a release run. A reader that shrugs at those would hand
   * the rest of the gate a version string nothing else can compare.
   */
  it("is nothing at all when the tag is not v<semver>", () => {
    for (const ref of ["0.5.0", "v0.5", "vnext", "v0.5.0.1", "release-0.5.0", "v"]) {
      expect(versionOfTag(ref), ref).toBeUndefined();
    }
  });
});

describe("the tag and the version in package.json", () => {
  it("agree, or the reason names both", () => {
    expect(whyTagDisagrees("v0.5.0", "0.5.0")).toBeUndefined();

    const disagreement = whyTagDisagrees("v0.5.0", "0.4.0") ?? "";
    expect(disagreement).toContain("0.5.0");
    expect(disagreement).toContain("0.4.0");
  });

  /**
   * A prerelease tag on a release version is the case that reads as agreement to
   * anything comparing only the numbers: `v0.5.0-rc.1` would publish the tree
   * that declares `0.5.0`, and the registry would then hold a `0.5.0-rc.1` whose
   * own `package.json` says something else.
   */
  it("do not agree when one of them carries a prerelease and the other does not", () => {
    expect(whyTagDisagrees("v0.5.0-rc.1", "0.5.0")).toBeDefined();
    expect(whyTagDisagrees("v0.5.0", "0.5.0-rc.1")).toBeDefined();
    expect(whyTagDisagrees("v0.5.0-rc.1", "0.5.0-rc.1")).toBeUndefined();
  });

  it("cannot agree when the tag is not a version", () => {
    expect(whyTagDisagrees("vnext", "0.5.0")).toBeDefined();
    expect(whyTagDisagrees(undefined, "0.5.0")).toBeDefined();
  });
});

/**
 * Precedence, by the semver rules rather than by string order.
 *
 * The two that a hand-rolled comparison gets wrong are here on purpose: `0.10.0`
 * against `0.9.0`, where lexical order says the wrong thing, and a prerelease
 * against its release, where the shorter string is the greater version.
 */
describe("which of two versions is the newer", () => {
  it("compares the numbers as numbers", () => {
    expect(compareVersions("0.4.0", "0.5.0")).toBeLessThan(0);
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
    expect(compareVersions("0.5.0", "0.5.0")).toBe(0);
  });

  it("puts a prerelease below the release it leads to", () => {
    expect(compareVersions("0.5.0-rc.1", "0.5.0")).toBeLessThan(0);
    expect(compareVersions("0.5.0", "0.5.0-rc.1")).toBeGreaterThan(0);
  });

  it("orders prereleases among themselves the way semver says", () => {
    expect(compareVersions("0.5.0-alpha", "0.5.0-beta")).toBeLessThan(0);
    expect(compareVersions("0.5.0-rc.1", "0.5.0-rc.2")).toBeLessThan(0);
    expect(compareVersions("0.5.0-rc.2", "0.5.0-rc.10")).toBeLessThan(0);
    expect(compareVersions("0.5.0-rc.1", "0.5.0-rc.1.1")).toBeLessThan(0);
    // A numeric identifier is below an alphanumeric one.
    expect(compareVersions("0.5.0-1", "0.5.0-alpha")).toBeLessThan(0);
  });
});

/**
 * The dist-tag a publish will take.
 *
 * `npm publish` with no `--tag` writes `latest`, and `v0.5.0-rc.1` matches the
 * `v*` trigger, so a release candidate became the version `npm install barbican`
 * hands out. Found by the audit of 20 August 2026.
 */
describe("the dist-tag a version publishes under", () => {
  it("is latest for a release and the prerelease's own word otherwise", () => {
    expect(distTagOf("0.5.0")).toBe("latest");
    expect(distTagOf("0.5.0-rc.1")).toBe("rc");
    expect(distTagOf("1.0.0-beta.2")).toBe("beta");
    expect(distTagOf("1.0.0-next")).toBe("next");
  });

  /**
   * A prerelease whose first identifier is a number gives `--tag 1`, and a
   * dist-tag `latest` gives a release candidate the name of the stable channel.
   * Both are refused rather than guessed at: the gate does not get to invent the
   * channel somebody's `npm install` reads.
   */
  it("is refused rather than invented when the prerelease has no usable word", () => {
    for (const version of ["0.5.0-1", "0.5.0-latest", "0.5.0-RC.1", "0.5.0-.1", "nonsense"]) {
      expect(distTagOf(version), version).toBeUndefined();
      expect(whyNoDistTag(version), version).toBeDefined();
    }
    expect(whyNoDistTag("0.5.0")).toBeUndefined();
    expect(whyNoDistTag("0.5.0-rc.1")).toBeUndefined();
  });
});

/**
 * What the registry already holds.
 *
 * Without this the answer arrives as a 409 from npm, after the whole gate has
 * run — four jobs, a build and a pack, to find out something one request could
 * have said at the start.
 */
describe("the registry, asked before the work rather than after it", () => {
  it("accepts a version nobody has published", () => {
    expect(whyRegistryRefuses("0.5.0", ["0.3.0", "0.4.0"], "latest")).toBeUndefined();
    expect(whyRegistryRefuses("0.1.0", [], "latest")).toBeUndefined();
  });

  it("refuses one that is already there", () => {
    const refusal = whyRegistryRefuses("0.4.0", ["0.3.0", "0.4.0"], "latest") ?? "";
    expect(refusal).toContain("0.4.0");
    expect(refusal).toContain("already");
  });

  /**
   * The harm a 409 does not describe: `latest` is what `npm install barbican`
   * resolves to, so publishing an older version there walks every new consumer
   * backwards. A patch on an older line is a real thing to want — it just does
   * not take `latest`, and the message says so.
   */
  it("refuses to walk latest backwards", () => {
    const refusal = whyRegistryRefuses("0.4.1", ["0.4.0", "0.5.0"], "latest") ?? "";
    expect(refusal).toContain("0.5.0");
    expect(refusal).toContain("latest");

    // The same version under a channel of its own is fine: nothing moves.
    expect(whyRegistryRefuses("0.4.1", ["0.4.0", "0.5.0"], "hotfix")).toBeUndefined();
  });

  /**
   * A published release candidate does not block the release it leads to, and a
   * newer candidate does not block a patch to the stable line — only published
   * *releases* are what `latest` is measured against.
   */
  it("measures latest against the releases, not against the candidates", () => {
    expect(whyRegistryRefuses("0.5.0", ["0.4.0", "0.5.0-rc.1"], "latest")).toBeUndefined();
    expect(whyRegistryRefuses("0.5.1", ["0.5.0", "0.6.0-rc.1"], "latest")).toBeUndefined();
  });
});

/**
 * The description of what is being released.
 *
 * ADR-0034 put the description where a consumer reads it and renamed it at
 * release time. What nothing asked was whether the renamed section says
 * anything: `### Unreleased` needs a body of substance while it is unreleased,
 * and on the release commit the same text became a heading that only had to
 * exist. Rename it, delete the paragraphs, tag — and `0.3.0` happens again.
 */
describe("the README describes the version being released", () => {
  const notes = "x".repeat(NOTES_MINIMUM + 1);

  it("is satisfied by a named section with something under it", () => {
    expect(
      whyNotDescribed(`## Install\n\n### What changed in 0.5.0\n\n${notes}\n`, "0.5.0"),
    ).toBeUndefined();
  });

  it("is not satisfied by a heading with nothing under it", () => {
    const refusal = whyNotDescribed("### What changed in 0.5.0\n\ntoo short\n", "0.5.0") ?? "";
    expect(refusal).toContain("0.5.0");
  });

  it("is not satisfied by the section of some other version", () => {
    expect(whyNotDescribed(`### What changed in 0.4.0\n\n${notes}\n`, "0.5.0")).toBeDefined();
  });

  /**
   * And the section that was renamed is gone. A README carrying both says two
   * things about one release, and the one a reader believes is whichever they
   * reach first.
   */
  it("is not satisfied while an Unreleased section is still standing", () => {
    const both = `### What changed in 0.5.0\n\n${notes}\n\n### Unreleased\n\n${notes}\n`;
    const refusal = whyNotDescribed(both, "0.5.0") ?? "";
    expect(refusal).toContain("Unreleased");
  });

  it("reads a section up to the next heading and no further", () => {
    const readme = "### Unreleased\n\nfirst\n\n### What changed in 0.4.0\n\nsecond\n";

    expect(sectionOf(readme, "### Unreleased")).toContain("first");
    expect(sectionOf(readme, "### Unreleased")).not.toContain("second");
    expect(sectionOf(readme, "### What changed in 0.9.9")).toBeUndefined();
  });
});

/**
 * The commit under the tag is one `main` carries.
 *
 * The trigger is a tag glob, and a tag can be put on anything a laptop has: a
 * branch that never merged, a commit that was rebased away, a fork's history. It
 * would publish with provenance attesting to a repository whose `main` never
 * held that code. Driven against real git rather than a fake, because what is
 * under test is a claim about git's answer.
 */
describe("the commit under the tag is on main", () => {
  const workspace = mkdtempSync(join(tmpdir(), "barbican-release-gate-"));

  const git = (cwd: string, ...args: readonly string[]): string =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.invalid",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd, encoding: "utf8" },
    ).trim();

  /** A repository with one commit on `main` and one on a branch that never merged. */
  const repo = join(workspace, "repo");
  execFileSync("git", ["init", "-q", repo]);
  git(repo, "symbolic-ref", "HEAD", "refs/heads/main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "on main");
  const onMain = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "-b", "elsewhere");
  git(repo, "commit", "-q", "--allow-empty", "-m", "not on main");
  const offMain = git(repo, "rev-parse", "HEAD");

  /** And one that has no `main` at all — a checkout that fetched only the tag. */
  const shallow = join(workspace, "shallow");
  execFileSync("git", ["init", "-q", shallow]);
  git(shallow, "symbolic-ref", "HEAD", "refs/heads/detached");
  git(shallow, "commit", "-q", "--allow-empty", "-m", "alone");
  const alone = git(shallow, "rev-parse", "HEAD");

  afterAll(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("built two histories rather than one, or it proves nothing", () => {
    expect(onMain).not.toBe(offMain);
    expect(mainRefIn(repo)).toBeDefined();
  });

  it("passes a commit main carries", () => {
    expect(whyNotOnMain(repo, onMain)).toBeUndefined();
  });

  it("refuses one it does not", () => {
    const refusal = whyNotOnMain(repo, offMain) ?? "";
    expect(refusal).toContain(offMain);
    expect(refusal).toContain("main");
  });

  /**
   * And refuses loudly when there is no `main` to compare against, rather than
   * passing by knowing nothing — which is the shape of guard this repository
   * keeps finding in its own CI.
   */
  it("refuses when the checkout has no main in it", () => {
    expect(mainRefIn(shallow)).toBeUndefined();
    expect(whyNotOnMain(shallow, alone)).toContain("fetch-depth");
  });
});

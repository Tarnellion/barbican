/**
 * Links in the documentation.
 *
 * Found while translating the ADRs into English:
 * `[ADR-0008](0008-run-configuration.md)` pointed at a file that does not
 * exist — the real name is `0008-run-configuration-format.md`. The link had
 * been broken since the day it was written, in the Russian version too: nobody
 * ever followed it.
 *
 * The same class as everything else in this project: the document claims the
 * reasoning behind a decision lives right here, and there is nothing there —
 * and the reader finds out exactly when the decision needed disputing.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Everything the repository carries, from git rather than from the disk.
 *
 * Walking the file system meant descending into `.claude/worktrees/`: of the 93
 * markdown files this visited, 41 were not the repository at all — checkouts of
 * other branches, whose broken links say nothing about this one and whose count
 * depends on what happened to be lying around. `language.test.ts` next door had
 * it right from the start. Found by the audit of 14 August 2026 (K-5).
 */
function trackedFiles(): readonly string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\u0000")
    .filter((one) => one !== "");
}

/**
 * Every tracked path, and every directory on the way to one, spelled the way git
 * records it.
 *
 * This set — and not the file system — is what a link target is checked against,
 * and the reason is the letter case. `existsSync` asks the file system, and the
 * file system on macOS, as on Windows, answers `true` for
 * `0003-CHECK-registry.md`. A link with the case wrong therefore passed on the
 * machine it was written on and failed on Linux CI: a gate red for a reason that
 * is not the contributor's, and a message that does not say so. The audit of
 * 14 August 2026 (K-6) found no such link in the repository at the time, which
 * is the only reason nobody had met it yet.
 *
 * The guard was rewritten on 15 August to take its **list of documents** from
 * `git ls-files` (K-5). That changed which files are scanned and nothing about
 * how their targets are checked, so the case-blindness outlived it — and it is
 * also what makes the cure cheap: git records a path with one spelling, and a
 * comparison against that record gives the same answer on every operating
 * system.
 *
 * Directories are in here because four links point at one — `docs/adr/`,
 * `examples/` — and git lists no directories of its own.
 */
function trackedPaths(files: readonly string[]): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const one of files) {
    paths.add(one);
    // `git ls-files` separates with `/` whatever the platform.
    for (let parent = posix.dirname(one); parent !== "."; parent = posix.dirname(parent)) {
      paths.add(parent);
    }
  }
  return paths;
}

/** Where a link points, as a repository path — the currency the tracked set uses. */
function targetOf(from: string, link: string): string {
  return relative(ROOT, resolve(dirname(join(ROOT, from)), link))
    .split(sep)
    .join("/");
}

/**
 * Whether the repository carries what a link points at.
 *
 * The set is a parameter rather than a constant this reads for itself, so that
 * the claim "this answers from the index and not from the disk" can be put to it
 * directly. A version of this function that consults the file system passes
 * every test below that uses the real set and fails the two that do not.
 */
function carries(paths: ReadonlySet<string>, from: string, link: string): boolean {
  return paths.has(targetOf(from, link));
}

/**
 * What `npm pack` puts in the tarball.
 *
 * `files` in `package.json`, plus the three npm always includes. A link is only
 * usable by whoever installed the package if its target is in here too.
 */
const SHIPPED = ["dist", "docs", "examples", "schema"];
const ALWAYS = new Set(["README.md", "LICENSE", "package.json"]);

function ships(repoPath: string): boolean {
  return (
    ALWAYS.has(repoPath) ||
    SHIPPED.some((directory) => repoPath === directory || repoPath.startsWith(`${directory}/`))
  );
}

/** Relative links only: external addresses need the network and are not checked here. */
function relativeLinks(repoPath: string): readonly string[] {
  const text = readFileSync(join(ROOT, repoPath), "utf8");
  return [...text.matchAll(/\[[^\]]*\]\(([^)#\s]+)(?:#[^)]*)?\)/g)]
    .map((match) => match[1] ?? "")
    .filter((target) => target !== "" && !/^(https?:|mailto:)/.test(target));
}

const files = trackedFiles();
const tracked = trackedPaths(files);
const documents = files.filter((one) => one.endsWith(".md"));

describe("links in the documentation", () => {
  it("finds documents instead of staying silent on an empty list", () => {
    // A test that found nothing is green for the same reason a passing one is.
    expect(documents.length).toBeGreaterThan(10);
  });

  it("lead to files that exist", () => {
    const broken: string[] = [];
    for (const file of documents) {
      for (const target of relativeLinks(file)) {
        if (!carries(tracked, file, target)) {
          broken.push(`${file} -> ${target}`);
        }
      }
    }

    expect(broken).toEqual([]);
  });

  /**
   * The answer comes from the repository's index and not from the disk.
   *
   * Put to a set made up for the occasion, because that is the one form of this
   * claim that means the same thing on every machine: one of the two files is on
   * disk and in the set, the other is on disk and out of it. Anything that
   * consults the file system agrees on the first and disagrees on the second,
   * here and on CI alike.
   */
  it("answers from what git records, not from what the disk holds", () => {
    const from = "docs/adr/0019-request-contexts.md";
    const pretend = new Set(["docs", "docs/adr", "docs/adr/0003-check-registry.md"]);
    const missingFromTheSet = "0028-the-policy-is-indexed-once.md";

    expect(existsSync(join(ROOT, "docs/adr", missingFromTheSet))).toBe(true);
    expect(carries(pretend, from, "0003-check-registry.md")).toBe(true);
    expect(carries(pretend, from, missingFromTheSet)).toBe(false);
  });

  /**
   * A link whose case is wrong leads nowhere, whatever this machine's file
   * system says about it.
   *
   * On macOS `existsSync` answers `true` for a name that differs only in case,
   * so this assertion is the finding itself: with the check made against the
   * file system it fails here and passes on Linux, which is the wrong way round
   * from every point of view. What this machine thinks is deliberately not
   * asserted — that would be a test with a different verdict per operating
   * system, the very thing being fixed.
   */
  it("does not accept a target whose letter case is wrong", () => {
    const from = "docs/adr/0019-request-contexts.md";

    expect(carries(tracked, from, "0003-check-registry.md")).toBe(true);
    expect(carries(tracked, from, "0003-Check-Registry.md")).toBe(false);
  });

  /**
   * And they lead somewhere for a reader who **installed** rather than cloned.
   *
   * `files: ["dist", "docs", "examples", "schema"]` leaves `polygon/`,
   * `tasks.md`, `plan.md`, the tests and the workflows outside the tarball, so
   * nine relative links in the shipped documents pointed at nothing under
   * `node_modules/barbican/`. The guard above stayed green on every one of them:
   * it resolves against the repository, where they all exist. Found by the audit
   * of 14 August 2026 (E-3).
   *
   * The fix for such a link is an absolute address on GitHub, which is what the
   * rest of the documents already use.
   */
  it("lead somewhere for a reader who installed the package", () => {
    const dead: string[] = [];
    for (const file of documents) {
      if (!ships(file)) {
        continue;
      }
      for (const target of relativeLinks(file)) {
        if (!ships(targetOf(file, target))) {
          dead.push(`${file} -> ${target}`);
        }
      }
    }

    expect(dead).toEqual([]);
  });
});

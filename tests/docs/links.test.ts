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
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The documents in the repository, from git rather than from the disk.
 *
 * Walking the file system meant descending into `.claude/worktrees/`: of the 93
 * markdown files this visited, 41 were not the repository at all — checkouts of
 * other branches, whose broken links say nothing about this one and whose count
 * depends on what happened to be lying around. `language.test.ts` next door had
 * it right from the start. Found by the audit of 14 August 2026 (K-5).
 */
function markdownFiles(): readonly string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\u0000")
    .filter((one) => one.endsWith(".md"))
    .map((one) => join(ROOT, one));
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
function relativeLinks(file: string): readonly string[] {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(/\[[^\]]*\]\(([^)#\s]+)(?:#[^)]*)?\)/g)]
    .map((match) => match[1] ?? "")
    .filter((target) => target !== "" && !/^(https?:|mailto:)/.test(target));
}

describe("links in the documentation", () => {
  const files = markdownFiles();

  it("finds documents instead of staying silent on an empty list", () => {
    // A test that found nothing is green for the same reason a passing one is.
    expect(files.length).toBeGreaterThan(10);
  });

  it("lead to files that exist", () => {
    const broken: string[] = [];
    for (const file of files) {
      for (const target of relativeLinks(file)) {
        if (!existsSync(resolve(dirname(file), target))) {
          broken.push(`${file.slice(ROOT.length + 1)} -> ${target}`);
        }
      }
    }

    expect(broken).toEqual([]);
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
    for (const file of files) {
      const from = relative(ROOT, file);
      if (!ships(from)) {
        continue;
      }
      for (const target of relativeLinks(file)) {
        const to = relative(ROOT, resolve(dirname(file), target));
        if (!ships(to)) {
          dead.push(`${from} -> ${target}`);
        }
      }
    }

    expect(dead).toEqual([]);
  });
});

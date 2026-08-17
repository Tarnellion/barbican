/**
 * The repository speaks English.
 *
 * Everything that goes to GitHub — code, comments, documentation, working notes,
 * the messages the tool prints — is written in English. The reason is not taste:
 * the repository is public, and a mixed language closes off exactly the part
 * where decisions are explained, which is the part worth reading.
 *
 * Russian copies live in `/_local/`, which is not tracked. They are a snapshot
 * for the owner, not a maintained translation: two language versions never stay
 * in agreement, and a silent disagreement is the very class of problem this tool
 * exists to catch.
 *
 * This test is the guard. Without it the rule survives exactly as long as
 * whoever writes the next comment remembers it.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Cyrillic: the main block plus the supplement, which carries the Ukrainian,
 * Belarusian and Slavic letters the main one misses.
 *
 * Written as escapes rather than as the characters themselves. With literal
 * endpoints this guard flagged its own source — and it only noticed once it was
 * committed, because until then git did not track it and it never looked at
 * itself. A check that cannot survive its own rule is not a rule.
 */
const CYRILLIC = /[\u0400-\u052f]/;

/**
 * Files tracked by git — the exact set that ends up on GitHub.
 *
 * Asking git rather than walking the tree is deliberate: `.gitignore` already
 * carries the answer to "does this go public", and a second, hand-written list
 * would drift away from it.
 */
function trackedFiles(): readonly string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter((path) => path !== "");
}

/** Binary files have no language; reading them as text proves nothing. */
const BINARY = /\.(png|jpg|jpeg|gif|ico|pdf|woff2?|zip|gz)$/i;

describe("the repository is in English", () => {
  const files = trackedFiles();

  it("sees the tracked files, rather than an empty list", () => {
    // A check that found nothing is green for the same reason a passing one is.
    expect(files.length).toBeGreaterThan(50);
  });

  it("has no Cyrillic in anything tracked by git", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (BINARY.test(file)) {
        continue;
      }
      // `git ls-files` lists what is tracked, which includes a file deleted in
      // the working tree but not yet staged. There is nothing to read and
      // nothing to complain about — and without this the guard died with an
      // ENOENT naming a file the reader had just deleted on purpose.
      if (!existsSync(resolve(ROOT, file))) {
        continue;
      }
      const text = readFileSync(resolve(ROOT, file), "utf8");
      const lines = text.split("\n");
      const first = lines.findIndex((line) => CYRILLIC.test(line));
      if (first !== -1) {
        offenders.push(`${file}:${first + 1}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

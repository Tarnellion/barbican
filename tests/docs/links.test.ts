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

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SKIP = new Set(["node_modules", ".git", "dist", "coverage", "_local"]);

function markdownFiles(directory: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) {
      continue;
    }
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...markdownFiles(full));
    } else if (entry.name.endsWith(".md")) {
      found.push(full);
    }
  }
  return found;
}

/** Relative links only: external addresses need the network and are not checked here. */
function relativeLinks(file: string): readonly string[] {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(/\[[^\]]*\]\(([^)#\s]+)(?:#[^)]*)?\)/g)]
    .map((match) => match[1] ?? "")
    .filter((target) => target !== "" && !/^(https?:|mailto:)/.test(target));
}

describe("links in the documentation", () => {
  const files = markdownFiles(ROOT);

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
});

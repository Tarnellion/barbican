/**
 * The checklist for a first run against somebody else's platform.
 *
 * `docs/first-run.md` is the one document written to be read *before* the first
 * request, and it is made of things this repository already knows — a canary
 * that tells this account from nobody, the arithmetic `--dry-run` prints, where
 * the report goes when nobody names a path. Scattered across a 1300-line guide
 * they are findable by somebody who has already read it once, which is not the
 * person about to make the traffic.
 *
 * Two things are guarded here, and the second is the one with a history.
 *
 * **That the document says what it is for.** Each item below is a decision an
 * operator makes once and cannot take back, so a checklist missing one of them
 * is worse than no checklist: it reads as complete.
 *
 * **That the document is reachable.** `links.test.ts` next door checks that
 * every link leads somewhere; nothing checked that anything leads *here*.
 * `docs/polygons/juice-shop.md` spent its first days in that state — a tracked,
 * finished, entirely unreferenced page — and the guard stayed green throughout,
 * because a document nobody links to has no broken links. Reachability is the
 * property that was missing, so it is the property asserted: a walk from
 * `README.md` over the repository's own markdown has to arrive at this file.
 */

import { execFileSync } from "node:child_process";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { read } from "./markdown.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const CHECKLIST = "docs/first-run.md";

/** What the repository carries, from git rather than from the disk — as in `links.test.ts`. */
function trackedFiles(): readonly string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\u0000")
    .filter((one) => one !== "");
}

/** Relative link targets of one document, as repository paths. */
function linksFrom(repoPath: string): readonly string[] {
  return [...read(repoPath).matchAll(/\[[^\]]*\]\(([^)#\s]+)(?:#[^)]*)?\)/g)]
    .map((match) => match[1] ?? "")
    .filter((target) => target !== "" && !/^(https?:|mailto:)/.test(target))
    .map((target) =>
      relative(ROOT, resolve(dirname(join(ROOT, repoPath)), target))
        .split(sep)
        .join("/"),
    );
}

/**
 * Every document a reader can walk to from the README, following relative links.
 *
 * Absolute GitHub addresses are deliberately not followed. A link that leaves
 * the repository is a link the reader has to already be online for, and the
 * question here is whether the document is part of the documentation — not
 * whether a URL exists.
 */
function reachableFromReadme(): ReadonlySet<string> {
  const documents = new Set(trackedFiles().filter((one) => one.endsWith(".md")));
  const seen = new Set<string>(["README.md"]);
  const queue: string[] = ["README.md"];

  while (queue.length > 0) {
    const current = queue.shift() ?? "";
    if (!documents.has(current)) {
      continue;
    }
    for (const target of linksFrom(current)) {
      if (!seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return seen;
}

describe("the first-run checklist is reachable", () => {
  const reachable = reachableFromReadme();

  it("walks somewhere, rather than answering from an empty set", () => {
    // A walk that found nothing would agree with a repository of orphans.
    expect(reachable.size).toBeGreaterThan(20);
  });

  it("is arrived at from README.md", () => {
    expect([...reachable].filter((one) => one === CHECKLIST)).toEqual([CHECKLIST]);
  });

  /**
   * And from the guide, directly. The README is where a stranger starts; the
   * guide is where the operator already is when they decide to run, and a
   * document reachable only through the front page is one they will not meet.
   */
  it("is linked from docs/guide.md", () => {
    expect(linksFrom("docs/guide.md")).toContain(CHECKLIST);
  });
});

/**
 * The items. Each is a thing already decided somewhere in this repository, and
 * each is a decision the operator cannot walk back after the first request.
 */
const ITEMS = [
  {
    what: "written permission, naming the deployment and the window",
    patterns: [/in writing/i, /window/i],
  },
  {
    what: "the mandatory host allowlist",
    patterns: [/allowedHosts/],
  },
  {
    what: "exclude, as the only guard against a GET that does something",
    patterns: [/exclude/, /createdb/i],
  },
  {
    what: "a canary per account that a request with no credentials cannot pass",
    patterns: [/canary/i, /no credentials|without credentials/i, /0040/],
  },
  {
    what: "the request arithmetic, and that --dry-run prints it",
    patterns: [/--dry-run/, /--max-requests/, /canary requests/],
  },
  {
    what: "the walk against the lifetime of a token",
    patterns: [/--rps/, /headersFor/, /lifetime|expire/i],
  },
  {
    what: "how large a matrix stays practical, and whose decision the wall is",
    patterns: [/30 000/, /692 000/, /74 000/],
  },
  {
    what: "identifying the run on the wire, and why the target's owner wants it",
    patterns: [/user-agent/i, /--no-identify/, /runId/],
  },
  {
    what: "where the report goes when nobody names a path",
    patterns: [/--report/, /stdout/],
  },
  {
    what: "the stream beside the report, and --resume",
    patterns: [/--resume/, /stream\.ndjson/],
  },
  {
    what: "what the tool structurally cannot see",
    patterns: [/cannot see|does not see|structurally/i, /\b202\b/, /refuses? with (?:a )?200/i],
  },
] as const;

describe("the first-run checklist says what it is for", () => {
  it("is long enough to be a checklist", () => {
    expect(read(CHECKLIST).length).toBeGreaterThan(4000);
  });

  for (const { what, patterns } of ITEMS) {
    it(`covers ${what}`, () => {
      const text = read(CHECKLIST);

      for (const pattern of patterns) {
        expect(text).toMatch(pattern);
      }
    });
  }
});

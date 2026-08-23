/**
 * A doc comment describes the symbol under it.
 *
 * In this repository a comment carries the *reasoning* — why a decision went one
 * way and not the other — which makes a detached one expensive in a way a merely
 * stale comment is not: it is often the only record of an argument. Fourteen of
 * them were found on 22 August 2026, and one described a security guarantee that
 * had moved: the reader of `sanitizeLocation` was told the redirect **path**
 * reaches the report, when since 17 August only the origin does. A reader who
 * believes that treats the artifact as a carrier of a password-reset path.
 *
 * The shape this file can detect is the mechanical one: a doc block followed,
 * after nothing but whitespace, by another doc block. Only the second attaches
 * to anything — TypeScript, an editor's quick-info and any documentation tool
 * read the nearest one — so the first is prose no tool will ever show beside a
 * symbol, whether it was left behind by a symbol that moved or superseded by the
 * block written under it. Twelve were found by reading, and this gate turned up
 * twelve more that nobody had been looking for. See ADR-0062.
 *
 * What it cannot detect is said out loud further down, beside the two
 * occurrences it is knowingly green about.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Files tracked by git — the same set `language.test.ts` and `links.test.ts`
 * ask about, and for the same reason: `.gitignore` already answers "does this go
 * public", and a second hand-written list drifts away from it. Walking the disk
 * would also descend into `.claude/worktrees/`, where other branches live.
 */
function trackedSources(): readonly string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter((path) => path.endsWith(".ts") || path.endsWith(".mjs"));
}

interface DocBlock {
  /** 0-based line the block opens on. */
  readonly start: number;
  /** 0-based line the block closes on. */
  readonly end: number;
  /** Whether any line of it is a JSDoc tag: `@param`, `@typedef`, `@property`. */
  readonly tagged: boolean;
}

/**
 * Every doc block in a file, in order.
 *
 * Line-based and not a parser. A parser would be right about a `/**` inside a
 * string literal and is a dependency and a second grammar to keep; the shape
 * being looked for is a layout, and the cost of being wrong about it is a false
 * name on a list a human reads. The one place the difference would show is a
 * source file that prints doc comments as data, and this file is the only one
 * that does — see the samples below, which are assembled so that the tokens
 * never appear in its text.
 */
function docBlocks(lines: readonly string[]): readonly DocBlock[] {
  const blocks: DocBlock[] = [];
  let start = -1;
  const tag = (from: number, to: number): boolean =>
    lines
      .slice(from, to + 1)
      .some((line) => /^\s*\*?\s*@[a-z]/.test(line.replace(/^\s*\/\*\*/, "")));

  lines.forEach((raw, index) => {
    const text = raw.trim();
    if (start === -1) {
      if (!text.startsWith("/**")) {
        return;
      }
      if (text.length > 3 && text.endsWith("*/")) {
        blocks.push({ start: index, end: index, tagged: tag(index, index) });
        return;
      }
      start = index;
      return;
    }
    if (text.endsWith("*/")) {
      blocks.push({ start, end: index, tagged: tag(start, index) });
      start = -1;
    }
  });
  return blocks;
}

/**
 * The lines where one doc block stands directly over another, with two shapes
 * left out because they are not this defect.
 *
 * **A block that opens the file.** Nothing precedes it, so it cannot have been
 * detached from anything: it is the module's header, and the block under it
 * belongs to the module's first symbol. `src/core/order.ts` and
 * `src/core/standards/types.ts` are that arrangement, and it is the normal one
 * in this repository — most files only escape this rule by having imports
 * between the two.
 *
 * **A block carrying a JSDoc tag.** The `.mjs` tools are typed by JSDoc, and
 * `tools/oracle/index.mjs` and `tools/release-gate.mjs` deliberately keep the
 * `@typedef` and `@param` lines in a block of their own next to the prose. A
 * `@typedef` is a declaration in its own right and needs no symbol under it at
 * all. Excluding these costs the gate nothing it could have judged: the two
 * blocks in such a pair are one comment written in two registers.
 */
function detachedDocBlocks(text: string): readonly number[] {
  const lines = text.split("\n");
  const blocks = docBlocks(lines);
  const found: number[] = [];
  for (let index = 1; index < blocks.length; index += 1) {
    const above = blocks[index - 1];
    const below = blocks[index];
    if (above === undefined || below === undefined) {
      continue;
    }
    if (!lines.slice(above.end + 1, below.start).every((line) => line.trim() === "")) {
      continue;
    }
    const opensTheFile = lines
      .slice(0, above.start)
      .every((line) => line.trim() === "" || line.startsWith("#!"));
    if (opensTheFile || above.tagged || below.tagged) {
      continue;
    }
    found.push(above.start + 1);
  }
  return found;
}

/**
 * The occurrences this gate is knowingly green about, and why each one is here.
 *
 * Counted rather than located, so that an edit elsewhere in the file does not
 * turn the list red for moving a line. Asserted **exactly**: a new occurrence in
 * one of these files fails, and so does the disappearance of one — an entry that
 * has been fixed has to be deleted, which is the property an exception list
 * needs to not become a pin nobody notices. The same rule `pnpm-workspace.yaml`
 * lives by for an override, and `osv-scanner.toml` for an expiry.
 *
 * - **`src/core/checks/clauses.ts`** — this is what no gate can catch. The block
 *   there heads a *group*: three constants, with the reasoning for how all three
 *   are named. Nothing attaches it, so the layout is identical to a detached
 *   one, and only a reader can tell that its subject is the run below rather
 *   than one declaration. A rule that flagged it would be a rule people satisfy
 *   with a blank line, which fixes nothing. This entry is permanent unless the
 *   header stops being a header.
 */
const KNOWN_OCCURRENCES: Readonly<Record<string, number>> = {
  "src/core/checks/clauses.ts": 1,
};

describe("a doc comment sits on the symbol it describes", () => {
  const sources = trackedSources();
  const byFile: Record<string, number> = {};
  for (const file of sources) {
    const count = detachedDocBlocks(readFileSync(join(ROOT, file), "utf8")).length;
    if (count > 0) {
      byFile[file] = count;
    }
  }

  it("reads the tracked sources, rather than an empty list", () => {
    // A check that found nothing is green for the same reason a passing one is.
    expect(sources.length).toBeGreaterThan(50);
  });

  /**
   * One assertion for both directions. A new detached block fails it, and so
   * does an entry above that somebody fixed without deleting the entry — which
   * is the failure mode of every exception list that outlives its reason.
   */
  it("has no doc block standing over another, beyond the two named above", () => {
    const where = Object.entries(byFile)
      .map(([file, count]) => `${file} (${count})`)
      .sort();
    const expected = Object.entries(KNOWN_OCCURRENCES)
      .map(([file, count]) => `${file} (${count})`)
      .sort();

    expect(where).toEqual(expected);
  });

  /**
   * Put to the reader directly, because the assertion above is a claim about the
   * repository only if the reader says yes to something.
   *
   * The samples are assembled from pieces so that the comment tokens never occur
   * in this file's text: written out, a two-block sample would be a real
   * occurrence in a tracked file and the scan above would find it here.
   * `language.test.ts` next door was caught by exactly that, and only after the
   * commit that made it visible to itself.
   */
  const OPEN = `/*${"*"}`;
  const CLOSE = `${"*"}/`;
  const block = (...lines: readonly string[]): string =>
    [OPEN, ...lines.map((line) => ` * ${line}`), ` ${CLOSE}`].join("\n");

  it("finds a block standing over another", () => {
    const source = [
      "import { x } from './x.js';",
      "",
      block("The subject that moved."),
      block("The neighbour."),
      "export const a = 1;",
    ];

    expect(detachedDocBlocks(source.join("\n"))).toEqual([3]);
  });

  it("says nothing about a block with its symbol under it", () => {
    const source = [
      block("The one comment."),
      "export const a = 1;",
      "",
      block("The other."),
      "export const b = 2;",
    ];

    expect(detachedDocBlocks(source.join("\n"))).toEqual([]);
  });

  it("does not take a module header for a detached block", () => {
    const source = [
      block("What this module is."),
      "",
      block("The first symbol."),
      "export const a = 1;",
    ];

    expect(detachedDocBlocks(source.join("\n"))).toEqual([]);
  });

  it("does not take a JSDoc annotation kept beside its prose for one", () => {
    const source = [
      "import { x } from './x.js';",
      "",
      block("What the function is for."),
      block("@param {string} name"),
      "export function f(name) { return name; }",
    ];

    expect(detachedDocBlocks(source.join("\n"))).toEqual([]);
  });

  /** Blank lines between the two are still nothing but whitespace. */
  it("is not fooled by a blank line between them", () => {
    const source = [
      "import { x } from './x.js';",
      "",
      block("The subject that moved."),
      "",
      "",
      block("The neighbour."),
      "export const a = 1;",
    ];

    expect(detachedDocBlocks(source.join("\n"))).toEqual([3]);
  });

  /** A single-line doc block is a doc block: both halves of a pair may be one. */
  it("counts a one-line block on either side of the pair", () => {
    const source = [
      "import { x } from './x.js';",
      "",
      `${OPEN} The subject that moved. ${CLOSE}`,
      block("The neighbour."),
      "export const a = 1;",
    ];

    expect(detachedDocBlocks(source.join("\n"))).toEqual([3]);
  });
});

/**
 * A doc comment describes the symbol under it.
 *
 * In this repository a comment carries the *reasoning* — why a decision went one
 * way and not the other — which makes a detached one expensive in a way a merely
 * stale comment is not: it is often the only record of an argument. Twelve of
 * them were found by reading on 22 August 2026, and one described a security
 * guarantee that had moved: the reader of `sanitizeLocation` was told the
 * redirect **path** reaches the report, when since 17 August only the origin
 * does. A reader who believes that treats the artifact as a carrier of a
 * password-reset path.
 *
 * The shape this file can detect is the mechanical one: a doc block followed,
 * after nothing but blank lines and `//` comments, by another doc block. Only
 * the second attaches to anything — TypeScript, an editor's quick-info and any
 * documentation tool read the nearest one — so the first is prose no tool will
 * ever show beside a symbol, whether it was left behind by a symbol that moved
 * or superseded by the block written under it. The gate written for the class
 * turned up twelve more that nobody had been looking for. See ADR-0062.
 *
 * What it cannot detect is said out loud further down, beside the one occurrence
 * it is knowingly green about and the seven module headers it lets through by
 * name.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Every extension in the JavaScript family, not the two the repository happens
 * to hold.
 *
 * `.ts` and `.mjs` are all there is here today, and a filter written from that
 * fact is a gate one `.js` file walks around — the adversarial review of
 * 23 August 2026 named the extension list as a way past this check. The set is
 * therefore what Node and TypeScript will load, so a file in a new dialect is
 * scanned the day it is added rather than the day somebody remembers this line.
 *
 * Out of scope, and deliberately: a doc comment inside a fenced block in a
 * markdown file, and one inside a JSON string. Neither is source, and neither
 * shows up beside a symbol in an editor.
 */
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;

/**
 * Files tracked by git — the same set `language.test.ts` and `links.test.ts`
 * ask about, and for the same reason: `.gitignore` already answers "does this go
 * public", and a second hand-written list drifts away from it. Walking the disk
 * would also descend into `.claude/worktrees/`, where other branches live.
 */
function trackedSources(): readonly string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter((path) => SOURCE.test(path));
}

interface DocBlock {
  /** 0-based line the block opens on. */
  readonly start: number;
  /** 0-based line the block closes on. */
  readonly end: number;
  /** Whether it carries a `@typedef`, which declares a type in the block itself. */
  readonly declares: boolean;
  /** Whether it is nothing but JSDoc tags — its first line of prose is a tag. */
  readonly tagsOnly: boolean;
}

/** A block's lines with the comment furniture taken off, blank ones dropped. */
function contentOf(lines: readonly string[], from: number, to: number): readonly string[] {
  return lines
    .slice(from, to + 1)
    .map((line) =>
      line
        .trim()
        .replace(/^\/\*\*/, "")
        .replace(/\*\/$/, "")
        .replace(/^\*/, "")
        .trim(),
    )
    .filter((line) => line !== "");
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
  const shape = (from: number, to: number): Pick<DocBlock, "declares" | "tagsOnly"> => {
    const content = contentOf(lines, from, to);
    return {
      declares: content.some((line) => line.startsWith("@typedef")),
      tagsOnly: /^@[a-z]/.test(content[0] ?? ""),
    };
  };

  lines.forEach((raw, index) => {
    const text = raw.trim();
    if (start === -1) {
      if (!text.startsWith("/**")) {
        return;
      }
      if (text.length > 3 && text.endsWith("*/")) {
        blocks.push({ start: index, end: index, ...shape(index, index) });
        return;
      }
      start = index;
      return;
    }
    if (text.endsWith("*/")) {
      blocks.push({ start, end: index, ...shape(start, index) });
      start = -1;
    }
  });
  return blocks;
}

interface Scan {
  /** Lines where a doc block stands over another and nothing excuses it. */
  readonly detached: readonly number[];
  /** Lines where the pair is the first two blocks of the file — see below. */
  readonly moduleHeaders: readonly number[];
}

/**
 * Where one doc block stands directly over another, and which of those pairs the
 * gate lets through.
 *
 * "Directly" admits blank lines and `//` comments between the two, and the second
 * of those was a hole until 23 August 2026: the check required the gap to be
 * empty, so a single `// still true` line between a stale block and its
 * neighbour made the pair invisible. A line comment attaches nothing either, so
 * the block above it is exactly as detached as it was without it.
 *
 * Two shapes are let through, and neither is judged by name here:
 *
 * **A block carrying a `@typedef`.** It declares a type in its own body, so it
 * is not a comment that failed to attach — there is nothing under it it was
 * meant to describe. `tools/oracle/index.mjs` and `tools/release-gate.mjs` keep
 * their `@typedef` blocks that way.
 *
 * **A block that is nothing but tags.** The `.mjs` tools are typed by JSDoc and
 * keep `@param`/`@returns` in a block of their own under the prose; a block
 * whose first line is a tag is the tag half of the comment above it.
 *
 * That second rule used to read "a block carrying a JSDoc tag", on either side
 * of the pair, and it was justified in ADR-0062 with the claim that it "costs
 * the gate nothing it could have judged". The branch's own diff refuted that on
 * the day it was written: `src/runner/canaries.ts` had `probeCanaries`' prose
 * standing over the block for `assertCanariesUsable`, whose last five lines are
 * `@throws` — a detached block of exactly the kind this file exists for, and one
 * the old rule was green about. A block that mixes prose with tags is a comment
 * for a symbol, so it is judged like one now.
 *
 * The pair that opens a file is a third case and is **not** silently skipped: it
 * is reported separately and asserted by name below, because there is no way to
 * tell a module header from a block detached at the top of its module.
 */
function scanDocBlocks(text: string): Scan {
  const lines = text.split("\n");
  const blocks = docBlocks(lines);
  const detached: number[] = [];
  const moduleHeaders: number[] = [];
  for (let index = 1; index < blocks.length; index += 1) {
    const above = blocks[index - 1];
    const below = blocks[index];
    if (above === undefined || below === undefined) {
      continue;
    }
    const between = lines.slice(above.end + 1, below.start);
    if (!between.every((line) => line.trim() === "" || line.trim().startsWith("//"))) {
      continue;
    }
    if (above.declares || below.tagsOnly) {
      continue;
    }
    const opensTheFile = lines
      .slice(0, above.start)
      .every((line) => line.trim() === "" || line.startsWith("#!"));
    (opensTheFile ? moduleHeaders : detached).push(above.start + 1);
  }
  return { detached, moduleHeaders };
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

/**
 * The files whose first two doc blocks are a module header over the first
 * symbol's comment.
 *
 * A header is indistinguishable from a detached block by layout: nothing
 * precedes either, and both stand over a comment that belongs to something else.
 * Until 23 August 2026 the gate skipped the shape wherever it met it, which
 * means the finding this whole ADR was written for — `sanitizeLocation`'s stale
 * security note — would have been invisible had that function been the first
 * thing in its module.
 *
 * So the shape is counted instead of skipped, and the count is held to this
 * list. A new file that opens this way costs one line here and a reader's glance
 * at whether the first block really is about the module; a detached block that
 * lands at the top of one of these files makes the count two and fails. Most
 * files never appear because imports sit between the two blocks.
 */
const MODULE_HEADERS: Readonly<Record<string, number>> = {
  "src/core/calendar.ts": 1,
  "src/core/keys.ts": 1,
  "src/core/order.ts": 1,
  "src/core/path-parameters.ts": 1,
  "src/core/standards/types.ts": 1,
  "tools/cold-start.mjs": 1,
  "tools/oracle/index.mjs": 1,
};

function asList(counts: Readonly<Record<string, number>>): readonly string[] {
  return Object.entries(counts)
    .map(([file, count]) => `${file} (${count})`)
    .sort();
}

describe("a doc comment sits on the symbol it describes", () => {
  const sources = trackedSources();
  const detached: Record<string, number> = {};
  const headers: Record<string, number> = {};
  for (const file of sources) {
    const scan = scanDocBlocks(readFileSync(join(ROOT, file), "utf8"));
    if (scan.detached.length > 0) {
      detached[file] = scan.detached.length;
    }
    if (scan.moduleHeaders.length > 0) {
      headers[file] = scan.moduleHeaders.length;
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
  it("has no doc block standing over another, beyond the one named above", () => {
    expect(asList(detached)).toEqual(asList(KNOWN_OCCURRENCES));
  });

  /**
   * And the same in both directions for the headers, which is the whole point of
   * counting them rather than skipping them: a module that grows a detached
   * block at the top has two where this list says one.
   */
  it("opens each file with a header this list names, and no other block", () => {
    expect(asList(headers)).toEqual(asList(MODULE_HEADERS));
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
  const detachedIn = (...lines: readonly string[]): readonly number[] =>
    scanDocBlocks(lines.join("\n")).detached;

  it("finds a block standing over another", () => {
    expect(
      detachedIn(
        "import { x } from './x.js';",
        "",
        block("The subject that moved."),
        block("The neighbour."),
        "export const a = 1;",
      ),
    ).toEqual([3]);
  });

  it("says nothing about a block with its symbol under it", () => {
    expect(
      detachedIn(
        block("The one comment."),
        "export const a = 1;",
        "",
        block("The other."),
        "export const b = 2;",
      ),
    ).toEqual([]);
  });

  it("does not take a JSDoc annotation kept beside its prose for one", () => {
    expect(
      detachedIn(
        "import { x } from './x.js';",
        "",
        block("What the function is for."),
        block("@param {string} name"),
        "export function f(name) { return name; }",
      ),
    ).toEqual([]);
  });

  /**
   * The counterexample ADR-0062 was justified against, kept as a test.
   *
   * `probeCanaries`' prose over `assertCanariesUsable`'s block, which ends in
   * five `@throws` lines. The rule this replaced excused the pair because the
   * lower block carried a tag anywhere in it; a block that opens with prose is a
   * comment for a symbol whatever it ends with.
   */
  it("judges a pair whose lower block is prose with tags at the end", () => {
    expect(
      detachedIn(
        "import { x } from './x.js';",
        "",
        block("Checks that the accounts really are authenticated."),
        block("Whether the declared canaries can be probed at all.", "", "@throws {Unusable}"),
        "export function assertCanariesUsable() {}",
      ),
    ).toEqual([3]);
  });

  /** A `@typedef` declares a type in its own body: nothing under it is missing. */
  it("does not take a typedef block for a detached one", () => {
    expect(
      detachedIn(
        "import { x } from './x.js';",
        "",
        block("The shapes this module works with.", "", "@typedef {string} Name"),
        block("What the constant is for."),
        "export const a = 1;",
      ),
    ).toEqual([]);
  });

  /** Blank lines between the two are still nothing but whitespace. */
  it("is not fooled by a blank line between them", () => {
    expect(
      detachedIn(
        "import { x } from './x.js';",
        "",
        block("The subject that moved."),
        "",
        "",
        block("The neighbour."),
        "export const a = 1;",
      ),
    ).toEqual([3]);
  });

  /** Nor by a line comment, which attaches to nothing either. */
  it("is not fooled by a line comment between them", () => {
    expect(
      detachedIn(
        "import { x } from './x.js';",
        "",
        block("The subject that moved."),
        "// Still true, as far as it goes.",
        block("The neighbour."),
        "export const a = 1;",
      ),
    ).toEqual([3]);
  });

  /** A single-line doc block is a doc block: both halves of a pair may be one. */
  it("counts a one-line block on either side of the pair", () => {
    expect(
      detachedIn(
        "import { x } from './x.js';",
        "",
        `${OPEN} The subject that moved. ${CLOSE}`,
        block("The neighbour."),
        "export const a = 1;",
      ),
    ).toEqual([3]);
  });

  /**
   * The pair that opens a file is reported, not swallowed.
   *
   * Which is the difference between this gate and the one of 22 August: there,
   * a block detached at the top of its module was excused by the same rule that
   * excuses a module header, and nothing said so out loud.
   */
  it("reports a pair that opens the file as a header rather than skipping it", () => {
    const source = [
      block("What this module is."),
      "",
      block("The first symbol."),
      "export const a = 1;",
    ].join("\n");

    expect(scanDocBlocks(source).detached).toEqual([]);
    expect(scanDocBlocks(source).moduleHeaders).toEqual([1]);
  });

  /** A third block at the top is past the header, and is judged as usual. */
  it("judges the block after the header on its own merits", () => {
    const source = [
      block("What this module is."),
      "",
      block("The subject that moved."),
      block("The first symbol."),
      "export const a = 1;",
    ].join("\n");

    expect(scanDocBlocks(source).moduleHeaders).toEqual([1]);
    expect(scanDocBlocks(source).detached).toEqual([5]);
  });
});

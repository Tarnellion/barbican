/**
 * A transcript pasted into a document is a copy of program output, and nothing
 * re-runs the program.
 *
 * `docs/guide.md` printed `Cells a run would probe: 144, plus 8 canary requests`
 * while the command it quotes prints `144, plus 24 canary requests (8 accounts,
 * …)`. It was true when it was written: the canary cost one request then. The
 * document was read by whoever was deciding how many requests to allow against
 * somebody else's deployment, and the number it gave them was a third of the
 * real one — the same undercount ADR-0064's third item is about, arrived at
 * through prose instead of through arithmetic.
 *
 * So the arithmetic lines of a dry-run transcript are re-measured here. The
 * declaration is the reference polygon's own, the preview is the one
 * `src/cli/run.ts` calls, and a document that quotes those lines has to quote
 * this run's.
 *
 * **What this holds:** the two lines a reader takes a number from — `Matrix
 * rows:` and `Cells a run would probe:` — wherever a tracked markdown file
 * quotes them, against the polygon's real output. Both directions: a quotation
 * that stops matching fails, and one nobody knew about fails as unaccounted for
 * rather than passing unseen.
 *
 * **What it does not hold, and why:**
 *
 * - Only those two lines. The transcripts are abridged — `docs/guide.md` shows
 *   two of the polygon's seven endpoint rows and hand-aligns their columns,
 *   which the tool does not do. Requiring the whole block would mean printing
 *   all seven rows in a document whose subject is the two numbers, so the
 *   abridgement is stated in the prose beside it instead.
 * - It drives `describePlan` in this tree, not `dist/cli.js`. What the CLI does
 *   between the command line and that call — parsing the two files, expanding
 *   the policy, refusing an unusable canary — is outside it, and
 *   `polygon/verify.mjs` is what runs the built binary against the platform.
 * - A block that quotes a dry run of some *other* declaration is listed below
 *   with its reason instead of being checked. There is one, and its numbers are
 *   held by the test that owns the same transcript.
 * - Only markdown. `tests/runner/unsafe-canary.test.ts` carries the same
 *   transcript as ADR-0042 in its header comment; the two are checked against
 *   each other by `tests/docs/detached-comments.test.ts`, not here.
 * - Only a transcript — a line inside a fenced or indented code block. Prose
 *   quoting the bill inline, as README's account of this very defect does, is
 *   the history of a number rather than a copy of it, and is left alone.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { polygonDeclaration, previewOf } from "../fixtures/preview-against-the-walk.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The line every transcript under test quotes, and the anchor the blocks are found by. */
const BILL = "Cells a run would probe:";

/**
 * The blocks that quote a dry run of a declaration that is not the polygon.
 *
 * Each carries the reason it is not measured here and the name of what does
 * measure it. An entry with no such pair is a block somebody stopped checking.
 */
const NOT_THE_POLYGON: ReadonlyMap<string, string> = new Map([
  [
    "docs/adr/0042-a-canary-the-run-will-not-send.md",
    "one account and one write endpoint, the smallest declaration that reaches the " +
      "defect the ADR is about; the same transcript is asserted against the code in " +
      "tests/runner/unsafe-canary.test.ts",
  ],
]);

/** What the repository carries, from git rather than from the disk — as in `links.test.ts`. */
function trackedMarkdown(): readonly string[] {
  return execFileSync("git", ["ls-files", "-z", "*.md"], { cwd: ROOT, encoding: "utf8" })
    .split("\u0000")
    .filter((one) => one !== "");
}

/**
 * Every transcript in one document that quotes the bill, with the words around
 * it that belong to the same transcript.
 *
 * A **transcript**, not a mention: only a line inside a fenced block or indented
 * as a code block is read. Prose saying what the line used to say — this
 * repository's README does, about the very number that started this — is the
 * history of the defect and not a copy of the output.
 *
 * Both kinds of block, because `docs/adr/0042-a-canary-the-run-will-not-send.md`
 * indents its transcript instead of fencing it: a search that only knew about
 * fences would have reported the repository clean of a copy it could not see. A
 * transcript runs from the `Matrix rows:` line above the bill, where there is
 * one, to the last line before the blank line or fence that ends it — which is
 * what picks up the wrapping `docs/first-run.md` does to stay inside its margin.
 */
function billsQuotedIn(text: string): readonly string[] {
  const lines = text.split("\n");
  const ends = (line: string): boolean => line.trim() === "" || line.trim().startsWith("```");
  const quotations: string[] = [];
  let fenced = false;
  lines.forEach((line, at) => {
    if (line.trim().startsWith("```")) {
      fenced = !fenced;
      return;
    }
    if (!line.includes(BILL) || !(fenced || line.startsWith("    "))) {
      return;
    }
    const from = at > 0 && (lines[at - 1] ?? "").trim().startsWith("Matrix rows:") ? at - 1 : at;
    let to = at;
    while (to + 1 < lines.length && !ends(lines[to + 1] ?? "")) {
      to += 1;
    }
    quotations.push(lines.slice(from, to + 1).join("\n"));
  });
  return quotations;
}

/**
 * The words of a transcript, with its line breaks taken out.
 *
 * The wrapping is the document's, not the tool's. Comparing the words rather
 * than the lines is what lets a document wrap where it needs to.
 */
function wordsOf(passage: string): string {
  return passage.replace(/\s+/g, " ").trim();
}

describe("a dry-run transcript in the documentation", () => {
  const quoting = trackedMarkdown().flatMap((path) =>
    billsQuotedIn(readFileSync(resolve(ROOT, path), "utf8")).map((block) => ({ path, block })),
  );

  it("is found at all, rather than agreeing with an empty walk", () => {
    // A search that found nothing would agree with a repository that had lost
    // every transcript.
    expect(quoting.length).toBeGreaterThanOrEqual(3);
  });

  it("quotes the polygon's own numbers, or is listed as quoting something else", async () => {
    const said = (await previewOf(polygonDeclaration())).screen;
    const real = wordsOf(said.slice(said.indexOf("Matrix rows:")));

    for (const { path, block } of quoting) {
      if (NOT_THE_POLYGON.has(path)) {
        continue;
      }
      expect(real, `${path} quotes a dry run this run does not produce`).toContain(wordsOf(block));
    }
  });

  /**
   * And the exceptions are exact in the other direction: a document listed above
   * that stopped carrying such a block leaves an allowance nobody will remove,
   * which is how an exception outlives the thing it excused.
   */
  it("has no listed exception that no longer quotes one", () => {
    const seen = new Set(quoting.map((one) => one.path));

    expect([...NOT_THE_POLYGON.keys()].filter((path) => !seen.has(path))).toEqual([]);
  });
});

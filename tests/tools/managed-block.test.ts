/**
 * The block of a document that a run writes and a human does not.
 *
 * `polygon/README.md` carries the verification table between two markers, and
 * `node polygon/verify.mjs --check-readme` compares what the file holds with
 * what this run rendered. The comparison was `current === block` — one side read
 * off the disk, the other joined with "\n" — so on a working tree checked out
 * with CRLF every line differed and the gate went red for a contributor who had
 * changed nothing. The message told them the table was stale, and doing what it
 * said committed the wrong line endings. The repository had no `.gitattributes`
 * to stop the checkout being like that in the first place. Found by the audit of
 * 14 August 2026 (K-4).
 *
 * Tested here rather than through the script: `verify.mjs` brings a platform up
 * twenty-eight times and needs a build, and none of that is what went wrong. The
 * two lines of text handling are.
 */

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  extractManagedBlock,
  ManagedBlockError,
  managedBlockMatches,
  normalizeNewlines,
  replaceManagedBlock,
} from "../../tools/managed-block.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const BEGIN = "<!-- verify:begin -->";
const END = "<!-- verify:end -->";

const BLOCK = [
  BEGIN,
  "",
  "| Combination | Findings |",
  "|---|---|",
  "| `clean` | 0 |",
  "",
  END,
].join("\n");

const DOCUMENT = ["# Polygon", "", "Prose above.", "", BLOCK, "", "Prose below.", ""].join("\n");

/** The same document as it arrives on a checkout that produces CRLF. */
const AS_CRLF = DOCUMENT.replaceAll("\n", "\r\n");

describe("reading the block", () => {
  it("finds it", () => {
    expect(extractManagedBlock(DOCUMENT, BEGIN, END)).toBe(BLOCK);
  });

  /**
   * The finding itself. Both documents say the same thing, and before the fix
   * only one of them compared equal to the table the run had just rendered.
   */
  it("gives the same block whatever the lines end with", () => {
    expect(extractManagedBlock(AS_CRLF, BEGIN, END)).toBe(
      extractManagedBlock(DOCUMENT, BEGIN, END),
    );
  });

  it("says so when a marker is missing, instead of returning something", () => {
    expect(() => extractManagedBlock("# Polygon\n", BEGIN, END)).toThrow(ManagedBlockError);
    expect(() => extractManagedBlock(`${BEGIN}\nno end\n`, BEGIN, END)).toThrow(ManagedBlockError);
  });

  /**
   * Markers the wrong way round would make `slice` return "", which a caller
   * reads as "the block is empty" — and then writes over a document that was
   * merely mis-marked.
   */
  it("refuses a document whose markers are the wrong way round", () => {
    expect(() => extractManagedBlock(`${END}\ntext\n${BEGIN}\n`, BEGIN, END)).toThrow(
      ManagedBlockError,
    );
  });
});

describe("comparing against the block", () => {
  it("matches when the document already says this", () => {
    expect(managedBlockMatches(DOCUMENT, BEGIN, END, BLOCK)).toBe(true);
  });

  /**
   * The gate, on the checkout that broke it. `--check-readme` renders with "\n"
   * always, so this is exactly the comparison it makes.
   */
  it("matches a CRLF document against a block rendered with LF", () => {
    expect(managedBlockMatches(AS_CRLF, BEGIN, END, BLOCK)).toBe(true);
  });

  /** And it still has to notice a table that really is out of date. */
  it("does not match when a number changed", () => {
    expect(managedBlockMatches(DOCUMENT, BEGIN, END, BLOCK.replace("| 0 |", "| 3 |"))).toBe(false);
    expect(managedBlockMatches(AS_CRLF, BEGIN, END, BLOCK.replace("| 0 |", "| 3 |"))).toBe(false);
  });
});

describe("writing the block", () => {
  it("replaces it and leaves the rest of the document alone", () => {
    const fresh = BLOCK.replace("| 0 |", "| 3 |");
    const written = replaceManagedBlock(DOCUMENT, BEGIN, END, fresh);

    expect(written).toContain("Prose above.");
    expect(written).toContain("Prose below.");
    expect(extractManagedBlock(written, BEGIN, END)).toBe(fresh);
  });

  /**
   * A CRLF document must not come back with both kinds of ending. That is what
   * writing an LF block into it produces, and a half-converted file is worse
   * than either: no comparison and no reviewer can read it, and git will
   * re-normalise part of it on the next commit.
   */
  it("leaves no mixture behind on a CRLF document", () => {
    const written = replaceManagedBlock(AS_CRLF, BEGIN, END, BLOCK.replace("| 0 |", "| 3 |"));

    expect(written).not.toContain("\r");
    expect(written).toContain("Prose below.");
  });

  /**
   * `String.replace` treats `$&` and `$1` in the replacement as substitutions,
   * and a rendered block is arbitrary text. A table with a `$` in a cell would
   * have been written out mangled.
   */
  it("writes a block containing a dollar sign as it stands", () => {
    const withDollars = [BEGIN, "", "| cost | $& and $1 |", "", END].join("\n");
    const written = replaceManagedBlock(DOCUMENT, BEGIN, END, withDollars);

    expect(extractManagedBlock(written, BEGIN, END)).toBe(withDollars);
  });
});

describe("normalizeNewlines", () => {
  it("makes CRLF and a lone CR into LF, and leaves LF alone", () => {
    expect(normalizeNewlines("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });
});

/**
 * The other half of K-4: what git puts in the working tree.
 *
 * The helpers above make the comparison survive CRLF; this makes the checkout
 * not produce it. Asserted through `git check-attr`, which answers for the rules
 * that are actually in force rather than for the text of a file — a
 * `.gitattributes` in the wrong place, or a pattern that misses a directory,
 * both show up here.
 *
 * `eol` and not only `text`: `text=auto` settles what goes into the repository
 * and leaves the checkout to `core.autocrlf`, which Git for Windows turns on
 * when it is installed. The working tree is what the gates read.
 */
describe("the repository's line endings", () => {
  function attributes(paths: readonly string[]): Map<string, Map<string, string>> {
    const out = execFileSync("git", ["check-attr", "-z", "text", "eol", "--", ...paths], {
      cwd: ROOT,
      encoding: "utf8",
    });
    // NUL-separated triples: path, attribute, value.
    const fields = out.split("\u0000");
    const byPath = new Map<string, Map<string, string>>();
    for (let i = 0; i + 2 < fields.length; i += 3) {
      const path = fields[i] ?? "";
      const forPath = byPath.get(path) ?? new Map<string, string>();
      forPath.set(fields[i + 1] ?? "", fields[i + 2] ?? "");
      byPath.set(path, forPath);
    }
    return byPath;
  }

  function tracked(): readonly string[] {
    return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
      .split("\u0000")
      .filter((one) => one !== "");
  }

  it("are settled for every tracked file, not left to the contributor's git", () => {
    const files = tracked();
    // A guard over an empty list is green for the same reason a passing one is.
    expect(files.length).toBeGreaterThan(50);

    const declared = attributes(files);
    const undeclared = files.filter((one) => {
      const forFile = declared.get(one);
      // `text: unset` is how a file marked `binary` reads, which is a deliberate
      // answer rather than a missing one.
      return forFile?.get("text") !== "unset" && forFile?.get("eol") !== "lf";
    });

    expect(undeclared).toEqual([]);
  });

  /** Named on its own, because it is the file the broken gate actually read. */
  it("are settled for the document the verification table lives in", () => {
    expect(attributes(["polygon/README.md"]).get("polygon/README.md")?.get("eol")).toBe("lf");
  });
});

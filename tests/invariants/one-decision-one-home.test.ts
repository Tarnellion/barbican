/**
 * A decision with one home, and a gate that cannot be walked around.
 *
 * Two decisions in this repository were each written out several times, each was
 * collapsed into one module on 23 August 2026, and each was given a test to keep
 * it collapsed:
 *
 * - the **key separator** and the keys glued with it (`src/core/keys.ts`,
 *   ADR-0059);
 * - the **`{name}` grammar** of a path template (`src/core/path-parameters.ts`,
 *   the note of 23 August on ADR-0024).
 *
 * The first gate could be walked around two ways and the second did not exist.
 * A reviewer put a second `cellKey` under another name into `src/report/`, and a
 * `const SEPARATOR = "\x00"` — the same character, spelled the way the gate did
 * not read — and a fourth copy of the `{name}` grammar back into
 * `src/runner/address.ts`. All three passed `pnpm run check` with exit 0. This
 * file is the replacement, and ADR-0060 is why it is shaped the way it is.
 *
 * ## What holds, and in what order
 *
 * 1. **The raw material does not leave its module.** `KEY_SEPARATOR` is no
 *    longer exported; `joinKey` is. `path-parameters.ts` never handed out its
 *    `RegExp` and does not start now. A copy elsewhere therefore cannot borrow
 *    the decision — it has to write the decision out again.
 * 2. **Writing it out again is what the scan reads.** Not one spelling of it:
 *    the sources are tokenised here and the escapes inside their literals are
 *    decoded, so every way of writing the code point zero — the four-digit
 *    escape, `\x00`, `\u{0}`, `\0`, and the byte itself — is one thing to this
 *    file, because they are one character. The `{name}` grammar is read the same
 *    way: a regular expression carrying a brace that is not a quantifier.
 * 3. **Borrowing the joining is enumerated.** `joinKey` is named in five modules
 *    and each is listed below with the key it builds. A sixth fails, whatever it
 *    calls itself, which is the evasion ADR-0059 claimed to catch and did not.
 * 4. **The owned names are owned.** No other module declares one — `let`, a
 *    class member, an object method and `const f: Fn = …` included, all of which
 *    the first version of this check missed.
 *
 * ## What it still cannot see
 *
 * A character built arithmetically rather than written — `String.fromCharCode(0)`
 * — is not a literal and is not decoded. There is one enumerated needle for that
 * shape below, and it is the only enumerated needle here: a courtesy, not what
 * holds. What holds is 1 and 3, and neither depends on how a character is spelled.
 *
 * A grammar for `{name}` written without a regular expression — `indexOf` and
 * `slice` over a brace — is a different implementation rather than a copy, and
 * this file does not read it.
 *
 * And neither gate can see two keys that glue the *same* coordinates in
 * different orders. `capRows` and `acceptanceKeyOf` do exactly that, on purpose;
 * ADR-0059 records it.
 *
 * ## The scope of each check
 *
 * The raw NUL byte is refused in **every tracked file**, not only under `src/`.
 * That widening is the whole of ADR-0060's second half: the byte was in
 * `docs/adr/0057-the-runner-is-cut-at-the-address.md`, which made that ADR binary
 * to `grep`, so a repository-wide search for the separator answered "no matches"
 * over it — and the ADR-0059 author read the silence as "the ADR renders the key
 * with a space" and wrote that down as a finding. A gate that scans `src/` alone
 * leaves the search it is defending lying.
 *
 * Everything else stops at `src/`. `tools/oracle/index.mjs` has a `cellKey` of
 * its own on purpose — an oracle that shared the tool's code would agree with
 * itself — and the tests that split `git ls-files -z` output split on a NUL that
 * is not a key at all.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as keys from "../../src/core/keys.js";
import { cellKey, joinKey, objectKey } from "../../src/core/keys.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The character itself, from its code point: a raw one here would make this file binary. */
const RAW_SEPARATOR = String.fromCharCode(0);

/** The module that owns the separator and the keys glued with it. */
const KEYS = "src/core/keys.ts";

/** The module that owns the `{name}` grammar. */
const GRAMMAR = "src/core/path-parameters.ts";

/**
 * The files that may spell the separator, and how many times each.
 *
 * The count is exact in both directions. A **new** spelling in the digest file
 * fails here like anywhere else, and a spelling that disappears from the owner
 * means the scanner has stopped seeing.
 */
const SEPARATOR_HOMES: ReadonlyMap<string, number> = new Map([
  // The owner: one constant, module-private since ADR-0060.
  [KEYS, 1],
  // Domain separation inside a hash, not a key in a map. The bytes go into a
  // number the report prints, and tying them to a constant whose subject is
  // lookup keys would mean that changing how this tool indexes its own tables
  // silently changes a digest. Deliberately unbound; see ADR-0059.
  ["src/adapters/signals.ts", 3],
]);

/**
 * The modules that may name `joinKey`, and the key each of them builds.
 *
 * This is the list ADR-0059's third assertion was meant to be. Every entry here
 * is a **different** key — a different tuple of coordinates, for a different
 * index — and that is what a sixth entry has to persuade a reader of, rather
 * than a matcher. A copy of one of these five, under any name at all, has
 * nowhere else to get the character from.
 */
const JOIN_KEY_CALLERS: ReadonlyMap<string, string> = new Map([
  [KEYS, "the owner: the cell key and the object key"],
  ["src/core/defects.ts", "endpoint, relation, conditions — a defect signature"],
  ["src/core/accepted.ts", "signature and kind — the acceptance index"],
  ["src/io/config/parse.ts", "citable defect and kind — the duplicate-acceptance refusal"],
  ["src/report/findings.ts", "kind and signature — the per-defect evidence budget"],
]);

/**
 * The modules that may write a brace-delimited grammar, and how many each holds.
 *
 * A regular expression carrying a brace that is not a quantifier: the `{4}` of a
 * date is not one of these, and the owner's expression is.
 */
const BRACE_GRAMMARS: ReadonlyMap<string, number> = new Map([
  // The owner: `{name}` in a path template, read by the plan, the canaries, the
  // address and the matrix.
  [GRAMMAR, 1],
  // Postman's own doubled braces, and the check that a path's braces are all
  // well-formed before the collection is handed on. A narrower reading of a
  // brace than the owner's, asked at a different moment and about a different
  // document; see the note in ADR-0060.
  ["src/adapters/postman.ts", 3],
  // The table of regular-expression metacharacters to escape, in which an
  // opening and a closing brace are two entries among sixteen.
  ["src/core/selectors.ts", 1],
]);

/** Every name one of the two owning modules is the sole home of. */
const OWNED_NAMES: readonly (readonly [string, string])[] = [
  ["joinKey", KEYS],
  ["cellKey", KEYS],
  ["objectKey", KEYS],
  ["hasPathParameters", GRAMMAR],
  ["pathParameterNames", GRAMMAR],
  ["fillPathParameters", GRAMMAR],
];

/**
 * The tracked files, from the index rather than from the disk.
 *
 * `.gitignore` already answers "does this go public", and a hand-written list
 * beside it would drift — and walking the tree here would descend into
 * `.claude/worktrees/`, where another branch's copy of a file would answer for
 * this one.
 *
 * A path the index still holds and the disk no longer does is skipped: that is a
 * deletion not yet staged, a state of somebody's working copy rather than of the
 * repository. Deleting a file this gate is about fails the assertion below
 * instead of throwing here.
 */
function tracked(...paths: readonly string[]): readonly string[] {
  return execFileSync("git", ["ls-files", "-z", ...paths], { cwd: ROOT, encoding: "utf8" })
    .split(RAW_SEPARATOR)
    .filter((path) => path.length > 0 && existsSync(resolve(ROOT, path)));
}

function sourceOf(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8");
}

type LiteralKind = "string" | "template" | "regex";

interface Literal {
  readonly kind: LiteralKind;
  /** The text between the delimiters, escapes left exactly as the source wrote them. */
  readonly body: string;
  readonly line: number;
}

const IDENTIFIER = /[A-Za-z0-9_$]/;

/** After one of these, a slash opens a regular expression rather than dividing. */
const BEFORE_A_REGEX = new Set([
  "(",
  ",",
  "=",
  ":",
  "[",
  "!",
  "&",
  "|",
  "?",
  "{",
  "}",
  ";",
  "+",
  "-",
  "*",
  "%",
  "^",
  "~",
  "<",
  ">",
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

/**
 * The literals of a TypeScript source: strings, templates and regular expressions.
 *
 * Written out here rather than taken from a parser, and that is a decision with
 * a cost. A parser would be a new package to vet for a gate whose whole value is
 * being short enough to read, and this repository minimises dependencies
 * aggressively (CLAUDE.md). The cost is that a hand-written tokeniser can lose
 * its place — so it is built to be **loud** when it does: anything it cannot
 * finish throws, because a scan that has lost its place must never report
 * "nothing found".
 *
 * Comments are skipped, so prose quoting a separator or a grammar is not a
 * finding. Template interpolations are handed back to the code scanner, so the
 * braces of an interpolation are in nobody's body.
 */
function literalsOf(source: string, where: string): readonly Literal[] {
  const found: Literal[] = [];
  const interpolations: { depth: number; body: string; line: number }[] = [];
  let at = 0;
  let line = 1;
  let previous = "";

  const fail = (what: string): never => {
    throw new Error(`${where}:${line}: ${what}`);
  };

  const readString = (quote: string): void => {
    const start = line;
    let body = "";
    at += 1;
    for (;;) {
      const char = source.charAt(at);
      if (char === "") fail("unterminated string");
      if (char === "\n") fail("a newline inside a quoted string");
      if (char === quote) {
        at += 1;
        break;
      }
      if (char === "\\") {
        body += char + source.charAt(at + 1);
        at += 2;
        continue;
      }
      body += char;
      at += 1;
    }
    found.push({ kind: "string", body, line: start });
    previous = "''";
  };

  /** Reads a template onward from `at`: from just past its backtick, or past a `}`. */
  const readTemplate = (opening: string, start: number): void => {
    let body = opening;
    for (;;) {
      const char = source.charAt(at);
      if (char === "") fail("unterminated template");
      if (char === "`") {
        at += 1;
        found.push({ kind: "template", body, line: start });
        previous = "``";
        return;
      }
      if (char === "\\") {
        body += char + source.charAt(at + 1);
        at += 2;
        continue;
      }
      if (char === "$" && source.charAt(at + 1) === "{") {
        interpolations.push({ depth: 0, body, line: start });
        at += 2;
        return;
      }
      if (char === "\n") line += 1;
      body += char;
      at += 1;
    }
  };

  const readRegex = (): void => {
    const start = line;
    let body = "";
    let inClass = false;
    at += 1;
    for (;;) {
      const char = source.charAt(at);
      if (char === "" || char === "\n") fail("unterminated regular expression");
      if (char === "\\") {
        body += char + source.charAt(at + 1);
        at += 2;
        continue;
      }
      if (char === "[") inClass = true;
      else if (char === "]") inClass = false;
      else if (char === "/" && !inClass) {
        at += 1;
        break;
      }
      body += char;
      at += 1;
    }
    while (IDENTIFIER.test(source.charAt(at))) at += 1;
    found.push({ kind: "regex", body, line: start });
    previous = "/re/";
  };

  while (at < source.length) {
    const char = source.charAt(at);
    if (char === "\n") {
      line += 1;
      at += 1;
      continue;
    }
    if (char === " " || char === "\t" || char === "\r") {
      at += 1;
      continue;
    }
    if (char === "/" && source.charAt(at + 1) === "/") {
      while (at < source.length && source.charAt(at) !== "\n") at += 1;
      continue;
    }
    if (char === "/" && source.charAt(at + 1) === "*") {
      at += 2;
      while (at < source.length && !(source.charAt(at) === "*" && source.charAt(at + 1) === "/")) {
        if (source.charAt(at) === "\n") line += 1;
        at += 1;
      }
      if (at >= source.length) fail("unterminated block comment");
      at += 2;
      continue;
    }
    if (char === '"' || char === "'") {
      readString(char);
      continue;
    }
    if (char === "`") {
      const start = line;
      at += 1;
      readTemplate("", start);
      continue;
    }
    const frame = interpolations.at(-1);
    if (frame !== undefined && char === "}") {
      if (frame.depth === 0) {
        interpolations.pop();
        at += 1;
        readTemplate(frame.body, frame.line);
        continue;
      }
      frame.depth -= 1;
      previous = "}";
      at += 1;
      continue;
    }
    if (frame !== undefined && char === "{") {
      frame.depth += 1;
      previous = "{";
      at += 1;
      continue;
    }
    if (char === "/") {
      if (previous === "" || BEFORE_A_REGEX.has(previous)) {
        readRegex();
        continue;
      }
      previous = "/";
      at += 1;
      continue;
    }
    if (IDENTIFIER.test(char)) {
      let word = "";
      while (IDENTIFIER.test(source.charAt(at))) {
        word += source.charAt(at);
        at += 1;
      }
      previous = word;
      continue;
    }
    previous = char;
    at += 1;
  }
  if (interpolations.length > 0) fail("unterminated template");
  return found;
}

/**
 * Every escape that stands for a single character: the two brace forms, the
 * four-digit form, the two-digit hex form and the octal family that `\0` belongs
 * to.
 *
 * Decoding rather than matching is the point of this gate. It holds no list of
 * ways to write the separator; it reads what a spelling *means*, so a spelling
 * nobody has thought of yet is covered the day it is written. It
 * over-approximates on a literal backslash followed by an escape — which nothing
 * under `src/` writes, and which would fail loudly rather than quietly.
 */
const ESCAPE =
  /\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([0-7]{1,3})(?![0-9]))/g;

/** How many times a literal's body spells the separator, in any spelling of it. */
function spellsTheSeparator(body: string): number {
  let count = body.split(RAW_SEPARATOR).length - 1;
  for (const match of body.matchAll(ESCAPE)) {
    const hex = match[1] ?? match[2] ?? match[3];
    if (hex !== undefined) {
      if (Number.parseInt(hex, 16) === 0) count += 1;
      continue;
    }
    const octal = match[4];
    if (octal !== undefined && Number.parseInt(octal, 8) === 0) count += 1;
  }
  return count;
}

/** A repetition count, which is the one thing a brace means that is not a grammar. */
const QUANTIFIER = /\{\d+(?:,\d*)?\}/g;

function isBraceGrammar(literal: Literal): boolean {
  if (literal.kind !== "regex") return false;
  const counted = literal.body.replace(QUANTIFIER, "");
  return counted.includes("{") || counted.includes("}");
}

/** The one enumerated needle in this file: a character built out of the code point zero. */
const FROM_A_CODE_POINT = /\bfrom(?:CharCode|CodePoint)\(\s*0+\s*\)/;

function escaped(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A declaration of `name`, in the forms this repository can write one.
 *
 * The first version matched `function name(` and `const name =` and nothing
 * else, so `let`, `const name=` with no spaces, `const name: Fn = …`, a class
 * member and an object method all walked past it. A call standing alone as a
 * statement matches the member form and would be a false positive: that is a
 * loud failure in a gate rather than a quiet pass, and nothing under `src/`
 * calls one of these names as a bare statement.
 */
function declares(source: string, name: string): boolean {
  const it = escaped(name);
  return new RegExp(
    [
      // `function f(`, `function* f(`, `async function f<T>(`
      `\\bfunction\\s*\\*?\\s+${it}\\s*[(<]`,
      // `const f =`, `let f=`, `var f: Fn = …`
      `\\b(?:const|let|var)\\s+${it}\\s*[:=]`,
      // A class member or an object method, behind any modifiers. The parameter
      // list has to open and close on the line and be followed by a body: bare
      // `name(` at the start of a line is far more often a call spread over
      // several lines — `cellKey({` in `findings.ts` is one — and a gate that
      // cries wolf is a gate somebody edits until it stops. A declaration whose
      // parameters run over several lines is missed here and caught by the two
      // checks above it, which is the point of there being three.
      `^[ \\t]*(?:(?:public|private|protected|static|readonly|abstract|override|async|get|set)\\s+)*${it}\\s*(?:<[^<>]*>)?\\([^)]*\\)\\s*(?::[^{;]+)?\\{`,
      // `f: () => …`, `f: function …`, `f: async (…)`
      `^[ \\t]*${it}\\s*:\\s*(?:async\\s+)?(?:function\\b|\\(|<)`,
    ].join("|"),
    "m",
  ).test(source);
}

describe("the scanner this gate reads with", () => {
  const sample = [
    "// a comment with /a regex?/ and an escape in it",
    "/* and a block one, with `a template` */",
    'const quoted = "one\\u0000two";',
    "const half = total / 2 / 3;",
    "const slashInAClass = /[/]{2}/;",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: an interpolation inside a plain string is the subject here — the scanner has to hand this one back to the code reader rather than keep it in a body
    "const nested = `a${ { b: `c${d}e` }.b }f`;",
    "function g() { return /after a keyword/g; }",
  ].join("\n");

  it("reads the literals, and nothing that only looks like one", () => {
    expect(literalsOf(sample, "<sample>")).toEqual([
      { kind: "string", body: "one\\u0000two", line: 3 },
      { kind: "regex", body: "[/]{2}", line: 5 },
      // A template is one literal with its interpolations taken out, so the
      // braces of an interpolation are in nobody's body — and the inner template
      // closes before the outer one does.
      { kind: "template", body: "ce", line: 6 },
      { kind: "template", body: "af", line: 6 },
      { kind: "regex", body: "after a keyword", line: 7 },
    ]);
  });

  it("refuses to guess once it has lost its place", () => {
    expect(() => literalsOf('const unfinished = "abc', "<sample>")).toThrow("unterminated string");
    expect(() => literalsOf("/* forever", "<sample>")).toThrow("unterminated block comment");
  });

  it("reads every spelling of one character as one character", () => {
    expect(spellsTheSeparator("\\u0000")).toBe(1);
    expect(spellsTheSeparator("\\x00")).toBe(1);
    expect(spellsTheSeparator("\\u{0}")).toBe(1);
    expect(spellsTheSeparator("\\0")).toBe(1);
    expect(spellsTheSeparator(`a${RAW_SEPARATOR}b`)).toBe(1);
    expect(spellsTheSeparator("\\u0000scope\\u0000")).toBe(2);
    // And reads a different character as a different character.
    expect(spellsTheSeparator("\\u0041\\x41\\1")).toBe(0);
  });

  it("tells a grammar of braces from a quantifier", () => {
    const grammar = (body: string): boolean => isBraceGrammar({ kind: "regex", body, line: 1 });
    expect(grammar("\\{([^}]+)\\}")).toBe(true);
    expect(grammar("{([^}]+)}")).toBe(true);
    expect(grammar("[{]([^}]+)[}]")).toBe(true);
    expect(grammar("^(\\d{4})-(\\d{2})-(\\d{2})$")).toBe(false);
    expect(grammar("^[0-9]{2,}$")).toBe(false);
    expect(isBraceGrammar({ kind: "string", body: "{name}", line: 1 })).toBe(false);
  });

  it("reads a declaration in every form this repository can write one", () => {
    expect(declares("export function cellKey(cell: {", "cellKey")).toBe(true);
    expect(declares("async function cellKey<T>(", "cellKey")).toBe(true);
    expect(declares("const cellKey = (cell) => 1;", "cellKey")).toBe(true);
    expect(declares("const cellKey=(cell)=>1;", "cellKey")).toBe(true);
    expect(declares("let cellKey: Fn = of;", "cellKey")).toBe(true);
    expect(declares("class A {\n  cellKey(cell) {\n    return 1;\n  }\n}", "cellKey")).toBe(true);
    expect(declares("const to = {\n  cellKey: (cell) => 1,\n};", "cellKey")).toBe(true);
    expect(declares("const to = {\n  cellKey: function () {},\n};", "cellKey")).toBe(true);
    // A use is not a declaration, and neither is an import.
    expect(declares("const key = cellKey(observation);", "cellKey")).toBe(false);
    expect(declares('import { cellKey } from "../core/keys.js";', "cellKey")).toBe(false);
  });
});

describe("one decision, one home", () => {
  const everything = tracked();
  const sources = tracked("src").filter((path) => path.endsWith(".ts"));

  it("sees the tree, rather than an empty list", () => {
    // A check that found nothing is green for the same reason a passing one is.
    expect(everything.length).toBeGreaterThan(200);
    expect(sources.length).toBeGreaterThan(30);
    for (const path of SEPARATOR_HOMES.keys()) expect(sources).toContain(path);
    for (const path of JOIN_KEY_CALLERS.keys()) expect(sources).toContain(path);
    for (const path of BRACE_GRAMMARS.keys()) expect(sources).toContain(path);
    // And that the widened scope really does reach past `src/`, which is where
    // the byte ADR-0059 could not see was sitting.
    expect(everything.filter((path) => path.startsWith("docs/adr/")).length).toBeGreaterThan(50);
  });

  it("carries the separator as an escape, never as the byte, in any tracked file", () => {
    const binary = everything.filter((path) => sourceOf(path).includes(RAW_SEPARATOR));

    expect(
      binary,
      `A raw NUL byte is in: ${binary.join(", ")}. It makes the whole file binary ` +
        `to \`grep\`, so a search for the separator answers "no matches" over a ` +
        `file that uses it. Two sources went unnoticed that way, and then an ADR — ` +
        `which is how ADR-0059 came to record, as a rendering choice, a byte it ` +
        `could not see. Write the escape; the string is the same.`,
    ).toEqual([]);
  });

  it("spells the separator in one module, and in one other for a reason", () => {
    const spelled = sources
      .map((path) => ({
        path,
        count: literalsOf(sourceOf(path), path).reduce(
          (total, literal) => total + spellsTheSeparator(literal.body),
          0,
        ),
      }))
      .filter((file) => file.count !== (SEPARATOR_HOMES.get(file.path) ?? 0))
      .map((file) => `${file.path} (${file.count})`);

    expect(
      spelled,
      `The key separator is spelled where it should not be, or is no longer ` +
        `spelled where it should: ${spelled.join(", ")}. Every spelling of the ` +
        `character is one thing here — the four-digit escape, the hex one, the ` +
        `brace one, the octal one and the byte — because they are one character. ` +
        `There is no constant to import any more: call joinKey, or one of the key ` +
        `functions beside it. See ADR-0060.`,
    ).toEqual([]);
  });

  it("builds no character out of the code point zero", () => {
    const built = sources.filter((path) => FROM_A_CODE_POINT.test(sourceOf(path)));

    expect(
      built,
      `A character is built from the code point zero in: ${built.join(", ")}. This ` +
        `needle is the one enumerated thing in this file and it is not what holds — ` +
        `the separator is unexported, so a key glued here would be a second ` +
        `spelling of a decision that already has a home. Call joinKey.`,
    ).toEqual([]);
  });

  it("hands out the joining and not the character", () => {
    // The seam ADR-0060 rests on. While the constant was exported, a copy under
    // another name could import it and rebuild the string by hand, and one did.
    expect(Object.keys(keys).sort()).toEqual(["cellKey", "joinKey", "objectKey"]);
    expect(
      Object.entries(keys)
        .filter(([, value]) => typeof value !== "function")
        .map(([name]) => name),
      "Something other than a function leaves src/core/keys.ts. The separator is " +
        "not to be exported again — that is the whole of ADR-0060.",
    ).toEqual([]);
  });

  it("lets five modules name joinKey, each for a key of its own", () => {
    const elsewhere = sources.filter(
      (path) => !JOIN_KEY_CALLERS.has(path) && /\bjoinKey\b/.test(sourceOf(path)),
    );

    expect(
      elsewhere,
      `joinKey is named in ${elsewhere.join(", ")}, which is not one of the modules ` +
        `that builds a key. Each of the five listed in this file builds a different ` +
        `tuple of coordinates; a sixth has to be a sixth key, and a copy of one of ` +
        `the five is exactly what this gate exists for — whatever it calls itself. ` +
        `See ADR-0060.`,
    ).toEqual([]);
  });

  it("writes a brace-delimited grammar in one module, and in two others for a reason", () => {
    const written = sources
      .map((path) => ({
        path,
        count: literalsOf(sourceOf(path), path).filter(isBraceGrammar).length,
      }))
      .filter((file) => file.count !== (BRACE_GRAMMARS.get(file.path) ?? 0))
      .map((file) => `${file.path} (${file.count})`);

    expect(
      written,
      `A regular expression reads a brace where it should not, or no longer reads ` +
        `one where it should: ${written.join(", ")}. The \`{name}\` of a path ` +
        `template is read by ${GRAMMAR} and by nothing else — it was written three ` +
        `times before 23 August 2026, in two layers, and a fourth copy walked past ` +
        `the gate that replaced them. Import hasPathParameters, pathParameterNames ` +
        `or fillPathParameters.`,
    ).toEqual([]);
  });

  it("holds one expression in the module that owns the grammar", () => {
    // A second spelling inside the owning module is the same duplicate one
    // directory further in, and it passed every assertion of the first gate.
    const expressions = literalsOf(sourceOf(GRAMMAR), GRAMMAR).filter(
      (literal) => literal.kind === "regex",
    );

    expect(expressions.map((literal) => literal.body)).toEqual(["\\{([^}]+)\\}"]);
  });

  it("lets no other module declare an owned name", () => {
    const elsewhere = OWNED_NAMES.flatMap(([name, owner]) =>
      sources
        .filter((path) => path !== owner && declares(sourceOf(path), name))
        .map((path) => `${name} in ${path}`),
    );

    expect(
      elsewhere,
      `A second declaration of a name with one home: ${elsewhere.join(", ")}. ` +
        `A copy that agrees today is what ADR-0059 and ADR-0060 are about.`,
    ).toEqual([]);
  });
});

describe("the two keys", () => {
  const alice = { accountId: "alice", endpointId: "orders.read", resourceId: "o-1" };
  const carol = { accountId: "carol", endpointId: "orders.read", resourceId: "o-1" };

  it("keeps the coordinates apart wherever the boundary falls", () => {
    // The separator's whole job: two different cells whose coordinates
    // concatenate to the same letters must not share a key.
    expect(cellKey({ accountId: "a", endpointId: "b.c", resourceId: "d" })).not.toBe(
      cellKey({ accountId: "a", endpointId: "b", resourceId: "c.d" }),
    );
    // One character, and the same one the digest in `signals.ts` frames with.
    // The two are unbound on purpose, and this is where that agreement is read
    // rather than assumed.
    expect(joinKey("a", "b")).toBe(`a${RAW_SEPARATOR}b`);
    expect(joinKey("a", "b")).toHaveLength(3);
  });

  it("reads an absent resource and an undefined one as one cell", () => {
    // The contract `?: string | undefined` states, kept deliberately: a caller
    // holding a `Resource | undefined` says "no resource" the way it has one,
    // and both ways mean the same cell. See the note over `cellKey`.
    expect(cellKey({ accountId: "alice", endpointId: "orders.list" })).toBe(
      cellKey({ accountId: "alice", endpointId: "orders.list", resourceId: undefined }),
    );
    expect(objectKey({ endpointId: "orders.list" })).toBe(
      objectKey({ endpointId: "orders.list", resourceId: undefined }),
    );
  });

  it("carries the resource, in both keys", () => {
    // The coordinate a copy of this function lost once: `relatedRequestOf`
    // dropped `resourceId` from the key it built, and a finding then named a
    // different cell than the one that produced it. Two objects of one endpoint
    // are two cells, and an endpoint with no resource is neither of them.
    expect(cellKey({ ...alice, resourceId: "o-2" })).not.toBe(cellKey(alice));
    expect(cellKey({ accountId: "alice", endpointId: "orders.read" })).not.toBe(cellKey(alice));
    expect(objectKey({ endpointId: "orders.read" })).not.toBe(objectKey(alice));
  });

  it("names one object for two accounts, and two cells", () => {
    // The difference between them, and the reason both exist: the walk asks
    // "which object" about a column every account shares, and the report asks
    // "which cell" about one account's row.
    expect(objectKey(alice)).toBe(objectKey(carol));
    expect(cellKey(alice)).not.toBe(cellKey(carol));
  });
});

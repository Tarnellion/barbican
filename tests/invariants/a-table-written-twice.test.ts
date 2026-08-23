/**
 * The two facts ADR-0064 collapsed into one home and gave to the compiler that
 * the compiler cannot hold.
 *
 * ADR-0064 put six duplicated facts each under the strongest mechanism available
 * to it. For two of them the decision table said "the compiler" and the
 * Consequences said the compiler "now refuses … a second severity table, and a
 * second date grammar in `src/io/config/schema.ts`". It refuses neither.
 * Adversarial review re-wrote each copy by hand on 23 August 2026 — a private
 * `Readonly<Record<Severity, number>>` back in `src/cli/screen.ts`, a literal
 * `/^\d{4}-\d{2}-\d{2}$/` back in the schema — and `npx tsc --noEmit` and
 * `npx vitest run` were both green over both.
 *
 * What the compiler does hold is real and narrower, and the ADR now says so:
 * `Record<Severity, number>` refuses a level added to `Severity` and left out of
 * the table, in every copy at once, which is the direction B-16 was about. It
 * says nothing about how many tables there are or how they rank.
 *
 * This is what reads the second copy. A third fact rides along: the header lists
 * behind `forbiddenHeaderReason` were made module-private in the same commit, so
 * a second composition that *borrows* them no longer compiles — and this file is
 * what reads a second composition that writes them out instead.
 *
 * ## What holds
 *
 * A source scan over the tracked files under `src/`, with the count exact in
 * both directions for every file allowed to carry the shape. A copy fails; so
 * does the owner losing its own, because a scanner that has stopped seeing
 * anything agrees with everything.
 *
 * Comments are dropped first — a line whose first non-space character opens or
 * continues one. Otherwise `src/report/shape.ts` explaining what `critical: 10`
 * means in a report would read as a severity table.
 *
 * ## What it cannot see
 *
 * What a scan of source text can hold at all is ADR-0065, stated once for every
 * gate of this family. The list below is this scan's own, and what stays open on
 * purpose rather than what nobody thought of.
 *
 * - A table or a list **built** rather than written: `Object.fromEntries`, a
 *   `Map` filled in a loop, a name assembled from pieces (`"x-" + "method"`), a
 *   name decoded or computed at run time. The shapes read here are the shapes a
 *   person types, which are also the shapes each of the reviewers typed. A
 *   header member written out is read in all three quotations and in any case,
 *   because those are spellings a formatter produces rather than ones somebody
 *   chooses; assembling the string is not.
 * - A date grammar spelled some other way — `\d\d\d\d-\d\d-\d\d`, or `indexOf`
 *   and `slice` over the hyphens. `[0-9]` is folded to `\d` before the scan
 *   because that substitution is the one a linter suggests; nothing else is.
 * - A trailing comment on a line of code, which is not dropped and so is
 *   scanned. That direction only ever adds a finding, never hides one.
 * - Anything outside `src/`. `tests/` writes severity tables on purpose, and
 *   `tools/oracle/` is meant not to share this tool's code at all.
 * - A re-ranking of the one table that is left. Nothing here or in the compiler
 *   holds that; `tests/report/compare.test.ts` and the exit-code tests are what
 *   would notice, and only through the order they observe.
 * - A second header composition that carries **no** member of either list — one
 *   built out of `forbiddenHeaderReason` itself, or one guarding names nobody
 *   has forbidden yet. The first is a caller and not a copy; the second is a new
 *   rule, and a new rule belongs in `basis.ts` by CLAUDE.md rather than by this
 *   file.
 * - A second header composition written out of **full header names** rather than
 *   the members. `"x-http-method-override"` carries no member with a quote on
 *   both sides of it, so it is a second composition that writes no member at all
 *   — the case above, reached without meaning to reach it. Measured on 23 August
 *   2026 in `src/io/config/contexts.ts`, with the counts for every file
 *   unchanged; ADR-0064 carries what was run.
 *
 * See ADR-0064.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CALENDAR_DATE } from "../../src/core/calendar.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The tracked TypeScript under `src/`, from git rather than from the disk. */
function sources(): readonly string[] {
  return execFileSync("git", ["ls-files", "-z", "src"], { cwd: ROOT, encoding: "utf8" })
    .split("\u0000")
    .filter((one) => one.endsWith(".ts"));
}

/**
 * One file with its comments dropped and `[0-9]` folded to `\d`.
 *
 * A line whose first non-space character opens, continues or closes a comment is
 * not code. That is coarser than a tokeniser and errs the safe way: a comment on
 * the end of a line of code stays, so the scan can only over-report.
 */
function codeOf(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8")
    .split("\n")
    .filter((line) => {
      const trimmed = line.trimStart();
      return !(
        trimmed.startsWith("*") ||
        trimmed.startsWith("/*") ||
        trimmed.startsWith("//") ||
        trimmed.startsWith("*/")
      );
    })
    .join("\n")
    .replaceAll("[0-9]", "\\d");
}

/** Where a shape may appear, and how many times. Exact in both directions. */
type Homes = ReadonlyMap<string, number>;

function found(probe: RegExp): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const path of sources()) {
    const hits = [...codeOf(path).matchAll(probe)].length;
    if (hits > 0) {
      counts.set(path, hits);
    }
  }
  return counts;
}

function expectExactly(probe: RegExp, homes: Homes): void {
  expect(Object.fromEntries(found(probe))).toEqual(Object.fromEntries(homes));
}

describe("the severity ranks are written in one place", () => {
  /**
   * An entry of an object literal giving a severity level a number.
   *
   * Two files carry the shape and only two may. `src/core/defects.ts` is the
   * ranking itself. `src/report/findings.ts` holds `EMPTY_BY_SEVERITY`, which is
   * the same five keys at zero — the identity a count starts from, not an order,
   * and there is no way for all-zero to rank anything differently from all-zero.
   * Both are `Record<Severity, number>`, so a level added to the union reaches
   * both through the compiler.
   */
  const HOMES: Homes = new Map([
    ["src/core/defects.ts", 5],
    ["src/report/findings.ts", 5],
  ]);

  /**
   * The key, then the number, with the spellings a person reaches for.
   *
   * `\b(?:critical|…)\s*:\s*\d` was the first version and it read three things
   * about a key that has more than three shapes: adversarial review of
   * 23 August 2026 put a private `Readonly<Record<Severity, number>>` back into
   * `src/cli/screen.ts` written `critical: +0 … info: +4` and again with quoted
   * keys, and both passed Biome, `tsc` and the whole suite. A leading `+` is
   * what `\d` alone misses; a quote is what `\b` misses, because the character
   * before `critical` is then `"` and the one after it is `"` rather than `:`.
   *
   * So: an optional quote on each side of the key — the same one on both, which
   * is what the backreference is for — an optional bracket for a computed key,
   * and an optional sign on the number. Every one of those is a spelling a
   * formatter or a linter can produce from the plain one; none of them is a
   * spelling somebody arrives at without meaning to.
   */
  const RANK = /(?<![\w$])\[?\s*(["']?)(?:critical|high|medium|low|info)\1\s*\]?\s*:\s*[+-]?\d/g;

  it("has no second table, and has not lost the one it has", () => {
    expectExactly(RANK, HOMES);
  });
});

describe("the YYYY-MM-DD grammar is written in one place", () => {
  /** `src/core/calendar.ts` owns it; `src/io/config/schema.ts` imports it. */
  const HOMES: Homes = new Map([["src/core/calendar.ts", 1]]);

  it("has no second grammar under src/", () => {
    expectExactly(/\\d\{4\}-\\d\{2\}-\\d\{2\}/g, HOMES);
  });

  /**
   * And the copy that ships is the same expression rather than a second one.
   *
   * `schema/barbican.run.schema.json` is published and editors complete a
   * configuration from it, so the pattern in it is a copy nobody re-derives —
   * the reason `CALENDAR_DATE` has no capture groups. Compared against the
   * owner's own `source`, so the two cannot drift apart in either direction.
   */
  it("ships the same expression in the published schema", () => {
    const schema = readFileSync(resolve(ROOT, "schema/barbican.run.schema.json"), "utf8");
    const patterns = [...schema.matchAll(/"pattern": "([^"]*)"/g)].map((match) => match[1] ?? "");

    expect(patterns).toContain(JSON.stringify(CALENDAR_DATE.source).slice(1, -1));
  });
});

describe("the forbidden-header lists are written in one place", () => {
  /**
   * The lists themselves are module-private, so a second composition cannot
   * import them — that half is the compiler's since 23 August 2026, and it is
   * the half the first reviewer walked through. This is the other half: a copy
   * that writes the entries out instead.
   *
   * It read three entries until the review of the same day came back through:
   * `proxy-authorization`, `x-original-` and `x-http-method`. A scan keyed on
   * three remembered strings answers about those three strings, and a second
   * composition carrying `authorization`, `cookie`, `host`, `x-method`,
   * `x-rewrite-` and `x-forwarded-host` — six of the twenty, and every one of
   * them load-bearing — went through the whole run green. A partial copy of a
   * denylist is a denylist; CLAUDE.md's rule about request conditions is on
   * record that this rule was already wrong once for having fewer layers than
   * it needed, so fewer members is exactly the drift to expect.
   *
   * ## What is read now
   *
   * **Every member of both layers, taken from the owner's own source** rather
   * than remembered here — the eleven exact names and the nine prefixes, parsed
   * out of the two declarations in `src/io/config/basis.ts`. A member added
   * there is covered by this scan the moment it is added, which a hand-copied
   * list of needles could never be.
   *
   * Per file, the count is the number of **occurrences** of a member as a quoted
   * literal, and it is exact in both directions.
   *
   * Occurrences and not distinct members, which is how this scan was first
   * written. Counting distinct members asks "does this file carry a piece of the
   * composition", and the owner already carries every piece — so a second, whole
   * composition written by hand inside `basis.ts` itself added nothing to the
   * count and passed. That is the one place a second composition is most likely
   * to appear and the one place it was invisible. Measured, not argued: under
   * that mutation the distinct count stays 20 and the suite is green, while the
   * occurrence count goes to 41.
   *
   * The price is that an honest second mention now costs a line here. That is
   * the price this repository already pays for an override in
   * `pnpm-workspace.yaml` and an expiry in `osv-scanner.toml`: an allowance
   * carries its count and its reason, and a count that has stopped being true
   * fails rather than passes.
   */
  const OWNER = "src/io/config/basis.ts";

  /**
   * The first element of every pair in one of the two declarations.
   *
   * Read out of the source and not imported, because these lists stopped being
   * exported for the reason this scan exists: a test that imported them would be
   * the twelfth door in the wall. The declaration runs to the first line that
   * begins with `]` — `]);` closes the `Map`, `];` the array.
   */
  function entriesOf(declaration: string): readonly string[] {
    const code = codeOf(OWNER);
    const from = code.indexOf(declaration);
    expect(from, `${declaration} is not in ${OWNER}`).toBeGreaterThanOrEqual(0);
    const to = code.indexOf("\n]", from);
    return [...code.slice(from, to).matchAll(/\["([^"]+)",/g)].map((match) => match[1] ?? "");
  }

  const EXACT = entriesOf("const FORBIDDEN_CONTEXT_HEADERS");
  const PREFIXES = entriesOf("const FORBIDDEN_HEADER_PREFIXES");
  const MEMBERS = [...EXACT, ...PREFIXES];

  /**
   * Where a member of either layer may be written out, and how many times in
   * all — occurrences, as above, not distinct members. Every entry but the
   * owner's carries the reason it is not a copy.
   */
  const HOMES: ReadonlyMap<string, { readonly members: number; readonly why: string }> = new Map([
    [
      OWNER,
      {
        members: 21,
        why:
          "the owner: both layers, and nothing else holds either. " +
          "Twenty-one and not twenty: `cookie` is written once in the exact layer and " +
          "once more where the reason for it is composed",
      },
    ],
    [
      "src/adapters/http.ts",
      {
        members: 3,
        why:
          "content-length, transfer-encoding and connection are stripped from a " +
          "request the client builds — the transport doing its own job, not a rule " +
          "about what an operator may declare",
      },
    ],
    [
      "src/adapters/credentials.ts",
      {
        members: 6,
        why:
          "authorization and cookie are the headers the credential provider sets; " +
          "this is the code the forbidden list exists to protect, not a copy of it. " +
          "Six occurrences of two members, each written once per scheme it belongs to",
      },
    ],
    [
      "src/report/sections.ts",
      {
        members: 3,
        why:
          "authorization and cookie in the report's redaction of what it prints, " +
          "one of the two written twice",
      },
    ],
    [
      "src/io/config/schema.ts",
      { members: 1, why: 'cookie is the "kind" of a declared authentication scheme' },
    ],
  ]);

  /** The three ways a string literal is written. Built, so this file holds none. */
  const QUOTES: readonly string[] = ['"', "'", String.fromCharCode(96)];

  /**
   * The scan has to be reading a list rather than an empty one it could not
   * parse: an `entriesOf` that matched nothing would agree with every file in
   * the tree. The two numbers move only when somebody deliberately adds a
   * forbidden name, which is a change that should cost one line here.
   */
  it("reads both layers off the owner", () => {
    expect(EXACT).toHaveLength(11);
    expect(PREFIXES).toHaveLength(9);
    expect(EXACT).toContain("authorization");
    expect(PREFIXES).toContain("x-http-method");
  });

  it("has no second composition, whichever members it carries", () => {
    const carried = new Map<string, number>();
    for (const path of sources()) {
      // Case-folded, because `Authorization` is how a person writes a header
      // name and `forbiddenHeaderReason` lower-cases its argument for exactly
      // that reason. No file in this tree spells one of these with a capital
      // today, so folding costs nothing and closes the cheapest evasion there
      // is.
      const code = codeOf(path).toLowerCase();
      // All three ways a string literal is written, for the same reason. The
      // counts are the same with the third as without it, so it costs nothing
      // either: counted on 23 August 2026, `src/` holds fourteen backtick
      // spellings of a member across six files — eleven in doc blocks and three
      // in line comments — and `codeOf` drops every line they sit on.
      let written = 0;
      for (const member of MEMBERS) {
        for (const quote of QUOTES) {
          written += code.split(`${quote}${member}${quote}`).length - 1;
        }
      }
      if (written > 0) {
        carried.set(path, written);
      }
    }

    expect(Object.fromEntries(carried)).toEqual(
      Object.fromEntries([...HOMES].map(([path, home]) => [path, home.members])),
    );
  });
});

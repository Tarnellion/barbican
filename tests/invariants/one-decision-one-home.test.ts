/**
 * A decision with one home, and a gate that says what it holds.
 *
 * Three decisions in this repository were each written out several times, or
 * could be, and each has one module and an entry in the tables below:
 *
 * - the **key separator** and the keys glued with it (`src/core/keys.ts`,
 *   ADR-0059);
 * - the **`{name}` grammar** of a path template (`src/core/path-parameters.ts`,
 *   the note of 23 August on ADR-0024);
 * - the **grammar of an identifier** (`src/core/identifiers.ts`, ADR-0066), added
 *   here on 24 August 2026. It landed with one home and no gate, and a reviewer
 *   measured what that costs the same day: a second, independent copy of the
 *   grammar plus a new export `looksLikeAnIdentifier` in `src/report/findings.ts`
 *   left the whole suite green — that was their measurement, on the tree the ADR
 *   landed on. Written against this tree the same copy fails **1 test of 1828**,
 *   which is the assertion three functions down.
 *
 * The first gate could be walked around two ways and the second did not exist. A
 * reviewer put a second `cellKey` under another name into `src/report/`, and a
 * `const SEPARATOR = "\x00"` — the same character, spelled the way the gate did
 * not read — and a fourth copy of the `{name}` grammar back into
 * `src/runner/address.ts`. All three passed `pnpm run check` with exit 0.
 *
 * This file replaced them, and was then walked around six more ways on the same
 * day, every one of them green. Five of the six are closed here. The sixth — a
 * separator computed rather than written — is not, and the fifth is closed only
 * outside the two modules already allowed to build an expression at runtime; both
 * are named under "What it cannot see" below rather than left for the next
 * reviewer to find. ADR-0060 is why the file is shaped the way it is and carries
 * the same two lists.
 *
 * A second review the same day found two more, and both are closed: a brace
 * written as `\u007b`, which the brace scan read as an ordinary character while
 * the separator scan two functions away decoded escapes on principle; and the
 * constructor reached through `const Expression = RegExp`, which no count of
 * calls could see. See the amendment of 23 August 2026 in ADR-0060.
 *
 * ## What holds, and in what order
 *
 * 1. **The raw material does not leave its module.** `KEY_SEPARATOR` is not
 *    exported; `joinKey` is. `path-parameters.ts` never handed out its `RegExp`
 *    and does not start now. `identifiers.ts` exports three functions and no
 *    character class — no set, no array, no expression. A copy elsewhere
 *    therefore cannot borrow the decision — it has to write the decision out
 *    again, or reach into the owning module by name.
 * 2. **Writing it out again is what the scan reads.** Not one spelling of it: the
 *    sources are tokenised here and the escapes inside their literals are
 *    decoded, so every way of writing the code point zero **into a source
 *    literal** — the four-digit escape, `\x00`, `\u{0}`, `\0`, and the byte
 *    itself — is one thing to this file, because they are one character. The
 *    brace is read the same way since the second review of 23 August 2026: one
 *    decoder, both scans. It was not until then, and `/\u007b([^\u007d]+)\u007d/g`
 *    — the owner's grammar byte for byte — was a literal with no brace in it. A
 *    character computed rather than written is a different matter and is the
 *    first entry under "What it cannot see".
 *
 *    The identifier grammar's raw material is **three code points**, read the
 *    same way in both of the places a copy can put them: as a character inside a
 *    literal, and as a **numeric literal** in whatever base — `0x9f`, `159`,
 *    `0b10011111`, `0o237` are one thing here. `U+009F`, `U+2028` and `U+2029`
 *    are what separates this class from the address grammar's in
 *    `src/io/untrusted.ts`, which refuses a backslash, the C0 range and DEL and
 *    stops there; `0x20` and `0x7f` are shared between the two and so are not
 *    counted, and the three that are not shared are enough, because a copy
 *    faithful enough to be a copy has to write all three.
 * 3. **Reaching in is enumerated at the import, not at the call.** The first
 *    version of this check counted the text `joinKey(` per module, and
 *    `import { joinKey as glue }` reduced that count to zero — as would
 *    `const glue = joinKey`, an idiom already in the tree at
 *    `src/core/defects.ts`. What is enumerated now is which module may import
 *    which name out of an owning module. An import cannot be renamed away,
 *    because the imported name is written in the import whatever the local name
 *    becomes; the local name is banned from differing at all, so that a reader
 *    grepping for `joinKey` still finds every use of it.
 *
 *    **A barrel that re-exports an owner is a second address for its names**, and
 *    it is enumerated as one. `src/core/index.ts` does `export * from
 *    "./identifiers.js"` on purpose — the three names are on the published
 *    surface (ADR-0066) — so seven modules could import `identifier` from the
 *    barrel and never name the owner at all. `CONDUITS` is that allowance,
 *    written down with the module it stands for, and an import of a watched name
 *    through it is held to the same table as an import of it from the owner. The
 *    conduit is also pinned to re-exporting its owner exactly once, in both
 *    directions.
 * 4. **An owned name outside its owner is an import of it or a call of it, in
 *    any syntactic form.** Not "a declaration in the shapes we listed": the
 *    tokeniser classifies every occurrence, so a `function`, a `const`, a class
 *    member, an object method, a getter, an interface member and an overload
 *    signature are all declarations here, whatever their parameter lists
 *    contain and however many lines they run over. That replaces a regular
 *    expression which read `([^)]*)` and so missed a parameter typed
 *    `(part: string) => string`.
 * 5. **A regular expression built at runtime is enumerated too.** The brace scan
 *    reads regex literals, and `new RegExp` out of a non-foldable argument is not
 *    one. Two modules name `RegExp` at all and both are listed with a count, so a
 *    third fails; and any string or template literal handed to such a call is
 *    read for a brace as if it had been written as a literal expression. What is
 *    counted is every mention of the word rather than every call of it, because
 *    `const Expression = RegExp;` is a mention in no role a call count reads —
 *    and `new Expression("\\{([^}]+)\\}")` under it was a fourth copy of the
 *    grammar with everything green, Biome's `useRegexLiterals` included.
 *
 * ## What it cannot see
 *
 * This is not the section for shapes that are merely awkward to reach. Each of
 * these is a way past this file that is known to work, kept here because a gate
 * that is trusted for more than it holds is worse than no gate. What a scan of
 * source text can hold at all — and why a list like this one is measured rather
 * than reasoned about — is ADR-0065, once, for every gate of this family:
 *
 * - **A character obtained without writing a zero.** `decodeURIComponent("%00")`
 *   builds the separator out of a string this file reads as `%00`, and a second
 *   key builder under an unowned name that glues with it passes everything here.
 *   So does any arithmetic — `String.fromCharCode(one - one)` — or a code point
 *   read out of data. The one enumerated needle below reads
 *   `String.fromCharCode` and `String.fromCodePoint` of a **numeric zero written
 *   in a base**, which covers `0`, `0x0`, `0b0` and `0o0` and nothing cleverer.
 *   What holds against the class is 1 — the constant has no exported form to
 *   borrow, so a copy is a new implementation of the separator rather than a
 *   second reference to the one implementation, and it will drift when the one
 *   moves.
 * - **A `{name}` grammar written without a regular expression.** `indexOf` and
 *   `slice` over a brace is a different implementation rather than a copy, and
 *   nothing here reads it.
 * - **A `{name}` grammar inside a module already allowed to build a `RegExp`.**
 *   `src/core/selectors.ts` may construct one, and the pattern it constructs is
 *   read for a brace only in the part of it that is a literal. A grammar
 *   assembled there out of variables is invisible to this file.
 * - **A constructor reached without writing its name.** `const Expression = RegExp`
 *   is caught, because every mention of the word is counted; `/x/.constructor`,
 *   `Reflect.construct(…)` and a lookup on `globalThis` out of an assembled string
 *   are not. This is the same class as the separator above and has the same
 *   answer. What holds against it is 1 — the grammar has no exported form to
 *   borrow, so a copy is a second implementation that will drift when the one
 *   moves.
 * - **Two keys that glue the *same* coordinates in different orders.** `capRows`
 *   and `acceptanceKeyOf` were the example and stopped being one on 24 August
 *   2026: both ask `defectSignature` to extend its own signature now, so the two
 *   are one string rather than two orders of one pair (ADR-0066). The limitation
 *   is unchanged — it is a question about **what** is glued rather than about
 *   how, and nothing here can see that two tuples are the same tuple.
 * - **A copy of the identifier grammar that refuses a *narrower* class.** The
 *   class scan reads the three code points that are not shared with the address
 *   grammar, which is what makes it about this class rather than about any
 *   character test. A `looksLikeAnIdentifier` in `src/report/findings.ts`
 *   refusing only the C0 range and DEL therefore passes: measured, 119 files,
 *   1827 passed, 1 skipped. That is the right answer as far as the scan goes —
 *   `isNeverInAPath` is exactly such a function and is deliberate — and it is a
 *   hole all the same, because a narrower copy answering "can this be a name" is
 *   a second decision doing the first one's job.
 * - **The three code points computed rather than written.** `0x9e + 1` and
 *   `0x2027 + 1` give a faithful copy that writes none of them: measured, 119
 *   files, 1827 passed, 1 skipped. The same class as the separator above, with
 *   the same answer, and the same one enumerated courtesy: a numeric literal is
 *   read in any base, and `1_59` is past it.
 * - **A back door inside the grammar itself.** `if (value.startsWith("legacy:"))
 *   { return undefined; }` at the head of `refusalOf` passes the whole suite —
 *   119 files, 1827 passed, 1 skipped — because nothing pins the text of those
 *   three functions and `tests/core/identifiers.test.ts` varies the character
 *   rather than the string around it. ADR-0066 carries this one; it is repeated
 *   here because this file is now the gate a reader will look at first.
 * - **Anything outside `src/`, except the raw byte.** `tools/oracle/index.mjs`
 *   has a `cellKey` of its own on purpose — an oracle that shared the tool's code
 *   would agree with itself — and the tests that split `git ls-files -z` output
 *   split on a NUL that is not a key at all.
 * - **The tokeniser is not a parser.** It is written out here because a parser
 *   would be a package to vet for a gate whose value is being short enough to
 *   read (CLAUDE.md), and a hand-written one can lose its place. It is built to
 *   be loud when it does: anything it cannot finish throws, because a scan that
 *   has lost its place must never report "nothing found".
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
 * Everything else stops at `src/`.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as identifiers from "../../src/core/identifiers.js";
import * as keys from "../../src/core/keys.js";
import { cellKey, joinKey, objectKey } from "../../src/core/keys.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The character itself, from its code point: a raw one here would make this file binary. */
const RAW_SEPARATOR = String.fromCharCode(0);

/** The module that owns the separator and the keys glued with it. */
const KEYS = "src/core/keys.ts";

/** The module that owns the `{name}` grammar. */
const GRAMMAR = "src/core/path-parameters.ts";

/** The module that owns the grammar of an identifier. */
const IDENTIFIERS = "src/core/identifiers.ts";

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
 * The code points that make the identifier class and no other class in this tree.
 *
 * `U+009F` closes the C1 range, and `U+2028`/`U+2029` are the two Unicode line
 * separators. The address grammar in `src/io/untrusted.ts` refuses a backslash,
 * everything under `U+0020` and DEL, and none of these three — so a module that
 * writes one of them is either the owner or a second answer to the owner's
 * question. `0x20` and `0x7f` are deliberately **not** here: both grammars write
 * them, counting them would put `untrusted.ts` on the list for a reason that is
 * not this one, and a copy of the identifier class cannot be a copy without all
 * three of these.
 */
const CLASS_POINTS: ReadonlySet<number> = new Set([0x9f, 0x2028, 0x2029]);

/**
 * The files that may write one of them, and how many times each.
 *
 * Exact in both directions, like `SEPARATOR_HOMES`: a fourth mention in the owner
 * is a widened class nobody argued for, and a mention that disappears means the
 * scanner has stopped seeing.
 */
const CLASS_HOMES: ReadonlyMap<string, number> = new Map([
  // The owner: the three that are not shared with the address grammar, on the one
  // line of `isNotText`.
  [IDENTIFIERS, 3],
]);

/** Every name one of the three owning modules is the sole home of. */
const OWNED_NAMES: ReadonlyMap<string, string> = new Map([
  ["joinKey", KEYS],
  ["cellKey", KEYS],
  ["objectKey", KEYS],
  ["hasPathParameters", GRAMMAR],
  ["pathParameterNames", GRAMMAR],
  ["fillPathParameters", GRAMMAR],
  ["identifier", IDENTIFIERS],
  ["isUsableIdentifier", IDENTIFIERS],
  ["UnusableIdentifierError", IDENTIFIERS],
  ["spellOut", IDENTIFIERS],
]);

/**
 * A module that re-exports an owner, and so is a second address for its names.
 *
 * One entry, and it is a decision rather than an oversight: ADR-0066 puts
 * `UnusableIdentifierError`, `isUsableIdentifier` and `identifier` on the
 * published surface, because the library door holds a consumer to this grammar
 * and a rule a consumer cannot inspect is a wall rather than a check. `KEYS` and
 * `GRAMMAR` are on nobody's barrel and must stay off one — an entry added here
 * for either of them is that decision being made silently.
 *
 * An import of a **watched** name through a conduit is held to `REACHES_IN`
 * exactly as an import from the owner is; every other name the barrel carries is
 * none of this file's business.
 */
const CONDUITS: ReadonlyMap<string, { readonly owner: string; readonly why: string }> = new Map([
  [
    "src/core/index.ts",
    {
      owner: IDENTIFIERS,
      why: "the three names are the published surface of the grammar (ADR-0066)",
    },
  ],
]);

/**
 * Who may reach into an owning module, and for what.
 *
 * This is the enumeration the caller counter should have been. A module absent
 * from this table may not import an owned name and may not mention one; a module
 * present may import the names listed and call them, and may do nothing else with
 * them — no local rebinding, no re-export, no member of that name of its own.
 *
 * Enumerating the **import** rather than the call site is the point. A call can
 * be renamed (`import { joinKey as glue }`, or `const glue = joinKey` — an idiom
 * this repository already writes, at `src/core/defects.ts`), and the first
 * version of this gate counted the text `joinKey(` and so counted zero. The
 * imported name survives every rename, because it is what the import names.
 */
const REACHES_IN: ReadonlyMap<string, { readonly names: readonly string[]; readonly why: string }> =
  new Map([
    [
      "src/core/defects.ts",
      { names: ["joinKey"], why: "a defect signature, and the two keys that extend one" },
    ],
    ["src/report/findings.ts", { names: ["cellKey"], why: "the cell a finding names" }],
    [
      "src/runner/walk.ts",
      { names: ["cellKey", "objectKey"], why: "the cells walked, and the objects behind them" },
    ],
    ["src/core/matrix.ts", { names: ["pathParameterNames"], why: "whether a cell exists" }],
    ["src/runner/plan.ts", { names: ["hasPathParameters"], why: "what a run can address" }],
    ["src/runner/canaries.ts", { names: ["hasPathParameters"], why: "a canary is not templated" }],
    ["src/runner/address.ts", { names: ["fillPathParameters"], why: "substitution into a path" }],
    // The seam, and then the doors under it. ADR-0066's table is this list read
    // the other way round, and the two must not drift: a door that stops asking
    // still leaves the seam, and a **seventh** door added tomorrow with no entry
    // here is a module reaching into the owner without a reader having agreed.
    ["src/core/keys.ts", { names: ["identifier"], why: "the seam every key passes through" }],
    ["src/core/checks/registry.ts", { names: ["identifier"], why: "a registered check's id" }],
    ["src/adapters/endpoint-list.ts", { names: ["identifier"], why: "an entry's id" }],
    [
      "src/adapters/http.ts",
      {
        names: ["spellOut"],
        why:
          "a response header kept by value is the platform's own text, and it " +
          "travels into the report; JSON escapes C0 and leaves C1, so a control " +
          "character reaches the file whole",
      },
    ],
    ["src/adapters/openapi.ts", { names: ["identifier"], why: "an operationId, and the fallback" }],
    ["src/adapters/postman.ts", { names: ["identifier"], why: "an item's name and folder path" }],
    [
      "src/io/config/parse.ts",
      { names: ["identifier"], why: "an account, a resource and an acceptance" },
    ],
    ["src/io/config/contexts.ts", { names: ["identifier"], why: "a context id" }],
    [
      "src/report/compare.ts",
      { names: ["identifier"], why: "every string lifted out of a saved report" },
    ],
    [
      "src/report/write.ts",
      { names: ["identifier"], why: "the header and the cells of a resume stream" },
    ],
  ]);

/**
 * The modules that call `joinKey`, how often, and the key each one builds.
 *
 * Every entry here is a **different** key — a different tuple of coordinates, for
 * a different index — and that is what a further entry has to persuade a reader
 * of, rather than a matcher.
 *
 * The **count** is what makes that true of a module already on the list. Without
 * it, a second key builder inside `defects.ts` — the reviewer's `keyOfCell`,
 * moved one file over — would be borrowing an allowance granted for something
 * else. One entry here is one key; a module that needs two needs a reader.
 *
 * There were four entries until 24 August 2026. Two of them built a key that is
 * a defect signature and one coordinate more, by handing the finished signature
 * back to `joinKey` as a part; ADR-0066 made a part of a key an identifier, and
 * a signature is not one. Both ask `defectSignature` to extend itself instead,
 * which is why neither reaches into the owning module any more.
 *
 * The other owned names carry no count, because a count of them would mean
 * nothing: how many times `findings.ts` happens to ask for a cell key is not a
 * decision anybody should have to defend, and a number with no reason under it is
 * a number somebody eventually deletes.
 */
const KEY_BUILDERS: ReadonlyMap<string, { readonly calls: number; readonly key: string }> = new Map(
  [
    [KEYS, { calls: 2, key: "the owner: the cell key and the object key" }],
    [
      "src/core/defects.ts",
      {
        calls: 1,
        key:
          "endpoint, relation, conditions — a signature, and with a further part " +
          "the acceptance index and the per-defect evidence budget",
      },
    ],
  ],
);

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

/**
 * The modules that write the word `RegExp` in code at all, and how many times.
 *
 * A constructed expression is not a literal, so the brace scan does not read it —
 * that is how a fourth `{name}` grammar got back into `src/runner/address.ts`
 * with `pnpm run check` green. Biome's `useRegexLiterals` catches the constructor
 * over a plain string and folds it back to a literal; it does not catch one built
 * out of a variable, which is the shape that walked past. Construction is rare
 * enough to enumerate, so it is enumerated.
 *
 * The count was of **calls** until the second review of 23 August 2026, and a
 * call is not the only way to reach a constructor: `const Expression = RegExp;`
 * and then `new Expression(…)` built the owner's grammar in `src/runner/address.ts`
 * with everything green — the alias is a call of `Expression`, and the pattern
 * beside it is a string literal no scan reads. Every mention is counted now, in
 * whatever role, so the alias is the thing that fails. A mention obtained without
 * the word — `/x/.constructor` — is not covered and is under "What it cannot see".
 *
 * Each count is two: the construction, and the `RegExp` return type over the
 * function that performs it.
 */
const REGEXP_MENTIONS: ReadonlyMap<string, number> = new Map([
  // The owner, recompiling its one source under the `g` flag per call. The reason
  // it is a fresh object each time is `lastIndex`; see the module.
  [GRAMMAR, 2],
  // A path selector, anchored: `^…$` around an already-escaped body.
  ["src/core/selectors.ts", 2],
]);

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

/** A word or a single character of punctuation, in code position. */
interface Code {
  readonly kind: "word" | "punct";
  readonly text: string;
  readonly line: number;
}

type Token = Literal | Code;

function isLiteral(token: Token): token is Literal {
  return token.kind === "string" || token.kind === "template" || token.kind === "regex";
}

function isWord(token: Token | undefined, text: string): boolean {
  return token !== undefined && token.kind === "word" && token.text === text;
}

function isPunct(token: Token | undefined, text: string): boolean {
  return token !== undefined && token.kind === "punct" && token.text === text;
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
 * The tokens of a TypeScript source: words, punctuation, and the three kinds of
 * literal.
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
 * braces of an interpolation are in nobody's body — and the code inside one is
 * tokenised like any other code. A template that carries an interpolation is
 * emitted at its closing backtick, which puts it after the tokens of its own
 * interpolations; nothing here depends on the order between those two.
 */
function tokensOf(source: string, where: string): readonly Token[] {
  const found: Token[] = [];
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

  const punct = (char: string): void => {
    found.push({ kind: "punct", text: char, line });
    previous = char;
    at += 1;
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
      punct(char);
      continue;
    }
    if (frame !== undefined && char === "{") {
      frame.depth += 1;
      punct(char);
      continue;
    }
    if (char === "/") {
      if (previous === "" || BEFORE_A_REGEX.has(previous)) {
        readRegex();
        continue;
      }
      punct(char);
      continue;
    }
    if (IDENTIFIER.test(char)) {
      const start = line;
      let word = "";
      while (IDENTIFIER.test(source.charAt(at))) {
        word += source.charAt(at);
        at += 1;
      }
      found.push({ kind: "word", text: word, line: start });
      previous = word;
      continue;
    }
    punct(char);
  }
  if (interpolations.length > 0) fail("unterminated template");
  return found;
}

/** The literals alone, in source order, for the scans that only read literals. */
function literalsOf(source: string, where: string): readonly Literal[] {
  return tokensOf(source, where).filter(isLiteral);
}

/**
 * Every escape that stands for a single character: the two brace forms, the
 * four-digit form, the two-digit hex form and the octal family that `\0` belongs
 * to.
 *
 * Decoding rather than matching is the point of this gate. It holds no list of
 * ways to write the separator or the brace; it reads what a spelling *means*, so
 * a spelling nobody has thought of yet is covered the day it is written. It
 * over-approximates on a literal backslash followed by an escape — which nothing
 * under `src/` writes, and which would fail loudly rather than quietly.
 */
const ESCAPE =
  /\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([0-7]{1,3})(?![0-9]))/g;

/**
 * A literal's body with every such escape resolved to the character it stands
 * for.
 *
 * One decoder, read by both scans below. The separator scan had it from the
 * start — "it reads what a spelling *means*, so a spelling nobody has thought of
 * yet is covered the day it is written" — and the brace scan did not, which made
 * that sentence false of half this file: `/{([^}]+)}/g` is the
 * owner's grammar byte for byte and went through the brace scan as a literal
 * with no brace in it. Found by the second adversarial review of 23 August 2026.
 *
 * A code point outside the Unicode range is left as it was written: nothing
 * legal spells one, and `String.fromCodePoint` throws on it, which would turn a
 * scan into a crash rather than a finding.
 */
function decodeEscapes(body: string): string {
  return body.replace(
    ESCAPE,
    (match, braced?: string, four?: string, hex?: string, octal?: string) => {
      const digits = braced ?? four ?? hex;
      const point =
        digits === undefined ? Number.parseInt(octal ?? "", 8) : Number.parseInt(digits, 16);
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : match;
    },
  );
}

/** How many times a literal's body spells the separator, in any spelling of it. */
function spellsTheSeparator(body: string): number {
  return decodeEscapes(body).split(RAW_SEPARATOR).length - 1;
}

/**
 * A word token read as a numeric literal, or `NaN`.
 *
 * The tokeniser above makes `0x9f`, `159`, `0b10011111` and `0o237` one word
 * apiece, because every character of each is in `IDENTIFIER`. `Number` reads all
 * four as 159, which is the point: a copy of the class may write its code points
 * in any base, and the base is not the decision.
 *
 * The leading-digit guard is what keeps `Number("")` — which is 0 — and an
 * ordinary name out of it. A numeric separator (`1_59`) reads as `NaN` and is
 * under "What it cannot see".
 */
function numberOf(text: string): number {
  return /^[0-9]/.test(text) ? Number(text) : Number.NaN;
}

/**
 * How many times a source writes one of the identifier class's code points.
 *
 * Both places a copy can put one: inside a literal as the character itself, in
 * any escape spelling (`decodeEscapes` is the same decoder the separator scan
 * uses), and in code as a numeric literal in any base. A comment is neither, so
 * prose naming `U+2028` is not a finding — which matters, because the owner's own
 * header explains the class in words.
 */
function spellsTheClass(tokens: readonly Token[]): number {
  let total = 0;
  for (const token of tokens) {
    if (isLiteral(token)) {
      for (const character of decodeEscapes(token.body)) {
        if (CLASS_POINTS.has(character.codePointAt(0) ?? -1)) total += 1;
      }
      continue;
    }
    if (token.kind === "word" && CLASS_POINTS.has(numberOf(token.text))) total += 1;
  }
  return total;
}

/** A repetition count, which is the one thing a brace means that is not a grammar. */
const QUANTIFIER = /\{\d+(?:,\d*)?\}/g;

function hasABraceGrammar(body: string): boolean {
  const counted = decodeEscapes(body).replace(QUANTIFIER, "");
  return counted.includes("{") || counted.includes("}");
}

function isBraceGrammar(literal: Literal): boolean {
  return literal.kind === "regex" && hasABraceGrammar(literal.body);
}

/**
 * The one enumerated needle in this file, and the narrowest thing in it.
 *
 * It reads `String.fromCharCode` and `String.fromCodePoint` of a numeric zero
 * written in a base — `0`, `0x0`, `0b0`, `0o0`. It does not read
 * `decodeURIComponent("%00")`, an arithmetic expression, or a code point taken
 * out of data, and nothing of this kind could. See "What it cannot see" above:
 * this needle is a courtesy and not what holds.
 */
const FROM_A_CODE_POINT = /\bfrom(?:CharCode|CodePoint)\(\s*(?:0[xX]0+|0[bB]0+|0[oO]0+|0+)\s*\)/;

/**
 * A module path as this repository writes one, resolved to a tracked path.
 *
 * `./keys.js` from `src/core/defects.ts` and `../core/keys.js` from
 * `src/report/findings.ts` are the same module, and the gate has to know that.
 * The extension moves back from `.js` to `.ts` because `nodenext` writes the
 * emitted name in the source.
 */
function moduleOf(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const target = resolve(dirname(resolve(ROOT, from)), specifier);
  return relative(ROOT, target).split(sep).join("/").replace(/\.js$/, ".ts");
}

interface ImportedName {
  readonly name: string;
  readonly local: string;
  readonly index: number;
  readonly line: number;
}

interface ImportDeclaration {
  /** The module imported from, resolved, or `undefined` for a bare specifier. */
  readonly module: string | undefined;
  readonly names: readonly ImportedName[];
  /** `import * as x from …`, which puts every export behind a property access. */
  readonly namespace: boolean;
  readonly first: number;
  readonly last: number;
  readonly line: number;
}

/**
 * The import declarations of a source, from its tokens.
 *
 * Enough of the grammar to answer two questions and no more: which module, and
 * which names under which local names. A dynamic `import(` is not a declaration
 * and is skipped. A declaration whose specifier string never arrives throws,
 * like everything else here that has lost its place.
 */
function importsOf(tokens: readonly Token[], where: string): readonly ImportDeclaration[] {
  const found: ImportDeclaration[] = [];
  for (let at = 0; at < tokens.length; at += 1) {
    const token = tokens[at];
    if (!isWord(token, "import") || isPunct(tokens[at + 1], "(")) continue;
    let last = at + 1;
    while (last < tokens.length && !isLiteral(tokens[last] as Token)) last += 1;
    const source = tokens[last];
    if (source === undefined || !isLiteral(source) || source.kind !== "string") {
      throw new Error(`${where}: an import with no module specifier`);
    }
    const names: ImportedName[] = [];
    let namespace = false;
    for (let index = at + 1; index < last; index += 1) {
      const one = tokens[index];
      if (one === undefined) continue;
      if (isPunct(one, "*")) namespace = true;
      if (one.kind !== "word") continue;
      if (one.text === "type" || one.text === "as" || one.text === "from") continue;
      if (isWord(tokens[index - 1], "as")) continue;
      const renamed = isWord(tokens[index + 1], "as") ? tokens[index + 2] : undefined;
      names.push({
        name: one.text,
        local: renamed !== undefined && renamed.kind === "word" ? renamed.text : one.text,
        index,
        line: one.line,
      });
    }
    found.push({
      module: moduleOf(where, source.body),
      names,
      namespace,
      first: at,
      last,
      line: (token as Code).line,
    });
    at = last;
  }
  return found;
}

/** From `(` at `open`, the index of the `)` that closes it. Throws if there is none. */
function closingParen(tokens: readonly Token[], open: number, where: string, line: number): number {
  let depth = 0;
  for (let at = open; at < tokens.length; at += 1) {
    if (isPunct(tokens[at], "(")) depth += 1;
    else if (isPunct(tokens[at], ")")) {
      depth -= 1;
      if (depth === 0) return at;
    }
  }
  throw new Error(`${where}:${line}: a parenthesis that never closes`);
}

/** What binds a name, so that the word after one of these is a declaration. */
const BINDS = new Set(["function", "const", "let", "var", "class", "interface", "enum", "type"]);

type Role = "import" | "call" | "declaration" | "other";

interface Occurrence {
  readonly name: string;
  readonly role: Role;
  readonly line: number;
}

/**
 * What every occurrence of a watched name in a source is doing.
 *
 * Four answers, and the two that are not `import` or `call` are what the gate
 * refuses. The classification is by position in the token stream, so it does not
 * depend on how a declaration is spelled:
 *
 * - inside an import declaration → `import`;
 * - after `function`, `const`, `let`, `var`, `class`, `interface`, `enum` or
 *   `type` (and after the `*` of a generator) → `declaration`;
 * - a name whose parentheses close onto a `{` or a `:` → `declaration`, which is
 *   a class member, an object method, a getter, an interface member or an
 *   overload signature, whatever its parameter list holds and however many lines
 *   it runs over;
 * - a name followed by parentheses that close onto anything else → `call`;
 * - anything else at all — `const glue = joinKey`, `export { joinKey }`,
 *   `keys.joinKey`, a name in a type position → `other`.
 *
 * A ternary whose consequent is a call — `x ? cellKey(a) : b` — reads as a
 * declaration here and would fail. Nothing under `src/` writes one, and a gate
 * failing loudly on a shape it misreads is the trade this whole file makes.
 */
function occurrencesOf(
  tokens: readonly Token[],
  imports: readonly ImportDeclaration[],
  watched: ReadonlySet<string>,
  where: string,
): readonly Occurrence[] {
  const found: Occurrence[] = [];
  for (let at = 0; at < tokens.length; at += 1) {
    const token = tokens[at];
    if (token === undefined || token.kind !== "word" || !watched.has(token.text)) continue;
    const inside = imports.some((one) => at >= one.first && at <= one.last);
    if (inside) {
      found.push({ name: token.text, role: "import", line: token.line });
      continue;
    }
    const back = isPunct(tokens[at - 1], "*") ? at - 2 : at - 1;
    const before = tokens[back];
    if (before !== undefined && before.kind === "word" && BINDS.has(before.text)) {
      found.push({ name: token.text, role: "declaration", line: token.line });
      continue;
    }
    if (isPunct(tokens[at - 1], ".") || !isPunct(tokens[at + 1], "(")) {
      found.push({ name: token.text, role: "other", line: token.line });
      continue;
    }
    const close = closingParen(tokens, at + 1, where, token.line);
    const next = tokens[close + 1];
    const declared = isPunct(next, "{") || isPunct(next, ":");
    found.push({ name: token.text, role: declared ? "declaration" : "call", line: token.line });
  }
  return found;
}

/** Every literal handed to a `RegExp` call, which the brace scan reads as a pattern. */
function regexpArguments(tokens: readonly Token[], where: string): readonly Literal[] {
  const found: Literal[] = [];
  for (let at = 0; at < tokens.length; at += 1) {
    const token = tokens[at];
    if (token === undefined || token.kind !== "word" || token.text !== "RegExp") continue;
    if (!isPunct(tokens[at + 1], "(")) continue;
    const close = closingParen(tokens, at + 1, where, token.line);
    for (let index = at + 2; index < close; index += 1) {
      const one = tokens[index];
      if (one !== undefined && isLiteral(one)) found.push(one);
    }
  }
  return found;
}

/**
 * How many times a module writes the word `RegExp` in code at all.
 *
 * Calls were what this counted, on the reasoning that a return type is not a
 * construction. True, and beside the point: the constructor can be reached
 * through any name that is bound to it, and `const Expression = RegExp;` was
 * a mention in no role this counted, followed by a `new Expression("\\{([^}]+)\\}")`
 * that `regexpArguments` never looked at because the word beside the parenthesis
 * was not `RegExp`. Green, and a fourth copy of the owner's grammar. Biome's
 * `useRegexLiterals` does not see it either — the argument is a constant, but the
 * callee is not the constructor it knows.
 *
 * So every mention is counted, whatever it is doing: a call, a type annotation, a
 * binding. A module that gains a `: RegExp` return type is red until its count is
 * updated, which is the same trade every table in this file makes, and the same
 * one it makes for a rename. The word itself is what is counted — `pathPatternToRegExp`
 * is a different identifier and is not one.
 */
function regexpMentions(tokens: readonly Token[], where: string): number {
  return occurrencesOf(tokens, [], new Set(["RegExp"]), where).length;
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
    expect(() => tokensOf("f(", "<sample>")).not.toThrow();
    expect(() => occurrencesOf(tokensOf("f(", "<sample>"), [], new Set(["f"]), "<sample>")).toThrow(
      "a parenthesis that never closes",
    );
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

  it("reads a zero written in a base, and says so about the rest", () => {
    expect(FROM_A_CODE_POINT.test("String.fromCharCode(0)")).toBe(true);
    expect(FROM_A_CODE_POINT.test("String.fromCharCode(0x0)")).toBe(true);
    expect(FROM_A_CODE_POINT.test("String.fromCodePoint(0b0)")).toBe(true);
    expect(FROM_A_CODE_POINT.test("String.fromCharCode(0o00)")).toBe(true);
    expect(FROM_A_CODE_POINT.test("String.fromCharCode(65)")).toBe(false);
    // The limit, pinned so that nobody reads the needle as more than it is.
    expect(FROM_A_CODE_POINT.test('decodeURIComponent("%00")')).toBe(false);
    expect(FROM_A_CODE_POINT.test("String.fromCharCode(one - one)")).toBe(false);
  });

  it("reads a code point of the identifier class in any base, and as the character", () => {
    const written = (text: string): number => spellsTheClass(tokensOf(text, "<sample>"));

    // In code, in four bases, and the owner's own line.
    expect(written("const a = 0x9f;")).toBe(1);
    expect(written("const a = 159;")).toBe(1);
    expect(written("const a = 0b10011111;")).toBe(1);
    expect(written("const a = 0o237;")).toBe(1);
    expect(written("return code >= 0x7f && code <= 0x9f;")).toBe(1);
    expect(written("return c === 0x2028 || c === 0x2029;")).toBe(2);
    expect(written("return c === 8232 || c === 8233;")).toBe(2);
    // In a literal, as the character. The decoder is the one the separator scan
    // reads with, so the class written out as a character range is caught however
    // it is spelled. The samples write escapes rather than the characters
    // themselves, for the reason the separator is never written raw: a control
    // character in a tracked file makes the file binary to a search over it.
    expect(written(String.raw`const re = /[\u009f\u2028\u2029]/;`)).toBe(3);
    expect(written(String.raw`const re = /[\x9f]/;`)).toBe(1);
    expect(written(String.raw`const s = "\u{2028}";`)).toBe(1);
    // And the character itself, built rather than written, so that the sample is
    // the one thing in this file that proves the decoding is not all there is.
    expect(written(`const s = "${String.fromCodePoint(0x2029)}";`)).toBe(1);
    // And the neighbours are not it: the two shared with the address grammar, a
    // decimal that only looks like one, and prose in a comment.
    expect(written("return code < 0x20 || code === 0x7f;")).toBe(0);
    expect(written("const a = 2028;")).toBe(0);
    expect(written("// the two line separators are 0x2028 and 0x2029")).toBe(0);
    // The limit, pinned so that nobody reads the scan as more than it is.
    expect(written("const a = 0x9e + 1;")).toBe(0);
    expect(written('const a = Number.parseInt("9f", 16);')).toBe(0);
    expect(written("const a = 1_59;")).toBe(0);
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

  it("resolves a module specifier the way the compiler does", () => {
    expect(moduleOf("src/core/defects.ts", "./keys.js")).toBe("src/core/keys.ts");
    expect(moduleOf("src/report/findings.ts", "../core/keys.js")).toBe("src/core/keys.ts");
    expect(moduleOf("src/io/config/parse.ts", "../../core/keys.js")).toBe("src/core/keys.ts");
    expect(moduleOf("src/core/defects.ts", "node:crypto")).toBeUndefined();
  });

  it("reads what an import brings in, under whatever local name", () => {
    const parse = (source: string): readonly ImportDeclaration[] =>
      importsOf(tokensOf(source, "<sample>"), "src/report/findings.ts");

    expect(parse('import { joinKey } from "../core/keys.js";')[0]).toMatchObject({
      module: "src/core/keys.ts",
      names: [{ name: "joinKey", local: "joinKey" }],
      namespace: false,
    });
    expect(parse('import { joinKey as glue } from "../core/keys.js";')[0]).toMatchObject({
      names: [{ name: "joinKey", local: "glue" }],
    });
    expect(parse('import * as keys from "../core/keys.js";')[0]).toMatchObject({
      namespace: true,
    });
    expect(parse('import type { Cell } from "../core/index.js";')[0]).toMatchObject({
      names: [{ name: "Cell", local: "Cell" }],
    });
    // A dynamic import is an expression, not a declaration.
    expect(parse('const m = await import("../core/keys.js");')).toEqual([]);
  });

  it("tells a declaration from a call, in every form either can take", () => {
    const roles = (source: string): readonly Role[] => {
      const tokens = tokensOf(source, "<sample>");
      return occurrencesOf(
        tokens,
        importsOf(tokens, "src/report/compare.ts"),
        new Set(["cellKey"]),
        "<sample>",
      ).map((one) => one.role);
    };

    expect(roles("export function cellKey(cell: Cell): string { return in(cell); }")).toEqual([
      "declaration",
    ]);
    expect(roles("async function* cellKey<T>(cell: T) { yield 1; }")).toEqual(["declaration"]);
    expect(roles("const cellKey = (cell) => 1;")).toEqual(["declaration"]);
    expect(roles("const cellKey=(cell)=>1;")).toEqual(["declaration"]);
    expect(roles("let cellKey: Fn = of;")).toEqual(["declaration"]);
    expect(roles("class A {\n  cellKey(cell) {\n    return 1;\n  }\n}")).toEqual(["declaration"]);
    expect(roles("const to = {\n  cellKey: (cell) => 1,\n};")).toEqual(["other"]);
    // The shape the previous check could not see: a `)` inside the parameter
    // list, and a parameter list spread over several lines.
    expect(
      roles(
        "const to = {\n  cellKey(cell: Cell, esc: (part: string) => string) {\n    return 1;\n  },\n};",
      ),
    ).toEqual(["declaration"]);
    expect(
      roles("class A {\n  cellKey(\n    cell: Cell,\n  ): string {\n    return 1;\n  }\n}"),
    ).toEqual(["declaration"]);
    expect(roles("interface Keys {\n  cellKey(cell: Cell): string;\n}")).toEqual(["declaration"]);
    expect(roles("class A {\n  get cellKey() {\n    return 1;\n  }\n}")).toEqual(["declaration"]);
    expect(roles("class A {\n  static cellKey(cell: Cell): string;\n}")).toEqual(["declaration"]);
    // And a call is still a call, including one whose arguments run over lines.
    expect(roles("const key = cellKey(observation);")).toEqual(["call"]);
    expect(roles("const key = cellKey({\n  accountId: a,\n});")).toEqual(["call"]);
    expect(roles("map.set(cellKey(cell), cell);")).toEqual(["call"]);
    // Neither, and both are refused outside the owning module.
    expect(roles('import { cellKey } from "../core/keys.js";')).toEqual(["import"]);
    expect(roles("const glue = cellKey;")).toEqual(["other"]);
    expect(roles('export { cellKey } from "../core/keys.js";')).toEqual(["other"]);
    expect(roles("keys.cellKey(observation);")).toEqual(["other"]);
  });

  it("reads a pattern handed to RegExp, and counts every mention of the name", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the sample is the source text of a module that builds its grammar out of a variable — the interpolation is the subject, not a mistake in this string
    const source = 'const re = new RegExp(`\\\\{${name}\\\\}`, "g");';
    const tokens = tokensOf(source, "<sample>");
    expect(regexpMentions(tokens, "<sample>")).toBe(1);
    expect(regexpArguments(tokens, "<sample>").some((one) => hasABraceGrammar(one.body))).toBe(
      true,
    );
    // A return type is a mention, and so is a binding — the shape that reaches
    // the constructor under a name this file is not watching.
    const mentions = (text: string): number =>
      regexpMentions(tokensOf(text, "<sample>"), "<sample>");
    expect(mentions("function f(): RegExp { return g; }")).toBe(1);
    expect(mentions("const Expression = RegExp;")).toBe(1);
    // And the word is the word: a longer identifier that ends in it is not one.
    expect(mentions("export function pathPatternToRegExp(p: string) { return p; }")).toBe(0);
  });

  it("reads a brace spelled as an escape", () => {
    // The owner's grammar byte for byte, spelled in escapes.
    expect(hasABraceGrammar(String.raw`\u007b([^\u007d]+)\u007d`)).toBe(true);
    expect(hasABraceGrammar(String.raw`\x7b([^\x7d]+)\x7d`)).toBe(true);
    // Not a case about escapes, and it was labelled as one. The braced form
    // writes a brace of its own, so the answer is true before any decoding as
    // well as after it: measured on 23 August 2026, the scan as it stood before
    // `decodeEscapes` reached it answers true for this string and false for the
    // two above. It stays because the braced form should be read at all; the two
    // above it are what discriminate.
    expect(hasABraceGrammar(String.raw`\u{7b}`)).toBe(true);
    // And a quantifier is still a quantifier however it is spelled.
    expect(hasABraceGrammar(String.raw`\d{4}`)).toBe(false);
    // A code point outside the Unicode range is left as it was written rather
    // than thrown on — and what is written carries two braces of its own, so it
    // is a finding. Over-approximating loudly is the direction this file fails in.
    expect(hasABraceGrammar(String.raw`\u{ffffffff}`)).toBe(true);
  });
});

describe("one decision, one home", () => {
  const everything = tracked();
  const sources = tracked("src").filter((path) => path.endsWith(".ts"));
  const owners = new Set(OWNED_NAMES.values());
  const watched = new Set(OWNED_NAMES.keys());
  const read = new Map(
    sources.map((path) => {
      const tokens = tokensOf(sourceOf(path), path);
      return [path, { tokens, imports: importsOf(tokens, path) }];
    }),
  );

  const tokensFor = (path: string): readonly Token[] => read.get(path)?.tokens ?? [];
  const importsFor = (path: string): readonly ImportDeclaration[] => read.get(path)?.imports ?? [];

  it("sees the tree, rather than an empty list", () => {
    // A check that found nothing is green for the same reason a passing one is.
    expect(everything.length).toBeGreaterThan(200);
    expect(sources.length).toBeGreaterThan(30);
    for (const path of SEPARATOR_HOMES.keys()) expect(sources).toContain(path);
    for (const path of REACHES_IN.keys()) expect(sources).toContain(path);
    for (const path of KEY_BUILDERS.keys()) expect(sources).toContain(path);
    for (const path of BRACE_GRAMMARS.keys()) expect(sources).toContain(path);
    for (const path of REGEXP_MENTIONS.keys()) expect(sources).toContain(path);
    for (const path of CLASS_HOMES.keys()) expect(sources).toContain(path);
    for (const path of CONDUITS.keys()) expect(sources).toContain(path);
    for (const owner of new Set(OWNED_NAMES.values())) expect(sources).toContain(owner);
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
        count: tokensFor(path)
          .filter(isLiteral)
          .reduce((total, literal) => total + spellsTheSeparator(literal.body), 0),
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

  it("hands out the rule and not the class of characters", () => {
    // The same seam one module over. `isNotText` is private, and so is every
    // spelling of what it decides: no set, no array, no expression, no list of
    // code points. What leaves is four functions that answer the question, so a
    // copy elsewhere cannot borrow the class — it has to write the class out, and
    // writing it out is what the scan below reads.
    //
    // `spellOut` is the fourth, added 24 August 2026. It hands out a rendering
    // and not the class: a caller learns which characters are not text only by
    // reading its output, one string at a time, which is no more than it learns
    // from `identifier` refusing. It exists because the report carries a response
    // header value the platform chose, and `JSON.stringify` escapes C0 while
    // leaving C1 alone — see ADR-0066.
    expect(Object.keys(identifiers).sort()).toEqual([
      "UnusableIdentifierError",
      "identifier",
      "isUsableIdentifier",
      "spellOut",
    ]);
    expect(
      Object.entries(identifiers)
        .filter(([, value]) => typeof value !== "function")
        .map(([name]) => name),
      "Something other than a function leaves src/core/identifiers.ts. A code " +
        "point, a set of them or an expression over them is the raw material, and " +
        "handing it out is how a second implementation becomes a second reference " +
        "that nobody notices. See ADR-0066.",
    ).toEqual([]);
  });

  it("writes the identifier class's code points in one module", () => {
    const written = sources
      .map((path) => ({ path, count: spellsTheClass(tokensFor(path)) }))
      .filter((file) => file.count !== (CLASS_HOMES.get(file.path) ?? 0))
      .map((file) => `${file.path} (${file.count})`);

    expect(
      written,
      `A code point of the identifier class is written where it should not be, or ` +
        `is no longer written where it should: ${written.join(", ")}. U+009F, ` +
        `U+2028 and U+2029 are what tells this class from the address grammar's, ` +
        `and every base and every escape spelling of one is the same thing here. ` +
        `There is no class to import: call identifier or isUsableIdentifier. ` +
        `See ADR-0066.`,
    ).toEqual([]);
  });

  it("lets the listed modules reach into an owning module, and no others", () => {
    const wrong: string[] = [];
    for (const path of sources) {
      const allowed = REACHES_IN.get(path)?.names ?? [];
      for (const declaration of importsFor(path)) {
        const module = declaration.module;
        // A conduit is the owner's second address, so an import of a watched name
        // through it is the same reach; every other name a barrel carries is not
        // this file's business.
        const conduit = module === undefined ? undefined : CONDUITS.get(module);
        if (module === undefined || (!owners.has(module) && conduit === undefined)) continue;
        // An owner importing from itself cannot happen, and an owner importing
        // from another owner is a reach like any other: `src/core/keys.ts` asks
        // `identifiers.ts` for the seam, and that is an entry in the table.
        if (module === path) continue;
        if (declaration.namespace) {
          wrong.push(`${path}:${declaration.line} imports ${module} as a namespace`);
          continue;
        }
        for (const one of declaration.names) {
          if (conduit !== undefined && !OWNED_NAMES.has(one.name)) continue;
          if (one.local !== one.name) {
            wrong.push(`${path}:${one.line} imports ${one.name} under the name ${one.local}`);
          }
          if (!allowed.includes(one.name)) {
            wrong.push(
              `${path}:${one.line} imports ${one.name}${conduit === undefined ? "" : ` through ${module}`}`,
            );
          }
        }
      }
    }

    expect(
      wrong,
      `A module reaches into an owning module in a way the table does not grant: ` +
        `${wrong.join("; ")}. The table is the enumeration; a renamed import and a ` +
        `namespace import are refused because both make the imported name ` +
        `invisible at the place it is used. See ADR-0060.`,
    ).toEqual([]);
  });

  it("mentions an owning module's path only in an import of it, or in the one conduit", () => {
    const wrong: string[] = [];
    const reExported = new Map<string, number>();
    for (const path of sources) {
      const declarations = importsFor(path);
      for (const [at, token] of tokensFor(path).entries()) {
        if (!isLiteral(token) || token.kind !== "string") continue;
        const target = moduleOf(path, token.body);
        if (target === undefined || !owners.has(target) || target === path) continue;
        if (declarations.some((one) => one.last === at)) continue;
        if (CONDUITS.get(path)?.owner === target) {
          reExported.set(path, (reExported.get(path) ?? 0) + 1);
          continue;
        }
        wrong.push(`${path}:${token.line} names ${target} outside an import`);
      }
    }
    // Exact in both directions, like every count in this file. A conduit that has
    // stopped re-exporting its owner means the surface ADR-0066 argued for is
    // gone; a second mention means the barrel is doing something else with it.
    for (const [path, conduit] of CONDUITS) {
      const times = reExported.get(path) ?? 0;
      if (times !== 1) {
        wrong.push(`${path} re-exports ${conduit.owner} ${times} times rather than once`);
      }
    }

    expect(
      wrong,
      `An owning module's path is written somewhere that is not an import of it: ` +
        `${wrong.join("; ")}. \`export … from\` and a dynamic import both put the ` +
        `owner's names somewhere the import table cannot see them — which is why ` +
        `the one barrel allowed to do it is in CONDUITS, with the reason and a ` +
        `count, and why an import through it is held to REACHES_IN all the same.`,
    ).toEqual([]);
  });

  it("uses an owned name outside its owner only by calling what was imported", () => {
    const wrong: string[] = [];
    for (const path of sources) {
      const imported = new Set(
        importsFor(path)
          .filter(
            (one) =>
              one.module !== undefined && (owners.has(one.module) || CONDUITS.has(one.module)),
          )
          .flatMap((one) => one.names.map((name) => name.name)),
      );
      for (const one of occurrencesOf(tokensFor(path), importsFor(path), watched, path)) {
        // Per name rather than per file: three owners now, and one of them —
        // `src/core/keys.ts` — both owns names and calls another owner's.
        if (OWNED_NAMES.get(one.name) === path) continue;
        if (one.role === "import") continue;
        if (one.role !== "call") {
          wrong.push(
            `${path}:${one.line} ${one.role === "declaration" ? "declares" : "holds"} ${one.name}`,
          );
          continue;
        }
        if (!imported.has(one.name)) {
          wrong.push(`${path}:${one.line} calls ${one.name} without importing it`);
        }
      }
    }

    expect(
      wrong,
      `A name with one home is used somewhere as something other than a call of ` +
        `the import: ${wrong.join("; ")}. A second declaration is the copy ADR-0059 ` +
        `and ADR-0060 are about, in whatever form it is written; a reference that ` +
        `is not a call — \`const glue = joinKey\`, a re-export, a property access — ` +
        `is how a copy hides from the count below.`,
    ).toEqual([]);
  });

  it("declares each owned name once, in the module that owns it", () => {
    const wrong: string[] = [];
    for (const [name, owner] of OWNED_NAMES) {
      const roles = occurrencesOf(tokensFor(owner), importsFor(owner), new Set([name]), owner).map(
        (one) => one.role,
      );
      const declarations = roles.filter((role) => role === "declaration").length;
      if (declarations !== 1) wrong.push(`${owner} declares ${name} ${declarations} times`);
      const other = roles.filter((role) => role === "other").length;
      if (other !== 0) wrong.push(`${owner} holds ${name} ${other} times without calling it`);
    }

    expect(
      wrong,
      `An owning module does not declare exactly one of its own names: ` +
        `${wrong.join("; ")}. A second spelling inside the owner is the same ` +
        `duplicate one directory further in, and it passed every assertion of the ` +
        `first gate.`,
    ).toEqual([]);
  });

  it("lets two modules call joinKey, each for one key of its own", () => {
    const wrong = sources
      .map((path) => ({
        path,
        calls: occurrencesOf(tokensFor(path), importsFor(path), new Set(["joinKey"]), path).filter(
          (one) => one.role === "call",
        ).length,
      }))
      .filter((file) => file.calls !== (KEY_BUILDERS.get(file.path)?.calls ?? 0))
      .map((file) => `${file.path} (${file.calls})`);

    expect(
      wrong,
      `joinKey is called somewhere that builds no key of its own, or a module on ` +
        `the list builds a second one: ${wrong.join(", ")}. Each of the two ` +
        `entries in this file is a different tuple of coordinates and one key; a ` +
        `third entry, or a second key inside one of the two, is exactly what this ` +
        `gate exists for — whatever the function calls itself. See ADR-0060.`,
    ).toEqual([]);
  });

  it("writes a brace-delimited grammar in one module, and in two others for a reason", () => {
    const written = sources
      .map((path) => ({
        path,
        count:
          tokensFor(path).filter((token) => isLiteral(token) && isBraceGrammar(token)).length +
          regexpArguments(tokensFor(path), path).filter((one) => hasABraceGrammar(one.body)).length,
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

  it("names RegExp in two modules, and counts every mention of it", () => {
    const built = sources
      .map((path) => ({ path, count: regexpMentions(tokensFor(path), path) }))
      .filter((file) => file.count !== (REGEXP_MENTIONS.get(file.path) ?? 0))
      .map((file) => `${file.path} (${file.count})`);

    expect(
      built,
      `The word RegExp is written where the table does not allow it, or no longer ` +
        `where it does: ${built.join(", ")}. A constructed expression is not a ` +
        `literal, so the brace scan above reads only the literal parts of its ` +
        `pattern — which is how a fourth \`{name}\` grammar got back into ` +
        `src/runner/address.ts with everything green, and a second one got back ` +
        `through \`const Expression = RegExp\`, which is a mention and not a call. ` +
        `Every mention is counted for that reason, a type annotation included. ` +
        `See ADR-0060.`,
    ).toEqual([]);
  });

  it("holds one expression in the module that owns the grammar", () => {
    // A second spelling inside the owning module is the same duplicate one
    // directory further in, and it passed every assertion of the first gate.
    const expressions = tokensFor(GRAMMAR).filter(
      (token): token is Literal => isLiteral(token) && token.kind === "regex",
    );

    expect(expressions.map((literal) => literal.body)).toEqual(["\\{([^}]+)\\}"]);
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

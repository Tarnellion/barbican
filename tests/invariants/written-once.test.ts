/**
 * Three decisions this repository makes once, held to being made once.
 *
 * ADR-0024 states the principle and `src/io/untrusted.ts` opens with the count
 * that produced it: eleven point fixes of one shape across four files, two of
 * them already drifted apart. The sweep of 22 August 2026 found the principle
 * broken in three more places, one of them inside that very file:
 *
 * - the address grammar was written twice — a conjunction of predicates for the
 *   seam, the same predicates re-listed as `if` blocks for the door — so a sixth
 *   rule could be added to the door alone and never reach `joinUrl`, which is
 *   the only thing between a consumer of the library and the wire (ADR-0032);
 * - the refusal of a scheme-relative path was written three times, under a
 *   comment saying it was written once. One of the three had been dead since the
 *   day the grammar took the rule over;
 * - two sets of statuses and error names that must agree were left to agree by
 *   inspection: `TERMINAL_ERROR_NAMES` against the client's own `instanceof`
 *   pair and against a second set in the CLI, and `classifyStatus`'s `not-found`
 *   list against a copy of it in the self-inflicted-404 guard.
 *
 * Each of them was repaired by making one side derive from the other. What is
 * here is the other half of that: a test that goes red when a member is added to
 * one place and not the other, so that the derivation cannot be quietly undone
 * by the next edit. Where a constant is deliberately unexported it is read out
 * of the source, the way `tests/invariants/transport.test.ts` reads the
 * response-header allowlist out of `http.ts` — a gate does not get to widen the
 * surface it is guarding.
 *
 * **What the source-reading half reads, and what it cannot.** Adversarial review
 * of 23 August 2026 walked around four of these assertions and each walk-around
 * is closed below; the closures are worth stating as limits rather than as
 * completeness:
 *
 * - the two "written in one file" assertions now read **every tracked file under
 *   `src/`**, from `git ls-files`, not a list somebody remembered to update. The
 *   list they used to read was 5 files of 65 and 15 of 65, and the ones it missed
 *   were the plausible carriers. What they still match is an **exact substring**:
 *   a copy that words the same refusal differently, or builds the class name by
 *   concatenation, is a copy this file cannot see;
 * - the ids of `ADDRESS_RULES` are read with a regex that no longer needs `id` on
 *   a line of its own, the count of ids is held equal to the count of entries, so
 *   a rule whose id is not a plain double-quoted literal fails rather than
 *   passing unwitnessed, and a spread into the table is refused rather than
 *   followed. A disjunct added inside an existing predicate such as `isAddress`
 *   still changes what the grammar refuses with no witness demanded of it;
 * - the order of `ADDRESS_RULES` is behaviour and is held by witness pairs, one
 *   per adjacent pair of the table. Order is held over the pairs listed; nothing
 *   here says the order is the *right* one, only that changing it is a red test;
 * - the endpoint list's live copy of the scheme-relative refusal is held to being
 *   one of `isAddress`'s own disjuncts, character for character, and separately
 *   over a corpus of shapes. The corpus is a corpus. What makes the pair strong
 *   is the first half: any textual change to that condition is red, including one
 *   that is behaviourally identical.
 *
 * See ADR-0061.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createCredentialProvider, DEFAULT_AUTH_SCHEME } from "../../src/adapters/credentials.js";
import { createEndpointListParser } from "../../src/adapters/endpoint-list.js";
import { CircuitOpenError } from "../../src/adapters/http.js";
import { createPostmanCollectionParser } from "../../src/adapters/postman.js";
import { RunBudgetExhaustedError } from "../../src/adapters/throttle.js";
import type { Account, Endpoint, Resource } from "../../src/core/index.js";
import {
  isAddressablePath,
  isUsablePathTemplate,
  pathTemplate,
  UnusablePathTemplateError,
} from "../../src/io/untrusted.js";
import { TERMINAL_ERROR_NAMES, terminalCause } from "../../src/runner/outcome.js";
import { classifyStatus, collectObservations } from "../../src/runner.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const sourceOf = (path: string): string => readFileSync(resolve(ROOT, path), "utf8");

/**
 * Every tracked TypeScript file under `src/`, from the index rather than the disk.
 *
 * The two assertions below that ask "is this written anywhere else" used to read
 * a list of file names written into this file by hand — 5 of them for the
 * refusal wording and 15 for the error names, against 65 tracked sources. So 60
 * files went unread by the shorter list and 50 by the longer one, and among them
 * were `src/cli/stream.ts`, `src/runner/stream.ts`, `src/report/findings.ts`,
 * `src/runner/plan.ts` and `src/cli.ts` — which is to say the plausible carriers.
 * A gate that reads a list somebody has to remember to update is the defect it
 * was written against.
 *
 * `git ls-files` rather than a walk, for the reason `tests/docs/language.test.ts`
 * gives: `.gitignore` already answers "does this go public", and walking the disk
 * from here would descend into `.claude/worktrees/`, where another branch's copy
 * of a file would answer for this one. A path the index still holds and the disk
 * no longer does is a deletion not yet staged — somebody's working copy, not the
 * repository — and is skipped.
 */
function trackedSources(): readonly string[] {
  return execFileSync("git", ["ls-files", "-z", "src"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter((path) => path.endsWith(".ts") && existsSync(resolve(ROOT, path)));
}

/**
 * The text of one top-level function, signature included.
 *
 * From the signature to the first line that is a lone `}` — which is what a
 * top-level function's closing brace looks like under this repository's
 * formatting, and nothing nested reaches column zero.
 */
function bodyOf(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `${signature} is not in the source`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\n}", start);
  expect(end, `${signature} does not close`).toBeGreaterThan(start);
  return source.slice(start, end);
}

/**
 * The address grammar: one table, two entry points.
 *
 * The gate is the witness list. Every rule in `ADDRESS_RULES` must have a path
 * here that it refuses, that path must be refused by **both** entry points with
 * **that rule's** sentence, and the witnesses must be in the table's own order —
 * so a rule added to the table without being thought about is a red test, a rule
 * that reaches only one of the two entry points cannot be spelled at all while
 * they share the list, and a permutation of the table is caught rather than
 * silently changing which sentence a path breaking two rules is answered with.
 *
 * "A rule added to the table" means an entry with a `refuses` key and an `id`
 * that is a double-quoted literal. An entry that is neither — an id computed
 * from a constant, or a whole array spread in — fails rather than passing
 * unwitnessed. What is invisible here is a disjunct added inside an existing
 * predicate, which changes what the grammar refuses without adding a rule to the
 * table at all.
 */
describe("the address grammar is one list", () => {
  const source = sourceOf("src/io/untrusted.ts");

  /**
   * One rule's witness: a path only that rule refuses, the sentence it answers
   * with, and — for every rule but the last — a pair of paths that prove it is
   * asked before the rule under it.
   */
  interface Witness {
    readonly id: string;
    /**
     * A path this rule refuses and no other does. Distinct sentences are what
     * make "which rule fired" observable from outside a module that exports
     * neither the table nor the predicates.
     */
    readonly path: string;
    readonly says: RegExp;
    /**
     * Precedence over the next entry in the table, as two paths.
     *
     * `both` breaks this rule and the next one, and must be answered with this
     * rule's sentence. `nextAlone` is `both` with this rule's trigger taken out,
     * and must be answered with the next rule's — which is what proves `both`
     * really did break two rules rather than one. Absent on the last entry,
     * which has nothing under it.
     */
    readonly aheadOfTheNext?: { readonly both: string; readonly nextAlone: string };
  }

  /** The witnesses, in the order the table states the rules. */
  const WITNESSES: readonly Witness[] = [
    {
      id: "query-or-fragment",
      path: "/v1/orders/{orderId}?_method=DELETE",
      says: /carries a query string or a fragment/,
      // A query string and a backslash. Take the query away and the backslash
      // is what is left to refuse.
      aheadOfTheNext: { both: "/v1\\reports?_method=DELETE", nextAlone: "/v1\\reports" },
    },
    {
      id: "unaddressable-character",
      // Backslashes, which the URL parser reads as separators and a split on
      // `/` reads as ordinary characters. No `/` in it beyond the first, so
      // `navigates` has nothing to say and the sentence can only come from
      // this rule.
      path: "/v1\\reports\\..\\..\\danger",
      says: /carries a backslash or a control character/,
      // A backslash inside a scheme-relative address. Turn the backslash into
      // the separator it was pretending to be and the address is what is left.
      aheadOfTheNext: { both: "//api.test/v1\\danger", nextAlone: "//api.test/v1/danger" },
    },
    {
      id: "address",
      path: "//api.test/v1/danger",
      says: /is an address rather than a path/,
      // An address that also navigates. Drop the leading slash and the
      // navigation is what is left.
      aheadOfTheNext: { both: "//api.test/v1/../danger", nextAlone: "/v1/../danger" },
    },
    {
      id: "navigates",
      path: "/v1/reports/../danger",
      says: /navigates with/,
    },
  ];

  const witnessOf = (id: string): Witness | undefined => WITNESSES.find((one) => one.id === id);

  /**
   * The ids, off the table itself, with the count held to the count of entries.
   *
   * The regex used to be anchored — `^\s*id: "…",$` — which needed `id` on a line
   * of its own. Biome at `lineWidth: 100` leaves a short entry written on one
   * line exactly as it found it, so a fifth rule spelled
   * `{ id: "bang", refuses: …, because: … },` had no id as far as this gate could
   * see, no witness was demanded for it, and the suite stayed green. The count of
   * `refuses` keys is compared to the count of ids for the same reason: an entry
   * whose id is a constant or a template literal would otherwise be an entry this
   * gate cannot name and therefore does not ask about.
   *
   * A spread is refused outright rather than followed. `...MORE_RULES` in the
   * table is entries this gate cannot count, let alone name, and following one
   * would mean parsing the module — so the table is held to being written out.
   * The red test says so, and the fix is to write the entry where the other four
   * are.
   */
  const declared = (): readonly string[] => {
    const table = /const ADDRESS_RULES[^=]*=\s*\[([\s\S]*?)\n\];/.exec(source);
    // A guard on the guard: a renamed constant must not read as an empty table
    // and pass everything below by having nothing to check.
    expect(table).not.toBeNull();
    const body = table?.[1] ?? "";
    expect(
      body,
      "ADDRESS_RULES is spread from somewhere else. Write the entry into the table: " +
        "a spread is rules this gate cannot count, and an uncounted rule is one no " +
        "witness is demanded for.",
    ).not.toContain("...");
    const ids = [...body.matchAll(/(?:^|[\s{])id:\s*"([^"]+)"/g)].map((match) => match[1] ?? "");
    const entries = [...body.matchAll(/(?:^|[\s{])refuses:/g)].length;
    expect(
      ids,
      `${entries} entr${entries === 1 ? "y" : "ies"} in ADDRESS_RULES and ${ids.length} ` +
        `id${ids.length === 1 ? "" : "s"} this gate can read. An entry whose id is not a ` +
        `plain double-quoted literal is an entry no witness is demanded for.`,
    ).toHaveLength(entries);
    return ids;
  };

  it("has a witness for every rule it states, in the order it states them", () => {
    expect(declared()).toEqual(WITNESSES.map((witness) => witness.id));
  });

  it("refuses each witness through both entry points, with that rule's sentence", () => {
    for (const id of declared()) {
      const witness = witnessOf(id);
      expect(witness, `no witness for the rule "${id}"`).toBeDefined();
      const path = witness?.path ?? "";

      // The seam. A rule that reaches only `pathTemplate` is a rule `joinUrl`
      // does not apply, and `joinUrl` is the door a consumer of the library
      // comes through — ADR-0032, the whole of it.
      expect(isAddressablePath(path), `${id}: the seam admits ${path}`).toBe(false);
      expect(isUsablePathTemplate(path), `${id}: the door admits ${path}`).toBe(false);

      // And the door says which rule, in words an operator can act on. These
      // sentences are the reason the table holds pairs rather than predicates.
      let thrown: unknown;
      try {
        pathTemplate(path);
      } catch (cause) {
        thrown = cause;
      }
      expect(thrown, `${id}: the door admits ${path}`).toBeInstanceOf(UnusablePathTemplateError);
      expect((thrown as Error).message).toMatch(witness?.says ?? /$^/);
    }
  });

  /**
   * The order of the table, which its own comment calls behaviour.
   *
   * It was behaviour with nothing holding it. Every witness above breaks exactly
   * one rule by construction — that is what makes "which rule fired" readable —
   * so permuting the table changed nothing any of them could see, while changing
   * the sentence an operator gets for a path that breaks two rules at once.
   *
   * Each pair is proved twice over. `both` breaks the earlier rule and the later
   * one and must be answered with the earlier one's sentence; `nextAlone` is the
   * same path with the earlier rule's trigger taken out, and must be answered
   * with the later one's — which is what makes `both` a path that really did
   * break two rules, rather than one this test believes breaks two.
   */
  it("asks its rules in the order it states them, pair by adjacent pair", () => {
    const ids = declared();
    // Every adjacent pair is covered, and only those: an entry that grew a
    // neighbour, or lost one, lands here rather than passing.
    expect(WITNESSES.filter((witness) => witness.aheadOfTheNext !== undefined)).toHaveLength(
      ids.length - 1,
    );
    expect(WITNESSES.at(-1)?.aheadOfTheNext).toBeUndefined();

    const refusal = (path: string): string => {
      let thrown: unknown;
      try {
        pathTemplate(path);
      } catch (cause) {
        thrown = cause;
      }
      expect(thrown, `the door admits ${path}`).toBeInstanceOf(UnusablePathTemplateError);
      return (thrown as Error).message;
    };

    WITNESSES.forEach((earlier, index) => {
      const pair = earlier.aheadOfTheNext;
      if (pair === undefined) {
        return;
      }
      const later = WITNESSES[index + 1];
      expect(later, `${earlier.id} claims a rule under it and there is none`).toBeDefined();

      expect(
        refusal(pair.both),
        `${pair.both}: ${earlier.id} is stated before ${later?.id}`,
      ).toMatch(earlier.says);
      expect(
        refusal(pair.nextAlone),
        `${pair.nextAlone}: without ${earlier.id}'s trigger, ${later?.id} must be what refuses`,
      ).toMatch(later?.says ?? /$^/);
    });
  });

  /**
   * And neither entry point decides anything of its own.
   *
   * The witness test above cannot see a fifth `if` written beside the table:
   * such a rule has no id, so nothing demands a witness for it. This is what
   * does — one `every` on one side, one throw on the other.
   */
  it("asks the table and nothing besides", () => {
    const seam = bodyOf(source, "export function isAddressablePath");
    expect(seam).toContain("ADDRESS_RULES.every");
    // The conjunction this replaced. Its return was five predicates joined by
    // `&&`, and that is the shape a sixth would be appended to.
    expect(seam).not.toContain("&&");

    const door = bodyOf(source, "export function pathTemplate");
    expect(door).toContain("ADDRESS_RULES.find");
    // Exactly one place a refusal is worded, so a new message cannot be written
    // anywhere but into the table.
    expect([...door.matchAll(/new UnusablePathTemplateError\(/g)]).toHaveLength(1);
  });
});

/**
 * The scheme-relative refusal, now that two of the three copies are accounted
 * for.
 *
 * `//host/x` joined to the base becomes a request to somebody else's host, or —
 * because `joinUrl` strips leading slashes — to `/v1/host/x`, an endpoint the
 * configuration never named, reported as if it were the one it did. The grammar
 * refuses it for every door at once. The Postman parser's own copy sat after
 * `pathTemplate` and could not be reached; the endpoint list's runs before it
 * and is what answers there.
 */
describe("a scheme-relative path is refused once, and by the grammar", () => {
  const SCHEME_RELATIVE = "//evil.test/v1/users";
  const WORDING = "addresses another host";
  const ENDPOINT_LIST = "src/adapters/endpoint-list.ts";

  /** One entry, parsed; the message if it was refused, the empty string if not. */
  const refusalOfEntry = async (path: string): Promise<string> => {
    try {
      await createEndpointListParser().parse(
        `endpoints: [{ id: a, method: GET, path: ${JSON.stringify(path)} }]`,
      );
      return "";
    } catch (cause) {
      return cause instanceof Error ? cause.message : String(cause);
    }
  };

  it("is the grammar's answer at the Postman door, not a copy's", async () => {
    const collection = JSON.stringify({
      item: [{ name: "a", request: { method: "GET", url: { path: ["", "evil.test", "x"] } } }],
    });

    await expect(createPostmanCollectionParser().parse(collection)).rejects.toThrow(
      /an address rather than a path/,
    );
  });

  /**
   * The dead copy, held dead by its own wording.
   *
   * It was unreachable by construction: `pathTemplate` returns its argument
   * unchanged and throws when the decoded form is an address, and decoding
   * replaces `%2e`, `%2f` and `%5c` with one character each without deleting
   * anything — so a string that starts with `//` still does after it, and never
   * comes back from that call. v8 agreed, at zero hits over the whole suite.
   * What made it worth removing rather than leaving is that its comment claimed
   * it was holding the scope open.
   *
   * The sentence now lives in one file. A second file using it is either a new
   * copy or the old one back.
   *
   * Every tracked source is read, not a list of five written here by hand. The
   * list was the whole of this assertion until 23 August 2026, and the same
   * wording put into `src/runner/walk.ts` — which the list did not name — passed
   * it. What is still true only of an exact substring: a copy that says "points
   * at another host" is a copy this cannot see.
   */
  it("is worded in exactly one file, over every tracked source", () => {
    const sources = trackedSources();
    // A check that found nothing is green for the same reason a passing one is.
    expect(sources.length).toBeGreaterThan(50);
    expect(sources).toContain(ENDPOINT_LIST);

    expect(sources.filter((file) => sourceOf(file).includes(WORDING))).toEqual([ENDPOINT_LIST]);
  });

  /**
   * The live copy, held to being a subset — as a matter of source text.
   *
   * It is kept because it runs first and answers about the entry rather than the
   * template. What it must never become is a second, laxer reading: everything
   * it refuses, the grammar refuses too, so if it were deleted tomorrow the
   * refusal would still happen one line later.
   *
   * The claim used to be held by one string, `//evil.test/v1/users`, which
   * proves the copy still fires and nothing about how far it reaches: widening
   * the condition to `path.startsWith("//") || path.includes("@")` left the gate
   * green while the copy refused paths the grammar admits. What holds it now is
   * that the condition is one of `isAddress`'s own disjuncts, character for
   * character. Any edit to it is red, including a behaviourally identical one —
   * which is the cost of the strength, and the right way round for a rule whose
   * whole justification is that it says nothing new.
   */
  it("refuses under one of the grammar's own disjuncts, spelled the same way", () => {
    const list = sourceOf(ENDPOINT_LIST);
    // The sentence as the message spells it, parenthesis included. The comment
    // above the guard carries the wording too, and anchoring on the shorter
    // string read the guard *above* this one — the `typeof` check on the field.
    const at = list.indexOf(`${WORDING} (a scheme-relative URL)`);
    expect(at, `${ENDPOINT_LIST} no longer words the refusal at all`).toBeGreaterThan(0);
    const opens = list.lastIndexOf("if (", at);
    expect(opens, "the refusal has no `if (` above it").toBeGreaterThan(0);
    const closes = list.indexOf(") {", opens);
    expect(closes, "the refusal is not inside the `if` above it").toBeGreaterThan(opens);
    expect(closes).toBeLessThan(at);
    // And that the `if` found is the one that throws the sentence, rather than
    // one further up with the sentence somewhere beyond it.
    expect(
      list.slice(closes, at),
      "the `if` above the sentence is not the one that throws it",
    ).toContain("throw new InvalidEndpointError(");
    // `path` here, `value` in the grammar. The one rename this comparison makes,
    // and it is on a word boundary so that a condition mentioning the word in
    // any other position fails to match rather than being mangled into a match.
    const condition = list.slice(opens + "if (".length, closes).replace(/\bpath\b/g, "value");

    const grammar = bodyOf(sourceOf("src/io/untrusted.ts"), "function isAddress(");
    const returned = /return ([\s\S]*?);/.exec(grammar);
    expect(
      returned,
      "`isAddress` no longer returns an expression this gate can read",
    ).not.toBeNull();
    const disjuncts = (returned?.[1] ?? "").split("||").map((part) => part.trim());

    expect(disjuncts.length).toBeGreaterThan(1);
    expect(
      disjuncts,
      `the endpoint list refuses under \`${condition}\`, which is not one of the grammar's ` +
        `disjuncts (${disjuncts.join(" | ")}). A copy that says more than the rule it copies ` +
        `is a second rule, and it is the one nobody will think to widen when the grammar moves.`,
    ).toContain(condition);
  });

  /**
   * And the same subset claim as behaviour, over a corpus of shapes.
   *
   * The implication is one-way on purpose: the grammar refuses far more than the
   * copy does — a query string, a backslash, `..` — and the copy is not supposed
   * to have an opinion about any of that. What must never happen is the other
   * direction, a path the copy turns away and the grammar would have let through.
   *
   * A corpus, not a proof. It is here because the source-text assertion above
   * cannot see a widening made in `isAddress` and mirrored here, and this one
   * can.
   */
  it("turns away nothing at the endpoint list that the grammar would admit", async () => {
    const CORPUS: readonly string[] = [
      SCHEME_RELATIVE,
      "///evil.test/v1/users",
      "/v1/users",
      "/v1/users/{userId}",
      // Shapes that carry a character a widened copy would plausibly reach for,
      // and that the grammar has no quarrel with.
      "/v1/u@example.com/orders",
      "/v1/mail@host/x",
      "/v1/a.b/c",
      "/v1/a:b/c",
      "/v1/reports;jsessionid=1/x",
      "/v1/%40/x",
    ];

    let fired = 0;
    for (const path of CORPUS) {
      if (!(await refusalOfEntry(path)).includes(WORDING)) {
        continue;
      }
      fired += 1;
      expect(
        isUsablePathTemplate(path),
        `${path}: the endpoint list's copy refuses what the grammar admits`,
      ).toBe(false);
    }

    // A loop that refused nothing would pass by having asked nothing.
    expect(fired).toBeGreaterThan(0);
  });

  it("agrees with the grammar at the endpoint list, which refuses it first", async () => {
    expect(isUsablePathTemplate(SCHEME_RELATIVE)).toBe(false);
    expect(isAddressablePath(SCHEME_RELATIVE)).toBe(false);

    expect(await refusalOfEntry(SCHEME_RELATIVE)).toContain(WORDING);
  });
});

/**
 * The names by which a client says the walk cannot go on.
 *
 * Three readings of one fact: the set the runner matches by name, the second set
 * the CLI matched by name, and the client's own `instanceof` pair. The two sets
 * are one set now. The pair cannot be — an adapter sits below the runner and
 * must not import from it, and where the classes are in hand `instanceof` is the
 * stronger test — so the agreement between the set and the pair is held here.
 */
describe("the terminal errors are one list", () => {
  /** Every class the client refuses to retry, by the identifier it names. */
  const KNOWN: Readonly<Record<string, new (n: number) => Error>> = {
    RunBudgetExhaustedError,
    CircuitOpenError,
  };

  const retried = (): readonly string[] => {
    const source = sourceOf("src/adapters/http.ts");
    const guard = /if \((cause instanceof [\s\S]*?)\) \{\s*\n\s*throw cause;/.exec(source);
    // The same guard on the guard: a rewritten condition must not read as an
    // empty list of classes and pass by having nothing to compare.
    expect(guard).not.toBeNull();
    return [...(guard?.[1] ?? "").matchAll(/instanceof\s+([A-Za-z_$][\w$]*)/g)].map(
      (match) => match[1] ?? "",
    );
  };

  it("names the same errors in the client's retry guard and in the runner's set", () => {
    const identifiers = retried();
    expect(identifiers.length).toBeGreaterThan(0);

    const named = identifiers.map((identifier) => {
      const errorClass = KNOWN[identifier];
      // A fourth class added to the client's guard lands here: the test cannot
      // say whether the runner knows about it, so it says so out loud rather
      // than passing. Add it to `KNOWN` above, and to `TERMINAL_ERROR_NAMES`.
      expect(errorClass, `${identifier} is not one of the classes this test knows`).toBeDefined();
      // The identifier itself when there is no class for it: the assertion above
      // has already failed, and this only keeps the comparison below readable.
      return errorClass === undefined ? identifier : new errorClass(1).name;
    });

    // Both directions. A name added to the set with no class refusing retry
    // fails on the second line: the walk would call it terminal while the
    // client spent three attempts and two backoffs on it first.
    expect([...named].sort()).toEqual([...TERMINAL_ERROR_NAMES].sort());
  });

  it("is what terminalCause reads, through the wrapper the client throws", () => {
    for (const identifier of retried()) {
      const errorClass = KNOWN[identifier];
      expect(errorClass, `${identifier} is not one of the classes this test knows`).toBeDefined();
      if (errorClass === undefined) {
        continue;
      }
      const inner = new errorClass(1);
      // `RequestFailedError` wraps everything on its way out of the client, and
      // a match on the outer name is how this went unnoticed once already.
      const wrapped = new Error("request failed", { cause: inner });

      expect(terminalCause(wrapped)).toBe(inner);
    }

    expect(terminalCause(new Error("connection refused"))).toBeUndefined();
  });

  /**
   * And the names are spelled in one place besides the classes themselves.
   *
   * A quoted `"CircuitOpenError"` in a third file is a second list starting.
   * The two that are allowed: the class's own `this.name`, and the set.
   *
   * Every tracked source is read, not the 15 files this assertion used to name.
   * The list left 50 unread, and a second copy of the set put into
   * `src/runner/stream.ts` — one of them — passed. What is still true only of an
   * exact substring: a name assembled at runtime, `"Circuit" + "OpenError"`, is a
   * copy this cannot see.
   */
  it("is spelled where the class is defined and in the set, over every tracked source", () => {
    const files = trackedSources();
    // A check that found nothing is green for the same reason a passing one is.
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain("src/runner/outcome.ts");

    const spelling = (name: string): readonly string[] =>
      files.filter((file) => sourceOf(file).includes(`"${name}"`));

    expect(spelling("RunBudgetExhaustedError")).toEqual([
      "src/adapters/throttle.ts",
      "src/runner/outcome.ts",
    ]);
    expect(spelling("CircuitOpenError")).toEqual(["src/adapters/http.ts", "src/runner/outcome.ts"]);
  });
});

/**
 * The statuses that mean the object is not there.
 *
 * `classifyStatus` folds them into `not-found`, and `toBinary` folds `not-found`
 * on into a denial — so a status this run caused with its own write reads as
 * protection observed, which is the L-7 false negative. The guard in `walk.ts`
 * had the list written out a second time; ADR-0046 moved it once already, by
 * hand, when 410 joined 404.
 */
describe("the not-found statuses are one list", () => {
  const ACCOUNTS: readonly Account[] = [
    { id: "first", roleId: "r", tenantId: "t" },
    { id: "second", roleId: "r", tenantId: "t" },
  ];
  const CREDENTIALS = createCredentialProvider(
    DEFAULT_AUTH_SCHEME,
    new Map(ACCOUNTS.map((account) => [account.id, `token-${account.id}`])),
  );
  const DELETE_ORDER: Endpoint = {
    id: "orders.delete",
    method: "DELETE",
    path: "/v1/orders/{orderId}",
  };
  const ORDER: readonly Resource[] = [{ id: "order-1", tenantId: "t", params: { orderId: "1" } }];

  /** The list, computed rather than typed: whatever the classifier says today. */
  const notFound = (): readonly number[] => {
    const found: number[] = [];
    for (let status = 100; status < 600; status += 1) {
      if (classifyStatus(status) === "not-found") {
        found.push(status);
      }
    }
    return found;
  };

  /** A platform that really deletes: the first caller wins, the rest get `after`. */
  async function afterOurOwnWrite(after: number) {
    const gone = new Set<string>();
    return collectObservations({
      baseUrl: "https://a.test",
      endpoints: [DELETE_ORDER],
      accounts: ACCOUNTS,
      credentials: CREDENTIALS,
      resources: ORDER,
      client: {
        send(request) {
          const { pathname } = new URL(request.url);
          if (gone.has(pathname)) {
            return Promise.resolve({ status: after, headers: {} });
          }
          gone.add(pathname);
          return Promise.resolve({ status: 200, headers: {} });
        },
      },
      allowUnsafeMethods: true,
      // One at a time: "earlier" has to mean something for the guard to have
      // anything to say.
      concurrency: 1,
    });
  }

  /**
   * The list itself, spelled out once so that adding to it is a decision.
   *
   * The same reasoning as the response-header allowlist in
   * `tests/invariants/transport.test.ts`: a third status folding into
   * `not-found` changes what a denial means in every report this tool writes,
   * and it should cost an edit here and a line in an ADR.
   */
  it("folds exactly 404 and 410", () => {
    expect(notFound()).toEqual([404, 410]);
  });

  /**
   * The agreement, driven off the classifier rather than off a list.
   *
   * Whatever `classifyStatus` calls `not-found` is what the walk must call
   * self-inflicted after its own write. Add a status to the classifier and this
   * loop asks about it on the next run; a guard that re-hardcodes 404 and 410
   * then fails here instead of shipping a false "tested and agreed".
   */
  it("is what the self-inflicted guard recognises, every member of it", async () => {
    for (const status of notFound()) {
      const { observations, failures } = await afterOurOwnWrite(status);

      expect(observations[0]?.outcome, `${status}: the first write`).toBe("allowed");
      // Not `not-found`, which is the value that folds into a denial and made
      // the run report a protection it had manufactured itself.
      expect(observations[1]?.outcome, `${status}: the second`).toBe("error");
      expect(failures.at(-1)?.reason).toContain("already changed the object");
    }
  });

  /**
   * And nothing else is swept in with them. A refused write is a refusal, and a
   * 409 or a 500 after our own write says something the tool must not discard as
   * its own doing.
   */
  it("leaves every other status to mean what it means", async () => {
    for (const status of [403, 409, 500]) {
      const { failures } = await afterOurOwnWrite(status);

      for (const failure of failures) {
        expect(failure.reason, `${status}`).not.toContain("already changed the object");
      }
    }
  });

  /** And the guard reads it off the classifier rather than restating it. */
  it("is asked of classifyStatus in the guard, with no status written there", () => {
    const walk = sourceOf("src/runner/walk.ts");
    const guard = /} else if \((.*)\) \{\n\s*selfInflicted = true;/.exec(walk);
    expect(guard).not.toBeNull();

    const condition = guard?.[1] ?? "";
    expect(condition).toContain('classifyStatus(status) === "not-found"');
    expect(condition).not.toMatch(/\d/);
  });
});

/**
 * An identifier has a grammar, and every door and the seam ask it.
 *
 * `src/core/keys.ts` described its separator as "a character that never occurs
 * in an identifier" and nothing made that true. The measured pair, both entries
 * legal until 24 August 2026 and both written out below, gave two different
 * defects one `acceptanceKeyOf`: the configuration door refused them as one
 * entry declared twice, and `indexAcceptances` — a `Map` on that key, reachable
 * straight from the library — kept the last of the two and let it decide the
 * other's deadline.
 *
 * The grammar is `src/core/identifiers.ts`; the seam that cannot be walked past
 * is `joinKey`; the doors are here so that an operator gets the line of their own
 * file rather than the seam's general sentence. See ADR-0066.
 *
 * The NUL is written `\u0000` throughout. A raw byte here would make this file
 * binary to `grep`, which is the thing ADR-0060's second half is about, and
 * `tests/invariants/one-decision-one-home.test.ts` refuses one in any tracked
 * file.
 */

import { describe, expect, it } from "vitest";
import {
  createEndpointListParser,
  InvalidEndpointError,
} from "../../src/adapters/endpoint-list.js";
import { createOpenApiParser } from "../../src/adapters/openapi.js";
import { createPostmanCollectionParser } from "../../src/adapters/postman.js";
import type { Acceptance, Check } from "../../src/core/index.js";
import {
  acceptanceKeyOf,
  CheckRegistry,
  defectSignature,
  identifier,
  indexAcceptances,
  isUsableIdentifier,
  UnusableIdentifierError,
} from "../../src/core/index.js";
import { cellKey, joinKey, objectKey } from "../../src/core/keys.js";
import { parseRunConfig } from "../../src/io/config.js";
import { toComparableRun } from "../../src/report/compare.js";

const NUL = "\u0000";
/** `U+001B`, which opens a sequence a terminal obeys. An escape, for the reason above. */
const ESCAPE = "\u001b";

describe("the grammar", () => {
  it("takes a name a person would write, in any script", () => {
    for (const value of [
      "orders.list",
      "GET /v1/orders",
      "Orders / By id",
      "Bestellungen / Übersicht",
      "alice-a@geo-blocked",
      "a b",
      " leading and trailing ",
      "🚀",
    ]) {
      expect(isUsableIdentifier(value), value).toBe(true);
      expect(identifier(value, "The id")).toBe(value);
    }
  });

  it("refuses the separator, and says which character and where to look", () => {
    expect(isUsableIdentifier(`a${NUL}own`)).toBe(false);
    expect(() => identifier(`a${NUL}own`, "The id at accounts[0]")).toThrow(
      UnusableIdentifierError,
    );
    try {
      identifier(`a${NUL}own`, "The id at accounts[0]");
      expect.unreachable("the identifier was accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(UnusableIdentifierError);
      const message = (error as UnusableIdentifierError).message;
      expect(message).toContain("The id at accounts[0] carries U+0000");
      // The value is spelled out rather than quoted. A message that carried the
      // character would put it on the terminal the refusal exists to protect.
      expect(message).toContain('the value is "a\\u0000own"');
      expect(message).not.toContain("\u0000");
      expect((error as UnusableIdentifierError).value).toBe(`a${NUL}own`);
    }
  });

  it("refuses the rest of the class, and by the same rule", () => {
    // C0 beyond the NUL, DEL, C1, and the two line separators. Each is refused
    // by both entry points, which is the property ADR-0061 is about: one reading
    // of the rule, two ways of asking it.
    for (const character of ["\t", "\n", "\r", "\u001b", "\u001f", "\u007f", "\u0085", "\u009f"]) {
      expect(isUsableIdentifier(`orders${character}list`), JSON.stringify(character)).toBe(false);
      expect(() => identifier(`orders${character}list`, "The id")).toThrow(UnusableIdentifierError);
    }
    for (const character of ["\u2028", "\u2029"]) {
      expect(isUsableIdentifier(`orders${character}list`), JSON.stringify(character)).toBe(false);
    }
  });

  it("stops where the class stops", () => {
    // The neighbours of every boundary, so that a widened or narrowed range is a
    // red test rather than a judgement call.
    for (const character of [" ", "~", "\u00a0", "\u2027", "\u202a", "\u202e"]) {
      expect(isUsableIdentifier(`orders${character}list`), JSON.stringify(character)).toBe(true);
    }
  });

  /**
   * Every code point up to the last one the class names, asked one at a time.
   *
   * Sampling the boundaries leaves the middle of a range untested, and the middle
   * of a range is where a single code point can be let out without a witness
   * noticing — `if (code === 0x0b) return false;` inside the class. This asks
   * about all of them, so the answer is the class rather than a list of examples.
   */
  it("answers for every code point the class reaches, one at a time", () => {
    const wrong: string[] = [];
    for (let code = 0; code <= 0x2100; code += 1) {
      // A lone surrogate is not a character and is nobody's identifier; the class
      // says nothing about one, and `String.fromCharCode` would build one here.
      if (code >= 0xd800 && code <= 0xdfff) {
        continue;
      }
      const refused =
        code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
      if (isUsableIdentifier(`a${String.fromCharCode(code)}b`) === refused) {
        wrong.push(`U+${code.toString(16).toUpperCase().padStart(4, "0")}`);
      }
    }

    expect(
      wrong,
      `The grammar disagrees with the class it declares, at: ${wrong.join(", ")}. ` +
        `Widening or narrowing the range is a decision for ADR-0066, not an edit.`,
    ).toEqual([]);
  });

  it("refuses the empty string, which is how a key says a coordinate is absent", () => {
    expect(isUsableIdentifier("")).toBe(false);
    expect(() => identifier("", "The id at resources[0]")).toThrow(
      /The id at resources\[0\] is empty/,
    );
  });

  it("names a character outside the basic plane without splitting it", () => {
    // The scan reads code units, which is the same answer as code points for
    // every character it refuses — none of them is a surrogate. What has to hold
    // is that a pair passes through the spelling whole.
    try {
      identifier(`🚀${NUL}`, "The id");
      expect.unreachable("the identifier was accepted");
    } catch (error) {
      expect((error as Error).message).toContain('the value is "🚀\\u0000"');
    }
  });
});

describe("the seam", () => {
  it("refuses a coordinate that is not an identifier, wherever the key is built", () => {
    expect(() => joinKey("a", `b${NUL}c`)).toThrow(UnusableIdentifierError);
    expect(() => cellKey({ accountId: `a${NUL}`, endpointId: "e" })).toThrow(
      UnusableIdentifierError,
    );
    expect(() => objectKey({ endpointId: "e", resourceId: `r${NUL}` })).toThrow(
      UnusableIdentifierError,
    );
    expect(() => defectSignature({ endpointId: `e${NUL}` })).toThrow(UnusableIdentifierError);
    expect(() => acceptanceKeyOf({ endpointId: "e" }, `k${NUL}`)).toThrow(UnusableIdentifierError);
  });

  it("tells absence from an empty identifier, which used to be one cell", () => {
    // Two different cells with one key until ADR-0066: a resource whose id is the
    // empty string, and no resource at all.
    expect(cellKey({ accountId: "alice", endpointId: "orders.list" })).toBe(
      cellKey({ accountId: "alice", endpointId: "orders.list", resourceId: undefined }),
    );
    expect(() =>
      cellKey({ accountId: "alice", endpointId: "orders.list", resourceId: "" }),
    ).toThrow(UnusableIdentifierError);
    expect(() => objectKey({ endpointId: "orders.list", resourceId: "" })).toThrow(
      UnusableIdentifierError,
    );
  });

  it("builds the same string it built before", () => {
    // The change is what is refused, not what is produced. A key of the same
    // coordinates is the same bytes, and the acceptance key is still the
    // signature with the kind after it.
    expect(cellKey({ accountId: "alice", endpointId: "orders.read", resourceId: "o-1" })).toBe(
      `alice${NUL}orders.read${NUL}o-1`,
    );
    expect(cellKey({ accountId: "alice", endpointId: "orders.list" })).toBe(
      `alice${NUL}orders.list${NUL}`,
    );
    expect(objectKey({ endpointId: "orders.read", resourceId: "o-1" })).toBe(
      `orders.read${NUL}o-1`,
    );
    expect(defectSignature({ endpointId: "orders.list", relation: "own" })).toBe(
      `orders.list${NUL}own${NUL}`,
    );
    expect(acceptanceKeyOf({ endpointId: "orders.list", relation: "own" }, "kind")).toBe(
      `orders.list${NUL}own${NUL}${NUL}kind`,
    );
  });

  /**
   * The measured pair, at the door it reached through when no adapter is
   * involved: a consumer building `Acceptance[]` in code.
   */
  it("refuses the pair that had one key for two defects", () => {
    const first: Acceptance = {
      endpointId: "a",
      relation: "own",
      kind: `${NUL}E`,
      reason: "r1",
      until: "2026-11-30",
    };
    const second: Acceptance = {
      endpointId: `a${NUL}own`,
      kind: "E",
      reason: "r2",
      until: "2026-11-30",
    };

    // What it was: one key, so a `Map` of the two holds one entry and the second
    // reason decides the first one's deadline.
    expect(() => indexAcceptances([first, second])).toThrow(UnusableIdentifierError);
    // Each on its own, so that the refusal is about the entry and not about the
    // pair: either one alone was a defect nobody could have keyed on.
    expect(() => indexAcceptances([first])).toThrow(/A coordinate of a key carries U\+0000/);
    expect(() => indexAcceptances([second])).toThrow(/A coordinate of a key carries U\+0000/);
  });
});

describe("the doors", () => {
  it("the configuration: an account id", () => {
    expect(() =>
      parseRunConfig(
        `target: { baseUrl: "https://a.test", allowedHosts: [a.test] }\n` +
          `accounts: [{ id: "al\\0ice", role: user }]\n` +
          `policy: { fallback: denied, rules: [] }\n`,
      ),
    ).toThrow(/The id at accounts\[0\] carries U\+0000/);
  });

  it("the configuration: a resource id, a context id, and the three of an acceptance", () => {
    const head =
      `target: { baseUrl: "https://a.test", allowedHosts: [a.test] }\n` +
      `accounts: [{ id: alice, role: user, tenant: t-a }]\n`;

    expect(() =>
      parseRunConfig(
        `${head}policy: { fallback: denied, rules: [] }\n` +
          `resources: [{ id: "o\\0-1", tenant: t-a, params: { orderId: "1" } }]\n`,
      ),
    ).toThrow(/The id at resources\[0\] carries U\+0000/);

    expect(() =>
      parseRunConfig(
        `${head}policy:\n` +
          `  fallback: denied\n` +
          `  rules: [{ roles: "*", endpoints: [a], context: "geo\\0", outcome: denied }]\n` +
          `contexts: [{ id: "geo\\0", endpoints: [a], headers: { x-note: one } }]\n`,
      ),
    ).toThrow(/The id at contexts\[0\] carries U\+0000/);

    const accepted = (entry: string): string =>
      `${head}policy: { fallback: denied, rules: [] }\naccepted:\n  - ${entry}\n`;

    expect(() =>
      parseRunConfig(accepted('{ endpoint: "a\\0own", kind: E, reason: r, until: 2026-11-30 }')),
    ).toThrow(/The endpoint at accepted\[0\] carries U\+0000/);
    expect(() =>
      parseRunConfig(accepted('{ endpoint: a, kind: "\\0E", reason: r, until: 2026-11-30 }')),
    ).toThrow(/The kind at accepted\[0\] carries U\+0000/);
    expect(() =>
      parseRunConfig(
        accepted('{ endpoint: a, context: "c\\0", kind: E, reason: r, until: 2026-11-30 }'),
      ),
    ).toThrow(/The context at accepted\[0\] carries U\+0000/);
  });

  it("the endpoint list: the id, with the entry number this file adds", async () => {
    const parser = createEndpointListParser();

    await expect(
      parser.parse(
        `endpoints:\n` +
          `  - { id: users.list, method: GET, path: /v1/users }\n` +
          `  - { id: "a\\0own", method: GET, path: /v1/orders }\n`,
      ),
    ).rejects.toThrow(InvalidEndpointError);
    await expect(
      parser.parse(`endpoints:\n  - { id: "a\\0own", method: GET, path: /v1/orders }\n`),
    ).rejects.toThrow(/Endpoint #0: the id carries U\+0000/);
  });

  it("the specification: an operationId", async () => {
    const parser = createOpenApiParser();

    await expect(
      parser.parse(
        `openapi: 3.0.0\n` +
          `info: { title: t, version: "1" }\n` +
          `paths:\n` +
          `  /v1/orders:\n` +
          `    get:\n` +
          `      operationId: "orders\\0list"\n` +
          `      responses: { "200": { description: ok } }\n`,
      ),
    ).rejects.toThrow(/The operationId of GET \/v1\/orders carries U\+0000/);
  });

  /**
   * The fallback, which the door said it did not have to ask about.
   *
   * The comment over the call read: "The generated fallback needs none: the
   * method comes from a closed set and the path has been through `pathTemplate`
   * two loops up." Measured false on 24 August 2026 — the two grammars refuse
   * different classes. `isNeverInAPath` refuses a backslash, the C0 range and
   * DEL; this one refuses those and the C1 range and the two line separators, so
   * `U+0085` and `U+2028` walk through the first and are stopped by the second.
   * The id then reached the seam in `joinKey` mid-walk, as `A coordinate of a
   * key`, with no operation named.
   */
  it("the specification: the id generated where there is no operationId", async () => {
    const parser = createOpenApiParser();
    const spec = (path: string): string =>
      `openapi: 3.0.0\n` +
      `info: { title: t, version: "1" }\n` +
      `paths:\n` +
      `  "${path}":\n` +
      `    get:\n` +
      `      responses: { "200": { description: ok } }\n`;

    // Admitted by the address grammar and refused by this one, both of them. The
    // sentence names no path: the value is the method and the path, so the
    // spelled-out form is the location — and it is the only safe way to give it,
    // because a message quoting the path would carry the character it refuses.
    for (const [character, name] of [
      ["\\u0085", "0085"],
      ["\\u2028", "2028"],
    ] as const) {
      const refusal = parser.parse(spec(`/v1/a${character}b`));
      await expect(refusal).rejects.toThrow(
        `The id generated for an operation that declares no operationId carries U+${name}`,
      );
      await expect(refusal).rejects.toThrow(`the value is "GET /v1/a${character}b"`);
    }
    // And the path that is only unusual: a space is a legal character in a name,
    // so the generated id is one.
    await expect(parser.parse(spec("/v1/a b"))).resolves.toEqual([
      { id: "GET /v1/a b", method: "GET", path: "/v1/a b" },
    ]);
  });

  it("the collection: the name an endpoint id is built out of", async () => {
    const parser = createPostmanCollectionParser();
    const collection = JSON.stringify({
      info: { schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
      item: [
        {
          name: `Orders${NUL}`,
          request: { method: "GET", url: { raw: "{{baseUrl}}/v1/orders", path: ["v1", "orders"] } },
        },
      ],
    });

    await expect(parser.parse(collection)).rejects.toThrow(
      /The name of an item under <collection root> carries U\+0000/,
    );
  });

  /**
   * The ninth door: a saved report, read back by `barbican diff`.
   *
   * ADR-0066 counted five parsers, the library door and the resume stream, and
   * missed this one — the same shape ADR-0032 records twice, a guard on the ways
   * in and nothing on the door with no adapter behind it. Measured on 24 August
   * 2026 against the built tree: `U+001B` `[2K` and a carriage return in
   * `observations[].endpointId` erased the line the comparison printed it on, and
   * `U+001B` `[31m` in `defects[].key` recoloured everything after it.
   *
   * Every string is asked, not only the two that were measured. Each of them is
   * printed by `renderComparison`, keyed on by `compareRuns`, or both.
   */
  it("a saved report: every string the comparison lifts out of it", () => {
    const report = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
      schemaVersion: "2",
      runId: "11111111-1111-4111-8111-111111111111",
      configDigest: "a".repeat(64),
      startedAt: "2026-08-24T09:00:00.000Z",
      truncated: false,
      target: { baseUrl: "https://api.test", label: "staging" },
      defects: [],
      observations: [],
      coverage: { endpointsTotal: 1, endpointsProbed: 1, cellsObserved: 1, notProbed: {} },
      verdict: { code: 0, reason: "no discrepancy with the declared policy" },
      ...over,
    });
    const fullDefect = {
      key: "orders.list any-resource baseline",
      endpointId: "orders.list",
      kinds: ["privilege-escalation"],
      severity: "critical",
      accountIds: ["carol-b"],
      resourceIds: [],
      violations: 4,
    };

    // The two the reviewer measured, at the field and in the file they came from.
    expect(() =>
      toComparableRun(
        report({ defects: [{ ...fullDefect, key: `${ESCAPE}[31mRECOLOURED own none` }] }),
        "after.json",
      ),
    ).toThrow(/defects\[0\]\.key in the report "after\.json" carries U\+001B/);
    expect(() =>
      toComparableRun(
        report({ observations: [{ endpointId: `orders.list${ESCAPE}[2K\rSPOOFED` }] }),
        "after.json",
      ),
    ).toThrow(/observations\[0\]\.endpointId in the report "after\.json" carries U\+001B/);

    // And the rest of them, each named by where it sits rather than by its name
    // alone: a report with forty defects in it needs the index.
    expect(() => toComparableRun(report({ runId: `run${NUL}` }), "a.json")).toThrow(
      /runId in the report "a\.json" carries U\+0000/,
    );
    expect(() => toComparableRun(report({ startedAt: `2026\n` }), "a.json")).toThrow(
      /startedAt in the report "a\.json" carries U\+000A/,
    );
    expect(() =>
      toComparableRun(report({ target: { baseUrl: `https://a\r.test` } }), "a.json"),
    ).toThrow(/target\.baseUrl in the report "a\.json" carries U\+000D/);
    expect(() =>
      toComparableRun(
        report({ target: { baseUrl: "https://a.test", label: `s${ESCAPE}g` } }),
        "a.json",
      ),
    ).toThrow(/target\.label in the report "a\.json" carries U\+001B/);
    expect(() =>
      toComparableRun(report({ verdict: { code: 0, reason: `clean${ESCAPE}[2K` } }), "a.json"),
    ).toThrow(/verdict\.reason in the report "a\.json" carries U\+001B/);
    expect(() =>
      toComparableRun(
        report({
          coverage: {
            endpointsTotal: 1,
            endpointsProbed: 0,
            cellsObserved: 0,
            notProbed: { [`excluded${ESCAPE}[2K`]: 1 },
          },
        }),
        "a.json",
      ),
    ).toThrow(/a key of coverage\.notProbed in the report "a\.json" carries U\+001B/);
    expect(() =>
      toComparableRun(
        report({ defects: [{ ...fullDefect, kinds: ["ok", `bad${ESCAPE}`] }] }),
        "a.json",
      ),
    ).toThrow(/defects\[0\]\.kinds\[1\] in the report "a\.json" carries U\+001B/);
    expect(() =>
      toComparableRun(report({ defects: [{ ...fullDefect, contextId: `geo${NUL}` }] }), "a.json"),
    ).toThrow(/defects\[0\]\.contextId in the report "a\.json" carries U\+0000/);

    // A report this tool wrote is unaffected, which is the other half of the
    // decision: none of these fields is ever empty or carries a control
    // character in one, so the door refuses only documents it did not write.
    expect(() =>
      toComparableRun(
        report({
          defects: [{ ...fullDefect, contextId: "geo-blocked", relation: "own" }],
          observations: [{ endpointId: "orders.list" }],
          coverage: {
            endpointsTotal: 1,
            endpointsProbed: 1,
            cellsObserved: 1,
            notProbed: { excluded: 1 },
          },
        }),
        "a.json",
      ),
    ).not.toThrow();
  });

  it("the registry: the id of a check, which becomes a finding's kind", () => {
    const check: Check = {
      id: `leak${NUL}`,
      description: "a check with an id nothing can key on",
      severity: "low",
      standards: [],
      run: () => [],
    };

    expect(() => new CheckRegistry().register(check)).toThrow(
      /The id of a registered check carries U\+0000/,
    );
  });
});

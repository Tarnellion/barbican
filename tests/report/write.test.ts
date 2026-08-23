/**
 * The streamed file and the string are the same bytes.
 *
 * `reportChunks` exists to remove the 536 870 888-character ceiling that costs a
 * whole run at its last step (J-1). It is worth nothing if the file it writes is
 * not the file readers expect: the polygon's oracle parses the report and
 * compares it cell for cell, `tests/docs/report-example-numbers.test.ts` reads
 * numbers out of it, and an operator diffing two runs would otherwise see every
 * line move.
 *
 * So the property under test is equality with `JSON.stringify(value, null, 2)`,
 * over shapes chosen to break a hand-written serialiser: nesting, empty and
 * single-element arrays, `undefined` values that `JSON.stringify` drops, unicode
 * and characters that need escaping, numbers that do not round-trip naively.
 */

import { describe, expect, it } from "vitest";
import { reportChunks } from "../../src/report/write.js";

const streamed = (value: object) => [...reportChunks(value)].join("");
const stringified = (value: object) => `${JSON.stringify(value, null, 2)}\n`;

describe("the streamed report", () => {
  const shapes: ReadonlyArray<readonly [string, object]> = [
    ["an empty object", {}],
    ["scalars only", { schemaVersion: "2", truncated: false, count: 0 }],
    ["an empty array", { findings: [], observations: [] }],
    ["a single-element array", { findings: [{ kind: "privilege-escalation" }] }],
    [
      "arrays of objects, which is what the report mostly is",
      {
        observations: [
          { accountId: "a", endpointId: "e", status: 200, headers: { "content-type": "json" } },
          { accountId: "b", endpointId: "e", status: 401, headers: {} },
        ],
        summary: { findings: 1, byKind: { "privilege-escalation": 1 } },
      },
    ],
    ["nested objects", { coverage: { outcomes: { allowed: 1, denied: 2 }, notProbed: {} } }],
    [
      "a key whose value is undefined, which JSON.stringify drops",
      { kept: 1, dropped: undefined, alsoKept: "yes" },
    ],
    [
      "an array holding undefined, which JSON.stringify turns into null",
      { rows: [1, undefined, 3] },
    ],
    ["strings that need escaping", { reason: 'a "quoted" \\ path\nwith a newline\tand a tab' }],
    ["unicode outside ASCII", { label: "Ünïcode · ñeighbour · 🎲" }],
    ["numbers that are not integers", { rate: 0.30000000000000004, big: 1e21, negative: -0 }],
    ["null", { tenant: null }],
    ["an array of arrays", { pairs: [["a", "b"], [], ["c"]] }],
  ];

  for (const [what, value] of shapes) {
    it(`matches JSON.stringify for ${what}`, () => {
      expect(streamed(value)).toBe(stringified(value));
    });
  }

  /** And the result is still parseable — the equality above could hold on garbage. */
  it("writes a document that parses back to the same value", () => {
    const report = {
      schemaVersion: "2",
      observations: [{ accountId: "a", status: 200 }],
      summary: { findings: 0 },
    };

    expect(JSON.parse(streamed(report))).toEqual(report);
  });

  /**
   * The ceiling this function exists to remove is not removed by yielding in
   * chunks alone: anything that serialises a whole top-level value before the
   * first chunk puts it back. The first version filtered the keys with
   * `JSON.stringify(value) !== undefined`, which does exactly that — the throw
   * came from the filter, one line above the loop written to avoid it.
   *
   * `observations` is the array that grows with the matrix, so that is where the
   * test puts the weight. Found by adversarial review, 21 August 2026 (V-3).
   */
  it("yields a first chunk without serialising any value whole", () => {
    // Counted rather than measured. The property is "nothing serialises a whole
    // top-level value before the first chunk", and the honest way to show it
    // with a real document is a document past the 536 870 888-character limit —
    // which allocates 700 MB and does not survive alongside the rest of the
    // suite. `toJSON` says the same thing for the price of nothing: the filter
    // that used to sit above the loop called it on every element before the
    // first `next()`, and the loop calls it on one element at a time.
    let serialised = 0;
    const row = () => ({
      toJSON() {
        serialised += 1;
        return { accountId: "a" };
      },
    });
    const report = { schemaVersion: "2", observations: Array.from({ length: 100 }, row) };

    const chunks = reportChunks(report);
    chunks.next();

    expect(serialised).toBeLessThanOrEqual(1);

    for (const _chunk of chunks) {
      // drained
    }
    expect(serialised).toBe(100);
  });

  /**
   * The reason the function exists: no chunk is the size of the document. A
   * hand-written serialiser that quietly joined everything before yielding would
   * pass every assertion above and none of this one.
   */
  it("never holds the whole document in one chunk", () => {
    const report = {
      observations: Array.from({ length: 500 }, (_, index) => ({
        accountId: `account-${index}`,
        endpointId: "orders.list",
        status: 200,
        headers: { "content-type": "application/json", date: "Thu, 21 Aug 2026 00:00:00 GMT" },
      })),
    };
    const chunks = [...reportChunks(report)];
    const whole = chunks.join("");
    const largest = Math.max(...chunks.map((chunk) => chunk.length));

    expect(whole.length).toBeGreaterThan(50_000);
    expect(largest).toBeLessThan(whole.length / 100);
  });
});

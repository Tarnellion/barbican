/**
 * What a check says it was put, and how that travels to a clause row.
 *
 * A check that can tell "I was asked nothing" from "I looked and found nothing"
 * declares which of its coverage counters says so (`Check.reachCounter`). The
 * total is the check's own number, copied unchanged onto every clause row the
 * check answers for. It is not a denominator and ADR-0052 still refuses one;
 * what is under test is the copy, the zero, and the cases in which the answer is
 * "unknown" rather than "nothing".
 *
 * Fixtures are hand-written, per the repository rule.
 */

import { describe, expect, it } from "vitest";
import { counterTotal, reachOf, withoutReach } from "../../src/core/checks/reach.js";
import type { Check, CheckCoverage, CheckRun } from "../../src/core/checks/types.js";
import type { Endpoint } from "../../src/core/index.js";
import {
  CheckRegistry,
  createIdenticalResponseCheck,
  describeChecks,
  IDENTICAL_RESPONSE_CHECK_ID,
  UnusableIdentifierError,
} from "../../src/core/index.js";
import { clauseCoverage } from "../../src/core/standards/coverage.js";

const REF = { standard: "OWASP-API-2023", clause: "API8" };

function counters(
  checkId: string,
  values: Readonly<Record<string, number>>,
  endpointId = "e1",
): CheckCoverage {
  return { checkId, endpointId, counters: values };
}

function run(id: string, reachCounter?: string, standards = [REF]): CheckRun {
  return {
    id,
    description: `the check ${id}`,
    standards,
    ...(reachCounter === undefined ? {} : { reachCounter }),
  };
}

describe("counterTotal", () => {
  it("sums one named counter over the rows of one check and no other", () => {
    const rows = [
      counters("a", { asked: 2, other: 100 }, "e1"),
      counters("a", { asked: 3 }, "e2"),
      counters("b", { asked: 50 }, "e1"),
    ];

    expect(counterTotal(rows, "a", "asked")).toBe(5);
    expect(counterTotal(rows, "b", "asked")).toBe(50);
  });

  it("is zero for no rows, a missing key and a check that returned nothing", () => {
    expect(counterTotal([], "a", "asked")).toBe(0);
    expect(counterTotal([counters("a", { other: 4 })], "a", "asked")).toBe(0);
    expect(counterTotal([counters("b", { asked: 4 })], "a", "asked")).toBe(0);
  });

  it("counts only finite positive numbers, so one bad value does not poison the sum", () => {
    const rows = [
      counters("a", { asked: Number.NaN }),
      counters("a", { asked: Number.POSITIVE_INFINITY }),
      counters("a", { asked: -5 }),
      counters("a", { asked: 2 }),
    ];

    expect(counterTotal(rows, "a", "asked")).toBe(2);
  });

  it("answers for own properties only", () => {
    const inherited = Object.create({ asked: 9 }) as Record<string, number>;

    expect(counterTotal([counters("a", inherited)], "a", "asked")).toBe(0);
    // A counter literally named like a prototype key is a counter.
    expect(counterTotal([counters("a", { constructor: 3 })], "a", "constructor")).toBe(3);
  });

  it("reads a value that is not a number from a file as nothing", () => {
    const row = counters("a", { asked: "7" as unknown as number });

    expect(counterTotal([row], "a", "asked")).toBe(0);
  });
});

describe("reachOf", () => {
  it("covers only the checks that declared a counter", () => {
    const reach = reachOf(
      [run("declares", "asked"), run("silent")],
      [counters("declares", { asked: 4 }), counters("silent", { asked: 4 })],
    );

    expect([...reach.keys()]).toEqual(["declares"]);
    expect(reach.get("declares")).toEqual({ checkId: "declares", counter: "asked", total: 4 });
  });

  it("gives a declaring check that returned no rows a total of zero", () => {
    const reach = reachOf([run("declares", "asked")], []);

    expect(reach.get("declares")?.total).toBe(0);
  });
});

describe("a declared reach counter", () => {
  const check = (extra: Partial<Check> = {}): Check => ({
    id: "c",
    description: "d",
    severity: "info",
    standards: [REF],
    run: () => [],
    ...extra,
  });

  it("is copied into the description of the checks that ran, and only when declared", () => {
    const described = describeChecks([
      check({ reachCounter: "asked", coverage: () => [] }),
      check({ id: "plain" }),
    ]);

    expect(described[0]?.reachCounter).toBe("asked");
    // Not `reachCounter: undefined`: the key is absent, so a report written without a
    // declaration is the same bytes it was before the field existed.
    expect(Object.hasOwn(described[1] ?? {}, "reachCounter")).toBe(false);
  });

  it("is dropped from the description of a check that cannot report a count", () => {
    // A reach declared by a check with no coverage() could only ever total zero, and a
    // pack would then say the check was never put anything on a number it never made.
    const described = describeChecks([
      check({ reachCounter: "asked" }),
      check({ id: "reports", reachCounter: "asked", coverage: () => [] }),
    ]);

    expect(Object.hasOwn(described[0] ?? {}, "reachCounter")).toBe(false);
    expect(described[1]?.reachCounter).toBe("asked");
  });

  it("goes through the identifier grammar at registration, the library door", () => {
    const registry = new CheckRegistry();

    expect(() => registry.register(check({ reachCounter: "asked\nInjected" }))).toThrow(
      UnusableIdentifierError,
    );
    expect(() => registry.register(check({ reachCounter: "" }))).toThrow(UnusableIdentifierError);
    expect(() => registry.register(check({ reachCounter: "asked\nInjected" }))).toThrow(
      /The reach counter of the check "c"/,
    );
    expect(() => registry.register(check({ reachCounter: "asked" }))).not.toThrow();
  });
});

describe("checkReach on a clause row", () => {
  it("carries each declaring check's own total, in the order the ids sort", () => {
    const rows = clauseCoverage({
      checksRun: [run("beta", "asked"), run("alpha", "seen"), run("plain")],
      byCheck: [counters("beta", { asked: 2 }), counters("alpha", { seen: 0 })],
    });

    expect(rows[0]?.checkReach).toEqual([
      { checkId: "alpha", counter: "seen", total: 0 },
      { checkId: "beta", counter: "asked", total: 2 },
    ]);
  });

  it("is empty, and not absent, where the coverage was supplied and nothing declared", () => {
    const rows = clauseCoverage({ checksRun: [run("plain")], byCheck: [] });

    expect(rows[0]?.checkReach).toEqual([]);
  });

  it("is absent where the coverage was not supplied: unknown is not zero", () => {
    const rows = clauseCoverage({ checksRun: [run("declares", "asked")] });

    expect(Object.hasOwn(rows[0] ?? {}, "checkReach")).toBe(false);
  });

  it("is absent on a row only the matrix reaches", () => {
    const rows = clauseCoverage({
      cells: [{ verdict: "upheld" }],
      checksRun: [run("declares", "asked", [{ standard: "OWASP-API-2023", clause: "API1" }])],
      byCheck: [],
    });
    const matrixOnly = rows.find((one) => one.checkIds.length === 0);

    expect(matrixOnly).toBeDefined();
    expect(Object.hasOwn(matrixOnly ?? {}, "checkReach")).toBe(false);
  });
});

describe("the isolation check's reach", () => {
  const withEndpoints = (endpoints: readonly Endpoint[]) => ({
    matrix: { endpoints, accounts: [], resources: [], observations: [] },
  });

  it("is comparedPairs, and a run with no endpoint that declares a difference compared none", () => {
    const check = createIdenticalResponseCheck();
    const context = withEndpoints([{ id: "health", method: "GET", path: "/health" }]);
    const rows = clauseCoverage({
      checksRun: describeChecks([check]),
      byCheck: check.coverage?.(context) ?? [],
    });

    expect(check.reachCounter).toBe("comparedPairs");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.checkReach, row.clause).toEqual([
        { checkId: IDENTICAL_RESPONSE_CHECK_ID, counter: "comparedPairs", total: 0 },
      ]);
    }
  });

  it("is positive once an endpoint that declares a difference had pairs compared", () => {
    const check = createIdenticalResponseCheck();
    const byCheck: readonly CheckCoverage[] = [
      {
        checkId: IDENTICAL_RESPONSE_CHECK_ID,
        endpointId: "orders.list",
        counters: { comparedPairs: 3, matchedPairs: 0, differedPairs: 3 },
      },
    ];
    const rows = clauseCoverage({ checksRun: describeChecks([check]), byCheck });

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.checkReach?.[0]?.total, row.clause).toBe(3);
    }
  });
});

describe("withoutReach", () => {
  it("takes the declaration off the checks named, and only those", () => {
    const kept = withoutReach(
      [run("failed", "asked"), run("fine", "asked"), run("plain")],
      new Set(["failed", "plain", "unknown"]),
    );

    expect(Object.hasOwn(kept[0] ?? {}, "reachCounter")).toBe(false);
    expect(kept[0]).toMatchObject({ id: "failed", description: "the check failed" });
    expect(kept[1]?.reachCounter).toBe("asked");
    expect(kept[2]).toEqual(run("plain"));
  });

  it("makes a pack keep the reading it had for a check whose coverage threw", () => {
    const rows = clauseCoverage({
      checksRun: withoutReach([run("failed", "asked")], new Set(["failed"])),
      byCheck: [],
    });

    expect(rows[0]?.checkReach).toEqual([]);
  });
});

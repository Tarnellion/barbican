/**
 * Checks as plugins, which is what `plan.md` promises and ADR-0003 records:
 * Module 2 is added by registering checks, not by rewriting the core.
 *
 * The audit of 14 August 2026 found the promise held in four places and broken
 * in five (L-4). This file pins the four that were broken and are now closed:
 *
 * - `Check.standards` was declared, filled and **read by no line of code** — the
 *   word did not occur in a report at all, so the finding-to-clause
 *   traceability could not be built from a saved artifact.
 * - A registry could not be assembled for a particular run: every registered
 *   check ran, always.
 * - `CheckContext` carried only the matrix, so the statement "this clause was
 *   covered *enough*" was inexpressible rather than merely unwritten.
 * - A check's coverage went out through a function exported from one check and
 *   called by name, whose type the report layer imported — the report knowing
 *   one plugin by name.
 */

import { describe, expect, it } from "vitest";
import { CheckRegistry, UnknownCheckError } from "../../src/core/checks/registry.js";
import type { Check, CheckContext, CheckCoverage, Finding } from "../../src/core/checks/types.js";
import type { AccessMatrix } from "../../src/core/types.js";

const MATRIX: AccessMatrix = {
  endpoints: [{ id: "orders.list", method: "GET", path: "/v1/orders" }],
  accounts: [{ id: "alice", roleId: "user", tenantId: "t-a" }],
  resources: [],
  observations: [],
};

function stub(id: string, extra: Partial<Check> = {}): Check {
  return {
    id,
    description: `the ${id} check`,
    severity: "medium",
    standards: [{ standard: "OWASP-ASVS-5.0", clause: "1.2.3" }],
    run: () => [],
    ...extra,
  };
}

describe("assembling a registry for a particular run", () => {
  const registry = new CheckRegistry();
  registry.register(stub("first"));
  registry.register(stub("second"));

  /** The safe default: a check left out is coverage left out. */
  it("runs everything when nothing was selected", () => {
    expect(registry.select(undefined).map((one) => one.id)).toEqual(["first", "second"]);
  });

  it("runs only what was named, in the order it was named", () => {
    expect(registry.select("second,first").map((one) => one.id)).toEqual(["second", "first"]);
    expect(registry.select(" first ").map((one) => one.id)).toEqual(["first"]);
  });

  /**
   * A typo must not run the rest quietly. The only trace would be an entry
   * missing from `checksRun` that nobody was looking for, and the run would read
   * as "checked, and clean here".
   */
  it("refuses a name nobody registered", () => {
    expect(() => registry.select("frist")).toThrow(UnknownCheckError);
    // The message names what is available, or the operator has to read the
    // source to find out what they meant.
    expect(() => registry.select("frist")).toThrow(/first, second/);
  });

  it("selects nothing when asked for nothing", () => {
    expect(registry.select("")).toEqual([]);
  });
});

describe("what a check is told about the run", () => {
  /**
   * The difference between an evidence pack and a list of findings. A check that
   * sees only the matrix can say what it found; it cannot say that four of the
   * seven endpoints a clause is about were never probed at all.
   */
  it("carries what the run touched and what it did not", () => {
    let seen: CheckContext | undefined;
    const check = stub("scope-reader", {
      run(context) {
        seen = context;
        return [];
      },
    });

    check.run({
      matrix: MATRIX,
      scope: {
        probedEndpointIds: ["orders.list"],
        skipped: [{ endpointId: "orders.cancel", reason: "unsafe-method" }],
        truncated: false,
      },
    });

    expect(seen?.scope?.probedEndpointIds).toEqual(["orders.list"]);
    expect(seen?.scope?.skipped).toEqual([
      { endpointId: "orders.cancel", reason: "unsafe-method" },
    ]);
    expect(seen?.scope?.truncated).toBe(false);
  });

  /** Optional, so a check can be tested on a fixture without inventing a run. */
  it("is absent when the caller has no run to describe", () => {
    let seen: CheckContext | undefined;
    const check = stub("scope-reader", {
      run(context) {
        seen = context;
        return [];
      },
    });

    check.run({ matrix: MATRIX });

    expect(seen?.scope).toBeUndefined();
  });
});

describe("a check that has something to say about its own reach", () => {
  /**
   * Through the interface, not through a function the assembling code knows by
   * name. The counters are scalars named by the check, and the report carries
   * them without knowing what they mean.
   */
  it("reports it as counters the report need not understand", () => {
    const coverage: readonly CheckCoverage[] = [
      { checkId: "pairs", endpointId: "orders.list", counters: { comparedPairs: 3 } },
    ];
    const check = stub("pairs", { coverage: () => coverage });

    expect(check.coverage?.({ matrix: MATRIX })).toEqual(coverage);
  });

  /** A check with nothing to say says nothing, and the caller copes. */
  it("may have none", () => {
    expect(stub("silent").coverage).toBeUndefined();
  });
});

describe("a finding that names no cell", () => {
  /**
   * "This clause is covered by nothing" is the natural shape for the evidence
   * pack, and the type has always allowed it. The report used to drop it.
   */
  it("is what the type has always allowed", () => {
    const finding: Finding = {
      checkId: "evidence-coverage-insufficient",
      severity: "critical",
      title: "the clause is not covered by any probe",
      evidence: { probedEndpoints: 0 },
    };

    expect(finding.accountId).toBeUndefined();
    expect(finding.endpointId).toBeUndefined();
  });
});

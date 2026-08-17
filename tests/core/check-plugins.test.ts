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
import {
  CheckRegistry,
  describeChecks,
  ReservedCheckIdError,
  runChecks,
  UnknownCheckError,
} from "../../src/core/checks/registry.js";
import { createIdenticalResponseCheck } from "../../src/core/checks/tenant-isolation.js";
import type { Check, CheckContext, CheckCoverage, Finding } from "../../src/core/checks/types.js";
import type { AccessMatrix } from "../../src/core/types.js";

const MATRIX: AccessMatrix = {
  endpoints: [{ id: "orders.list", method: "GET", path: "/v1/orders" }],
  accounts: [{ id: "alice", roleId: "user", tenantId: "t-a" }],
  resources: [],
  observations: [],
};

/**
 * Two tenants, one digest, on an endpoint a human declared must differ between
 * them. Written out by hand, like every fixture here: a matrix generated from the
 * check would test the check against itself.
 */
function leakingMatrix(): AccessMatrix {
  const seen = (accountId: string) => ({
    endpointId: "orders.list",
    accountId,
    status: 200,
    headers: {},
    outcome: "allowed" as const,
    durationMs: 1,
    signals: { digest: 4242 },
  });
  return {
    endpoints: [
      { id: "orders.list", method: "GET", path: "/v1/orders", responseMustDifferByTenant: true },
    ],
    accounts: [
      { id: "alice", roleId: "user", tenantId: "t-a" },
      { id: "carol", roleId: "user", tenantId: "t-b" },
    ],
    resources: [],
    observations: [seen("alice"), seen("carol")],
  };
}

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

  /**
   * An empty selection is a typo, not a choice.
   *
   * It used to return an empty list and be obeyed in silence: `--checks ""`,
   * `--checks ,` and `--checks " "` switched the body channel off, and a leak
   * visible only by body left the run green with `checksRun: []` in the report
   * and no warning anywhere. There is deliberately no way to spell "run no
   * checks" — the flag narrows a run, it does not disarm it. Found by
   * adversarial review on 17 August 2026.
   */
  it("refuses an empty selection rather than running nothing", () => {
    expect(() => registry.select("")).toThrow(UnknownCheckError);
    expect(() => registry.select(",")).toThrow(UnknownCheckError);
    expect(() => registry.select(" ")).toThrow(UnknownCheckError);
    // The message names what is available, as it does for a misspelling.
    expect(() => registry.select("")).toThrow(/first, second/);
  });
});

describe("a check may not take the name of a matrix discrepancy", () => {
  /**
   * `summary.byKind` holds kinds of matrix discrepancy and check identifiers in
   * one key space, so a check registered under one of those names would have its
   * findings reported to the reader as privilege escalations. Refused at
   * registration for the same reason the signal name `digest` is refused when a
   * configuration is parsed: a collision that can be refused should not be left
   * to be noticed. Found by the audit of 14 August (B-4).
   */
  it("refuses all four of them", () => {
    for (const reserved of [
      "privilege-escalation",
      "unexpected-denial",
      "not-observed",
      "probe-error",
    ]) {
      expect(() => new CheckRegistry().register(stub(reserved))).toThrow(ReservedCheckIdError);
    }
  });

  it("says which names are taken, so the message is a fix", () => {
    expect(() => new CheckRegistry().register(stub("probe-error"))).toThrow(
      /privilege-escalation, unexpected-denial, not-observed, probe-error/,
    );
  });

  it("lets any other name through", () => {
    expect(() => new CheckRegistry().register(stub("identical-response"))).not.toThrow();
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

/**
 * `Check.severity` and `Check.description`, which nobody read.
 *
 * The state `standards` was in until 15 August, found by the same audit and
 * answered the same way: wired up, not deleted. Severity was worse than merely
 * unread — it was declared twice, on the check and again as a literal inside
 * `run()`, in the value the report sorts by and the exit code comes from, with
 * nothing in the language to relate the two. Found by the audit of 14 August
 * 2026 (L-8).
 */
describe("what a check declares about itself", () => {
  const context: CheckContext = { matrix: MATRIX };
  const finding = (extra: Partial<Finding> = {}): Finding => ({
    checkId: "weighty",
    title: "something",
    endpointId: "orders.list",
    accountId: "alice",
    evidence: {},
    ...extra,
  });

  /** The declaration on the check is where a finding's severity comes from. */
  it("puts its severity on the findings that name none", () => {
    const check = stub("weighty", { severity: "critical", run: () => [finding()] });

    expect(runChecks([check], context).map((one) => one.severity)).toEqual(["critical"]);
  });

  /**
   * And a check whose findings genuinely differ in weight can still say so.
   * Without this the field would be a constant rather than a default, and a
   * check that grades its findings would have nowhere to put the grade.
   */
  it("lets a finding carry a severity of its own", () => {
    const check = stub("weighty", {
      severity: "critical",
      run: () => [finding({ severity: "low" }), finding()],
    });

    expect(runChecks([check], context).map((one) => one.severity)).toEqual(["low", "critical"]);
  });

  /** Several checks, each answering for its own findings. */
  it("keeps each check's findings on that check's severity", () => {
    const findings = runChecks(
      [
        stub("first", { severity: "medium", run: () => [finding({ checkId: "first" })] }),
        stub("second", { severity: "info", run: () => [finding({ checkId: "second" })] }),
      ],
      context,
    );

    expect(findings.map((one) => [one.checkId, one.severity])).toEqual([
      ["first", "medium"],
      ["second", "info"],
    ]);
  });

  /**
   * The check in the tree declares `high` once and no longer repeats it. Asserted
   * on the real check rather than on a stub: the duplicate literal was in this
   * one, and a stub cannot have it.
   */
  it("is where the tenant-isolation check's severity now comes from, once", () => {
    const check = createIdenticalResponseCheck();
    const matrix = leakingMatrix();

    expect(check.run({ matrix })).toHaveLength(1);
    // Nothing of its own on the finding — the check said it, the runner puts it on.
    expect(check.run({ matrix })[0]?.severity).toBeUndefined();
    expect(runChecks([check], { matrix })[0]?.severity).toBe(check.severity);
    expect(check.severity).toBe("high");
  });

  /**
   * And the description reaches the report. It is the only sentence in the
   * project saying what a check does in words, and the reader of a saved
   * artifact has the report and not `src/core/checks/`.
   */
  it("goes into the report's list of checks, description and all", () => {
    expect(describeChecks([stub("first"), stub("second")])).toEqual([
      {
        id: "first",
        description: "the first check",
        standards: [{ standard: "OWASP-ASVS-5.0", clause: "1.2.3" }],
      },
      {
        id: "second",
        description: "the second check",
        standards: [{ standard: "OWASP-ASVS-5.0", clause: "1.2.3" }],
      },
    ]);
  });

  /** The real check describes itself too, and not with its own identifier. */
  it("describes the tenant-isolation check in words rather than by its id", () => {
    const [described] = describeChecks([createIdenticalResponseCheck()]);

    expect(described?.description).toContain("different tenants");
    expect(described?.description).not.toBe(described?.id);
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

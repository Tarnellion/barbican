/**
 * A check that throws takes itself out of the run and nothing else with it.
 *
 * `runChecks` is called after the walk and before `buildReport`, so an exception
 * from a check used to reach the CLI's handler: "Run aborted", no file written,
 * and an hour of traffic against somebody else's deployment discarded because
 * one check met a shape it did not expect — the ordinary condition of code
 * reading data from a system nobody here controls.
 *
 * The argument against that was already written twenty lines further on in
 * `src/cli.ts`, where a failure to write the report prints it to stdout instead:
 * the run is already paid for in traffic, and losing the result now would mean
 * spending it twice. It had not been applied one step earlier.
 *
 * At one registered check the risk was theoretical. ADR-0003 promises a registry
 * others extend, and Module 2 is where "others" starts. See ADR-0039 and the
 * audit of 20 August 2026 (M-13).
 */

import { describe, expect, it } from "vitest";
import type { Check, CheckContext } from "../../src/core/index.js";
import { runChecks } from "../../src/core/index.js";

const context = {
  matrix: { accounts: [], endpoints: [], resources: [], observations: [] },
} as unknown as CheckContext;

const working: Check = {
  id: "working",
  description: "finds one thing and does not throw",
  severity: "medium",
  standards: [],
  run: () => [{ checkId: "working", title: "found", evidence: {} }],
};

const throwing: Check = {
  id: "throwing",
  description: "meets a shape it did not expect",
  severity: "low",
  standards: [],
  run: () => {
    throw new TypeError("Cannot read properties of undefined (reading 'id')");
  },
};

describe("a check that throws", () => {
  it("does not take the run with it", () => {
    expect(() => runChecks([throwing], context)).not.toThrow();
  });

  it("does not take its neighbours with it, whichever side it runs on", () => {
    const before = runChecks([throwing, working], context);
    const after = runChecks([working, throwing], context);

    expect(before.some((finding) => finding.checkId === "working")).toBe(true);
    expect(after.some((finding) => finding.checkId === "working")).toBe(true);
  });

  /**
   * The distinction `describeChecks` exists to make: a check that crashed and a
   * check that found nothing are the same report otherwise, and the second is
   * read as good news.
   */
  it("says so, rather than looking like a check that found nothing", () => {
    const findings = runChecks([throwing], context);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.checkId).toBe("throwing");
    expect(findings[0]?.title).toContain("throwing");
    expect(findings[0]?.evidence.checkFailed).toBe(true);
  });

  /**
   * The class name and not the message. A bounded vocabulary of symbols cannot
   * carry a URL with a token in it; a message from a check written elsewhere is
   * a string this project has audited for nothing.
   */
  it("carries the class of the failure and not its message", () => {
    const findings = runChecks([throwing], context);

    expect(findings[0]?.evidence.error).toBe("TypeError");
    expect(JSON.stringify(findings[0])).not.toContain("Cannot read properties");
  });

  /** It fails the run: a check that judged nothing is not a check that agreed. */
  it("is not an `info` finding", () => {
    expect(runChecks([throwing], context)[0]?.severity).not.toBe("info");
  });
});

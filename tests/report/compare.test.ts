/**
 * Comparing two saved reports.
 *
 * The two questions an operator asks a second run — "what changed since
 * yesterday" and "is this the platform regressing or my own edit" — were both
 * answerable from the file and answerable by nobody: the report has carried
 * `configDigest` to separate the two causes and a citable `defects[].key` to
 * name a defect across runs, and nothing read either. A plain `diff` of two
 * report files is useless — `runId`, the three timestamps, `durationMs` on every
 * observation and the per-run salt behind `signals.digest` all differ on two
 * runs of the same matrix against the same platform.
 *
 * The fixtures here are written by hand. A pair of reports produced by running
 * the tool twice would make this a test that `compareRuns` agrees with
 * `buildReport`, and the end-to-end pair that does exercise both lives in
 * `tests/invariants/cli-surface.test.ts`, where it can also be asked for an exit
 * code.
 */

import { describe, expect, it } from "vitest";
import {
  type ComparableDefect,
  type ComparableRun,
  compareRuns,
  renderComparison,
  toComparableRun,
  UnreadableReportError,
} from "../../src/report/compare.js";

/**
 * A defect as the report prints one.
 *
 * `key` is not derived from the other fields here on purpose: it is the string
 * the report writes and the string this comparison joins on, and a fixture that
 * computed it would be agreeing with the function under test.
 */
function defect(over: Partial<ComparableDefect> & { readonly key: string }): ComparableDefect {
  return {
    endpointId: over.key.split(" ")[0] ?? "",
    kinds: ["privilege-escalation"],
    severity: "critical",
    accountIds: ["carol-b"],
    resourceIds: [],
    violations: 4,
    ...over,
  };
}

function run(over: Partial<ComparableRun> = {}): ComparableRun {
  return {
    schemaVersion: "2",
    runId: "11111111-1111-4111-8111-111111111111",
    configDigest: "aaaa000000000000",
    startedAt: "2026-08-20T09:00:00.000Z",
    truncated: false,
    target: { baseUrl: "https://api.test", label: "staging" },
    defects: [],
    observations: [],
    coverage: { endpointsTotal: 4, endpointsProbed: 4, cellsObserved: 144, notProbed: {} },
    verdict: { code: 0, reason: "no discrepancy with the declared policy" },
    ...over,
  };
}

/** The endpoints a run asked about, in the shape the report records them. */
function probed(...endpointIds: readonly string[]): readonly { readonly endpointId: string }[] {
  return endpointIds.map((endpointId) => ({ endpointId }));
}

const LATER = "2026-08-21T09:00:00.000Z";
const SECOND_RUN = "22222222-2222-4222-8222-222222222222";

/** The rendered screen as one string, which is how a reader meets it. */
function screen(comparison: ReturnType<typeof compareRuns>): string {
  return renderComparison(comparison)
    .map((line) => line.text)
    .join("\n");
}

describe("two runs of the same declaration", () => {
  it("says nothing changed, and exits 0", () => {
    const before = run({ defects: [defect({ key: "orders.list any-resource baseline" })] });
    const after = run({
      runId: SECOND_RUN,
      startedAt: LATER,
      defects: [defect({ key: "orders.list any-resource baseline" })],
    });

    const comparison = compareRuns(before, after);

    expect(comparison.verdict.code).toBe(0);
    expect(comparison.defects.unchanged).toBe(1);
    expect(comparison.defects.gone).toEqual([]);
    expect(comparison.defects.appeared).toEqual([]);
    expect(comparison.defects.changed).toEqual([]);
  });

  /**
   * The unit of comparison is the defect, not the finding row.
   *
   * ADR-0029 caps the evidence rows at fifty per defect, and `violations` counts
   * the cells one defect touched — a number that moves when the matrix is
   * widened by one account. Neither is news about the platform, and a comparison
   * that reported them would cry wolf on every run where a resource was added.
   */
  it("does not call a different number of cells a difference", () => {
    const before = run({
      defects: [defect({ key: "orders.list any-resource baseline", violations: 50 })],
    });
    const after = run({
      runId: SECOND_RUN,
      startedAt: LATER,
      defects: [defect({ key: "orders.list any-resource baseline", violations: 12 })],
    });

    const comparison = compareRuns(before, after);

    expect(comparison.verdict.code).toBe(0);
    expect(comparison.defects.changed).toEqual([]);
    expect(comparison.defects.unchanged).toBe(1);
  });
});

describe("a defect that appeared and one that went", () => {
  const before = run({
    observations: probed("orders.list", "invoices.list", "reports.list"),
    defects: [
      defect({ key: "orders.list any-resource baseline" }),
      defect({ key: "invoices.list any-resource baseline", severity: "high" }),
    ],
    verdict: { code: 1, reason: "privilege escalation: 8 cells" },
  });
  const after = run({
    runId: SECOND_RUN,
    startedAt: LATER,
    observations: probed("orders.list", "invoices.list", "reports.list"),
    defects: [
      defect({ key: "invoices.list any-resource baseline", severity: "high" }),
      defect({ key: "reports.list any-resource baseline" }),
    ],
    verdict: { code: 1, reason: "privilege escalation: 8 cells" },
  });

  it("names both, and exits 1", () => {
    const comparison = compareRuns(before, after);

    expect(comparison.verdict.code).toBe(1);
    expect(comparison.defects.gone.map((one) => one.defect.key)).toEqual([
      "orders.list any-resource baseline",
    ]);
    expect(comparison.defects.appeared.map((one) => one.defect.key)).toEqual([
      "reports.list any-resource baseline",
    ]);
    expect(comparison.defects.unchanged).toBe(1);
  });

  /**
   * A defect is gone from a run that looked, which is the only reading under
   * which "gone" means "fixed".
   */
  it("records that the second run did probe the endpoint", () => {
    const comparison = compareRuns(before, after);

    expect(comparison.defects.gone[0]?.otherRunProbedEndpoint).toBe(true);
    expect(comparison.defects.appeared[0]?.otherRunProbedEndpoint).toBe(true);
    expect(screen(comparison)).toContain("probed orders.list and found nothing there");
  });

  /**
   * And the reading that is not a fix at all: the endpoint was never asked
   * about. This is the half a `git diff` of two files cannot give, because the
   * absence of a defect looks identical either way.
   */
  it("refuses to call a disappearance a fix when the endpoint was not probed", () => {
    const narrowed = run({
      runId: SECOND_RUN,
      startedAt: LATER,
      observations: probed("invoices.list", "reports.list"),
      defects: [defect({ key: "invoices.list any-resource baseline", severity: "high" })],
      coverage: { endpointsTotal: 4, endpointsProbed: 2, cellsObserved: 144, notProbed: {} },
    });

    const comparison = compareRuns(before, narrowed);

    expect(comparison.defects.gone[0]?.otherRunProbedEndpoint).toBe(false);
    expect(screen(comparison)).toContain("never probed orders.list");
  });

  /** The mirror: a new defect on an endpoint nobody had probed before. */
  it("says a new defect may be new coverage rather than new breakage", () => {
    const narrow = run({
      observations: probed("orders.list"),
      defects: [defect({ key: "orders.list any-resource baseline" })],
    });
    const wide = run({
      runId: SECOND_RUN,
      startedAt: LATER,
      observations: probed("orders.list", "reports.list"),
      defects: [
        defect({ key: "orders.list any-resource baseline" }),
        defect({ key: "reports.list any-resource baseline" }),
      ],
    });

    const comparison = compareRuns(narrow, wide);

    expect(comparison.defects.appeared[0]?.otherRunProbedEndpoint).toBe(false);
    expect(screen(comparison)).toContain("newly covered rather than newly broken");
  });
});

describe("a defect that changed without going away", () => {
  it("names the kind that was added", () => {
    const before = run({
      observations: probed("orders.list"),
      defects: [
        defect({ key: "orders.list any-resource baseline", kinds: ["privilege-escalation"] }),
      ],
    });
    const after = run({
      runId: SECOND_RUN,
      startedAt: LATER,
      observations: probed("orders.list"),
      defects: [
        defect({
          key: "orders.list any-resource baseline",
          kinds: ["identical-response-across-tenants", "privilege-escalation"],
        }),
      ],
    });

    const comparison = compareRuns(before, after);

    expect(comparison.verdict.code).toBe(1);
    expect(comparison.defects.changed[0]?.changes.map((one) => one.axis)).toEqual(["kinds"]);
    expect(screen(comparison)).toContain("identical-response-across-tenants");
  });

  it("names a severity that moved", () => {
    const before = run({
      observations: probed("orders.list"),
      defects: [defect({ key: "orders.list any-resource baseline", severity: "medium" })],
    });
    const after = run({
      runId: SECOND_RUN,
      startedAt: LATER,
      observations: probed("orders.list"),
      defects: [defect({ key: "orders.list any-resource baseline", severity: "critical" })],
    });

    const comparison = compareRuns(before, after);

    expect(comparison.defects.changed[0]?.changes).toEqual([
      { axis: "severity", before: "medium", after: "critical" },
    ]);
  });

  /**
   * A defect that stopped failing the build because somebody signed for it.
   *
   * ADR-0048 keeps the row in the report and takes it out of the verdict, so
   * two runs whose verdicts differ by exactly this look, to every counter above
   * them, like a platform that was fixed. It is the sharpest form of the
   * question this subcommand exists for, and the answer is on the defect.
   */
  it("treats an acceptance appearing as a change, not as a fix", () => {
    const before = run({
      observations: probed("orders.list"),
      defects: [defect({ key: "orders.list any-resource baseline" })],
      verdict: { code: 1, reason: "privilege escalation: 4 cells" },
    });
    const after = run({
      runId: SECOND_RUN,
      startedAt: LATER,
      observations: probed("orders.list"),
      defects: [
        defect({
          key: "orders.list any-resource baseline",
          acceptedKinds: ["privilege-escalation"],
        }),
      ],
      verdict: { code: 0, reason: "no discrepancy that fails a run" },
    });

    const comparison = compareRuns(before, after);

    expect(comparison.verdict.code).toBe(1);
    expect(comparison.defects.gone).toEqual([]);
    expect(comparison.defects.changed[0]?.changes.map((one) => one.axis)).toEqual(["acceptance"]);
    expect(screen(comparison)).toContain("held out of the verdict");
  });
});

describe("the declaration behind the two runs", () => {
  it("says so first when the digests differ", () => {
    const before = run({ configDigest: "aaaa000000000000" });
    const after = run({ runId: SECOND_RUN, startedAt: LATER, configDigest: "bbbb111111111111" });

    const comparison = compareRuns(before, after);
    const lines = renderComparison(comparison).map((line) => line.text);

    expect(comparison.declaration.changed).toBe(true);
    // First among the things the comparison has to say, before coverage and
    // before a single defect: everything below it may be the reader's own edit.
    const declaration = lines.findIndex((line) => line.includes("configDigest"));
    const coverage = lines.findIndex((line) => line.startsWith("Coverage"));
    const defects = lines.findIndex((line) => line.startsWith("Defects"));
    expect(declaration).toBeGreaterThan(-1);
    expect(declaration).toBeLessThan(coverage);
    expect(declaration).toBeLessThan(defects);
    expect(lines[declaration]).toContain("your own edit");
  });

  /** A changed declaration is a caveat over the reading, not a difference in it. */
  it("does not make a changed declaration a difference by itself", () => {
    const before = run();
    const after = run({ runId: SECOND_RUN, startedAt: LATER, configDigest: "bbbb111111111111" });

    expect(compareRuns(before, after).verdict.code).toBe(0);
  });

  it("says the declaration held when the digests agree", () => {
    const comparison = compareRuns(run(), run({ runId: SECOND_RUN, startedAt: LATER }));

    expect(comparison.declaration.changed).toBe(false);
    expect(screen(comparison)).toContain("The declaration is the same in both runs");
  });
});

describe("a difference in coverage", () => {
  /**
   * The run that "fixed" nothing.
   *
   * 144 cells yesterday and 12 today is not a platform that improved, and every
   * defect missing from the second run is missing because nothing went looking.
   */
  it("is untrustworthy when the second run looked at less", () => {
    const before = run({
      observations: probed("orders.list", "invoices.list"),
      defects: [defect({ key: "orders.list any-resource baseline" })],
    });
    const after = run({
      runId: SECOND_RUN,
      startedAt: LATER,
      observations: probed("invoices.list"),
      coverage: {
        endpointsTotal: 4,
        endpointsProbed: 1,
        cellsObserved: 12,
        notProbed: { "path-parameters": 3 },
      },
    });

    const comparison = compareRuns(before, after);

    expect(comparison.coverage.shrank).toBe(true);
    expect(comparison.coverage.noLongerProbed).toEqual(["orders.list"]);
    expect(comparison.verdict.code).toBe(2);
    expect(screen(comparison)).toContain("Coverage shrank");
  });

  /** Growth is news of the same kind, and it is not a reason to distrust. */
  it("is a difference, not a blocker, when the second run looked at more", () => {
    const before = run({
      observations: probed("orders.list"),
      coverage: { endpointsTotal: 4, endpointsProbed: 1, cellsObserved: 12, notProbed: {} },
    });
    const after = run({
      runId: SECOND_RUN,
      startedAt: LATER,
      observations: probed("orders.list", "invoices.list"),
      coverage: { endpointsTotal: 4, endpointsProbed: 2, cellsObserved: 24, notProbed: {} },
    });

    const comparison = compareRuns(before, after);

    expect(comparison.coverage.shrank).toBe(false);
    expect(comparison.coverage.newlyProbed).toEqual(["invoices.list"]);
    expect(comparison.verdict.code).toBe(1);
  });

  /** Why the surface shrank, in the runner's own vocabulary for it. */
  it("carries the reasons endpoints were left out", () => {
    const before = run({
      coverage: {
        endpointsTotal: 4,
        endpointsProbed: 4,
        cellsObserved: 144,
        notProbed: { excluded: 1 },
      },
    });
    const after = run({
      runId: SECOND_RUN,
      startedAt: LATER,
      coverage: {
        endpointsTotal: 4,
        endpointsProbed: 1,
        cellsObserved: 12,
        notProbed: { excluded: 1, "path-parameters": 3 },
      },
    });

    const comparison = compareRuns(before, after);

    expect(comparison.coverage.reasons).toEqual([
      { reason: "excluded", before: 1, after: 1 },
      { reason: "path-parameters", before: 0, after: 3 },
    ]);
    // The unchanged one is carried and not printed: a line saying a number did
    // not move is a line a reader has to skip on every run.
    expect(screen(comparison)).toContain('endpoints skipped as "path-parameters": 0 → 3');
    expect(screen(comparison)).not.toContain('endpoints skipped as "excluded"');
  });

  /**
   * A reason named after something on `Object.prototype`.
   *
   * `coverage.notProbed` is keyed by the runner's vocabulary as a **saved file**
   * spells it, which is a key space this module did not choose — and a report
   * parsed back out of JSON carries `Object.prototype`. Reading the other run's
   * count with `record[reason]` instead of `lookup` therefore answers for
   * `constructor` with a **function**, and the row this comparison prints comes
   * out as one. ADR-0024, on the reading side; the key here is present in one
   * run and absent from the other, which is the only way that lookup happens.
   */
  it("reads a reason named constructor as absent from the run that lacks it", () => {
    const before = run({
      coverage: {
        endpointsTotal: 4,
        endpointsProbed: 4,
        cellsObserved: 144,
        notProbed: JSON.parse('{"constructor": 2}') as Record<string, number>,
      },
    });
    const after = run({
      runId: SECOND_RUN,
      startedAt: LATER,
      coverage: { endpointsTotal: 4, endpointsProbed: 4, cellsObserved: 144, notProbed: {} },
    });

    const comparison = compareRuns(before, after);

    expect(comparison.coverage.reasons).toEqual([{ reason: "constructor", before: 2, after: 0 }]);
  });
});

describe("what cannot be compared", () => {
  it("refuses two reports of different shapes", () => {
    const comparison = compareRuns(
      run({ schemaVersion: "1" }),
      run({ runId: SECOND_RUN, startedAt: LATER }),
    );

    expect(comparison.compared).toBe(false);
    expect(comparison.blockers.map((one) => one.kind)).toEqual(["schema-differs"]);
    expect(comparison.verdict.code).toBe(2);
    // And it does not go on to compare fields that have moved between shapes.
    expect(comparison.defects.unchanged).toBe(0);
  });

  it("refuses a shape this build does not read", () => {
    const comparison = compareRuns(
      run({ schemaVersion: "1" }),
      run({ schemaVersion: "1", runId: SECOND_RUN, startedAt: LATER }),
    );

    expect(comparison.compared).toBe(false);
    expect(comparison.blockers.map((one) => one.kind)).toEqual(["schema-unreadable"]);
    expect(comparison.verdict.code).toBe(2);
  });

  /**
   * A report against itself.
   *
   * Every difference is zero by construction, and an empty comparison is the
   * exact shape of "nothing changed since yesterday" — the most expensive false
   * clean this subcommand can produce.
   */
  it("refuses a report compared with itself", () => {
    const comparison = compareRuns(run(), run());

    expect(comparison.blockers.map((one) => one.kind)).toEqual(["same-run"]);
    expect(comparison.verdict.code).toBe(2);
  });

  /**
   * A truncated run is honest only as "here is what was looked at", so the
   * comparison is performed and printed in full and the verdict says it cannot
   * settle anything.
   */
  it("compares a truncated run but does not trust the result", () => {
    const before = run({
      observations: probed("orders.list"),
      defects: [defect({ key: "orders.list any-resource baseline" })],
    });
    const after = run({
      runId: SECOND_RUN,
      startedAt: LATER,
      truncated: true,
      observations: probed("orders.list"),
      defects: [defect({ key: "orders.list any-resource baseline" })],
      verdict: { code: 2, reason: "the run was cut short" },
    });

    const comparison = compareRuns(before, after);

    expect(comparison.compared).toBe(true);
    expect(comparison.defects.unchanged).toBe(1);
    expect(comparison.blockers.map((one) => one.kind)).toContain("truncated");
    expect(comparison.verdict.code).toBe(2);
    expect(screen(comparison)).toContain("what was looked at");
  });

  /** A run whose own verdict was 2 cannot anchor a comparison either. */
  it("will not build on a run that could not be trusted", () => {
    const before = run({
      verdict: { code: 2, reason: "credentials nothing confirmed: carol-b" },
    });
    const after = run({ runId: SECOND_RUN, startedAt: LATER });

    const comparison = compareRuns(before, after);

    expect(comparison.blockers.map((one) => one.kind)).toContain("untrusted-run");
    expect(comparison.verdict.code).toBe(2);
  });

  /**
   * Two positional arguments in the wrong order invert every conclusion: what
   * was fixed reads as broken and back. Said out loud rather than refused — a
   * comparison run backwards on purpose is a fair thing to want.
   */
  it("says so when the second report is the older one", () => {
    const comparison = compareRuns(run({ startedAt: LATER }), run({ runId: SECOND_RUN }));

    expect(screen(comparison)).toContain("older than the first");
  });

  /** And the screen for a pair of shapes says that, and stops. */
  it("prints nothing below the declaration when the shapes do not line up", () => {
    const lines = renderComparison(
      compareRuns(run({ schemaVersion: "1" }), run({ runId: SECOND_RUN, startedAt: LATER })),
    ).map((line) => line.text);

    expect(lines.some((line) => line.startsWith("Nothing was compared:"))).toBe(true);
    // No coverage line and no defect line: both would be arithmetic over fields
    // that are not the same fields.
    expect(lines.some((line) => line.startsWith("Coverage"))).toBe(false);
    expect(lines.some((line) => line.startsWith("Defects"))).toBe(false);
    expect(lines.at(-1)).toContain("Exit code 2");
  });
});

/**
 * Worst first, and the same order on every machine.
 *
 * The lists are what a reader scans, and a nine-defect run whose critical row
 * sits sixth is a run whose worst news is below the fold. The tie-break is
 * `byCodeUnits` for the reason ADR-0036 gives: `localeCompare` with no locale
 * takes the order from the machine's `LC_ALL`, and two people comparing one
 * pair of files would then read two different screens.
 */
describe("the order the lists come out in", () => {
  it("puts the worst defect first and breaks ties by key", () => {
    const before = run({ observations: probed("a.list", "b.list", "c.list", "d.list") });
    const after = run({
      runId: SECOND_RUN,
      startedAt: LATER,
      observations: probed("a.list", "b.list", "c.list", "d.list"),
      defects: [
        defect({ key: "d.list any-resource baseline", severity: "low" }),
        defect({ key: "b.list any-resource baseline", severity: "critical" }),
        defect({ key: "c.list any-resource baseline", severity: "medium" }),
        defect({ key: "a.list any-resource baseline", severity: "critical" }),
      ],
    });

    const comparison = compareRuns(before, after);

    expect(comparison.defects.appeared.map((one) => one.defect.key)).toEqual([
      "a.list any-resource baseline",
      "b.list any-resource baseline",
      "c.list any-resource baseline",
      "d.list any-resource baseline",
    ]);
  });

  /**
   * A severity out of a file, and not one of the five.
   *
   * `SEVERITY_ORDER` is an object literal, so ranking by `SEVERITY_ORDER[level]`
   * answers for `constructor` with a **function**: every subtraction in the
   * comparator becomes `NaN`, and a comparator returning `NaN` leaves the order
   * to the engine. A saved report is a document this tool was handed, and
   * ADR-0024 is about the door, not about the likelihood.
   */
  it("ranks an unknown severity last instead of shuffling the list", () => {
    const before = run({ observations: probed("a.list", "b.list", "c.list") });
    const after = run({
      runId: SECOND_RUN,
      startedAt: LATER,
      observations: probed("a.list", "b.list", "c.list"),
      defects: [
        defect({ key: "a.list any-resource baseline", severity: "constructor" }),
        defect({ key: "b.list any-resource baseline", severity: "toString" }),
        defect({ key: "c.list any-resource baseline", severity: "high" }),
      ],
    });

    const comparison = compareRuns(before, after);

    expect(comparison.defects.appeared.map((one) => one.defect.key)).toEqual([
      "c.list any-resource baseline",
      "a.list any-resource baseline",
      "b.list any-resource baseline",
    ]);
  });

  it("orders the gone and the changed lists by the same rule", () => {
    const before = run({
      observations: probed("a.list", "b.list", "c.list", "d.list"),
      defects: [
        defect({ key: "d.list any-resource baseline", severity: "low" }),
        defect({ key: "b.list any-resource baseline", severity: "critical" }),
        defect({ key: "a.list any-resource baseline", severity: "medium" }),
        defect({ key: "c.list any-resource baseline", severity: "high" }),
      ],
    });
    const after = run({
      runId: SECOND_RUN,
      startedAt: LATER,
      observations: probed("a.list", "b.list", "c.list", "d.list"),
      defects: [
        defect({ key: "a.list any-resource baseline", severity: "critical" }),
        defect({ key: "c.list any-resource baseline", severity: "low" }),
      ],
    });

    const comparison = compareRuns(before, after);

    expect(comparison.defects.gone.map((one) => one.defect.key)).toEqual([
      "b.list any-resource baseline",
      "d.list any-resource baseline",
    ]);
    // Sorted by how the defect stands **now**, which is what a reader is
    // deciding what to open next from.
    expect(comparison.defects.changed.map((one) => one.key)).toEqual([
      "a.list any-resource baseline",
      "c.list any-resource baseline",
    ]);
  });
});

describe("reading a report off disk", () => {
  const MINIMAL = {
    schemaVersion: "2",
    runId: "11111111-1111-4111-8111-111111111111",
    configDigest: "aaaa",
    startedAt: "2026-08-20T09:00:00.000Z",
    truncated: false,
    target: { baseUrl: "https://api.test" },
    defects: [],
    observations: [],
    coverage: { endpointsTotal: 1, endpointsProbed: 1, cellsObserved: 1, notProbed: {} },
    verdict: { code: 0, reason: "clean" },
  };

  /** A defect as the report prints one, with every optional field present. */
  const FULL_DEFECT = {
    key: "orders.byId foreign-tenant geo-blocked",
    endpointId: "orders.byId",
    kinds: ["privilege-escalation"],
    severity: "critical",
    accountIds: ["carol-b"],
    resourceIds: ["alice-order"],
    violations: 3,
    contextId: "geo-blocked",
    relation: "foreign-tenant",
    acceptedKinds: ["privilege-escalation"],
  };

  it("accepts one the tool wrote", () => {
    expect(toComparableRun(MINIMAL, "before.json").runId).toBe(MINIMAL.runId);
  });

  it("carries the optional halves of a defect and the endpoints that were asked", () => {
    const parsed = toComparableRun(
      {
        ...MINIMAL,
        target: { baseUrl: "https://api.test", label: "staging" },
        defects: [FULL_DEFECT],
        observations: [{ endpointId: "orders.byId" }, { endpointId: "orders.list" }],
        coverage: {
          endpointsTotal: 2,
          endpointsProbed: 2,
          cellsObserved: 6,
          notProbed: { excluded: 1 },
        },
      },
      "before.json",
    );

    expect(parsed.target.label).toBe("staging");
    expect(parsed.defects[0]).toEqual(FULL_DEFECT);
    expect(parsed.observations.map((one) => one.endpointId)).toEqual([
      "orders.byId",
      "orders.list",
    ]);
    expect(parsed.coverage.notProbed).toEqual({ excluded: 1 });
  });

  /**
   * A skip reason named `__proto__`, in a file this tool did not write.
   *
   * `JSON.parse` makes it an own property and `Object.entries` lists it, so the
   * record is read correctly and then **written** into an object literal, where
   * the assignment calls the prototype setter, is ignored for a number, and the
   * row silently disappears. `openRecord` — `Object.create(null)` — is what
   * makes the write land. ADR-0024, and the exact shape it names: "a plain
   * object literal swallows a key named `__proto__`".
   *
   * Written as JSON text rather than as an object literal because there is no
   * other way to build one: `{ "__proto__": 2 }` in source is the syntax that
   * sets a prototype, not the syntax that creates a property.
   */
  it("keeps a skip reason named __proto__, which an object literal swallows", () => {
    const document = JSON.parse(`{
      "schemaVersion": "2",
      "runId": "33333333-3333-4333-8333-333333333333",
      "configDigest": "aaaa",
      "startedAt": "2026-08-21T09:00:00.000Z",
      "truncated": false,
      "target": { "baseUrl": "https://api.test" },
      "defects": [],
      "observations": [],
      "coverage": {
        "endpointsTotal": 4,
        "endpointsProbed": 1,
        "cellsObserved": 12,
        "notProbed": { "__proto__": 2, "excluded": 1 }
      },
      "verdict": { "code": 0, "reason": "clean" }
    }`) as unknown;

    const parsed = toComparableRun(document, "after.json");

    expect(Object.entries(parsed.coverage.notProbed)).toEqual([
      ["__proto__", 2],
      ["excluded", 1],
    ]);
    // And it survives into what a reader is shown, rather than into a count
    // that no longer adds up against `endpointsProbed`.
    expect(compareRuns(run(), parsed).coverage.reasons).toContainEqual({
      reason: "__proto__",
      before: 0,
      after: 2,
    });
  });

  it("names the file when the document is not a report", () => {
    expect(() => toComparableRun({ hello: "world" }, "before.json")).toThrow(UnreadableReportError);
    expect(() => toComparableRun({ hello: "world" }, "before.json")).toThrow(/before\.json/);
  });

  it("refuses a report whose defects are not defects", () => {
    expect(() => toComparableRun({ ...MINIMAL, defects: [{ key: 7 }] }, "after.json")).toThrow(
      UnreadableReportError,
    );
    expect(() => toComparableRun({ ...MINIMAL, defects: ["orders.list"] }, "after.json")).toThrow(
      /not an object/,
    );
    expect(
      () =>
        toComparableRun(
          { ...MINIMAL, defects: [{ ...FULL_DEFECT, violations: "many" }] },
          "after.json",
        ),
      // The path and not the field name alone: a report with forty defects in it
      // says nothing to a reader who is told only that "violations" is wrong.
    ).toThrow(/"defects\[0\]\.violations" is not a number/);
    expect(() =>
      toComparableRun({ ...MINIMAL, defects: [{ ...FULL_DEFECT, kinds: [7] }] }, "after.json"),
    ).toThrow(/"defects\[0\]\.kinds" holds something that is not a string/);
    expect(() =>
      toComparableRun({ ...MINIMAL, defects: [{ ...FULL_DEFECT, kinds: "one" }] }, "after.json"),
    ).toThrow(/"defects\[0\]\.kinds" is missing or is not an array/);
  });

  /**
   * The three fields a comparison would otherwise read as `undefined` and carry
   * on with: a missing verdict silently becomes a run nothing was said about,
   * a missing `truncated` becomes a complete walk, and a `cellsObserved` that
   * is not a number makes every coverage comparison `NaN` — which compares
   * false against everything and reports a shrunken run as unchanged.
   */
  it("refuses a report whose verdict, coverage or truncation is missing", () => {
    expect(() => toComparableRun({ ...MINIMAL, truncated: "no" }, "a.json")).toThrow(
      /"truncated" is not a boolean/,
    );
    expect(() => toComparableRun({ ...MINIMAL, verdict: "clean" }, "a.json")).toThrow(
      /"verdict" is missing or is not an object/,
    );
    expect(() =>
      toComparableRun(
        { ...MINIMAL, coverage: { ...MINIMAL.coverage, cellsObserved: null } },
        "a.json",
      ),
    ).toThrow(/"coverage\.cellsObserved" is not a number/);
    expect(() =>
      toComparableRun(
        { ...MINIMAL, coverage: { ...MINIMAL.coverage, notProbed: { excluded: "three" } } },
        "a.json",
      ),
    ).toThrow(/"coverage\.notProbed\.excluded" is not a number/);
    expect(() => toComparableRun({ ...MINIMAL, observations: [7] }, "a.json")).toThrow(
      /"observations" holds something that is not an object/,
    );
    expect(() => toComparableRun({ ...MINIMAL, observations: {} }, "a.json")).toThrow(
      /"observations" is missing or is not an array/,
    );
  });

  it("refuses something that is not an object at all", () => {
    expect(() => toComparableRun("[]", "after.json")).toThrow(UnreadableReportError);
    expect(() => toComparableRun(null, "after.json")).toThrow(UnreadableReportError);
    // An array is a JSON object to `typeof` and is not a report.
    expect(() => toComparableRun([], "after.json")).toThrow(/not a JSON object/);
  });
});

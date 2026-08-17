/**
 * The shared module for comparison against a machine-readable oracle.
 *
 * The format is described in ADR-0012. Before it every polygon had a shape and a
 * comparison of its own, there was not a line of shared code, and every next polygon
 * cost as much as the first.
 *
 * It lives outside `src/` because it is tooling for testing the tool itself, not
 * part of the published package: `files` carries the build, the documentation,
 * the examples and the schema, and nothing that only serves to test the tool.
 */

/**
 * The kinds of defect visibility. The rationale for the list — ADR-0012.
 *
 * The first two mean "the tool finds this", the rest say why it does not. The
 * reasons are held apart deliberately: "lives on POST", "the endpoint must not be
 * touched" and "the question is not about the access matrix" are three different
 * gaps with three different ways of closing them, and a single shared `invisible`
 * erased that distinction.
 */
export const VISIBILITIES = [
  /** Visible in the response status. */
  "status",
  /** Visible through an irreversible scalar over the body (ADR-0011). */
  "body-signal",
  /** A difference in the body, but inexpressible by a declared scalar: field values. */
  "body-only",
  /** Lives on a write method: without `--unsafe-methods` the endpoint is not probed. */
  "unsafe-method",
  /** Would be visible, but the endpoint is excluded deliberately: a request breaks the deployment. */
  "excluded",
  /** Outside the area of module 1: the question is not about the "role × endpoint" matrix. */
  "out-of-scope",
];

/** The kinds for which a defect must be detected. */
export const DETECTABLE = ["status", "body-signal"];

export class GroundTruthError extends Error {
  constructor(message) {
    super(message);
    this.name = "GroundTruthError";
  }
}

function requireObject(value, where) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GroundTruthError(`${where}: expected an object`);
  }
  return value;
}

/**
 * Parses and validates the oracle.
 *
 * The checks are not cosmetic. A finding that references a non-existent defect means
 * the oracle has fallen out of sync with its own list of defects — and a
 * verification against it will confirm anything at all.
 */
export function loadGroundTruth(source) {
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (cause) {
    throw new GroundTruthError(`does not parse as JSON: ${cause.message}`);
  }
  requireObject(parsed, "ground truth");

  const defects = requireObject(parsed.defects, "defects");
  for (const [id, defect] of Object.entries(defects)) {
    requireObject(defect, `defects.${id}`);
    if (!VISIBILITIES.includes(defect.visibility)) {
      throw new GroundTruthError(
        `defects.${id}.visibility = ${JSON.stringify(defect.visibility)}; ` +
          `allowed: ${VISIBILITIES.join(", ")}. A defect with no declared visibility ` +
          `cannot be told from a forgotten one: that is why the field is required.`,
      );
    }
  }

  if (!Array.isArray(parsed.variants) || parsed.variants.length === 0) {
    throw new GroundTruthError("variants: expected a non-empty array");
  }

  const seen = new Set();
  for (const variant of parsed.variants) {
    requireObject(variant, "variants[]");
    if (typeof variant.id !== "string" || variant.id === "") {
      throw new GroundTruthError("variants[].id: expected a non-empty string");
    }
    if (seen.has(variant.id)) {
      throw new GroundTruthError(`variant "${variant.id}" is declared more than once`);
    }
    seen.add(variant.id);
    requireObject(variant.selector, `variants.${variant.id}.selector`);
    if (!Number.isInteger(variant.expectedExitCode)) {
      throw new GroundTruthError(`variants.${variant.id}.expectedExitCode: expected an integer`);
    }
    if (!Array.isArray(variant.findings)) {
      throw new GroundTruthError(`variants.${variant.id}.findings: expected an array`);
    }
    for (const finding of variant.findings) {
      requireObject(finding, `variants.${variant.id}.findings[]`);
      if (!Array.isArray(finding.defects) || finding.defects.length === 0) {
        throw new GroundTruthError(
          `variant "${variant.id}": a finding has no defect in its defects field. ` +
            `A finding nothing explains is either a forgotten defect ` +
            `or an error in the ground truth itself.`,
        );
      }
      for (const id of finding.defects) {
        if (!Object.hasOwn(defects, id)) {
          throw new GroundTruthError(
            `variant "${variant.id}": a finding references defect "${id}", ` +
              `which is not in the list. The ground truth is out of sync with itself.`,
          );
        }
      }
    }
  }

  return parsed;
}

/**
 * Checks the oracle for completeness.
 *
 * It answers not the question "did it match" but the question "is everything
 * declared tested at all". A defect declared visible and occurring in no variant is
 * either a forgotten variant or a wrong visibility mark. A defect declared
 * unreachable and yet expected among the findings is a contradiction inside the
 * oracle itself.
 */
export function checkCoverage(groundTruth) {
  const used = new Set();
  for (const variant of groundTruth.variants) {
    for (const finding of variant.findings) {
      for (const id of finding.defects) {
        used.add(id);
      }
    }
  }

  const problems = [];
  for (const [id, defect] of Object.entries(groundTruth.defects)) {
    const detectable = DETECTABLE.includes(defect.visibility);
    if (!detectable && used.has(id)) {
      problems.push(
        `defect "${id}" is declared unreachable (${defect.visibility}) yet expected among findings`,
      );
    }
    if (detectable && !used.has(id)) {
      problems.push(
        `defect "${id}" is declared visible (${defect.visibility}) yet expected in no variant`,
      );
    }
  }
  return problems;
}

/**
 * The key of a cell.
 *
 * It understands both matrix discrepancies and check findings: for the former the
 * third coordinate is the resource, for the latter the second account of the pair,
 * because a defect of a list shows itself not on a resource but on a match between
 * two responses.
 */
export function cellKey(finding) {
  const account = finding.account ?? finding.accountId;
  const endpoint = finding.endpoint ?? finding.endpointId;
  const kind = finding.kind ?? finding.checkId;
  const detail =
    finding.other ??
    finding.evidence?.otherAccountId ??
    finding.resource ??
    finding.resourceId ??
    "—";
  return `${account} × ${endpoint} × ${detail} [${kind}]`;
}

/**
 * The report against itself.
 *
 * The oracle compares **which cells** are broken and is blind to what the report
 * says about them: `cellKey` is built from account, endpoint, kind and resource,
 * so `relation`, `contextId` and the whole of `evidence` take no part in it.
 * A mutation campaign on 14 August gutted all three and the verification stayed
 * green — as did the unit suite. The strongest gate in the project was checking
 * the list of findings and nothing about the document that carries it.
 *
 * These are the invariants that need no ground truth: they hold for any run
 * whatever the platform answered, so they cost nothing to state and catch a
 * regression in the aggregation that leaves the finding list itself correct.
 */
function checkReportConsistency(report) {
  const problems = [];
  const findings = report.findings ?? [];
  const summary = report.summary ?? {};
  const sum = (counts) => Object.values(counts ?? {}).reduce((total, one) => total + one, 0);

  const say = (what, declared, counted) => {
    if (declared !== counted) {
      problems.push(`${what}: the summary says ${declared}, the body has ${counted}`);
    }
  };

  say("findings", summary.findings, findings.length);
  say("observations", summary.observations, (report.observations ?? []).length);
  say("bySeverity totals", sum(summary.bySeverity), findings.length);
  say("byKind totals", sum(summary.byKind), findings.length);
  say(
    "checkFindings",
    summary.checkFindings,
    findings.filter((one) => one.source === "check").length,
  );
  say("defectGroups", summary.defectGroups, (report.defects ?? []).length);
  // Findings that name a cell, because a defect group answers "how many distinct
  // breakages of the platform" and a run-level finding — "this clause is covered
  // by nothing" — is a statement about the run. It is deliberately not grouped
  // (L-4), so the identity is over the ones that are.
  const placed = findings.filter(
    (one) => one.accountId !== undefined && one.endpointId !== undefined,
  );
  say(
    "violations across the defect groups",
    (report.defects ?? []).reduce((total, group) => total + group.violations, 0),
    placed.length,
  );

  // The identity `docs/report.md` offers its reader, asserted where a reader
  // cannot: on every one of the 28 combinations at once. It was documented and
  // untrue for as long as two channels have judged cells — the verdict came from
  // the walk alone, so a cell could be `match: true` and carry a body finding.
  // Kept over cells rather than over `summary.findings`, because one cell can
  // produce several findings.
  const observations = report.observations ?? [];
  const coverage = report.coverage ?? {};
  if (coverage.cellsMatched !== undefined) {
    say(
      "cellsMatched",
      coverage.cellsMatched,
      observations.filter((one) => one.match === true).length,
    );
    say(
      "cellsWithFindings",
      coverage.cellsWithFindings,
      observations.filter((one) => one.findingKinds !== undefined).length,
    );
    if (coverage.cellsMatched + coverage.cellsWithFindings !== coverage.cellsObserved) {
      problems.push(
        `cellsMatched ${coverage.cellsMatched} + cellsWithFindings ` +
          `${coverage.cellsWithFindings} is not cellsObserved ${coverage.cellsObserved}`,
      );
    }
  }

  // A cell listed as agreed while carrying a finding is the contradiction the
  // two numbers above only summarise. Named per cell, because "the arithmetic is
  // off by twelve" does not tell you which twelve.
  const withFinding = new Set(
    findings
      .filter((one) => one.accountId !== undefined && one.endpointId !== undefined)
      .map((one) => `${one.accountId} ${one.endpointId} ${one.resourceId ?? "—"}`),
  );
  for (const one of observations) {
    if (one.match !== true) {
      continue;
    }
    if (withFinding.has(`${one.accountId} ${one.endpointId} ${one.resourceId ?? "—"}`)) {
      problems.push(
        `${one.accountId} × ${one.endpointId} is listed as agreed and appears in the findings`,
      );
    }
  }

  // Every check that ran names the clauses it answers for, and every finding it
  // produced carries them too. `Check.standards` was declared, filled and read by
  // no line of code until 15 August: the word did not occur in a report, so the
  // finding-to-clause traceability the plan promises could not be built from a
  // saved artifact. A gate that does not check this lets it rot back.
  for (const check of coverage.checksRun ?? []) {
    if (typeof check !== "object" || check === null) {
      problems.push(`coverage.checksRun holds a bare id: ${JSON.stringify(check)}`);
      continue;
    }
    if (!Array.isArray(check.standards) || check.standards.length === 0) {
      problems.push(`the check ${check.id} names no clause of any standard`);
    }
    // And says what it asserts, in words. `Check.description` went the same way
    // `standards` had: declared, filled, and dropped by the two-field mapping
    // that built this list — so the reader of a saved artifact got an identifier
    // and a clause number and no sentence to read. Found by the audit of
    // 14 August 2026 (L-8). A gate that does not check this lets it rot back.
    if (typeof check.description !== "string" || check.description === "") {
      problems.push(`the check ${check.id} says nothing about what it asserts`);
    }
  }
  for (const one of findings.filter((f) => f.source === "check")) {
    if (!Array.isArray(one.standards) || one.standards.length === 0) {
      problems.push(`the finding ${one.kind} carries no clause of any standard`);
    }
  }

  // A paired finding names its other side, and the report prints that side's
  // request. Both used to hang off `evidence.otherAccountId` — a convention, not
  // a contract — and when the field moved, nothing here noticed the check had
  // stopped setting it: 28 combinations stayed green while every leak in the
  // report lost the account it leaked to. Found by reverting the file by
  // accident, which is the cheapest way this could have been found.
  for (const one of findings) {
    const pairedInEvidence = typeof one.evidence?.otherAccountId === "string";
    if (pairedInEvidence && one.relatedAccountId === undefined) {
      problems.push(
        `${one.kind} on ${one.accountId} names its pair in evidence but not as a field`,
      );
    }
    if (one.relatedAccountId !== undefined && one.relatedRequest === undefined) {
      problems.push(`${one.kind} on ${one.accountId} names a pair with no request to reproduce it`);
    }
  }

  // Grouping is by the signature "endpoint × kind × relation × conditions", so
  // the two sets of signatures are the same set seen twice. A group that lost
  // `relation`, or a finding that lost `contextId`, shows up here and nowhere
  // else: the finding list stays right, and only the aggregation is wrong.
  const signature = (one) =>
    `${one.endpointId} × ${one.kind} × ${one.relation ?? "—"} × ${one.contextId ?? "—"}`;
  const inFindings = new Set(placed.map(signature));
  const inGroups = new Set((report.defects ?? []).map(signature));
  for (const missing of [...inFindings].filter((one) => !inGroups.has(one)).sort()) {
    problems.push(`no defect group for the signature ${missing}`);
  }
  for (const extra of [...inGroups].filter((one) => !inFindings.has(one)).sort()) {
    problems.push(`a defect group with a signature no finding has: ${extra}`);
  }

  // The conditions are spelled twice — in the account's name and in the field —
  // and a finding that loses the field still reproduces the baseline case, not
  // the one that was found.
  for (const finding of findings) {
    const suffix = String(finding.accountId ?? "").split("@")[1];
    if (suffix !== finding.contextId) {
      problems.push(`finding for ${finding.accountId} says contextId ${finding.contextId ?? "—"}`);
    }
  }

  return problems;
}

/**
 * Compares the tool's report against the variant's expectations.
 *
 * A comparison over sets in both directions: what was missed and what was extra are
 * different errors. The number of findings alone is not enough — it matches when the
 * two cancel each other out as well.
 */
export function compareVariant(variant, report, exitCode) {
  const expected = new Set(variant.findings.map(cellKey));
  // There is one list of findings: the means of detection is the `source` field, not
  // a separate array. The former fallback to `report.checks` rested on a shape of the
  // report that no longer exists, and silently added nothing.
  const actual = new Set(report.findings.map(cellKey));

  const missing = [...expected].filter((key) => !actual.has(key)).sort();
  const unexpected = [...actual].filter((key) => !expected.has(key)).sort();

  const problems = [];
  if (missing.length > 0) {
    problems.push(`not found (${missing.length}):\n    ${missing.join("\n    ")}`);
  }
  if (unexpected.length > 0) {
    problems.push(
      `found beyond the ground truth (${unexpected.length}):\n    ${unexpected.join("\n    ")}`,
    );
  }
  if (exitCode !== variant.expectedExitCode) {
    problems.push(`exit code ${exitCode}, expected ${variant.expectedExitCode}`);
  }
  // The signs of an untrustworthy run: there may be no findings simply because they
  // were never reached.
  if (report.truncated === true) {
    problems.push("the run was cut short, the tail of the matrix was never tested");
  }
  if ((report.unauthenticated ?? []).length > 0) {
    problems.push(`accounts with no access anywhere: ${report.unauthenticated.join(", ")}`);
  }
  if ((report.staleCredentials ?? []).length > 0) {
    problems.push(`credentials went stale mid-run: ${report.staleCredentials.join(", ")}`);
  }
  problems.push(...checkReportConsistency(report));

  return { missing, unexpected, problems };
}

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
 * The shapes this module works with, as JSDoc rather than as a `.d.mts` beside it.
 *
 * There was one: hand-written, outside `tsconfig.include`, and with
 * `skipLibCheck` on nothing compared it to the code below. Tests typed against
 * the declaration while CI ran the implementation, so the two were free to
 * disagree — in the module that decides whether the whole oracle gate passed.
 * Written here, the compiler reads one source for both. Found by the audit of
 * 14 August 2026 (B-13).
 *
 * @typedef {"status" | "body-signal" | "body-only" | "unsafe-method" | "excluded" | "out-of-scope"} Visibility
 *
 * @typedef {object} DefectDeclaration
 * @property {string} [title]
 * @property {Visibility} visibility
 * @property {string} [note]
 *
 * @typedef {object} OracleFinding
 * @property {string} account
 * @property {string} endpoint
 * @property {string | null} [resource]
 * @property {string | null} [other]
 * @property {string} kind
 * @property {readonly string[]} defects the defects that explain this cell; there
 *   may be several, since one defect can be a special case of another and the
 *   shared cell is then explained by both
 *
 * @typedef {object} Variant
 * @property {string} id
 * @property {Readonly<Record<string, unknown>>} selector
 * @property {number} expectedExitCode
 * @property {number} [expectedCells] how many cells the run must probe. Written by
 *   hand like everything else here, and the one number that says the run happened
 *   at all — see the validation below.
 *
 *   Optional, and not because it is optional to care. A polygon whose endpoint
 *   list lives in this repository can state the number and must: `polygon/` and
 *   `polygons/vampi/` do, and `tests/tools/ground-truth-files.test.ts` refuses a
 *   variant of theirs that leaves it out. crAPI's endpoints come from an OpenAPI
 *   document in the crAPI checkout, outside this tree and versioned by somebody
 *   else — the count there is a property of a file this repository does not hold,
 *   and a hand-written constant for it would be a number nobody can maintain.
 *
 *   Made optional on 18 August 2026, after being made mandatory on the 17th
 *   without either external polygon being loaded once: both `ground-truth.json`
 *   files under `polygons/` stopped parsing at the first line, and no test
 *   noticed, because no test opened them
 * @property {readonly OracleFinding[]} findings
 * @property {Readonly<Record<string, string>>} [relations] copied from the root
 *   by `loadGroundTruth`, not written by hand on a variant
 * @property {Readonly<Record<string, string>>} [checkSeverities] likewise
 *
 * @typedef {object} GroundTruth
 * @property {string} [note]
 * @property {string} [cellKey]
 * @property {string} [target]
 * @property {Readonly<Record<string, DefectDeclaration>>} defects
 * @property {readonly Variant[]} variants
 * @property {string} [relationsNote]
 * @property {Readonly<Record<string, string>>} [relations] `"account × resource"`
 *   → the relation the tool must arrive at. Written by hand from the tenant tree;
 *   see `checkRelations` below for why a set of cells is not enough
 * @property {Readonly<Record<string, string>>} [checkSeverities] the severity a
 *   named check must give its findings. A check declares its own, so the table
 *   of ADR-0014 does not reach it
 *
 * @typedef {object} Comparison
 * @property {readonly string[]} missing
 * @property {readonly string[]} unexpected
 * @property {readonly string[]} problems
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

/**
 * The relations a cell can have. The tree and the definitions — ADR-0013.
 *
 * Repeated here rather than imported from `src/core`: this module is the oracle,
 * and an oracle that takes its vocabulary from the program under test cannot
 * disagree with it about a name. The list is short and it is a published API of
 * the tool — a value added to it and not added here fails loudly, which is the
 * intended direction of the failure.
 */
export const RELATIONS = [
  "own",
  "same-tenant",
  "descendant-tenant",
  "ancestor-tenant",
  "foreign-tenant",
];

/**
 * The severity of a matrix discrepancy, by ADR-0014.
 *
 * Hand-transcribed from the ADR rather than imported from `severityOf`, for the
 * reason the whole ground truth is hand-written: a table taken from the code
 * agrees with the code by construction. This one disagrees when the code
 * changes, which is the only way it is worth having.
 *
 * `relation` is undefined on endpoints with no path parameters — there is no
 * resource to stand in relation to — and the ADR gives those the same weight as
 * a discrepancy inside one's own tenant.
 *
 * @param {string} kind
 * @param {string | undefined} relation
 * @returns {string}
 */
export function severityByAdr0014(kind, relation) {
  if (kind === "not-observed" || kind === "probe-error") {
    return "low";
  }
  if (kind === "unexpected-denial") {
    return "medium";
  }
  if (relation === "foreign-tenant") {
    return "critical";
  }
  // Reaching one's own resource where the policy said no is far more often a
  // mistake in the policy than a hole in the platform.
  if (relation === "own") {
    return "medium";
  }
  return "high";
}

export class GroundTruthError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "GroundTruthError";
  }
}

/**
 * @param {unknown} value
 * @param {string} where
 * @returns {Record<string, any>}
 */
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
 *
 * @param {string} source
 * @returns {GroundTruth}
 */
export function loadGroundTruth(source) {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (cause) {
    throw new GroundTruthError(
      `does not parse as JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const root = requireObject(parsed, "ground truth");

  const defects = requireObject(root.defects, "defects");
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

  // The relation table, when a polygon declares one. It is optional because a
  // single-tenant polygon has no relations to declare — VAmPI has no such thing
  // as a foreign tenant at all — and mandatory in substance for one that does:
  // see `tests/tools/polygon-oracle-facts.test.ts`, which requires the reference
  // platform's oracle to declare a relation for every cell its findings name.
  if (root.relations !== undefined) {
    const relations = requireObject(root.relations, "relations");
    for (const [cell, relation] of Object.entries(relations)) {
      if (!RELATIONS.includes(relation)) {
        throw new GroundTruthError(
          `relations["${cell}"] = ${JSON.stringify(relation)}; allowed: ${RELATIONS.join(", ")}`,
        );
      }
    }
  }
  if (root.checkSeverities !== undefined) {
    requireObject(root.checkSeverities, "checkSeverities");
  }

  if (!Array.isArray(root.variants) || root.variants.length === 0) {
    throw new GroundTruthError("variants: expected a non-empty array");
  }

  const seen = new Set();
  for (const variant of root.variants) {
    requireObject(variant, "variants[]");
    if (
      variant.expectedCells !== undefined &&
      (!Number.isInteger(variant.expectedCells) || variant.expectedCells <= 0)
    ) {
      throw new GroundTruthError(
        `variants[].expectedCells: expected a positive integer or nothing at all, got ` +
          `${JSON.stringify(variant.expectedCells)}`,
      );
    }
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
    // The relation table and the checks' severities belong to the platform, not
    // to a combination of flags, so they are declared once at the root — and
    // handed to every variant here, rather than passed to `compareVariant` as
    // one more argument. The reason is the failure this file has already seen
    // twice: a check that reads an argument the caller forgot to pass does not
    // fail, it silently asserts nothing. `assertCanariesUsable` was in that
    // state on 18 August, and its unit test passed throughout. Attached to the
    // variant, the data cannot be left behind by a caller that has the variant.
    variant.relations = root.relations;
    variant.checkSeverities = root.checkSeverities;
  }

  return /** @type {GroundTruth} */ (root);
}

/**
 * Checks the oracle against itself: every defect it declares detectable is named
 * by a finding somewhere, and no defect it declares unreachable is.
 *
 * That is narrower than "is everything declared tested at all", which is what
 * the header claimed until 18 August 2026, and the difference is not academic.
 * Both halves read the **same file**, so an edit that changes both halves at
 * once passes: downgrade one defect to `out-of-scope`, delete the two variants
 * that switched it on, and the gate reports 26 combinations, 0 mismatches and
 * complete coverage. Nothing here counts how many defects the platform has,
 * because nothing here has ever read the platform.
 *
 * The missing half cannot live in this module — it is a claim about a
 * particular deployment, and the shared format knows nothing about how a
 * polygon switches its defects on: this one uses environment variables named
 * exactly like its defect ids, VAmPI a single `vulnerable` flag. It lives in
 * `tests/tools/polygon-oracle-facts.test.ts`, which counts the switches out of
 * `polygon/server.mjs` and requires the oracle to declare each one and to
 * switch each one on in some variant. Together the two make the header's old
 * claim true; apart, this one alone never did.
 */
/**
 * @param {GroundTruth} groundTruth
 * @returns {readonly string[]}
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
 * Who is really asking, with the request conditions stripped off.
 *
 * A row of the matrix is an account under conditions and is named `alice-a@geo-blocked`;
 * the relation is a property of `alice-a`. That is not a convenience of this
 * module, it is a claim of the tool's own — "request conditions do not cancel
 * ownership", written beside `relationOf` — and keying the table by the
 * principal is what puts the claim under test: a `relationOf` that started
 * reading the row instead of the account would answer `foreign-tenant` where the
 * table says `own`.
 *
 * @param {unknown} accountId
 * @returns {string}
 */
function principalOf(accountId) {
  // `?? ""` because `split` is typed as possibly returning nothing at index 0
  // under `noUncheckedIndexedAccess`; it cannot, and an empty principal would
  // simply miss the table and be reported as a cell with no declared relation.
  return String(accountId ?? "").split("@")[0] ?? "";
}

/**
 * @param {Readonly<Record<string, any>> | undefined} table
 * @param {string} key
 * @returns {string | undefined}
 */
function lookup(table, key) {
  return table !== undefined && Object.hasOwn(table, key) ? table[key] : undefined;
}

/**
 * The relation and the weight of every finding, against the hand-written tree.
 *
 * The comparison above is over **sets of cells**, and `cellKey` is built from
 * account, endpoint, kind and resource — so what the report *says* about a cell
 * took no part in it. Adversarial review of 18 August 2026 measured the size of
 * that hole: replace the last `return "foreign-tenant"` in `src/core/tenancy.ts`
 * with `"ancestor-tenant"` and every cross-tenant leak on this platform drops
 * from `critical` to `high` while all 28 combinations still match. The severity
 * was checked only as a sum equal to the number of findings, which that mutation
 * leaves alone; the signature checks compare the report with itself, and agree
 * with themselves whatever the relation is.
 *
 * The relation is deliberately **not** folded into `cellKey`. It would be
 * caught there too, as one missing cell and one unexpected cell per finding —
 * twenty-four lines of that on `all-nine`, none of which says the word
 * `relation`. Named here instead, the mismatch reads as what it is.
 *
 * Both tables are written by hand: `relations` from the tenant tree in
 * `barbican.run.yaml`, `severityByAdr0014` from the ADR. Nothing in either is
 * derived from a run, so the gate cannot agree with itself about them.
 *
 * @param {Variant} variant
 * @param {Readonly<Record<string, any>>} report
 * @returns {string[]}
 */
function checkRelations(variant, report) {
  /** @type {string[]} */
  const problems = [];
  /** @type {any[]} */
  const findings = report.findings ?? [];

  for (const finding of findings) {
    const key = cellKey(finding);

    // A check settles the severity of its own findings (`Check.severity`, and
    // `runChecks` in the registry), so the table of ADR-0014 has no say over
    // them and the ground truth declares theirs by check id.
    if (finding.source === "check") {
      const declared = lookup(variant.checkSeverities, finding.kind);
      if (declared !== undefined && finding.severity !== declared) {
        problems.push(
          `${key}: severity ${finding.severity}, the ground truth declares ${declared}`,
        );
      }
      continue;
    }

    // No resource, no relation — and then the relation is known without a table,
    // so the weight is checkable on any polygon. A relation on a cell that
    // addresses nothing is not a harmless extra field either: the report groups
    // its defects by it, and one would split a group in two.
    if (finding.resourceId === undefined) {
      if (finding.relation !== undefined) {
        problems.push(`${key}: carries relation ${finding.relation} with no resource to relate to`);
      }
      const severity = severityByAdr0014(finding.kind, undefined);
      if (finding.severity !== severity) {
        problems.push(
          `${key}: severity ${finding.severity}, ADR-0014 gives ${severity} for ${finding.kind}`,
        );
      }
      continue;
    }

    // A polygon that declares no relations makes no claim about them, and this
    // says nothing rather than guessing: a single-tenant deployment has no
    // relations to state, and computing the weight as though the relation were
    // absent would be wrong for a cell that has one.
    if (variant.relations === undefined) {
      continue;
    }

    const declared = lookup(
      variant.relations,
      `${principalOf(finding.accountId)} × ${finding.resourceId}`,
    );
    if (declared === undefined) {
      problems.push(
        `${key}: the ground truth declares no relation for this cell — ` +
          `a finding whose relation nothing states is one the gate cannot weigh`,
      );
      continue;
    }
    if (finding.relation !== declared) {
      problems.push(
        `${key}: relation ${finding.relation ?? "—"}, the ground truth declares ${declared}`,
      );
    }
    // From the declared relation, never from the reported one: computing the
    // expected severity out of the value under test is how a check comes to
    // agree with whatever it is handed.
    const severity = severityByAdr0014(finding.kind, declared);
    if (finding.severity !== severity) {
      problems.push(
        `${key}: severity ${finding.severity}, ADR-0014 gives ${severity} ` +
          `for ${finding.kind} on ${declared}`,
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
/**
 * @param {Readonly<Record<string, any>>} finding
 * @returns {string}
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
/**
 * @param {Readonly<Record<string, any>>} report
 * @returns {string[]}
 */
function checkReportConsistency(report) {
  /** @type {string[]} */
  const problems = [];
  /** @type {any[]} */
  const findings = report.findings ?? [];
  /** @type {Record<string, any>} */
  const summary = report.summary ?? {};
  /** @param {Record<string, number> | undefined} counts */
  const sum = (counts) => Object.values(counts ?? {}).reduce((total, one) => total + one, 0);

  /**
   * @param {string} what
   * @param {unknown} declared
   * @param {unknown} counted
   */
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
  /** @type {any[]} */
  const groups = report.defects ?? [];
  say("defectGroups", summary.defectGroups, groups.length);
  // Findings that name a cell, because a defect group answers "how many distinct
  // breakages of the platform" and a run-level finding — "this clause is covered
  // by nothing" — is a statement about the run. It is deliberately not grouped
  // (L-4), so the identity is over the ones that are.
  const placed = findings.filter(
    (one) => one.accountId !== undefined && one.endpointId !== undefined,
  );
  say(
    "violations across the defect groups",
    groups.reduce((total, group) => total + group.violations, 0),
    placed.length,
  );

  // The identity `docs/report.md` offers its reader, asserted where a reader
  // cannot: on every one of the 28 combinations at once. It was documented and
  // untrue for as long as two channels have judged cells — the verdict came from
  // the walk alone, so a cell could be `match: true` and carry a body finding.
  // Kept over cells rather than over `summary.findings`, because one cell can
  // produce several findings.
  /** @type {any[]} */
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

  // Grouping is by the signature "endpoint × relation × conditions", so the two
  // sets of signatures are the same set seen twice. A group that lost `relation`,
  // or a finding that lost `contextId`, shows up here and nowhere else: the
  // finding list stays right, and only the aggregation is wrong.
  //
  // The kind is not in it since 17 August 2026 (B-6, ADR-0030): it says how a
  // defect was noticed rather than what it is, and an endpoint with no
  // authorization at all is noticed twice. It is checked below instead — every
  // kind a finding carries has to appear in its group's `kinds`, and every name
  // in `kinds` has to come from a finding.
  /** @param {Record<string, any>} one */
  const signature = (one) => `${one.endpointId} × ${one.relation ?? "—"} × ${one.contextId ?? "—"}`;
  const inFindings = new Set(placed.map(signature));
  const inGroups = new Set(groups.map(signature));
  for (const missing of [...inFindings].filter((one) => !inGroups.has(one)).sort()) {
    problems.push(`no defect group for the signature ${missing}`);
  }
  for (const extra of [...inGroups].filter((one) => !inFindings.has(one)).sort()) {
    problems.push(`a defect group with a signature no finding has: ${extra}`);
  }

  // And the kinds are carried, not dropped. Merging the channels is only right if
  // nothing is lost by it: the group has to name every way its cells were found
  // to be broken, and to invent none.
  const kindsPerSignature = new Map();
  for (const one of placed) {
    const key = signature(one);
    if (!kindsPerSignature.has(key)) {
      kindsPerSignature.set(key, new Set());
    }
    kindsPerSignature.get(key).add(one.kind);
  }
  for (const group of report.defects ?? []) {
    const expected = [...(kindsPerSignature.get(signature(group)) ?? [])].sort();
    const actual = [...(group.kinds ?? [])].sort();
    if (expected.join(",") !== actual.join(",")) {
      problems.push(
        `the defect group ${group.key} names the kinds ${actual.join(", ") || "—"} ` +
          `while its findings carry ${expected.join(", ") || "—"}`,
      );
    }
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
/**
 * @param {Variant} variant
 * @param {Readonly<Record<string, any>>} report
 * @param {number} exitCode
 * @returns {Comparison}
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
  // How many cells the run actually probed.
  //
  // Everything above compares **sets of cells a finding is expected on**, and a
  // cell nobody expects a finding on is therefore outside the comparison
  // entirely. The ground truth never names the anonymous account, `health`,
  // `affiliate.stats` or the accounts under `wide-scope` — some 34 of 144 cells —
  // so a change that stops probing them is invisible here by construction.
  //
  // Demonstrated on 18 August 2026 by adversarial review: one line dropping the
  // anonymous account from every run leaves `tsc` clean, 859 tests green, and
  // this gate reporting 28 combinations and 0 mismatches, with the matrix down
  // from 144 cells to 128. The account whose whole purpose is the claim "this
  // endpoint is not public" simply stopped being asked, and the strongest gate
  // this project has said nothing.
  //
  // A number per variant, written by hand like every other fixture here: it is
  // not derived from a run, so a run cannot agree with itself about it.
  const probed = (report.observations ?? []).length;
  if (variant.expectedCells !== undefined && probed !== variant.expectedCells) {
    problems.push(
      `probed ${probed} cells, expected ${variant.expectedCells} — the matrix ` +
        `changed size, and a comparison of findings cannot see that`,
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
  problems.push(...checkRelations(variant, report));
  problems.push(...checkReportConsistency(report));

  return { missing, unexpected, problems };
}

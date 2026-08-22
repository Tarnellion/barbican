/**
 * Comparing two saved reports.
 *
 * Both halves of the two questions a second run is made to answer were already
 * in the file, and nothing read either. `configDigest` exists "to tell 'the
 * platform changed' from 'we changed the declaration'" — `docs/report.md` says
 * so — and `defects[].key` was made readable and stable between runs
 * specifically so that a ticket could cite it. Meanwhile there was no
 * subcommand, no section in the documentation, and a plain `diff` of two report
 * files answers nothing: `runId`, `startedAt`, `finishedAt`, the `at` and
 * `durationMs` of every observation and every `signals.digest` differ on two
 * runs of one matrix against one platform, because the digest salt is drawn per
 * run. Found as M-17; see ADR-0050.
 *
 * Three things this module is built around, and each of them is a way the
 * obvious implementation lies:
 *
 * 1. **The declaration comes first.** Comparing two runs made under different
 *    declarations is legitimate and often the point — but half the differences
 *    may then be the reader's own edit, and a reader who is not told that reads
 *    an edit as a regression.
 * 2. **The unit is the defect, not the finding row.** One defect is fifty rows
 *    or one, depending on the evidence budget of ADR-0029 and on how many cells
 *    the matrix has; a difference in row counts is news about the run's shape,
 *    not about the platform. `defects[].key` is the identity that survives.
 * 3. **A difference in coverage is a difference.** A run that probed twelve
 *    cells where yesterday's probed a hundred and forty-four did not fix
 *    anything, and every defect missing from it is missing because nothing went
 *    looking. The gone half of the comparison is worthless without it.
 *
 * Pure, like the rest of what a report is built from: the CLI reads the files
 * and this decides what the pair means.
 */

import type { ResourceRelation } from "../core/index.js";
import { SEVERITY_ORDER } from "../core/index.js";
import { byCodeUnits } from "../core/order.js";
import { lookup, openRecord } from "../io/untrusted.js";
import { REPORT_SCHEMA_VERSION } from "./build.js";

/**
 * The version of this comparison's own shape, for `--json`.
 *
 * The report has one for the reason stated on `RunReport.schemaVersion`, and a
 * second machine-readable artifact published by the same tool gets the same
 * courtesy: without it a parser breaks silently at the first change of
 * structure.
 */
export const COMPARISON_SCHEMA_VERSION = "1";

/**
 * A defect group, as much of one as a comparison reads.
 *
 * `DefectGroup` from the core satisfies this, which is what makes a `RunReport`
 * usable here without a conversion. It is restated narrowly rather than
 * imported because the other side of this module is a **file**: a saved report
 * is parsed from JSON and is not a `DefectGroup` until something has checked
 * it, and a type that promised more than `toComparableRun` verifies would be a
 * promise made by a cast.
 *
 * `severity` is a plain string for the same reason. Every `Severity` is one, so
 * the report's own type fits; a file carrying a sixth level, or a nonsense one,
 * is displayed rather than made to stop the comparison — nothing here decides
 * anything by severity except the order two lists are printed in.
 */
export interface ComparableDefect {
  readonly key: string;
  readonly endpointId: string;
  readonly kinds: readonly string[];
  readonly severity: string;
  readonly accountIds: readonly string[];
  readonly resourceIds: readonly string[];
  readonly violations: number;
  readonly contextId?: string;
  readonly relation?: ResourceRelation;
  readonly acceptedKinds?: readonly string[];
}

/**
 * What a comparison reads out of a run.
 *
 * A `RunReport` is assignable to it. Everything else in the report is left
 * alone on purpose: a comparison that read the observation rows would be
 * comparing the timestamps and the per-run digest salt, which is the useless
 * `diff` this subcommand exists to replace. The one thing taken from
 * `observations` is which endpoints were asked about at all, because that is
 * what separates "fixed" from "not looked at".
 */
export interface ComparableRun {
  readonly schemaVersion: string;
  readonly runId: string;
  readonly configDigest: string;
  readonly startedAt: string;
  readonly truncated: boolean;
  readonly target: { readonly baseUrl: string; readonly label?: string };
  readonly defects: readonly ComparableDefect[];
  readonly observations: readonly { readonly endpointId: string }[];
  readonly coverage: {
    readonly endpointsTotal: number;
    readonly endpointsProbed: number;
    readonly cellsObserved: number;
    /** Why endpoints were not probed, by reason. A key space this tool owns only in part. */
    readonly notProbed: Readonly<Record<string, number>>;
  };
  readonly verdict: { readonly code: number; readonly reason: string };
}

/** One run, as much of its identity as the screen prints. */
export interface ComparedRun {
  readonly runId: string;
  readonly startedAt: string;
  readonly baseUrl: string;
  readonly label?: string;
  readonly truncated: boolean;
  readonly verdict: { readonly code: number; readonly reason: string };
}

/**
 * A reason the comparison cannot be believed.
 *
 * Kept apart from the differences, because they answer different questions and
 * the exit code is made of these: a difference is news about the platform, a
 * blocker is a statement that the news cannot be relied on. The same line
 * `runVerdict` draws between 1 and 2, drawn again one level up.
 */
export type BlockerKind =
  | "schema-differs"
  | "schema-unreadable"
  | "same-run"
  | "truncated"
  | "untrusted-run"
  | "coverage-shrank";

export interface ComparisonBlocker {
  readonly kind: BlockerKind;
  readonly detail: string;
}

export interface DeclarationDifference {
  readonly changed: boolean;
  readonly before: string;
  readonly after: string;
}

/** One reason endpoints went unprobed, on both sides. */
export interface NotProbedReason {
  readonly reason: string;
  readonly before: number;
  readonly after: number;
}

export interface CoverageDifference {
  readonly cellsBefore: number;
  readonly cellsAfter: number;
  readonly endpointsProbedBefore: number;
  readonly endpointsProbedAfter: number;
  readonly endpointsTotalBefore: number;
  readonly endpointsTotalAfter: number;
  /** Endpoints the first run asked about and the second did not. */
  readonly noLongerProbed: readonly string[];
  readonly newlyProbed: readonly string[];
  readonly reasons: readonly NotProbedReason[];
  /** The second run looked at less. Every disappearance below is then unexplained. */
  readonly shrank: boolean;
  readonly changed: boolean;
}

/**
 * A defect present in one run and not the other, with the one fact that decides
 * how to read it: whether the other run probed its endpoint at all.
 *
 * `false` on a disappearance means nothing was fixed, because nothing was
 * looked at. `false` on an appearance means the opposite reassurance — this may
 * be surface that was newly covered rather than newly broken.
 */
export interface DefectAppearance {
  readonly defect: ComparableDefect;
  readonly otherRunProbedEndpoint: boolean;
}

/** The axes along which one defect is said to have changed. */
export type DefectAxis = "kinds" | "severity" | "acceptance";

export interface DefectChange {
  readonly axis: DefectAxis;
  readonly before: string;
  readonly after: string;
}

export interface ChangedDefect {
  readonly key: string;
  readonly before: ComparableDefect;
  readonly after: ComparableDefect;
  readonly changes: readonly DefectChange[];
}

export interface DefectDifference {
  readonly gone: readonly DefectAppearance[];
  readonly appeared: readonly DefectAppearance[];
  readonly changed: readonly ChangedDefect[];
  /** Defects present in both, along every axis this compares. A count: they are not news. */
  readonly unchanged: number;
}

export interface RunComparison {
  readonly schemaVersion: string;
  readonly before: ComparedRun;
  readonly after: ComparedRun;
  /**
   * Whether the two files could be read against each other at all.
   *
   * `false` only for a difference of shape, where every field below would be a
   * comparison of things that are not the same field. The coverage and defect
   * sections are then empty rather than absent, so a consumer reads one shape.
   */
  readonly compared: boolean;
  readonly declaration: DeclarationDifference;
  readonly blockers: readonly ComparisonBlocker[];
  readonly coverage: CoverageDifference;
  readonly defects: DefectDifference;
  readonly verdict: { readonly code: number; readonly reason: string };
}

/**
 * A file that is not a report this tool can compare.
 *
 * Public, like the rest of this package's error classes: telling a mistyped
 * path from a report of another vintage is something a consumer has to be able
 * to do in a `catch`, and `instanceof` needs the class.
 */
export class UnreadableReportError extends Error {
  override readonly name = "UnreadableReportError";
  constructor(source: string, why: string) {
    super(
      `${source} is not a barbican report this tool can compare: ${why}. ` +
        `Both arguments are report files written by \`barbican run --report\`.`,
    );
  }
}

/** Severity as a sort key over a string that came out of a file. */
function severityRank(severity: string): number {
  // `lookup` and not `SEVERITY_ORDER[severity]`. The table is an object
  // literal, so indexing it with a name out of a document answers for
  // `constructor` with a function — and a rank that is a function makes every
  // subtraction below `NaN`, which turns a sort comparator into an
  // implementation-defined shuffle. ADR-0024, on the reading side.
  return (
    lookup(SEVERITY_ORDER as Readonly<Record<string, number>>, severity) ?? Number.MAX_SAFE_INTEGER
  );
}

/** Worst first, then by the citable key: one order on every machine (ADR-0036). */
function worstFirst(left: ComparableDefect, right: ComparableDefect): number {
  return (
    severityRank(left.severity) - severityRank(right.severity) || byCodeUnits(left.key, right.key)
  );
}

/** The endpoints a run actually asked about — not the ones it was given. */
function probedEndpoints(run: ComparableRun): ReadonlySet<string> {
  return new Set(run.observations.map((observation) => observation.endpointId));
}

/**
 * The two lists of skip reasons, side by side.
 *
 * A `Map` keyed by the reason and not an object: the keys are the runner's
 * vocabulary as a **saved file** spells it, which is a key space this module
 * did not choose, and an object literal drops an assignment to `__proto__` on
 * the floor rather than storing it. The record handed back to `--json` is built
 * with `openRecord` for the same reason. See ADR-0024.
 */
function compareNotProbed(
  before: Readonly<Record<string, number>>,
  after: Readonly<Record<string, number>>,
): readonly NotProbedReason[] {
  const reasons = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort(byCodeUnits);
  return reasons.map((reason) => ({
    reason,
    before: lookup(before, reason) ?? 0,
    after: lookup(after, reason) ?? 0,
  }));
}

function compareCoverage(before: ComparableRun, after: ComparableRun): CoverageDifference {
  const probedBefore = probedEndpoints(before);
  const probedAfter = probedEndpoints(after);
  const noLongerProbed = [...probedBefore].filter((id) => !probedAfter.has(id)).sort(byCodeUnits);
  const newlyProbed = [...probedAfter].filter((id) => !probedBefore.has(id)).sort(byCodeUnits);
  // Two ways of looking at less, and the endpoint set is the one the defect
  // attribution below rests on. Cells alone would miss a run that swapped one
  // endpoint for another; endpoints alone would miss a run that dropped every
  // resource and kept the endpoint list.
  const shrank =
    after.coverage.cellsObserved < before.coverage.cellsObserved || noLongerProbed.length > 0;
  return {
    cellsBefore: before.coverage.cellsObserved,
    cellsAfter: after.coverage.cellsObserved,
    endpointsProbedBefore: before.coverage.endpointsProbed,
    endpointsProbedAfter: after.coverage.endpointsProbed,
    endpointsTotalBefore: before.coverage.endpointsTotal,
    endpointsTotalAfter: after.coverage.endpointsTotal,
    noLongerProbed,
    newlyProbed,
    reasons: compareNotProbed(before.coverage.notProbed, after.coverage.notProbed),
    shrank,
    changed:
      shrank ||
      newlyProbed.length > 0 ||
      after.coverage.cellsObserved !== before.coverage.cellsObserved ||
      after.coverage.endpointsProbed !== before.coverage.endpointsProbed,
  };
}

/** The kinds an acceptance holds, as one comparable phrase. */
function acceptedPhrase(defect: ComparableDefect): string {
  const kinds = [...(defect.acceptedKinds ?? [])].sort(byCodeUnits);
  return kinds.length === 0 ? "none" : kinds.join(", ");
}

/**
 * What changed about one defect that is in both runs.
 *
 * Three axes, and `violations` is deliberately not one of them. It counts the
 * cells a defect touched, which moves when an account or a resource is added to
 * the declaration and when the evidence budget of ADR-0029 bites — neither is
 * news about the platform, and a comparison that reported them would be loud on
 * every run and useful on none.
 *
 * `accountIds` and `resourceIds` are left out for the same reason and one more:
 * the accounts a defect was seen from are a property of the matrix that was
 * walked. Widen the run by one role and every defect in the file "changes".
 */
function changesOn(before: ComparableDefect, after: ComparableDefect): readonly DefectChange[] {
  const changes: DefectChange[] = [];
  const kindsBefore = [...before.kinds].sort(byCodeUnits).join(", ");
  const kindsAfter = [...after.kinds].sort(byCodeUnits).join(", ");
  if (kindsBefore !== kindsAfter) {
    changes.push({ axis: "kinds", before: kindsBefore, after: kindsAfter });
  }
  if (before.severity !== after.severity) {
    changes.push({ axis: "severity", before: before.severity, after: after.severity });
  }
  // An acceptance appearing is the case this whole subcommand is sharpest on: a
  // defect that stopped failing the build because somebody signed for it looks,
  // to every counter above it and to the exit code beside it, exactly like a
  // platform that was fixed. ADR-0048 keeps the row; this keeps the difference.
  const acceptedBefore = acceptedPhrase(before);
  const acceptedAfter = acceptedPhrase(after);
  if (acceptedBefore !== acceptedAfter) {
    changes.push({ axis: "acceptance", before: acceptedBefore, after: acceptedAfter });
  }
  return changes;
}

function compareDefects(before: ComparableRun, after: ComparableRun): DefectDifference {
  // A `Map` keyed by `defects[].key`, which is built out of an endpoint id —
  // a name that came from an OpenAPI document, an endpoint list or a Postman
  // collection, and so a name this tool did not choose. See ADR-0024.
  const beforeByKey = new Map(before.defects.map((one) => [one.key, one]));
  const afterByKey = new Map(after.defects.map((one) => [one.key, one]));
  const probedBefore = probedEndpoints(before);
  const probedAfter = probedEndpoints(after);

  const gone: DefectAppearance[] = [];
  const changed: ChangedDefect[] = [];
  let unchanged = 0;
  for (const [key, defect] of beforeByKey) {
    const twin = afterByKey.get(key);
    if (twin === undefined) {
      gone.push({ defect, otherRunProbedEndpoint: probedAfter.has(defect.endpointId) });
      continue;
    }
    const changes = changesOn(defect, twin);
    if (changes.length === 0) {
      unchanged += 1;
    } else {
      changed.push({ key, before: defect, after: twin, changes });
    }
  }

  const appeared: DefectAppearance[] = [];
  for (const [key, defect] of afterByKey) {
    if (!beforeByKey.has(key)) {
      appeared.push({ defect, otherRunProbedEndpoint: probedBefore.has(defect.endpointId) });
    }
  }

  return {
    gone: gone.sort((left, right) => worstFirst(left.defect, right.defect)),
    appeared: appeared.sort((left, right) => worstFirst(left.defect, right.defect)),
    changed: changed.sort((left, right) => worstFirst(left.after, right.after)),
    unchanged,
  };
}

function identityOf(run: ComparableRun): ComparedRun {
  return {
    runId: run.runId,
    startedAt: run.startedAt,
    baseUrl: run.target.baseUrl,
    ...(run.target.label === undefined ? {} : { label: run.target.label }),
    truncated: run.truncated,
    verdict: run.verdict,
  };
}

const NOTHING: DefectDifference = { gone: [], appeared: [], changed: [], unchanged: 0 };

/** What the coverage section says when nothing was compared. */
function noCoverage(before: ComparableRun, after: ComparableRun): CoverageDifference {
  return {
    cellsBefore: before.coverage.cellsObserved,
    cellsAfter: after.coverage.cellsObserved,
    endpointsProbedBefore: before.coverage.endpointsProbed,
    endpointsProbedAfter: after.coverage.endpointsProbed,
    endpointsTotalBefore: before.coverage.endpointsTotal,
    endpointsTotalAfter: after.coverage.endpointsTotal,
    noLongerProbed: [],
    newlyProbed: [],
    reasons: [],
    shrank: false,
    changed: false,
  };
}

/**
 * The shapes that stop a comparison before it starts.
 *
 * Two of them and not one. Different `schemaVersion`s mean the fields do not
 * line up — `coverage.bodyComparison` became `coverage.byCheck`, `checksRun`
 * changed what its entries hold — so a field-by-field reading would be
 * comparing things that are not the same thing. Two files of one version this
 * build does not know is the other case: they line up with each other and not
 * with anything here, and guessing is how a reader gets a confident answer
 * about fields that were never read.
 */
function shapeBlockers(before: ComparableRun, after: ComparableRun): readonly ComparisonBlocker[] {
  if (before.schemaVersion !== after.schemaVersion) {
    return [
      {
        kind: "schema-differs",
        detail:
          `the two files are of different shapes: schemaVersion ${before.schemaVersion} and ` +
          `${after.schemaVersion}. A field-by-field reading would compare fields that moved ` +
          `between the two, so nothing was compared. Re-run the older configuration with this ` +
          `build and compare the two reports it writes`,
      },
    ];
  }
  if (before.schemaVersion !== REPORT_SCHEMA_VERSION) {
    return [
      {
        kind: "schema-unreadable",
        detail:
          `both files are schemaVersion ${before.schemaVersion} and this build reads ` +
          `${REPORT_SCHEMA_VERSION}. They agree with each other and not with anything here, ` +
          `and a comparison that guessed at the difference would answer confidently about ` +
          `fields it never read`,
      },
    ];
  }
  return [];
}

/**
 * Everything that makes a comparison untrustworthy without making it impossible.
 *
 * All of them are collected rather than the first one returned: a run may be
 * both truncated and narrower than the one before it, and an operator told only
 * the first reason fixes it and meets the second.
 */
function trustBlockers(
  before: ComparableRun,
  after: ComparableRun,
  coverage: CoverageDifference,
): readonly ComparisonBlocker[] {
  const blockers: ComparisonBlocker[] = [];
  // The most expensive false clean this subcommand can produce: every
  // difference is zero by construction, and an empty comparison is exactly the
  // shape of "nothing changed since yesterday".
  if (before.runId === after.runId) {
    blockers.push({
      kind: "same-run",
      detail:
        `both files record the same run, ${before.runId}. Every difference below is zero ` +
        `because there is only one run here, which reads exactly like "nothing changed"`,
    });
  }
  for (const [side, run] of [
    ["first", before],
    ["second", after],
  ] as const) {
    if (run.truncated) {
      blockers.push({
        kind: "truncated",
        detail:
          `the ${side} run was cut short and never reached the end of its matrix, so this ` +
          `comparison is honest only as "here is what was looked at". What is missing from ` +
          `that run is missing from the walk, not from the platform`,
      });
    }
  }
  for (const [side, run] of [
    ["first", before],
    ["second", after],
  ] as const) {
    // Truncation already said its piece above; a run has one verdict and this
    // must not print the same fact twice under two names.
    if (run.verdict.code === 2 && !run.truncated) {
      blockers.push({
        kind: "untrusted-run",
        detail:
          `the ${side} run could not be trusted on its own terms — it exited 2: ` +
          `${run.verdict.reason}. A comparison cannot be steadier than the runs it is made of`,
      });
    }
  }
  if (coverage.shrank) {
    blockers.push({
      kind: "coverage-shrank",
      detail:
        `the second run looked at less than the first: ${coverage.cellsBefore} cells against ` +
        `${coverage.cellsAfter}` +
        (coverage.noLongerProbed.length === 0
          ? ""
          : `, and ${coverage.noLongerProbed.length} ` +
            `${coverage.noLongerProbed.length === 1 ? "endpoint" : "endpoints"} it never asked ` +
            `about at all`) +
        `. A defect gone from a run that did not go looking for it was not fixed`,
    });
  }
  return blockers;
}

/**
 * Two saved reports, read against each other.
 *
 * Nothing here touches a clock, a file or the network: the pair is the whole
 * input, which is what makes the awkward cases — a truncated run, a run against
 * itself, two shapes that do not line up — testable at all.
 */
export function compareRuns(before: ComparableRun, after: ComparableRun): RunComparison {
  const declaration: DeclarationDifference = {
    changed: before.configDigest !== after.configDigest,
    before: before.configDigest,
    after: after.configDigest,
  };
  const shape = shapeBlockers(before, after);
  if (shape.length > 0) {
    return {
      schemaVersion: COMPARISON_SCHEMA_VERSION,
      before: identityOf(before),
      after: identityOf(after),
      compared: false,
      declaration,
      blockers: shape,
      coverage: noCoverage(before, after),
      defects: NOTHING,
      verdict: { code: 2, reason: verdictReason(2, shape, noCoverage(before, after), NOTHING) },
    };
  }

  const coverage = compareCoverage(before, after);
  const defects = compareDefects(before, after);
  const blockers = trustBlockers(before, after, coverage);
  const differs =
    coverage.changed ||
    defects.gone.length > 0 ||
    defects.appeared.length > 0 ||
    defects.changed.length > 0;
  // 2 outranks 1 here for the reason it does in `runVerdict`: what cannot be
  // trusted is never clean, and a comparison of runs that cannot be trusted is
  // one of those. A changed declaration is deliberately not in this arithmetic
  // — it is a caveat over the reading, not a difference in it.
  const code = blockers.length > 0 ? 2 : differs ? 1 : 0;
  return {
    schemaVersion: COMPARISON_SCHEMA_VERSION,
    before: identityOf(before),
    after: identityOf(after),
    compared: true,
    declaration,
    blockers,
    coverage,
    defects,
    verdict: { code, reason: verdictReason(code, blockers, coverage, defects) },
  };
}

/** The sentence beside the code, for the reader who has only the exit status. */
function verdictReason(
  code: number,
  blockers: readonly ComparisonBlocker[],
  coverage: CoverageDifference,
  defects: DefectDifference,
): string {
  if (code === 2) {
    return `this comparison cannot be trusted: ${blockers.map((one) => one.detail).join("; ")}`;
  }
  if (code === 0) {
    return "the same defects, over the same surface";
  }
  const parts = [
    defects.appeared.length > 0 ? `${defects.appeared.length} new` : undefined,
    defects.gone.length > 0 ? `${defects.gone.length} gone` : undefined,
    defects.changed.length > 0 ? `${defects.changed.length} changed` : undefined,
    coverage.changed ? "the surface probed is not the same" : undefined,
  ].filter((one) => one !== undefined);
  return `the two runs do not describe the same platform: ${parts.join(", ")}`;
}

/** How loudly a line is meant to be said. The colour itself is the CLI's business. */
export type ComparisonTone = "plain" | "good" | "warn" | "bad";

export interface ComparisonLine {
  readonly text: string;
  readonly tone: ComparisonTone;
}

/** A digest is 64 hex characters; a screen needs enough of one to tell two apart. */
function shortDigest(digest: string): string {
  return digest.length <= 16 ? digest : `${digest.slice(0, 16)}…`;
}

/**
 * One defect on one line: what it is, how bad, and how much of the matrix it
 * touched.
 *
 * The cell count is printed and compared by nothing — see `changesOn`. It is
 * here because a reader deciding which of nine new defects to open first wants
 * the size of each, and it is stated in the past tense on a disappearance so
 * that the number is not read as a claim about the second run.
 */
function defectLine(defect: ComparableDefect, tense: "is" | "was"): string {
  return (
    `  ${defect.key} — ${tense === "was" ? "was " : ""}` +
    `${[...defect.kinds].sort(byCodeUnits).join(", ")}, ${defect.severity}, ` +
    `${defect.violations} ${defect.violations === 1 ? "cell" : "cells"}`
  );
}

/**
 * The comparison as an operator reads it.
 *
 * The order is the argument: the declaration before anything derived from it,
 * then what was looked at, then what was found, then the code CI acts on. A
 * reader who stops after the first paragraph has stopped at the caveat that
 * governs everything below it, which is the one place stopping early is safe.
 *
 * The sentences live here rather than in `src/cli.ts` so that they can be
 * asserted without a subprocess, and the tone rather than the colour so that
 * the decision about escape codes stays with the thing that knows whether there
 * is a terminal. That split is `WARNINGS` and `WARNING_STYLE` again, and the
 * reason is the four days those two spent disagreeing.
 */
export function renderComparison(comparison: RunComparison): readonly ComparisonLine[] {
  const lines: ComparisonLine[] = [];
  const say = (text: string, tone: ComparisonTone = "plain"): void => {
    lines.push({ text, tone });
  };

  const name = (identity: ComparedRun): string =>
    `run ${identity.runId} started ${identity.startedAt}` +
    (identity.label === undefined ? ` at ${identity.baseUrl}` : ` against ${identity.label}`);
  say(`before: ${name(comparison.before)}`);
  say(`after:  ${name(comparison.after)}`);

  // Two positional arguments the wrong way round invert every conclusion below:
  // what was fixed reads as broken and back. Said rather than refused — running
  // a comparison backwards on purpose is a fair thing to want.
  if (comparison.after.startedAt < comparison.before.startedAt) {
    say(
      `The second report is older than the first. Every "new" below is something that went ` +
        `away and every "gone" is something that appeared — swap the two arguments, or read ` +
        `it inverted on purpose.`,
      "warn",
    );
  }

  // First, before coverage and before a single defect. Half of what follows may
  // be the reader's own edit, and a reader who is not told that reads an edit as
  // a regression.
  if (comparison.declaration.changed) {
    say(
      `The declaration changed between these runs: configDigest ` +
        `${shortDigest(comparison.declaration.before)} → ` +
        `${shortDigest(comparison.declaration.after)}. Part of what follows may be your own ` +
        `edit rather than the platform's doing.`,
      "warn",
    );
  } else {
    say(
      `The declaration is the same in both runs (configDigest ` +
        `${shortDigest(comparison.declaration.before)}), so what follows is about the platform.`,
    );
  }

  if (!comparison.compared) {
    for (const blocker of comparison.blockers) {
      say(`Nothing was compared: ${blocker.detail}.`, "bad");
    }
    say(`Exit code ${comparison.verdict.code}: ${comparison.verdict.reason}`, "bad");
    return lines;
  }

  const coverage = comparison.coverage;
  const surface = (probed: number, total: number, cells: number): string =>
    `${cells} ${cells === 1 ? "cell" : "cells"} over ${probed} of ${total} endpoints`;
  const both =
    `${surface(coverage.endpointsProbedBefore, coverage.endpointsTotalBefore, coverage.cellsBefore)}` +
    ` → ${surface(coverage.endpointsProbedAfter, coverage.endpointsTotalAfter, coverage.cellsAfter)}`;
  if (coverage.shrank) {
    say(`Coverage shrank: ${both}.`, "bad");
  } else if (coverage.changed) {
    say(`Coverage grew: ${both}.`, "good");
  } else {
    // The same surface twice reads as a mistake in the tool; said once, and
    // said out loud rather than left out, because "the same" is the fact that
    // makes every disappearance below a fix.
    say(
      `Coverage: ${surface(coverage.endpointsProbedAfter, coverage.endpointsTotalAfter, coverage.cellsAfter)}, unchanged.`,
    );
  }
  if (coverage.noLongerProbed.length > 0) {
    say(`  no longer probed: ${coverage.noLongerProbed.join(", ")}`, "bad");
  }
  if (coverage.newlyProbed.length > 0) {
    say(`  probed for the first time: ${coverage.newlyProbed.join(", ")}`, "good");
  }
  for (const reason of coverage.reasons) {
    if (reason.before !== reason.after) {
      say(`  endpoints skipped as "${reason.reason}": ${reason.before} → ${reason.after}`);
    }
  }
  if (coverage.shrank) {
    say(
      `A defect gone from a run that did not go looking for it was not fixed. Read the ` +
        `disappearances below against this line.`,
      "bad",
    );
  }

  const defects = comparison.defects;
  const total = (side: "before" | "after"): number =>
    defects.unchanged +
    defects.changed.length +
    (side === "before" ? defects.gone.length : defects.appeared.length);
  say(
    `Defects: ${total("before")} → ${total("after")} — ${defects.appeared.length} new, ` +
      `${defects.gone.length} gone, ${defects.changed.length} changed, ` +
      `${defects.unchanged} unchanged.`,
    defects.appeared.length > 0 ? "bad" : "plain",
  );

  if (defects.appeared.length > 0) {
    say(`New (${defects.appeared.length}):`, "bad");
    for (const one of defects.appeared) {
      say(defectLine(one.defect, "is"), "bad");
      say(
        one.otherRunProbedEndpoint
          ? `      the first run probed ${one.defect.endpointId} too, so this is new behaviour.`
          : `      the first run never probed ${one.defect.endpointId}, so this may be newly ` +
              `covered rather than newly broken.`,
        one.otherRunProbedEndpoint ? "bad" : "warn",
      );
    }
  }

  if (defects.gone.length > 0) {
    say(`Gone (${defects.gone.length}):`, "plain");
    for (const one of defects.gone) {
      say(defectLine(one.defect, "was"), one.otherRunProbedEndpoint ? "good" : "warn");
      say(
        one.otherRunProbedEndpoint
          ? `      the second run probed ${one.defect.endpointId} and found nothing there.`
          : `      the second run never probed ${one.defect.endpointId}: nothing was fixed, ` +
              `nothing was looked at.`,
        one.otherRunProbedEndpoint ? "good" : "warn",
      );
    }
  }

  if (defects.changed.length > 0) {
    say(`Changed (${defects.changed.length}):`, "warn");
    for (const one of defects.changed) {
      say(`  ${one.key}`, "warn");
      for (const change of one.changes) {
        say(
          change.axis === "acceptance"
            ? `      held out of the verdict by an acceptance: ${change.before} → ${change.after}`
            : `      ${change.axis}: ${change.before} → ${change.after}`,
          "warn",
        );
      }
    }
  }

  for (const blocker of comparison.blockers) {
    say(`Cannot be trusted: ${blocker.detail}.`, "bad");
  }
  say(`Run verdicts: ${comparison.before.verdict.code} → ${comparison.after.verdict.code}.`);
  say(
    `Exit code ${comparison.verdict.code}: ${comparison.verdict.reason}`,
    comparison.verdict.code === 0 ? "good" : "bad",
  );
  return lines;
}

/** Whether a parsed value is an object worth reading fields off. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringAt(source: string, holder: Readonly<Record<string, unknown>>, key: string): string {
  const value = holder[key];
  if (typeof value !== "string") {
    throw new UnreadableReportError(source, `"${key}" is not a string`);
  }
  return value;
}

function numberAt(source: string, holder: Readonly<Record<string, unknown>>, key: string): number {
  const value = holder[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new UnreadableReportError(source, `"${key}" is not a number`);
  }
  return value;
}

function objectAt(
  source: string,
  holder: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> {
  const value = holder[key];
  if (!isRecord(value)) {
    throw new UnreadableReportError(source, `"${key}" is missing or is not an object`);
  }
  return value;
}

function arrayAt(
  source: string,
  holder: Readonly<Record<string, unknown>>,
  key: string,
): readonly unknown[] {
  const value = holder[key];
  if (!Array.isArray(value)) {
    throw new UnreadableReportError(source, `"${key}" is missing or is not an array`);
  }
  return value;
}

function stringsAt(
  source: string,
  holder: Readonly<Record<string, unknown>>,
  key: string,
): readonly string[] {
  return arrayAt(source, holder, key).map((one) => {
    if (typeof one !== "string") {
      throw new UnreadableReportError(source, `"${key}" holds something that is not a string`);
    }
    return one;
  });
}

/** The counts a `notProbed` record carries, over keys the runner chose. */
function countsAt(
  source: string,
  holder: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, number>> {
  const value = objectAt(source, holder, key);
  // `openRecord`, not `{}`: the keys are a saved file's, and a reason literally
  // named `__proto__` is swallowed by an object literal — the assignment is a
  // no-op and the row silently disappears from the comparison. ADR-0024.
  const counts = openRecord<number>();
  for (const [reason, count] of Object.entries(value)) {
    if (typeof count !== "number" || !Number.isFinite(count)) {
      throw new UnreadableReportError(source, `"${key}.${reason}" is not a number`);
    }
    counts[reason] = count;
  }
  return counts;
}

function defectAt(source: string, value: unknown): ComparableDefect {
  if (!isRecord(value)) {
    throw new UnreadableReportError(source, `"defects" holds something that is not an object`);
  }
  const relation = value["relation"];
  const contextId = value["contextId"];
  const acceptedKinds = value["acceptedKinds"];
  return {
    key: stringAt(source, value, "key"),
    endpointId: stringAt(source, value, "endpointId"),
    kinds: stringsAt(source, value, "kinds"),
    severity: stringAt(source, value, "severity"),
    accountIds: stringsAt(source, value, "accountIds"),
    resourceIds: stringsAt(source, value, "resourceIds"),
    violations: numberAt(source, value, "violations"),
    ...(typeof contextId === "string" ? { contextId } : {}),
    // Not checked against the vocabulary of the core: a relation this build has
    // not heard of is a report from another vintage, and printing the word back
    // is more use than refusing the file over it.
    ...(typeof relation === "string" ? { relation: relation as ResourceRelation } : {}),
    ...(acceptedKinds === undefined
      ? {}
      : { acceptedKinds: stringsAt(source, value, "acceptedKinds") }),
  };
}

/**
 * A parsed JSON document, checked far enough to be compared.
 *
 * Far enough and no further: this validates the fields the comparison reads and
 * says nothing about the rest of the report, because a second full validator of
 * the report shape beside `buildReport` is a duplicate that drifts — and the
 * first thing it would drift into is refusing a file the tool itself wrote.
 *
 * `schemaVersion` is read and **not** enforced here: a mismatch is a statement
 * the comparison makes, with the two versions named, rather than an error that
 * loses which was which.
 *
 * @throws {UnreadableReportError} naming the file, because a comparison takes two
 */
export function toComparableRun(value: unknown, source: string): ComparableRun {
  if (!isRecord(value)) {
    throw new UnreadableReportError(source, "the document is not a JSON object");
  }
  const target = objectAt(source, value, "target");
  const label = target["label"];
  const coverage = objectAt(source, value, "coverage");
  const verdict = objectAt(source, value, "verdict");
  const truncated = value["truncated"];
  if (typeof truncated !== "boolean") {
    throw new UnreadableReportError(source, `"truncated" is not a boolean`);
  }
  return {
    schemaVersion: stringAt(source, value, "schemaVersion"),
    runId: stringAt(source, value, "runId"),
    configDigest: stringAt(source, value, "configDigest"),
    startedAt: stringAt(source, value, "startedAt"),
    truncated,
    target: {
      baseUrl: stringAt(source, target, "baseUrl"),
      ...(typeof label === "string" ? { label } : {}),
    },
    defects: arrayAt(source, value, "defects").map((one) => defectAt(source, one)),
    observations: arrayAt(source, value, "observations").map((one) => {
      if (!isRecord(one)) {
        throw new UnreadableReportError(
          source,
          `"observations" holds something that is not an object`,
        );
      }
      return { endpointId: stringAt(source, one, "endpointId") };
    }),
    coverage: {
      endpointsTotal: numberAt(source, coverage, "endpointsTotal"),
      endpointsProbed: numberAt(source, coverage, "endpointsProbed"),
      cellsObserved: numberAt(source, coverage, "cellsObserved"),
      notProbed: countsAt(source, coverage, "notProbed"),
    },
    verdict: {
      code: numberAt(source, verdict, "code"),
      reason: stringAt(source, verdict, "reason"),
    },
  };
}

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
 *    not about the platform. What survives is a defect's **coordinates** —
 *    endpoint, relation, conditions — and `defectIdentity` reads them out of the
 *    group. `defects[].key` is the citable form of the same three, and it was
 *    what this indexed on until 24 August 2026: a form joined with a space, in a
 *    grammar where a space is a legal character, so it names two defects at once
 *    and merged them. See ADR-0070.
 * 3. **A difference in coverage is a difference.** A run that probed twelve
 *    cells where yesterday's probed a hundred and forty-four did not fix
 *    anything, and every defect missing from it is missing because nothing went
 *    looking. The gone half of the comparison is worthless without it.
 *
 * Pure, like the rest of what a report is built from: the CLI reads the files
 * and this decides what the pair means.
 *
 * ## The other side of this module is a document
 *
 * `toComparableRun` is a **door**, and until 24 August 2026 it was not treated as
 * one. A saved report can come from another machine, an earlier build or somebody
 * else, exactly like an OpenAPI file — and its strings are printed straight onto a
 * terminal and used as map keys. ADR-0032 is the record of this repository placing
 * a grammar on the ways in and missing the door with no adapter on it; ADR-0066
 * listed five parsers, the library door and the resume stream, and missed this
 * one.
 *
 * The reading half of that door left this file on 25 August 2026, when
 * `evidencePack` became a second reader of the same kind of file: it is
 * `src/report/document.ts`, and `readable` there is the sentence that used to be
 * written here. What is left below names the fields a comparison needs and stops,
 * which is the half that belongs to comparing. See ADR-0070.
 */

import type { ResourceRelation } from "../core/index.js";
import { defectSignature, SEVERITY_ORDER } from "../core/index.js";
import { byCodeUnits } from "../core/order.js";
import { lookup } from "../io/untrusted.js";
import { REPORT_SCHEMA_VERSION } from "./build.js";
import {
  arrayAt,
  countsAt,
  isRecord,
  numberAt,
  objectAt,
  optionalStringAt,
  stringAt,
  stringsAt,
  UnreadableReportError,
} from "./document.js";

/**
 * Thrown by the reader at the foot of this file, and declared next door.
 *
 * Re-exported rather than moved off the surface: `docs/library.md` tells a
 * consumer to catch it beside `toComparableRun`, and an import that worked
 * yesterday should not need a new module name today. It is one class with one
 * declaration — `src/report/document.ts` — and this is a second address for it,
 * not a second class. See ADR-0070.
 */
export { UnreadableReportError } from "./document.js";

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
  /**
   * The citable form: what an operator pastes into a ticket, printed as written.
   *
   * Not the identity — see `defectIdentity`. It is read out of the file rather
   * than recomputed from the coordinates beside it, because it is the string the
   * report actually carries and the one a reader will search their file for.
   */
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
  /** The citable key, as the second run wrote it. The identity is `defectIdentity`. */
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
 * The two endpoint sets, built once and read by both halves of the comparison.
 *
 * `probedEndpoints` walks `observations`, which is the longest array a report
 * has — one row per cell the run reached. Both halves need both sets and for the
 * same reason: coverage says which endpoints stopped being probed, and the defect
 * comparison says whether a defect that vanished vanished from a run that went
 * looking. Each built its own pair, so a comparison walked two observation lists
 * four times to learn two things.
 *
 * Threaded as an argument rather than memoised on the run, because a
 * `ComparableRun` is a structural view a consumer may hand over frozen, and a
 * cache written onto somebody else's object is a side effect in a function this
 * module's header calls pure.
 *
 * Measured on 24 August 2026 over a pair of runs of 80 000 observations each:
 * `compareRuns` took 5.16 ms, of which 2.98 ms was the second pair of walks.
 * Nothing about a real report makes this urgent — the reference platform's is
 * 2 888 cells — and it is here because a reader who meets `probedEndpoints`
 * twice has to work out whether the two answers can differ. They cannot.
 */
interface ProbedEndpoints {
  readonly before: ReadonlySet<string>;
  readonly after: ReadonlySet<string>;
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

function compareCoverage(
  before: ComparableRun,
  after: ComparableRun,
  probed: ProbedEndpoints,
): CoverageDifference {
  const { before: probedBefore, after: probedAfter } = probed;
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

/**
 * The identity two runs meet a defect on: its coordinates, not its printed key.
 *
 * `defects[].key` was this until 24 August 2026, and it is the citable form — the
 * three coordinates joined with a **space**, for a person to paste into a ticket.
 * A space is a legal character in an identifier, deliberately (ADR-0066), so that
 * string can name two defects at once:
 *
 * ```
 * A = { endpointId: "a",       relation: "own",         contextId: "b same-tenant d" }
 * B = { endpointId: "a own b", relation: "same-tenant", contextId: "d" }
 * ```
 *
 * Both print `a own b same-tenant d`. Two rows of one report, merged into one
 * entry by the `Map` below — the second run then reads as having changed the
 * kinds and the severity of a defect that is in fact two defects, one of them
 * gone. It does not take two files: `groupDefects` keys on the signature, so a
 * report this tool wrote carries both rows under one `key`. See ADR-0070.
 *
 * `defectSignature` is asked rather than a second spelling of the three
 * coordinates, because it is the function that decided these were two groups in
 * the first place — the run that wrote the file and the comparison that reads it
 * back agree by construction rather than by two authors agreeing. Its parts go
 * through the identifier grammar, which refuses the separator, so the joining is
 * injective where a space is not.
 *
 * The coordinates are read out of the group and no new field is written: a
 * machine key beside the citable one would be absent from every report already on
 * disk, which is the file this subcommand exists to read.
 *
 * ## When this throws
 *
 * `joinKey` refuses a part that is not an identifier, so this can raise
 * `UnusableIdentifierError` where indexing on `defects[].key` could not. Not from
 * the CLI: `toComparableRun` put every string through the same grammar before it
 * built the value, so a report read off disk has already been refused at the door
 * if it carries one. From the **library** door it can — `compareRuns` takes a
 * `ComparableRun`, which a consumer's own `RunReport` satisfies without passing
 * `toComparableRun`. That is the seam under a door nobody enumerated, which is
 * what ADR-0066 put it there for, and a report `buildReport` wrote cannot reach
 * it: `groupDefects` builds the same signature and would have thrown first.
 */
function defectIdentity(defect: ComparableDefect): string {
  return defectSignature(defect);
}

function compareDefects(
  before: ComparableRun,
  after: ComparableRun,
  probed: ProbedEndpoints,
): DefectDifference {
  // Keyed by the coordinates — an endpoint id among them, a name that came from
  // an OpenAPI document, an endpoint list or a Postman collection, and so a name
  // this tool did not choose. See ADR-0024, and `defectIdentity` above for why
  // this is not `defects[].key`.
  const beforeBySignature = new Map(before.defects.map((one) => [defectIdentity(one), one]));
  const afterBySignature = new Map(after.defects.map((one) => [defectIdentity(one), one]));
  const { before: probedBefore, after: probedAfter } = probed;

  const gone: DefectAppearance[] = [];
  const changed: ChangedDefect[] = [];
  let unchanged = 0;
  for (const [signature, defect] of beforeBySignature) {
    const twin = afterBySignature.get(signature);
    if (twin === undefined) {
      gone.push({ defect, otherRunProbedEndpoint: probedAfter.has(defect.endpointId) });
      continue;
    }
    const changes = changesOn(defect, twin);
    if (changes.length === 0) {
      unchanged += 1;
    } else {
      // The citable key as the **second** run wrote it. The signature above is a
      // NUL-joined string and has no business on a terminal; the two runs agree
      // on the citable form whenever both were written by this tool, and where
      // they do not, the row is about what is there now.
      changed.push({ key: twin.key, before: defect, after: twin, changes });
    }
  }

  const appeared: DefectAppearance[] = [];
  for (const [signature, defect] of afterBySignature) {
    if (!beforeBySignature.has(signature)) {
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

  // Once, for both halves below. See {@link ProbedEndpoints}.
  const probed: ProbedEndpoints = {
    before: probedEndpoints(before),
    after: probedEndpoints(after),
  };
  const coverage = compareCoverage(before, after, probed);
  const defects = compareDefects(before, after, probed);
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
 * The sentences live here rather than in `src/cli/compare.ts` so that they can be
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

function defectAt(source: string, value: unknown, at: string): ComparableDefect {
  if (!isRecord(value)) {
    throw new UnreadableReportError(source, `${at} is not an object`);
  }
  const contextId = optionalStringAt(source, value, "contextId", at);
  // The **vocabulary** is still not checked: a relation this build has not heard
  // of is a report from another vintage, and printing the word back is more use
  // than refusing the file over it. The characters are, like every other string
  // lifted out of a document here — see `readable`.
  const relation = optionalStringAt(source, value, "relation", at);
  const acceptedKinds = value["acceptedKinds"];
  return {
    key: stringAt(source, value, "key", at),
    endpointId: stringAt(source, value, "endpointId", at),
    kinds: stringsAt(source, value, "kinds", at),
    severity: stringAt(source, value, "severity", at),
    accountIds: stringsAt(source, value, "accountIds", at),
    resourceIds: stringsAt(source, value, "resourceIds", at),
    violations: numberAt(source, value, "violations", at),
    ...(contextId === undefined ? {} : { contextId }),
    ...(relation === undefined ? {} : { relation: relation as ResourceRelation }),
    ...(acceptedKinds === undefined
      ? {}
      : { acceptedKinds: stringsAt(source, value, "acceptedKinds", at) }),
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
 * Every string it does lift goes through the identifier grammar. That is the
 * ninth door, and the reasoning is on `readable` in `src/report/document.ts`,
 * which is where every reader of a saved report gets it from.
 *
 * @throws {UnreadableReportError} naming the file, because a comparison takes two
 * @throws {UnusableIdentifierError} naming the field and the file it was read from
 */
export function toComparableRun(value: unknown, source: string): ComparableRun {
  if (!isRecord(value)) {
    throw new UnreadableReportError(source, "the document is not a JSON object");
  }
  const target = objectAt(source, value, "target");
  const label = optionalStringAt(source, target, "label", "target");
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
      baseUrl: stringAt(source, target, "baseUrl", "target"),
      ...(label === undefined ? {} : { label }),
    },
    defects: arrayAt(source, value, "defects").map((one, index) =>
      defectAt(source, one, `defects[${index}]`),
    ),
    observations: arrayAt(source, value, "observations").map((one, index) => {
      if (!isRecord(one)) {
        throw new UnreadableReportError(source, `observations[${index}] is not an object`);
      }
      return { endpointId: stringAt(source, one, "endpointId", `observations[${index}]`) };
    }),
    coverage: {
      endpointsTotal: numberAt(source, coverage, "endpointsTotal", "coverage"),
      endpointsProbed: numberAt(source, coverage, "endpointsProbed", "coverage"),
      cellsObserved: numberAt(source, coverage, "cellsObserved", "coverage"),
      notProbed: countsAt(source, coverage, "notProbed", "coverage"),
    },
    verdict: {
      code: numberAt(source, verdict, "code", "verdict"),
      reason: stringAt(source, verdict, "reason", "verdict"),
    },
  };
}

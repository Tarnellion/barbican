/**
 * What an evidence pack is allowed to say, and the structure a document is drawn
 * from.
 *
 * Module 2 in CLAUDE.md is "an evidence pack against external standards. Added
 * by registering checks, not by rewriting the core", and most of its machinery
 * was already here: the catalogue in `src/core/standards/`, `coverage.clauses`
 * in the report (ADR-0052), the clauses a finding cites (ADR-0041), and
 * `clauseReservationsOf` in `sections.ts`, which computes the qualifications
 * that would otherwise stay behind in another section. What was missing is the
 * decision this module is: **which sentence the tool is willing to say to a
 * third party about a clause, given what a run actually did.**
 *
 * Nothing here renders anything. JSON is the single source of truth and a
 * document is drawn from it in a separate step (ADR-0002), so this is pure — no
 * file system, no clock, no network — and a pack is built from a **saved report**
 * after the run is over rather than assembled as the checks run.
 *
 * ## The defect this exists against
 *
 * The doc comment on `clauseReservationsOf` records it: a run probed two
 * endpoints of eleven and printed "No privilege escalation found" over the other
 * nine (B-4). Nothing was missing from the file; the number that mattered was
 * not next to the claim. An evidence pack is the artifact where that failure is
 * most expensive, because it is the one a third party reads as a conclusion.
 *
 * So every rule below is written in the same direction:
 *
 * - **A clause nothing answered for is `unanswered`, never a pass.** The
 *   catalogue is what makes that sayable at all — a list of clauses to iterate
 *   over, which is why `StandardCatalog` exists (ADR-0043).
 * - **A claim of "upheld" carries its own denominator and its own
 *   reservations**, read off the report rather than recomputed. `matrixCells`
 *   holds the cells that concluded and the cells that did not; `reservations`
 *   holds why "exercised" falls short of "holds across the surface". Both travel
 *   on the row, because a row is what gets pulled out of a report and into a
 *   pack about one requirement.
 * - **A run that exited 2 describes the network, the deployment or its own
 *   credentials rather than the platform.** See {@link PackStanding}: such a run
 *   may still report what it found and may not report a clause as upheld.
 * - **A pack presents evidence about a policy a human declared** (ADR-0006). It
 *   is not an independent audit of whether that policy is the right one, and
 *   {@link DISCLAIMERS} says so in the document rather than in this comment.
 *
 * ## The wording is a decision, not a string
 *
 * Every sentence a pack prints about a clause is an assertion this tool makes to
 * somebody who was not there. {@link CLAIMS} is the one place those sentences are
 * written, for the reason `WARNINGS` in `verdict.ts` is one place: the two halves
 * that were written separately drifted within four days, and a reader holding the
 * artifact could not tell which of them the tool had meant. A row carries the
 * **code**; whatever renders it reads the sentence from here.
 *
 * See ADR-0067.
 */

import { byCodeUnits } from "../core/order.js";
import type { StandardCatalog } from "../core/standards/catalog.js";
import { INCONCLUSIVE_REASONS } from "../core/standards/coverage.js";
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
import { nothingLeftUnnamed, REPORT_SCHEMA_VERSION } from "./shape.js";

/**
 * The version of the pack's own shape.
 *
 * The report has one for the reason stated on `RunReport.schemaVersion`, and the
 * comparison has one for the same reason: a third machine-readable artifact
 * published by this tool gets the same courtesy, because without it a parser
 * breaks silently at the first change of structure.
 */
export const PACK_SCHEMA_VERSION = "1";

/**
 * Whether this run is in a position to support a claim about the platform at
 * all.
 *
 * `runVerdict` already draws this line and states it in a sentence: 2 means the
 * report describes the state of the network, of the deployment or of its own
 * credentials rather than the platform's access control. Five of the six ways to
 * reach it — a matrix nobody walked, a walk cut short, credentials that went
 * stale, credentials nothing confirmed, half the cells failing to answer — leave
 * cells whose *silence* proves nothing.
 *
 * **They do not make what was found unfound.** A privilege escalation seen on a
 * run that later ran out of budget is still a privilege escalation, and an
 * allowed response under a token that may be dead is worse rather than better.
 * So the asymmetry this whole project reasons by applies here too: a positive
 * claim of safety needs a sound run, a positive finding of a hole does not.
 * `withheld` therefore replaces `upheld` and `answered-without-findings`, and
 * leaves `breached` standing. See {@link claimFor}.
 */
export type PackStanding = keyof typeof STANDINGS;

/**
 * What the standing means, in the words the pack prints.
 *
 * A plain sentence and not a template, deliberately, for the reason `WARNINGS`
 * gives: one that interpolates is one the two sides can format differently. The
 * run's own `verdict.reason` says which of the ways it was, and travels beside
 * this in {@link PackedRun}.
 */
export const STANDINGS = {
  evidence:
    "This run walked its matrix and answered for its own trustworthiness — it " +
    "exited 0 or 1 — so the rows below are evidence about the platform it ran " +
    "against, within the reservations each row carries.",
  withheld:
    "This run exited 2: it describes the state of the network, of the deployment " +
    "or of its own credentials rather than the platform's access control. A row " +
    "recording a disagreement still stands — what was found was found — but no " +
    "clause below is reported as upheld, because a cell that agreed may have " +
    "agreed for a reason that has nothing to do with access.",
} as const;

/**
 * What a pack is willing to say about one clause.
 *
 * The vocabulary is the keys of this object rather than a list beside it: a
 * second enumeration of the same six names is the shape
 * `tests/invariants/a-table-written-twice.test.ts` exists against, and there is
 * nothing here to iterate over that would justify one.
 *
 * Read as a whole, the six are one argument. Three of them say something about
 * the platform (`breached`, `upheld`, and `answered-without-findings` weakly);
 * three of them say something about **this run** and nothing about the platform
 * (`inconclusive`, `unanswered`, `withheld`). The second group is the half a
 * pack usually lacks, and the half a reader mistakes for the first.
 */
export const CLAIMS = {
  breached:
    "The platform and the declared policy disagree under this clause: this run " +
    "recorded at least one cell or check finding here. Which of the two is wrong " +
    "is not settled by this pack — the policy is a human declaration and the tool " +
    "compares against it — but one of them has to change.",
  upheld:
    "Every cell that reached a conclusion under this clause agreed with the " +
    "declared policy. That is evidence about a declared policy over the cells " +
    "counted on this row, and it says nothing about the cells this run did not " +
    "reach: read the inconclusive counts and the reservations beside it before " +
    "reading this as a pass.",
  inconclusive:
    "This clause was reached and nothing was concluded under it: every cell " +
    "counted here failed to answer or was never asked. The run says nothing about " +
    "this clause in either direction.",
  "answered-without-findings":
    "A registered check answers for this clause, it ran, and it reported nothing. " +
    "What that check examined is its own to state — this pack has no denominator " +
    "for the check channel — so a check that reported nothing is not the same as " +
    "there being nothing to report.",
  unanswered:
    "Nothing in this run answers for this clause: no check cited it and no cell of " +
    "the matrix was evidence about it. It is unanswered, which is not the same as " +
    "passed, and no absence of findings below applies to it.",
  withheld:
    "This run could not be trusted on its own terms, so no claim is made under " +
    "this clause. What the run recorded is still on the row; a clause nothing was " +
    "found wrong under is not thereby upheld.",
} as const;

export type ClaimStatus = keyof typeof CLAIMS;

/**
 * What the pack refuses to claim, whatever any row says.
 *
 * Three standing qualifications, printed on every pack rather than kept in this
 * comment. Each of them is a limit of the method and not of a particular run, so
 * none of them can ever be discharged by running the tool again — which is
 * exactly why a reader who has only the document needs them in it.
 */
export const DISCLAIMERS = {
  /**
   * ADR-0006, which is load-bearing for the whole artifact: the expected matrix
   * is declared by a human and is never derived from the specification of the
   * API under test, because that specification is generated from the same code
   * and deriving from it would compare an implementation against itself.
   */
  declaration:
    "Expected access is declared by a human and is never derived from the " +
    "specification of the system under test. Every row below compares a platform " +
    "against that declaration: where they disagree this tool cannot say which of " +
    "the two is wrong, and where they agree, what was agreed with is the " +
    "declaration. This is evidence about a declared policy, not an audit of " +
    "whether the policy is the right one.",
  /**
   * L-3, whose signature is `outcomes.denied === 0` and whose reservation code
   * is `no-refusal-observed`. Stated for every pack and not only for the runs
   * that trip it, because it bounds what any row here can mean.
   */
  blackBox:
    "Every conclusion here is drawn from HTTP status codes observed from outside " +
    "the platform. A deployment that answers 200 with the refusal in the body " +
    "reads as allowed on every cell, and no row below can tell that case apart " +
    "from a platform that grants everything.",
  /**
   * `StandardDefinition.scope`, one level up. The row carries the boundary of
   * its own standard; this says that the set of standards is bounded too, and
   * that no requirement's text is reproduced anywhere in the pack.
   */
  catalogue:
    "The clauses below are the ones the catalogue this pack was built against " +
    "carries, and every row states that catalogue's own boundary. A clause absent " +
    "from this pack is not thereby absent from the standard. No requirement's " +
    "text is reproduced: a row carries the identifier, one line of this tool's " +
    "own, and the address of the published wording.",
} as const;

/** The cells of the matrix under one clause, as the saved report counted them. */
export interface PackableCells {
  readonly conclusive: number;
  readonly upheld: number;
  readonly breached: number;
  /** By reason, over a key space this build does not own once it is in a file. */
  readonly inconclusive: Readonly<Record<string, number>>;
}

/** One row of `coverage.clauses`, as much of it as a pack reads. */
export interface PackableClauseRow {
  readonly standard: string;
  readonly clause: string;
  readonly checkIds: readonly string[];
  /** Absent where the matrix channel does not reach this clause at all. */
  readonly matrixCells?: PackableCells;
  /**
   * The codes as the file spells them.
   *
   * The **vocabulary** is deliberately not checked, the way `toComparableRun`
   * does not check a relation: a reservation this build has not heard of is a
   * report from another vintage, and carrying the word into the pack is more use
   * than refusing the file over it — a qualification nobody recognises is still
   * a qualification.
   */
  readonly reservations: readonly string[];
}

/** A clause reference as a saved report spells one. */
export interface PackableRef {
  readonly standard: string;
  readonly clause: string;
}

/** One finding row, as much of one as a pack reads. */
export interface PackableFinding {
  readonly kind: string;
  /**
   * The report's `source`: how it was found, by comparing the matrix or by a
   * check. Renamed here only so that the field and the name of the file this was
   * read from are not both called `source` three lines apart.
   */
  readonly channel: string;
  readonly severity: string;
  /** Empty where the finding cites none, which a check registered elsewhere may. */
  readonly standards: readonly PackableRef[];
  /** An acceptance is holding this row out of the verdict, and has not lapsed. */
  readonly heldByAcceptance: boolean;
}

/**
 * What a pack reads out of a saved report.
 *
 * A `RunReport` is **not** assignable to it, which is the difference from
 * `ComparableRun` next door and is deliberate: the finding rows are narrowed to
 * five fields, the clause rows to four, and the report's own vocabulary types
 * (`Severity`, `DiffKind`, `ClauseReservation`) become plain strings, because a
 * file carrying a sixth severity or a fifth reservation is a report from another
 * vintage rather than a document to refuse. Building one from a report in hand
 * is `packableRun`; building one from JSON off disk is `toPackableRun`.
 */
export interface PackableRun {
  readonly runId: string;
  readonly configDigest: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly tool: {
    readonly name: string;
    readonly version: string;
    readonly documentation: string;
  };
  readonly target: { readonly baseUrl: string; readonly label?: string };
  readonly verdict: { readonly code: number; readonly reason: string };
  readonly surface: {
    readonly endpointsTotal: number;
    readonly endpointsProbed: number;
    readonly cellsObserved: number;
  };
  /** The run's own warnings, in the tool's own words. See `WARNINGS`. */
  readonly warnings: readonly string[];
  /** `findingsOmitted`: how many evidence rows the file left out. */
  readonly evidenceRowsOmitted: number;
  readonly clauses: readonly PackableClauseRow[];
  readonly findings: readonly PackableFinding[];
}

/**
 * The run a pack was built from, as the pack names it.
 *
 * A narrowing of {@link PackableRun} and not the whole of it: the clause rows
 * and the finding rows are what the pack digests into claims, and carrying them
 * here as well would put the same facts in the document twice, free to disagree.
 * `nothingLeftUnnamed` in {@link packedRun} is what makes that a statement the
 * compiler checks.
 */
export interface PackedRun {
  readonly runId: string;
  readonly configDigest: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly tool: PackableRun["tool"];
  readonly target: PackableRun["target"];
  readonly verdict: PackableRun["verdict"];
  readonly surface: PackableRun["surface"];
  readonly warnings: readonly string[];
  readonly evidenceRowsOmitted: number;
}

/**
 * The finding rows of the file that cite one clause, counted by what they mean.
 *
 * Counted from the rows the file carries, which are capped at
 * `MAX_ROWS_PER_DEFECT` per defect (ADR-0029) — so `lowerBound` says when these
 * are floors rather than totals. The cells beside them are not capped: they are
 * counted over the matrix, and `matrixCells.breached` is the number to trust
 * where both exist.
 */
export interface PackedEvidence {
  /**
   * Rows where the platform and the declaration disagree.
   *
   * A matrix row of any kind but the two that conclude nothing, and a check row
   * of any severity but `info` — the same threshold `runVerdict` fails a run by.
   * A kind or a channel this build does not recognise counts here rather than
   * being passed over: an unrecognised finding read as "nothing found" is how a
   * pack would come to claim a clause upheld over a row that says otherwise.
   */
  readonly disagreements: number;
  /** Of those, rows an unexpired acceptance holds out of the verdict (ADR-0048). */
  readonly heldByAcceptance: number;
  /**
   * Rows that cite the clause and record something else: a cell nothing was
   * learned about, a failed probe, a check speaking at `info`.
   */
  readonly other: number;
  /** The file left evidence rows out, so the two counts above are floors. */
  readonly lowerBound: boolean;
}

/** One clause the run cited that the catalogue does not carry. */
export interface CitedClause {
  readonly standard: string;
  readonly clause: string;
  readonly claim: ClaimStatus;
  /** The registered checks that answer for it and ran, the ones that found nothing included. */
  readonly checkIds: readonly string[];
  /** Absent where the matrix channel does not reach this clause. */
  readonly cells?: PackableCells;
  readonly evidence: PackedEvidence;
  /**
   * Why the numbers on this row fall short of "the clause holds across the
   * surface", from the report and not recomputed.
   *
   * On the row for the reason `clauseReservationsOf` gives: a qualification left
   * behind in another section is one that did not travel with the claim. Empty
   * on a row the run never reached, where there is no claim for one to qualify.
   */
  readonly reservations: readonly string[];
}

/** The same, for a clause the catalogue carries — which is what lets it be named. */
export interface ClaimedClause extends CitedClause {
  /** One line of this tool's own. Never the requirement's own wording. */
  readonly title: string;
  /** Where the published text is. */
  readonly url: string;
  /** The catalogue's boundary for this standard, carried on every row. */
  readonly scope: string;
}

/** The structure a document is drawn from. */
export interface EvidencePack {
  readonly schemaVersion: string;
  readonly run: PackedRun;
  readonly standing: PackStanding;
  /**
   * What governs the whole document, in the order it has to be read: what this
   * run is in a position to say, then the three limits of the method.
   *
   * Sentences and not codes, unlike a row's `claim`. That is `report.warnings[]`
   * again, and for its reason: these are read once, by a person, at the top of a
   * document — nothing counts or filters them — and a document that has the
   * sentences cannot render the pack without them.
   */
  readonly notes: readonly string[];
  /**
   * Every clause of the catalogue, in the order the catalogue gives them.
   *
   * **Every** one, including the clauses this run never touched: those are the
   * rows the pack exists for. A pack built from findings alone lists what
   * happened to be checked, and the question a reader has is what was not.
   */
  readonly clauses: readonly ClaimedClause[];
  /**
   * Clauses this run cited that the catalogue does not carry.
   *
   * Kept apart rather than mixed in, because the pack cannot state a title, a
   * source or a boundary for them and a row that printed those as blank would
   * read as a catalogued clause with nothing to say. Two ordinary things land
   * here: a report written on a machine that registered a standard whose
   * numbering may not be published (ADR-0043), and a report from a build whose
   * catalogue has since grown.
   */
  readonly outsideCatalogue: readonly CitedClause[];
}

/**
 * The matrix kinds that conclude nothing, from the one place they are named.
 *
 * `INCONCLUSIVE_REASONS` is the vocabulary `judgedCells` maps a cell onto — a
 * cell with no observation is `not-observed`, one whose request failed is
 * `probe-error` — and `diffAccess` gives a finding on such a cell the same two
 * names. Reading it from there rather than writing the pair out again is the
 * point: the day a third way to learn nothing exists, it is inconclusive here
 * without anybody remembering this line.
 */
const NOTHING_CONCLUDED: ReadonlySet<string> = new Set(INCONCLUSIVE_REASONS);

/** The level at which a check is making a note rather than a disagreement. */
const NOTE_SEVERITY = "info";

/** Whether a finding row says the platform and the declaration disagree. */
function isDisagreement(finding: PackableFinding): boolean {
  if (finding.channel === "matrix") {
    return !NOTHING_CONCLUDED.has(finding.kind);
  }
  // A check finding, or a channel this build has never heard of. Both are read
  // by severity, which is the threshold `runVerdict` uses on the check channel:
  // `info` is what a check says without failing a build, and everything else is
  // a disagreement between the platform and a declaration.
  return finding.severity !== NOTE_SEVERITY;
}

/** A two-level index, because a standard and a clause are never glued into one key. */
type ByClause<T> = Map<string, Map<string, T>>;

function put<T>(index: ByClause<T>, ref: PackableRef, value: T): void {
  const clauses = index.get(ref.standard) ?? new Map<string, T>();
  index.set(ref.standard, clauses);
  clauses.set(ref.clause, value);
}

function get<T>(index: ByClause<T>, standard: string, clause: string): T | undefined {
  return index.get(standard)?.get(clause);
}

interface Counted {
  disagreements: number;
  heldByAcceptance: number;
  other: number;
}

/** The finding rows of the file, counted per clause by what each one means. */
function countEvidence(findings: readonly PackableFinding[]): ByClause<Counted> {
  const counted: ByClause<Counted> = new Map();
  for (const finding of findings) {
    for (const ref of finding.standards) {
      const row = get(counted, ref.standard, ref.clause) ?? {
        disagreements: 0,
        heldByAcceptance: 0,
        other: 0,
      };
      put(counted, ref, row);
      if (!isDisagreement(finding)) {
        row.other += 1;
        continue;
      }
      row.disagreements += 1;
      if (finding.heldByAcceptance) {
        row.heldByAcceptance += 1;
      }
    }
  }
  return counted;
}

const NOTHING: Readonly<Counted> = { disagreements: 0, heldByAcceptance: 0, other: 0 };

/**
 * The one decision this module is: what may be said about a clause.
 *
 * The order of the branches is the argument, and it is the order of decreasing
 * confidence in what the run saw:
 *
 * 1. A disagreement stands whatever the run's standing. It was observed, and no
 *    later failure of the run unobserves it.
 * 2. A run that cannot be trusted says nothing further. Everything below this
 *    line is a claim that something is *fine*, and such a claim needs a run that
 *    answered for itself.
 * 3. Cells that concluded are the only thing "upheld" may rest on, and the
 *    denominator travels with it on the row.
 * 4. Cells that concluded nothing are exactly that, and are not silence.
 * 5. A check that ran and found nothing is the weakest thing here, because
 *    nothing in the report says how much it looked at (ADR-0052 refuses to
 *    invent a denominator for the check channel).
 * 6. Whatever is left was answered by nothing at all.
 */
function claimFor(
  standing: PackStanding,
  row: PackableClauseRow | undefined,
  evidence: Readonly<Counted>,
): ClaimStatus {
  if (evidence.disagreements > 0 || (row?.matrixCells?.breached ?? 0) > 0) {
    return "breached";
  }
  if (standing === "withheld") {
    return "withheld";
  }
  const cells = row?.matrixCells;
  if (cells !== undefined) {
    return cells.conclusive > 0 ? "upheld" : "inconclusive";
  }
  if ((row?.checkIds.length ?? 0) > 0) {
    return "answered-without-findings";
  }
  return "unanswered";
}

/** One clause, with everything the run had to say about it on the row. */
function citedClause(
  standard: string,
  clause: string,
  standing: PackStanding,
  row: PackableClauseRow | undefined,
  evidence: Readonly<Counted>,
  lowerBound: boolean,
): CitedClause {
  return {
    standard,
    clause,
    claim: claimFor(standing, row, evidence),
    checkIds: row?.checkIds ?? [],
    ...(row?.matrixCells === undefined ? {} : { cells: row.matrixCells }),
    evidence: { ...evidence, lowerBound },
    reservations: row?.reservations ?? [],
  };
}

/**
 * The run's identity, narrowed to what a pack publishes about it.
 *
 * Field by field rather than by spreading, for the reason every mapping in
 * `sections.ts` is written that way: a published shape must not pass on what it
 * did not mean to publish, and `nothingLeftUnnamed` is what stops a field added
 * to {@link PackableRun} from going missing here in silence.
 */
function packedRun(run: PackableRun): PackedRun {
  const {
    runId,
    configDigest,
    startedAt,
    finishedAt,
    tool,
    target,
    verdict,
    surface,
    warnings,
    evidenceRowsOmitted,
    // Withheld, and digested instead: these two are the pack's raw material, and
    // a document that carried both them and the rows built from them would be
    // stating one fact twice.
    clauses: _clauses,
    findings: _findings,
    ...unnamed
  } = run;
  nothingLeftUnnamed(unnamed);
  return {
    runId,
    configDigest,
    startedAt,
    finishedAt,
    tool,
    target,
    verdict,
    surface,
    warnings,
    evidenceRowsOmitted,
  };
}

/**
 * The pack, built from a saved run and the catalogue it is to be read against.
 *
 * Pure, and both arguments are the whole input: the catalogue decides which
 * clauses exist to be answered for, and the run decides what was answered. A
 * catalogue is assembled per caller (`createBundledCatalog`, plus whatever
 * private standard a machine registers into it), so a pack built on a machine
 * holding GLI-19 asks the same questions of the same report and gets more rows.
 *
 * The order is the catalogue's own — the standards in the order they were
 * registered, the clauses in the order a reader of the standard meets them — and
 * then the cited-but-uncatalogued rows, sorted, so that two runs of one report
 * produce the same document on every machine (ADR-0036).
 */
export function evidencePack(input: {
  readonly run: PackableRun;
  readonly catalog: StandardCatalog;
}): EvidencePack {
  const { run, catalog } = input;
  const standing: PackStanding =
    run.verdict.code === 0 || run.verdict.code === 1 ? "evidence" : "withheld";
  const lowerBound = run.evidenceRowsOmitted > 0;

  const rows: ByClause<PackableClauseRow> = new Map();
  for (const row of run.clauses) {
    put(rows, row, row);
  }
  const evidence = countEvidence(run.findings);

  // Which coordinates the pack has already spoken about, so that the second pass
  // below reports what is left rather than repeating what is above.
  const said: ByClause<true> = new Map();
  const clauses: ClaimedClause[] = [];
  for (const definition of catalog.definitions()) {
    for (const clause of definition.clauses) {
      put(said, { standard: definition.id, clause: clause.id }, true);
      clauses.push({
        ...citedClause(
          definition.id,
          clause.id,
          standing,
          get(rows, definition.id, clause.id),
          get(evidence, definition.id, clause.id) ?? NOTHING,
          lowerBound,
        ),
        title: clause.title,
        url: clause.url,
        scope: definition.scope,
      });
    }
  }

  // Both indexes, because a clause outside the catalogue may be reached by
  // either channel and by only one of them: a check registered from code citing
  // a standard this machine has no definition for lands in `rows`, and a
  // finding carried over from a build whose catalogue was wider lands in
  // `evidence`. `said` is what keeps a clause in both from being reported twice.
  const outside: CitedClause[] = [];
  for (const [standard, byClause] of [...rows, ...evidence]) {
    for (const clause of byClause.keys()) {
      if (get(said, standard, clause) === true) {
        continue;
      }
      put(said, { standard, clause }, true);
      outside.push(
        citedClause(
          standard,
          clause,
          standing,
          get(rows, standard, clause),
          get(evidence, standard, clause) ?? NOTHING,
          lowerBound,
        ),
      );
    }
  }

  return {
    schemaVersion: PACK_SCHEMA_VERSION,
    run: packedRun(run),
    standing,
    notes: [
      STANDINGS[standing],
      DISCLAIMERS.declaration,
      DISCLAIMERS.blackBox,
      DISCLAIMERS.catalogue,
    ],
    clauses,
    outsideCatalogue: outside.sort(
      (left, right) =>
        byCodeUnits(left.standard, right.standard) || byCodeUnits(left.clause, right.clause),
    ),
  };
}

function cellsAt(
  source: string,
  holder: Readonly<Record<string, unknown>>,
  at: string,
): PackableCells {
  const cells = objectAt(source, holder, "matrixCells", at);
  const inner = `${at}.matrixCells`;
  return {
    conclusive: numberAt(source, cells, "conclusive", inner),
    upheld: numberAt(source, cells, "upheld", inner),
    breached: numberAt(source, cells, "breached", inner),
    inconclusive: countsAt(source, cells, "inconclusive", inner),
  };
}

function clauseRowAt(source: string, value: unknown, at: string): PackableClauseRow {
  if (!isRecord(value)) {
    throw new UnreadableReportError(source, `${at} is not an object`);
  }
  return {
    standard: stringAt(source, value, "standard", at),
    clause: stringAt(source, value, "clause", at),
    checkIds: stringsAt(source, value, "checkIds", at),
    ...(value["matrixCells"] === undefined ? {} : { matrixCells: cellsAt(source, value, at) }),
    reservations: stringsAt(source, value, "reservations", at),
  };
}

function refAt(source: string, value: unknown, at: string): PackableRef {
  if (!isRecord(value)) {
    throw new UnreadableReportError(source, `${at} is not an object`);
  }
  return {
    standard: stringAt(source, value, "standard", at),
    clause: stringAt(source, value, "clause", at),
  };
}

function findingAt(source: string, value: unknown, at: string): PackableFinding {
  if (!isRecord(value)) {
    throw new UnreadableReportError(source, `${at} is not an object`);
  }
  const accepted = value["accepted"];
  return {
    kind: stringAt(source, value, "kind", at),
    channel: stringAt(source, value, "source", at),
    severity: stringAt(source, value, "severity", at),
    standards:
      value["standards"] === undefined
        ? []
        : arrayAt(source, value, "standards", at).map((one, index) =>
            refAt(source, one, `${at}.standards[${index}]`),
          ),
    // A mark that has lapsed stops holding: the row counts in the verdict again
    // (ADR-0048), and it counts here again too. Anything that is not an object
    // is no mark at all.
    heldByAcceptance: isRecord(accepted) && accepted["expired"] !== true,
  };
}

/**
 * A parsed JSON document, checked far enough to build a pack from.
 *
 * The tenth door. A saved report is a document the tool was handed — from
 * another machine, an earlier build, or somebody else — and every string lifted
 * out of one goes through the identifier grammar, which is `src/report/document.ts`
 * and the reasoning is on `readable` there. A rendered document is a new sink,
 * and refusing a control character at the door is what lets the renderer above
 * this be right about one grammar instead of two. See ADR-0066 and ADR-0067.
 *
 * Far enough and no further, like `toComparableRun`: it validates the fields a
 * pack reads and says nothing about the rest of the report, because a second full
 * validator of the report shape beside `buildReport` is a duplicate that drifts.
 *
 * `schemaVersion` is **enforced** here, which is the one place this reader parts
 * company with the comparison. There a mismatch is a statement the comparison
 * makes with both versions named; here there is one file and nothing to compare
 * it against, and a shape this build cannot read would be read as a run that
 * answered for no clause at all — a pack full of `unanswered` over a run that may
 * have answered for every one of them. That is the pack's own worst failure
 * pointed at itself.
 *
 * @throws {UnreadableReportError} naming the field and the file
 * @throws {UnusableIdentifierError} naming the field and the file it was read from
 */
export function toPackableRun(value: unknown, source: string): PackableRun {
  if (!isRecord(value)) {
    throw new UnreadableReportError(source, "the document is not a JSON object");
  }
  const schemaVersion = stringAt(source, value, "schemaVersion");
  if (schemaVersion !== REPORT_SCHEMA_VERSION) {
    throw new UnreadableReportError(
      source,
      `it is schemaVersion ${schemaVersion} and this build reads ${REPORT_SCHEMA_VERSION}. ` +
        `A pack built from a shape this build cannot read would report every clause as ` +
        `unanswered, over a run that may have answered for all of them. Re-run that ` +
        `configuration with this build and build the pack from the report it writes`,
    );
  }
  const tool = objectAt(source, value, "tool");
  const target = objectAt(source, value, "target");
  const label = optionalStringAt(source, target, "label", "target");
  const verdict = objectAt(source, value, "verdict");
  const coverage = objectAt(source, value, "coverage");
  // Named rather than left to `arrayAt`, because this is the one absence a
  // reader will meet by accident: `coverage.clauses` arrived in 0.5.0 (ADR-0052)
  // and `schemaVersion` deliberately stayed `2` when it did, so a report from
  // 0.4.0 passes the check above and reaches here. The failure it would cause is
  // this module's own worst one, which is why it is refused rather than defaulted
  // to an empty list.
  if (coverage["clauses"] === undefined) {
    throw new UnreadableReportError(
      source,
      `it carries no "coverage.clauses". That field is what says which clause each cell ` +
        `was evidence about, and a report written before it existed would produce a pack ` +
        `reporting every clause as unanswered over a run that may have answered for all ` +
        `of them. Re-run that configuration with this build`,
    );
  }
  return {
    runId: stringAt(source, value, "runId"),
    configDigest: stringAt(source, value, "configDigest"),
    startedAt: stringAt(source, value, "startedAt"),
    finishedAt: stringAt(source, value, "finishedAt"),
    tool: {
      name: stringAt(source, tool, "name", "tool"),
      version: stringAt(source, tool, "version", "tool"),
      documentation: stringAt(source, tool, "documentation", "tool"),
    },
    target: {
      baseUrl: stringAt(source, target, "baseUrl", "target"),
      // Absent means the run named no system under test, which is a fact a pack
      // has to be able to print: an evidence pack that does not say what was
      // tested is evidence about nothing. `warnings` carries the sentence.
      ...(label === undefined ? {} : { label }),
    },
    verdict: {
      code: numberAt(source, verdict, "code", "verdict"),
      reason: stringAt(source, verdict, "reason", "verdict"),
    },
    surface: {
      endpointsTotal: numberAt(source, coverage, "endpointsTotal", "coverage"),
      endpointsProbed: numberAt(source, coverage, "endpointsProbed", "coverage"),
      cellsObserved: numberAt(source, coverage, "cellsObserved", "coverage"),
    },
    warnings: stringsAt(source, value, "warnings"),
    evidenceRowsOmitted: numberAt(source, value, "findingsOmitted"),
    clauses: arrayAt(source, coverage, "clauses", "coverage").map((one, index) =>
      clauseRowAt(source, one, `coverage.clauses[${index}]`),
    ),
    findings: arrayAt(source, value, "findings").map((one, index) =>
      findingAt(source, one, `findings[${index}]`),
    ),
  };
}

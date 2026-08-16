/**
 * Building the report.
 *
 * JSON is the single source of truth (ADR-0002). Human-readable forms are
 * rendered from it in a separate step, not assembled as the run goes.
 *
 * There are no tokens in the report by construction, not as the result of a
 * clean-up pass: they live in a separate map and belong to neither the
 * configuration nor the observations. Response headers arrive from the HTTP
 * client already redacted.
 */

import { createHash, randomUUID } from "node:crypto";
import type { AuthScheme } from "../adapters/credentials.js";
import type { ThrottleLimits } from "../adapters/throttle.js";
import type { CheckCoverage, StandardRef } from "../core/checks/types.js";
import type {
  AccessDiff,
  AccessObservation,
  AccessOutcome,
  Account,
  CellVerdict,
  DefectGroup,
  DiffKind,
  Endpoint,
  ExpectedOutcome,
  Finding,
  HttpMethod,
  ResolvedAccessPolicy,
  Resource,
  ResourceRelation,
  Severity,
  TenantNode,
} from "../core/index.js";
import { groupDefects, principalOf } from "../core/index.js";
import type {
  AccountConfig,
  ContextAttributeValue,
  RequestContextConfig,
  RunConfig,
} from "../io/config.js";
import type { ProbeFailure, SkippedEndpoint } from "../runner.js";

/**
 * The version of the report's shape. Bumped on an incompatible change of structure.
 *
 * `2` since 15 August 2026, and every part of it is incompatible rather than
 * additive — a reader written against `1` breaks on all four, which is what the
 * field is for (L-4, ADR-0025):
 *
 * - `coverage.checksRun` holds `{ id, standards }` where it held bare ids. The
 *   clauses a check answers for were declared, filled and read by no line of
 *   code, so the traceability the plan promises could not be built from a saved
 *   report at all.
 * - `coverage.bodyComparison` became `coverage.byCheck`, generic over checks.
 *   The old field was one check's shape, and this file imported its type from
 *   that check's module.
 * - `coverage.checksWithUnusableFindings` is gone: nothing is dropped any more,
 *   and a field that can only ever be empty is its own kind of lie.
 * - `findings[].accountId` and `.endpointId` are optional. A run-level finding —
 *   "this clause is covered by nothing" — has no cell, and used to be discarded.
 */
export const REPORT_SCHEMA_VERSION = "2";

export interface ReportSummary {
  readonly endpoints: number;
  readonly accounts: number;
  /**
   * Matrix rows: the declared accounts plus the same accounts under the declared
   * conditions.
   *
   * A number of its own, because `accounts` is about the declaration while cells
   * are counted by rows. A reader checking the arithmetic by `accounts` got 9 × 6,
   * which does not add up to 135 cells in any way. Found by a cold read.
   */
  readonly accountRows: number;
  readonly resources: number;
  readonly observations: number;
  readonly skipped: number;
  readonly failures: number;
  readonly findings: number;
  /**
   * By kind. The keys are kinds of matrix discrepancy and check identifiers: after
   * the lists were merged everything lands here, so a dashboard built on it is
   * complete.
   */
  readonly byKind: Readonly<Record<string, number>>;
  /** Discrepancies by severity — where the reader starts. See ADR-0014. */
  readonly bySeverity: Readonly<Record<Severity, number>>;
  /**
   * By severity, but counting **defects** rather than rows.
   *
   * `critical: 10` in `bySeverity` is one missing filter that touched ten cells,
   * yet it reads as ten problems. The number next to it settles the question.
   */
  readonly defectsBySeverity: Readonly<Record<Severity, number>>;
  /**
   * Distinct defect signatures. A **lower bound** on the number of problems: two
   * different bugs with the same signature are indistinguishable from the outside.
   * The upper bound is `findings`.
   */
  readonly defectGroups: number;
  /** Findings from plugin checks. Counted apart: they are of a different nature. */
  readonly checkFindings: number;
}

/** The outcome of one canary: who, where, and whether authentication held. */
export interface CanaryOutcome {
  readonly accountId: string;
  readonly endpointId: string;
  readonly status: number;
  readonly authenticated: boolean;
  /**
   * The transport failure's code, when there was no status to report at all —
   * `ECONNREFUSED`, `ENOTFOUND` and their like.
   *
   * `status: 0` says only that nothing came back, and a reader of the report
   * cannot tell a wrong port from a platform that dropped the connection. A
   * code and never a message: this is serialized, and a bounded vocabulary of
   * symbols cannot carry a URL with a token in it.
   */
  readonly failure?: string;
}

/**
 * A finding with the request attached.
 *
 * The core does not know about addresses and must not — the join happens here,
 * while the report is built, on the triple 'account × endpoint × resource'.
 */
/**
 * A report finding — one for both means of detection.
 *
 * There used to be two lists: matrix discrepancies along the axes `kind`/
 * `expected`/`actual`/`relation`, and check findings along the axes `checkId`/
 * `title`/`evidence`. One and the same cross-tenant leak landed in a different
 * list depending on whether it was visible by status or by body — that is, a
 * difference in the **means of detection** was passed off as a difference in the
 * nature of the finding.
 *
 * The cost of that split was not aesthetic. `bySeverity` counted only the first
 * list and showed half the number; `byKind` did not count the second at all;
 * grouping by signature did not extend to checks, and six clones of one finding
 * inflated the picture sixfold. Three symptoms, one cause.
 */
export interface ReportFinding {
  /** The kind of discrepancy, or the check's identifier. */
  readonly kind: string;
  /** How it was found: by comparing the matrix, or by a check from the registry. */
  readonly source: "matrix" | "check";
  readonly severity: Severity;
  /**
   * The cell, when there is one.
   *
   * Both absent on a run-level finding — "this clause is covered by nothing" —
   * which is the shape the evidence pack needs and which the report used to drop
   * on the floor. Nothing is substituted in their place: a reader who sees an
   * endpoint id believes a request was made to it.
   */
  readonly accountId?: string;
  readonly endpointId?: string;
  readonly resourceId?: string;
  /**
   * The clauses of external standards this finding answers for.
   *
   * From the check that produced it. Matrix discrepancies carry none: they come
   * from the declared policy, not from a check mapped onto a standard.
   */
  readonly standards?: readonly StandardRef[];
  /** The second account of a paired finding. See `Finding.relatedAccountId`. */
  readonly relatedAccountId?: string;
  readonly relation?: ResourceRelation;
  /**
   * The request conditions. Absent means baseline, with no attributes added.
   *
   * Without this field the finding 'there is access where none is meant to be'
   * would not differ from the finding 'there is access with the country
   * substituted': the account in the report differs, but the reader has nowhere to
   * learn how.
   */
  readonly contextId?: string;
  readonly expected?: ExpectedOutcome;
  readonly actual?: AccessOutcome;
  /** Only on check findings: a human-readable description and the grounds for it. */
  readonly title?: string;
  readonly evidence?: Readonly<Record<string, string | number | boolean>>;
  /**
   * What to reproduce it with, and what the platform answered.
   *
   * The code is needed right here: `actual: "allowed"` means '2xx', and which one
   * exactly had to be looked up in the observations and joined by hand on the
   * triple.
   */
  readonly request?: RequestRecord;
  /**
   * The second request of a paired finding.
   *
   * A leak found by body had two requests, and one was printed: on a platform with
   * per-tenant addresses the reader put the second one together himself — and put
   * it together wrongly, because the other brand's host is different. Found by a
   * third cold read.
   */
  readonly relatedRequest?: RequestRecord;
  readonly status?: number;
}

/**
 * The inputs the conclusions rest on.
 *
 * Without them a finding can neither be filed as a ticket nor disputed: every
 * `expected` rests on a policy the report did not carry, and `foreign-tenant` and
 * `ancestor-tenant` rest on a tenant tree the reader had to reconstruct from the
 * pattern of denials.
 */
/**
 * What to reproduce a finding with.
 *
 * There are no credential headers here and there cannot be: they come from the
 * environment, and that is the only place for them. `contextHeaders` are the
 * request-condition attributes declared by a human, without which the line
 * reproduces the baseline case instead of the one that was found.
 */
export interface RequestRecord {
  readonly method: HttpMethod;
  readonly url: string;
  /**
   * The context attributes in their declared form: a string or `{ env: NAME }`.
   *
   * Declared, not resolved: a value from the environment never lands in the
   * report — the variable's name stays there, exactly as with `tokenEnv`.
   */
  readonly contextHeaders?: Readonly<Record<string, ContextAttributeValue>>;
}

/**
 * An observation together with the verdict on its cell.
 *
 * `match: true` means 'tested and agreed with what was declared, by every channel
 * that judged this cell'; this is the only place in the report where a positive
 * result is visible cell by cell rather than as a total. The verdict comes from
 * the same walk as the discrepancies (ADR-0020), narrowed by the checks
 * (ADR-0022).
 */
export interface ReportedObservation extends AccessObservation {
  readonly expected?: ExpectedOutcome;
  readonly match?: boolean;
  /**
   * The kinds of finding recorded against this cell. Absent means none.
   *
   * The reason `match` is `false`, on the line where `match` is. A discrepancy
   * over the status code can be read off the row itself; a body finding cannot —
   * there the expectation, the outcome and the status all agree.
   */
  readonly findingKinds?: readonly string[];
  readonly relation?: ResourceRelation;
  readonly ruleIndex?: number;
}

export interface RunInputs {
  /** The policy with patterns expanded — exactly the one that gave the verdicts. */
  readonly policy: ResolvedAccessPolicy;
  /** The tenant tree. Empty when no hierarchy is declared. */
  readonly tenants: readonly TenantNode[];
  /**
   * How the tool presented itself: the kind of scheme and the name of the header
   * or the cookie. There are no values here and cannot be — they live only in the
   * environment.
   */
  readonly auth: AuthScheme;
  /**
   * The declared request conditions together with their attributes.
   *
   * The attributes are printed: without them 'access under context: geo-blocked'
   * is a claim that can be neither reproduced nor disputed. A human sets the
   * values, and secrets have no place there — exactly as in the rest of the
   * configuration.
   */
  readonly contexts: readonly ReportedContext[];
  /**
   * Endpoints the operator excluded by hand.
   *
   * Saying nothing here read as 'nothing was excluded': the operator could take an
   * endpoint out of the run, and the report said nothing about it.
   */
  readonly exclude: readonly string[];
  /**
   * The request limits that were in force.
   *
   * There is no other way to check the invariant 'throttling is always on' from
   * the report — it has to be taken on trust.
   */
  readonly throttle?: ThrottleLimits;
}

export interface ReportedContext {
  readonly id: string;
  readonly description?: string;
  /** The declared form: a string or `{ env: NAME }`. No environment values here. */
  readonly headers: Readonly<Record<string, ContextAttributeValue>>;
  readonly query: Readonly<Record<string, ContextAttributeValue>>;
  readonly endpointIds: readonly string[];
  /** The accounts they applied to. Empty means all of them. */
  readonly accountIds: readonly string[];
}

/**
 * What exactly was tested and what was not.
 *
 * Answers the question the report was missing most: 'six endpoints — what
 * percentage of the surface is that?'. Without a denominator the count of what was
 * probed means nothing, and the absence of a finding on what was not tested reads
 * as 'clean'.
 */
export interface Coverage {
  /** How many endpoints the source gave — a specification, a list or a collection. */
  readonly endpointsTotal: number;
  /** How many of them were actually probed. */
  readonly endpointsProbed: number;
  readonly cellsObserved: number;
  /** Cells the policy declared but which were not observed. */
  readonly cellsNotObserved: number;
  /** Why endpoints were not probed, by reason. */
  readonly notProbed: Readonly<Record<string, number>>;
  /**
   * The endpoints on which bodies were compared.
   *
   * Named one by one on purpose: on every other one the absence of a finding means
   * 'no comparison was made', not 'nothing matched'. There is no other way to see
   * the difference.
   */
  readonly bodiesComparedOn: readonly string[];
  /** Whether methods that change state were performed. */
  readonly writeMethodsProbed: boolean;
  /**
   * The checks that actually ran, and the clauses each one answers for.
   *
   * All of them are listed, the ones that found nothing included. Otherwise a
   * check that someone forgot to register, or that crashed, gives a report
   * indistinguishable from a clean one: its key shows up in `byKind` only once it
   * has found something.
   *
   * The clauses are here because they were nowhere. `Check.standards` was
   * declared, filled and **read by no line of code** — the word did not occur in
   * a report at all — so the traceability the plan promises, from a finding to a
   * clause of an external standard, could not be built out of a saved artifact.
   * Both directions are needed and both are now present: a finding carries its
   * clauses, and this list says which clauses were exercised at all, including by
   * a check that found nothing. That second direction is the whole difference
   * between an evidence pack and a list of findings. Found by the audit of
   * 14 August 2026 (L-4).
   */
  readonly checksRun: readonly CheckRun[];
  /**
   * What each check examined, in the check's own terms.
   *
   * This was `bodyComparison`, a shape belonging to one particular check, and
   * this file imported the type from that check's module — the report layer
   * knowing one plugin by name, which is the arrangement ADR-0003 exists to
   * prevent. A check now reports its own reach through `Check.coverage` and the
   * report carries the counters without knowing what they mean.
   *
   * Why any of it: `bodiesComparedOn` names the endpoints, but saying nothing
   * about a particular pair reads as "nothing matched". On the reference
   * platform the holding and the support account with a set of memberships
   * matched by digest lawfully — they are related — and without the number there
   * was nothing to tell "skipped" from "compared and they differed".
   */
  readonly byCheck: readonly CheckCoverage[];
  /**
   * How the observations came out, by conclusion.
   *
   * Here so that the one question worth asking of a report full of findings can
   * be answered from the report: **was anything ever refused?** A platform that
   * answers `200 OK` with the outcome in the body reads as "allowed" on every
   * cell, and every cell the policy denies then becomes a privilege escalation —
   * a whole report that is wrong, looking exactly like a catastrophe.
   *
   * `denied: 0` with observations present is the signature. It does not settle
   * which of the two it is, and cannot: from status codes alone "refuses with
   * 200" and "grants everything" are the same picture. Both are worth stopping
   * for, which is why the number is stated rather than turned into a verdict.
   * See L-3 and `docs/report.md`.
   */
  readonly outcomes: Readonly<Record<AccessOutcome, number>>;
  /**
   * How many cells were observed under each declared set of conditions.
   *
   * A zero here means 'the conditions are declared but were not tested': their
   * endpoints may have landed in `skipped`, and the absence of findings would read
   * as 'everything is in order under these conditions'. Every declared set of
   * conditions has a key, a zero one included — there must be no silence about
   * conditions.
   */
  readonly contextsProbed: Readonly<Record<string, number>>;
  /**
   * How many cells were observed and nothing was found on them.
   *
   * The reader computed `cellsObserved − findings` himself, and 'tested and clean'
   * existed in the report only as a subtraction. As a number it is checkable:
   * `cellsMatched + cellsWithFindings === cellsObserved`.
   */
  readonly cellsMatched?: number;
  /**
   * How many observed cells carry at least one finding.
   *
   * `summary.findings` counts rows, and one cell can produce several of them at
   * once — a discrepancy over the status code and a body one — so the reader who
   * added `cellsMatched` to it got a number larger than `cellsObserved` and had
   * every reason to conclude the report was lying. Present exactly when
   * `cellsMatched` is: half of an identity is worse than none of it.
   */
  readonly cellsWithFindings?: number;
  /**
   * Resources every account was answered 404 for.
   *
   * Found by the audit of 14 August. A resource that is not there answers 404 to
   * everybody; `not-found` folds into `denied`; and where no rule grants anyone
   * access, every one of its cells agrees with the policy and the report says
   * "tested and agreed". The central claim of the tool — "carol cannot read
   * alice's order" — was then proved by the order not existing.
   *
   * Where an owner **is** granted access the tool already speaks: that account's
   * cell expects `allowed`, gets a denial and lands in `findings` as an
   * unexpected denial. This field is for the other half, where the declaration
   * grants nobody anything and a 404 is indistinguishable from a locked door.
   *
   * Two situations produce it, and neither can be told from the other by status
   * alone: the object is absent, or the platform hides its existence from
   * everyone. Both mean the same thing for a reader — no cell touching this
   * resource says anything about isolation.
   */
  readonly resourcesNotFound: readonly string[];
}

/**
 * A check that ran, and the clauses it answers for.
 *
 * A pair rather than a bare id: an evidence pack is read from the clause
 * inwards — "what covers ASVS 8.4.1" — and a list of identifiers answers only
 * the other direction.
 */
export interface CheckRun {
  readonly id: string;
  readonly standards: readonly StandardRef[];
}

export interface RunReport {
  /**
   * The version of the report's shape.
   *
   * Without it a parser breaks silently at the first change of structure — and the
   * structure has changed three times already.
   */
  readonly schemaVersion: string;
  /** The run's identifier: otherwise two reports cannot be told apart. */
  readonly runId: string;
  /**
   * The configuration's fingerprint.
   *
   * Computed over the parsed configuration, not over the text of the file:
   * comments and formatting do not affect the result of a run, while they would
   * affect a hash. It is there to tell 'the platform changed' from 'we changed the
   * declaration'.
   */
  readonly configDigest: string;
  /**
   * Who produced this file, and where its shape is explained.
   *
   * The audit of 14 August looked for a reference to the documentation and found
   * none: the report carried `schemaVersion: "1"` and a version number, and
   * everything a reader needs to interpret it — what `basis` means, what
   * `findingKinds` says about a cell, how to tell "clean" from "nothing was
   * checked" — is in `docs/report.md`, which the artifact did not name. The receiver of a ticket has the JSON and nothing else.
   *
   * Pinned to the version that produced the file rather than to `main`: a
   * document read a year later must describe the tool that wrote the report, not
   * the one that exists now.
   */
  readonly tool: {
    readonly name: string;
    readonly version: string;
    readonly documentation: string;
  };
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly target: {
    readonly baseUrl: string;
    readonly allowedHosts: readonly string[];
    /**
     * What the system under test is called, declared by a human.
     *
     * Its absence is meaningful: the report does not name the platform, and the
     * reader cannot tell a run against a production-like deployment from a run
     * against a demo polygon. No ticket against the platform can be filed from
     * such an artefact.
     */
    readonly label?: string;
  };
  readonly accounts: readonly {
    readonly id: string;
    readonly role: string;
    /** The set of memberships, when the account sits in several tenants at once. */
    readonly tenants?: readonly string[] | undefined;
    /** Declared without credentials: it makes its requests anonymously. */
    readonly anonymous?: boolean;
    /**
     * The name of the environment variable holding the token — **the name, not
     * the value**.
     *
     * Without it there is nothing to reproduce a finding with: 'add the
     * authentication header of account alice-a' does not say where to get that
     * token.
     */
    readonly tokenEnv?: string;
    /**
     * The original account, when this row is that same account under request
     * conditions.
     *
     * Without it the `@` suffix stays the only carrier of the structure, and it
     * reads as 'a user at a domain' — that is, as a different account.
     */
    readonly baseAccountId?: string;
    /**
     * The request conditions this row exists under.
     *
     * The same account with the same credentials: what changes is the request, not
     * the account. Absent means baseline conditions.
     */
    readonly contextId?: string;
    /**
     * The scheme the account presented itself with. Only the kind and the names,
     * no values. On an anonymous account it means nothing — there is nothing to
     * present.
     */
    readonly auth?: AuthScheme;
    /** Absent on an account outside of tenants: the key is simply not in the JSON. */
    readonly tenant?: string | undefined;
  }[];
  readonly endpoints: readonly Endpoint[];
  /**
   * The resources requested. Without them a finding about broken isolation cannot
   * be verified: it is unclear which resource the access was to.
   */
  readonly resources: readonly Resource[];
  readonly skipped: readonly SkippedEndpoint[];
  readonly failures: readonly ProbeFailure[];
  /**
   * Accounts whose every request came back 401.
   *
   * A non-empty list means the findings cannot be trusted: most likely it is
   * authentication that did not work, not the policy.
   */
  readonly unauthenticated: readonly string[];
  /**
   * How many canaries were checked before the run.
   *
   * A zero means authentication was never confirmed. That has to be visible in the
   * JSON: otherwise the report of an unverified run matches the report of a
   * successful one byte for byte, and the only difference left is a warning on
   * stderr.
   */
  readonly canariesChecked: number;
  /**
   * The result of every canary by name.
   *
   * A counter with no verdict is useless: a report saying '7 checked' with zero
   * findings is indistinguishable from one where the canaries failed silently.
   */
  readonly canaries: readonly CanaryOutcome[];
  /**
   * Accounts whose canary passed before the walk and failed after it.
   *
   * Found by the audit of 14 August. Canaries were probed once, at the start. A
   * token that expires in the middle of a walk — and at the default five
   * requests a second a matrix of ten accounts, sixty endpoints and three
   * resources takes about an hour, longer than a typical JWT — turns every
   * remaining cell into a 401. That reads as a denial, agrees with a policy of
   * denial, and lands in `cellsMatched` as "tested and agreed".
   *
   * `findUnauthenticated` cannot see it by construction: it asks whether an
   * account was granted access **nowhere**, and the first half of the walk
   * succeeded.
   *
   * Non-empty means the tail of the walk says nothing, exactly like `truncated`,
   * and the verdict is 2 for the same reason.
   */
  readonly staleCredentials: readonly string[];
  /** The run was cut short before it reached the end of the matrix. */
  readonly truncated: boolean;
  readonly observations: readonly ReportedObservation[];
  readonly findings: readonly ReportFinding[];

  /** The inputs the conclusions rest on. */
  readonly inputs: RunInputs;
  /** What was tested and what was not. */
  readonly coverage: Coverage;
  /**
   * Discrepancies collapsed to the signatures 'endpoint × kind × relation'.
   *
   * One defect in the platform touches as many cells as there are; without
   * grouping, the report tells the size of the matrix, not the number of problems.
   */
  readonly defects: readonly DefectGroup[];
  readonly summary: ReportSummary;
}

export interface BuildReportOptions {
  readonly version: string;
  readonly config: RunConfig;
  /**
   * The matrix rows, including accounts under the declared conditions.
   *
   * A ready list from the derivation, not a second walk over the same rules: once
   * the two drift apart, they would give a finding referring to an account the
   * report does not have.
   */
  readonly accounts?: readonly Account[];
  readonly endpoints: readonly Endpoint[];
  /** The endpoints that were actually probed. */
  readonly probed?: readonly Endpoint[];
  readonly observations: readonly AccessObservation[];
  readonly skipped: readonly SkippedEndpoint[];
  readonly failures: readonly ProbeFailure[];
  readonly unauthenticated: readonly string[];
  readonly canariesChecked: number;
  readonly canaries?: readonly CanaryOutcome[];
  /** Accounts whose canary passed before the walk and failed after it. */
  readonly staleCredentials?: readonly string[];
  readonly truncated: boolean;
  /** Whether methods that change state were performed. */
  readonly unsafeMethods?: boolean;
  readonly findings: readonly AccessDiff[];
  /** The policy with patterns expanded — the one that gave the verdicts. */
  readonly policy: ResolvedAccessPolicy;
  /** Findings from the registry's checks. Absent means 'no checks were run'. */
  readonly checks?: readonly Finding[];
  /** The identifiers of the checks that ran, the ones that found nothing included. */
  readonly checksRun?: readonly CheckRun[];
  /**
   * The verdicts on the cells — from the same walk that gave the discrepancies.
   *
   * A second source of verdicts here would be the worst one possible: the report
   * would claim 'tested and agreed' about a cell that landed in the findings.
   */
  readonly cells?: readonly CellVerdict[];
  /** The request limits in force — as throttling resolved them, not as flags said. */
  readonly throttle?: ThrottleLimits;
  /** What was compared by body: the pairs compared and those skipped as related. */
  readonly byCheck?: readonly CheckCoverage[];
  readonly startedAt: Date;
  readonly finishedAt: Date;
}

const EMPTY_BY_KIND: Readonly<Record<DiffKind, number>> = {
  "privilege-escalation": 0,
  "unexpected-denial": 0,
  "not-observed": 0,
  "probe-error": 0,
};

const EMPTY_BY_SEVERITY: Readonly<Record<Severity, number>> = {
  info: 0,
  low: 0,
  medium: 0,
  high: 0,
  critical: 0,
};

/**
 * Counts over **all** findings, check findings included.
 *
 * Only matrix discrepancies used to be counted, and the summary showed high: 5
 * where there were 11. A dashboard built on `bySeverity` lost six findings — among
 * them the most exploitable one: a leak from a list endpoint, visible only by the
 * body. Found by a cold read of the report by someone who did not know the project.
 */
function countBySeverity(findings: readonly ReportFinding[]): Readonly<Record<Severity, number>> {
  const counts = { ...EMPTY_BY_SEVERITY };
  for (const finding of findings) {
    counts[finding.severity] += 1;
  }
  return counts;
}

/**
 * Attaches to every finding the request that produced it.
 *
 * Joined on the triple 'account × endpoint × resource' — the same key a cell is
 * identified by everywhere in the project.
 */
/**
 * The key of a matrix cell: account, endpoint, resource.
 *
 * Written out by hand in five places, and the sixth had to agree with all five
 * for a verdict and a finding to meet on the same cell. A separator that cannot
 * occur in an identifier, so that `a|b` and `a` + `|b` are different keys.
 */
function cellKey(of: {
  readonly accountId: string;
  readonly endpointId: string;
  readonly resourceId?: string;
}): string {
  return `${of.accountId}\u0000${of.endpointId}\u0000${of.resourceId ?? ""}`;
}

function mergeFindings(
  diffs: readonly AccessDiff[],
  checks: readonly Finding[],
  observations: readonly AccessObservation[],
  contexts: readonly RequestContextConfig[] = [],
  checksRun: readonly CheckRun[] = [],
): readonly ReportFinding[] {
  // The clauses a check answers for, by its id. Declared on the check since
  // ADR-0003 and read by nothing until L-4.
  const clausesOf = new Map(checksRun.map((check) => [check.id, check.standards]));
  const standardsOf = (checkId: string): readonly StandardRef[] => clausesOf.get(checkId) ?? [];
  // The headers of the declared conditions, keyed by the name of the conditions.
  // A human declared the values in the configuration, and there are no secrets
  // there and cannot be: credentials come only from the environment and never land
  // in the report under any circumstances.
  const headersOf = new Map(
    contexts
      .filter((context) => Object.keys(context.headers).length > 0)
      .map((c) => [c.id, c.headers]),
  );
  const byCell = new Map(observations.map((observation) => [cellKey(observation), observation]));
  function withRequest<
    T extends { accountId?: string; endpointId?: string; resourceId?: string; contextId?: string },
  >(finding: T): T & { request?: RequestRecord } {
    // A run-level finding names no cell, so there is no request to attach and
    // none is invented.
    if (finding.accountId === undefined || finding.endpointId === undefined) {
      return finding;
    }
    const observation = byCell.get(
      cellKey({
        accountId: finding.accountId,
        endpointId: finding.endpointId,
        ...(finding.resourceId === undefined ? {} : { resourceId: finding.resourceId }),
      }),
    );
    if (observation?.url === undefined || observation.method === undefined) {
      return finding;
    }
    // The context attributes are printed next to the address, or else reproducing
    // a finding made under conditions gives the **baseline** case: query
    // parameters are visible in the address, headers are visible nowhere, and the
    // line silently reproduces the wrong thing. Found by a cold read: 43% of the
    // findings were reproduced that way.
    const contextHeaders =
      finding.contextId === undefined ? undefined : headersOf.get(finding.contextId);
    return {
      ...finding,
      request: {
        method: observation.method,
        url: observation.url,
        ...(contextHeaders === undefined ? {} : { contextHeaders }),
      },
      status: observation.status,
    };
  }

  /** The other side's request in a paired finding, if there was one. */
  function relatedRequestOf(check: Finding): { relatedRequest?: RequestRecord } {
    // The field, not `evidence.otherAccountId`. That was a contract between two
    // layers held together by a key name: typed as "some scalar", documented
    // nowhere, and undiscoverable by whoever writes the next check.
    const other = check.relatedAccountId;
    if (other === undefined || check.endpointId === undefined) {
      return {};
    }
    const observation = byCell.get(cellKey({ accountId: other, endpointId: check.endpointId }));
    if (observation?.url === undefined || observation.method === undefined) {
      return {};
    }
    const contextHeaders =
      check.contextId === undefined ? undefined : headersOf.get(check.contextId);
    return {
      relatedRequest: {
        method: observation.method,
        url: observation.url,
        ...(contextHeaders === undefined ? {} : { contextHeaders }),
      },
    };
  }

  const fromMatrix: readonly ReportFinding[] = diffs.map((diff) =>
    withRequest({ ...diff, source: "matrix" as const }),
  );

  /**
   * A check finding that names neither an account nor an endpoint is dropped.
   *
   * The `Finding` type makes both optional, and everything downstream — the
   * request, the defect signature, the whole idea of a cell — used to be keyed
   * by them.
   *
   * The comment that used to stand here said such findings "stay visible only
   * through the counter". That was untrue: `summary.checkFindings` counts the
   * list **after** this filter, so they were visible nowhere at all — a
   * critical finding could arrive and the report would say `findings: 0`,
   * `checkFindings: 0`, verdict clean, while `coverage.checksRun` named the
   * check as having run. Found by the audit of 14 August.
   *
   * **The filter is gone as of 15 August.** A run-level finding — "this clause
   * is not covered by anything" — is the natural shape for the evidence pack,
   * and dropping it was never a property of the report but of one line here.
   * What it needed was for everything downstream to stop assuming a cell:
   * `withRequest` has nothing to attach and attaches nothing, the cell verdict
   * skips it, and the defect signature carries `—` in place of the endpoint. The
   * interim counter `coverage.checksWithUnusableFindings` is gone with it: a
   * field that could only ever be empty is its own kind of lie.
   */
  const fromChecks: readonly ReportFinding[] = checks.map((check) =>
    withRequest({
      kind: check.checkId,
      source: "check" as const,
      severity: check.severity,
      // Both absent on a run-level finding, and both stay absent rather than
      // being filled with a placeholder: a reader who sees an endpoint id
      // believes there was a request.
      ...(check.accountId === undefined ? {} : { accountId: check.accountId }),
      ...(check.endpointId === undefined ? {} : { endpointId: check.endpointId }),
      // The conditions are carried over like everything else. The fields were
      // copied by naming each one, and a new one was silently lost: a check
      // finding made under conditions looked like a baseline one, grouping
      // merged it with the baseline one, and `request` was printed without the
      // attributes. Found by a cold read.
      ...(check.contextId === undefined ? {} : { contextId: check.contextId }),
      title: check.title,
      // Which clauses this finding answers for. Declared on the check since
      // ADR-0003 and read by nothing until now, so the traceability the plan
      // promises could not be built from a saved report.
      ...(standardsOf(check.checkId).length === 0 ? {} : { standards: standardsOf(check.checkId) }),
      ...(check.relatedAccountId === undefined ? {} : { relatedAccountId: check.relatedAccountId }),
      evidence: check.evidence,
      // The second request of the pair. Taken from the observations by the name
      // of the other side: the check knows nothing about transport and stores
      // no addresses.
      ...relatedRequestOf(check),
    }),
  );

  return [...fromMatrix, ...fromChecks];
}

function countGroupsBySeverity(groups: readonly DefectGroup[]): Readonly<Record<Severity, number>> {
  const counts = { ...EMPTY_BY_SEVERITY };
  for (const group of groups) {
    counts[group.severity] += 1;
  }
  return counts;
}

function countByKind(findings: readonly ReportFinding[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = { ...EMPTY_BY_KIND };
  for (const finding of findings) {
    counts[finding.kind] = (counts[finding.kind] ?? 0) + 1;
  }
  return counts;
}

function countByReason(skipped: readonly SkippedEndpoint[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const item of skipped) {
    counts[item.reason] = (counts[item.reason] ?? 0) + 1;
  }
  return counts;
}

/**
 * The account rows, including accounts under conditions.
 *
 * An account under conditions is a matrix row of its own, and that is what a
 * finding refers to. Without such a row in the report the reference dangles: the
 * reader sees `alice-a@geo-blocked`, looks for it in the account list and does not
 * find it.
 */
function withContextAccounts(
  options: BuildReportOptions,
): readonly (AccountConfig & { readonly contextId?: string; readonly baseAccountId?: string })[] {
  const base = options.config.accounts;
  const byId = new Map(base.map((account) => [account.id, account]));
  const derived: (AccountConfig & {
    readonly contextId: string;
    readonly baseAccountId: string;
  })[] = [];
  for (const account of options.accounts ?? []) {
    if (account.contextId === undefined) {
      continue;
    }
    const baseAccountId = principalOf(account);
    const source = byId.get(baseAccountId);
    if (source === undefined) {
      continue;
    }
    // Everything comes from the original account — including `tokenEnv`, on which
    // both the anonymity mark and which scheme gets printed depend.
    derived.push({ ...source, id: account.id, contextId: account.contextId, baseAccountId });
  }
  return [...base, ...derived];
}

/**
 * Puts the verdict next to the observation.
 *
 * An observation used to carry no verdict on principle, and 'it is clean here'
 * existed only as a total: to check a single cell, the reader of the report was
 * rewriting the core in his own language. See ADR-0020.
 */
function withVerdicts(
  options: BuildReportOptions,
  findings: readonly ReportFinding[],
): readonly ReportedObservation[] {
  const cells = options.cells ?? [];
  if (cells.length === 0) {
    return options.observations;
  }
  const byCell = new Map(cells.map((cell) => [cellKey(cell), cell]));
  // Every kind recorded against the cell, from both channels at once.
  //
  // The walk is not the only thing that judges a cell. A check over response
  // bodies judges it too, and against a declaration made by the same human in the
  // same configuration: `responseMustDifferByTenant` is not a heuristic the tool
  // brought along. A cell where the bodies did not differ has not "agreed with
  // what was declared", whatever the status code was.
  const kindsOf = new Map<string, string[]>();
  for (const finding of findings) {
    // Unreachable today, and a type guard rather than a decision: matrix
    // discrepancies always name both, and `mergeFindings` drops a check finding
    // that names neither — reporting it under
    // `coverage.checksWithUnusableFindings` rather than in silence. A finding
    // with no cell cannot narrow the verdict on one.
    if (finding.accountId === undefined || finding.endpointId === undefined) {
      continue;
    }
    const key = cellKey({
      accountId: finding.accountId,
      endpointId: finding.endpointId,
      ...(finding.resourceId === undefined ? {} : { resourceId: finding.resourceId }),
    });
    const kinds = kindsOf.get(key);
    if (kinds === undefined) {
      kindsOf.set(key, [finding.kind]);
    } else if (!kinds.includes(finding.kind)) {
      kinds.push(finding.kind);
    }
  }
  return options.observations.map((observation) => {
    const key = cellKey(observation);
    const cell = byCell.get(key);
    if (cell === undefined) {
      return observation;
    }
    const kinds = kindsOf.get(key);
    return {
      ...observation,
      expected: cell.expected,
      // The walk's verdict **and** the checks. `match` used to be the walk alone,
      // so a cell could be `match: true` and carry a body finding at the same
      // time: twelve of them did on the reference run. A reader who started from
      // the observation closed it as works-as-designed, and both arithmetic
      // self-checks this report offers came out wrong. Found by the audit of
      // 14 August 2026.
      match: cell.match && kinds === undefined,
      // Why it did not agree, next to the cell itself. Without this a body
      // finding leaves an unexplainable row behind: expectation `allowed`,
      // outcome `allowed`, `match: false`, and nothing on the line saying which
      // channel objected.
      ...(kinds === undefined ? {} : { findingKinds: [...kinds].sort() }),
      ...(cell.relation === undefined ? {} : { relation: cell.relation }),
      ...(cell.ruleIndex === undefined ? {} : { ruleIndex: cell.ruleIndex }),
    };
  });
}

/**
 * Where the shape of this report is explained, for the version that wrote it.
 *
 * A tag when the version looks like a release, `main` otherwise — a development
 * build has no tag to point at, and a link into nothing is worse than a link
 * into the newest text.
 */
function documentationUrl(version: string): string {
  const base = "https://github.com/Tarnellion/barbican/blob";
  const ref = /^\d+\.\d+\.\d+$/.test(version) ? `v${version}` : "main";
  return `${base}/${ref}/docs/report.md`;
}

/**
 * The observations by conclusion, with every key present.
 *
 * Every key, a zero one included: `denied: 0` is the whole point of the field,
 * and a missing key would have to be read as a zero by a reader who thought to
 * look for it.
 */
function countByOutcome(
  observations: readonly AccessObservation[],
): Readonly<Record<AccessOutcome, number>> {
  const counts: Record<AccessOutcome, number> = {
    allowed: 0,
    denied: 0,
    "not-found": 0,
    error: 0,
  };
  for (const observation of observations) {
    counts[observation.outcome] += 1;
  }
  return counts;
}

/**
 * Resources that answered 404 to every account that asked.
 *
 * Only cells that produced an answer count: a request that failed says nothing
 * about whether the object is there. A resource nobody reached at all does not
 * appear here either — that is a different gap, and `cellsNotObserved` carries it.
 */
function resourcesNeverFound(observations: readonly AccessObservation[]): readonly string[] {
  const answered = new Map<string, { total: number; missing: number }>();
  for (const observation of observations) {
    if (observation.resourceId === undefined || observation.outcome === "error") {
      continue;
    }
    const seen = answered.get(observation.resourceId) ?? { total: 0, missing: 0 };
    seen.total += 1;
    seen.missing += observation.outcome === "not-found" ? 1 : 0;
    answered.set(observation.resourceId, seen);
  }
  return [...answered]
    .filter(([, seen]) => seen.total > 0 && seen.total === seen.missing)
    .map(([resourceId]) => resourceId)
    .sort();
}

/** How many cells were observed under each set of conditions, untested included. */
function countByContext(options: BuildReportOptions): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const context of options.config.contexts) {
    counts[context.id] = 0;
  }
  const contextOf = new Map(
    (options.accounts ?? [])
      .filter((account) => account.contextId !== undefined)
      .map((account) => [account.id, account.contextId]),
  );
  for (const observation of options.observations) {
    const contextId = contextOf.get(observation.accountId);
    if (contextId !== undefined) {
      counts[contextId] = (counts[contextId] ?? 0) + 1;
    }
  }
  return counts;
}

export function buildReport(options: BuildReportOptions): RunReport {
  // The findings first: a verdict on a cell depends on them, and merging depends
  // on the raw observations rather than on the verdicts, so the order is forced.
  const merged = mergeFindings(
    options.findings,
    options.checks ?? [],
    options.observations,
    options.config.contexts,
    options.checksRun ?? [],
  );
  const observations = withVerdicts(options, merged);
  const notObserved = options.findings.filter((finding) => finding.kind === "not-observed").length;
  // The other side of a paired finding sits in `evidence`: grouping does not see
  // it, and without it a group names one side of the leak out of two.
  const groups = groupDefects(
    merged
      // A defect group answers "how many distinct breakages of the platform".
      // A run-level finding — "this clause is covered by nothing" — is a
      // statement about the run, not about the platform, and grouping it by a
      // signature made of an endpoint it does not have would be a category
      // error. It still counts in `summary.findings`; what holds is
      // `sum(defects[].violations) + run-level findings === summary.findings`.
      .filter(
        (finding): finding is ReportFinding & { accountId: string; endpointId: string } =>
          finding.accountId !== undefined && finding.endpointId !== undefined,
      )
      .map((finding) =>
        finding.relatedAccountId === undefined
          ? finding
          : { ...finding, counterpartAccountId: finding.relatedAccountId },
      ),
  );
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    runId: randomUUID(),
    configDigest: createHash("sha256")
      .update(JSON.stringify(options.config))
      .digest("hex")
      .slice(0, 16),
    tool: {
      name: "barbican",
      version: options.version,
      documentation: documentationUrl(options.version),
    },
    startedAt: options.startedAt.toISOString(),
    finishedAt: options.finishedAt.toISOString(),
    target: {
      baseUrl: options.config.target.baseUrl,
      allowedHosts: options.config.target.allowedHosts,
      ...(options.config.target.label === undefined ? {} : { label: options.config.target.label }),
    },
    accounts: withContextAccounts(options).map((account) => ({
      id: account.id,
      role: account.role,
      tenant: account.tenant,
      // The set of memberships is printed just like a single tenant. Without this
      // an account with a set looked in the report like an account with no tenant
      // at all — that is, indistinguishable from an anonymous one — even though
      // the verdicts on it are correct.
      tenants: account.tenants,
      // An account without credentials is declared anonymous. Without an explicit
      // mark the report's only positive conclusion — 'the anonymous account got
      // 401 everywhere' — is unprovable: an account whose token was passed wrongly
      // would look the same.
      anonymous: account.tokenEnv === undefined,
      // The name of the variable, not the value. It sits in the configuration
      // anyway, the one that is meant to be committed, and without it the reader
      // of the report does not know which token to reproduce the finding with.
      // Found by a third cold read.
      ...(account.tokenEnv === undefined ? {} : { tokenEnv: account.tokenEnv }),
      // The conditions this row exists under. Absent means baseline.
      ...(account.contextId === undefined
        ? {}
        : { contextId: account.contextId, baseAccountId: account.baseAccountId }),
      // Which surface the account went through. Not written at all for an
      // anonymous one: it has nothing to present, and a scheme recorded there only
      // confused. Without this the reader cannot tell 'the endpoint is closed'
      // from 'we knocked with the wrong transport': both give 401. Only the kind
      // of scheme and the name of the header or the cookie here — no values
      // anywhere.
      ...(account.tokenEnv === undefined
        ? {}
        : {
            // By the original account: the scheme is a property of the surface,
            // not of a matrix row. A row under conditions used to look the scheme
            // up by its own id, fail to find it and print the root one — that is,
            // the field lied exactly where it is the only thing needed: 'the
            // endpoint is closed' against 'we knocked with the wrong transport'.
            // Found by a cold read.
            auth:
              options.config.accountAuth.get(account.baseAccountId ?? account.id) ??
              options.config.auth,
          }),
    })),
    endpoints: options.endpoints,
    resources: options.config.resources,
    skipped: options.skipped,
    failures: options.failures,
    unauthenticated: options.unauthenticated,
    canariesChecked: options.canariesChecked,
    canaries: options.canaries ?? [],
    staleCredentials: options.staleCredentials ?? [],
    truncated: options.truncated,
    observations,
    findings: merged,
    coverage: {
      endpointsTotal: options.endpoints.length,
      endpointsProbed: options.probed?.length ?? options.endpoints.length - options.skipped.length,
      cellsObserved: options.observations.length,
      cellsNotObserved: notObserved,
      notProbed: countByReason(options.skipped),
      bodiesComparedOn: options.endpoints
        .filter((endpoint) => endpoint.responseMustDifferByTenant === true)
        .map((endpoint) => endpoint.id),
      writeMethodsProbed: options.unsafeMethods ?? false,
      checksRun: options.checksRun ?? [],
      byCheck: options.byCheck ?? [],
      contextsProbed: countByContext(options),
      resourcesNotFound: resourcesNeverFound(options.observations),
      outcomes: countByOutcome(options.observations),
      // Counted from the verdicts themselves, not by subtraction. Subtraction
      // lied: among the discrepancies there are `not-observed` ones that have no
      // observation at all, and the number came out too low. ADR-0020 promises
      // equality with the number of observations that carry `match: true` — now it
      // is one and the same number, not two. Found by adversarial review.
      //
      // The key is absent entirely when no verdicts were computed: a zero would
      // read as 'not a single cell agreed', that is, as a claim about the
      // platform, while what has to be said is 'we did not count this'.
      ...(options.cells === undefined
        ? {}
        : {
            cellsMatched: observations.filter((observation) => observation.match === true).length,
            // Cells, not rows of `findings`. One cell can carry several findings
            // at once — a discrepancy over the status code and a body one — and
            // `summary.findings` counts them separately, so the identity the
            // documentation offered the reader did not hold on any run with more
            // than one channel firing. Counting the cells here means the reader
            // adds two numbers instead of deduplicating a list by three fields.
            cellsWithFindings: observations.filter(
              (observation) => observation.findingKinds !== undefined,
            ).length,
          }),
    },
    inputs: {
      policy: options.policy,
      tenants: options.config.tenants ?? [],
      auth: options.config.auth,
      exclude: options.config.exclude,
      ...(options.throttle === undefined ? {} : { throttle: options.throttle }),
      contexts: options.config.contexts.map((context) => ({
        id: context.id,
        ...(context.description === undefined ? {} : { description: context.description }),
        headers: context.headers,
        query: context.query,
        endpointIds: context.endpointIds,
        accountIds: context.accountIds,
      })),
    },
    defects: groups,
    summary: {
      endpoints: options.endpoints.length,
      accounts: options.config.accounts.length,
      accountRows: (options.accounts ?? options.config.accounts).length,
      resources: options.config.resources.length,
      observations: options.observations.length,
      skipped: options.skipped.length,
      failures: options.failures.length,
      // The length of the common list, not the number of matrix discrepancies.
      // The neighbouring counters already counted everything, and one number out
      // of five differed from the rest by exactly the findings by body. The same
      // class as the earlier bySeverity bug, in the same object — found by a
      // second cold read.
      findings: merged.length,
      byKind: countByKind(merged),
      bySeverity: countBySeverity(merged),
      defectGroups: groups.length,
      defectsBySeverity: countGroupsBySeverity(groups),
      checkFindings: merged.filter((finding) => finding.source === "check").length,
    },
  };
}

/**
 * The share of failed requests past which the result cannot be trusted.
 *
 * Half. A smaller share is ordinary partial failure: it is visible in `failures`
 * and in `byKind`, but it does not cancel the conclusions about the surviving part
 * of the matrix. A larger one means the report describes the state of the network
 * or of the deployment, not the platform.
 */
const UNTRUSTWORTHY_ERROR_SHARE = 0.5;

/** The verdict on a run: the code CI acts on, and the sentence a human reads. */
export interface RunVerdict {
  readonly code: 0 | 1 | 2;
  readonly reason: string;
}

/**
 * The verdict on a run.
 *
 * 0 — tested and clean, 1 — a discrepancy was found, 2 — the run is untrustworthy.
 *
 * Telling 0 from 2 matters on principle. Adversarial review showed three ways to
 * get a 'clean' report having tested nothing: a specification without a single
 * endpoint, a deployment answering with nothing but errors, and an exhausted
 * request budget. In all three cases there are no findings exactly because there
 * was no testing either — and a 0 would read as confirmation of being protected.
 *
 * The reason travels with the code because the summary could not explain itself.
 * A cold read of 14 August saw "Distinct defects: at least 1" printed next to
 * exit 0 and concluded the exit code could not be trusted — it was a
 * low-severity probe error, which by the contract does not fail a run. The
 * contract was right and invisible. Deriving the sentence anywhere else would
 * give two sets of rules that agree until they do not.
 */
export function runVerdict(report: RunReport): RunVerdict {
  if (report.summary.observations === 0) {
    return { code: 2, reason: "not a single cell was probed — there is nothing to conclude from" };
  }
  // A run cut short did not test the tail of the matrix: there are no findings
  // there because nothing ever got to them. Found by adversarial review — an
  // exhausted request ceiling gave exit code 0 with a cross-tenant leak untested.
  if (report.truncated) {
    return {
      code: 2,
      reason:
        "the run was cut short: the tail of the matrix was never probed, and the " +
        "absence of findings there means nothing",
    };
  }
  // The same class as `truncated`, arriving from the other end: there the tail
  // was never walked, here it was walked by an account that had stopped being
  // authenticated. Both leave cells whose denials mean nothing, and both make the
  // whole result untrustworthy rather than merely incomplete.
  if (report.staleCredentials.length > 0) {
    return {
      code: 2,
      reason:
        `credentials went stale during the run: ${report.staleCredentials.join(", ")} — ` +
        `every cell probed after that point recorded a refusal that says nothing ` +
        `about access`,
    };
  }
  if (report.unauthenticated.length > 0) {
    return {
      code: 2,
      reason: `accounts granted access nowhere: ${report.unauthenticated.join(", ")} — most likely the tokens, not the policy`,
    };
  }
  // Not a single canary means authentication is confirmed by nothing. The
  // `findUnauthenticated` safeguard does not help here by construction: it is
  // built as 'declared accessible, but granted nowhere', and a policy made of
  // denials alone declares nothing accessible, so it stays silent.
  //
  // Found by adversarial review: the deployment answered 401 to everything, the
  // tokens were stale, and the report came out clean with exit code 0 — and with
  // `match: true` on each of the twelve cells at that. This is exactly the case
  // the 2 exists for: what was not tested is never clean.
  //
  // Accounts without credentials are excluded from the rule: an anonymous run —
  // 'check that nobody at all can get in here' — has nothing to authenticate, and
  // demanding a canary of it would forbid a legitimate scenario.
  if (report.canariesChecked === 0 && report.accounts.some((account) => !account.anonymous)) {
    return {
      code: 2,
      reason: "no canary was checked: nothing confirms the accounts were authenticated at all",
    };
  }
  // A threshold, not 'every single one'. The previous condition required **all**
  // cells to fail: 99 errors out of a hundred gave exit code 0, that is 'tested,
  // clean' about a matrix of which one percent survived. Half is the line past
  // which the report stops claiming anything; it is declared here as a constant,
  // because a number hidden inside an expression is one nobody will dispute.
  const probeErrors = report.summary.byKind["probe-error"] ?? 0;
  if (probeErrors >= report.summary.observations * UNTRUSTWORTHY_ERROR_SHARE) {
    return {
      code: 2,
      reason:
        `${probeErrors} of ${report.summary.observations} cells failed to answer: the ` +
        `report describes the state of the network or of the deployment, not the platform`,
    };
  }
  // A discrepancy is a discrepancy whichever way it points. The tool cannot tell
  // which side is wrong — the platform or the declaration — and since it cannot,
  // it has no right to stay silent. Found while checking the platform's oracle:
  // the holding was denied its own brand, and the run returned 0. See ADR-0014.
  //
  // Counted from the findings and by **source**, not out of `summary.byKind`.
  // That map holds kinds of matrix discrepancy and check identifiers in one key
  // space, so a check registered under `privilege-escalation` had its findings
  // read here as matrix ones. Registering such a check is refused now, but this
  // function takes a `RunReport` from anywhere — a consumer assembling one by
  // hand never passes the registry. Found by the audit of 14 August (B-4).
  const ofKind = (kind: DiffKind) =>
    report.findings.filter((finding) => finding.source === "matrix" && finding.kind === kind)
      .length;
  const escalations = ofKind("privilege-escalation");
  const denials = ofKind("unexpected-denial");
  if (escalations > 0 || denials > 0) {
    return {
      code: 1,
      reason:
        escalations > 0
          ? `privilege escalation: ${escalations} ${escalations === 1 ? "cell" : "cells"}`
          : `unexpected denials: ${denials} — the platform and the declaration disagree, and the tool cannot tell which is wrong`,
    };
  }
  // A check finding is the same discrepancy as an escalation, just seen by
  // something other than the status. Staying silent about it in the exit code
  // would mean a run with a cross-tenant leak found looks successful in CI.
  //
  // **Any severity but `info`**, which is the same threshold the matrix channel
  // has. It used to demand `high|critical`, so a check reporting a `medium`
  // disagreement between the platform and a declaration left the run green while
  // an identical disagreement seen by status failed it — two thresholds for one
  // principle, and ADR-0014 states the principle. `info` is the level for a note
  // rather than a disagreement, and it is what a check uses to say something
  // without failing a build. Found by the audit of 14 August (B-3).
  const bySignal = report.findings.filter(
    (finding) => finding.source === "check" && finding.severity !== "info",
  ).length;
  if (bySignal > 0) {
    return { code: 1, reason: `${bySignal} found by the response body rather than by status` };
  }

  // The line a cold read needed: "Distinct defects: at least 1" next to exit 0
  // reads as "a defect was found and the build is green" unless the summary says
  // out loud that nothing above the threshold was among them.
  return {
    code: 0,
    reason:
      report.summary.findings === 0
        ? "no discrepancy with the declared policy"
        : "no discrepancy that fails a run — the rows above are notes, not access holes",
  };
}

/**
 * The process exit code. The reasoning behind it — {@link runVerdict}.
 *
 * Kept as a function of its own because that is what a library consumer wants
 * from CI, and because every caller that only needs the number should not have
 * to reach through an object to get it.
 */
export function exitCodeFor(report: RunReport): number {
  return runVerdict(report).code;
}

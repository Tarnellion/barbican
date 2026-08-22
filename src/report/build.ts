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
// `CheckRun` is shaped in the core and not here. Every field of it is the
// check's own — its id, what it asserts, the clauses it answers for — and this
// file's business is to carry it, not to decide what goes in. It was declared
// here, and `description` was the field the mapping that built it left out.
// See `describeChecks`.
import { standardsForDiff } from "../core/checks/clauses.js";
import type {
  CheckCoverage,
  CheckRun,
  ResolvedFinding,
  StandardRef,
} from "../core/checks/types.js";
import type {
  Acceptance,
  AccessDiff,
  AccessObservation,
  AccessOutcome,
  Account,
  CellVerdict,
  DefectGroup,
  DiffKind,
  Endpoint,
  ExpectedOutcome,
  HttpMethod,
  ResolvedAccessPolicy,
  Resource,
  ResourceRelation,
  Severity,
  TenantNode,
} from "../core/index.js";
import {
  citableDefectKey,
  defectSignature,
  groupDefects,
  indexAcceptances,
  isAcceptanceInForce,
  matchingAcceptance,
  principalOf,
  SEVERITY_ORDER,
} from "../core/index.js";
import { byCodeUnits } from "../core/order.js";
// The clause-to-coverage direction. Shaped and computed in the core for the
// reason ADR-0041 gave for keeping `standardsForDiff` there: which clause a cell
// is evidence about is a statement about what a discrepancy means, and the
// report carries what a channel declares rather than deciding it.
import type { ClauseCoverage, ClauseReservation, JudgedCell } from "../core/standards/coverage.js";
import { clauseCoverage } from "../core/standards/coverage.js";
import type {
  AccountConfig,
  ContextAttributeValue,
  RequestContextConfig,
  RunConfig,
  RunTarget,
} from "../io/config.js";
import { lookup, openRecord } from "../io/untrusted.js";
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
  /**
   * Declared accounts — **not** the length of `report.accounts`.
   *
   * The only one of these counters that is not the length of its array, and the
   * one a distrustful reader checks first: `accounts` here is 9 where the array
   * holds 27, because the array carries a row per set of declared conditions.
   * `accountRows` below is that length. Said on this field and not only on that
   * one, because this is the field the reader lands on. Found by the audit of
   * 14 August 2026 (H-5).
   */
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
  /**
   * The counts the verdict is derived from, taken before the evidence cap.
   *
   * The verdict used to be derived by filtering `findings`, and on 17 August 2026
   * that array became the capped one (ADR-0029). The numerator was then bounded
   * at fifty per defect while its denominator, `observations`, was not: **101
   * cells that all failed to answer exited 0** — "checked, and clean" over a run
   * that reached nothing. Reachable inside the default request budget, and the
   * single worst class of defect this tool exists to find.
   *
   * `byKind` could not be used instead, and the reason is B-4: it holds kinds of
   * matrix discrepancy and check identifiers in one key space, so a check
   * registered under `privilege-escalation` would be read here as a matrix one.
   * `runVerdict` takes a report from anywhere and never sees the registry that
   * refuses such a name. So the counts it needs are separated by **source** at
   * the one place the source is known, and carried here.
   *
   * Additive: a reader written against schema `2` does not break on a field it
   * does not know. See ADR-0029's addendum.
   */
  readonly verdictInputs: VerdictCounts;
  /**
   * What the `accepted:` declarations did to this run.
   *
   * Four numbers and a breakdown, and the reason there are four is that a reader
   * of a report with a green verdict has to be able to ask three different
   * questions of it: how much is being held out of the verdict, how much of that
   * has lapsed, and how many declarations covered nothing at all. See ADR-0048.
   *
   * Additive, like `verdictInputs` before it: a reader written against schema
   * `2` does not break on a field it does not know.
   */
  readonly accepted: AcceptanceCounts;
}

/**
 * How many findings the acceptances held, and how many of them stopped holding.
 *
 * The identity worth checking, for every matrix kind: `byKind[k]` minus
 * `accepted.byKind[k]` is `verdictInputs.matrixByKind[k]`. It is what makes
 * "counters that tell the truth" a statement a reader can verify rather than a
 * promise — the whole objection to suppression is that the numbers stop meaning
 * what they say.
 */
export interface AcceptanceCounts {
  /** Entries in the configuration's `accepted:` section. */
  readonly declared: number;
  /** Finding rows an acceptance is holding out of the verdict right now. */
  readonly findings: number;
  /**
   * Rows whose acceptance has lapsed.
   *
   * These are **not** in `findings` and **are** in `verdictInputs`: past its day
   * an acceptance stops holding, which is the difference between this mechanism
   * and a silencer. The rows keep the mark, with `expired: true` on it, because
   * "found and once accepted" is what explains a run that has just started
   * failing again.
   */
  readonly expired: number;
  /**
   * Declarations that covered no finding on this run.
   *
   * Either the platform was fixed — in which case the line should be deleted —
   * or the run never reached those cells, in which case `coverage.notProbed`
   * says why. The report cannot tell the two apart and does not guess.
   */
  readonly unused: number;
  /**
   * The rows in `findings` above, by kind.
   *
   * By kind and not only as a total, because that is what makes the identity at
   * the head of this type checkable from the file alone. `findings[]` cannot
   * answer it: the evidence rows are capped.
   */
  readonly byKind: Readonly<Record<string, number>>;
}

/**
 * One `accepted:` declaration, and what it did.
 *
 * `defect` is the citable key rather than the three fields it was written from,
 * built by the same function that names `defects[].key`: the reader with the
 * JSON and nothing else can line the two up by eye, and a ticket quoting one
 * quotes the other.
 */
export interface ReportedAcceptance {
  /** The defect, in the words `defects[].key` uses. */
  readonly defect: string;
  /** The way that defect showed itself: a kind of discrepancy, or a check id. */
  readonly kind: string;
  readonly reason: string;
  /** The last day it holds, `YYYY-MM-DD`, inclusive, UTC. */
  readonly until: string;
  readonly ticket?: string;
  /** Whether the day had passed when this run started. */
  readonly expired: boolean;
  /** How many finding rows it covered. Zero is the case worth reading. */
  readonly matched: number;
}

/**
 * The mark an accepted finding carries, on the row itself.
 *
 * The row keeps its kind, its severity, its request and its clauses; what this
 * adds is who said it was known and until when. Nothing here is derived — the
 * reason and the date are the operator's own words, copied.
 */
export interface AcceptedMark {
  readonly reason: string;
  readonly until: string;
  readonly ticket?: string;
  /**
   * Whether the deadline had passed when the run started.
   *
   * `true` means the row counts in the verdict again, and the mark is kept
   * anyway: a run that has just started failing over something that was accepted
   * until last week is explained by this field and by nothing else in the file.
   */
  readonly expired: boolean;
}

/**
 * What `runVerdict` counts, uncapped and separated by source.
 *
 * Not derivable from anything else in the file once rows are capped, which is
 * exactly why it is a field.
 */
export interface VerdictCounts {
  /** Matrix discrepancies by kind. Check findings are not in here. */
  readonly matrixByKind: Readonly<Record<DiffKind, number>>;
  /**
   * Check findings of any severity but `info`.
   *
   * `info` is the level a check uses to say something without failing a build;
   * every other level is a disagreement between the platform and a declaration,
   * which is the same threshold the matrix channel has. See ADR-0014 and B-3.
   */
  readonly failingCheckFindings: number;
}

/** The outcome of one canary: who, where, and whether authentication held. */
export interface CanaryOutcome {
  readonly accountId: string;
  readonly endpointId: string;
  readonly status: number;
  readonly authenticated: boolean;
  /**
   * What the same endpoint answered to a request with no credentials.
   *
   * The reader of the report gets to see what the run checked: a canary that
   * distinguishes shows a refusal here, and one that does not is a canary the
   * run refused to start on. Absent where the credentialed request did not
   * succeed, and where the anonymous one failed on the wire. See ADR-0040.
   */
  readonly anonymousStatus?: number;
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
   * From the check that produced it, and — since 21 August 2026 — from
   * `standardsForDiff` for a matrix discrepancy. The comment that stood here
   * said matrix discrepancies carry none, "they come from the declared policy,
   * not from a check mapped onto a standard". Formally true and a dead end: the
   * matrix channel is privilege escalation and cross-tenant access, which is
   * everything this tool is written for, so a traceability matrix built from a
   * saved report covered one registered check and none of that. Found as M-11;
   * see ADR-0041.
   *
   * Both directions of the citation are meant. On an escalation the clause is
   * the control the platform broke; on an unobserved cell or a failed probe it
   * is the control this run left unproved, which is a statement an evidence pack
   * needs to attach to the same clause rather than to nothing. `kind` and
   * `severity` on the same row say which of the two it is.
   *
   * Still optional, and the reason is narrower than it looks: every finding this
   * file produces has clauses today, and a check registered by a consumer of the
   * library may declare an empty `standards`.
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
  /**
   * What declared the expectation, and which rule if a rule did.
   *
   * Every matrix finding has carried both since cell verdicts existed — they
   * arrive through the spread from `AccessDiff` — and this interface declared
   * neither until 17 August 2026. So a consumer typed against `ReportFinding`
   * could not read the two fields `docs/report.md` devotes a whole section to,
   * while the values sat in the object. The same shape as `AccessDiff.basis`,
   * which was closed the same day one layer down; found by adversarial review.
   *
   * Absent on a check finding: a check does not compare against the policy, so
   * there is no rule behind what it found.
   */
  readonly basis?: "rule" | "fallback";
  /** The rule's position in `inputs.policy.rules`. Only when `basis` is `rule`. */
  readonly ruleIndex?: number;
  /**
   * The response headers, redacted as everywhere else.
   *
   * A finding carried a status and no headers, and those are the one thing that
   * tells "the endpoint is closed" from "we knocked with the wrong transport":
   * a 401 with `www-authenticate` is the platform naming a scheme we did not
   * use. The reader had the triple and could join to the observation by hand,
   * and a finding is what gets pasted into a ticket. Found by the audit of
   * 14 August 2026 (H-7).
   */
  readonly headers?: Readonly<Record<string, string>>;
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
   * Present when an `accepted:` declaration names this finding.
   *
   * The row is here either way — that is the point of ADR-0048 — and this is
   * what says whether it counted towards the verdict. `expired: true` on the
   * mark means it did.
   *
   * A run-level finding never carries one: an acceptance is addressed by defect
   * coordinates, and a statement about the run has none.
   */
  readonly accepted?: AcceptedMark;
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
   * Which account sent it.
   *
   * On a list endpoint both sides of a paired finding ask the same address — the
   * two requests differ only by the credentials, and those are not in the report
   * and will not be. So `relatedRequest` came out byte for byte equal to
   * `request`, and a reader had two identical lines and no way to tell which was
   * whose. Found by the audit of 14 August 2026 (H-6).
   *
   * The account, not the token: the account id is already all over this report,
   * and it is what turns `curl` with the right `Authorization` into the right
   * `curl`.
   */
  readonly as: string;
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
  /**
   * What declared the expectation: a rule of the policy, or the fallback.
   *
   * Present exactly when `expected` is — both come from the cell verdict, and a
   * row with an expectation and no grounds for it is the state this field was
   * introduced to end. `ruleIndex` names the rule when `basis` is `"rule"`;
   * absence of `ruleIndex` on its own cannot be told from a field the tool
   * failed to fill in, which is why the core says it in a field.
   *
   * Typed from `CellVerdict` rather than restating the two words: the vocabulary
   * belongs to the core, and a copy of it here would be one more shape described
   * twice.
   */
  readonly basis?: CellVerdict["basis"];
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
  readonly auth: ReportedAuthScheme;
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

/**
 * A row of `accounts`: a declared account, or that same account under one
 * declared set of request conditions.
 *
 * A type of its own rather than a shape written inline in `RunReport`, so that
 * the mapping that fills it has something to satisfy in full — the half of the
 * cure `describeChecks` applied to `CheckRun`. See `reportedAccount`.
 */
export interface ReportedAccount {
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
   *
   * **Declared and probed**, not merely declared. The list used to be filtered
   * out of every endpoint the source gave, while the check runs on observations —
   * which exist only for the ones a request went to. So an endpoint carrying
   * `responseMustDifferByTenant` and then excluded, or skipped as an unsafe
   * method, was named here as compared. That is the field lying in the one
   * direction it exists to prevent: claiming a comparison that did not happen.
   * Found by the audit of 14 August 2026 (B-5).
   *
   * How many pairs were actually compared on each is `byCheck`, from the check
   * itself. Being on this list means the question was asked, not that there was a
   * pair to ask it of.
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
   * Every clause this run reached, and what it did about it.
   *
   * The second direction of the citation, for both channels at once.
   * `checksRun` above has always had it for registered checks — the clauses a
   * check answers for, named whether or not it found anything. The matrix
   * channel had no such list, so a clause exercised across nine hundred agreeing
   * cells appeared in an evidence pack only if one of them broke: the pack could
   * say "here is what failed under 8.2.2" and not "8.2.2 was exercised across
   * the surface and holds", which is the sentence a certifying body asks for.
   * ADR-0041 recorded the gap; ADR-0052 closes it.
   *
   * **Nothing here is a ratio, on purpose.** A percentage is the shape this
   * record could most easily lie in: it hides its denominator, and the
   * denominator is the whole question. Each row carries the cells that concluded
   * and the cells that did not — by reason, with every reason present — so that
   * "exercised: 900" cannot be read without "and 140 cells said nothing".
   *
   * And each row carries the run-level reservations that stop "exercised" from
   * meaning "holds": an endpoint never probed, a walk cut short, credentials
   * nothing confirmed, a platform whose refusals this tool cannot recognise.
   * Claiming a clause covered over a surface the tool structurally could not see
   * is worse than claiming nothing, and it is the same class of failure as a
   * falsely clean run.
   *
   * Additive: a reader written against schema `2` is not broken by a field it
   * does not know.
   */
  readonly clauses: readonly ClauseCoverage[];
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
   * affect a hash. It is there to tell 'the platform changed' from 'we changed
   * the declaration'.
   *
   * Over a **canonical** serialisation since 15 August 2026, and the reason is
   * not hypothetical: `accountAuth` is a `Map`, `JSON.stringify` renders a `Map`
   * as `{}`, and so the per-account authentication schemes did not enter the
   * digest at all. Two runs presenting entirely different credentials — one as an
   * `x-api-key` header, the other as a `sid` cookie — produced the same
   * fingerprint. Changing how the accounts authenticate is precisely "we changed
   * the declaration", which is the one question this field exists to answer.
   * Found by the audit of 14 August (H-11).
   *
   * Keys are sorted too. That was the audit's own claim and it was **wrong** when
   * measured — `parseRunConfig` builds its result in a fixed order, so reordering
   * the YAML already gave the same digest. Sorting is kept as insurance rather
   * than as a fix: the guarantee should belong to this function and not to the
   * incidental construction order of another one.
   */
  readonly configDigest: string;
  /**
   * The report's fingerprint of itself, over everything but this field.
   *
   * Three fields identified a run — `runId`, `configDigest`, `tool.version` —
   * and none of them identified the **artifact**. `createHash` occurred once in
   * this file and it hashed the configuration, so the document could be opened
   * in a text editor, have a row taken out of `findings` and a sentence
   * rewritten in `verdict.reason`, and nothing inside it would object. The
   * provenance npm publishes attests to the package, not to what a run of it
   * produced. Under ADR-0002 the edit is not contained either: HTML and PDF are
   * rendered from this file, so a doctored JSON carries into every form of the
   * document.
   *
   * `checkContentDigest` is what recomputes it — over the parsed document, so
   * that reindenting the file does not read as tampering.
   *
   * **It catches carelessness and not malice**, and ADR-0051 says so in the
   * decision rather than in a footnote: anyone who can change a row can
   * recompute this value. A signature is the other half and is deliberately not
   * done — where the key lives and who holds the public half are decisions this
   * one does not make.
   *
   * Additive: a reader written against schema `2` is not broken by a field it
   * does not know.
   */
  readonly contentDigest: string;
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
  readonly accounts: readonly ReportedAccount[];
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
  /**
   * Accounts whose canary could not be probed after the walk, because the run
   * had reached its own ceiling.
   *
   * The third way past the rule of ADR-0033, and the one the tool itself leads
   * an operator into. `--dry-run` counted the canary requests once while the run
   * makes them twice, so a ceiling it called sufficient stops the second pass;
   * every result of that pass then carries a terminal failure, which is our own
   * doing rather than a dead token. Saying "the credentials went stale" there
   * would send the reader after the wrong thing — so this is a separate field,
   * and `truncated` is not it either: the matrix **was** walked to the end, and
   * that reason would be false.
   *
   * What is unproved is narrower and worth its own sentence: the tokens were
   * confirmed before the walk and never confirmed after it. Found by the audit
   * of 20 August 2026 (B-1).
   */
  readonly unverifiedAfterWalk: readonly string[];
  /** The run was cut short before it reached the end of the matrix. */
  readonly truncated: boolean;
  readonly observations: readonly ReportedObservation[];
  /**
   * The evidence rows, at most `MAX_ROWS_PER_DEFECT` of them per defect.
   *
   * Not the whole of what was found — `summary.findings` is that number, and it
   * is counted before the cap, as are `summary.byKind`, `summary.bySeverity`,
   * every entry in `defects` and the verdict itself. So `findings.length` may be
   * smaller than `summary.findings`; `findingsOmitted` is the difference, and a
   * reader who wants the identity back has `findings.length + findingsOmitted
   * === summary.findings`.
   */
  readonly findings: readonly ReportFinding[];
  /**
   * How many evidence rows the cap left out. Zero on nearly every run.
   *
   * A field rather than an inference from two numbers, because the inference is
   * only available to a reader who already knows the cap exists — and the whole
   * point is to tell one who does not.
   */
  readonly findingsOmitted: number;
  /**
   * The `accepted:` declarations, in the order written, and what each one did.
   *
   * Top-level rather than under `inputs`, beside `canaries` and for the same
   * reason: those fields are declarations **and** their outcomes, while `inputs`
   * holds what was declared and nothing about how it went. `matched` and
   * `expired` are outcomes.
   *
   * Empty on a run that accepts nothing, which is nearly every run. See
   * ADR-0048.
   */
  readonly accepted: readonly ReportedAcceptance[];

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
  /**
   * The conclusion, in the artifact rather than only on the terminal.
   *
   * The report carried every input to the verdict and not the verdict: a reader
   * who got the JSON — which is how it travels, attached to a ticket — had to
   * reimplement `runVerdict` to learn whether the run passed, and the whole
   * point of the exit code is that the arithmetic is not obvious. The CI console
   * that had the answer is gone by the time anybody reads the file.
   *
   * Both halves, because the number is for machines and the sentence is for
   * people: `2` says "this cannot be trusted" and the reason says which of the
   * five ways it happened. Found by the audit of 14 August 2026 (H-9).
   */
  readonly verdict: RunVerdict;
  /**
   * What the console said that the numbers do not.
   *
   * The report is read as a file, long after the terminal that printed these is
   * gone. The one this was found by: a run against a target with no `label`
   * warns on stderr and the artifact says nothing — a reader cannot tell a run
   * against production from a run against a demo, and absence of a field does
   * not explain why the field mattered. Found by the audit of 14 August 2026
   * (H-4).
   *
   * Not failures — those are in `verdict` — and not everything the CLI prints:
   * only what is derivable from the report itself, so that the two cannot say
   * different things. The sentences are the same ones the console shows, from
   * the same constants — and that sentence was false for four days. `WARNINGS`
   * did not occur in `src/cli.ts` at all: the CLI wrote its own copies, two of
   * the four had already drifted apart in wording, and `findingsCapped` was
   * never printed on screen, so a run whose evidence rows were dropped said so
   * only here. The CLI now prints **this array**, which makes the claim true of
   * the conditions as well as of the words. Found by the adversarial review of
   * 18 August 2026; held by `tests/cli.test.ts`.
   */
  readonly warnings: readonly string[];
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
  /** Accounts whose canary the run's own ceiling stopped it from probing again. */
  readonly unverifiedAfterWalk?: readonly string[];
  readonly truncated: boolean;
  /** Whether methods that change state were performed. */
  readonly unsafeMethods?: boolean;
  readonly findings: readonly AccessDiff[];
  /** The policy with patterns expanded — the one that gave the verdicts. */
  readonly policy: ResolvedAccessPolicy;
  /** Findings from the registry's checks. Absent means 'no checks were run'. */
  readonly checks?: readonly ResolvedFinding[];
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

/**
 * Takes whatever a mapping did not name, and does not compile when there is any.
 *
 * The mappings below rebuild a structure by naming its fields one at a time,
 * which is the right shape for a published format: the report must not pass on
 * what it does not mean to publish, and spreading a source object into it would
 * answer every future question with "publish it". What such a mapping never had
 * is a way to notice a field added upstream — and this file records two that
 * were lost exactly so: `CheckRun.description`, left out by a mapping in
 * `src/cli.ts` that named `id` and `standards`, and `contextId`, left off a
 * check finding by `mergeFindings` below.
 *
 * Passing the rest of a destructuring through here is that notice. The
 * parameter admits only an object with nothing left in it, so a field added to
 * the source and named by neither half — carried, or withheld with the reason
 * written beside it — stops the build with the one question worth asking: which
 * of the two is it? Found by the audit of 14 August 2026 (B-12).
 */
function nothingLeftUnnamed(_unnamed: Record<string, never>): void {
  // Nothing to do at runtime: the statement has already been checked by the
  // compiler, and the call is only what carries it to the mapping it is about.
}

function mergeFindings(
  diffs: readonly AccessDiff[],
  checks: readonly ResolvedFinding[],
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
        as: observation.accountId,
        ...(contextHeaders === undefined ? {} : { contextHeaders }),
      },
      status: observation.status,
      // The spread, not `headers: observation.headers`. Since E-8 the field is
      // optional on an observation — nothing in the core reads it — and under
      // `exactOptionalPropertyTypes` an optional field means "absent or a
      // record", never "present and undefined". Writing the second one happens
      // to survive here because the literal has no contextual type to be checked
      // against, and a guarantee that rests on that is not one.
      ...(observation.headers === undefined ? {} : { headers: observation.headers }),
    };
  }

  /** The other side's request in a paired finding, if there was one. */
  function relatedRequestOf(check: ResolvedFinding): { relatedRequest?: RequestRecord } {
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
        as: observation.accountId,
        ...(contextHeaders === undefined ? {} : { contextHeaders }),
      },
    };
  }

  const fromMatrix: readonly ReportFinding[] = diffs.map((diff) => {
    // Named field by field, like the check mapping below and for the reason the
    // spread that used to stand here proved.
    //
    // `ReportFinding` does not extend `AccessDiff` — it merges two sources and
    // re-declares what they share — so `{ ...diff }` carried whatever the core
    // put on a discrepancy, declared here or not. `basis` and `ruleIndex` went
    // that way: written on every matrix finding since cell verdicts existed,
    // present in every report, named by this interface nowhere, so a consumer
    // typed against it could not read the two fields `docs/report.md` devotes a
    // section to. A field added to `AccessDiff` tomorrow would publish itself the
    // same way. Found by adversarial review on 17 August 2026.
    //
    // The observation mapping keeps its spread on purpose: `ReportedObservation`
    // **extends** `AccessObservation`, so carrying every field is what that type
    // says it does. A spread is wrong where the target re-declares its fields and
    // right where it inherits them.
    const {
      accountId,
      endpointId,
      contextId,
      resourceId,
      relation,
      expected,
      actual,
      kind,
      basis,
      ruleIndex,
      severity,
      ...unnamed
    } = diff;
    nothingLeftUnnamed(unnamed);
    return withRequest({
      kind,
      source: "matrix" as const,
      severity,
      accountId,
      endpointId,
      // The clauses this discrepancy answers for, from the same declarations the
      // registered checks cite. Never empty, so no conditional spread: the
      // mapping answers for every kind, and a row with no clause on it is the
      // state M-11 was written from. See `standardsForDiff` and ADR-0041.
      standards: standardsForDiff(kind, relation),
      expected,
      ...(actual === undefined ? {} : { actual }),
      ...(contextId === undefined ? {} : { contextId }),
      ...(resourceId === undefined ? {} : { resourceId }),
      ...(relation === undefined ? {} : { relation }),
      ...(basis === undefined ? {} : { basis }),
      ...(ruleIndex === undefined ? {} : { ruleIndex }),
    });
  });

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
  const fromChecks: readonly ReportFinding[] = checks.map((check) => {
    // Every field of the finding named, and the remainder asserted empty. This
    // is the mapping `contextId` was lost by; naming the fields is still right,
    // and what was missing is the compiler noticing the next one that appears.
    // See `nothingLeftUnnamed`.
    const {
      checkId,
      severity,
      title,
      accountId,
      endpointId,
      contextId,
      relatedAccountId,
      resourceId,
      relation,
      evidence,
      ...unnamed
    } = check;
    nothingLeftUnnamed(unnamed);
    const standards = standardsOf(checkId);
    return withRequest({
      kind: checkId,
      source: "check" as const,
      severity,
      // Both absent on a run-level finding, and both stay absent rather than
      // being filled with a placeholder: a reader who sees an endpoint id
      // believes there was a request.
      ...(accountId === undefined ? {} : { accountId }),
      ...(endpointId === undefined ? {} : { endpointId }),
      // The conditions are carried over like everything else. The fields were
      // copied by naming each one, and a new one was silently lost: a check
      // finding made under conditions looked like a baseline one, grouping
      // merged it with the baseline one, and `request` was printed without the
      // attributes. Found by a cold read.
      ...(contextId === undefined ? {} : { contextId }),
      // The third coordinate of the cell, and the relation that goes with it.
      // Absent on a check that judges a whole endpoint, which is every check in
      // the registry today; present the moment one judges an object, and then
      // `withVerdicts` and `withRequest` below find the observation instead of
      // missing it and printing the cell as agreed. See ADR-0039.
      ...(resourceId === undefined ? {} : { resourceId }),
      ...(relation === undefined ? {} : { relation }),
      title,
      // Which clauses this finding answers for. Declared on the check since
      // ADR-0003 and read by nothing until now, so the traceability the plan
      // promises could not be built from a saved report.
      ...(standards.length === 0 ? {} : { standards }),
      ...(relatedAccountId === undefined ? {} : { relatedAccountId }),
      evidence,
      // The second request of the pair. Taken from the observations by the name
      // of the other side: the check knows nothing about transport and stores
      // no addresses.
      ...relatedRequestOf(check),
    });
  });

  // Severity first, then the cell, and the two channels interleave rather than
  // sitting in two blocks. The list used to be every matrix row and then every
  // check row — so a critical leak found by body sat below eighty low-severity
  // discrepancies, and a reader who stopped at the top of the file stopped at
  // the least important thing in it. `defects[]` beside it was sorted by
  // severity all along. Found by the audit of 14 August 2026 (B-9).
  //
  // The tie-breakers are what makes it a **stable** order: two runs of the same
  // matrix have to produce the same file, and severity alone leaves eighty rows
  // free to shuffle.
  //
  // Stable across machines, which is what the sentence above always meant and
  // what these four comparisons did not deliver: they were `localeCompare()`
  // with no locale, so the order came from the `LC_ALL` of whoever ran the tool
  // — `sv_SE` and `en_US` sorted the same rows differently. `MAX_ROWS_PER_DEFECT`
  // cuts the evidence below this line, so the two machines did not merely print
  // one file in two orders: they kept different rows. `byCodeUnits` is the one
  // rule the project compares by; see `src/core/order.ts` for why it is code
  // units and not a pinned locale. Found by the audit of 21 August 2026 (L-2).
  return [...fromMatrix, ...fromChecks].sort((left, right) => {
    const bySeverity = SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity];
    if (bySeverity !== 0) {
      return bySeverity;
    }
    return (
      byCodeUnits(left.endpointId ?? "", right.endpointId ?? "") ||
      byCodeUnits(left.accountId ?? "", right.accountId ?? "") ||
      byCodeUnits(left.resourceId ?? "", right.resourceId ?? "") ||
      byCodeUnits(left.kind, right.kind)
    );
  });
}

/**
 * What the `accepted:` declarations did to a list of findings.
 *
 * One pass, because three answers have to agree: the mark on each row, the
 * counters in the summary, and the per-declaration `matched`. Computed
 * separately they would be three walks over one question, which is the shape
 * ADR-0020 made `describeMatrix` out of.
 *
 * The moment is the run's **start** and is passed in rather than read from a
 * clock here: this file is the report layer, and a function that asks the system
 * what time it is cannot be tested against a boundary. One moment for the whole
 * run, too — a walk that crosses midnight must not accept its first half and
 * report its second.
 */
function applyAcceptances(
  findings: readonly ReportFinding[],
  declared: readonly Acceptance[],
  at: Date,
): {
  readonly rows: readonly ReportFinding[];
  readonly accepted: readonly ReportedAcceptance[];
  readonly counts: AcceptanceCounts;
} {
  const index = indexAcceptances(declared);
  const inForce = new Map(
    declared.map((acceptance) => [acceptance, isAcceptanceInForce(acceptance, at)]),
  );
  const matched = new Map<Acceptance, number>();
  // The same key space as `summary.byKind`, and guarded the same way — see
  // `countByKind`. A check id is a name this tool did not choose.
  const byKind = openRecord<number>();
  let held = 0;
  let expired = 0;

  const rows = findings.map((finding) => {
    // A run-level finding — "this clause is covered by nothing" — has no defect
    // coordinates, so there is nothing for a declaration to name. It is also not
    // the kind of statement an acceptance is for: it is about the run.
    if (finding.endpointId === undefined) {
      return finding;
    }
    const acceptance = matchingAcceptance(
      {
        endpointId: finding.endpointId,
        kind: finding.kind,
        ...(finding.relation === undefined ? {} : { relation: finding.relation }),
        ...(finding.contextId === undefined ? {} : { contextId: finding.contextId }),
      },
      index,
    );
    if (acceptance === undefined) {
      return finding;
    }
    matched.set(acceptance, (matched.get(acceptance) ?? 0) + 1);
    const lapsed = inForce.get(acceptance) !== true;
    if (lapsed) {
      expired += 1;
    } else {
      held += 1;
      byKind[finding.kind] = (lookup(byKind, finding.kind) ?? 0) + 1;
    }
    return {
      ...finding,
      accepted: {
        reason: acceptance.reason,
        until: acceptance.until,
        ...(acceptance.ticket === undefined ? {} : { ticket: acceptance.ticket }),
        expired: lapsed,
      },
    };
  });

  return {
    rows,
    accepted: declared.map((acceptance) => ({
      defect: citableDefectKey(acceptance),
      kind: acceptance.kind,
      reason: acceptance.reason,
      until: acceptance.until,
      ...(acceptance.ticket === undefined ? {} : { ticket: acceptance.ticket }),
      expired: inForce.get(acceptance) !== true,
      matched: matched.get(acceptance) ?? 0,
    })),
    counts: {
      declared: declared.length,
      findings: held,
      expired,
      unused: declared.filter((acceptance) => (matched.get(acceptance) ?? 0) === 0).length,
      byKind,
    },
  };
}

function countGroupsBySeverity(groups: readonly DefectGroup[]): Readonly<Record<Severity, number>> {
  const counts = { ...EMPTY_BY_SEVERITY };
  for (const group of groups) {
    counts[group.severity] += 1;
  }
  return counts;
}

/**
 * Findings by kind, over a key space the tool does not own.
 *
 * `kind` is a diff kind for a matrix row and a **check id** for the other
 * channel, and a check id comes from whoever registered the check. So this is
 * one of the records ADR-0024 is about: an object literal swallows a key named
 * `__proto__` — the assignment is a no-op and the count silently disappears —
 * and indexing one answers for `constructor`. `openRecord` and `lookup` are the
 * grammar, written once in `src/io/untrusted.ts`.
 *
 * `summary.accepted.byKind` beside it is built the same way, over the same key
 * space. Two records of one kind guarded differently is the shape that rule
 * exists against.
 */
function countByKind(findings: readonly ReportFinding[]): Readonly<Record<string, number>> {
  const counts = openRecord<number>();
  Object.assign(counts, EMPTY_BY_KIND);
  for (const finding of findings) {
    counts[finding.kind] = (lookup(counts, finding.kind) ?? 0) + 1;
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
 * A declared account, or that same account under one set of declared conditions.
 *
 * What `reportedAccount` maps from, named so that the mapping has one source to
 * answer for rather than a shape restated at two call sites.
 */
type ConfiguredAccountRow = AccountConfig & {
  readonly contextId?: string;
  readonly baseAccountId?: string;
};

/**
 * The account rows, including accounts under conditions.
 *
 * An account under conditions is a matrix row of its own, and that is what a
 * finding refers to. Without such a row in the report the reference dangles: the
 * reader sees `alice-a@geo-blocked`, looks for it in the account list and does not
 * find it.
 */
function withContextAccounts(options: BuildReportOptions): readonly ConfiguredAccountRow[] {
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
 * One account as the report publishes it.
 *
 * A whole function for what used to be an object literal inside `buildReport`,
 * for the reason `describeChecks` is a function: a mapping that names fields
 * needs one place to name them in and one type to satisfy, or the next field
 * added to `AccountConfig` goes the way `CheckRun.description` went. Every
 * field of the source is accounted for below — carried, or withheld with the
 * reason beside it — and `nothingLeftUnnamed` is what makes that a statement
 * the compiler checks rather than a claim in a comment. Found by the audit of
 * 14 August 2026 (B-12).
 */
function reportedAccount(account: ConfiguredAccountRow, config: RunConfig): ReportedAccount {
  const {
    id,
    role,
    tenant,
    tenants,
    tokenEnv,
    contextId,
    baseAccountId,
    // Withheld. `canary` is the endpoint the operator nominated for the
    // pre-flight check: what the canaries did is in `canaries`, and which
    // endpoint was picked says nothing about access. `authScheme` is a
    // reference into `authSchemes` by name, and `auth` below carries the scheme
    // that reference resolves to — publishing both would put one fact in the
    // file twice, free to disagree.
    canary: _canary,
    authScheme: _authScheme,
    ...unnamed
  } = account;
  nothingLeftUnnamed(unnamed);
  return {
    id,
    role,
    tenant,
    // The set of memberships is printed just like a single tenant. Without this
    // an account with a set looked in the report like an account with no tenant
    // at all — that is, indistinguishable from an anonymous one — even though
    // the verdicts on it are correct.
    tenants,
    // An account without credentials is declared anonymous. Without an explicit
    // mark the report's only positive conclusion — 'the anonymous account got
    // 401 everywhere' — is unprovable: an account whose token was passed wrongly
    // would look the same.
    anonymous: tokenEnv === undefined,
    // The name of the variable, not the value. It sits in the configuration
    // anyway, the one that is meant to be committed, and without it the reader
    // of the report does not know which token to reproduce the finding with.
    // Found by a third cold read.
    ...(tokenEnv === undefined ? {} : { tokenEnv }),
    // The conditions this row exists under. Absent means baseline.
    ...(contextId === undefined ? {} : { contextId, baseAccountId }),
    // Which surface the account went through. Not written at all for an
    // anonymous one: it has nothing to present, and a scheme recorded there only
    // confused. Without this the reader cannot tell 'the endpoint is closed'
    // from 'we knocked with the wrong transport': both give 401. Only the kind
    // of scheme and the name of the header or the cookie here — no values
    // anywhere.
    ...(tokenEnv === undefined
      ? {}
      : {
          // By the original account: the scheme is a property of the surface,
          // not of a matrix row. A row under conditions used to look the scheme
          // up by its own id, fail to find it and print the root one — that is,
          // the field lied exactly where it is the only thing needed: 'the
          // endpoint is closed' against 'we knocked with the wrong transport'.
          // Found by a cold read.
          auth: namedScheme(config.accountAuth.get(baseAccountId ?? id) ?? config.auth),
        }),
  };
}

/**
 * One declared set of request conditions as the report publishes it.
 *
 * Everything the configuration declares about the conditions is published:
 * 'access under context: geo-blocked' can be neither reproduced nor disputed
 * without the attributes, and there are no secrets among them — a human wrote
 * the values, and `{ env: NAME }` names a variable rather than carrying one.
 * The rest of the destructuring is asserted empty for the same reason as in
 * `reportedAccount`: an attribute added to the declaration must not be able to
 * go missing here in silence.
 */
function reportedContext(context: RequestContextConfig): ReportedContext {
  const { id, description, headers, query, endpointIds, accountIds, ...unnamed } = context;
  nothingLeftUnnamed(unnamed);
  return {
    id,
    ...(description === undefined ? {} : { description }),
    headers,
    query,
    endpointIds,
    accountIds,
  };
}

/**
 * The system under test, as the report names it.
 *
 * The whole of `RunTarget` is published — there is nothing in it a report about
 * that target should withhold — and the assertion is what keeps that true of
 * the next field rather than of this list.
 */
function reportedTarget(target: RunTarget): RunReport["target"] {
  const { baseUrl, allowedHosts, label, ...unnamed } = target;
  nothingLeftUnnamed(unnamed);
  return { baseUrl, allowedHosts, ...(label === undefined ? {} : { label }) };
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
    // A run-level finding — "this clause is covered by nothing" — names no
    // cell, and a statement about the run cannot narrow the verdict on one.
    //
    // The comment that stood here called this branch unreachable, on the
    // grounds that `mergeFindings` dropped such a finding and counted it under
    // `coverage.checksWithUnusableFindings`. Both stopped being true on
    // 15 August: the filter is gone, the counter is gone, and the finding
    // reaches this loop. Noticed while closing B-12 — the same class as B-12
    // itself, a line about the code that the code stopped agreeing with.
    if (finding.accountId === undefined || finding.endpointId === undefined) {
      continue;
    }
    // Both sides of the finding, not only the one it is filed under.
    //
    // A leak found by body is a statement about a **pair** of cells: alice's
    // response and carol's were the same, and it is carol who received a
    // tenant's data that is not hers. The finding names alice in `accountId` and
    // carol in `relatedAccountId`, and only alice's cell was narrowed — so
    // carol's went into the file as `match: true`, "tested and agreed", and into
    // `coverage.cellsMatched`. On the reference run with every defect on, twelve
    // cells were printed that way.
    //
    // Twelve is the same number `docs/report.md` quotes for the defect ADR-0022
    // closed on 15 August, where the body channel did not reach this field at
    // all. That fix taught the loop to read check findings and left it reading
    // one end of them. Found by adversarial review on 17 August 2026.
    for (const accountId of [finding.accountId, finding.relatedAccountId]) {
      if (accountId === undefined) {
        continue;
      }
      const key = cellKey({
        accountId,
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
  }
  return options.observations.map((observation) => {
    const key = cellKey(observation);
    const cell = byCell.get(key);
    if (cell === undefined) {
      return observation;
    }
    // The verdict's fields named one at a time, and the remainder asserted
    // empty — see `nothingLeftUnnamed`. This mapping is where `basis` was lost.
    const {
      expected,
      basis,
      match,
      relation,
      ruleIndex,
      // Withheld, because the observation this row is built on already carries
      // each of them. `accountId`, `endpointId` and `resourceId` are the key
      // the two were joined on a line above; `contextId` travels on the account
      // the row names; and `actual` is `observation.outcome` under a second
      // name. Printing them again would put one fact in two places on one line,
      // free to disagree.
      accountId: _accountId,
      endpointId: _endpointId,
      resourceId: _resourceId,
      contextId: _contextId,
      actual: _actual,
      ...unnamed
    } = cell;
    nothingLeftUnnamed(unnamed);
    const kinds = kindsOf.get(key);
    return {
      ...observation,
      expected,
      // What declared the expectation. The core has computed it on every cell
      // since the absence of `ruleIndex` proved to be a poor answer, and this
      // mapping named four of the cell's fields and not this one — so on an
      // observation a missing `ruleIndex` was still the whole answer, and it
      // cannot be told from a field the tool failed to fill in. Findings have
      // carried it all along, which is what made the gap invisible: the two
      // halves of `docs/report.md`'s "Which rule gave the verdict" were true of
      // different rows. Found by the audit of 14 August 2026 (B-12).
      basis,
      // The walk's verdict **and** the checks. `match` used to be the walk alone,
      // so a cell could be `match: true` and carry a body finding at the same
      // time: twelve of them did on the reference run. A reader who started from
      // the observation closed it as works-as-designed, and both arithmetic
      // self-checks this report offers came out wrong. Found by the audit of
      // 14 August 2026.
      match: match && kinds === undefined,
      // Why it did not agree, next to the cell itself. Without this a body
      // finding leaves an unexplainable row behind: expectation `allowed`,
      // outcome `allowed`, `match: false`, and nothing on the line saying which
      // channel objected.
      ...(kinds === undefined ? {} : { findingKinds: [...kinds].sort(byCodeUnits) }),
      ...(relation === undefined ? {} : { relation }),
      ...(ruleIndex === undefined ? {} : { ruleIndex }),
    };
  });
}

/**
 * An authentication scheme with the header it actually uses spelled out.
 *
 * `{ kind: "bearer" }` said nothing about where the credential goes, while
 * `header` and `cookie` name theirs — so of the four schemes two left the reader
 * to know that bearer and basic both mean `authorization`. The configuration
 * keeps its shape, where writing `kind: bearer` and nothing else is right; the
 * report is what has to be self-explanatory. Found by the audit of 14 August
 * 2026 (H-8).
 */
export type ReportedAuthScheme = AuthScheme & { readonly header: string };

function namedScheme(scheme: AuthScheme): ReportedAuthScheme {
  switch (scheme.kind) {
    case "header":
      return { ...scheme, header: scheme.header.toLowerCase() };
    case "cookie":
      return { ...scheme, header: "cookie" };
    default:
      // bearer and basic. Both put the credential in `Authorization`, differing
      // only in how it is encoded — which `kind` already says.
      return { ...scheme, header: "authorization" };
  }
}

/**
 * The sentences the console and the report both use.
 *
 * One source, because they are the same statement: a warning worded one way on
 * the terminal and another way in the file is two statements a reader has to
 * reconcile. See `RunReport.warnings`.
 */
/**
 * How many evidence rows one defect may put in the file.
 *
 * The isolation check compares accounts pairwise, so on an endpoint that leaks
 * to everybody it produces one row per pair: quadratic in accounts, while the
 * one guard that bounds a run — `--max-requests`, 2000 by default — is linear in
 * them. Measured on 17 August 2026: 100 accounts on a single endpoint give 4 950
 * rows and a 1.65 MB file, 200 give 19 900 and 6.6 MB, and 2 000 accounts — one
 * request each, exactly the default budget — give 1 999 000 rows, at which point
 * `JSON.stringify` throws `RangeError: Invalid string length` and the whole run
 * is lost at its last step, to an error that names a string length rather than
 * anything the operator did.
 *
 * Those rows are also redundant, which is what makes a cap the right answer
 * rather than a compromise: the report already collapses all 4 950 of them into
 * **one** defect group, and the counts, the severities and the exit code are all
 * computed before this cap applies. What a reader loses is the 51st example of a
 * thing they have 50 examples of.
 *
 * Per defect and not over the whole list — see `defectSignature`. A first-N cap
 * over the flat list would let the endpoint that leaks to two thousand accounts
 * spend the whole budget and leave a rarer defect with no evidence at all, and
 * the rare one is the interesting one.
 *
 * **Fifty rather than a larger number** because the many-defects case is what
 * actually bounds a file, and it was measured too: 200 endpoints all leaking to
 * 50 accounts produce 245 000 rows across 200 defects, which is 4.5 MB at fifty
 * rows each and 13.9 MB at two hundred. With a single defect the constant barely
 * shows — 0.55 MB against 0.60 MB, because the observations dominate — so fifty
 * costs nothing where it does not matter and three times less where it does.
 * Fifty examples is also far past what anybody reads to see a pattern.
 *
 * Found by measuring for I-5 and I-6 on 17 August 2026; the audit of 14 August
 * had both as "nothing to measure against until somebody runs it at that size".
 * See ADR-0029.
 */
export const MAX_ROWS_PER_DEFECT = 50;

/**
 * The warning sentences, for the file and for the terminal both.
 *
 * The one place they are written. `src/cli.ts` imports this object and prints
 * the strings verbatim; it does not paraphrase them, and it does not build a
 * sentence of its own around a number. Only the colour is the terminal's to
 * decide, and a JSON file has none.
 *
 * That is the second attempt at the arrangement. The first was "write the same
 * sentence in both places and remember to keep them level", and it lasted until
 * somebody improved one of the two: by 18 August 2026 the console's `noCanary`
 * and the file's said different things about the same run, and a reader holding
 * the artifact could not tell which of them the tool had meant.
 *
 * A plain string and not a template taking the run's numbers, deliberately. A
 * warning that interpolates is a warning the two sides can format differently —
 * which is exactly what `nothingRefused` did, "Not one of the 144 requests" on
 * screen against "Not one request" in the file. The count is not lost: it is
 * `summary.observations`, printed as "Cells probed" on the line above.
 */
export const WARNINGS = {
  unnamedTarget:
    "The target is unnamed: target has no label field. The report will not " +
    "identify the system under test, and a reader cannot tell a run against a " +
    "real environment from a run against a demo polygon.",
  nothingRefused:
    "Not one request was refused. Either nothing on this platform is protected, " +
    "or it refuses with 200 and states the outcome in the body — which this tool " +
    'reads as "allowed" everywhere, making every finding above false. Open one ' +
    "cell you are sure about before believing this report.",
  // The union of the two texts that had drifted, not a choice between them. The
  // file's half said what is unproved; the console's half said what it costs —
  // and the reader of the artifact is the one who needs to know why the run came
  // back 2 without a single finding to explain it.
  noCanary:
    "Authentication is unverified for at least one account that has credentials: " +
    "no canary of its own passed, so nothing confirms the run ever authenticated " +
    "as it. If its token does not work, every cell walked under that account " +
    "answers the way an unauthenticated request would and is read here as a lawful " +
    "denial — which is why such a run ends with exit code 2. The verdict names " +
    "the accounts.",
  // What the other four cannot say. Every counter beside them answers "was
  // anything found"; this one answers "was anything looked at", which is the
  // question `coverage` exists for and which nothing consulted. See B-4.
  endpointsNotProbed:
    "Not every endpoint was probed: coverage.notProbed says how many were left " +
    "out and for what reason. No finding against one of them means no request " +
    "ever went to it, not that it is clean. The usual reason is a path " +
    "parameter with no resource declaring a value for it, and that reason drops " +
    "the object half of the surface — the endpoints addressed by identifier, " +
    "which is where broken object-level authorization lives. Declare resources " +
    "for them, or read this report as covering the rest of the list only.",
  findingsCapped:
    "Some evidence rows were left out of this file: a defect was observed more " +
    `times than the ${MAX_ROWS_PER_DEFECT} rows kept per defect. Nothing about ` +
    "the verdict changes — summary.findings, summary.byKind, summary.bySeverity " +
    "and every defect group are counted from all of them — and findingsOmitted " +
    "says how many rows are missing. Each defect keeps its own examples, so none " +
    "of them is left with no evidence at all.",
} as const;

/**
 * The accounts whose credentials this run confirmed nothing about.
 *
 * One function because two readers need the same answer — the warning and the
 * verdict — and the pair that was written twice drifted within four days:
 * `canariesChecked === 0` asked whether the run had **a** canary, while the
 * sentence beside it promised something about "the accounts".
 *
 * A row under request conditions is not a separate principal: it is the same
 * account with the same token making a differently shaped request, so it is the
 * base account's canary that clears it. Without this the rule would demand a
 * canary for a row no operator can declare one on — `baseAccountId` is the
 * carrier, `contextId` only says the row exists.
 *
 * Anonymous accounts are not in the answer: there is nothing to confirm.
 */
function unconfirmedCredentials(
  // The two fields it reads and no more, because a third reader arrived that
  // has them before the report exists: `clauseReservationsOf` asks the same
  // question while `coverage` is still being assembled. Narrowing the parameter
  // is what lets the answer stay one function rather than becoming the pair that
  // drifted within four days the first time it was written twice.
  report: Pick<VerdictInputs, "accounts" | "canaries">,
): readonly string[] {
  // `?? []` although the type says the field is there: `runVerdict` and
  // `exitCodeFor` are exported, and a consumer recomputing a verdict from a
  // report saved by 0.4.0 hands over an object that predates the field. It used
  // to read `canariesChecked` only, so such an object worked; a TypeError where
  // an exit code was expected is a worse answer than "nothing confirmed".
  const confirmed = new Set(
    (report.canaries ?? [])
      .filter((canary) => canary.authenticated)
      .map((canary) => canary.accountId),
  );
  const unconfirmed = new Set<string>();
  for (const account of report.accounts) {
    if (account.anonymous === true) {
      continue;
    }
    const principal = account.baseAccountId ?? account.id;
    if (!confirmed.has(principal)) {
      unconfirmed.add(principal);
    }
  }
  return [...unconfirmed].sort(byCodeUnits);
}

/**
 * What the console said that the numbers do not.
 *
 * Derived from the finished report so that the file and the terminal cannot
 * disagree — and only from what the report can see. A warning the CLI computes
 * before the report exists, such as an unwritable `--report` path, stays where
 * it is: by then there is no report to put it in.
 */
function warningsFor(report: VerdictInputs, config: RunConfig): readonly string[] {
  const warnings: string[] = [];
  if (config.target.label === undefined) {
    warnings.push(WARNINGS.unnamedTarget);
  }
  if (report.summary.observations > 0 && report.coverage.outcomes.denied === 0) {
    warnings.push(WARNINGS.nothingRefused);
  }
  // The counters this function reads all answer "was anything found". None of
  // them answers "was anything looked at", and `coverage` was not read here at
  // all — so a run that probed two endpoints out of eleven, the other nine being
  // templated with no resources declared, came back with `warnings: []`,
  // `findings: 0` and exit 0, and the screen called it clean. The nine are the
  // object half of the surface. Found by the audit of 21 August 2026 (B-4).
  //
  // The two counters and not `notProbed`, which is built from `skipped` alone:
  // `endpointsProbed` may also come from `options.probed`, and a run that
  // reached fewer endpoints than the source gave owes the reservation however it
  // came to.
  if (report.coverage.endpointsProbed < report.coverage.endpointsTotal) {
    warnings.push(WARNINGS.endpointsNotProbed);
  }
  if (report.findingsOmitted > 0) {
    warnings.push(WARNINGS.findingsCapped);
  }
  if (unconfirmedCredentials(report).length > 0) {
    warnings.push(WARNINGS.noCanary);
  }
  return warnings;
}

/**
 * A serialisation whose result depends on the meaning and not on the shape.
 *
 * `JSON.stringify` was used here and dropped a whole field: `accountAuth` is a
 * `Map`, and a `Map` stringifies to `{}` whatever is in it. Sorting the keys is
 * the second half — see `configDigest` for why that half is insurance and not a
 * fix.
 *
 * A `Map` becomes its entries sorted by key, tagged so that it cannot collide
 * with a plain object carrying the same pairs: a fingerprint that cannot tell
 * two different declarations apart is the failure being fixed, and inventing a
 * new way to do it would be a poor exchange. Arrays keep their order — in a
 * policy the order of rules decides the outcome, and sorting them would make two
 * different policies look alike.
 *
 * All three sorts go through `byCodeUnits`, and until 21 August 2026 they did
 * not: the `Map` branch used `localeCompare()` while the `Set` branch and the
 * object keys used the default `.sort()`. One function, two orders — and the
 * `Map` half took its order from the machine's `LC_ALL`, so `configDigest` came
 * out different on a Swedish machine than on an American one over the same
 * declaration. That is precisely the question `docs/report.md` sells this digest
 * as the answer to: "the platform changed" against "we changed the declaration".
 * Found by the audit of 21 August 2026 (L-2); `src/core/order.ts` holds the rule.
 */
function canonical(value: unknown): string {
  const pieces: string[] = [];
  canonicalInto((piece) => pieces.push(piece), value);
  return pieces.join("");
}

/**
 * The same serialisation, handed to a sink one piece at a time.
 *
 * One traversal for both readers, which is the whole reason this function is
 * shaped like this: `configDigest` hashes a configuration small enough to hold
 * as a string, and `contentDigest` hashes the finished report, which is not.
 * `src/report/write.ts` was rewritten in chunks because the string ceiling —
 * 536 870 888 characters — is reachable on this tool's ordinary output: a run of
 * 57 826 cells against a platform answering with 196 headers died at the last
 * step with every request already spent (ADR-0038). Building the canonical form
 * as one string to hash it would put that ceiling straight back, one function
 * further along.
 *
 * A second serialiser would be the other way to have it, and this project has a
 * rule about that. The `Set` branch is the one place a piece has to be
 * materialised — its members are sorted by their serialised form — and it is
 * bounded by the set, not by the document.
 */
function canonicalInto(write: (piece: string) => void, value: unknown): void {
  if (value instanceof Map) {
    const entries = [...value.entries()].sort(([left], [right]) =>
      byCodeUnits(String(left), String(right)),
    );
    write("Map(");
    entries.forEach(([key, one], index) => {
      write(index === 0 ? "" : ",");
      write(`${JSON.stringify(String(key))}:`);
      canonicalInto(write, one);
    });
    write(")");
    return;
  }
  if (value instanceof Set) {
    write(`Set(${[...value].map(canonical).sort(byCodeUnits).join(",")})`);
    return;
  }
  if (Array.isArray(value)) {
    write("[");
    value.forEach((element, index) => {
      write(index === 0 ? "" : ",");
      canonicalInto(write, element);
    });
    write("]");
    return;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    // A key whose value is `undefined`, a function or a symbol is dropped, for
    // the reason `reportChunks` drops it: `JSON.stringify` does, so the file on
    // disk does not have it. `contentDigest` is checked against a report parsed
    // back out of that file, and a serialisation that wrote `"tenant":null`
    // where the document has no `tenant` at all would fail every honest report
    // it was asked about. Found the first time this digest was compared with
    // itself across a round trip — `ReportedAccount.tenant` is `string |
    // undefined` and an account outside a tenant carries the key unset.
    //
    // It is the right answer for `configDigest` too, and slightly more right
    // than what stood here: `{ exclude: undefined }` and `{}` are one
    // declaration, and a fingerprint that told them apart was answering a
    // question nobody asked.
    const keys = Object.keys(record)
      .filter((key) => {
        const own = record[key];
        return own !== undefined && typeof own !== "function" && typeof own !== "symbol";
      })
      .sort(byCodeUnits);
    write("{");
    keys.forEach((key, index) => {
      write(index === 0 ? "" : ",");
      write(`${JSON.stringify(key)}:`);
      canonicalInto(write, record[key]);
    });
    write("}");
    return;
  }
  // `undefined` inside an array, and a function or a symbol anywhere: all three
  // become `null`, which is what `JSON.stringify` writes for them in an array.
  write(JSON.stringify(value) ?? "null");
}

/**
 * The name of the field a report carries its own digest under.
 *
 * Written once, because two readers need it and they must agree: the builder
 * that fills it and the verifier that has to take it back out before
 * recomputing. A literal in both places is the shape ADR-0024 was written
 * against, at the one spot where a disagreement would make every report verify
 * against itself and none against the file.
 */
const CONTENT_DIGEST = "contentDigest";

/**
 * The digest of everything in a report except the field that carries it.
 *
 * Over the **parsed** document and not over its bytes, which is the same
 * decision `configDigest` rests on: indentation, key order and the trailing
 * newline are the file's formatting, not its content, and a reader who
 * reserialised the JSON to look at it would otherwise be told the report had
 * been tampered with.
 *
 * A whole sha256 rather than the sixteen characters `configDigest` keeps.
 * That one is a label two runs are compared by, where a short string is easier
 * to read off a screen; this one is a check value, and truncating a check value
 * trades collision resistance for nothing.
 */
export function contentDigestOf(report: object): string {
  const { [CONTENT_DIGEST]: _carried, ...content } = report as Record<string, unknown>;
  const hash = createHash("sha256");
  canonicalInto((piece) => {
    hash.update(piece);
  }, content);
  return hash.digest("hex");
}

/** What {@link checkContentDigest} answers. */
export interface ContentDigestCheck {
  /**
   * Whether the file carries a digest and that digest is the one its content
   * gives.
   *
   * **False on a report that carries none.** A verifier that read a missing
   * field as a pass would make the whole exercise optional: delete the line and
   * the document is unimpeachable again. `declared` is what tells the two cases
   * apart — a report written before 0.5.0 has no digest, and that is a thing to
   * know rather than a thing to wave through.
   */
  readonly ok: boolean;
  /** The digest this content gives now. */
  readonly computed: string;
  /** The digest the file carries, if it carries one. */
  readonly declared?: string;
}

/**
 * Whether a report is the file the run wrote.
 *
 * **What it catches:** an edit made without thinking — a row deleted from
 * `findings`, a sentence rewritten in `verdict.reason`, a counter nudged in
 * `summary`, a merge that mangled the JSON, a truncated download. Since
 * HTML and PDF are rendered from this file (ADR-0002), an edit here reaches
 * every form of the document, and this is what makes the edit visible.
 *
 * **What it does not catch: a deliberate change.** Whoever edited the row can
 * run this function and write the new value back, and nothing here would know.
 * A digest a reader can recompute is a digest an author can recompute. Making
 * the artifact evidence against a determined editor takes a signature — a key
 * that does not live beside the report and a verifier that holds the public
 * half — and that is a separate decision this one does not make. ADR-0051
 * records it as not done rather than leaving the reader to assume it was.
 */
export function checkContentDigest(report: object): ContentDigestCheck {
  const declared = (report as Record<string, unknown>)[CONTENT_DIGEST];
  const computed = contentDigestOf(report);
  return {
    ok: typeof declared === "string" && declared === computed,
    computed,
    ...(typeof declared === "string" ? { declared } : {}),
  };
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
 * The identifiers of the endpoints a request actually went to.
 *
 * Identifiers, and the endpoint itself is then looked up in `options.endpoints`.
 * `probed` is a selection out of that list, so reading a property off it would
 * mean trusting two copies of one endpoint to agree — and the first version of
 * this function did exactly that, then read `responseMustDifferByTenant` off a
 * copy that did not carry it.
 *
 * `options.probed` when the caller has it — the runner does — and otherwise
 * everything the source gave minus what was skipped, the same subtraction
 * `endpointsProbed` falls back to.
 */
function probedEndpointIds(options: BuildReportOptions): ReadonlySet<string> {
  if (options.probed !== undefined) {
    return new Set(options.probed.map((endpoint) => endpoint.id));
  }
  const skipped = new Set(options.skipped.map((one) => one.endpointId));
  return new Set(
    options.endpoints.filter((endpoint) => !skipped.has(endpoint.id)).map((one) => one.id),
  );
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
    .sort(byCodeUnits);
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

/**
 * The cells of the matrix, reduced to what a clause row needs of each.
 *
 * From `options.cells` — the walk's own enumeration, which carries a verdict for
 * every cell including the ones no request reached — and **not** from the
 * observations, which have no row for a cell that was never asked. That absence
 * is the single most important number on a clause row: an evidence pack that
 * counts only what came back describes the surface it happened to touch.
 *
 * The narrowed match is taken from the published observations rather than from
 * `cell.match`, so that `upheld` here is the same "tested and agreed" as
 * `coverage.cellsMatched`. The walk is not the only channel that judges a cell:
 * a body check objects to cells the walk agreed with (ADR-0022), and a second
 * reading of `match` in this file would be the two-sources-of-verdict defect
 * `withVerdicts` exists to avoid.
 *
 * An `error` outcome concluded nothing whatever the verdict says about it, and
 * is counted as such before anything else looks at `match`.
 */
function judgedCells(
  cells: readonly CellVerdict[],
  observations: readonly ReportedObservation[],
): readonly JudgedCell[] {
  const narrowed = new Map(
    observations
      .filter((observation) => observation.match !== undefined)
      .map((observation) => [cellKey(observation), observation.match === true]),
  );
  return cells.map((cell) => {
    const relation = cell.relation === undefined ? {} : { relation: cell.relation };
    if (cell.actual === undefined) {
      return { ...relation, verdict: "not-observed" as const };
    }
    if (cell.actual === "error") {
      return { ...relation, verdict: "probe-error" as const };
    }
    const upheld = narrowed.get(cellKey(cell)) ?? cell.match;
    return { ...relation, verdict: upheld ? ("upheld" as const) : ("breached" as const) };
  });
}

/**
 * Why the clause rows are not a statement about the whole surface.
 *
 * Every one of these is already somewhere in the report — in `coverage`, in
 * `truncated`, in `canaries`, in `outcomes` — and that is exactly why they are
 * repeated on the rows: a clause row is what gets pulled out of the file and
 * into a pack about one requirement, and a qualification that stayed behind in
 * another section is one that did not travel with the claim. The report already
 * had `endpointsProbed` when a run probed two endpoints of eleven and printed
 * "No privilege escalation found" over the other nine (B-4); nothing was missing
 * from the file, and the number that mattered was not next to the claim.
 */
function clauseReservationsOf(input: {
  readonly accounts: readonly ReportedAccount[];
  readonly canaries: readonly CanaryOutcome[];
  readonly staleCredentials: readonly string[];
  readonly unverifiedAfterWalk: readonly string[];
  readonly unauthenticated: readonly string[];
  readonly endpointsProbed: number;
  readonly endpointsTotal: number;
  readonly truncated: boolean;
  readonly observed: number;
  readonly denied: number;
}): readonly ClauseReservation[] {
  const reservations: ClauseReservation[] = [];
  // All four ways a run can fail to prove that an account was who it said it
  // was, under one code. They differ in the cure and not in what they do to a
  // clause row: a refusal recorded under an account whose credentials nothing
  // confirmed says what an unauthenticated request says, so a cell that
  // "upheld" a denial upheld nothing. Which of the four it was is in
  // `verdict.reason` and in `canaries`.
  if (
    input.staleCredentials.length > 0 ||
    input.unverifiedAfterWalk.length > 0 ||
    input.unauthenticated.length > 0 ||
    unconfirmedCredentials(input).length > 0
  ) {
    reservations.push("authentication-unproved");
  }
  if (input.endpointsProbed < input.endpointsTotal) {
    reservations.push("endpoints-not-probed");
  }
  // `denied: 0` with observations present. It does not settle whether the
  // platform grants everything or refuses with 200 and the outcome in the body,
  // and it cannot: from status codes alone the two are one picture. Either way
  // the cells under this run were read off a document the tool may not be able
  // to read. See L-3 and `coverage.outcomes`.
  if (input.observed > 0 && input.denied === 0) {
    reservations.push("no-refusal-observed");
  }
  if (input.truncated) {
    reservations.push("run-truncated");
  }
  return reservations;
}

/**
 * Keeps at most `MAX_ROWS_PER_DEFECT` rows per defect, in the order they came.
 *
 * A finding that names no cell is always kept: it is a statement about the run
 * rather than about the platform, it has no defect signature to be capped
 * within, and there is one of each.
 */
function capRows(findings: readonly ReportFinding[]): {
  readonly rows: readonly ReportFinding[];
  readonly omitted: number;
} {
  const seen = new Map<string, number>();
  const rows: ReportFinding[] = [];
  let omitted = 0;

  for (const finding of findings) {
    if (finding.accountId === undefined || finding.endpointId === undefined) {
      rows.push(finding);
      continue;
    }
    // The defect's signature **and the kind**. Since ADR-0030 the signature no
    // longer carries the kind, so one budget of fifty was shared by every kind on
    // an endpoint and the heavier one — findings are sorted by severity — spent
    // it first: a defect with three `unexpected-denial` rows arrived in the file
    // with none of them, under a warning promising that "each defect keeps its
    // own examples". Two changes of the same day, and the interaction was in
    // neither. Found by adversarial review on 17 August 2026.
    //
    // The three coordinates and nothing else. `defectSignature` reads exactly
    // them; the account and the severity were passed because the parameter used
    // to demand a whole finding, and it asks for `DefectCoordinates` since
    // ADR-0048 — the same shape an acceptance is written against.
    const signature = `${finding.kind}\u0000${defectSignature({
      endpointId: finding.endpointId,
      ...(finding.relation === undefined ? {} : { relation: finding.relation }),
      ...(finding.contextId === undefined ? {} : { contextId: finding.contextId }),
    })}`;
    const kept = seen.get(signature) ?? 0;
    if (kept >= MAX_ROWS_PER_DEFECT) {
      omitted += 1;
      continue;
    }
    seen.set(signature, kept + 1);
    rows.push(finding);
  }

  return { rows, omitted };
}

/**
 * The counts a verdict is made of, from the full set of findings.
 *
 * Separated by source here, where the source is known, so that `runVerdict` need
 * not filter rows that may have been capped — and need not read `byKind`, whose
 * one key space would let a check named after a matrix kind be counted as one.
 */
function verdictCountsOf(findings: readonly ReportFinding[]): VerdictCounts {
  const matrixByKind: Record<DiffKind, number> = {
    "privilege-escalation": 0,
    "unexpected-denial": 0,
    "not-observed": 0,
    "probe-error": 0,
  };
  let failingCheckFindings = 0;

  for (const finding of findings) {
    // A finding an acceptance holds is out of the verdict and nowhere else: it
    // keeps its row, its severity, its place in `byKind` and its defect group.
    // An **expired** acceptance is not this — `expired` on the mark means the
    // day has passed, and the row counts again, which is the whole difference
    // between a deadline and a silencer. See ADR-0048.
    if (finding.accepted !== undefined && !finding.accepted.expired) {
      continue;
    }
    if (finding.source === "matrix") {
      matrixByKind[finding.kind as DiffKind] += 1;
    } else if (finding.severity !== "info") {
      failingCheckFindings += 1;
    }
  }

  return { matrixByKind, failingCheckFindings };
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
  // Then the acceptances, before anything reads the findings. Everything
  // downstream sees the marked rows: the counters, the defect groups, the cap
  // and the verdict. Applying it later would mean two lists of findings in one
  // function, which is how `match: true` once came to stand on a cell that
  // carried a finding.
  const applied = applyAcceptances(merged, options.config.accepted, options.startedAt);
  const marked = applied.rows;
  const observations = withVerdicts(options, marked);
  const notObserved = options.findings.filter((finding) => finding.kind === "not-observed").length;
  // The other side of a paired finding sits in `evidence`: grouping does not see
  // it, and without it a group names one side of the leak out of two.
  const groups = groupDefects(
    marked
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
      .map((finding) => ({
        ...finding,
        // What the group prints as `acceptedKinds`. An expired acceptance does
        // not count: the finding is back in the verdict, and a group marked
        // accepted while it fails the build would be the mark lying.
        accepted: finding.accepted !== undefined && !finding.accepted.expired,
        ...(finding.relatedAccountId === undefined
          ? {}
          : { counterpartAccountId: finding.relatedAccountId }),
      })),
  );
  // After the grouping and before the file: the counts above answer for every
  // finding, the rows below are the evidence and evidence has a budget.
  const capped = capRows(marked);
  // Hoisted out of the literal below, because the clause rows need them while
  // `coverage` is still being written: `clauseReservationsOf` asks the same
  // questions of the accounts and of the surface that the warnings and the
  // verdict ask of the finished report, and it has to ask them of the same
  // values rather than of a second reading.
  const accounts = withContextAccounts(options).map((account) =>
    reportedAccount(account, options.config),
  );
  const canaries = options.canaries ?? [];
  const endpointsTotal = options.endpoints.length;
  const endpointsProbed =
    options.probed?.length ?? options.endpoints.length - options.skipped.length;
  const outcomes = countByOutcome(options.observations);
  const report: VerdictInputs = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    runId: randomUUID(),
    configDigest: createHash("sha256").update(canonical(options.config)).digest("hex").slice(0, 16),
    tool: {
      name: "barbican",
      version: options.version,
      documentation: documentationUrl(options.version),
    },
    startedAt: options.startedAt.toISOString(),
    finishedAt: options.finishedAt.toISOString(),
    target: reportedTarget(options.config.target),
    accounts,
    endpoints: options.endpoints,
    resources: options.config.resources,
    skipped: options.skipped,
    failures: options.failures,
    unauthenticated: options.unauthenticated,
    canariesChecked: options.canariesChecked,
    canaries,
    staleCredentials: options.staleCredentials ?? [],
    unverifiedAfterWalk: options.unverifiedAfterWalk ?? [],
    truncated: options.truncated,
    observations,
    // The rows, after the per-defect cap. Everything derived from findings —
    // `summary`, `defects`, the cell verdicts on the observations above — was
    // computed from `merged` before this line, so a capped file carries the same
    // verdict, the same counts and the same exit code as an uncapped one.
    findings: capped.rows,
    findingsOmitted: capped.omitted,
    accepted: applied.accepted,
    coverage: {
      endpointsTotal,
      endpointsProbed,
      cellsObserved: options.observations.length,
      cellsNotObserved: notObserved,
      notProbed: countByReason(options.skipped),
      // Declared, probed, **and with a check to ask the question**.
      //
      // The list was built from declarations and the walk and never from whether
      // anything ran, so a run with no checks selected named every declared
      // endpoint as compared while `checksRun` was empty beside it. That is the
      // field lying in the one direction it exists to prevent — its own comment
      // says so, and B-5 closed the other direction on 15 August. Being on this
      // list means the question was asked; with no check registered it was asked
      // nowhere. Found by adversarial review on 17 August 2026.
      bodiesComparedOn: ((probed, asked) =>
        asked
          ? options.endpoints
              .filter(
                (endpoint) =>
                  endpoint.responseMustDifferByTenant === true && probed.has(endpoint.id),
              )
              .map((endpoint) => endpoint.id)
          : [])(probedEndpointIds(options), (options.checksRun ?? []).length > 0),
      writeMethodsProbed: options.unsafeMethods ?? false,
      checksRun: options.checksRun ?? [],
      // Both channels on one list of clauses, with the denominator on every row.
      //
      // `cells` and not the observations, so that the cells nobody asked are in
      // the answer: an evidence pack built from what came back describes the
      // surface the run happened to touch. Absent from the input when the run
      // computed no verdicts, and then no row carries `matrixCells` at all —
      // the same silence `cellsMatched` keeps, and for the same reason.
      clauses: clauseCoverage({
        ...(options.cells === undefined ? {} : { cells: judgedCells(options.cells, observations) }),
        checksRun: options.checksRun ?? [],
        reservations: clauseReservationsOf({
          accounts,
          canaries,
          staleCredentials: options.staleCredentials ?? [],
          unverifiedAfterWalk: options.unverifiedAfterWalk ?? [],
          unauthenticated: options.unauthenticated,
          endpointsProbed,
          endpointsTotal,
          truncated: options.truncated,
          observed: options.observations.length,
          denied: outcomes.denied,
        }),
      }),
      byCheck: options.byCheck ?? [],
      contextsProbed: countByContext(options),
      resourcesNotFound: resourcesNeverFound(options.observations),
      outcomes,
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
      auth: namedScheme(options.config.auth),
      exclude: options.config.exclude,
      ...(options.throttle === undefined ? {} : { throttle: options.throttle }),
      contexts: options.config.contexts.map(reportedContext),
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
      findings: marked.length,
      byKind: countByKind(marked),
      bySeverity: countBySeverity(marked),
      defectGroups: groups.length,
      defectsBySeverity: countGroupsBySeverity(groups),
      checkFindings: marked.filter((finding) => finding.source === "check").length,
      // From the whole marked list, never from `capped.rows`: this is what the
      // verdict reads, and it is where an acceptance — and only an acceptance —
      // takes a row out. The counters above keep every row, which is what makes
      // `byKind` minus `accepted.byKind` reconcile with this map.
      verdictInputs: verdictCountsOf(marked),
      accepted: applied.counts,
    },
  };

  // Computed last, from the finished report, and put inside it. The alternative
  // was recomputing it in every consumer; the exit code exists precisely because
  // the arithmetic is not obvious from the counters.
  const concluded = {
    ...report,
    verdict: runVerdict(report),
    warnings: warningsFor(report, options.config),
  };
  // And the digest after even that, over everything above it. The verdict and
  // the warnings are the two sentences a reader is most likely to want changed,
  // so a digest taken before them would cover the file except where it matters.
  return { ...concluded, contentDigest: contentDigestOf(concluded) };
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

/**
 * A report without its conclusion, which is what the conclusion is computed from.
 *
 * The report carries its own verdict since 15 August (H-9), so the type would
 * otherwise refer to itself. This is also the honest signature: `runVerdict`
 * reads inputs and does not read the field it produces.
 */
export type VerdictInputs = Omit<RunReport, "verdict" | "warnings" | "contentDigest">;

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
export function runVerdict(report: VerdictInputs): RunVerdict {
  const verdict = verdictOfRun(report);
  const note = acceptanceNote(report);
  return note === undefined ? verdict : { ...verdict, reason: `${verdict.reason}; ${note}` };
}

/**
 * What the acceptances add to the sentence beside the code.
 *
 * `undefined` on a run that declares none, which is nearly every run. On one
 * that does, the exit code stops being derivable from the counters above it —
 * a critical finding sits in the file under a code of 0 — and the reason is
 * where this project says out loud what the arithmetic did. That argument is
 * `runVerdict`'s own; this is the case where it bites hardest, because the
 * alternative is a green line over something the operator has already been told
 * about and a reader has not.
 *
 * The other two clauses are the ways an acceptance stops being what it says it
 * is. A lapsed one is why a run that passed last week fails today, and a
 * declaration that covered nothing is a line nobody will delete unless
 * something says it did nothing — the same failure as an `overrides` entry
 * carrying no condition for its own removal.
 *
 * `?? ` although the type says the field is there, for the reason
 * `unconfirmedCredentials` has one: `runVerdict` is exported, and a consumer
 * recomputing a verdict from a report saved by 0.4.0 hands over an object that
 * predates it.
 */
function acceptanceNote(report: VerdictInputs): string | undefined {
  const counts = report.summary.accepted ?? { findings: 0, expired: 0, unused: 0 };
  const clauses: string[] = [];
  if (counts.findings > 0) {
    clauses.push(
      `${counts.findings} ${counts.findings === 1 ? "finding is" : "findings are"} held out ` +
        `of this verdict by an acceptance and ${counts.findings === 1 ? "is" : "are"} still ` +
        `in the report`,
    );
  }
  if (counts.expired > 0) {
    clauses.push(
      `${counts.expired} ${counts.expired === 1 ? "row" : "rows"} whose acceptance has ` +
        `expired ${counts.expired === 1 ? "counts" : "count"} again`,
    );
  }
  if (counts.unused > 0) {
    clauses.push(
      `${counts.unused} ${counts.unused === 1 ? "acceptance" : "acceptances"} matched ` +
        `nothing here — either what it names is fixed, or the run did not reach those ` +
        `cells (coverage.notProbed)`,
    );
  }
  return clauses.length === 0 ? undefined : clauses.join("; ");
}

/** The verdict itself, before the acceptances have their say in the sentence. */
function verdictOfRun(report: VerdictInputs): RunVerdict {
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
  // The same class a third time, and the narrowest of the three: the walk
  // finished, the tokens were confirmed before it, and the run's own ceiling
  // stopped the confirmation after it. Below `staleCredentials` on purpose —
  // there we know the tail lied, here we only know that nobody asked. Nothing
  // here says the credentials are bad; it says the second half of the check
  // never happened, and a run that cannot say its accounts were still
  // authenticated at the end has not tested what it claims. See ADR-0035.
  if ((report.unverifiedAfterWalk ?? []).length > 0) {
    return {
      code: 2,
      reason:
        `authentication was never confirmed a second time: ` +
        `${(report.unverifiedAfterWalk ?? []).join(", ")} — the run stopped itself ` +
        `(a request ceiling or the circuit breaker) or the platform stopped ` +
        `answering, and either way the walk that came before it is unproved. ` +
        `canaries[] says which: a failure code is ours, a status of 0 is the ` +
        `platform's silence`,
    };
  }
  if (report.unauthenticated.length > 0) {
    return {
      code: 2,
      reason: `accounts granted access nowhere: ${report.unauthenticated.join(", ")} — most likely the tokens, not the policy`,
    };
  }
  // Authentication is confirmed per account, and it used to be asked per run:
  // `canariesChecked === 0`. One canary on one account cleared every other
  // account of the same run.
  //
  // The `findUnauthenticated` safeguard does not close the gap and cannot by
  // construction: it is built as 'declared accessible, but granted nowhere', and
  // for an account the policy denies everywhere nothing is declared accessible,
  // so it stays silent on exactly the account whose token nothing else proves.
  //
  // Found twice. Adversarial review of 17 August: the deployment answered 401 to
  // everything, the tokens were stale, and the report came out clean with exit
  // code 0 — with `match: true` on each of the twelve cells at that. Adversarial
  // review of 19 August, against the rule written after it: a second account
  // carrying a dead token and no canary of its own, beside one healthy account
  // that had one. Exit 0, no warning, `match: true` on every denied cell — and
  // the claim being made about that account, 'a guest reaches nothing', is the
  // most valuable one such a run produces.
  //
  // Accounts without credentials are excluded: an anonymous run — 'check that
  // nobody at all can get in here' — has nothing to authenticate, and demanding a
  // canary of it would forbid a legitimate scenario.
  const unconfirmed = unconfirmedCredentials(report);
  if (unconfirmed.length > 0) {
    return {
      code: 2,
      reason:
        `credentials nothing confirmed: ${unconfirmed.join(", ")} — each of them has a token ` +
        `and no canary that passed, so every cell walked under it says what an ` +
        `unauthenticated request says and nothing about access. Declare a canary on an ` +
        `endpoint the policy allows that account; where the policy allows it nothing at ` +
        `all, nothing here can tell a dead token from a lawful denial, and an account ` +
        `whose token is not the point belongs in the run without one`,
    };
  }
  // A threshold, not 'every single one'. The previous condition required **all**
  // cells to fail: 99 errors out of a hundred gave exit code 0, that is 'tested,
  // clean' about a matrix of which one percent survived. Half is the line past
  // which the report stops claiming anything; it is declared here as a constant,
  // because a number hidden inside an expression is one nobody will dispute.
  // From `summary.verdictInputs`, which is separated by **source** and taken
  // before the evidence cap.
  //
  // It used to filter `report.findings` here, and that was right until that array
  // became the capped one on 17 August: the numerator was then bounded at fifty
  // per defect and `observations` below was not, so 101 cells that all failed to
  // answer exited 0. Not `summary.byKind` either, and that is B-4 — the map holds
  // kinds of matrix discrepancy and check identifiers in one key space, so a check
  // registered under `privilege-escalation` would be read here as a matrix one,
  // and this function takes a report from anywhere without ever seeing the
  // registry that refuses such a name. Both readings were wrong in different
  // directions; the counts are carried instead.
  const ofKind = (kind: DiffKind) => report.summary.verdictInputs.matrixByKind[kind];
  const probeErrors = ofKind("probe-error");
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
  const bySignal = report.summary.verdictInputs.failingCheckFindings;
  if (bySignal > 0) {
    return { code: 1, reason: `${bySignal} found by the response body rather than by status` };
  }

  // The line a cold read needed: "Distinct defects: at least 1" next to exit 0
  // reads as "a defect was found and the build is green" unless the summary says
  // out loud that nothing above the threshold was among them.
  //
  // The third wording is what an acceptance costs this sentence: "the rows above
  // are notes" stops being true the moment one of them is a critical finding
  // somebody signed for. Which rows those are is on the rows themselves, and how
  // many is in the clause `acceptanceNote` appends.
  const held = report.summary.accepted?.findings ?? 0;
  if (report.summary.findings === 0) {
    return { code: 0, reason: "no discrepancy with the declared policy" };
  }
  return {
    code: 0,
    reason:
      held > 0
        ? "no discrepancy that fails a run — the rows above are notes, or findings an " +
          "acceptance holds out of the verdict"
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
export function exitCodeFor(report: VerdictInputs): number {
  return runVerdict(report).code;
}

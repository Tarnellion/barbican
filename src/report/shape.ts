/**
 * What a report is, and what it is built from.
 *
 * There are no tokens in the report by construction, not as the result of a
 * clean-up pass: they live in a separate map and belong to neither the
 * configuration nor the observations. Response headers arrive from the HTTP
 * client already redacted.
 *
 * Both halves of the declaration in one file, by ADR-0054: `RunReport` is what
 * a consumer parses and `BuildReportOptions` is what a consumer passes, and the
 * two are the same contract read from its two ends. The mappings that satisfy
 * them are in `findings.ts` and `sections.ts`; `nothingLeftUnnamed` at the foot
 * of this file is what makes "every field accounted for" a statement the
 * compiler checks rather than a claim in a comment, and it lives here because
 * it is a statement about this shape.
 */

// `CheckRun` is shaped in the core and not here. Every field of it is the
// check's own — its id, what it asserts, the clauses it answers for — and this
// file's business is to carry it, not to decide what goes in. It was declared
// here, and `description` was the field the mapping that built it left out.
// See `describeChecks`.
import type { AuthScheme } from "../adapters/credentials.js";
import type { ThrottleLimits } from "../adapters/throttle.js";
import type {
  CheckCoverage,
  CheckRun,
  ResolvedFinding,
  StandardRef,
} from "../core/checks/types.js";
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
  HttpMethod,
  ResolvedAccessPolicy,
  Resource,
  ResourceRelation,
  Severity,
  TenantNode,
} from "../core/index.js";
// The clause-to-coverage direction. Shaped and computed in the core for the
// reason ADR-0041 gave for keeping `standardsForDiff` there: which clause a cell
// is evidence about is a statement about what a discrepancy means, and the
// report carries what a channel declares rather than deciding it.
import type { ClauseCoverage } from "../core/standards/coverage.js";
import type { ContextAttributeValue, RunConfig } from "../io/config.js";
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

/** The verdict on a run: the code CI acts on, and the sentence a human reads. */
export interface RunVerdict {
  readonly code: 0 | 1 | 2;
  readonly reason: string;
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
  /**
   * The run's identifier, where the caller already has one.
   *
   * The CLI does: `runId` has to exist before the first request or it cannot be
   * on the wire at all (ADR-0045), while this function runs after the last
   * response. Absent, one is minted here — a report without an identifier cannot
   * be told from the next report, and a consumer of the library assembling one
   * without having walked anything has nothing to pass.
   *
   * **An option and not a field to patch on afterwards.** `contentDigest` is
   * taken over the finished document as the last thing this function does, so
   * anything written onto the report after it returns is outside the digest —
   * and `{ ...built, runId }` in `src/cli/run.ts` was exactly that, one line
   * past the last thing that hashed anything. Every file the tool ever wrote
   * failed its own check. Whatever a caller wants in the document comes in
   * through here. See ADR-0058.
   */
  readonly runId?: string;
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

/**
 * Takes whatever a mapping did not name, and does not compile when there is any.
 *
 * The mappings that fill the shapes above rebuild a structure by naming its
 * fields one at a time, which is the right shape for a published format: the
 * report must not pass on what it does not mean to publish, and spreading a
 * source object into it would answer every future question with "publish it".
 * What such a mapping never had is a way to notice a field added upstream — and
 * two were lost exactly so: `CheckRun.description`, left out by a mapping in
 * `src/cli.ts` that named `id` and `standards`, and `contextId`, left off a
 * check finding by `mergeFindings` in `src/report/findings.ts`.
 *
 * Passing the rest of a destructuring through here is that notice. The
 * parameter admits only an object with nothing left in it, so a field added to
 * the source and named by neither half — carried, or withheld with the reason
 * written beside it — stops the build with the one question worth asking: which
 * of the two is it? Found by the audit of 14 August 2026 (B-12).
 *
 * It sits beside the shapes rather than beside the mappings because ADR-0054
 * put those in two files, and this is a statement about what a published field
 * costs — not about either mapping. Exported no further than the report layer:
 * `build.ts` does not re-export it, since a discipline the compiler applies to
 * this file's types says nothing to a consumer.
 */
export function nothingLeftUnnamed(_unnamed: Record<string, never>): void {
  // Nothing to do at runtime: the statement has already been checked by the
  // compiler, and the call is only what carries it to the mapping it is about.
}

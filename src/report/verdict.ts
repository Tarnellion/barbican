/**
 * What the run concluded, and what the numbers do not say on their own.
 *
 * Split out of `build.ts` by ADR-0054, and the two halves are here together
 * because they are one statement made twice. A warning and a verdict read the
 * same finished report and answer the same questions of it — was anything
 * looked at, was anything refused, did anything confirm the credentials — and
 * the one time they were written apart they drifted within four days.
 * `unconfirmedCredentials` below is the function that came out of that, and it
 * has a third reader in `sections.ts`.
 *
 * Everything here takes a `VerdictInputs` and nothing else: `runVerdict` and
 * `exitCodeFor` are exported, so a consumer hands over a saved file rather than
 * a run, and a function that reached for anything outside the report could not
 * answer for one.
 */

import type { DiffKind } from "../core/index.js";
import { byCodeUnits } from "../core/order.js";
import type { RunConfig } from "../io/config.js";
import { MAX_ROWS_PER_DEFECT } from "./findings.js";
import type { RunReport, RunVerdict } from "./shape.js";

/**
 * The sentences the console and the report both use.
 *
 * One source, because they are the same statement: a warning worded one way on
 * the terminal and another way in the file is two statements a reader has to
 * reconcile. See `RunReport.warnings`.
 */
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
export function unconfirmedCredentials(
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
export function warningsFor(report: VerdictInputs, config: RunConfig): readonly string[] {
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

/**
 * Who took part in the run, and how much of the surface it reached.
 *
 * Split out of `build.ts` by ADR-0054. Every mapping here answers a question a
 * reader asks *before* looking at a finding — which accounts, under which
 * conditions, against which target, with how many of the endpoints actually
 * probed — and none of them is keyed by a cell, which is what separates this
 * file from `findings.ts`.
 *
 * They are together rather than one per section because they are read together:
 * a coverage number means nothing without the account rows it was counted over,
 * and `clauseReservationsOf` at the foot of the file is the point where the two
 * meet — it is the same set of questions the warnings and the verdict ask of the
 * finished report, asked while `coverage` is still being written.
 */

import type { AuthScheme } from "../adapters/credentials.js";
import type { AccessObservation, AccessOutcome } from "../core/index.js";
import { principalOf } from "../core/index.js";
import { byCodeUnits } from "../core/order.js";
import type { ClauseReservation } from "../core/standards/coverage.js";
import type { AccountConfig, RequestContextConfig, RunConfig, RunTarget } from "../io/config.js";
import { lookup, openRecord } from "../io/untrusted.js";
import type { SkippedEndpoint } from "../runner.js";
import type {
  BuildReportOptions,
  CanaryOutcome,
  ReportedAccount,
  ReportedAuthScheme,
  ReportedContext,
  RunReport,
} from "./shape.js";
import { nothingLeftUnnamed } from "./shape.js";
import { unconfirmedCredentials } from "./verdict.js";

/**
 * Why endpoints were not probed, counted.
 *
 * A plain literal, where `countByContext` at the foot of this file needs
 * `openRecord`. The difference is the key space and not the shape of the loop:
 * `SkippedEndpoint["reason"]` is a closed union of four names this tool wrote
 * down, so `__proto__` cannot be one of them and there is nothing here for
 * ADR-0024 to guard. The moment a reason takes any part of its text from a
 * configuration or a response, this becomes the same record as the one below and
 * moves to `openRecord` with it. See ADR-0058.
 */
export function countByReason(
  skipped: readonly SkippedEndpoint[],
): Readonly<Record<string, number>> {
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
export type ConfiguredAccountRow = AccountConfig & {
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
export function withContextAccounts(options: BuildReportOptions): readonly ConfiguredAccountRow[] {
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
export function reportedAccount(account: ConfiguredAccountRow, config: RunConfig): ReportedAccount {
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
export function reportedContext(context: RequestContextConfig): ReportedContext {
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
export function reportedTarget(target: RunTarget): RunReport["target"] {
  const { baseUrl, allowedHosts, label, ...unnamed } = target;
  nothingLeftUnnamed(unnamed);
  return { baseUrl, allowedHosts, ...(label === undefined ? {} : { label }) };
}

/**
 * The scheme as the report names it.
 *
 * Why the report names it at all, and why `header` is on it, is written on
 * {@link ReportedAuthScheme} in `shape.ts` — ADR-0054 put the type with the
 * shape and the mapping with the mappings, and that reason belongs to the type.
 */
export function namedScheme(scheme: AuthScheme): ReportedAuthScheme {
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
 * Where the shape of this report is explained, for the version that wrote it.
 *
 * A tag when the version looks like a release, `main` otherwise — a development
 * build has no tag to point at, and a link into nothing is worse than a link
 * into the newest text.
 */
export function documentationUrl(version: string): string {
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
export function countByOutcome(
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
export function probedEndpointIds(options: BuildReportOptions): ReadonlySet<string> {
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
export function resourcesNeverFound(observations: readonly AccessObservation[]): readonly string[] {
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

/**
 * How many cells were observed under each set of conditions, untested included.
 *
 * Over a key space the tool does not own. A condition's id is `z.string().min(1)`
 * and nothing narrower — the label is the operator's to pick — so this is one of
 * the records ADR-0024 is about, and it was the one still built out of a plain
 * object literal. `counts["__proto__"] = 0` is a no-op, and the increment below
 * would read `Object.prototype`, add one to it and assign the resulting string
 * into the same no-op: a declared set of conditions vanished from the field
 * whose whole promise is that none of them is passed over in silence, which is
 * the reading `docs/report.md` gives a missing key — "nobody declared this".
 *
 * `countByKind` and `summary.accepted.byKind` in `findings.ts` are the same
 * shape and were already guarded; two records of one kind guarded differently is
 * exactly what that rule exists against. `openRecord` and `lookup` are the
 * grammar, written once in `src/io/untrusted.ts`. See ADR-0058.
 */
export function countByContext(options: BuildReportOptions): Readonly<Record<string, number>> {
  const counts = openRecord<number>();
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
      counts[contextId] = (lookup(counts, contextId) ?? 0) + 1;
    }
  }
  return counts;
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
export function clauseReservationsOf(input: {
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

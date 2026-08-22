/**
 * Tenant isolation check over body signals.
 *
 * Closes a class of defects invisible by status: a list endpoint with no tenant
 * filter answers 200 to everyone, and a correct implementation answers the same
 * way. The difference is entirely in the body — see ADR-0011.
 */

import { byCodeUnits } from "../order.js";
import type { TenantHierarchy } from "../tenancy.js";
import { createTenantHierarchy, FLAT_HIERARCHY } from "../tenancy.js";
import type { AccessObservation, Account, Endpoint, TenantId } from "../types.js";
import { tenantIdsOf } from "../types.js";
import {
  API_OBJECT_LEVEL_AUTHORIZATION,
  ASVS_TENANT_ISOLATION,
  CWE_IMPROPER_AUTHORIZATION,
} from "./clauses.js";
import type { Check, CheckContext, CheckCoverage, Finding } from "./types.js";

export const IDENTICAL_RESPONSE_CHECK_ID = "identical-response-across-tenants";

/** The default name of the digest signal. Overridden at registration. */
export const DEFAULT_DIGEST_SIGNAL = "digest";

/**
 * The signal that says the body was never read because it was too large.
 *
 * A body over `maxBodyBytes` yielded no signals, so the pair was skipped, the
 * comparison quietly became zero, and nothing in the report said why. "No
 * comparison was made" and "the bodies differed" are the two readings this whole
 * check exists to keep apart, and here the report offered neither. Found by the
 * audit of 14 August 2026 (D-5).
 *
 * A reserved name, like `digest` and for the same reason: a human declaring a
 * scalar of this name would take its place, and the check would then read
 * something else without anybody being told.
 */
export const BODY_OVER_LIMIT_SIGNAL = "bodyOverLimit";

/**
 * The signal that says a declared subtree was not there to hash.
 *
 * A digest scoped by `compareSubtree` needs the body to be JSON and the path to
 * resolve. Where either fails there is no digest — falling back to the whole
 * body would compare something other than what the configuration asked for, and
 * under the same field name. That leaves the observation without a digest, which
 * is the same silence `BODY_OVER_LIMIT_SIGNAL` was introduced for, so it gets
 * the same treatment: a flag saying which silence it is.
 *
 * Reserved for the same reason as the other two names. See ADR-0044.
 */
export const DIGEST_SCOPE_MISSING_SIGNAL = "digestScopeMissing";

export interface IdenticalResponseCheckOptions {
  readonly digestSignal?: string;
}

/**
 * The other scalars of an observation — the ones a human declared for digging in.
 *
 * They land in the evidence under a side prefix: "alice sees 4 records, carol
 * sees 4, and there are 4 in total" convinces more than "the digests matched".
 */
function scalarsOf(
  observation: AccessObservation,
  digestSignal: string,
  side: "own" | "other",
): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {};
  for (const [name, value] of Object.entries(observation.signals ?? {})) {
    if (name !== digestSignal) {
      out[`${side}.${name}`] = value;
    }
  }
  return out;
}

function digestOf(observation: AccessObservation, name: string): number | undefined {
  const value = observation.signals?.[name];
  return typeof value === "number" ? value : undefined;
}

/**
 * How to name an account's membership in the text of a finding.
 *
 * An account outside tenants (an anonymous one) has no tenant, and a reserved
 * name must not be substituted here: a sentinel string would come back into the
 * report, indistinguishable from a real tenant with the same name.
 */
function tenantLabel(account: Account): string {
  const tenants = tenantIdsOf(account);
  if (tenants.length === 0) {
    return `an account outside tenants (${account.id})`;
  }
  return tenants.length === 1 ? `tenant ${tenants[0]}` : `tenants ${tenants.join(", ")}`;
}

/**
 * Whether two accounts have a tenant in common.
 *
 * A generalization of the former `leftTenant === rightTenant` comparison to
 * sets: if even one tenant is shared, matching responses are legitimate and say
 * nothing about isolation — just as they said nothing about two neighbors inside
 * one tenant.
 */
function shareTenant(left: readonly TenantId[], right: readonly TenantId[]): boolean {
  return left.some((tenant) => right.includes(tenant));
}

/**
 * Whether the sets are related by kinship through at least one pair.
 *
 * Kinship is counted only between declared tenants: an account outside tenants
 * has an empty set, it has no kin, and such a pair is compared — as it was
 * before.
 */
function related(
  left: readonly TenantId[],
  right: readonly TenantId[],
  hierarchy: TenantHierarchy,
): boolean {
  return left.some((outer) =>
    right.some((inner) => hierarchy.isAncestor(outer, inner) || hierarchy.isAncestor(inner, outer)),
  );
}

/**
 * The names of the scalars a human declared as counts on this endpoint.
 *
 * These are the tool's only way to tell an empty response from a full one, and
 * they cost nothing extra: the body is already read for the digest, and a count
 * is a number over a path an operator wrote down. Nothing here reads more of the
 * body than ADR-0011 allows, and no new kind of `SignalValue` is involved.
 */
function countSignalsOf(endpoint: Endpoint): readonly string[] {
  return (endpoint.signals ?? []).filter((spec) => spec.kind === "count").map((spec) => spec.name);
}

/**
 * Whether the human's own counts say this response carried nothing.
 *
 * Every declared count has to be present and zero. "Present" matters: a count is
 * absent when the path was not an array or the body was not JSON, and reading
 * that absence as emptiness would be a claim nothing measured — the same reason
 * the extractor writes no zero in that case.
 *
 * With no count declared the answer is `false`, and it has to be: there is
 * nothing here that means "empty", and guessing would put the check back to
 * deciding for the operator what their endpoint returns. The endpoint's coverage
 * carries the number of counts declared, so a reader can see the difference
 * between "not empty" and "nothing here could have said".
 *
 * The record is indexed by names the operator chose, as `digestOf` does one
 * screen up. The extractor builds it with `openRecord`, so there is no prototype
 * to answer for `constructor`; a record assembled by a library consumer might,
 * and a value that is not a number is treated as "not measured" — the safe
 * direction, since it keeps a pair being compared rather than silently dropping
 * it.
 */
function declaredEmpty(observation: AccessObservation, countSignals: readonly string[]): boolean {
  if (countSignals.length === 0) {
    return false;
  }
  return countSignals.every((name) => observation.signals?.[name] === 0);
}

/**
 * Whether a pair of accounts is comparable.
 *
 * One place for the whole check: both the walk itself and the coverage
 * recomputation ask from here. Take them apart and coverage starts describing
 * something other than what happens.
 */
function comparable(left: Account, right: Account, hierarchy: TenantHierarchy): boolean {
  // Different request conditions must not be compared: two variables would
  // change in such a pair at once — the tenant and the attributes — and matching
  // digests would say nothing about either. What the check asserts is "different
  // tenants get different responses **all else being equal**". See ADR-0019.
  if (left.contextId !== right.contextId) {
    return false;
  }
  const leftTenants = tenantIdsOf(left);
  const rightTenants = tenantIdsOf(right);
  if (leftTenants.length === 0 && rightTenants.length === 0) {
    return false;
  }
  if (shareTenant(leftTenants, rightTenants)) {
    return false;
  }
  return !related(leftTenants, rightTenants, hierarchy);
}

/**
 * What became of one pair of observations.
 *
 * Six outcomes where the report used to show two, and every one of them is a
 * different sentence about the same silence. `comparedPairs` grew by one whether
 * the digests matched, differed, or were never compared at all, so a reader
 * could not tell "we compared and they honestly differed" from "we compared, the
 * difference sat in a request identifier, and the leak went past us". See
 * ADR-0044.
 */
type PairVerdict =
  /** Compared, and the digests matched. This is the finding. */
  | "matched"
  /** Compared, and the digests differed. **Not** a proof of isolation — only that the bytes differed. */
  | "differed"
  /** Every count a human declared was zero on both sides: nothing to conclude either way. */
  | "both-empty"
  /** One side or both had no digest — the body was over the ceiling, or a declared subtree was absent. */
  | "no-digest"
  /** A shared tenant, or kinship along the tree: matching responses are lawful. */
  | "related"
  /** Different request conditions: two variables would move at once. */
  | "different-context";

interface ObservedPair {
  readonly left: AccessObservation;
  readonly right: AccessObservation;
  readonly leftAccount: Account;
  readonly rightAccount: Account;
  readonly verdict: PairVerdict;
}

/** The tenant tree of a run, or the flat one when none was declared. */
function hierarchyOf(context: CheckContext): TenantHierarchy {
  return context.matrix.tenants === undefined
    ? FLAT_HIERARCHY
    : createTenantHierarchy(context.matrix.tenants);
}

/**
 * Every pair on one endpoint, each with its verdict.
 *
 * The single walk both `run` and `coverage` go through. They used to be two
 * loops with the pair rules written out twice, and the note beside `comparable`
 * says what that costs: coverage starts describing something other than what
 * happened. It very nearly did — the outcome of a comparison is now part of the
 * coverage, and recomputing that beside the findings would be the same fact
 * derived twice from the same data by two pieces of code.
 *
 * Observations are **not** filtered by having a digest here, which is the change
 * that lets a pair without one be counted instead of vanishing. The filter used
 * to sit in front of the pairing, so a body over the size ceiling took its pair
 * out of every number in the report, and nothing said so — the silence D-5
 * closed on the observation, still open one layer above it.
 */
function* pairsOn(
  endpoint: Endpoint,
  context: CheckContext,
  digestSignal: string,
): Generator<ObservedPair> {
  const hierarchy = hierarchyOf(context);
  const accountById = new Map(context.matrix.accounts.map((account) => [account.id, account]));
  const countSignals = countSignalsOf(endpoint);

  const relevant = context.matrix.observations
    .filter(
      (observation) =>
        observation.endpointId === endpoint.id &&
        observation.resourceId === undefined &&
        observation.outcome === "allowed",
    )
    // The order decides which side of a matched pair is the finding's subject
    // and which is its `relatedAccountId`, so it is printed. It was
    // `localeCompare()` with no locale and moved with the machine's `LC_ALL`;
    // see `../order.js`, found by the audit of 21 August 2026 (L-2).
    .sort((left, right) => byCodeUnits(left.accountId, right.accountId));

  for (let i = 0; i < relevant.length; i += 1) {
    for (let j = i + 1; j < relevant.length; j += 1) {
      const left = relevant[i];
      const right = relevant[j];
      if (left === undefined || right === undefined) {
        continue;
      }
      const leftAccount = accountById.get(left.accountId);
      const rightAccount = accountById.get(right.accountId);
      if (leftAccount === undefined || rightAccount === undefined) {
        continue;
      }

      const verdict = verdictFor(left, right, leftAccount, rightAccount, {
        hierarchy,
        countSignals,
        digestSignal,
      });
      yield { left, right, leftAccount, rightAccount, verdict };
    }
  }
}

/**
 * The verdict on one pair, in the order the reasons rule each other out.
 *
 * Comparability first: a pair of the same tenant, of kin, or under different
 * conditions is not a pair this check has anything to say about, whatever its
 * bodies look like. Then emptiness, because a pair where both sides carried
 * nothing gives the same digest on a healthy platform and on a broken one — the
 * false positive that arrives by the wall on a fresh deployment. Only then the
 * digests.
 */
function verdictFor(
  left: AccessObservation,
  right: AccessObservation,
  leftAccount: Account,
  rightAccount: Account,
  rules: {
    readonly hierarchy: TenantHierarchy;
    readonly countSignals: readonly string[];
    readonly digestSignal: string;
  },
): PairVerdict {
  if (!comparable(leftAccount, rightAccount, rules.hierarchy)) {
    // Two reasons, and one number for both would hide both: "skipped because of
    // kinship" is simply untrue about a pair under different conditions.
    return leftAccount.contextId === rightAccount.contextId ? "related" : "different-context";
  }
  if (declaredEmpty(left, rules.countSignals) && declaredEmpty(right, rules.countSignals)) {
    return "both-empty";
  }
  const leftDigest = digestOf(left, rules.digestSignal);
  const rightDigest = digestOf(right, rules.digestSignal);
  if (leftDigest === undefined || rightDigest === undefined) {
    return "no-digest";
  }
  return leftDigest === rightDigest ? "matched" : "differed";
}

/**
 * Two accounts from different tenants got the same response digest.
 *
 * The digest, not the body: bodies are not stored and there is nothing to
 * compare them with (ADR-0011). Hence the name of the field in the evidence —
 * `bodyDigestsEqual` rather than the former `identicalBody`: a 48-bit collision
 * is unlikely, but the tool never checked the claim of a byte-for-byte match and
 * has no right to make it.
 *
 * The check fires only on endpoints for which a human declared
 * `responseMustDifferByTenant`. Without that declaration `GET /v1/health` with
 * its `{"status":"ok"}`, the same for everyone, would become a finding, and real
 * leaks would drown in the noise.
 *
 * Only requests **without a resource** are considered. When a resource is given,
 * both accounts read the very same record, and an identical response is not a
 * sign of a defect but its consequence: the very fact that a foreign tenant
 * reached the resource is already visible by status and lands in the diff.
 * Duplicating it here means counting one defect twice.
 */
export function createIdenticalResponseCheck(options: IdenticalResponseCheckOptions = {}): Check {
  const digestSignal = options.digestSignal ?? DEFAULT_DIGEST_SIGNAL;

  return {
    id: IDENTICAL_RESPONSE_CHECK_ID,
    description:
      "The response digest matched for accounts from different tenants on an " +
      "endpoint whose response was declared to differ between them: the sign of " +
      "a missing tenant filter",
    severity: "high",
    /**
     * API3 (property-level) was removed on purpose: the check knows nothing
     * about fields, it compares the response as a whole. Being credited with a
     * class of finding it cannot find is an inflated claim of coverage.
     *
     * CWE-285, not 862 or 863: from the outside "there is no check" and "there
     * is a check but it is wrong" give an indistinguishable answer, so only the
     * parent class is honest.
     *
     * The three were literals here until 21 August 2026, when the matrix channel
     * gained a mapping of its own and the same clause had to be named twice
     * (ADR-0041). Named constants, so that there are two places assigning a
     * clause and one place spelling it.
     */
    standards: [API_OBJECT_LEVEL_AUTHORIZATION, ASVS_TENANT_ISOLATION, CWE_IMPROPER_AUTHORIZATION],

    coverage(context: CheckContext): readonly CheckCoverage[] {
      return describeBodyComparison(context, options);
    },

    run(context: CheckContext): readonly Finding[] {
      const { endpoints } = context.matrix;

      // Pairs are skipped for a shared tenant (legitimate sameness, as with
      // neighbors, and with partially overlapping sets too), for kinship along
      // the tree (a holding's rollup legitimately matches its brand's response),
      // for differing request conditions, and — since ADR-0044 — where the
      // human's own counts say both sides carried nothing. A pair of "a tenant
      // against an account outside tenants" is compared, and must be: a match
      // means the tenant's data is visible to someone who is not a member of it.
      // All of that is `verdictFor`, which the coverage below reads too.
      //
      // By id, and one entry per id: this used to build a `Set` of ids, and a
      // matrix carrying an endpoint twice — which the configuration door
      // refuses and the library door does not — would otherwise report every
      // pair on it twice.
      const declared = new Map(
        endpoints
          .filter((endpoint) => endpoint.responseMustDifferByTenant === true)
          .map((endpoint) => [endpoint.id, endpoint]),
      );
      if (declared.size === 0) {
        return [];
      }
      const findings: Finding[] = [];

      for (const endpointId of [...declared.keys()].sort(byCodeUnits)) {
        const endpoint = declared.get(endpointId);
        if (endpoint === undefined) {
          continue;
        }
        for (const pair of pairsOn(endpoint, context, digestSignal)) {
          if (pair.verdict !== "matched") {
            continue;
          }
          const { left, right, leftAccount, rightAccount } = pair;
          findings.push({
            checkId: IDENTICAL_RESPONSE_CHECK_ID,
            // No severity here. It is declared once, on the check above, and
            // `runChecks` puts it on. It used to be repeated as a literal in
            // this object — the same word in two places in one file, with
            // nothing to keep them equal, in a value the exit code is derived
            // from. Found by the audit of 14 August 2026 (L-8).
            //
            // The title speaks of the digest, not of the response: bodies are
            // not stored, and there was nothing to compare them with. See
            // `bodyDigestsEqual`.
            title: `Response digest of ${endpointId} matched for ${tenantLabel(leftAccount)} and ${tenantLabel(rightAccount)}`,
            endpointId,
            accountId: leftAccount.id,
            // A pair is always under the same conditions — different ones are
            // not compared — so the finding has one set of conditions, not two
            // fields. Without them a finding under conditions and the same one
            // in the baseline merged into a single defect group, and the report
            // declared two breakages one. Found by a cold read.
            ...(leftAccount.contextId === undefined ? {} : { contextId: leftAccount.contextId }),
            // A field, not a key in `evidence`. The report reads this to print
            // the other side's request and to group both sides as one defect,
            // and it used to dig it out of `evidence.otherAccountId` — a
            // convention typed as "some scalar", documented nowhere, and
            // undiscoverable by a new check. It stays in `evidence` as well,
            // for whoever is reading one finding rather than the schema.
            relatedAccountId: rightAccount.id,
            evidence: {
              // The values, not only the verdict. "The digests matched" on its
              // own leaves the most convincing number of the run — how many
              // records each account saw — for the reader to go and join by
              // hand out of the observations.
              //
              // The digest itself is **not** among them; see the note beside
              // `bodyDigestsEqual` below. It used to be, contradicting that
              // note eighteen lines further down in the same object, and it
              // was an exact duplicate of `signals.digest` on the observation
              // for this very cell. Found by the audit of 14 August 2026 and
              // decided on 15 August in favour of the note.
              ...scalarsOf(left, digestSignal, "own"),
              ...scalarsOf(right, digestSignal, "other"),
              otherAccountId: rightAccount.id,
              // The key is absent when there is no tenant: an empty spot reads
              // as "outside tenants", while a placeholder would read as a name.
              //
              // For an account with a set of memberships there is no key
              // either, and it is the same reason, not thrift. Gluing the
              // names with commas would put into a field that holds real
              // identifiers a string no tenant is called by — and it would be
              // read as a name. The names of the set are given by the title of
              // the finding.
              ...(leftAccount.tenantId === undefined ? {} : { tenant: leftAccount.tenantId }),
              ...(rightAccount.tenantId === undefined
                ? {}
                : { otherTenant: rightAccount.tenantId }),
              status: left.status,
              // The digest value is not carried into the finding: it is
              // meaningful only inside one run — the salt is random — so it
              // tells the reader of the report nothing, and `evidence` is
              // documented as statuses, flags and identifiers, none of which
              // it is. Whoever does want it has it: `signals.digest` on the
              // observation for this cell is the same number, and that is
              // where a per-cell measurement belongs.
              //
              // What is carried is the fact of equality, named after what was
              // actually checked: 48 bits of salted SHA-256 matched, not the
              // bodies. A collision is unlikely (of the order of 10⁻⁹ over a
              // thousand responses, ADR-0011), but the report becomes the
              // basis of an incident, and there the difference between "the
              // bodies matched" and "the digests matched" is fundamental.
              bodyDigestsEqual: true,
            },
          });
        }
      }

      return findings;
    },
  };
}

/**
 * What the check compared, endpoint by endpoint, and how each comparison came
 * out.
 *
 * Reported through `Check.coverage`, in the generic shape every check uses. It
 * was a type of its own that `src/report/build.ts` imported from this module —
 * the report layer knowing one plugin by name, which is what ADR-0003 exists to
 * prevent. Closed with L-4.
 *
 * The counters, and why each one is separate:
 *
 * `comparedPairs` — pairs actually compared. Kept as the total it always was,
 * and checkable on the spot: `comparedPairs === matchedPairs + differedPairs`.
 *
 * `matchedPairs` — compared, and the digests matched. One finding each.
 *
 * `differedPairs` — compared, and the digests differed. Split off from
 * `comparedPairs` with ADR-0044: the two used to grow together, so nothing in
 * the report told "we compared and they honestly differed" from "we compared,
 * the difference was a `requestId` in the envelope, and the leak went past us".
 * A number that answers the first question and not the second is the number a
 * reader will take for the first.
 *
 * `skippedBothEmptyPairs` — every count a human declared was zero on both sides.
 * Two tenants with no records return the same bytes on a healthy platform and on
 * a broken one, so the pair proves nothing either way, and counting it as
 * compared is how a fresh deployment produced a wall of findings.
 *
 * `pairsWithoutDigest` — one side or both had no digest: a body over the size
 * ceiling, or a declared subtree that was not there. Before this number such a
 * pair was filtered out ahead of pairing and vanished from the report entirely.
 *
 * `emptinessSignalsDeclared` — how many `count` signals this endpoint has. Zero
 * means the tool has no way to tell an empty response from a full one here, so
 * `skippedBothEmptyPairs` could not have fired whatever the platform returned.
 * A reader comparing two runs needs to know which of the two states they are in.
 *
 * `skippedRelatedPairs` — skipped for a shared tenant or kinship in the tree.
 * Named apart because the report's silence about them reads as "there were no
 * matches". On the reference platform the holding and the support account with a
 * set of memberships match by digest, legitimately.
 *
 * `skippedDifferentContextPairs` — skipped because the request conditions
 * differed. A different reason from kinship, and one number for both would hide
 * both. Absent when no conditions are declared.
 *
 * It lives next to the check on purpose: the pair rules are described here, and
 * repeating them in report assembly would mean a duplicate that drifts. It does
 * not merely live next to them any more — since ADR-0044 it walks the very same
 * `pairsOn`, so a verdict cannot be counted one way and reported another.
 */
function describeBodyComparison(
  context: CheckContext,
  options: IdenticalResponseCheckOptions = {},
): readonly CheckCoverage[] {
  const digestSignal = options.digestSignal ?? DEFAULT_DIGEST_SIGNAL;

  return context.matrix.endpoints
    .filter((endpoint) => endpoint.responseMustDifferByTenant === true)
    .map((endpoint) => {
      const tally: Record<PairVerdict, number> = {
        matched: 0,
        differed: 0,
        "both-empty": 0,
        "no-digest": 0,
        related: 0,
        "different-context": 0,
      };
      for (const pair of pairsOn(endpoint, context, digestSignal)) {
        tally[pair.verdict] += 1;
      }

      return {
        checkId: IDENTICAL_RESPONSE_CHECK_ID,
        endpointId: endpoint.id,
        counters: {
          comparedPairs: tally.matched + tally.differed,
          matchedPairs: tally.matched,
          differedPairs: tally.differed,
          skippedBothEmptyPairs: tally["both-empty"],
          pairsWithoutDigest: tally["no-digest"],
          emptinessSignalsDeclared: countSignalsOf(endpoint).length,
          skippedRelatedPairs: tally.related,
          ...(tally["different-context"] === 0
            ? {}
            : { skippedDifferentContextPairs: tally["different-context"] }),
        },
      };
    });
}

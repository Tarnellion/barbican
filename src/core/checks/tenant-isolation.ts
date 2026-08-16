/**
 * Tenant isolation check over body signals.
 *
 * Closes a class of defects invisible by status: a list endpoint with no tenant
 * filter answers 200 to everyone, and a correct implementation answers the same
 * way. The difference is entirely in the body — see ADR-0011.
 */

import type { TenantHierarchy } from "../tenancy.js";
import { createTenantHierarchy, FLAT_HIERARCHY } from "../tenancy.js";
import type { AccessObservation, Account, TenantId } from "../types.js";
import { tenantIdsOf } from "../types.js";
import type { Check, CheckContext, CheckCoverage, Finding } from "./types.js";

export const IDENTICAL_RESPONSE_CHECK_ID = "identical-response-across-tenants";

/** The default name of the digest signal. Overridden at registration. */
export const DEFAULT_DIGEST_SIGNAL = "digest";

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
     */
    standards: [
      { standard: "OWASP-API-2023", clause: "API1" },
      { standard: "OWASP-ASVS-5.0", clause: "8.4.1" },
      { standard: "CWE", clause: "285" },
    ],

    coverage(context: CheckContext): readonly CheckCoverage[] {
      return describeBodyComparison(context, options);
    },

    run(context: CheckContext): readonly Finding[] {
      const { endpoints, accounts, observations } = context.matrix;

      const mustDiffer = new Set(
        endpoints
          .filter((endpoint) => endpoint.responseMustDifferByTenant === true)
          .map((endpoint) => endpoint.id),
      );
      if (mustDiffer.size === 0) {
        return [];
      }

      const accountById = new Map<string, Account>(
        accounts.map((account) => [account.id, account]),
      );
      // Pairs related by kinship must not be compared. A holding sees the union
      // of its brands; if it has only one brand, its response legitimately
      // matches that brand's — and without accounting for the tree the check
      // would declare a rollup on a healthy platform a leak. Found by running
      // the holding scenario.
      const hierarchy =
        context.matrix.tenants === undefined
          ? FLAT_HIERARCHY
          : createTenantHierarchy(context.matrix.tenants);
      const findings: Finding[] = [];

      for (const endpointId of [...mustDiffer].sort()) {
        const relevant = observations
          .filter(
            (observation) =>
              observation.endpointId === endpointId &&
              observation.resourceId === undefined &&
              observation.outcome === "allowed" &&
              digestOf(observation, digestSignal) !== undefined,
          )
          .sort((left, right) => left.accountId.localeCompare(right.accountId));

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
            // Skips: both outside tenants (they have no different tenant); a
            // shared tenant (legitimate sameness, as with neighbors, and with
            // partially overlapping sets too); kinship along the tree (a
            // holding's rollup legitimately matches the response of its brand).
            // A pair of "a tenant against an account outside tenants" is
            // compared — and must be: a match means the tenant's data is visible
            // to someone who is not a member of it.
            if (!comparable(leftAccount, rightAccount, hierarchy)) {
              continue;
            }
            const leftDigest = digestOf(left, digestSignal);
            if (leftDigest !== digestOf(right, digestSignal) || leftDigest === undefined) {
              continue;
            }

            findings.push({
              checkId: IDENTICAL_RESPONSE_CHECK_ID,
              severity: "high",
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
                // The values, not only the verdict. "The digests matched"
                // without the digests themselves forces the reader to go into
                // the observations and join them by hand; the most convincing
                // number of the run — "how many records each account saw" — was
                // left aside.
                digest: leftDigest,
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
                // The digest value itself is not carried out: it is meaningful
                // only inside a run (the salt is random) and tells the reader of
                // the report nothing. What is carried out is the fact of
                // equality — and it is named after what was checked: 48 bits of
                // salted SHA-256 matched, not the bodies. A collision is
                // unlikely (of the order of 10⁻⁹ over a thousand responses,
                // ADR-0011), but the report becomes the basis of an incident, and
                // there the difference between "the bodies matched" and "the
                // digests matched" is fundamental.
                bodyDigestsEqual: true,
              },
            });
          }
        }
      }

      return findings;
    },
  };
}

/**
 * What the check compared, endpoint by endpoint.
 *
 * Reported through `Check.coverage`, in the generic shape every check uses. It
 * was a type of its own that `src/report/build.ts` imported from this module —
 * the report layer knowing one plugin by name, which is what ADR-0003 exists to
 * prevent. Closed with L-4.
 *
 * The three counters and why each is separate:
 *
 * `comparedPairs` — pairs actually compared.
 *
 * `skippedRelatedPairs` — skipped for tenant kinship. Named apart because the
 * report's silence about them reads as "there were no matches". On the reference
 * platform the holding and the support account with a set of memberships match
 * by digest, legitimately, and without this number there is nothing to tell
 * "skipped" from "compared and differed".
 *
 * `skippedDifferentContextPairs` — skipped because the request conditions
 * differed. A different reason from kinship, and one number for both would hide
 * both. Absent when no conditions are declared.
 *
 * It lives next to the check on purpose: the pair-skipping rule is described
 * here, and repeating it in report assembly would mean a duplicate that drifts.
 */
function describeBodyComparison(
  context: CheckContext,
  options: IdenticalResponseCheckOptions = {},
): readonly CheckCoverage[] {
  const digestSignal = options.digestSignal ?? DEFAULT_DIGEST_SIGNAL;
  const hierarchy =
    context.matrix.tenants === undefined
      ? FLAT_HIERARCHY
      : createTenantHierarchy(context.matrix.tenants);
  const accountById = new Map(context.matrix.accounts.map((account) => [account.id, account]));

  return context.matrix.endpoints
    .filter((endpoint) => endpoint.responseMustDifferByTenant === true)
    .map((endpoint) => {
      const relevant = context.matrix.observations.filter(
        (observation) =>
          observation.endpointId === endpoint.id &&
          observation.resourceId === undefined &&
          observation.outcome === "allowed" &&
          digestOf(observation, digestSignal) !== undefined,
      );
      let compared = 0;
      let skipped = 0;
      let skippedByContext = 0;
      for (let i = 0; i < relevant.length; i += 1) {
        for (let j = i + 1; j < relevant.length; j += 1) {
          const left = accountById.get(relevant[i]?.accountId ?? "");
          const right = accountById.get(relevant[j]?.accountId ?? "");
          if (left === undefined || right === undefined) {
            continue;
          }
          if (comparable(left, right, hierarchy)) {
            compared += 1;
          } else if (left.contextId !== right.contextId) {
            // Counted separately: "skipped because of kinship" is untrue about
            // this pair, and one number for two different reasons would hide
            // both.
            skippedByContext += 1;
          } else {
            skipped += 1;
          }
        }
      }
      return {
        checkId: IDENTICAL_RESPONSE_CHECK_ID,
        endpointId: endpoint.id,
        counters: {
          comparedPairs: compared,
          skippedRelatedPairs: skipped,
          ...(skippedByContext === 0 ? {} : { skippedDifferentContextPairs: skippedByContext }),
        },
      };
    });
}

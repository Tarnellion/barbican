/**
 * Grouping discrepancies by defect signature.
 *
 * One defect in the platform gives as many rows as there are cells it touched. A
 * run against crAPI gave six rows for three BOLAs — the same three defects, seen
 * from a user's point of view and from an administrator's. On the reference
 * platform one missing filter gives ten rows. Such a report cannot be read: the
 * numbers speak of the size of the matrix, not of the number of problems.
 */

import { joinKey } from "./keys.js";
import { byCodeUnits } from "./order.js";
import type { ResourceRelation, Severity } from "./types.js";

/**
 * The three coordinates a defect is identified by.
 *
 * Named on their own because two things ask for exactly them and neither is a
 * finding: `defectSignature` reads nothing else, and an acceptance
 * (`src/core/accepted.ts`) is written against these three and a kind. Demanding
 * a whole `GroupableFinding` of a declaration that has no account and no
 * severity would have meant inventing values for both, which is how a key
 * quietly stops being the key.
 */
export interface DefectCoordinates {
  readonly endpointId: string;
  readonly contextId?: string | undefined;
  readonly relation?: ResourceRelation | undefined;
}

/**
 * The minimum needed for grouping.
 *
 * A structural type rather than `AccessDiff`: findings from checks are grouped
 * on equal terms with matrix discrepancies. They have neither `expected` nor
 * `actual`, but they have everything the signature is made of — and six clones
 * of one finding must collapse the same way ten cells of one missing filter do.
 */
export interface GroupableFinding extends DefectCoordinates {
  readonly accountId: string;
  /**
   * The other side of the finding, when it is a pair.
   *
   * A leak seen by body has two sides, and `accountId` names one. A group
   * without the second read as "tenant-a's data is visible to somebody" — to
   * whom exactly had to be looked up in the `evidence` of every row. Found by a
   * cold read.
   */
  readonly counterpartAccountId?: string | undefined;
  readonly resourceId?: string | undefined;
  readonly kind: string;
  readonly severity: Severity;
  /**
   * Whether an acceptance holds this finding out of the verdict right now.
   *
   * Carried into the group so that `defects[]` — the array a reader actually
   * reads, sorted by severity — does not print a critical row with nothing on it
   * to say the run was told about it. An expired acceptance is not this: the
   * finding counts again, so it is not marked accepted either. See ADR-0048.
   */
  readonly accepted?: boolean | undefined;
}

/**
 * The signature: endpoint, relation to the resource and request conditions.
 *
 * The role is deliberately not part of the signature. If an endpoint was opened
 * to a user and to an administrator alike, the defect is one — a missing check —
 * not two.
 *
 * Conditions are part of it for the same reason as the relation: the country
 * check and the permission check are different mechanisms of the platform, they
 * break independently and are fixed in different places, so here too there are
 * two defects, not one.
 *
 * **The kind is not part of it, since 17 August 2026.** It was, and that made
 * this count the one thing a lower bound may never be: larger than the truth. An
 * endpoint with no authorization on it at all answers a request it should refuse
 * *and* returns the same body to every tenant, so it produced a
 * `privilege-escalation` group and an `identical-response-across-tenants` group —
 * two defects for one missing check, and two tickets to the same team, the second
 * closed as a duplicate of the first. How a defect was noticed is not what a
 * defect is. See `kinds` below and ADR-0030; found by the audit of 14 August
 * 2026 (B-6).
 */
export interface DefectGroup {
  /**
   * A name for this group that survives the next run.
   *
   * "Defect #5 from run X" pointed elsewhere a month later: the array is ordered
   * by severity, so one fix upstream renumbers everything below it. The key is
   * the signature the grouping already uses — endpoint, kind, relation,
   * conditions — so two runs of the same configuration against the same platform
   * name the same defect the same way, and a ticket can cite it. Found by the
   * audit of 14 August 2026 (H-10).
   *
   * Readable rather than hashed, for the same reason the finding carries a
   * `request` and not an identifier: what a human pastes into a ticket should be
   * something they can also read.
   */
  readonly key: string;
  readonly endpointId: string;
  /** The request conditions. Absent on discrepancies in baseline conditions. */
  readonly contextId?: string;
  /**
   * Every way this defect showed itself, sorted, at least one.
   *
   * Kinds of matrix discrepancy and check identifiers in one list, because they
   * are one key space and the reader is asking "what is wrong with this
   * endpoint", not "which subsystem of the tool spoke first". A defect seen both
   * by status and by body has two entries here and is one group.
   */
  readonly kinds: readonly string[];
  /** Absent on discrepancies with no resource — access to a whole function. */
  readonly relation?: ResourceRelation;
  /** The highest severity among the group's observations. */
  readonly severity: Severity;
  /** The accounts the defect concerns — for paired findings, both sides. */
  readonly accountIds: readonly string[];
  /** The resources it was observed on. Empty on discrepancies with no resource. */
  readonly resourceIds: readonly string[];
  /**
   * Which of `kinds` an acceptance currently holds out of the verdict.
   *
   * Absent when none of them is. A group whose `acceptedKinds` covers its
   * `kinds` is a breakage the operator has declared known; one where it covers
   * some of them is the case ADR-0030 predicted — the same endpoint failing a
   * second way, which nobody has looked at yet. The severity above is not
   * lowered for either: what an acceptance changes is the verdict, not the
   * finding.
   */
  readonly acceptedKinds?: readonly string[];
  /**
   * How many cells were touched.
   *
   * Named `violations` rather than `observations`: the top-level `observations`
   * means "probes performed", and one word in two senses read as "the defect was
   * observed on 10 probes out of however many".
   */
  readonly violations: number;
}

/**
 * Severity as a sort key, most severe first.
 *
 * Exported because the finding list is ordered by it too, and two orderings of
 * the same five levels would be a duplicate that drifts.
 */
export const SEVERITY_ORDER: Readonly<Record<Severity, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

/**
 * The citable form of the same signature `defectSignature` builds.
 *
 * The separator is a space rather than the NUL the signature uses: this one is
 * read by people and pasted into tickets, that one is a map key and must not
 * admit a collision between two different signatures glued together.
 *
 * Exported since 21 August 2026, because an acceptance is written against this
 * string and prints it back: `accepted[].defect` in the report is the same words
 * as `defects[].key`, and it is one function that makes them so rather than two
 * that agree today. See ADR-0048.
 */
export function citableDefectKey(of: DefectCoordinates): string {
  return [of.endpointId, of.relation ?? "any-resource", of.contextId ?? "baseline"].join(" ");
}

/**
 * The signature two findings share when they describe one breakage.
 *
 * Exported because the report has to cap its evidence rows **per defect** rather
 * than globally, and the only way to do that without a second, drifting notion
 * of "the same defect" is to ask the grouping what it thinks. A first-N cap over
 * the flat list would let one endpoint leaking to two thousand accounts crowd
 * out the single row of a rarer defect — and the rare one is the interesting one.
 */
export function defectSignature(of: DefectCoordinates): string {
  // A separator that never occurs in identifiers: gluing with a hyphen would
  // admit a collision of two different signatures into one string. `joinKey`
  // rather than the character, which does not leave `./keys.js` — ADR-0060.
  return joinKey(of.endpointId, of.relation ?? "", of.contextId ?? "");
}

const keyOf = defectSignature;

/**
 * Reduces discrepancies to signatures.
 *
 * **This is a lower bound on the number of defects, not an exact value.** Two
 * different bugs in the platform that give the same signature are
 * indistinguishable from the outside: "the list of my orders" and "the list of
 * my group's orders" are different queries with different filters, but a 200
 * where a denial was expected looks the same. The upper bound is the number of
 * observations themselves; the truth is between them, and the tool does not know
 * it.
 */
export function groupDefects(diffs: readonly GroupableFinding[]): readonly DefectGroup[] {
  const groups = new Map<
    string,
    {
      endpointId: string;
      key: string;
      kinds: Set<string>;
      acceptedKinds: Set<string>;
      relation?: ResourceRelation;
      contextId?: string;
      severity: Severity;
      accounts: Set<string>;
      resources: Set<string>;
      violations: number;
    }
  >();

  for (const diff of diffs) {
    const key = keyOf(diff);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        key: citableDefectKey(diff),
        endpointId: diff.endpointId,
        kinds: new Set([diff.kind]),
        acceptedKinds: new Set(diff.accepted === true ? [diff.kind] : []),
        ...(diff.relation === undefined ? {} : { relation: diff.relation }),
        ...(diff.contextId === undefined ? {} : { contextId: diff.contextId }),
        severity: diff.severity,
        accounts: new Set(
          diff.counterpartAccountId === undefined
            ? [diff.accountId]
            : [diff.accountId, diff.counterpartAccountId],
        ),
        resources: new Set(diff.resourceId === undefined ? [] : [diff.resourceId]),
        violations: 1,
      });
      continue;
    }
    existing.kinds.add(diff.kind);
    if (diff.accepted === true) {
      existing.acceptedKinds.add(diff.kind);
    }
    existing.accounts.add(diff.accountId);
    if (diff.counterpartAccountId !== undefined) {
      existing.accounts.add(diff.counterpartAccountId);
    }
    if (diff.resourceId !== undefined) {
      existing.resources.add(diff.resourceId);
    }
    existing.violations += 1;
    if (SEVERITY_ORDER[diff.severity] < SEVERITY_ORDER[existing.severity]) {
      existing.severity = diff.severity;
    }
  }

  return [...groups.values()]
    .map((group) => ({
      key: group.key,
      endpointId: group.endpointId,
      kinds: [...group.kinds].sort(byCodeUnits),
      ...(group.relation === undefined ? {} : { relation: group.relation }),
      ...(group.contextId === undefined ? {} : { contextId: group.contextId }),
      severity: group.severity,
      accountIds: [...group.accounts].sort(byCodeUnits),
      resourceIds: [...group.resources].sort(byCodeUnits),
      // Absent rather than empty when nothing here is accepted. An empty array
      // on every group of every run would be a field the reader has to learn to
      // ignore, and the whole value of the mark is that it is rare.
      ...(group.acceptedKinds.size === 0
        ? {}
        : { acceptedKinds: [...group.acceptedKinds].sort(byCodeUnits) }),
      violations: group.violations,
    }))
    .sort((left, right) => {
      const bySeverity = SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity];
      if (bySeverity !== 0) {
        return bySeverity;
      }
      // One comparison rule, and the same one the three `.sort()` calls above
      // already used. These four were `localeCompare()` with no locale, so the
      // group order — which the report prints and a reader diffs between runs —
      // came out of the machine's `LC_ALL`. See `./order.js`; found by the audit
      // of 21 August 2026 (L-2).
      return (
        byCodeUnits(left.endpointId, right.endpointId) ||
        byCodeUnits(left.kinds.join(","), right.kinds.join(",")) ||
        byCodeUnits(left.relation ?? "", right.relation ?? "") ||
        byCodeUnits(left.contextId ?? "", right.contextId ?? "")
      );
    });
}

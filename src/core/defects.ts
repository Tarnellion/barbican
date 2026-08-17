/**
 * Grouping discrepancies by defect signature.
 *
 * One defect in the platform gives as many rows as there are cells it touched. A
 * run against crAPI gave six rows for three BOLAs — the same three defects, seen
 * from a user's point of view and from an administrator's. On the reference
 * platform one missing filter gives ten rows. Such a report cannot be read: the
 * numbers speak of the size of the matrix, not of the number of problems.
 */

import type { ResourceRelation, Severity } from "./types.js";

/**
 * The minimum needed for grouping.
 *
 * A structural type rather than `AccessDiff`: findings from checks are grouped
 * on equal terms with matrix discrepancies. They have neither `expected` nor
 * `actual`, but they have everything the signature is made of — and six clones
 * of one finding must collapse the same way ten cells of one missing filter do.
 */
export interface GroupableFinding {
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
  readonly endpointId: string;
  readonly contextId?: string | undefined;
  readonly resourceId?: string | undefined;
  readonly relation?: ResourceRelation | undefined;
  readonly kind: string;
  readonly severity: Severity;
}

/**
 * The signature: endpoint, kind of discrepancy, relation to the resource and
 * request conditions.
 *
 * The role is deliberately not part of the signature. If an endpoint was opened
 * to a user and to an administrator alike, the defect is one — a missing check —
 * not two.
 *
 * Conditions are part of it for the same reason as the relation: the country
 * check and the permission check are different mechanisms of the platform, they
 * break independently and are fixed in different places, so here too there are
 * two defects, not one.
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
  /** The kind of discrepancy, or a check identifier. */
  readonly kind: string;
  /** Absent on discrepancies with no resource — access to a whole function. */
  readonly relation?: ResourceRelation;
  /** The highest severity among the group's observations. */
  readonly severity: Severity;
  /** The accounts the defect concerns — for paired findings, both sides. */
  readonly accountIds: readonly string[];
  /** The resources it was observed on. Empty on discrepancies with no resource. */
  readonly resourceIds: readonly string[];
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
 * The key separator: a character that never occurs in identifiers.
 *
 * Written as an escape sequence rather than a raw byte. The byte in the source
 * made the file binary to `grep`: a search across the repository silently
 * skipped it entirely, and "no matches" here would read as "this code does not
 * exist".
 */
const SEPARATOR = "\u0000";

/**
 * The citable form of the same signature `keyOf` builds.
 *
 * The separator is a space rather than the NUL `keyOf` uses: this one is read by
 * people and pasted into tickets, that one is a map key and must not admit a
 * collision between two different signatures glued together.
 */
function citableKey(diff: GroupableFinding): string {
  return [
    diff.endpointId,
    diff.kind,
    diff.relation ?? "any-resource",
    diff.contextId ?? "baseline",
  ].join(" ");
}

function keyOf(diff: GroupableFinding): string {
  // A separator that never occurs in identifiers: gluing with a hyphen would
  // admit a collision of two different signatures into one string.
  return [diff.endpointId, diff.kind, diff.relation ?? "", diff.contextId ?? ""].join(SEPARATOR);
}

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
      kind: string;
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
        key: citableKey(diff),
        endpointId: diff.endpointId,
        kind: diff.kind,
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
      kind: group.kind,
      ...(group.relation === undefined ? {} : { relation: group.relation }),
      ...(group.contextId === undefined ? {} : { contextId: group.contextId }),
      severity: group.severity,
      accountIds: [...group.accounts].sort(),
      resourceIds: [...group.resources].sort(),
      violations: group.violations,
    }))
    .sort((left, right) => {
      const bySeverity = SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity];
      if (bySeverity !== 0) {
        return bySeverity;
      }
      return (
        left.endpointId.localeCompare(right.endpointId) ||
        left.kind.localeCompare(right.kind) ||
        (left.relation ?? "").localeCompare(right.relation ?? "") ||
        (left.contextId ?? "").localeCompare(right.contextId ?? "")
      );
    });
}

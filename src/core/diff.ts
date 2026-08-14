/**
 * Comparison of the declared intent against observed access.
 *
 * A pure function: the same input always gives the same output, order included.
 */

import type { ResolvedAccessPolicy } from "./expected.js";
import { resolveExpectedVerdict } from "./expected.js";
import { indexObservations, resourceApplies } from "./matrix.js";
import { createTenantHierarchy, FLAT_HIERARCHY } from "./tenancy.js";
import type {
  AccessDiff,
  AccessMatrix,
  AccessOutcome,
  DiffKind,
  ExpectedOutcome,
  ResourceRelation,
} from "./types.js";
import { relationOf, severityOf } from "./types.js";

/**
 * Reduces the observed outcome to a binary "there is access / there is none".
 *
 * `not-found` counts as a denial: access to the resource was not granted.
 * Telling "404 instead of 403, to hide existence" from "the resource really is
 * absent" requires knowing that the resource exists and belongs to separate
 * checks, not to the base diff.
 */
function toBinary(actual: Exclude<AccessOutcome, "error">): ExpectedOutcome {
  return actual === "allowed" ? "allowed" : "denied";
}

function classify(expected: ExpectedOutcome, actual: AccessOutcome | undefined): DiffKind | null {
  if (actual === undefined) {
    return "not-observed";
  }
  if (actual === "error") {
    return "probe-error";
  }
  if (toBinary(actual) === expected) {
    return null;
  }
  return expected === "denied" ? "privilege-escalation" : "unexpected-denial";
}

/**
 * The verdict on a single cell — the matching ones included.
 *
 * Introduced because "it is clean here" cannot otherwise be shown or quoted:
 * the report held only the total, and a reader checking a single cell was
 * rewriting this file in their own language. See ADR-0020.
 */
export interface CellVerdict {
  readonly accountId: string;
  readonly endpointId: string;
  readonly resourceId?: string;
  readonly contextId?: string;
  readonly relation?: ResourceRelation;
  readonly expected: ExpectedOutcome;
  readonly actual?: AccessOutcome;
  /** The rule that declared the expectation. Absence means `fallback`. */
  readonly ruleIndex?: number;
  /** Whether the observed matched the declared. */
  readonly match: boolean;
}

/**
 * Verdicts on every cell of the matrix, the matching ones and the rest.
 *
 * One walk for both answers: discrepancies are the same cells, the ones with
 * `match: false`. Two independent passes would drift, and the report would claim
 * "tested and agreed" about a cell that landed in the findings.
 */
export function describeCells(
  matrix: AccessMatrix,
  policy: ResolvedAccessPolicy,
): readonly CellVerdict[] {
  return walk(matrix, policy).cells;
}

/**
 * Returns the discrepancies between the policy and the observations.
 *
 * Matches are not returned: the result is a list of what needs attention. The
 * order is deterministic — by accounts, then by endpoints, in the order they are
 * declared in the matrix.
 */
export function diffAccess(
  matrix: AccessMatrix,
  policy: ResolvedAccessPolicy,
): readonly AccessDiff[] {
  return walk(matrix, policy).diffs;
}

function walk(
  matrix: AccessMatrix,
  policy: ResolvedAccessPolicy,
): { readonly diffs: readonly AccessDiff[]; readonly cells: readonly CellVerdict[] } {
  const index = indexObservations(matrix);
  // The tree is built once per diff: the integrity checks (unknown parent,
  // cycle) must fire before the walk, not in the middle of it.
  const hierarchy =
    matrix.tenants === undefined ? FLAT_HIERARCHY : createTenantHierarchy(matrix.tenants);
  const diffs: AccessDiff[] = [];
  const cells: CellVerdict[] = [];

  /** A verdict on a cell is always written, a discrepancy only when there is one. */
  function verdictOf(
    accountId: string,
    endpointId: string,
    expected: ExpectedOutcome,
    actual: AccessOutcome | undefined,
    match: boolean,
    ruleIndex?: number,
    resourceId?: string,
    relation?: ResourceRelation,
    contextId?: string,
  ): void {
    cells.push({
      accountId,
      endpointId,
      expected,
      match,
      ...(actual === undefined ? {} : { actual }),
      ...(ruleIndex === undefined ? {} : { ruleIndex }),
      ...(resourceId === undefined ? {} : { resourceId }),
      ...(relation === undefined ? {} : { relation }),
      ...(contextId === undefined ? {} : { contextId }),
    });
  }

  function record(
    accountId: string,
    endpointId: string,
    expected: ExpectedOutcome,
    actual: AccessOutcome | undefined,
    kind: DiffKind,
    ruleIndex?: number,
    resourceId?: string,
    relation?: ResourceRelation,
    contextId?: string,
  ): void {
    const base = {
      accountId,
      endpointId,
      expected,
      kind,
      severity: severityOf(kind, relation),
      // Absence means `fallback`: no rule matched.
      ...(ruleIndex === undefined ? {} : { ruleIndex }),
      // Absence means baseline request conditions.
      ...(contextId === undefined ? {} : { contextId }),
    };
    const withResource =
      resourceId === undefined ? base : { ...base, resourceId, ...(relation && { relation }) };
    diffs.push(actual === undefined ? withResource : { ...withResource, actual });
  }

  for (const account of matrix.accounts) {
    const byEndpoint = index.get(account.id);
    for (const endpoint of matrix.endpoints) {
      // An account under conditions does not exist across the whole surface:
      // where the conditions are not declared there is no cell at all — and
      // "not observed" cannot be said about it, that would be an invented hole
      // in coverage.
      if (account.endpointIds !== undefined && !account.endpointIds.includes(endpoint.id)) {
        continue;
      }
      // An endpoint with parameters exists only together with a resource:
      // without one there is nothing to substitute, and such a cell is not a
      // coordinate but an empty spot.
      const applicable = matrix.resources.filter((resource) => resourceApplies(endpoint, resource));
      if (applicable.length > 0) {
        for (const resource of applicable) {
          const relation = relationOf(account, resource, hierarchy);
          const verdict = resolveExpectedVerdict(
            policy,
            account.roleId,
            endpoint.id,
            relation,
            account.contextId,
          );
          const expected = verdict.outcome;
          const actual = byEndpoint?.get(endpoint.id)?.get(resource.id)?.outcome;
          const kind = classify(expected, actual);
          verdictOf(
            account.id,
            endpoint.id,
            expected,
            actual,
            kind === null,
            verdict.ruleIndex,
            resource.id,
            relation,
            account.contextId,
          );
          if (kind !== null) {
            record(
              account.id,
              endpoint.id,
              expected,
              actual,
              kind,
              verdict.ruleIndex,
              resource.id,
              relation,
              account.contextId,
            );
          }
        }
        continue;
      }

      const verdict = resolveExpectedVerdict(
        policy,
        account.roleId,
        endpoint.id,
        undefined,
        account.contextId,
      );
      const expected = verdict.outcome;
      const actual = byEndpoint?.get(endpoint.id)?.get(undefined)?.outcome;
      const kind = classify(expected, actual);
      verdictOf(
        account.id,
        endpoint.id,
        expected,
        actual,
        kind === null,
        verdict.ruleIndex,
        undefined,
        undefined,
        account.contextId,
      );
      if (kind !== null) {
        record(
          account.id,
          endpoint.id,
          expected,
          actual,
          kind,
          verdict.ruleIndex,
          undefined,
          undefined,
          account.contextId,
        );
      }
    }
  }

  return { diffs, cells };
}

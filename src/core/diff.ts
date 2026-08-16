/**
 * Comparison of the declared intent against observed access.
 *
 * A pure function: the same input always gives the same output, order included.
 */

import type { ExpectedVerdict, ResolvedAccessPolicy } from "./expected.js";
import { indexPolicy, resolveIndexedVerdict } from "./expected.js";
import { indexObservations, resourceApplies } from "./matrix.js";
import { createTenantHierarchy, FLAT_HIERARCHY } from "./tenancy.js";
import type {
  AccessDiff,
  AccessMatrix,
  AccessOutcome,
  DiffKind,
  ExpectedOutcome,
  Resource,
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
  /** Which declared the expectation: a rule of the policy, or `fallback`. */
  readonly basis: "rule" | "fallback";
  /** The rule that declared the expectation. Present only when `basis` is `rule`. */
  readonly ruleIndex?: number;
  /** Whether the observed matched the declared. */
  readonly match: boolean;
}

/**
 * Both answers about the matrix, from one walk over it.
 *
 * `diffs` are the same cells as the ones in `cells` with `match: false`, and
 * they are that by construction rather than by agreement between two passes.
 * See ADR-0020.
 */
export interface MatrixVerdicts {
  readonly cells: readonly CellVerdict[];
  readonly diffs: readonly AccessDiff[];
}

/**
 * Verdicts on every cell of the matrix and the discrepancies among them.
 *
 * The function to call when both answers are wanted — which is what a run wants.
 * `describeCells` and `diffAccess` each walk the matrix on their own, so asking
 * them one after the other walks it twice: the same work, and, worse, the same
 * work done twice over inputs that are only *expected* to be identical. The
 * audit of 14 August found exactly that on two consecutive lines of `src/cli.ts`
 * — the comment there promising one walk while the call site took two.
 */
export function describeMatrix(matrix: AccessMatrix, policy: ResolvedAccessPolicy): MatrixVerdicts {
  return walk(matrix, policy);
}

/**
 * Verdicts on every cell of the matrix, the matching ones and the rest.
 *
 * One walk for both answers: discrepancies are the same cells, the ones with
 * `match: false`. Two independent passes would drift, and the report would claim
 * "tested and agreed" about a cell that landed in the findings.
 *
 * Wanting the discrepancies as well means {@link describeMatrix}, not this
 * function and `diffAccess` next to each other.
 */
export function describeCells(
  matrix: AccessMatrix,
  policy: ResolvedAccessPolicy,
): readonly CellVerdict[] {
  return describeMatrix(matrix, policy).cells;
}

/**
 * Returns the discrepancies between the policy and the observations.
 *
 * Matches are not returned: the result is a list of what needs attention. The
 * order is deterministic — by accounts, then by endpoints, in the order they are
 * declared in the matrix.
 *
 * Wanting the verdicts on the matching cells as well means
 * {@link describeMatrix}, not this function and `describeCells` next to each
 * other.
 */
export function diffAccess(
  matrix: AccessMatrix,
  policy: ResolvedAccessPolicy,
): readonly AccessDiff[] {
  return describeMatrix(matrix, policy).diffs;
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
  // The policy, arranged for lookup, built once for the whole walk. Resolving a
  // cell used to scan every rule of the policy — see `indexPolicy`.
  const rules = indexPolicy(policy);
  const diffs: AccessDiff[] = [];
  const cells: CellVerdict[] = [];

  /**
   * Where a cell sits in the matrix, and what the platform answered there.
   *
   * An object rather than a tail of optional positional arguments. There were
   * nine of them, four optional, and the call sites carried placeholders like
   * `undefined, undefined, account.contextId` — a shape where adding a
   * coordinate means editing every caller and getting the order right by eye.
   */
  interface Cell {
    readonly accountId: string;
    readonly endpointId: string;
    readonly resourceId?: string;
    readonly relation?: ResourceRelation;
    readonly contextId?: string;
  }

  /** A verdict on a cell is always written, a discrepancy only when there is one. */
  function verdictOf(
    cell: Cell,
    verdict: ExpectedVerdict,
    actual: AccessOutcome | undefined,
    match: boolean,
  ): void {
    cells.push({
      accountId: cell.accountId,
      endpointId: cell.endpointId,
      expected: verdict.outcome,
      // Which of the two declared it. Said in a field rather than by the absence
      // of `ruleIndex`: on the reference run 37 of 80 findings carried no index,
      // and "the fallback fired" was indistinguishable from "the tool did not
      // fill this in".
      basis: verdict.basis,
      match,
      ...(actual === undefined ? {} : { actual }),
      ...(verdict.ruleIndex === undefined ? {} : { ruleIndex: verdict.ruleIndex }),
      ...(cell.resourceId === undefined ? {} : { resourceId: cell.resourceId }),
      ...(cell.relation === undefined ? {} : { relation: cell.relation }),
      ...(cell.contextId === undefined ? {} : { contextId: cell.contextId }),
    });
  }

  function record(
    cell: Cell,
    verdict: ExpectedVerdict,
    actual: AccessOutcome | undefined,
    kind: DiffKind,
  ): void {
    const base = {
      accountId: cell.accountId,
      endpointId: cell.endpointId,
      expected: verdict.outcome,
      basis: verdict.basis,
      kind,
      severity: severityOf(kind, cell.relation),
      ...(verdict.ruleIndex === undefined ? {} : { ruleIndex: verdict.ruleIndex }),
      // Absence means baseline request conditions.
      ...(cell.contextId === undefined ? {} : { contextId: cell.contextId }),
    };
    const withResource =
      cell.resourceId === undefined
        ? base
        : {
            ...base,
            resourceId: cell.resourceId,
            ...(cell.relation && { relation: cell.relation }),
          };
    diffs.push(actual === undefined ? withResource : { ...withResource, actual });
  }

  /**
   * Which resources apply to which endpoint — computed once, not per account.
   *
   * The answer does not depend on the account: it is a property of the path
   * template and the resource's parameters. Recomputing it inside the account
   * loop made the walk cost accounts × endpoints × resources, and
   * `resourceApplies` re-parses the path with a regular expression on every
   * call: 1 312 000 calls and 425 ms on a matrix of 400 endpoints, 41 accounts
   * and 80 resources, which the audit of 14 August measured as the largest
   * single quadratic term in the run.
   *
   * A memo inside `resourceApplies` would have fixed the same number, and would
   * have put mutable state into the core, which has none by design. Hoisting the
   * loop removes the term instead of caching it.
   */
  const applicableTo = new Map<string, readonly Resource[]>(
    matrix.endpoints.map((endpoint) => [
      endpoint.id,
      matrix.resources.filter((resource) => resourceApplies(endpoint, resource)),
    ]),
  );

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
      const applicable = applicableTo.get(endpoint.id) ?? [];
      if (applicable.length > 0) {
        for (const resource of applicable) {
          const relation = relationOf(account, resource, hierarchy);
          const verdict = resolveIndexedVerdict(
            rules,
            account.roleId,
            endpoint.id,
            relation,
            account.contextId,
          );
          const actual = byEndpoint?.get(endpoint.id)?.get(resource.id)?.outcome;
          const kind = classify(verdict.outcome, actual);
          const cell: Cell = {
            accountId: account.id,
            endpointId: endpoint.id,
            resourceId: resource.id,
            relation,
            ...(account.contextId === undefined ? {} : { contextId: account.contextId }),
          };
          verdictOf(cell, verdict, actual, kind === null);
          if (kind !== null) {
            record(cell, verdict, actual, kind);
          }
        }
        continue;
      }

      const verdict = resolveIndexedVerdict(
        rules,
        account.roleId,
        endpoint.id,
        undefined,
        account.contextId,
      );
      const actual = byEndpoint?.get(endpoint.id)?.get(undefined)?.outcome;
      const kind = classify(verdict.outcome, actual);
      const cell: Cell = {
        accountId: account.id,
        endpointId: endpoint.id,
        ...(account.contextId === undefined ? {} : { contextId: account.contextId }),
      };
      verdictOf(cell, verdict, actual, kind === null);
      if (kind !== null) {
        record(cell, verdict, actual, kind);
      }
    }
  }

  return { diffs, cells };
}

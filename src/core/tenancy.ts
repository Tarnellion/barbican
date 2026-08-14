/**
 * The tenant tree.
 *
 * The "parent — child" link is declared by an explicit field and never derived
 * from the shape of an identifier: identifiers come from a configuration written
 * by a human, and a typo in a parsed path would silently make one tenant kin to
 * another. The reasoning — ADR-0013.
 */

import type { TenantId } from "./types.js";

export interface TenantNode {
  readonly id: TenantId;
  /** The parent. Absence means a root. */
  readonly parentId?: TenantId;
}

export class UnknownParentTenantError extends Error {
  constructor(id: TenantId, parentId: TenantId) {
    super(
      `Tenant "${id}" is declared a child of "${parentId}", which is not in the list. ` +
        `A typo in the parent makes the tenant a separate root and turns 'our own brand' ` +
        `into 'someone else's' — that is, it hides a finding.`,
    );
    this.name = "UnknownParentTenantError";
  }
}

export class TenantCycleError extends Error {
  constructor(id: TenantId) {
    super(`Tenant "${id}" ends up being its own ancestor: the tenant list has a cycle`);
    this.name = "TenantCycleError";
  }
}

export class DuplicateTenantIdError extends Error {
  constructor(id: TenantId) {
    super(`A tenant with id "${id}" is declared more than once`);
    this.name = "DuplicateTenantIdError";
  }
}

export class DuplicateMembershipError extends Error {
  constructor(where: string, id: TenantId) {
    super(
      `${where} is declared in tenant "${id}" twice. A repeat is always a typo: ` +
        `it does not affect the relation, but it hides the second, real tenant ` +
        `that was meant to be written.`,
    );
    this.name = "DuplicateMembershipError";
  }
}

export class SubsumedMembershipError extends Error {
  constructor(where: string, ancestor: TenantId, descendant: TenantId) {
    super(
      `${where} is declared in both "${ancestor}" and "${descendant}", and the second ` +
        `lies in the subtree of the first. Such a set changes the meaning silently: ` +
        `resources of "${descendant}" stop being descendant-tenant and become ` +
        `same-tenant, a rule with scope: descendant-tenant no longer applies to them, ` +
        `and the cell falls through to the fallback. Keep "${ancestor}": membership ` +
        `in an ancestor already covers the whole subtree.`,
    );
    this.name = "SubsumedMembershipError";
  }
}

export interface TenantHierarchy {
  /** Strictly higher in the tree: a tenant is not considered its own ancestor. */
  isAncestor(ancestor: TenantId, descendant: TenantId): boolean;
}

/**
 * Checks an account's set of memberships for repeats and for nesting.
 *
 * Nesting is rejected for a reason, not out of fastidiousness. The relation is
 * computed by the nearest membership, so adding a brand to an already declared
 * holding moves the brand's resources from `descendant-tenant` into
 * `same-tenant` — and a rule written for the top-down view stops applying,
 * marking that in no way at all. This is the same class as a typo in a tenant
 * name: the meaning changed, the report looks the same.
 *
 * @throws {DuplicateMembershipError}
 * @throws {SubsumedMembershipError}
 */
export function assertIndependentMemberships(
  where: string,
  tenantIds: readonly TenantId[],
  hierarchy: TenantHierarchy,
): void {
  const seen = new Set<TenantId>();
  for (const id of tenantIds) {
    if (seen.has(id)) {
      throw new DuplicateMembershipError(where, id);
    }
    seen.add(id);
  }
  for (const outer of tenantIds) {
    for (const inner of tenantIds) {
      if (hierarchy.isAncestor(outer, inner)) {
        throw new SubsumedMembershipError(where, outer, inner);
      }
    }
  }
}

/**
 * A forest with no links: any two different tenants are foreign to each other.
 *
 * The behaviour from before ADR-0013. Used when no links are declared — which is
 * why existing configurations work exactly as they did.
 */
export const FLAT_HIERARCHY: TenantHierarchy = {
  isAncestor: () => false,
};

export function createTenantHierarchy(nodes: readonly TenantNode[]): TenantHierarchy {
  const parents = new Map<TenantId, TenantId | undefined>();
  for (const node of nodes) {
    if (parents.has(node.id)) {
      throw new DuplicateTenantIdError(node.id);
    }
    parents.set(node.id, node.parentId);
  }

  for (const node of nodes) {
    if (node.parentId !== undefined && !parents.has(node.parentId)) {
      throw new UnknownParentTenantError(node.id, node.parentId);
    }
  }

  // The cycle is looked for at startup: otherwise the walk up the tree during
  // the diff would loop forever, and a run against someone else's deployment is
  // no place for an infinite loop.
  for (const node of nodes) {
    const seen = new Set<TenantId>([node.id]);
    let current = node.parentId;
    while (current !== undefined) {
      if (seen.has(current)) {
        throw new TenantCycleError(node.id);
      }
      seen.add(current);
      current = parents.get(current);
    }
  }

  return {
    isAncestor(ancestor, descendant) {
      // A fast path, not a guard: a cycle is rejected at construction time, so a
      // tenant does not end up in its own ancestor chain even without this line.
      // Verified by mutation — removing it does not break the tests.
      if (ancestor === descendant) {
        return false;
      }
      let current = parents.get(descendant);
      while (current !== undefined) {
        if (current === ancestor) {
          return true;
        }
        current = parents.get(current);
      }
      return false;
    },
  };
}

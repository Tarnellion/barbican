/**
 * Дерево тенантов.
 *
 * Связь «родитель — потомок» объявляется явным полем и никогда не выводится
 * из вида идентификатора: идентификаторы приходят из конфигурации, написанной
 * человеком, и опечатка в разбираемом пути молча переродняла бы тенанта.
 * Обоснование — ADR-0013.
 */

import type { TenantId } from "./types.js";

export interface TenantNode {
  readonly id: TenantId;
  /** Родитель. Отсутствие означает корень. */
  readonly parentId?: TenantId;
}

export class UnknownParentTenantError extends Error {
  constructor(id: TenantId, parentId: TenantId) {
    super(
      `Tenant "${id}" is declared a child of "${parentId}", which is not in the list. ` +
        `A typo in the parent makes the tenant a separate root and turns «our own brand» ` +
        `into «someone else's» — that is, it hides a finding.`,
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
  /** Строго выше по дереву: тенант сам себе предком не считается. */
  isAncestor(ancestor: TenantId, descendant: TenantId): boolean;
}

/**
 * Проверяет набор членств аккаунта на повторы и на вложенность.
 *
 * Вложенность отвергается не из чистоплюйства. Отношение считается по самому
 * близкому членству, поэтому добавление бренда к уже объявленному холдингу
 * переводит объекты бренда из `descendant-tenant` в `same-tenant` — и правило,
 * написанное для взгляда сверху вниз, перестаёт применяться, ничем этого
 * не обозначив. Это тот же класс, что опечатка в имени тенанта: смысл поменялся,
 * отчёт остался прежним на вид.
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
 * Лес без связей: любые два разных тенанта чужие друг другу.
 *
 * Поведение до ADR-0013. Используется, когда связи не объявлены, — поэтому
 * существующие конфигурации работают в точности как раньше.
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

  // Цикл ищется на старте: иначе подъём по дереву во время диффа зациклился бы,
  // а прогон против чужого стенда — не место для бесконечного цикла.
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
      // Быстрый путь, а не защита: цикл отвергнут при построении, поэтому
      // тенант не попадает в собственную цепочку предков и без этой строки.
      // Проверено мутацией — её снятие тесты не роняет.
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

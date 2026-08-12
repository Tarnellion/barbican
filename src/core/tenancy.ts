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
      `Тенант "${id}" объявлен потомком "${parentId}", которого нет в перечне. ` +
        `Опечатка в родителе делает тенанта отдельным корнем и превращает ` +
        `«свой бренд» в «чужой», то есть прячет находку.`,
    );
    this.name = "UnknownParentTenantError";
  }
}

export class TenantCycleError extends Error {
  constructor(id: TenantId) {
    super(`Тенант "${id}" оказывается собственным предком: в перечне тенантов цикл`);
    this.name = "TenantCycleError";
  }
}

export class DuplicateTenantIdError extends Error {
  constructor(id: TenantId) {
    super(`Тенант с id "${id}" объявлен больше одного раза`);
    this.name = "DuplicateTenantIdError";
  }
}

export interface TenantHierarchy {
  /** Строго выше по дереву: тенант сам себе предком не считается. */
  isAncestor(ancestor: TenantId, descendant: TenantId): boolean;
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

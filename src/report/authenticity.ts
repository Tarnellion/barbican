/**
 * Признак недостоверного прогона.
 *
 * Отдельный слой, потому что вывод требует знания политики: сам по себе 401
 * неотличим от законного отказа. Опасен он только там, где доступ **объявлен**:
 * если каждый эндпоинт, положенный аккаунту, ответил 401, значит мы не вошли,
 * а не что доступ отобрали.
 *
 * Первая версия проверки жила в прогоне и требовала 401 на всех обращениях
 * подряд. Проверка на живом стенде показала, что этого мало: одного публичного
 * эндпоинта хватало, чтобы условие не выполнилось и сломанная аутентификация
 * прошла незамеченной.
 */

import type {
  AccessObservation,
  Account,
  ExpectedAccessPolicy,
  Resource,
  TenantNode,
} from "../core/index.js";
import {
  createTenantHierarchy,
  FLAT_HIERARCHY,
  relationOf,
  resolveExpected,
} from "../core/index.js";

export interface AuthenticitySuspicion {
  readonly accountId: string;
  /** Сколько эндпоинтов политика считает доступными этому аккаунту. */
  readonly expectedAllowed: number;
  /** Из них не дали доступа. */
  readonly refused: number;
  /** Самый частый статус среди отказов — подсказка, куда смотреть. */
  readonly dominantStatus: number;
}

/**
 * Находит аккаунты, у которых **ни один** объявленный доступным эндпоинт
 * не дал доступа.
 *
 * Проверка не привязана к 401 намеренно. Разведка crAPI показала, что отказы
 * бывают неоднородны даже внутри одного продукта: сервис на Java отвечает 404
 * там, где сервис на Django отвечает 401. А сплошные 404 — ещё и типичный
 * признак неверного `baseUrl` или префикса пути. Во всех этих случаях
 * результату верить нельзя одинаково, поэтому смотрим на сам факт: человек
 * объявил доступ, доступа нет нигде.
 *
 * Порог намеренно строгий: частичные отказы — обычная находка «неожиданный
 * отказ», и тревога по ним приучила бы к ложным срабатываниям.
 */
export function findUnauthenticated(
  accounts: readonly Account[],
  observations: readonly AccessObservation[],
  policy: ExpectedAccessPolicy,
  resources: readonly Resource[] = [],
  /**
   * Дерево тенантов. Пропустить его — значит повторить регрессию, случившуюся
   * при вводе `scope`: отношение считалось неверно, `expectedAllowed` всегда
   * выходил нулём, и предохранитель не срабатывал ни разу.
   */
  tenants?: readonly TenantNode[],
): readonly AuthenticitySuspicion[] {
  const hierarchy = tenants === undefined ? FLAT_HIERARCHY : createTenantHierarchy(tenants);
  const suspicions: AuthenticitySuspicion[] = [];
  const byId = new Map(resources.map((resource) => [resource.id, resource]));

  for (const account of accounts) {
    let expectedAllowed = 0;
    let refused = 0;
    const statusCounts = new Map<number, number>();

    for (const observation of observations) {
      if (observation.accountId !== account.id) {
        continue;
      }
      // Отношение обязательно: правила со `scope` без него не применяются вовсе,
      // и для политики в стиле ADR-0010 счётчик оставался бы нулевым — то есть
      // предохранитель молчал бы именно на том стиле, который рекомендован.
      const resource =
        observation.resourceId === undefined ? undefined : byId.get(observation.resourceId);
      const relation =
        resource === undefined ? undefined : relationOf(account, resource, hierarchy);
      if (resolveExpected(policy, account.roleId, observation.endpointId, relation) !== "allowed") {
        continue;
      }
      expectedAllowed += 1;
      if (observation.outcome !== "allowed") {
        refused += 1;
        statusCounts.set(observation.status, (statusCounts.get(observation.status) ?? 0) + 1);
      }
    }

    if (expectedAllowed > 0 && refused === expectedAllowed) {
      let dominantStatus = 0;
      let best = 0;
      for (const [status, count] of statusCounts) {
        if (count > best) {
          best = count;
          dominantStatus = status;
        }
      }
      suspicions.push({ accountId: account.id, expectedAllowed, refused, dominantStatus });
    }
  }

  return suspicions;
}

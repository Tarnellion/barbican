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

import type { AccessObservation, Account, ExpectedAccessPolicy } from "../core/index.js";
import { resolveExpected } from "../core/index.js";

export interface AuthenticitySuspicion {
  readonly accountId: string;
  /** Сколько эндпоинтов политика считает доступными этому аккаунту. */
  readonly expectedAllowed: number;
  /** Из них ответили 401. */
  readonly unauthorized: number;
}

/**
 * Находит аккаунты, у которых **все** объявленные доступными эндпоинты
 * ответили 401.
 *
 * Порог намеренно строгий: частичные отказы — это обычная находка
 * «неожиданный отказ», и поднимать по ним тревогу значило бы приучить
 * к ложным срабатываниям.
 */
export function findUnauthenticated(
  accounts: readonly Account[],
  observations: readonly AccessObservation[],
  policy: ExpectedAccessPolicy,
): readonly AuthenticitySuspicion[] {
  const suspicions: AuthenticitySuspicion[] = [];

  for (const account of accounts) {
    let expectedAllowed = 0;
    let unauthorized = 0;

    for (const observation of observations) {
      if (observation.accountId !== account.id) {
        continue;
      }
      if (resolveExpected(policy, account.roleId, observation.endpointId) !== "allowed") {
        continue;
      }
      expectedAllowed += 1;
      if (observation.status === 401) {
        unauthorized += 1;
      }
    }

    if (expectedAllowed > 0 && unauthorized === expectedAllowed) {
      suspicions.push({ accountId: account.id, expectedAllowed, unauthorized });
    }
  }

  return suspicions;
}

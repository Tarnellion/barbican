/**
 * Построение фактической матрицы доступа из наблюдений.
 *
 * Чистые функции: ни сети, ни файловой системы. Вход — уже собранные наблюдения.
 */

import type { AccessMatrix, AccessObservation, Account, Endpoint } from "./types.js";

export class DuplicateIdError extends Error {
  constructor(kind: "эндпоинт" | "аккаунт", id: string) {
    super(`Дублирующийся ${kind} с id "${id}"`);
    this.name = "DuplicateIdError";
  }
}

export class UnknownReferenceError extends Error {
  constructor(kind: "эндпоинт" | "аккаунт", id: string) {
    super(`Наблюдение ссылается на неизвестный ${kind} "${id}"`);
    this.name = "UnknownReferenceError";
  }
}

export class ConflictingObservationError extends Error {
  constructor(accountId: string, endpointId: string) {
    super(
      `Больше одного наблюдения для пары "${accountId}" × "${endpointId}". ` +
        `Какое из них отражает доступ — определить нельзя.`,
    );
    this.name = "ConflictingObservationError";
  }
}

export interface AccessMatrixInput {
  readonly endpoints: readonly Endpoint[];
  readonly accounts: readonly Account[];
  readonly observations: readonly AccessObservation[];
}

/**
 * Индекс наблюдений: аккаунт → эндпоинт → наблюдение.
 *
 * Вложенные карты, а не составной строковый ключ: склейка идентификаторов
 * в одну строку допускает коллизию, а тихо смешать результаты двух аккаунтов
 * в инструменте, который судит о правах доступа, недопустимо.
 */
export type ObservationIndex = ReadonlyMap<string, ReadonlyMap<string, AccessObservation>>;

/**
 * Собирает матрицу, проверяя целостность входа.
 *
 * Проверки не формальность: непокрытая пара, принятая за отказ, порождает
 * ложное срабатывание, а лишнее наблюдение — неопределённый вердикт.
 *
 * @throws {DuplicateIdError} повторяющийся id эндпоинта или аккаунта
 * @throws {UnknownReferenceError} наблюдение ссылается на неизвестный объект
 * @throws {ConflictingObservationError} для одной пары больше одного наблюдения
 */
export function buildAccessMatrix(input: AccessMatrixInput): AccessMatrix {
  const endpointIds = new Set<string>();
  for (const endpoint of input.endpoints) {
    if (endpointIds.has(endpoint.id)) {
      throw new DuplicateIdError("эндпоинт", endpoint.id);
    }
    endpointIds.add(endpoint.id);
  }

  const accountIds = new Set<string>();
  for (const account of input.accounts) {
    if (accountIds.has(account.id)) {
      throw new DuplicateIdError("аккаунт", account.id);
    }
    accountIds.add(account.id);
  }

  const seen = new Map<string, Set<string>>();
  for (const observation of input.observations) {
    if (!accountIds.has(observation.accountId)) {
      throw new UnknownReferenceError("аккаунт", observation.accountId);
    }
    if (!endpointIds.has(observation.endpointId)) {
      throw new UnknownReferenceError("эндпоинт", observation.endpointId);
    }

    let endpointsForAccount = seen.get(observation.accountId);
    if (endpointsForAccount === undefined) {
      endpointsForAccount = new Set();
      seen.set(observation.accountId, endpointsForAccount);
    }
    if (endpointsForAccount.has(observation.endpointId)) {
      throw new ConflictingObservationError(observation.accountId, observation.endpointId);
    }
    endpointsForAccount.add(observation.endpointId);
  }

  return {
    endpoints: input.endpoints,
    accounts: input.accounts,
    observations: input.observations,
  };
}

export function indexObservations(matrix: AccessMatrix): ObservationIndex {
  const index = new Map<string, Map<string, AccessObservation>>();
  for (const observation of matrix.observations) {
    let byEndpoint = index.get(observation.accountId);
    if (byEndpoint === undefined) {
      byEndpoint = new Map();
      index.set(observation.accountId, byEndpoint);
    }
    byEndpoint.set(observation.endpointId, observation);
  }
  return index;
}

export function findObservation(
  index: ObservationIndex,
  accountId: string,
  endpointId: string,
): AccessObservation | undefined {
  return index.get(accountId)?.get(endpointId);
}

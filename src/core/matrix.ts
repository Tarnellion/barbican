/**
 * Построение фактической матрицы доступа из наблюдений.
 *
 * Чистые функции: ни сети, ни файловой системы. Вход — уже собранные наблюдения.
 */

import type { TenantNode } from "./tenancy.js";
import type { AccessMatrix, AccessObservation, Account, Endpoint, Resource } from "./types.js";

export class DuplicateIdError extends Error {
  constructor(kind: "эндпоинт" | "аккаунт" | "ресурс", id: string) {
    super(`Дублирующийся ${kind} с id "${id}"`);
    this.name = "DuplicateIdError";
  }
}

export class UnknownReferenceError extends Error {
  constructor(kind: "эндпоинт" | "аккаунт" | "ресурс", id: string) {
    super(`Наблюдение ссылается на неизвестный ${kind} "${id}"`);
    this.name = "UnknownReferenceError";
  }
}

export class ConflictingObservationError extends Error {
  constructor(accountId: string, endpointId: string, resourceId?: string) {
    const cell = resourceId === undefined ? "" : ` × "${resourceId}"`;
    super(
      `Больше одного наблюдения для "${accountId}" × "${endpointId}"${cell}. ` +
        `Какое из них отражает доступ — определить нельзя.`,
    );
    this.name = "ConflictingObservationError";
  }
}

export interface AccessMatrixInput {
  readonly endpoints: readonly Endpoint[];
  readonly accounts: readonly Account[];
  /** Объекты обращения. Пусто, если параметризованных эндпоинтов нет. */
  readonly resources?: readonly Resource[];
  readonly observations: readonly AccessObservation[];
  /** Дерево тенантов. Отсутствие означает лес из корней без связей. */
  readonly tenants?: readonly TenantNode[];
}

/**
 * Индекс наблюдений: аккаунт → эндпоинт → объект → наблюдение.
 *
 * Три уровня вложенных карт, а не составной строковый ключ: склейка
 * идентификаторов допускает коллизию, а тихо смешать результаты двух аккаунтов
 * или двух объектов в инструменте, который судит о правах доступа, недопустимо.
 * Отсутствие объекта — ключ `undefined`, который Map поддерживает наравне
 * со строками, поэтому выдумывать для него строковый маркер не нужно.
 *
 * Объект здесь координата, а не признак: одна и та же ручка со своим объектом
 * и с чужим — разные ячейки с разным ожидаемым исходом.
 */
export type ObservationIndex = ReadonlyMap<
  string,
  ReadonlyMap<string, ReadonlyMap<string | undefined, AccessObservation>>
>;

const PARAMETER_NAME = /\{([^}]+)\}/g;

/**
 * Относится ли объект к эндпоинту.
 *
 * Одно правило на прогон и на дифф: разойдясь, они дали бы наблюдения,
 * которым не с чем сравниваться, и находки без наблюдений.
 */
export function resourceApplies(endpoint: Endpoint, resource: Resource): boolean {
  const names = [...endpoint.path.matchAll(PARAMETER_NAME)].map((match) => match[1] ?? "");
  // `Object.hasOwn`, а не проверка на undefined: имена берутся из пути, то есть
  // из недоверенной спецификации, и `{constructor}` отвечал бы у любого объекта
  // через цепочку прототипов — враждебная спека получала бы обращения от каждого
  // аккаунта на каждый объявленный объект.
  const covered = names.every((name) => Object.hasOwn(resource.params, name));

  if (resource.endpointIds !== undefined) {
    return resource.endpointIds.includes(endpoint.id) && covered;
  }
  // Без явного списка объект относится только к эндпоинтам с параметрами:
  // иначе объект с одним лишь query прицепился бы к каждой ручке подряд.
  return names.length > 0 && covered;
}

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

  const resourceIds = new Set<string>();
  for (const resource of input.resources ?? []) {
    if (resourceIds.has(resource.id)) {
      throw new DuplicateIdError("ресурс", resource.id);
    }
    resourceIds.add(resource.id);
  }

  const accountIds = new Set<string>();
  for (const account of input.accounts) {
    if (accountIds.has(account.id)) {
      throw new DuplicateIdError("аккаунт", account.id);
    }
    accountIds.add(account.id);
  }

  const seen = new Map<string, Map<string, Set<string | undefined>>>();
  for (const observation of input.observations) {
    if (!accountIds.has(observation.accountId)) {
      throw new UnknownReferenceError("аккаунт", observation.accountId);
    }
    if (!endpointIds.has(observation.endpointId)) {
      throw new UnknownReferenceError("эндпоинт", observation.endpointId);
    }
    if (observation.resourceId !== undefined && !resourceIds.has(observation.resourceId)) {
      throw new UnknownReferenceError("ресурс", observation.resourceId);
    }

    let byEndpoint = seen.get(observation.accountId);
    if (byEndpoint === undefined) {
      byEndpoint = new Map();
      seen.set(observation.accountId, byEndpoint);
    }
    let resourcesSeen = byEndpoint.get(observation.endpointId);
    if (resourcesSeen === undefined) {
      resourcesSeen = new Set();
      byEndpoint.set(observation.endpointId, resourcesSeen);
    }
    if (resourcesSeen.has(observation.resourceId)) {
      throw new ConflictingObservationError(
        observation.accountId,
        observation.endpointId,
        observation.resourceId,
      );
    }
    resourcesSeen.add(observation.resourceId);
  }

  return {
    endpoints: input.endpoints,
    accounts: input.accounts,
    resources: input.resources ?? [],
    observations: input.observations,
    // Дерево обязано доехать до диффа: без него отношение считается по плоской
    // модели, и объявленное родство молча ни на что не влияет.
    ...(input.tenants === undefined ? {} : { tenants: input.tenants }),
  };
}

export function indexObservations(matrix: AccessMatrix): ObservationIndex {
  const index = new Map<string, Map<string, Map<string | undefined, AccessObservation>>>();
  for (const observation of matrix.observations) {
    let byEndpoint = index.get(observation.accountId);
    if (byEndpoint === undefined) {
      byEndpoint = new Map();
      index.set(observation.accountId, byEndpoint);
    }
    let byResource = byEndpoint.get(observation.endpointId);
    if (byResource === undefined) {
      byResource = new Map();
      byEndpoint.set(observation.endpointId, byResource);
    }
    byResource.set(observation.resourceId, observation);
  }
  return index;
}

export function findObservation(
  index: ObservationIndex,
  accountId: string,
  endpointId: string,
  resourceId?: string,
): AccessObservation | undefined {
  return index.get(accountId)?.get(endpointId)?.get(resourceId);
}

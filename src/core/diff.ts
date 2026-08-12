/**
 * Сравнение объявленного намерения с фактическим доступом.
 *
 * Чистая функция: одинаковый вход всегда даёт одинаковый выход, включая порядок.
 */

import type { ExpectedAccessPolicy } from "./expected.js";
import { resolveExpected } from "./expected.js";
import { indexObservations, resourceApplies } from "./matrix.js";
import type {
  AccessDiff,
  AccessMatrix,
  AccessOutcome,
  DiffKind,
  ExpectedOutcome,
  ResourceRelation,
} from "./types.js";
import { relationOf } from "./types.js";

/**
 * Сводит фактический исход к бинарному «доступ есть / доступа нет».
 *
 * `not-found` считается отказом: доступ к ресурсу не получен. Различение
 * «404 вместо 403, чтобы скрыть существование» от «ресурса действительно нет»
 * требует знания о существовании ресурса и относится к отдельным проверкам,
 * а не к базовому диффу.
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
 * Возвращает расхождения между политикой и наблюдениями.
 *
 * Совпадения не возвращаются: результат — список того, что требует внимания.
 * Порядок детерминирован — по аккаунтам, затем по эндпоинтам, в порядке их
 * объявления в матрице.
 */
export function diffAccess(
  matrix: AccessMatrix,
  policy: ExpectedAccessPolicy,
): readonly AccessDiff[] {
  const index = indexObservations(matrix);
  const diffs: AccessDiff[] = [];

  function record(
    accountId: string,
    endpointId: string,
    expected: ExpectedOutcome,
    actual: AccessOutcome | undefined,
    kind: DiffKind,
    resourceId?: string,
    relation?: ResourceRelation,
  ): void {
    const base = { accountId, endpointId, expected, kind };
    const withResource =
      resourceId === undefined ? base : { ...base, resourceId, ...(relation && { relation }) };
    diffs.push(actual === undefined ? withResource : { ...withResource, actual });
  }

  for (const account of matrix.accounts) {
    const byEndpoint = index.get(account.id);
    for (const endpoint of matrix.endpoints) {
      // Эндпоинт с параметрами существует только вместе с объектом: без него
      // подставлять нечего, и такая ячейка не координата, а пустое место.
      const applicable = matrix.resources.filter((resource) => resourceApplies(endpoint, resource));
      if (applicable.length > 0) {
        for (const resource of applicable) {
          const relation = relationOf(account, resource);
          const expected = resolveExpected(policy, account.roleId, endpoint.id, relation);
          const actual = byEndpoint?.get(endpoint.id)?.get(resource.id)?.outcome;
          const kind = classify(expected, actual);
          if (kind !== null) {
            record(account.id, endpoint.id, expected, actual, kind, resource.id, relation);
          }
        }
        continue;
      }

      const expected = resolveExpected(policy, account.roleId, endpoint.id);
      const actual = byEndpoint?.get(endpoint.id)?.get(undefined)?.outcome;
      const kind = classify(expected, actual);
      if (kind !== null) {
        record(account.id, endpoint.id, expected, actual, kind);
      }
    }
  }

  return diffs;
}

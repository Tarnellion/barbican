/**
 * Сравнение объявленного намерения с фактическим доступом.
 *
 * Чистая функция: одинаковый вход всегда даёт одинаковый выход, включая порядок.
 */

import type { ExpectedAccessPolicy } from "./expected.js";
import { resolveExpected } from "./expected.js";
import { indexObservations } from "./matrix.js";
import type {
  AccessDiff,
  AccessMatrix,
  AccessOutcome,
  DiffKind,
  ExpectedOutcome,
} from "./types.js";

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

  for (const account of matrix.accounts) {
    const byEndpoint = index.get(account.id);
    for (const endpoint of matrix.endpoints) {
      const expected = resolveExpected(policy, account.roleId, endpoint.id);
      const actual = byEndpoint?.get(endpoint.id)?.outcome;
      const kind = classify(expected, actual);
      if (kind === null) {
        continue;
      }
      diffs.push(
        actual === undefined
          ? { accountId: account.id, endpointId: endpoint.id, expected, kind }
          : { accountId: account.id, endpointId: endpoint.id, expected, actual, kind },
      );
    }
  }

  return diffs;
}

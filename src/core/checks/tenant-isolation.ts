/**
 * Проверка изоляции тенантов по сигналам над телом.
 *
 * Закрывает класс дефектов, невидимый по статусу: списочная ручка без фильтра
 * по тенанту отвечает 200 всем, и корректная реализация отвечает так же.
 * Разница целиком в теле — см. ADR-0011.
 */

import type { AccessObservation, Account } from "../types.js";
import type { Check, CheckContext, Finding } from "./types.js";

export const IDENTICAL_RESPONSE_CHECK_ID = "identical-response-across-tenants";

/** Имя сигнала-дайджеста по умолчанию. Переопределяется при регистрации. */
export const DEFAULT_DIGEST_SIGNAL = "digest";

export interface IdenticalResponseCheckOptions {
  readonly digestSignal?: string;
}

function digestOf(observation: AccessObservation, name: string): number | undefined {
  const value = observation.signals?.[name];
  return typeof value === "number" ? value : undefined;
}

/**
 * Два аккаунта из разных тенантов получили побайтово одинаковый ответ.
 *
 * Проверка срабатывает только на эндпоинтах, помеченных человеком как
 * `tenantScoped`. Без пометки `GET /v1/health` с его одинаковым для всех
 * `{"status":"ok"}` стал бы находкой, и настоящие утечки утонули бы в шуме.
 *
 * Рассматриваются только обращения **без объекта**. Когда объект задан, оба
 * аккаунта читают одну и ту же запись, и одинаковый ответ — не признак дефекта,
 * а его следствие: сам факт доступа чужого тенанта к объекту уже виден по статусу
 * и попадает в дифф. Дублировать его здесь значит считать один дефект дважды.
 */
export function createIdenticalResponseCheck(options: IdenticalResponseCheckOptions = {}): Check {
  const digestSignal = options.digestSignal ?? DEFAULT_DIGEST_SIGNAL;

  return {
    id: IDENTICAL_RESPONSE_CHECK_ID,
    description:
      "Ответ помеченного tenantScoped эндпоинта побайтово совпал у аккаунтов " +
      "из разных тенантов: признак отсутствующего фильтра по тенанту",
    severity: "high",
    standards: [
      { standard: "OWASP-API-2023", clause: "API1" },
      { standard: "OWASP-API-2023", clause: "API3" },
    ],

    run(context: CheckContext): readonly Finding[] {
      const { endpoints, accounts, observations } = context.matrix;

      const tenantScoped = new Set(
        endpoints
          .filter((endpoint) => endpoint.tenantScoped === true)
          .map((endpoint) => endpoint.id),
      );
      if (tenantScoped.size === 0) {
        return [];
      }

      const accountById = new Map<string, Account>(
        accounts.map((account) => [account.id, account]),
      );
      const findings: Finding[] = [];

      for (const endpointId of [...tenantScoped].sort()) {
        const relevant = observations
          .filter(
            (observation) =>
              observation.endpointId === endpointId &&
              observation.resourceId === undefined &&
              observation.outcome === "allowed" &&
              digestOf(observation, digestSignal) !== undefined,
          )
          .sort((left, right) => left.accountId.localeCompare(right.accountId));

        for (let i = 0; i < relevant.length; i += 1) {
          for (let j = i + 1; j < relevant.length; j += 1) {
            const left = relevant[i];
            const right = relevant[j];
            if (left === undefined || right === undefined) {
              continue;
            }

            const leftAccount = accountById.get(left.accountId);
            const rightAccount = accountById.get(right.accountId);
            if (leftAccount === undefined || rightAccount === undefined) {
              continue;
            }
            if (leftAccount.tenantId === rightAccount.tenantId) {
              continue;
            }
            if (digestOf(left, digestSignal) !== digestOf(right, digestSignal)) {
              continue;
            }

            findings.push({
              checkId: IDENTICAL_RESPONSE_CHECK_ID,
              severity: "high",
              title: `Ответ ${endpointId} одинаков для тенантов ${leftAccount.tenantId} и ${rightAccount.tenantId}`,
              endpointId,
              accountId: leftAccount.id,
              evidence: {
                otherAccountId: rightAccount.id,
                tenant: leftAccount.tenantId,
                otherTenant: rightAccount.tenantId,
                status: left.status,
                // Дайджест не выносится: он осмыслен только внутри прогона
                // (соль случайна), а читателю отчёта ничего не сообщает.
                identicalBody: true,
              },
            });
          }
        }
      }

      return findings;
    },
  };
}

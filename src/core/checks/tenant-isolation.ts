/**
 * Проверка изоляции тенантов по сигналам над телом.
 *
 * Закрывает класс дефектов, невидимый по статусу: списочная ручка без фильтра
 * по тенанту отвечает 200 всем, и корректная реализация отвечает так же.
 * Разница целиком в теле — см. ADR-0011.
 */

import { createTenantHierarchy, FLAT_HIERARCHY } from "../tenancy.js";
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
 * У двух аккаунтов из разных тенантов совпал дайджест ответа.
 *
 * Именно дайджест, а не тело: тела не сохраняются и сравнить их нечем
 * (ADR-0011). Отсюда и имя поля в обосновании — `bodyDigestsEqual`, а не
 * прежнее `identicalBody`: коллизия 48 бит маловероятна, но утверждение
 * о побайтовом совпадении инструмент не проверял и делать его не вправе.
 *
 * Проверка срабатывает только на эндпоинтах, для которых человек объявил
 * `responseMustDifferByTenant`. Без объявления `GET /v1/health` с его
 * одинаковым для всех `{"status":"ok"}` стал бы находкой, и настоящие утечки
 * утонули бы в шуме.
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
      "Дайджест ответа совпал у аккаунтов из разных тенантов на эндпоинте, " +
      "ответ которого объявлен обязанным различаться между ними: признак " +
      "отсутствующего фильтра по тенанту",
    severity: "high",
    /**
     * API3 (property-level) убран намеренно: проверка ничего не знает о полях,
     * она сравнивает ответ целиком. Числиться за находкой класса, который она
     * не умеет находить, — это завышенная заявка о покрытии.
     *
     * CWE-285, а не 862 или 863: снаружи «проверки нет» и «проверка есть,
     * но неверна» дают неотличимый ответ, поэтому честен только класс-родитель.
     */
    standards: [
      { standard: "OWASP-API-2023", clause: "API1" },
      { standard: "OWASP-ASVS-5.0", clause: "8.4.1" },
      { standard: "CWE", clause: "285" },
    ],

    run(context: CheckContext): readonly Finding[] {
      const { endpoints, accounts, observations } = context.matrix;

      const mustDiffer = new Set(
        endpoints
          .filter((endpoint) => endpoint.responseMustDifferByTenant === true)
          .map((endpoint) => endpoint.id),
      );
      if (mustDiffer.size === 0) {
        return [];
      }

      const accountById = new Map<string, Account>(
        accounts.map((account) => [account.id, account]),
      );
      // Пары, связанные родством, сравнивать нельзя. Холдинг видит объединение
      // своих брендов; если бренд у него один, ответ законно совпадает с ответом
      // этого бренда — и без учёта дерева проверка объявила бы утечкой роллап
      // на исправной платформе. Найдено прогоном холдингового сценария.
      const hierarchy =
        context.matrix.tenants === undefined
          ? FLAT_HIERARCHY
          : createTenantHierarchy(context.matrix.tenants);
      const findings: Finding[] = [];

      for (const endpointId of [...mustDiffer].sort()) {
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
            if (
              hierarchy.isAncestor(leftAccount.tenantId, rightAccount.tenantId) ||
              hierarchy.isAncestor(rightAccount.tenantId, leftAccount.tenantId)
            ) {
              continue;
            }
            if (digestOf(left, digestSignal) !== digestOf(right, digestSignal)) {
              continue;
            }

            findings.push({
              checkId: IDENTICAL_RESPONSE_CHECK_ID,
              severity: "high",
              // Заголовок говорит о дайджесте, а не об ответе: тела не
              // сохраняются, и сравнить их было нечем. См. `bodyDigestsEqual`.
              title: `Дайджест ответа ${endpointId} совпал у тенантов ${leftAccount.tenantId} и ${rightAccount.tenantId}`,
              endpointId,
              accountId: leftAccount.id,
              evidence: {
                otherAccountId: rightAccount.id,
                tenant: leftAccount.tenantId,
                otherTenant: rightAccount.tenantId,
                status: left.status,
                // Само значение дайджеста не выносится: оно осмыслено только
                // внутри прогона (соль случайна), а читателю отчёта ничего
                // не сообщает. Выносится факт равенства — и назван он тем,
                // что проверено: совпали 48 бит SHA-256 с солью, а не тела.
                // Коллизия маловероятна (порядка 10⁻⁹ на тысяче ответов,
                // ADR-0011), но отчёт ложится в основу инцидента, и разница
                // между «тела совпали» и «совпали дайджесты» там принципиальна.
                bodyDigestsEqual: true,
              },
            });
          }
        }
      }

      return findings;
    },
  };
}

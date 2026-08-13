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
 * Как назвать принадлежность аккаунта в тексте находки.
 *
 * У аккаунта вне тенантов (анонимного) тенанта нет, и подставлять сюда
 * служебное имя нельзя: в отчёт вернулась бы строка-сентинел, неотличимая
 * от настоящего тенанта с таким же именем.
 */
function tenantLabel(account: Account): string {
  return account.tenantId === undefined
    ? `аккаунта вне тенантов (${account.id})`
    : `тенанта ${account.tenantId}`;
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
      // Пары, связанные родством, сравнивать нельзя. Холдинг видит объединение
      // своих брендов; если бренд у него один, ответ законно совпадает с ответом
      // этого бренда — и без учёта дерева проверка объявила бы утечкой роллап
      // на исправной платформе. Найдено прогоном холдингового сценария.
      const hierarchy =
        context.matrix.tenants === undefined
          ? FLAT_HIERARCHY
          : createTenantHierarchy(context.matrix.tenants);
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
            const leftTenant = leftAccount.tenantId;
            const rightTenant = rightAccount.tenantId;
            // Сюда попадают и два аккаунта вне тенантов: тенанта нет ни у того,
            // ни у другого, разным он у них быть не может, и совпадение ответов
            // об изоляции ничего не говорит.
            if (leftTenant === rightTenant) {
              continue;
            }
            // Родство считается только между объявленными тенантами: у аккаунта
            // вне тенантов узла в дереве нет, а значит нет и родни. Пара «тенант
            // против аккаунта вне тенантов» сравнивается — и должна: совпадение
            // ответов означает, что данные тенанта видны тому, кто в нём не состоит.
            if (
              leftTenant !== undefined &&
              rightTenant !== undefined &&
              (hierarchy.isAncestor(leftTenant, rightTenant) ||
                hierarchy.isAncestor(rightTenant, leftTenant))
            ) {
              continue;
            }
            if (digestOf(left, digestSignal) !== digestOf(right, digestSignal)) {
              continue;
            }

            findings.push({
              checkId: IDENTICAL_RESPONSE_CHECK_ID,
              severity: "high",
              title: `Ответ ${endpointId} одинаков для ${tenantLabel(leftAccount)} и ${tenantLabel(rightAccount)}`,
              endpointId,
              accountId: leftAccount.id,
              evidence: {
                otherAccountId: rightAccount.id,
                // Ключ отсутствует, если тенанта нет: пустое место читается
                // как «вне тенантов», а заглушка читалась бы как имя.
                ...(leftTenant === undefined ? {} : { tenant: leftTenant }),
                ...(rightTenant === undefined ? {} : { otherTenant: rightTenant }),
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

/**
 * Проверка изоляции тенантов по сигналам над телом.
 *
 * Закрывает класс дефектов, невидимый по статусу: списочная ручка без фильтра
 * по тенанту отвечает 200 всем, и корректная реализация отвечает так же.
 * Разница целиком в теле — см. ADR-0011.
 */

import type { TenantHierarchy } from "../tenancy.js";
import { createTenantHierarchy, FLAT_HIERARCHY } from "../tenancy.js";
import type { AccessObservation, Account, TenantId } from "../types.js";
import { tenantIdsOf } from "../types.js";
import type { Check, CheckContext, Finding } from "./types.js";

export const IDENTICAL_RESPONSE_CHECK_ID = "identical-response-across-tenants";

/** Имя сигнала-дайджеста по умолчанию. Переопределяется при регистрации. */
export const DEFAULT_DIGEST_SIGNAL = "digest";

export interface IdenticalResponseCheckOptions {
  readonly digestSignal?: string;
}

/**
 * Прочие скаляры наблюдения — те, что человек объявил ради разбора.
 *
 * Попадают в доказательство под префиксом стороны: «alice видит 4 записи,
 * carol видит 4, а всего их 4» убеждает сильнее, чем «дайджесты совпали».
 */
function scalarsOf(
  observation: AccessObservation,
  digestSignal: string,
  side: "own" | "other",
): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {};
  for (const [name, value] of Object.entries(observation.signals ?? {})) {
    if (name !== digestSignal) {
      out[`${side}.${name}`] = value;
    }
  }
  return out;
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
  const tenants = tenantIdsOf(account);
  if (tenants.length === 0) {
    return `аккаунта вне тенантов (${account.id})`;
  }
  return tenants.length === 1 ? `тенанта ${tenants[0]}` : `тенантов ${tenants.join(", ")}`;
}

/**
 * Есть ли у двух аккаунтов общий тенант.
 *
 * Обобщение прежнего сравнения `leftTenant === rightTenant` на наборы: если
 * хоть один тенант общий, совпадение ответов законно и об изоляции ничего
 * не говорит — так же, как оно ничего не говорило про двух соседей по тенанту.
 */
function shareTenant(left: readonly TenantId[], right: readonly TenantId[]): boolean {
  return left.some((tenant) => right.includes(tenant));
}

/**
 * Связаны ли наборы родством хоть одной парой.
 *
 * Родство считается только между объявленными тенантами: у аккаунта вне
 * тенантов набор пуст, родни у него нет, и такая пара сравнивается — как
 * и прежде.
 */
function related(
  left: readonly TenantId[],
  right: readonly TenantId[],
  hierarchy: TenantHierarchy,
): boolean {
  return left.some((outer) =>
    right.some((inner) => hierarchy.isAncestor(outer, inner) || hierarchy.isAncestor(inner, outer)),
  );
}

/**
 * Сравнима ли пара аккаунтов.
 *
 * Одно место на всю проверку: и сам обход, и пересчёт покрытия спрашивают
 * отсюда. Разведи их — и покрытие начнёт описывать не то, что происходит.
 */
function comparable(left: Account, right: Account, hierarchy: TenantHierarchy): boolean {
  // Разные условия обращения сравнивать нельзя: у пары менялись бы сразу две
  // переменные — тенант и атрибуты, — и совпадение дайджестов не говорило бы
  // ни о том, ни о другом. Утверждение проверки — «разным тенантам приходит
  // разное при **прочих равных**». См. ADR-0019.
  if (left.contextId !== right.contextId) {
    return false;
  }
  const leftTenants = tenantIdsOf(left);
  const rightTenants = tenantIdsOf(right);
  if (leftTenants.length === 0 && rightTenants.length === 0) {
    return false;
  }
  if (shareTenant(leftTenants, rightTenants)) {
    return false;
  }
  return !related(leftTenants, rightTenants, hierarchy);
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
            // Пропуски: оба вне тенантов (разного тенанта у них нет);
            // общий тенант (законная одинаковость, как у соседей, и у частично
            // пересекающихся наборов тоже); родство по дереву (роллап холдинга
            // законно совпадает с ответом его бренда). Пара «тенант против
            // аккаунта вне тенантов» сравнивается — и должна: совпадение
            // означает, что данные тенанта видны тому, кто в нём не состоит.
            if (!comparable(leftAccount, rightAccount, hierarchy)) {
              continue;
            }
            const leftDigest = digestOf(left, digestSignal);
            if (leftDigest !== digestOf(right, digestSignal) || leftDigest === undefined) {
              continue;
            }

            findings.push({
              checkId: IDENTICAL_RESPONSE_CHECK_ID,
              severity: "high",
              // Заголовок говорит о дайджесте, а не об ответе: тела не
              // сохраняются, и сравнить их было нечем. См. `bodyDigestsEqual`.
              title: `Дайджест ответа ${endpointId} совпал у ${tenantLabel(leftAccount)} и ${tenantLabel(rightAccount)}`,
              endpointId,
              accountId: leftAccount.id,
              evidence: {
                // Значения, а не только вердикт. «Дайджесты совпали» без самих
                // дайджестов заставляет читателя идти в наблюдения и соединять
                // вручную; самое убедительное число прогона — «сколько записей
                // увидел каждый» — так и оставалось в стороне.
                digest: leftDigest,
                ...scalarsOf(left, digestSignal, "own"),
                ...scalarsOf(right, digestSignal, "other"),
                otherAccountId: rightAccount.id,
                // Ключ отсутствует, если тенанта нет: пустое место читается
                // как «вне тенантов», а заглушка читалась бы как имя.
                //
                // У аккаунта с набором членств ключа тоже нет, и это та же
                // причина, а не экономия. Склейка имён через запятую вернула бы
                // в поле, где стоят настоящие идентификаторы, строку, которой
                // ни один тенант не называется, — а прочитана она была бы как имя.
                // Имена набора называет заголовок находки.
                ...(leftAccount.tenantId === undefined ? {} : { tenant: leftAccount.tenantId }),
                ...(rightAccount.tenantId === undefined
                  ? {}
                  : { otherTenant: rightAccount.tenantId }),
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

/** Что проверка сравнивала на одном эндпоинте. */
export interface BodyComparisonCoverage {
  readonly endpointId: string;
  /** Пар аккаунтов, чьи ответы действительно сравнивались. */
  readonly comparedPairs: number;
  /**
   * Пар, пропущенных из-за родства тенантов.
   *
   * Названо отдельно, потому что молчание отчёта об этих парах читается как
   * «совпадений нет». На прогоне референс-платформы холдинг и саппорт с набором
   * членств совпали дайджестом — законно, они в родстве, — и без этого числа
   * отличить «пропустили» от «сравнили и разошлись» было нечем.
   */
  readonly skippedRelatedPairs: number;
  /**
   * Пары, пропущенные из-за разных условий обращения.
   *
   * Отдельно от родства: причины разные, и одно число на обе скрывало бы обе.
   * Отсутствует, когда условия не объявлены вовсе.
   */
  readonly skippedDifferentContextPairs?: number;
}

/**
 * Пересчитывает, что проверка сравнивала, не выполняя саму проверку.
 *
 * Живёт рядом с ней намеренно: правило пропуска пар описано здесь, и повторять
 * его в сборке отчёта значило бы завести дубль, который разойдётся.
 */
export function describeBodyComparison(
  context: CheckContext,
  options: IdenticalResponseCheckOptions = {},
): readonly BodyComparisonCoverage[] {
  const digestSignal = options.digestSignal ?? DEFAULT_DIGEST_SIGNAL;
  const hierarchy =
    context.matrix.tenants === undefined
      ? FLAT_HIERARCHY
      : createTenantHierarchy(context.matrix.tenants);
  const accountById = new Map(context.matrix.accounts.map((account) => [account.id, account]));

  return context.matrix.endpoints
    .filter((endpoint) => endpoint.responseMustDifferByTenant === true)
    .map((endpoint) => {
      const relevant = context.matrix.observations.filter(
        (observation) =>
          observation.endpointId === endpoint.id &&
          observation.resourceId === undefined &&
          observation.outcome === "allowed" &&
          digestOf(observation, digestSignal) !== undefined,
      );
      let compared = 0;
      let skipped = 0;
      let skippedByContext = 0;
      for (let i = 0; i < relevant.length; i += 1) {
        for (let j = i + 1; j < relevant.length; j += 1) {
          const left = accountById.get(relevant[i]?.accountId ?? "");
          const right = accountById.get(relevant[j]?.accountId ?? "");
          if (left === undefined || right === undefined) {
            continue;
          }
          if (comparable(left, right, hierarchy)) {
            compared += 1;
          } else if (left.contextId !== right.contextId) {
            // Считается отдельно: «пропущено по родству» про эту пару неправда,
            // а одно число на две разные причины скрывало бы обе.
            skippedByContext += 1;
          } else {
            skipped += 1;
          }
        }
      }
      return {
        endpointId: endpoint.id,
        comparedPairs: compared,
        skippedRelatedPairs: skipped,
        ...(skippedByContext === 0 ? {} : { skippedDifferentContextPairs: skippedByContext }),
      };
    });
}

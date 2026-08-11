/**
 * Сценарий: два тенанта, три роли, четыре эндпоинта.
 *
 * Наблюдения заданы вручную, а не выведены из политики. Если бы «чистый» набор
 * генерировался вызовом resolveExpected, тест на отсутствие расхождений проверял
 * бы согласованность функции с самой собой и не поймал бы ничего.
 */

import type {
  AccessObservation,
  AccessOutcome,
  Account,
  Endpoint,
  ExpectedAccessPolicy,
} from "../../src/core/index.js";
import { ANY } from "../../src/core/index.js";

export const endpoints: readonly Endpoint[] = [
  { id: "ep.profile.read", method: "GET", path: "/v1/players/{playerId}" },
  { id: "ep.wallet.read", method: "GET", path: "/v1/players/{playerId}/wallet" },
  { id: "ep.tickets.list", method: "GET", path: "/v1/support/tickets" },
  { id: "ep.users.list", method: "GET", path: "/v1/admin/users" },
];

export const accounts: readonly Account[] = [
  { id: "acc.player.a", roleId: "player", tenantId: "tenant-a" },
  { id: "acc.support.a", roleId: "support", tenantId: "tenant-a" },
  { id: "acc.admin.a", roleId: "admin", tenantId: "tenant-a" },
  { id: "acc.player.b", roleId: "player", tenantId: "tenant-b" },
];

/**
 * Объявленное намерение.
 *
 * Порядок правил значим: последнее подходящее выигрывает, поэтому широкое
 * правило для admin стоит после узких.
 */
export const policy: ExpectedAccessPolicy = {
  fallback: "denied",
  rules: [
    { roles: ANY, endpoints: ["ep.profile.read"], outcome: "allowed" },
    { roles: ["player"], endpoints: ["ep.wallet.read"], outcome: "allowed" },
    { roles: ["support"], endpoints: ["ep.tickets.list"], outcome: "allowed" },
    { roles: ["admin"], endpoints: ANY, outcome: "allowed" },
  ],
};

const STATUS_BY_OUTCOME: Readonly<Record<AccessOutcome, number>> = {
  allowed: 200,
  denied: 403,
  "not-found": 404,
  error: 0,
};

export function observe(
  accountId: string,
  endpointId: string,
  outcome: AccessOutcome,
): AccessObservation {
  return {
    accountId,
    endpointId,
    status: STATUS_BY_OUTCOME[outcome],
    headers: { "content-type": "application/json" },
    outcome,
    durationMs: 12,
  };
}

type Row = readonly [accountId: string, endpointId: string, outcome: AccessOutcome];

/** Платформа ведёт себя ровно так, как объявлено. Расхождений быть не должно. */
const CLEAN: readonly Row[] = [
  ["acc.player.a", "ep.profile.read", "allowed"],
  ["acc.player.a", "ep.wallet.read", "allowed"],
  ["acc.player.a", "ep.tickets.list", "denied"],
  ["acc.player.a", "ep.users.list", "denied"],

  ["acc.support.a", "ep.profile.read", "allowed"],
  ["acc.support.a", "ep.wallet.read", "denied"],
  ["acc.support.a", "ep.tickets.list", "allowed"],
  ["acc.support.a", "ep.users.list", "denied"],

  ["acc.admin.a", "ep.profile.read", "allowed"],
  ["acc.admin.a", "ep.wallet.read", "allowed"],
  ["acc.admin.a", "ep.tickets.list", "allowed"],
  ["acc.admin.a", "ep.users.list", "allowed"],

  ["acc.player.b", "ep.profile.read", "allowed"],
  ["acc.player.b", "ep.wallet.read", "allowed"],
  ["acc.player.b", "ep.tickets.list", "denied"],
  ["acc.player.b", "ep.users.list", "denied"],
];

function toObservations(rows: readonly Row[]): readonly AccessObservation[] {
  return rows.map(([accountId, endpointId, outcome]) => observe(accountId, endpointId, outcome));
}

export const cleanObservations = toObservations(CLEAN);

function replace(rows: readonly Row[], patch: Row): readonly Row[] {
  return rows.map((row) => (row[0] === patch[0] && row[1] === patch[1] ? patch : row));
}

/** Игрок дотягивается до административного списка пользователей. */
export const escalationObservations = toObservations(
  replace(CLEAN, ["acc.player.a", "ep.users.list", "allowed"]),
);

/** Поддержке отказано там, где доступ объявлен. */
export const denialObservations = toObservations(
  replace(CLEAN, ["acc.support.a", "ep.tickets.list", "denied"]),
);

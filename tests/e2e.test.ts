/**
 * Сквозной прогон против настоящего сервера.
 *
 * Собирает всю цепочку: конфигурация → спецификация → обход матрицы по HTTP →
 * дифф с политикой → отчёт. Единственный тест, который доказывает, что части
 * стыкуются, а не просто работают поодиночке.
 */

import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { createCredentialProvider } from "../src/adapters/credentials.js";
import { createHttpClient } from "../src/adapters/http.js";
import { createOpenApiParser } from "../src/adapters/openapi.js";
import { createThrottle } from "../src/adapters/throttle.js";
import { buildAccessMatrix, diffAccess, expandPolicy } from "../src/core/index.js";
import { parseRunConfig, resolveTokens, toAccounts } from "../src/io/config.js";
import { buildReport, exitCodeFor } from "../src/report/build.js";
import { collectObservations, probeCanaries } from "../src/runner.js";

const SPEC = `
openapi: 3.0.0
info: { title: demo, version: "1" }
paths:
  /v1/support/tickets:
    get: { operationId: tickets.list, responses: { "200": { description: ok } } }
  /v1/admin/users:
    get: { operationId: users.list, responses: { "200": { description: ok } } }
  /v1/players/{playerId}:
    get: { operationId: profile.read, responses: { "200": { description: ok } } }
  # Ручка «кто я» — та, что законно доступна любому вошедшему. Канарейке нужна
  # именно такая: она подтверждает, что токен работает, а не что доступ есть.
  /v1/me:
    get: { operationId: profile.me, responses: { "200": { description: ok } } }
`;

const PLAYER_TOKEN = "e2e-player-token";
const ADMIN_TOKEN = "e2e-admin-token";

/**
 * Стенд с намеренным дефектом: список пользователей открыт игроку,
 * хотя политика разрешает его только администратору.
 */
async function startTarget() {
  const server = createServer((request, response) => {
    const token = (request.headers.authorization ?? "").replace("Bearer ", "");
    const isAdmin = token === ADMIN_TOKEN;
    const url = request.url ?? "";

    response.setHeader("set-cookie", "session=must-not-reach-report");

    if (url === "/v1/me") {
      // Отвечает любому вошедшему и 401 без токена: канарейка проверяет
      // аутентификацию, а не права.
      const known = token === ADMIN_TOKEN || token === PLAYER_TOKEN;
      response.writeHead(known ? 200 : 401).end();
      return;
    }
    if (url === "/v1/support/tickets") {
      response.writeHead(isAdmin ? 200 : 403).end();
      return;
    }
    if (url === "/v1/admin/users") {
      // Дефект: доступ выдаётся всем.
      response.writeHead(200).end();
      return;
    }
    response.writeHead(404).end();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("не удалось поднять стенд");
  }
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

describe("сквозной прогон", () => {
  it("находит подложенную эскалацию и не выдумывает лишнего", async () => {
    const target = await startTarget();
    try {
      const config = parseRunConfig(`
target:
  baseUrl: http://127.0.0.1:${target.port}
  allowedHosts: [127.0.0.1]
accounts:
  # Канарейка обязательна там, где есть учётные данные: без неё прогон
  # объявляется недостоверным, потому что «отказали везде» и «мы не вошли»
  # снаружи неразличимы. Найдено состязательной проверкой.
  - { id: player-a, role: player, tenant: tenant-a, tokenEnv: E2E_PLAYER, canary: profile.me }
  - { id: admin-a,  role: admin,  tenant: tenant-a, tokenEnv: E2E_ADMIN, canary: profile.me }
policy:
  fallback: denied
  rules:
    - { roles: [admin], endpoints: "*", outcome: allowed }
    - { roles: "*", endpoints: [profile.me], outcome: allowed }
`);

      const endpoints = await createOpenApiParser().parse(SPEC);
      const credentials = createCredentialProvider(
        config.auth,
        resolveTokens(config, {
          E2E_PLAYER: PLAYER_TOKEN,
          E2E_ADMIN: ADMIN_TOKEN,
        }),
      );
      const accounts = toAccounts(config).accounts;
      const client = createHttpClient({
        allowedHosts: config.target.allowedHosts,
        throttle: createThrottle({ concurrency: 2, requestsPerSecond: 1000, maxRequests: 50 }),
      });

      // Канарейки прогоняются по-настоящему, как это делает CLI: прогон
      // без подтверждённой аутентификации объявляется недостоверным.
      const canaries = await probeCanaries({
        baseUrl: config.target.baseUrl,
        endpoints,
        canaries: config.accounts.map((account) => ({
          accountId: account.id,
          endpointId: account.canary ?? "",
        })),
        credentials,
        client,
        accounts,
      });
      expect(canaries.every((result) => result.authenticated)).toBe(true);

      const startedAt = new Date();
      const { observations, skipped, failures } = await collectObservations({
        baseUrl: config.target.baseUrl,
        endpoints,
        accounts,
        credentials,
        client,
      });

      const matrix = buildAccessMatrix({ endpoints, accounts, observations });
      // Тот же путь, что в CLI: политика раскрывается до диффа.
      const policy = expandPolicy(config.policy, endpoints);
      const findings = diffAccess(matrix, policy);
      const report = buildReport({
        version: "0.0.0-test",
        config,
        endpoints,
        observations,
        skipped,
        failures,
        unauthenticated: [],
        canariesChecked: canaries.length,
        truncated: false,
        findings,
        policy,
        startedAt,
        finishedAt: new Date(),
      });

      // Эндпоинт с параметром в пути не опрашивался и помечен пропущенным.
      expect(report.skipped).toEqual([{ endpointId: "profile.read", reason: "path-parameters" }]);

      // Подложенный дефект найден: игрок дотянулся до админского списка.
      const escalations = report.findings.filter((f) => f.kind === "privilege-escalation");
      expect(escalations).toEqual([
        {
          accountId: "player-a",
          endpointId: "users.list",
          expected: "denied",
          actual: "allowed",
          kind: "privilege-escalation",
          source: "matrix",
          severity: "high",
          // Воспроизведение приложено к находке: читателю не нужно склеивать
          // адрес из эндпоинта, объекта и базового URL вручную.
          request: { method: "GET", url: `${config.target.baseUrl}/v1/admin/users` },
          // Код ответа прямо в находке: «allowed» означает лишь «2xx»,
          // а какой именно — приходилось искать в наблюдениях.
          status: 200,
        },
      ]);
      expect(report.summary.byKind["privilege-escalation"]).toBe(1);
      expect(exitCodeFor(report)).toBe(1);

      // Ложных срабатываний нет: там, где платформа ведёт себя как объявлено,
      // расхождений быть не должно.
      expect(report.findings.filter((f) => f.kind === "unexpected-denial")).toEqual([]);

      // Ни токенов, ни сессионной куки в отчёте.
      const serialized = JSON.stringify(report);
      expect(serialized).not.toContain(PLAYER_TOKEN);
      expect(serialized).not.toContain(ADMIN_TOKEN);
      expect(serialized).not.toContain("must-not-reach-report");
      expect(serialized).toContain("[REDACTED]");
    } finally {
      await target.close();
    }
  });

  it("на стенде без дефектов не находит ничего и завершается успехом", async () => {
    const server = createServer((request, response) => {
      const authorization = request.headers.authorization ?? "";
      if ((request.url ?? "") === "/v1/me") {
        const known = authorization.includes(ADMIN_TOKEN) || authorization.includes(PLAYER_TOKEN);
        response.writeHead(known ? 200 : 401).end();
        return;
      }
      const isAdmin = authorization.includes(ADMIN_TOKEN);
      response.writeHead(isAdmin ? 200 : 403).end();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("не удалось поднять стенд");
    }

    try {
      const config = parseRunConfig(`
target:
  baseUrl: http://127.0.0.1:${address.port}
  allowedHosts: [127.0.0.1]
accounts:
  # Канарейка обязательна там, где есть учётные данные: без неё прогон
  # объявляется недостоверным, потому что «отказали везде» и «мы не вошли»
  # снаружи неразличимы. Найдено состязательной проверкой.
  - { id: player-a, role: player, tenant: tenant-a, tokenEnv: E2E_PLAYER, canary: profile.me }
  - { id: admin-a,  role: admin,  tenant: tenant-a, tokenEnv: E2E_ADMIN, canary: profile.me }
policy:
  fallback: denied
  rules:
    - { roles: [admin], endpoints: "*", outcome: allowed }
    - { roles: "*", endpoints: [profile.me], outcome: allowed }
`);
      const endpoints = await createOpenApiParser().parse(SPEC);
      const accounts = toAccounts(config).accounts;
      const client = createHttpClient({
        allowedHosts: config.target.allowedHosts,
        throttle: createThrottle({ concurrency: 2, requestsPerSecond: 1000, maxRequests: 50 }),
      });
      const credentials = createCredentialProvider(
        config.auth,
        resolveTokens(config, { E2E_PLAYER: PLAYER_TOKEN, E2E_ADMIN: ADMIN_TOKEN }),
      );
      // Канарейки прогоняются и здесь: чистый отчёт без подтверждённой
      // аутентификации — ровно то, что состязательная проверка и предъявила.
      const canaries = await probeCanaries({
        baseUrl: config.target.baseUrl,
        endpoints,
        canaries: config.accounts.map((account) => ({
          accountId: account.id,
          endpointId: account.canary ?? "",
        })),
        credentials,
        client,
        accounts,
      });

      const { observations, skipped, failures } = await collectObservations({
        baseUrl: config.target.baseUrl,
        endpoints,
        accounts,
        credentials,
        client,
      });

      const policy = expandPolicy(config.policy, endpoints);
      const findings = diffAccess(buildAccessMatrix({ endpoints, accounts, observations }), policy);
      const report = buildReport({
        version: "0.0.0-test",
        config,
        endpoints,
        observations,
        skipped,
        failures,
        unauthenticated: [],
        canariesChecked: canaries.length,
        truncated: false,
        findings,
        policy,
        startedAt: new Date(),
        finishedAt: new Date(),
      });

      expect(report.summary.byKind["privilege-escalation"]).toBe(0);
      expect(report.summary.byKind["unexpected-denial"]).toBe(0);
      expect(exitCodeFor(report)).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

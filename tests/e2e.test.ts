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
import { buildAccessMatrix, diffAccess } from "../src/core/index.js";
import { parseRunConfig, resolveTokens, toAccounts } from "../src/io/config.js";
import { buildReport, exitCodeFor } from "../src/report/build.js";
import { collectObservations } from "../src/runner.js";

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
  - { id: player-a, role: player, tenant: tenant-a, tokenEnv: E2E_PLAYER }
  - { id: admin-a,  role: admin,  tenant: tenant-a, tokenEnv: E2E_ADMIN }
policy:
  fallback: denied
  rules:
    - { roles: [admin], endpoints: "*", outcome: allowed }
`);

      const endpoints = await createOpenApiParser().parse(SPEC);
      const credentials = createCredentialProvider(
        config.auth,
        resolveTokens(config, {
          E2E_PLAYER: PLAYER_TOKEN,
          E2E_ADMIN: ADMIN_TOKEN,
        }),
      );
      const accounts = toAccounts(config);

      const startedAt = new Date();
      const { observations, skipped, failures } = await collectObservations({
        baseUrl: config.target.baseUrl,
        endpoints,
        accounts,
        credentials,
        client: createHttpClient({
          allowedHosts: config.target.allowedHosts,
          throttle: createThrottle({ concurrency: 2, requestsPerSecond: 1000, maxRequests: 50 }),
        }),
      });

      const matrix = buildAccessMatrix({ endpoints, accounts, observations });
      const findings = diffAccess(matrix, config.policy);
      const report = buildReport({
        version: "0.0.0-test",
        config,
        endpoints,
        observations,
        skipped,
        failures,
        unauthenticated: [],
        canariesChecked: 0,
        findings,
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
      const isAdmin = (request.headers.authorization ?? "").includes(ADMIN_TOKEN);
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
  - { id: player-a, role: player, tenant: tenant-a, tokenEnv: E2E_PLAYER }
  - { id: admin-a,  role: admin,  tenant: tenant-a, tokenEnv: E2E_ADMIN }
policy:
  fallback: denied
  rules:
    - { roles: [admin], endpoints: "*", outcome: allowed }
`);
      const endpoints = await createOpenApiParser().parse(SPEC);
      const accounts = toAccounts(config);
      const { observations, skipped, failures } = await collectObservations({
        baseUrl: config.target.baseUrl,
        endpoints,
        accounts,
        credentials: createCredentialProvider(
          config.auth,
          resolveTokens(config, { E2E_PLAYER: PLAYER_TOKEN, E2E_ADMIN: ADMIN_TOKEN }),
        ),
        client: createHttpClient({
          allowedHosts: config.target.allowedHosts,
          throttle: createThrottle({ concurrency: 2, requestsPerSecond: 1000, maxRequests: 50 }),
        }),
      });

      const findings = diffAccess(
        buildAccessMatrix({ endpoints, accounts, observations }),
        config.policy,
      );
      const report = buildReport({
        version: "0.0.0-test",
        config,
        endpoints,
        observations,
        skipped,
        failures,
        unauthenticated: [],
        canariesChecked: 0,
        findings,
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

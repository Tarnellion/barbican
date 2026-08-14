/**
 * An end-to-end run against a real server.
 *
 * It assembles the whole chain: configuration -> specification -> walking the
 * matrix over HTTP -> diff against the policy -> report. The only test that
 * proves the parts fit together rather than merely working on their own.
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
  # A 'who am I' endpoint is the one lawfully available to anyone logged in.
  # A canary needs exactly that: it confirms the token works, not that access
  # is granted.
  /v1/me:
    get: { operationId: profile.me, responses: { "200": { description: ok } } }
`;

const PLAYER_TOKEN = "e2e-player-token";
const ADMIN_TOKEN = "e2e-admin-token";

/**
 * A deployment with a deliberate defect: the list of users is open to a player,
 * though the policy allows it to an administrator only.
 */
async function startTarget() {
  const server = createServer((request, response) => {
    const token = (request.headers.authorization ?? "").replace("Bearer ", "");
    const isAdmin = token === ADMIN_TOKEN;
    const url = request.url ?? "";

    response.setHeader("set-cookie", "session=must-not-reach-report");

    if (url === "/v1/me") {
      // Answers anyone logged in and 401 without a token: a canary checks
      // authentication, not permissions.
      const known = token === ADMIN_TOKEN || token === PLAYER_TOKEN;
      response.writeHead(known ? 200 : 401).end();
      return;
    }
    if (url === "/v1/support/tickets") {
      response.writeHead(isAdmin ? 200 : 403).end();
      return;
    }
    if (url === "/v1/admin/users") {
      // The defect: access is granted to everyone.
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
    throw new Error("could not start the deployment");
  }
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

describe("the end-to-end run", () => {
  it("finds the planted escalation and invents nothing extra", async () => {
    const target = await startTarget();
    try {
      const config = parseRunConfig(`
target:
  baseUrl: http://127.0.0.1:${target.port}
  allowedHosts: [127.0.0.1]
accounts:
  # A canary is mandatory wherever there are credentials: without one the run
  # is declared untrustworthy, because 'denied everywhere' and 'we never logged
  # in' are indistinguishable from the outside. Found by adversarial review.
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

      // The canaries are probed for real, as the CLI does: a run without
      // confirmed authentication is declared untrustworthy.
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
      // The same path as in the CLI: the policy is expanded before the diff.
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

      // The endpoint with a path parameter was not probed and is marked skipped.
      expect(report.skipped).toEqual([{ endpointId: "profile.read", reason: "path-parameters" }]);

      // The planted defect is found: a player reached the admin list.
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
          // The reproduction is attached to the finding: the reader does not
          // have to assemble the address from the endpoint, the resource and
          // the base URL by hand.
          request: { method: "GET", url: `${config.target.baseUrl}/v1/admin/users` },
          // The response code sits right in the finding: 'allowed' means only
          // '2xx', and which one exactly had to be looked up in the observations.
          status: 200,
        },
      ]);
      expect(report.summary.byKind["privilege-escalation"]).toBe(1);
      expect(exitCodeFor(report)).toBe(1);

      // No false positives: where the platform behaves as declared there must
      // be no discrepancies.
      expect(report.findings.filter((f) => f.kind === "unexpected-denial")).toEqual([]);

      // Neither the tokens nor the session cookie are in the report.
      const serialized = JSON.stringify(report);
      expect(serialized).not.toContain(PLAYER_TOKEN);
      expect(serialized).not.toContain(ADMIN_TOKEN);
      expect(serialized).not.toContain("must-not-reach-report");
      expect(serialized).toContain("[REDACTED]");
    } finally {
      await target.close();
    }
  });

  it("finds nothing on a deployment with no defects and exits successfully", async () => {
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
      throw new Error("could not start the deployment");
    }

    try {
      const config = parseRunConfig(`
target:
  baseUrl: http://127.0.0.1:${address.port}
  allowedHosts: [127.0.0.1]
accounts:
  # A canary is mandatory wherever there are credentials: without one the run
  # is declared untrustworthy, because 'denied everywhere' and 'we never logged
  # in' are indistinguishable from the outside. Found by adversarial review.
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
      // The canaries are probed here too: a clean report without confirmed
      // authentication is exactly what the adversarial review produced.
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

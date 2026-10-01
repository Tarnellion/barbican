/**
 * `permissive-cors` through the whole command, as an operator meets it.
 *
 * `tests/core/check-cors.test.ts` proves the check on hand-written observations.
 * What it cannot prove is the chain around it, and ADR-0076 rests on three links
 * of that chain that were read in the source and not run:
 *
 * - **A condition may declare `origin`.** The refusal lists in `basis.ts` name
 *   credentials, transport and routing headers; `origin` is in none of them. A
 *   fourth layer nobody remembered would make the whole check unreachable from
 *   the CLI while every unit test stayed green.
 * - **The two response headers survive the adapter.** They are on the value
 *   allowlist, and a value that were redacted would read `[REDACTED]` and be
 *   found by nothing.
 * - **The finding carries the condition.** `Finding.contextId` is what keeps the
 *   same wildcard under two declared origins apart, and it comes from the
 *   account the cell was walked as.
 *
 * The stand behaves as a real server does: CORS headers only in answer to a
 * request that carried an `Origin`. A stand that sent them unasked would make the
 * case "no origin condition declared" find something, which is the opposite of
 * what the check says about itself.
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunFlags } from "../../src/cli/flags.js";
import { run } from "../../src/cli/run.js";

const TOKEN = "cors-run-token-alice";

/** What the stand answers to a request that carries an `Origin`. */
type Behaviour = "null-with-credentials" | "wildcard-with-credentials" | "specific" | "none";

let server: Server;
let port: number;
let behaviour: Behaviour;
let directory: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    const token = (request.headers.authorization ?? "").replace("Bearer ", "");
    if (token !== TOKEN) {
      response.writeHead(401).end();
      return;
    }
    const origin = request.headers.origin;
    // Only in answer to an Origin, as a real server does. Nothing is sent
    // unasked, so a run with no origin condition has nothing to read.
    if (origin !== undefined) {
      if (behaviour === "null-with-credentials") {
        response.setHeader("access-control-allow-origin", "null");
        response.setHeader("access-control-allow-credentials", "true");
      } else if (behaviour === "wildcard-with-credentials") {
        response.setHeader("access-control-allow-origin", "*");
        response.setHeader("access-control-allow-credentials", "true");
      } else if (behaviour === "specific") {
        response.setHeader("access-control-allow-origin", "https://app.example.com");
        response.setHeader("access-control-allow-credentials", "true");
      }
    }
    response.writeHead(200).end();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("could not start the stand");
  }
  port = address.port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
});

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "barbican-cors-run-"));
  behaviour = "none";
  vi.stubEnv("CORS_RUN_TOKEN_ALICE", TOKEN);
  Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const ENDPOINTS = `
endpoints:
  - id: me
    method: GET
    path: /v1/me
`;

/** The declaration, with or without the condition that asks the question. */
function configText(withOriginCondition: boolean): string {
  const contexts = withOriginCondition
    ? `
contexts:
  - id: sandboxed
    description: a request from a sandboxed document, which sends the null origin
    headers: { origin: "null" }
    endpoints: [me]
`
    : "";
  const contextRule = withOriginCondition
    ? "    - { roles: [user], endpoints: [me], context: sandboxed, outcome: allowed }\n"
    : "";
  return `
target:
  label: cors run test stand
  baseUrl: http://127.0.0.1:${port}
  allowedHosts: [127.0.0.1]
accounts:
  - { id: alice, role: user, tokenEnv: CORS_RUN_TOKEN_ALICE, canary: me }
${contexts}
policy:
  fallback: denied
  rules:
    - { roles: [user], endpoints: [me], outcome: allowed }
${contextRule}`;
}

interface WrittenReport {
  readonly findings: readonly {
    readonly kind: string;
    readonly severity: string;
    readonly endpointId?: string;
    readonly contextId?: string;
    readonly evidence?: Readonly<Record<string, unknown>>;
  }[];
  readonly coverage: {
    readonly checksRun: readonly { readonly id: string }[];
    readonly byCheck?: readonly { readonly checkId: string }[];
  };
  readonly observations?: readonly {
    readonly accountId: string;
    readonly headers?: Readonly<Record<string, string>>;
  }[];
}

async function runIt(withOriginCondition: boolean): Promise<{
  readonly code: number;
  readonly report: WrittenReport;
}> {
  const config = join(directory, "barbican.run.yaml");
  const endpoints = join(directory, "endpoints.yaml");
  const reportPath = join(directory, "run.json");
  await writeFile(config, configText(withOriginCondition), "utf8");
  await writeFile(endpoints, ENDPOINTS, "utf8");
  const flags: RunFlags = { config, endpoints, report: reportPath, identify: true };
  const code = await run(flags);
  return { code, report: JSON.parse(await readFile(reportPath, "utf8")) as WrittenReport };
}

const corsFindings = (report: WrittenReport) =>
  report.findings.filter((finding) => finding.kind === "permissive-cors");

describe("permissive-cors, through the command", () => {
  it("finds the null origin with credentials under a declared origin condition", async () => {
    behaviour = "null-with-credentials";

    const { code, report } = await runIt(true);

    const found = corsFindings(report);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      severity: "high",
      endpointId: "me",
      // The condition travelled from the account the cell was walked as.
      contextId: "sandboxed",
      evidence: { allowOrigin: "null", allowCredentials: true },
    });
    // A high finding fails the run.
    expect(code).toBe(1);
  });

  it("finds the wildcard with credentials, and weighs it lighter", async () => {
    behaviour = "wildcard-with-credentials";

    const { report } = await runIt(true);

    expect(corsFindings(report)).toHaveLength(1);
    expect(corsFindings(report)[0]?.severity).toBe("medium");
  });

  it("finds nothing when no condition declares an origin, and the check still ran", async () => {
    // The stand is just as broken, but a server answers CORS only to an Origin
    // and nothing here sent one. "Never asked" has to read as no finding, and
    // the check must still be in the report as having run.
    behaviour = "null-with-credentials";

    const { code, report } = await runIt(false);

    expect(corsFindings(report)).toEqual([]);
    expect(report.coverage.checksRun.map((check) => check.id)).toContain("permissive-cors");
    expect(code).toBe(0);
  });

  it("finds nothing on a platform that echoes a specific origin, which it cannot judge", async () => {
    behaviour = "specific";

    const { report } = await runIt(true);

    expect(corsFindings(report)).toEqual([]);
  });

  it("keeps the two header values in the observations rather than redacting them", async () => {
    // The allowlist entry is what makes the check able to see anything. A
    // regression that dropped it would leave `[REDACTED]` here and every case
    // above would stop finding, which is the false clean this guards.
    behaviour = "null-with-credentials";

    const { report } = await runIt(true);

    const underCondition = report.observations?.find((one) => one.accountId.includes("sandboxed"));
    expect(underCondition?.headers?.["access-control-allow-origin"]).toBe("null");
    expect(underCondition?.headers?.["access-control-allow-credentials"]).toBe("true");
  });
});

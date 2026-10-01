/**
 * `permissive-cors` through the whole command, as an operator meets it.
 *
 * `tests/core/check-cors.test.ts` proves the check on hand-written observations.
 * What it cannot prove is the chain around it, and ADR-0076 and ADR-0078 rest on
 * links of that chain that were read in the source and not run:
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
 * - **`originIsForeign` reaches the check.** The marker is parsed, resolved to the
 *   origin the context sends, handed to the check at registration, and restated
 *   in the report. Any one of those four steps dropped leaves a run that exits 0
 *   on a platform that trusts the origin the operator said it must not.
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

/**
 * What the stand answers to a request that carries an `Origin`.
 *
 * `reflect` copies the origin it was sent, which is the defect ADR-0078 exists to
 * judge; `allowlist` answers with one origin of its own whatever it was sent,
 * which is the platform behaving correctly and looking, from the response alone,
 * exactly like a reflection of that one origin.
 */
type Behaviour =
  | "null-with-credentials"
  | "wildcard-with-credentials"
  | "allowlist"
  | "reflect"
  | "none";

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
      const allow = (value: string) => {
        response.setHeader("access-control-allow-origin", value);
        response.setHeader("access-control-allow-credentials", "true");
      };
      if (behaviour === "null-with-credentials") {
        allow("null");
      } else if (behaviour === "wildcard-with-credentials") {
        allow("*");
      } else if (behaviour === "allowlist") {
        allow("https://app.example.com");
      } else if (behaviour === "reflect") {
        allow(origin);
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

/** A set of request conditions that sends an `Origin`. */
interface OriginCondition {
  readonly id: string;
  readonly description: string;
  /** The header exactly as the declaration writes it, quotes included. */
  readonly origin: string;
  /** Extra lines of the declaration, for `originIsForeign` and for refusals. */
  readonly extra?: string;
}

/** What a sandboxed document sends. Wrong with credentials whatever was asked. */
const SANDBOXED: OriginCondition = {
  id: "sandboxed",
  description: "a request from a sandboxed document, which sends the null origin",
  origin: '"null"',
};

/** An origin the operator says the platform must never trust with credentials. */
const FOREIGN: OriginCondition = {
  id: "foreign-origin",
  description: "a request from a page the platform has no reason to trust",
  origin: '"https://attacker.example"',
  extra: "    originIsForeign: true\n",
};

/** The same sort of origin, not marked: a partner, as far as the platform's owner says. */
const PARTNER: OriginCondition = {
  id: "partner-origin",
  description: "a request from an origin nobody declared foreign",
  origin: '"https://partner.example"',
};

/** The declaration, with or without the condition that asks the question. */
function configText(condition?: OriginCondition): string {
  const contexts =
    condition === undefined
      ? ""
      : `
contexts:
  - id: ${condition.id}
    description: ${condition.description}
    headers: { origin: ${condition.origin} }
${condition.extra ?? ""}    endpoints: [me]
`;
  const contextRule =
    condition === undefined
      ? ""
      : `    - { roles: [user], endpoints: [me], context: ${condition.id}, outcome: allowed }\n`;
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
    readonly byCheck: readonly {
      readonly checkId: string;
      readonly endpointId?: string;
      readonly counters: Readonly<Record<string, number>>;
    }[];
  };
  readonly inputs: {
    readonly contexts: readonly {
      readonly id: string;
      readonly foreignOrigin?: string;
      readonly headers: Readonly<Record<string, unknown>>;
    }[];
  };
  readonly observations?: readonly {
    readonly accountId: string;
    readonly headers?: Readonly<Record<string, string>>;
  }[];
}

function flagsFor(config: string, endpoints: string, report: string): RunFlags {
  return { config, endpoints, report, identify: true };
}

async function runIt(condition?: OriginCondition): Promise<{
  readonly code: number;
  readonly report: WrittenReport;
}> {
  const config = join(directory, "barbican.run.yaml");
  const endpoints = join(directory, "endpoints.yaml");
  const reportPath = join(directory, "run.json");
  await writeFile(config, configText(condition), "utf8");
  await writeFile(endpoints, ENDPOINTS, "utf8");
  const code = await run(flagsFor(config, endpoints, reportPath));
  return { code, report: JSON.parse(await readFile(reportPath, "utf8")) as WrittenReport };
}

const corsFindings = (report: WrittenReport) =>
  report.findings.filter((finding) => finding.kind === "permissive-cors");

const corsCoverage = (report: WrittenReport, endpointId: string) =>
  report.coverage.byCheck.find(
    (row) => row.checkId === "permissive-cors" && row.endpointId === endpointId,
  );

describe("permissive-cors, through the command", () => {
  it("finds the null origin with credentials under a declared origin condition", async () => {
    behaviour = "null-with-credentials";

    const { code, report } = await runIt(SANDBOXED);

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

    const { report } = await runIt(SANDBOXED);

    expect(corsFindings(report)).toHaveLength(1);
    expect(corsFindings(report)[0]?.severity).toBe("medium");
  });

  it("finds nothing when no condition declares an origin, and the check still ran", async () => {
    // The stand is just as broken, but a server answers CORS only to an Origin
    // and nothing here sent one. "Never asked" has to read as no finding, and
    // the check must still be in the report as having run.
    behaviour = "null-with-credentials";

    const { code, report } = await runIt();

    expect(corsFindings(report)).toEqual([]);
    expect(report.coverage.checksRun.map((check) => check.id)).toContain("permissive-cors");
    expect(code).toBe(0);
  });

  it("finds nothing on a platform that allows one origin of its own, which it cannot judge", async () => {
    behaviour = "allowlist";

    const { report } = await runIt(PARTNER);

    expect(corsFindings(report)).toEqual([]);
  });

  it("keeps the two header values in the observations rather than redacting them", async () => {
    // The allowlist entry is what makes the check able to see anything. A
    // regression that dropped it would leave `[REDACTED]` here and every case
    // above would stop finding, which is the false clean this guards.
    behaviour = "null-with-credentials";

    const { report } = await runIt(SANDBOXED);

    const underCondition = report.observations?.find((one) => one.accountId.includes("sandboxed"));
    expect(underCondition?.headers?.["access-control-allow-origin"]).toBe("null");
    expect(underCondition?.headers?.["access-control-allow-credentials"]).toBe("true");
  });
});

describe("a reflected origin, through the command (ADR-0078)", () => {
  it("finds a platform that reflects the origin the operator declared foreign", async () => {
    behaviour = "reflect";

    const { code, report } = await runIt(FOREIGN);

    const found = corsFindings(report);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      severity: "high",
      endpointId: "me",
      contextId: "foreign-origin",
      evidence: {
        allowOrigin: "https://attacker.example",
        allowCredentials: true,
        foreignOriginDeclared: true,
      },
    });
    expect(code).toBe(1);
  });

  it("is silent about the very same reflection when the origin was not declared foreign", async () => {
    // The boundary the field exists to draw. The platform echoes the origin and a
    // partner's origin looks identical, so without the marking there is nothing
    // to conclude, and the run must not conclude it.
    behaviour = "reflect";

    const { code, report } = await runIt(PARTNER);

    expect(corsFindings(report)).toEqual([]);
    expect(code).toBe(0);
  });

  it("says the question was asked when the platform answers it correctly", async () => {
    // An allowlist that does not trust the declared origin: no finding, and the
    // coverage is what tells this apart from a run that never asked.
    behaviour = "allowlist";

    const { code, report } = await runIt(FOREIGN);

    expect(corsFindings(report)).toEqual([]);
    expect(corsCoverage(report, "me")?.counters).toMatchObject({
      corsResponsesSeen: 1,
      corsResponsesAllowingCredentials: 1,
      foreignOriginCellsAnswered: 1,
    });
    expect(code).toBe(0);
  });

  it("leaves the counter out of a run that declared no foreign origin", async () => {
    behaviour = "allowlist";

    const { report } = await runIt(PARTNER);

    expect(corsCoverage(report, "me")?.counters).not.toHaveProperty("foreignOriginCellsAnswered");
  });

  it("restates the marking in the report, beside the header that was sent", async () => {
    behaviour = "allowlist";

    const { report } = await runIt(FOREIGN);

    const declared = report.inputs.contexts.find((one) => one.id === "foreign-origin");
    expect(declared?.foreignOrigin).toBe("https://attacker.example");
    expect(declared?.headers.origin).toBe("https://attacker.example");
  });

  it("refuses a marking with nothing to mark before the first request", async () => {
    const config = join(directory, "barbican.run.yaml");
    const endpoints = join(directory, "endpoints.yaml");
    await writeFile(
      config,
      configText({
        id: "foreign-origin",
        description: "marked, but sends no origin of its own",
        origin: '"https://attacker.example/"',
        extra: "    originIsForeign: true\n",
      }),
      "utf8",
    );
    await writeFile(endpoints, ENDPOINTS, "utf8");

    await expect(run(flagsFor(config, endpoints, join(directory, "run.json")))).rejects.toThrow(
      /says originIsForeign: true/,
    );
  });
});

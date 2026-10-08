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
 * The stand behaves as most CORS layers do: headers only in answer to a request
 * that carried an `Origin`, so a run that declares no origin condition has nothing
 * to read from it and is clean. One behaviour, `unasked-wildcard`, is the other
 * kind of platform, a global middleware that decorates every response; the check
 * reads every answered cell, so that stand is reported with no declaration at all.
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunFlags } from "../../src/cli/flags.js";
import { pack } from "../../src/cli/pack.js";
import { run } from "../../src/cli/run.js";
import { WARNINGS } from "../../src/report/build.js";

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
  | "unasked-wildcard"
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
    const allow = (value: string) => {
      response.setHeader("access-control-allow-origin", value);
      response.setHeader("access-control-allow-credentials", "true");
    };
    // `unasked-wildcard` is the platform that decorates every response, which is
    // what a global CORS middleware configured with `*` and credentials does.
    // The others answer only a request that named an origin, as most layers do,
    // so a run with no origin condition has nothing to read from them.
    if (behaviour === "unasked-wildcard") {
      allow("*");
    } else if (origin !== undefined) {
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

/** The same list plus a write, which a run without --unsafe-methods does not walk. */
const ENDPOINTS_WITH_A_WRITE = `${ENDPOINTS}  - id: write.me
    method: POST
    path: /v1/write
`;

/** A set of request conditions that sends an `Origin`. */
interface OriginCondition {
  readonly id: string;
  readonly description: string;
  /** The header exactly as the declaration writes it, quotes included. */
  readonly origin: string;
  /** Extra lines of the declaration, for `originIsForeign` and for refusals. */
  readonly extra?: string;
  /** The endpoint the conditions apply on. `me` unless a case is about another. */
  readonly endpoint?: string;
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

/** The declaration, with or without the conditions that ask the question. */
function configText(declared?: OriginCondition | readonly OriginCondition[]): string {
  const conditions = declared === undefined ? [] : Array.isArray(declared) ? declared : [declared];
  const contexts =
    conditions.length === 0
      ? ""
      : `\ncontexts:\n${conditions
          .map(
            (condition) =>
              `  - id: ${condition.id}
    description: ${condition.description}
    headers: { origin: ${condition.origin} }
${condition.extra ?? ""}    endpoints: [${condition.endpoint ?? "me"}]\n`,
          )
          .join("")}`;
  const contextRule = conditions
    .map(
      (condition) =>
        `    - { roles: [user], endpoints: [${condition.endpoint ?? "me"}], context: ${condition.id}, outcome: allowed }\n`,
    )
    .join("");
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
  readonly warnings: readonly string[];
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
    readonly match?: boolean;
    readonly findingKinds?: readonly string[];
  }[];
}

function flagsFor(config: string, endpoints: string, report: string, checks?: string): RunFlags {
  return {
    config,
    endpoints,
    report,
    identify: true,
    // The pace `FAST_STAND` gives a spawned binary (`tests/fixtures/local-stand.ts`),
    // as flags. Five requests a second is a pace and not only a ceiling
    // (ADR-0026), so each of these runs waited about 800 ms for a stub on loopback
    // that answers in under a millisecond, and this file was the longest in the
    // suite. Nothing here is about the pace (ADR-0072).
    rps: 200,
    concurrency: 8,
    ...(checks === undefined ? {} : { checks }),
  };
}

/** What a case changes about the run beyond the condition it declares. */
interface RunOptions {
  /** `--checks`, which narrows the run to the named checks. */
  readonly checks?: string;
  /** The endpoint list, `ENDPOINTS` unless a case needs another. */
  readonly endpoints?: string;
  /** A whole configuration, for the cases the origin conditions do not describe. */
  readonly config?: string;
}

async function runIt(
  condition?: OriginCondition | readonly OriginCondition[],
  options: RunOptions = {},
): Promise<{
  readonly code: number;
  readonly report: WrittenReport;
}> {
  const config = join(directory, "barbican.run.yaml");
  const endpoints = join(directory, "endpoints.yaml");
  const reportPath = join(directory, "run.json");
  await writeFile(config, options.config ?? configText(condition), "utf8");
  await writeFile(endpoints, options.endpoints ?? ENDPOINTS, "utf8");
  const code = await run(flagsFor(config, endpoints, reportPath, options.checks));
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

/**
 * A marker that was declared and never put to the platform (ADR-0078).
 *
 * The run used to come back clean. A marker is an explicit claim by the operator
 * that something will be checked, so it is the one declaration whose silent
 * non-execution has to be said. Measured by adversarial review, both ways in.
 */
describe("a foreign origin that nobody asked about", () => {
  it("is warned about when --checks leaves the check out", async () => {
    behaviour = "reflect";

    const { code, report } = await runIt(FOREIGN, { checks: "identical-response-across-tenants" });

    expect(report.warnings).toContain(WARNINGS.foreignOriginNotAsked);
    // The reflection was never looked for, so a clean exit is not an answer, and
    // the warning is what keeps it from reading as one.
    expect(corsFindings(report)).toEqual([]);
    expect(code).toBe(0);
  });

  it("is warned about when the marked context is on a write the run does not walk", async () => {
    behaviour = "reflect";

    const { report } = await runIt(
      { ...FOREIGN, endpoint: "write.me" },
      { endpoints: ENDPOINTS_WITH_A_WRITE },
    );

    expect(report.warnings).toContain(WARNINGS.foreignOriginNotAsked);
    expect(corsFindings(report)).toEqual([]);
  });

  it("is not warned about once the question was asked, whatever the answer", async () => {
    for (const platform of ["allowlist", "reflect"] as const) {
      behaviour = platform;

      const { report } = await runIt(FOREIGN);

      expect(report.warnings, platform).not.toContain(WARNINGS.foreignOriginNotAsked);
    }
  });

  it("is warned about when the marked context was not asked, though another context was", async () => {
    // The configuration the warning exists for: a partner's origin that runs
    // fine and a foreign one that is declared on a write nobody walks. A
    // condition that required every context to be marked would stay silent here,
    // and so would one that required all of them to be asked of.
    behaviour = "reflect";

    const { report } = await runIt([PARTNER, { ...FOREIGN, endpoint: "write.me" }], {
      endpoints: ENDPOINTS_WITH_A_WRITE,
    });

    expect(report.warnings).toContain(WARNINGS.foreignOriginNotAsked);
  });

  it("is not raised when one of two marked contexts was asked, and says so only in the coverage", async () => {
    // The accepted limit written into ADR-0078: the warning is all or nothing, and
    // the second context's silence is read from `coverage.byCheck`.
    behaviour = "allowlist";

    const { report } = await runIt(
      [FOREIGN, { ...FOREIGN, id: "foreign-on-write", endpoint: "write.me" }],
      { endpoints: ENDPOINTS_WITH_A_WRITE },
    );

    expect(report.warnings).not.toContain(WARNINGS.foreignOriginNotAsked);
    expect(corsCoverage(report, "me")?.counters.foreignOriginCellsAnswered).toBe(1);
    expect(corsCoverage(report, "write.me")).toBeUndefined();
  });

  it("is not raised for a run that marked nothing", async () => {
    // An origin condition with no marker and a check that never ran is not a
    // claim, and the warning is about claims.
    behaviour = "reflect";

    const { report } = await runIt(PARTNER, { checks: "identical-response-across-tenants" });

    expect(report.warnings).not.toContain(WARNINGS.foreignOriginNotAsked);
  });
});

/**
 * A header policy is not a verdict on who may reach a cell (found by the second
 * pre-release review).
 *
 * A finding narrows the cell it names, so that a leak found by body on a cell the
 * walk agreed with is not counted as agreed (ADR-0022). `permissive-cors` names a
 * cell too, only because a cell is where the header was seen. Measured before the
 * fix: a platform whose every cell agreed with the declared policy, with one
 * header finding, had its cells flipped to `match: false` and the evidence pack
 * said ASVS 8.1.1 and 8.2.1 were breached, "the platform and the declared policy
 * disagree", above "evidence rows: 0 recording a disagreement".
 */
describe("a cross-origin finding on a platform that agrees with its declared policy", () => {
  const WITH_AN_OBJECT = `${ENDPOINTS}  - id: order.read
    method: GET
    path: /v1/orders/{orderId}
`;

  const CONFIG_WITH_AN_OBJECT = () => `
target:
  label: cors run test stand
  baseUrl: http://127.0.0.1:${port}
  allowedHosts: [127.0.0.1]
tenants: [tenant-a]
accounts:
  - { id: alice, role: user, tenant: tenant-a, tokenEnv: CORS_RUN_TOKEN_ALICE, canary: me }
resources:
  - { id: order-1, tenant: tenant-a, params: { orderId: "O-1" } }
  - { id: order-2, tenant: tenant-a, params: { orderId: "O-2" } }
policy:
  fallback: denied
  rules:
    - { roles: [user], endpoints: [me, order.read], outcome: allowed }
`;

  it("leaves every cell as agreed, and the finding is still there", async () => {
    behaviour = "unasked-wildcard";

    const { report } = await runIt(undefined, {
      endpoints: WITH_AN_OBJECT,
      config: CONFIG_WITH_AN_OBJECT(),
    });

    expect(corsFindings(report).length).toBeGreaterThan(0);
    const cells = report.observations ?? [];
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      expect(cell.match, JSON.stringify(cell)).toBe(true);
      expect(cell).not.toHaveProperty("findingKinds");
    }
  });

  it("does not make the pack call an access-control clause breached", async () => {
    behaviour = "unasked-wildcard";
    const { report } = await runIt(undefined, {
      endpoints: WITH_AN_OBJECT,
      config: CONFIG_WITH_AN_OBJECT(),
    });
    const from = join(directory, "run.json");
    const json = join(directory, "pack.json");

    await pack(from, { out: join(directory, "pack.html"), json });

    const rows = (
      JSON.parse(await readFile(json, "utf8")) as {
        clauses: readonly { standard: string; clause: string; claim: string }[];
      }
    ).clauses;
    const claim = (standard: string, id: string) =>
      rows.find((row) => row.standard === standard && row.clause === id)?.claim;
    // The access-control clauses are what the walk says they are: upheld.
    expect(claim("OWASP-ASVS-5.0", "8.1.1")).toBe("upheld");
    expect(claim("OWASP-ASVS-5.0", "8.2.2")).toBe("upheld");
    // And the clause the finding is evidence about is the one that is breached.
    expect(claim("OWASP-API-2023", "API8")).toBe("breached");
    expect(report.findings.filter((finding) => finding.kind === "permissive-cors")).not.toEqual([]);
  });

  it("still carries the request that reproduces it, on an endpoint that takes an object", async () => {
    // The finding names no resource, and every cell of this endpoint has one. It
    // used to print with no request, status or headers, and nothing in it said
    // which address had carried the header.
    behaviour = "unasked-wildcard";

    const { report } = await runIt(undefined, {
      endpoints: WITH_AN_OBJECT,
      config: CONFIG_WITH_AN_OBJECT(),
    });

    const onTheObject = report.findings.find(
      (finding) => finding.kind === "permissive-cors" && finding.endpointId === "order.read",
    ) as unknown as
      | { request?: { url: string; as: string }; status?: number; headers?: Record<string, string> }
      | undefined;
    expect(onTheObject?.request?.url).toBe(`http://127.0.0.1:${port}/v1/orders/O-1`);
    expect(onTheObject?.request?.as).toBe("alice");
    expect(onTheObject?.status).toBe(200);
    expect(onTheObject?.headers?.["access-control-allow-origin"]).toBe("*");
  });
});

/**
 * A check that ran and was never asked, in the pack a person is handed.
 *
 * API8 is answered by this check alone, and until the check declared a reach the
 * pack read it as `answered-without-findings` on any run where it found nothing,
 * including a run in which no request carried an `Origin`. Now the pack tells the
 * two apart without a denominator: the check's own count of what it was put.
 */
describe("a check that was never asked, through the pack", () => {
  async function api8ClaimOf(): Promise<string | undefined> {
    const json = join(directory, "pack.json");
    await pack(join(directory, "run.json"), { out: join(directory, "pack.html"), json });
    const rows = (
      JSON.parse(await readFile(json, "utf8")) as {
        clauses: readonly {
          standard: string;
          clause: string;
          claim: string;
          checkReach?: readonly { checkId: string; counter: string; total: number }[];
        }[];
      }
    ).clauses;
    const found = rows.find((row) => row.standard === "OWASP-API-2023" && row.clause === "API8");
    reachOfApi8 = found?.checkReach;
    return found?.claim;
  }
  let reachOfApi8: readonly { checkId: string; counter: string; total: number }[] | undefined;

  it("reads API8 as inconclusive when no request carried an origin", async () => {
    behaviour = "none";

    const { report } = await runIt();

    expect(await api8ClaimOf()).toBe("inconclusive");
    expect(reachOfApi8).toEqual([
      { checkId: "permissive-cors", counter: "crossOriginCellsAnswered", total: 0 },
    ]);
    // And the check's own coverage says why: it has no row at all.
    expect(report.coverage.byCheck.filter((row) => row.checkId === "permissive-cors")).toEqual([]);
  });

  it("reads API8 as answered-without-findings once an origin was sent and refused", async () => {
    // The correct platform: it answers an origin it does not trust with no header
    // at all. The check was asked, and found nothing.
    behaviour = "none";

    const { report } = await runIt(PARTNER);

    expect(await api8ClaimOf()).toBe("answered-without-findings");
    expect(reachOfApi8?.[0]?.total).toBe(1);
    expect(corsCoverage(report, "me")?.counters).toMatchObject({ crossOriginCellsAnswered: 1 });
  });

  it("reads API8 as inconclusive when the only context sends no origin at all", async () => {
    // The overcount is the false "it was asked" this feature exists to prevent: a
    // context that declares a region and no origin walks cells, and none of them
    // invited a CORS answer. Counting every context (or only the first, or none of
    // them filtered) would flip this row.
    behaviour = "none";
    const config = configText()
      .replace(
        "policy:",
        `contexts:
  - id: region
    description: a request from another region
    headers: { x-region: eu }
    endpoints: [me]

policy:`,
      )
      .replace(
        "    - { roles: [user], endpoints: [me], outcome: allowed }\n",
        `    - { roles: [user], endpoints: [me], outcome: allowed }
    - { roles: [user], endpoints: [me], context: region, outcome: allowed }\n`,
      );

    const { report } = await runIt(undefined, { config });

    expect(report.coverage.byCheck.filter((row) => row.checkId === "permissive-cors")).toEqual([]);
    expect(await api8ClaimOf()).toBe("inconclusive");
  });

  it("counts only the context that sends an origin when another one does not", async () => {
    behaviour = "none";
    const config = configText(PARTNER)
      .replace(
        "policy:",
        `  - id: region
    description: a request from another region
    headers: { x-region: eu }
    endpoints: [me]

policy:`,
      )
      .replace(
        "    - { roles: [user], endpoints: [me], outcome: allowed }\n",
        `    - { roles: [user], endpoints: [me], outcome: allowed }
    - { roles: [user], endpoints: [me], context: region, outcome: allowed }\n`,
      );

    const { report } = await runIt(undefined, { config });

    // Two derived accounts walked `me`, and only the one that sent an origin counts.
    expect(corsCoverage(report, "me")?.counters).toMatchObject({ crossOriginCellsAnswered: 1 });
    expect(await api8ClaimOf()).toBe("answered-without-findings");
  });
});

/**
 * Four seams the verdict rests on, each held by a comment and by nothing else.
 *
 * The audit of 20 August 2026 took the protections one at a time, removed them,
 * and ran the suite. All four stayed green: the threshold that decides which
 * check findings fail a run, the second pass over the canaries, the recognition
 * of a terminal error arriving from a client other than this project's own, and
 * the CLI's refusal to walk a matrix behind a canary that did not pass. Every
 * one of them is written down — in `runVerdict`, in `src/cli.ts`, in
 * `terminalCause` — and a rule nothing measures is a rule the next edit deletes
 * for free.
 *
 * What makes each case a gate rather than a description is the route it takes.
 * Every one goes through the function that actually decides, from the inputs a
 * run really produces: `buildReport` rather than a hand-written `summary`, the
 * CLI rather than `runVerdict` on a literal, a stub deployment on the loopback
 * rather than a fake client that agrees with the runner. Where the existing
 * suite went the shorter way it is named below, because the short way is what
 * made these four invisible.
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCredentialProvider, DEFAULT_AUTH_SCHEME } from "../../src/adapters/credentials.js";
import type { HttpClient, HttpRequest, HttpResponse } from "../../src/adapters/ports.js";
import { RunBudgetExhaustedError } from "../../src/adapters/throttle.js";
import type {
  AccessObservation,
  Account,
  Endpoint,
  ExpectedAccessPolicy,
  Severity,
} from "../../src/core/index.js";
import { buildAccessMatrix, diffAccess, expandPolicy } from "../../src/core/index.js";
import { parseRunConfig } from "../../src/io/config.js";
import type { BuildReportOptions } from "../../src/report/build.js";
import { buildReport, exitCodeFor, runVerdict } from "../../src/report/build.js";
import { collectObservations } from "../../src/runner.js";

const CONFIG = parseRunConfig(`
target: { baseUrl: "https://a.test", allowedHosts: [a.test] }
accounts:
  - { id: alice, role: user, tenant: t-a, tokenEnv: A }
  - { id: carol, role: user, tenant: t-b, tokenEnv: C }
policy: { fallback: denied, rules: [] }
`);

const ACCOUNTS: readonly Account[] = [
  { id: "alice", roleId: "user", tenantId: "t-a" },
  { id: "carol", roleId: "user", tenantId: "t-b" },
];

const ORDERS: Endpoint = { id: "orders.list", method: "GET", path: "/v1/orders" };
const ADMIN: Endpoint = { id: "admin.users", method: "GET", path: "/v1/admin/users" };
const ENDPOINTS: readonly Endpoint[] = [ORDERS, ADMIN];

/** Everybody may read orders; nobody may read the admin list. */
const POLICY: ExpectedAccessPolicy = {
  fallback: "denied",
  rules: [{ roles: ["user"], endpoints: ["orders.list"], outcome: "allowed" }],
};

function seen(
  accountId: string,
  endpointId: string,
  status: number,
  outcome: AccessObservation["outcome"],
): AccessObservation {
  return { accountId, endpointId, status, headers: {}, outcome, durationMs: 1 };
}

/** A walk that matches the policy exactly: on its own this run exits 0. */
const AS_DECLARED: readonly AccessObservation[] = [
  seen("alice", "orders.list", 200, "allowed"),
  seen("carol", "orders.list", 200, "allowed"),
  seen("alice", "admin.users", 403, "denied"),
  seen("carol", "admin.users", 403, "denied"),
];

/**
 * The report a run of the above would produce, built by `buildReport` itself.
 *
 * The counting function is the thing under test, so nothing here may set
 * `summary.verdictInputs` — and that is precisely what `tests/report/exit-code.test.ts`
 * does. Its helper writes the field out by hand, which is the right shape for
 * asking "given these counts, what is the verdict" and cannot reach the question
 * "which findings become those counts". `verdictCountsOf` is never called there
 * at all.
 */
function reportOf(overrides: Partial<BuildReportOptions> = {}) {
  const matrix = buildAccessMatrix({
    endpoints: ENDPOINTS,
    accounts: ACCOUNTS,
    observations: AS_DECLARED,
  });
  const policy = expandPolicy(POLICY, ENDPOINTS);
  return buildReport({
    version: "test",
    config: CONFIG,
    endpoints: ENDPOINTS,
    observations: AS_DECLARED,
    skipped: [],
    failures: [],
    unauthenticated: [],
    canariesChecked: ACCOUNTS.length,
    canaries: ACCOUNTS.map((account) => ({
      accountId: account.id,
      endpointId: "orders.list",
      status: 200,
      authenticated: true,
    })),
    truncated: false,
    findings: diffAccess(matrix, policy),
    policy,
    startedAt: new Date(0),
    finishedAt: new Date(1),
    ...overrides,
  });
}

/** One check finding on a cell of the clean walk above, at the level asked for. */
function checkFinding(severity: Severity) {
  return {
    checkId: "identical-response-across-tenants",
    severity,
    title: `a disagreement reported at ${severity}`,
    endpointId: "orders.list",
    accountId: "alice",
    relatedAccountId: "carol",
    evidence: { bodyDigestsEqual: true },
  } as const;
}

describe("B-2 · the severity a check finding has to reach to fail a run", () => {
  /**
   * The threshold is "anything but `info`", and it used to be "high or
   * critical" — two thresholds for one principle, which is what ADR-0014 and
   * B-3 of the audit of 14 August settled. Narrowing it back to the old pair
   * broke nothing in the suite of 20 August: `tests/report/exit-code.test.ts`
   * supplies `summary.verdictInputs` from a literal, so `verdictCountsOf` never
   * runs there, and the one test that does go through `buildReport` —
   * `tests/report/verdict-seam.test.ts` — reports its finding at `high`, which
   * both thresholds accept.
   *
   * So the cases below are `low` and `medium` on purpose: they are the whole
   * width of the disagreement between the rule and the one it replaced, and a
   * gate placed anywhere else is a gate the same mutation walks past.
   */
  for (const severity of ["low", "medium"] as const) {
    it(`fails the run at ${severity}, the same as the matrix channel would`, () => {
      const report = reportOf({ checks: [checkFinding(severity)] });

      // Counted by the function under test, from the finding rather than from a
      // number handed in beside it.
      expect(report.summary.verdictInputs.failingCheckFindings).toBe(1);
      expect(exitCodeFor(report)).toBe(1);
      expect(runVerdict(report).reason).toContain("body");
    });
  }

  /**
   * The control, and the reason the two cases above are not a test that always
   * says 1: `info` is the level a check uses to note something without failing a
   * build, and it stays below the line. Without this an "always fail" rule would
   * satisfy the pair above just as well.
   */
  it("leaves the run at 0 for a finding reported at info", () => {
    const report = reportOf({ checks: [checkFinding("info")] });

    expect(report.summary.checkFindings).toBe(1);
    expect(report.summary.verdictInputs.failingCheckFindings).toBe(0);
    expect(exitCodeFor(report)).toBe(0);
  });

  /** And the walk on its own is clean, so the exit code above comes from the check. */
  it("exits 0 on the same walk with no check finding at all", () => {
    expect(exitCodeFor(reportOf())).toBe(0);
  });
});

/**
 * A client that stops the walk the way a foreign implementation of the port would.
 *
 * `RequestFailedError` in `src/adapters/http.ts` is this project's own wrapper,
 * and since the audit of 14 August that client rethrows a terminal error
 * **directly** rather than wrapping it. So the premise
 * `tests/runner-truncation.test.ts` states in its header — "everything that
 * leaves `createHttpClient` is wrapped in `RequestFailedError`" — stopped being
 * true of it, and the chain walk in `terminalCause` is left holding up nobody
 * but a client written by somebody else. `HttpClient` is a published port
 * (ADR-0003), a consumer's retry wrapper is the ordinary shape for one, and
 * `{ cause }` is how an error is wrapped in this language.
 */
function budgetExhaustedAfter(successes: number): HttpClient {
  let sent = 0;
  return {
    send(_request: HttpRequest): Promise<HttpResponse> {
      sent += 1;
      if (sent > successes) {
        // Wrapped, not thrown bare: bare is what the stock client produces, and
        // that path the suite already covers.
        return Promise.reject(
          new Error("the request failed after 3 attempts", {
            cause: new RunBudgetExhaustedError(successes),
          }),
        );
      }
      return Promise.resolve({ status: 200, headers: {} });
    },
  };
}

describe("B-6 · a terminal error arriving from another implementation of HttpClient", () => {
  const WALK_CONFIG = parseRunConfig(`
target: { baseUrl: "https://a.test", allowedHosts: [a.test] }
accounts: [{ id: alice, role: user, tenant: t-a, tokenEnv: A }]
policy: { fallback: allowed, rules: [] }
`);
  const WALK_ACCOUNTS: readonly Account[] = [{ id: "alice", roleId: "user", tenantId: "t-a" }];
  const WALK_ENDPOINTS: readonly Endpoint[] = Array.from({ length: 6 }, (_unused, index) => ({
    id: `e${index}`,
    method: "GET" as const,
    path: `/v1/e${index}`,
  }));
  const WALK_POLICY: ExpectedAccessPolicy = { fallback: "allowed", rules: [] };

  /**
   * Six cells, four of them answered, so the tail is a third of the matrix.
   *
   * Deliberately under the half at which `runVerdict` calls a report a
   * description of the network: with a larger tail the run reaches exit 2
   * through that branch whether or not the terminal error was ever recognised,
   * and the gate would pass over the very mutation it exists for.
   */
  async function walk() {
    return await collectObservations({
      baseUrl: "https://a.test",
      endpoints: WALK_ENDPOINTS,
      accounts: WALK_ACCOUNTS,
      credentials: createCredentialProvider(DEFAULT_AUTH_SCHEME, new Map([["alice", "tok"]])),
      client: budgetExhaustedAfter(4),
    });
  }

  it("cuts the walk short rather than carrying on to the end of the matrix", async () => {
    const result = await walk();

    expect(result.truncated).toBe(true);
    // The cell that met the ceiling, and no request after it. Reading only the
    // outermost error, the runner sees the wrapper's name, calls it an ordinary
    // failed request and goes on asking for every cell that is left.
    expect(result.failures).toHaveLength(1);
    expect(result.observations).toHaveLength(5);
  });

  /** And the verdict says the run cannot be concluded from, which is the point. */
  it("reaches exit 2, and for having been cut short", async () => {
    const result = await walk();
    const policy = expandPolicy(WALK_POLICY, WALK_ENDPOINTS);
    const report = buildReport({
      version: "test",
      config: WALK_CONFIG,
      endpoints: WALK_ENDPOINTS,
      probed: result.probed,
      observations: result.observations,
      skipped: result.skipped,
      failures: result.failures,
      unauthenticated: [],
      canariesChecked: 1,
      canaries: [{ accountId: "alice", endpointId: "e0", status: 200, authenticated: true }],
      truncated: result.truncated,
      findings: diffAccess(
        buildAccessMatrix({
          endpoints: result.probed,
          accounts: WALK_ACCOUNTS,
          observations: result.observations,
        }),
        policy,
      ),
      policy,
      startedAt: new Date(0),
      finishedAt: new Date(1),
    });

    expect(exitCodeFor(report)).toBe(2);
    expect(runVerdict(report).reason).toContain("cut short");
    // Not by the other road to 2. One cell in five failing to answer is under
    // the share at which a report is called a description of the network — and
    // were it not, this case would pass with the recognition removed.
    expect(runVerdict(report).reason).not.toContain("failed to answer");
  });
});

/**
 * A deployment that counts what was asked of it and can be told when to refuse.
 *
 * The count is the assertion in B-7: traffic against somebody else's platform is
 * the cost this project treats as expensive, and "the run stopped" is a claim
 * about requests not sent. Nothing but the wire can witness that.
 */
async function startCountingTarget(options: {
  /**
   * How many requests answer 200 before the deployment starts refusing.
   *
   * A count and not a set of paths, because both cases below are about *when* a
   * credential stops working rather than about which address is protected: zero
   * is a token that never worked, three is one that dies between the walk and
   * the canary that follows it.
   */
  readonly ok: number;
}) {
  const paths: string[] = [];
  let served = 0;
  const server = createServer((request, response) => {
    // The control request every canary makes since ADR-0040: the same endpoint
    // with no credentials at all. An endpoint worth naming as a canary refuses
    // it, and this stub is standing in for one — so the refusal is what a
    // healthy deployment does here, not an inconvenience of the fixture.
    //
    // It is not counted against `ok`, which counts how long the credential goes
    // on working, and it is not recorded in `paths`, which is asserted against
    // the size of the matrix.
    if (request.headers.authorization === undefined) {
      response.writeHead(401).end();
      return;
    }
    paths.push(request.url ?? "");
    served += 1;
    response.writeHead(served > options.ok ? 401 : 200).end();
  });
  await new Promise<void>((ready) => {
    server.listen(0, "127.0.0.1", ready);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the stub deployment did not report a port");
  }
  return {
    port: address.port,
    /** Every path asked for, in the order the deployment saw them. */
    get requests(): readonly string[] {
      return paths;
    },
    close: () =>
      new Promise<void>((done) => {
        server.close(() => done());
      }),
  };
}

interface CliResult {
  readonly stderr: string;
  readonly exitCode: number | undefined;
}

/**
 * Runs the CLI in this process, the way `tests/cli.test.ts` does.
 *
 * The entry point calls `parseAsync` at the top level, so importing it is a run
 * and `vi.resetModules()` is what makes a second import execute rather than
 * return the cached module. `process.exitCode` is saved and restored: the CLI
 * sets it, and vitest's own exit code is that same field.
 *
 * Both cases below go through this rather than calling `runVerdict` on a report.
 * They are about what the CLI does before and after the walk — a second pass
 * over the canaries, and a refusal to start one — and neither of those exists
 * anywhere a report can be handed to.
 */
async function runCli(...argv: readonly string[]): Promise<CliResult> {
  const savedArgv = process.argv;
  const savedExitCode = process.exitCode;
  const savedIsTty = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
  // Pinned off, so an assertion on a sentence is not comparing it against the
  // same sentence wrapped in escape codes when the suite is run on a terminal.
  Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });
  const stderr: string[] = [];
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  // The report goes to stdout when `--report` is absent; swallowed so it cannot
  // bury the test output.
  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

  process.argv = ["node", "barbican", ...argv];
  process.exitCode = undefined;
  try {
    vi.resetModules();
    await import("../../src/cli.js");
    return { stderr: stderr.join(""), exitCode: process.exitCode };
  } finally {
    process.argv = savedArgv;
    errSpy.mockRestore();
    outSpy.mockRestore();
    process.exitCode = savedExitCode;
    if (savedIsTty === undefined) {
      delete (process.stderr as { isTTY?: boolean }).isTTY;
    } else {
      Object.defineProperty(process.stderr, "isTTY", savedIsTty);
    }
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** The run's two files on disk, since the CLI takes paths and not documents. */
async function writeRun(config: string, endpoints: string) {
  const directory = await mkdtemp(join(tmpdir(), "barbican-verdict-seams-"));
  const configPath = join(directory, "run.yaml");
  const endpointsPath = join(directory, "endpoints.yaml");
  await writeFile(configPath, config, "utf8");
  await writeFile(endpointsPath, endpoints, "utf8");
  return { configPath, endpointsPath, reportPath: join(directory, "report.json") };
}

describe("B-7 · a canary that did not pass stops the run before the walk", () => {
  /**
   * Eight endpoints and two accounts, which is sixteen cells behind the canaries.
   *
   * The size is the whole point. With the refusal removed the run reaches the
   * same exit code 2 — `runVerdict` still finds no canary that passed — but it
   * gets there having walked the entire matrix and probed the canaries a second
   * time on top. That is the shape the audit of 20 August measured: the same
   * verdict by a route that spends every request the run had to spend. Nothing
   * in the suite looked at the wire, so the two routes were indistinguishable.
   */
  const ENDPOINT_LIST = `
endpoints:
${Array.from(
  { length: 8 },
  (_unused, index) => `  - { id: e${index}, method: GET, path: /v1/e${index} }`,
).join("\n")}
  - { id: me, method: GET, path: /v1/me }
`;

  function config(port: number): string {
    return `
target:
  label: verdict seams stand
  baseUrl: http://127.0.0.1:${port}
  allowedHosts: [127.0.0.1]

accounts:
  - { id: alice, role: user, tenant: tenant-a, tokenEnv: SEAM_TOKEN_ALICE, canary: me }
  - { id: carol, role: user, tenant: tenant-b, tokenEnv: SEAM_TOKEN_CAROL, canary: me }

policy:
  fallback: allowed
  rules: []

tenants: [tenant-a, tenant-b]
`;
  }

  it("sends the canaries and nothing else, and exits 2", async () => {
    // Every request refused, so both canaries fail on the first thing asked.
    const target = await startCountingTarget({ ok: 0 });
    const paths = await writeRun(config(target.port), ENDPOINT_LIST);
    process.env.SEAM_TOKEN_ALICE = "token-alice";
    process.env.SEAM_TOKEN_CAROL = "token-carol";

    try {
      const result = await runCli(
        "run",
        "--config",
        paths.configPath,
        "--endpoints",
        paths.endpointsPath,
        "--report",
        paths.reportPath,
        // The rate is incidental here — these tests count requests and read
        // verdicts — and at the conservative default of five a second a matrix
        // of eighteen cells takes longer than vitest waits. Left at the default,
        // this file failed on a loaded CI runner and passed on a quiet laptop,
        // which is the worst way for a test to be wrong.
        "--rps",
        "500",
      );

      // Two accounts, one canary each, and not one request more. The matrix
      // behind them is sixteen cells; the second pass over the canaries would
      // be two more.
      expect(target.requests).toEqual(["/v1/me", "/v1/me"]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("The canaries did not pass");
      // Named, both of them: an operator who cannot tell which account's token
      // is dead has to go looking for it by hand.
      expect(result.stderr).toContain("alice");
      expect(result.stderr).toContain("carol");
    } finally {
      delete process.env.SEAM_TOKEN_ALICE;
      delete process.env.SEAM_TOKEN_CAROL;
      await target.close();
    }
  });

  /**
   * The control: the same configuration against a deployment that answers.
   *
   * Without it, a CLI that refused to send anything at all would satisfy the
   * case above — the count would be right for the wrong reason.
   */
  it("walks the whole matrix when the canaries do pass", async () => {
    const target = await startCountingTarget({ ok: Number.MAX_SAFE_INTEGER });
    const paths = await writeRun(config(target.port), ENDPOINT_LIST);
    process.env.SEAM_TOKEN_ALICE = "token-alice";
    process.env.SEAM_TOKEN_CAROL = "token-carol";

    try {
      const result = await runCli(
        "run",
        "--config",
        paths.configPath,
        "--endpoints",
        paths.endpointsPath,
        "--report",
        paths.reportPath,
        // The rate is incidental here — these tests count requests and read
        // verdicts — and at the conservative default of five a second a matrix
        // of eighteen cells takes longer than vitest waits. Left at the default,
        // this file failed on a loaded CI runner and passed on a quiet laptop,
        // which is the worst way for a test to be wrong.
        "--rps",
        "500",
      );

      // Two canaries, eighteen cells, two canaries again.
      expect(target.requests).toHaveLength(22);
      expect(result.exitCode).toBe(0);
    } finally {
      delete process.env.SEAM_TOKEN_ALICE;
      delete process.env.SEAM_TOKEN_CAROL;
      await target.close();
    }
  });
});

describe("B-3 · a token that dies in the middle of the walk", () => {
  const ENDPOINT_LIST = `
endpoints:
  - { id: me, method: GET, path: /v1/me }
  - { id: orders, method: GET, path: /v1/orders }
`;

  function config(port: number): string {
    return `
target:
  label: verdict seams stand
  baseUrl: http://127.0.0.1:${port}
  allowedHosts: [127.0.0.1]

accounts:
  - { id: alice, role: user, tenant: tenant-a, tokenEnv: SEAM_TOKEN_ALICE, canary: me }

policy:
  fallback: allowed
  rules: []

tenants: [tenant-a]
`;
  }

  interface ReportFile {
    readonly staleCredentials: readonly string[];
    readonly verdict: { readonly code: number };
    readonly observations: readonly unknown[];
  }

  async function runAgainst(ok: number): Promise<CliResult & { readonly report: ReportFile }> {
    const target = await startCountingTarget({ ok });
    const paths = await writeRun(config(target.port), ENDPOINT_LIST);
    process.env.SEAM_TOKEN_ALICE = "token-alice";
    try {
      const result = await runCli(
        "run",
        "--config",
        paths.configPath,
        "--endpoints",
        paths.endpointsPath,
        "--report",
        paths.reportPath,
        // The rate is incidental here — these tests count requests and read
        // verdicts — and at the conservative default of five a second a matrix
        // of eighteen cells takes longer than vitest waits. Left at the default,
        // this file failed on a loaded CI runner and passed on a quiet laptop,
        // which is the worst way for a test to be wrong.
        "--rps",
        "500",
      );
      // Read through a message rather than through ENOENT. When this failed on
      // CI the whole diagnosis was "no such file", which says the run wrote no
      // report and nothing about why — and the why is on stderr, which the
      // helper already has in hand.
      let report: ReportFile;
      try {
        report = JSON.parse(await readFile(paths.reportPath, "utf8")) as ReportFile;
      } catch (cause) {
        throw new Error(
          `the run wrote no report (exit ${result.exitCode}). Its stderr was:\n${result.stderr}`,
          { cause },
        );
      }
      return { ...result, report };
    } finally {
      delete process.env.SEAM_TOKEN_ALICE;
      await target.close();
    }
  }

  /**
   * Three requests answered and the fourth refused, which is the whole matrix
   * plus its opening canary, and then the closing one.
   *
   * This is the only shape that catches a credential dying mid-walk, and the
   * reason is written on `RunReport.staleCredentials`: every cell probed after
   * the token died answers 401, a 401 reads as a denial, a denial agrees with a
   * policy of denial, and the cells land in `cellsMatched` as "tested and
   * agreed". `findUnauthenticated` cannot reach it by construction — it asks
   * whether an account was granted access **nowhere**, and here the first half
   * of the walk succeeded.
   *
   * The walk itself is deliberately clean: every cell this run did observe was
   * answered 200 under a policy that allows everything, so with the second pass
   * removed there is no finding, no warning that fails a build and no other
   * road to a non-zero code. That is what the audit of 20 August measured —
   * exit 0 over a run whose token was dead by the end of it.
   */
  it("is caught by the second pass, and the run exits 2 naming the account", async () => {
    const { exitCode, stderr, report } = await runAgainst(3);

    expect(report.staleCredentials).toEqual(["alice"]);
    expect(exitCode).toBe(2);
    expect(report.verdict.code).toBe(2);
    // The screen says which account and what it means, not only the number.
    expect(stderr).toContain("Credentials went stale during the run");
    expect(stderr).toContain("alice");
    // And the artifact says it too: the terminal is gone by the time anyone
    // reads the file.
    expect(stderr).toContain("Exit code 2");
  });

  /**
   * The control, and the reason the case above is not a test that always says 2.
   *
   * The same configuration, the same four requests, against a deployment whose
   * token never dies. If the second pass condemned every run it would satisfy
   * the case above just as well.
   */
  it("leaves a run whose token held to the end at 0", async () => {
    const { exitCode, report } = await runAgainst(Number.MAX_SAFE_INTEGER);

    expect(report.staleCredentials).toEqual([]);
    expect(report.observations).toHaveLength(2);
    expect(exitCode).toBe(0);
  });
});

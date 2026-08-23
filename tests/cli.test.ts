/**
 * What the operator's screen says, proved by running the command.
 *
 * `src/cli.ts` is excluded from the coverage thresholds on the grounds that it is
 * argument parsing and printing, checked by running the built binary. That leaves
 * the two things a human actually receives — the summary and the error messages —
 * with nothing holding them in place, and both defects tested here were of exactly
 * that shape: a severity level the report counted and the screen never named, and
 * a filesystem error that named none of the four paths a run takes.
 *
 * The command is driven by importing the entry point with `process.argv` set, not
 * by spawning a build: the module runs `parseAsync` at the top level, so an import
 * is a run. `vi.resetModules()` between cases is what makes the second import
 * execute rather than return the cached module, and `process.exitCode` is put back
 * afterwards — the CLI sets it, and vitest's own exit code is the same field.
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Severity } from "../src/core/index.js";
import { checkContentDigest, MAX_ROWS_PER_DEFECT, WARNINGS } from "../src/report/build.js";

/** Every level of the type, so that a level added later is not left off the screen. */
const SEVERITIES: readonly Severity[] = ["info", "low", "medium", "high", "critical"];

interface RunResult {
  readonly stderr: string;
  readonly stdout: string;
  readonly exitCode: number | undefined;
}

/**
 * Runs the CLI in this process and collects what it wrote.
 *
 * Both streams are captured rather than only stderr: the report goes to stdout
 * when `--report` is absent, and letting it through would bury the test output.
 */
async function runCli(...argv: readonly string[]): Promise<RunResult> {
  const savedArgv = process.argv;
  const savedExitCode = process.exitCode;
  const savedIsTty = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
  // The CLI colours its output only on a TTY, and vitest may be run on one. A
  // test that asserts a line is *exactly* a sentence would then be comparing it
  // against the sentence wrapped in escape codes, and would pass or fail by how
  // the suite was invoked. Pinned rather than stripped afterwards: the plain
  // branch is what a redirected run gets, and that is the output worth asserting
  // on.
  Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });
  const stderr: string[] = [];
  const stdout: string[] = [];
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });

  process.argv = ["node", "barbican", ...argv];
  process.exitCode = undefined;
  try {
    vi.resetModules();
    await import("../src/cli.js");
    return { stderr: stderr.join(""), stdout: stdout.join(""), exitCode: process.exitCode };
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

/**
 * A deployment with one deliberate defect: the admin endpoint answers everyone.
 *
 * Kept as small as it can be while still producing a finding — the summary line
 * under test is printed only when there is something to summarize.
 */
async function startTarget() {
  const server = createServer((request, response) => {
    const token = (request.headers.authorization ?? "").replace("Bearer ", "");
    const url = request.url ?? "";
    if (url === "/v1/me") {
      response.writeHead(token === "token-alice" ? 200 : 401).end();
      return;
    }
    // The defect: no role check at all.
    response.writeHead(200).end();
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
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      }),
  };
}

const ENDPOINTS = `
endpoints:
  - id: me
    method: GET
    path: /v1/me
  - id: admin.accounts
    method: GET
    path: /v1/admin/accounts
`;

/** The same list plus an endpoint that takes a resource, for the cases needing many cells. */
const ENDPOINTS_WITH_ITEMS = `
endpoints:
  - id: me
    method: GET
    path: /v1/me
  - id: items.get
    method: GET
    path: /v1/items/{itemId}
`;

/**
 * What to leave out of the configuration, for the warnings that fire on absence.
 *
 * Everything defaults to the complete configuration the first two tests use, so
 * a case names only the thing it is about.
 */
interface ConfigOptions {
  /** `target.label`, whose absence is `WARNINGS.unnamedTarget`. */
  readonly label?: boolean;
  /** The account's canary, whose absence is `WARNINGS.noCanary`. */
  readonly canary?: boolean;
  /** How many resources to declare, all of one tenant and one endpoint. */
  readonly resources?: number;
  /**
   * Whether the account presents credentials at all.
   *
   * `false` is an anonymous run — "check that nobody at all can get in here" —
   * which has nothing to authenticate and therefore owes no canary.
   */
  readonly credentials?: boolean;
}

function configFor(port: number, options: ConfigOptions = {}): string {
  const { label = true, canary = true, resources = 0, credentials = true } = options;
  // One tenant and no owner on any of them, so every cell of `items.get` gets the
  // same relation and therefore the same defect signature: the cap is per defect,
  // and fifty-one resources spread over several signatures would not reach it.
  const resourceLines = Array.from(
    { length: resources },
    (_unused, index) =>
      `  - { id: item-${index + 1}, tenant: tenant-a, params: { itemId: "I-${index + 1}" } }`,
  );
  return `
target:
${label ? "  label: cli test stand\n" : ""}  baseUrl: http://127.0.0.1:${port}
  allowedHosts: [127.0.0.1]

accounts:
  - { id: alice, role: user, tenant: tenant-a${
    credentials ? `, tokenEnv: CLI_TEST_TOKEN_ALICE${canary ? ", canary: me" : ""}` : ""
  } }

policy:
  fallback: denied
  rules:
    - { roles: [user], endpoints: [me], outcome: allowed }

tenants: [tenant-a]
${resources === 0 ? "" : `\nresources:\n${resourceLines.join("\n")}\n`}`;
}

interface ReportFile {
  /** The identifier the run put on the wire, and the artifact is filed under. */
  readonly runId: string;
  /** The report's fingerprint of itself — recomputed off the disk, not off an object. */
  readonly contentDigest: string;
  readonly warnings: readonly string[];
  readonly summary: { readonly findings: number };
  readonly coverage: {
    readonly resourcesNotFound: readonly string[];
    readonly endpointsTotal: number;
    readonly endpointsProbed: number;
    readonly notProbed: Readonly<Record<string, number>>;
  };
}

/**
 * A deployment where the declared objects are simply not there.
 *
 * `/v1/me` answers the token and everything else is 404. Every cell over a
 * resource then agrees with a policy of denial — a 404 satisfies a denial — while
 * having settled nothing, which is the run the green headline used to clear.
 */
async function startNotFoundTarget() {
  const server = createServer((request, response) => {
    const token = (request.headers.authorization ?? "").replace("Bearer ", "");
    if ((request.url ?? "") === "/v1/me") {
      response.writeHead(token === "token-alice" ? 200 : 401).end();
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
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      }),
  };
}

/**
 * One run against the plain stand, with the report read back off the disk.
 *
 * The file and not stdout: what these tests compare is the two channels a human
 * receives, and reading the artifact is how the file's half is obtained.
 */
async function runAgainstStand(options: {
  readonly config: (port: number) => string;
  readonly endpoints: string;
  readonly flags?: readonly string[];
  /** A deployment other than the plain one, for the cases that need it. */
  readonly target?: () => Promise<{ port: number; close: () => Promise<void> }>;
  /**
   * `false` leaves `--report` off, and the document is taken from stdout.
   *
   * The other channel the same report goes out through, and it is a channel and
   * not a formatting choice: a pipeline that never names a path still receives
   * an artifact, and whatever the file is answerable for that document is
   * answerable for too.
   */
  readonly toFile?: boolean;
}): Promise<RunResult & { readonly report: ReportFile; readonly document: string }> {
  const target = await (options.target ?? startTarget)();
  const directory = await mkdtemp(join(tmpdir(), "barbican-cli-"));
  const configPath = join(directory, "run.yaml");
  const endpointsPath = join(directory, "endpoints.yaml");
  const reportPath = join(directory, "report.json");
  await writeFile(configPath, options.config(target.port), "utf8");
  await writeFile(endpointsPath, options.endpoints, "utf8");
  process.env.CLI_TEST_TOKEN_ALICE = "token-alice";

  try {
    const result = await runCli(
      "run",
      "--config",
      configPath,
      "--endpoints",
      endpointsPath,
      ...(options.toFile === false ? [] : ["--report", reportPath]),
      ...(options.flags ?? []),
    );
    const document = options.toFile === false ? result.stdout : await readFile(reportPath, "utf8");
    const report = JSON.parse(document) as ReportFile;
    return { ...result, report, document };
  } finally {
    delete process.env.CLI_TEST_TOKEN_ALICE;
    await target.close();
  }
}

describe("the severity summary on the screen", () => {
  /**
   * B-16 of the audit of 14 August 2026.
   *
   * `Severity` has five levels and both summary lines spelled out four of them by
   * hand. `info` — the level a registry check may report, and the one the verdict
   * deliberately does not fail a run on — was counted in `summary.bySeverity` and
   * named nowhere on screen. An operator reading the terminal could not tell that
   * such a finding existed at all.
   *
   * The run below produces a `high` finding, not an `info` one: no check shipped
   * with the tool reports `info`, and inventing one here would test the fixture
   * rather than the summary. What the assertion holds is the property that was
   * missing — that the line is built from the whole set of levels rather than
   * from a list written beside it — and it fails the moment any level is dropped.
   */
  it("names every severity level, info included", async () => {
    const target = await startTarget();
    const directory = await mkdtemp(join(tmpdir(), "barbican-cli-"));
    const configPath = join(directory, "run.yaml");
    const endpointsPath = join(directory, "endpoints.yaml");
    const reportPath = join(directory, "report.json");
    await writeFile(configPath, configFor(target.port), "utf8");
    await writeFile(endpointsPath, ENDPOINTS, "utf8");
    process.env.CLI_TEST_TOKEN_ALICE = "token-alice";

    try {
      const result = await runCli(
        "run",
        "--config",
        configPath,
        "--endpoints",
        endpointsPath,
        "--report",
        reportPath,
      );

      const rows = result.stderr.split("\n").find((line) => line.startsWith("Rows by severity:"));
      const defects = result.stderr
        .split("\n")
        .find((line) => line.startsWith("Defects by severity:"));

      // Without a findings line there is nothing to assert about, and the test
      // would pass on a run that never reached the summary.
      expect(rows).toBeDefined();
      expect(defects).toBeDefined();
      for (const severity of SEVERITIES) {
        expect(rows).toContain(severity);
        expect(defects).toContain(severity);
      }
    } finally {
      delete process.env.CLI_TEST_TOKEN_ALICE;
      await target.close();
    }
  });
});

describe("a path on the command line that cannot be read", () => {
  /**
   * G-10 of the audit of 14 August 2026.
   *
   * `EISDIR: illegal operation on a directory, read` names neither the file nor
   * the flag, and a run takes up to four paths. The operator is told that one of
   * them is wrong and left to work out which.
   */
  it("names the flag and the path when --config points at a directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "barbican-cli-"));

    const result = await runCli("run", "--config", directory, "--endpoints", directory);

    expect(result.stderr).toContain("--config");
    expect(result.stderr).toContain(directory);
    expect(result.exitCode).toBe(2);
  });

  /**
   * The endpoint source, which is the flag the reader is least likely to suspect:
   * the configuration parsed, so the run looks past the point where a path was
   * wrong.
   */
  it("names --endpoints rather than the configuration when the source is a directory", async () => {
    const target = await startTarget();
    const directory = await mkdtemp(join(tmpdir(), "barbican-cli-"));
    const configPath = join(directory, "run.yaml");
    await writeFile(configPath, configFor(target.port), "utf8");

    try {
      const result = await runCli("run", "--config", configPath, "--endpoints", directory);

      expect(result.stderr).toContain("--endpoints");
      expect(result.stderr).toContain(directory);
      expect(result.exitCode).toBe(2);
    } finally {
      await target.close();
    }
  });
});

/**
 * A run that makes one warning fire, and why it does.
 *
 * Five fixtures rather than one, because the five warnings answer to five
 * different things and a run cannot be in all five states at once.
 */
interface WarningCase {
  /** What in this configuration produces the warning. */
  readonly why: string;
  readonly config: (port: number) => string;
  readonly endpoints: string;
  readonly flags?: readonly string[];
}

/**
 * A run for every key of `WARNINGS`.
 *
 * A `Record` over the keys and not a list of cases, for the reason `SEVERITIES`
 * above is exhaustive: a warning added to the report layer with no run to reach
 * it here does not compile. That is the half of the guard the drift needed —
 * `findingsCapped` was in the report from the day the cap was added and reached
 * no screen at any point, and no test noticed because no test was looking at all
 * four.
 */
const WARNING_CASES: Readonly<Record<keyof typeof WARNINGS, WarningCase>> = {
  unnamedTarget: {
    why: "the configuration declares no target.label",
    config: (port) => configFor(port, { label: false }),
    endpoints: ENDPOINTS,
  },
  noCanary: {
    why: "the account has credentials and no canary to prove they work",
    config: (port) => configFor(port, { canary: false }),
    endpoints: ENDPOINTS,
  },
  nothingRefused: {
    why: "the stand answers 200 to everything, so no cell was ever refused",
    config: (port) => configFor(port),
    endpoints: ENDPOINTS,
  },
  endpointsNotProbed: {
    why: "an endpoint takes a path parameter and no resource declares a value for it",
    // The same endpoint list `findingsCapped` uses and none of its resources:
    // `items.get` is then skipped, which is the ordinary shape of this defect —
    // the operator declared the endpoints and not the objects, and the half of
    // the surface addressed by identifier goes unasked.
    config: (port) => configFor(port),
    endpoints: ENDPOINTS_WITH_ITEMS,
  },
  findingsCapped: {
    why: "one defect over MAX_ROWS_PER_DEFECT + 1 resources, so a row is dropped",
    config: (port) => configFor(port, { resources: MAX_ROWS_PER_DEFECT + 1 }),
    endpoints: ENDPOINTS_WITH_ITEMS,
    // Fifty-two cells at the conservative default of five a second is ten seconds
    // of waiting for a local stand to answer itself.
    flags: ["--rps", "200", "--concurrency", "8"],
  },
};

describe("the warnings on the screen and the warnings in the file", () => {
  /**
   * The adversarial review of 18 August 2026.
   *
   * `Report.warnings` was documented as "the same ones the console shows, from
   * the same constants", and `WARNINGS` did not occur in `src/cli.ts` at all: the
   * CLI wrote its own copies. Two had already drifted — the file said
   * "Authentication is unverified: ... so nothing confirms the accounts were
   * authenticated at all", the screen said "... If the tokens do not work, the
   * run will report 'no escalations found' having tested nothing", about the same
   * run — and `findingsCapped` was printed nowhere, so a run whose evidence rows
   * were dropped said so only in the file while the terminal went on printing the
   * uncapped row count.
   *
   * Two assertions, and the second is the property. The first only proves the
   * fixture reaches the warning at all; without it a case that stopped firing
   * would leave the second one asserting over an empty list and passing.
   */
  for (const key of Object.keys(WARNING_CASES) as readonly (keyof typeof WARNINGS)[]) {
    const scenario = WARNING_CASES[key];
    it(`says ${key} on the screen in the words the report uses (${scenario.why})`, async () => {
      const { stderr, report } = await runAgainstStand(scenario);

      expect(report.warnings).toContain(WARNINGS[key]);
      for (const warning of report.warnings) {
        expect(stderr).toContain(warning);
      }
      // And nothing the other way round. The fix proves the file's warnings all
      // reach the screen; a warning the screen adds on its own is the same
      // disagreement, told by the half that leaves no artifact behind — and the
      // reader comparing a ticket against the terminal it came from has no way to
      // tell which of the two was wrong.
      for (const other of Object.keys(WARNINGS) as readonly (keyof typeof WARNINGS)[]) {
        if (stderr.includes(WARNINGS[other])) {
          expect(report.warnings).toContain(WARNINGS[other]);
        }
      }
    });
  }

  /**
   * The one run on which the screen warned and the file did not.
   *
   * An anonymous run has nothing to authenticate: `warningsFor` asks for an
   * account that is not anonymous before it warns about canaries, and
   * `runVerdict` excludes such a run from the rule that makes a missing canary
   * exit 2. The screen asked only whether any canary had been probed, so it
   * printed the warning — and the warning ends "which is why a run without a
   * canary ends with exit code 2", which is untrue of this run.
   *
   * Kept as a case of its own because the loop above cannot reach it: every
   * fixture there declares credentials, so the two predicates agree on all four
   * and a screen that warns unconditionally passes them all.
   */
  it("says nothing about canaries on a run that has nothing to authenticate", async () => {
    const { stderr, report, exitCode } = await runAgainstStand({
      config: (port) => configFor(port, { credentials: false }),
      endpoints: ENDPOINTS,
    });

    expect(report.warnings).not.toContain(WARNINGS.noCanary);
    expect(stderr).not.toContain(WARNINGS.noCanary);
    // The exit code is not the assertion. This run does end with 2, on the
    // separate rule for an account that opened nothing it was declared able to
    // open — the stand answers 401 to a request with no token, and the policy
    // declares `me` allowed. What must not be there is the canary's reason, which
    // is the rule `runVerdict` excludes an anonymous run from.
    expect(exitCode).toBe(2);
    expect(stderr).not.toContain("no canary was checked");
    // And it is a real run rather than a refusal before the first request: the
    // whole matrix was walked.
    expect(stderr).toContain("Cells probed: 2");
  });
});

/**
 * A deployment whose one defect is invisible to the status code.
 *
 * Two tenants, both authenticated, both allowed exactly what the policy declares
 * — and `/v1/orders` answering the same list to each. There is no privilege
 * escalation here to find: every status agrees with the policy, and the only
 * disagreement is in a body the tool reduces to a digest. That is the shape of
 * run the green headline used to be printed on.
 *
 * With `leak: false` the list carries the tenant and the digests differ: the same
 * platform with the defect taken out, and the run the headline has to keep saying
 * plainly — a fix that hedged every run would be the same defect pointing the
 * other way.
 */
async function startTenantTarget(options: { readonly leak: boolean }) {
  const tenantOf = new Map([
    ["token-alice", "tenant-a"],
    ["token-carol", "tenant-b"],
  ]);
  const server = createServer((request, response) => {
    const token = (request.headers.authorization ?? "").replace("Bearer ", "");
    const tenant = tenantOf.get(token);
    const url = request.url ?? "";
    if (tenant === undefined) {
      response.writeHead(401).end();
      return;
    }
    if (url === "/v1/me") {
      response.writeHead(200, { "content-type": "application/json" }).end(`{"me":"${tenant}"}`);
      return;
    }
    if (url === "/v1/orders") {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(options.leak ? '{"orders":[{"id":"1"}]}' : `{"orders":[{"id":"${tenant}-1"}]}`);
      return;
    }
    // Everything else is properly closed. Without a single refusal the run would
    // also warn that nothing on this platform is protected, which is a different
    // line about a different defect.
    response.writeHead(403).end();
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
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      }),
  };
}

const TENANT_ENDPOINTS = `
endpoints:
  - id: me
    method: GET
    path: /v1/me
  - id: orders.list
    method: GET
    path: /v1/orders
  - id: admin.accounts
    method: GET
    path: /v1/admin/accounts
`;

function tenantConfigFor(port: number, canary = true): string {
  const mark = canary ? ", canary: me" : "";
  return `
target:
  label: cli test stand
  baseUrl: http://127.0.0.1:${port}
  allowedHosts: [127.0.0.1]

accounts:
  - { id: alice-a, role: user, tenant: tenant-a, tokenEnv: CLI_TEST_TOKEN_ALICE${mark} }
  - { id: carol-b, role: user, tenant: tenant-b, tokenEnv: CLI_TEST_TOKEN_CAROL${mark} }

policy:
  fallback: denied
  rules:
    - { roles: [user], endpoints: [me, orders.list], outcome: allowed }

tenants: [tenant-a, tenant-b]

bodySignals:
  responseMustDifferByTenant: [orders.list]
`;
}

async function runAgainstTenantStand(options: {
  readonly leak: boolean;
  readonly canary?: boolean;
}): Promise<RunResult & { readonly report: ReportFile }> {
  const target = await startTenantTarget({ leak: options.leak });
  const directory = await mkdtemp(join(tmpdir(), "barbican-cli-"));
  const configPath = join(directory, "run.yaml");
  const endpointsPath = join(directory, "endpoints.yaml");
  const reportPath = join(directory, "report.json");
  await writeFile(configPath, tenantConfigFor(target.port, options.canary ?? true), "utf8");
  await writeFile(endpointsPath, TENANT_ENDPOINTS, "utf8");
  process.env.CLI_TEST_TOKEN_ALICE = "token-alice";
  process.env.CLI_TEST_TOKEN_CAROL = "token-carol";

  try {
    const result = await runCli(
      "run",
      "--config",
      configPath,
      "--endpoints",
      endpointsPath,
      "--report",
      reportPath,
      "--rps",
      "200",
      "--concurrency",
      "8",
    );
    const report = JSON.parse(await readFile(reportPath, "utf8")) as ReportFile;
    return { ...result, report };
  } finally {
    delete process.env.CLI_TEST_TOKEN_ALICE;
    delete process.env.CLI_TEST_TOKEN_CAROL;
    await target.close();
  }
}

/**
 * The sentence under test, exactly as a clean run is entitled to print it.
 *
 * Compared with `toBe` and not `toContain` in both directions: the defect was
 * that this claim stood alone and unqualified where it should not have, and the
 * cure would be worthless if it were allowed to stand alone anyway with a caveat
 * appended somewhere else on the screen.
 */
const NO_ESCALATION = "No privilege escalation found";

function headlineOf(stderr: string): string | undefined {
  return stderr.split("\n").find((line) => line.startsWith(NO_ESCALATION));
}

describe("the headline of the screen", () => {
  /**
   * The adversarial review of 18 August 2026.
   *
   * Against the polygon with `POLYGON_DEFECT_LIST_NO_FILTER=1` the screen printed
   * "No privilege escalation found" in green and, four lines below it, "Of those,
   * found by body rather than status: 12" — a sentence referring to the ones the
   * green line had just called absent. The line was literally true, because
   * `summary.byKind["privilege-escalation"]` counts matrix kinds only, and it was
   * the headline of a run whose verdict was exit code 1.
   */
  it("does not stand alone on a run whose findings came by the body", async () => {
    const { stderr, report, exitCode } = await runAgainstTenantStand({ leak: true });

    // The fixture really is the case under test: findings, and none of them an
    // escalation. Without this the assertions below would hold on a clean run.
    expect(report.summary.findings).toBeGreaterThan(0);
    expect(stderr).toContain("Of those, found by body rather than status:");
    expect(exitCode).toBe(1);

    const headline = headlineOf(stderr);
    expect(headline).toBeDefined();
    expect(headline).not.toBe(NO_ESCALATION);
    expect(headline).toContain(String(report.summary.findings));
  });

  /**
   * The other direction, and the reason the fix is a condition rather than a
   * caveat glued on unconditionally: a run that genuinely found nothing must say
   * so without hedging, or the line stops meaning anything and the next reader
   * learns to skip it.
   */
  it("stands alone, and unqualified, on a run that found nothing and proved it", async () => {
    const { stderr, report, exitCode } = await runAgainstTenantStand({ leak: false });

    expect(report.summary.findings).toBe(0);
    expect(exitCode).toBe(0);
    expect(headlineOf(stderr)).toBe(NO_ESCALATION);
  });

  /**
   * The state the first fix missed: nothing found, verdict 0, and nothing tested.
   *
   * Adversarial review of 19 August 2026. Every declared resource answers 404 to
   * everybody, so the whole isolation half of the matrix is cells that agree
   * because there was nothing there — and the run still came out with the bare
   * green sentence, while the report itself carried `nothingRefused`, the warning
   * this screen paints red and calls a reason to doubt every finding on it.
   *
   * The counters were the whole condition and they answer a different question:
   * they say nothing was found, not that anything was looked at.
   */
  it("does not stand alone on a run whose resources answered 404 to everyone", async () => {
    const { stderr, report, exitCode } = await runAgainstStand({
      config: (port) => configFor(port, { resources: 2 }),
      endpoints: ENDPOINTS_WITH_ITEMS,
      target: startNotFoundTarget,
    });

    // The fixture really is the case: nothing found, a clean verdict, and cells
    // that settled nothing.
    expect(report.summary.findings).toBe(0);
    expect(exitCode).toBe(0);
    expect(report.coverage.resourcesNotFound.length).toBeGreaterThan(0);

    expect(headlineOf(stderr)).not.toBe(NO_ESCALATION);
  });

  /**
   * The state both earlier fixes still cleared: nothing found, verdict 0, and
   * most of the surface never asked.
   *
   * The audit of 21 August 2026 (B-4). Eleven endpoints, nine of them templated
   * with no `resources` declared, so the run probed two — and printed the bare
   * green sentence, with `warnings: []` in the file beside it. Neither of the
   * conditions this line already had could see it: no request went to those nine,
   * so they left no finding to be counted and nothing in `resourcesNotFound`,
   * which is about objects that were asked for and were not there.
   *
   * The half that goes missing is the object half — the endpoints addressed by
   * identifier — which is where BOLA and IDOR live, and it goes missing on the
   * most ordinary mistake there is: declaring the endpoints and forgetting the
   * resources, or misspelling a `params` key.
   */
  it("does not stand alone on a run that did not reach every endpoint", async () => {
    const { stderr, report, exitCode } = await runAgainstStand({
      config: (port) => configFor(port),
      endpoints: ENDPOINTS_WITH_ITEMS,
    });

    // The fixture really is the case: a clean verdict over a partial walk.
    expect(report.summary.findings).toBe(0);
    expect(exitCode).toBe(0);
    expect(report.coverage.endpointsProbed).toBeLessThan(report.coverage.endpointsTotal);
    // And not the reservation the previous fix added: every resource that was
    // asked for answered, because none was declared to ask about.
    expect(report.coverage.resourcesNotFound).toEqual([]);

    expect(headlineOf(stderr)).not.toBe(NO_ESCALATION);
  });

  /**
   * The third state, which is neither: nothing was found and nothing was proved.
   * Without a canary the run walks the whole matrix, confirms no authentication
   * and exits 2 — and the headline used to be green on it too.
   */
  it("does not stand alone on a run that found nothing and proved nothing", async () => {
    const { stderr, report, exitCode } = await runAgainstTenantStand({
      leak: false,
      canary: false,
    });

    expect(report.summary.findings).toBe(0);
    expect(exitCode).toBe(2);

    const headline = headlineOf(stderr);
    expect(headline).toBeDefined();
    expect(headline).not.toBe(NO_ESCALATION);
    expect(headline).toContain("exit code 2");
  });
});

/**
 * M-6 and M-7 · what the run says about itself, to the platform and to the operator.
 *
 * Both findings are about a default nobody chose. The wire carried
 * `user-agent: node`, so the owner who signed the permission had no way to pick
 * the run out of their own logs; and the report goes to **stdout** when
 * `--report` is absent, which in the ordinary CI invocation is the build log —
 * while the same document written to a path is created `0600` with a comment
 * beside it explaining that it is a map of the holes in someone else's
 * authorization.
 *
 * `tests/invariants/transport.test.ts` holds the header at the client. What is
 * held here is the pair of defaults and the tie between them: the value on the
 * wire has to be the `runId` of the artifact, or naming the run buys the owner
 * nothing they could act on.
 */
describe("what a run says about itself", () => {
  /** The plain stand, plus a note of who each request claimed to be. */
  async function startListeningTarget() {
    const agents: (string | undefined)[] = [];
    const server = createServer((request, response) => {
      agents.push(request.headers["user-agent"]);
      const token = (request.headers.authorization ?? "").replace("Bearer ", "");
      if ((request.url ?? "") === "/v1/me") {
        response.writeHead(token === "token-alice" ? 200 : 401).end();
        return;
      }
      response.writeHead(200).end();
    });
    await new Promise<void>((settle) => {
      server.listen(0, "127.0.0.1", settle);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("could not start the deployment");
    }
    return {
      agents,
      port: address.port,
      close: () =>
        new Promise<void>((settle, fail) => {
          server.close((error) => (error === undefined ? settle() : fail(error)));
        }),
    };
  }

  /**
   * One run, with the report on disk or on stdout as the case asks.
   *
   * `runAgainstStand` above always passes `--report`, which is the one thing
   * half of these cases are about.
   */
  async function runListened(options: {
    readonly flags?: readonly string[];
    /** `false` leaves `--report` off, which is the default this is testing. */
    readonly toFile?: boolean;
  }) {
    const target = await startListeningTarget();
    const directory = await mkdtemp(join(tmpdir(), "barbican-identify-"));
    const configPath = join(directory, "run.yaml");
    const endpointsPath = join(directory, "endpoints.yaml");
    const reportPath = join(directory, "report.json");
    await writeFile(configPath, configFor(target.port), "utf8");
    await writeFile(endpointsPath, ENDPOINTS, "utf8");
    process.env.CLI_TEST_TOKEN_ALICE = "token-alice";
    try {
      const result = await runCli(
        "run",
        "--config",
        configPath,
        "--endpoints",
        endpointsPath,
        ...(options.toFile === false ? [] : ["--report", reportPath]),
        ...(options.flags ?? []),
      );
      const document =
        options.toFile === false ? result.stdout : await readFile(reportPath, "utf8");
      const report = (document.trim() === "" ? {} : JSON.parse(document)) as {
        readonly runId?: string;
      };
      return { ...result, report, agents: target.agents };
    } finally {
      delete process.env.CLI_TEST_TOKEN_ALICE;
      await target.close();
    }
  }

  it("names itself to the platform, with the identifier the report is filed under", async () => {
    const { report, agents } = await runListened({});

    expect(report.runId).toBeDefined();
    // Every request of the run, canaries included: the first thing the platform
    // sees is a canary, and an unmarked probe followed by marked traffic is a
    // log the owner still cannot read straight.
    expect(agents.length).toBeGreaterThan(2);
    for (const agent of agents) {
      expect(agent).toContain("barbican/");
      // The tie that makes the marking worth anything. Two different identifiers
      // — one on the wire, one in the file — would let the owner filter the
      // traffic and still not know which report it produced.
      expect(agent).toContain(`run=${report.runId}`);
    }
  });

  it("stops naming itself when the operator asks it not to", async () => {
    const { agents, exitCode } = await runListened({ flags: ["--no-identify"] });

    expect(agents.length).toBeGreaterThan(2);
    // node's own default, which is what every run of this tool sent until now.
    expect(agents).toEqual(agents.map(() => "node"));
    // And the run itself is unaffected: this is a decision about what the
    // platform is told, not about what is tested.
    expect(exitCode).toBe(1);
  });

  it("says on the screen which of the two it did", async () => {
    const named = await runListened({});
    const silent = await runListened({ flags: ["--no-identify"] });

    // The report has no field for this, so the operator's own transcript is the
    // only record of whether the run announced itself.
    expect(named.stderr).toContain("barbican/");
    expect(silent.stderr).toContain("--no-identify");
  });

  it("warns that the report is going to stdout when no --report was given", async () => {
    const { stderr, report } = await runListened({ toFile: false });

    // The report really did come out on stdout — otherwise the warning would be
    // about nothing.
    expect(report.runId).toBeDefined();
    expect(stderr).toContain("stdout");
    expect(stderr).toContain("0600");
  });

  it("keeps quiet about stdout when the report is going to a file", async () => {
    const { stderr } = await runListened({});

    expect(stderr).not.toContain("The report has nowhere to go but stdout");
  });

  /**
   * And not on a dry run, which sends nothing and writes nothing.
   *
   * A preview that warns about where a report goes is warning about a report it
   * is not going to produce — and `--dry-run` already says the opposite in the
   * same breath when `--report` *is* given ("is not written by a dry run").
   */
  it("keeps quiet about stdout on a dry run", async () => {
    const { stderr, agents } = await runListened({ toFile: false, flags: ["--dry-run"] });

    expect(agents).toEqual([]);
    expect(stderr).not.toContain("The report has nowhere to go but stdout");
  });
});

/**
 * The digest, checked on the artifact rather than on an object in memory.
 *
 * ADR-0051 sells `contentDigest` as the answer to "is this the file the run
 * wrote", and `tests/report/report-answers-for-itself.test.ts` proves it — of a
 * report `buildReport` returned, round-tripped through `JSON.stringify`. That
 * was the only report the guarantee ever held for. Every file the command has
 * produced failed its own check, because the CLI put the run's identifier on the
 * report **after** the digest had been taken over a report carrying a different
 * one: `{ ...built, runId }` (ADR-0045), one line past the last thing that
 * hashed anything. Measured on the 58 reports of the polygon: `ok: false` on all
 * 58.
 *
 * So the guarantee was checked everywhere except where it is used, which is the
 * class this project spends its audits looking for in its own code. The test for
 * it therefore runs the command and reads what landed on the disk: a report
 * assembled in this process passes with the defect still in place, exactly as
 * the existing suite did.
 *
 * See ADR-0058.
 */
describe("the digest on the artifact the command produced", () => {
  it("checks out against the file that was written", async () => {
    const { report } = await runAgainstStand({ config: configFor, endpoints: ENDPOINTS });
    const verdict = checkContentDigest(report);

    expect(verdict.declared).toMatch(/^[0-9a-f]{64}$/);
    expect(verdict.computed).toBe(verdict.declared);
    expect(verdict.ok).toBe(true);
  });

  /**
   * And the identifier it covers is the run's own, not a second one minted by
   * the report layer. The two guarantees are compatible only one way round:
   * hashing last is what lets the run decide the `runId`, and a fix that made
   * the digest check out by dropping ADR-0045 would leave the owner of the
   * platform holding traffic marked with an identifier no artifact carries.
   */
  it("covers the identifier the platform was given", async () => {
    const { report, stderr } = await runAgainstStand({ config: configFor, endpoints: ENDPOINTS });

    expect(stderr).toContain(`run=${report.runId}`);
    expect(checkContentDigest(report).ok).toBe(true);
  });

  /**
   * The same document down the other channel. `--report` is absent in the
   * ordinary CI invocation, and the artifact is then whatever stdout was
   * redirected into — a file by another name, and one nobody would think to
   * check separately.
   */
  it("checks out on the report printed to stdout", async () => {
    const { report } = await runAgainstStand({
      config: configFor,
      endpoints: ENDPOINTS,
      toFile: false,
    });

    expect(checkContentDigest(report).ok).toBe(true);
  });

  /**
   * And it still catches an edit to the file, which is the whole point of
   * carrying it: a check that passes on everything is not a check.
   */
  it("stops checking out when a line of the file is edited", async () => {
    const { document } = await runAgainstStand({ config: configFor, endpoints: ENDPOINTS });
    const edited = JSON.parse(document) as ReportFile & {
      verdict: { readonly code: number; readonly reason: string };
    };
    edited.verdict = { ...edited.verdict, reason: "all good, ship it" };

    expect(checkContentDigest(edited).ok).toBe(false);
  });
});

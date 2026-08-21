/**
 * A canary on a write endpoint, with `--unsafe-methods` absent.
 *
 * `assertCanariesUsable` checked four things — an unknown endpoint, a templated
 * one, an excluded one, one the policy denies — and not the method. A canary on
 * `POST /login` therefore passed every pre-flight check the tool has, and the
 * two halves of the tool then said different things about it:
 *
 *     DRY RUN exit 0
 *       login  (POST /login)  skip: a write method, and --unsafe-methods was not given
 *       Cells a run would probe: 1, plus 3 canary requests
 *
 *     REAL RUN exit 2
 *     Run aborted: The canaries did not pass, the run stopped:
 *       bob: login did not answer (TRANSPORT)
 *     The platform did not answer at all: nothing reached the application...
 *     Check the address, the port and that the deployment is up.
 *
 * Safety held throughout: `UnsafeMethodError` fires inside the client and
 * nothing goes on the wire. The diagnosis is what failed. `failureCode` finds no
 * code on an error this project threw itself, so the reason fell through to
 * `TRANSPORT`, and the operator was sent to check the port and the liveness of a
 * deployment that was up the whole time — while the mistake was three lines up
 * in their own configuration. The preview, meanwhile, printed the endpoint as
 * skipped for its method and in the same breath counted three canary requests
 * against it: an arithmetic that describes a run nobody can perform.
 *
 * This is the class `ExcludedCanaryError` already closed for the exclusion list —
 * a canary the run will not probe is a mistake in the declaration, named before
 * the first request rather than discovered as silence from the platform. The
 * fifth check says so for the method, and the error carries the account, the
 * endpoint and the method, because a diagnosis that does not name what to change
 * is the defect this file is about.
 *
 * Found by adversarial review, 21 August 2026 (V-5). See ADR-0041.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCredentialProvider, DEFAULT_AUTH_SCHEME } from "../../src/adapters/credentials.js";
import type { HttpClient, HttpRequest } from "../../src/adapters/ports.js";
import type { Endpoint } from "../../src/core/index.js";
import { assertCanariesUsable, probeCanaries, UnsafeCanaryError } from "../../src/runner.js";

const endpoints: readonly Endpoint[] = [
  { id: "login", method: "POST", path: "/login" },
  { id: "me", method: "GET", path: "/v1/me" },
];

const canaries = [{ accountId: "bob", endpointId: "login" }];

describe("the fifth check assertCanariesUsable makes", () => {
  it("refuses a canary whose method a run without --unsafe-methods will not issue", () => {
    expect(() => assertCanariesUsable({ endpoints, canaries })).toThrow(UnsafeCanaryError);
  });

  /**
   * The account, the endpoint and the method, because the message replaces
   * "did not answer (TRANSPORT)" — and that one named an account and left the
   * reader guessing at everything else.
   */
  it("names the account, the endpoint, the method and the flag", () => {
    let raised: unknown;
    try {
      assertCanariesUsable({ endpoints, canaries });
    } catch (error) {
      raised = error;
    }

    expect(raised).toBeInstanceOf(UnsafeCanaryError);
    const error = raised as UnsafeCanaryError;
    expect(error.name).toBe("UnsafeCanaryError");
    expect(error.accountId).toBe("bob");
    expect(error.endpointId).toBe("login");
    expect(error.method).toBe("POST");
    expect(error.message).toContain('"bob"');
    expect(error.message).toContain('"login"');
    expect(error.message).toContain("POST");
    expect(error.message).toContain("--unsafe-methods");
  });

  /**
   * The message is printed by `--dry-run` and by the run, and it must be true of
   * both. Nothing in it may claim that a request was made, or that a platform
   * answered: on the preview side neither has happened.
   */
  it("says nothing that only a run that already sent something could say", () => {
    let message = "";
    try {
      assertCanariesUsable({ endpoints, canaries });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).not.toMatch(/did not answer|was refused|the platform (?:answered|did)/i);
  });

  /** With the flag, the method is one the run issues, and there is nothing to refuse. */
  it("accepts the same canary once unsafe methods are allowed", () => {
    expect(() =>
      assertCanariesUsable({ endpoints, canaries, allowUnsafeMethods: true }),
    ).not.toThrow();
  });

  /** A safe canary is unaffected either way. */
  it("leaves a canary on a safe method alone", () => {
    expect(() =>
      assertCanariesUsable({ endpoints, canaries: [{ accountId: "bob", endpointId: "me" }] }),
    ).not.toThrow();
  });
});

describe("probeCanaries behind the same check", () => {
  it("refuses before the first request rather than on the wire", async () => {
    const seen: HttpRequest[] = [];
    const client: HttpClient = {
      send(request) {
        seen.push(request);
        return Promise.resolve({ status: 200, headers: {} });
      },
    };

    await expect(
      probeCanaries({
        baseUrl: "https://api.test",
        endpoints,
        canaries,
        credentials: createCredentialProvider(DEFAULT_AUTH_SCHEME, new Map([["bob", "tok"]])),
        client,
      }),
    ).rejects.toThrow(UnsafeCanaryError);
    expect(seen).toEqual([]);
  });
});

/**
 * A deployment that records everything, including requests carrying no
 * credentials.
 *
 * The control request behind every canary (ADR-0040) is anonymous, and the claim
 * under test is "nothing at all reached the application" — so the stand counts
 * that one too. It answers 200 to everybody: a stand that refused would make the
 * refusal ambiguous between "the tool did not ask" and "the platform said no".
 */
async function startRecordingTarget() {
  const seen: string[] = [];
  const server = createServer((request, response) => {
    seen.push(`${request.method ?? "?"} ${request.url ?? ""}`);
    response.writeHead(200).end();
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
    get requests(): readonly string[] {
      return seen;
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
 * The entry point calls `parseAsync` at the top level, so importing it is a run,
 * and `vi.resetModules()` is what makes the second import execute rather than
 * return the cached module. `process.exitCode` is saved and restored: the CLI
 * sets it, and vitest's own exit code is that same field.
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

const ENDPOINT_LIST = `
endpoints:
  - { id: login, method: POST, path: /login }
  - { id: orders, method: GET, path: /v1/orders }
`;

function configFor(port: number): string {
  return `
target:
  label: unsafe canary stand
  baseUrl: http://127.0.0.1:${port}
  allowedHosts: [127.0.0.1]

accounts:
  - { id: bob, role: user, tenant: tenant-a, tokenEnv: UNSAFE_CANARY_TOKEN_BOB, canary: login }

policy:
  fallback: denied
  rules:
    - { roles: [user], endpoints: [login, orders], outcome: allowed }

tenants: [tenant-a]
`;
}

/** The run's two files on disk, since the CLI takes paths and not documents. */
async function writeRun(config: string, endpointList: string) {
  const directory = await mkdtemp(join(tmpdir(), "barbican-unsafe-canary-"));
  const configPath = join(directory, "run.yaml");
  const endpointsPath = join(directory, "endpoints.yaml");
  await writeFile(configPath, config, "utf8");
  await writeFile(endpointsPath, endpointList, "utf8");
  return { configPath, endpointsPath, reportPath: join(directory, "report.json") };
}

/**
 * Both halves of the tool, against the same configuration.
 *
 * The preview and the run disagreeing is the finding, so neither side is worth
 * asserting on alone: the case is that they now say the same thing, and that the
 * thing they say is true.
 */
describe("both halves of the tool, on a canary a run will not issue", () => {
  const cases = [
    { name: "the preview", flags: ["--dry-run"] },
    { name: "the run", flags: [] as readonly string[] },
  ];

  for (const one of cases) {
    it(`${one.name} refuses it, names the method, and sends nothing`, async () => {
      const target = await startRecordingTarget();
      const paths = await writeRun(configFor(target.port), ENDPOINT_LIST);
      process.env.UNSAFE_CANARY_TOKEN_BOB = "token-bob";

      try {
        const result = await runCli(
          "run",
          "--config",
          paths.configPath,
          "--endpoints",
          paths.endpointsPath,
          "--report",
          paths.reportPath,
          ...one.flags,
        );

        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("POST");
        expect(result.stderr).toContain("login");
        expect(result.stderr).toContain("--unsafe-methods");
        // The sentence this replaces. It sent the reader to check a port and a
        // deployment that were both fine.
        expect(result.stderr).not.toContain("The platform did not answer at all");
        expect(target.requests).toEqual([]);
      } finally {
        delete process.env.UNSAFE_CANARY_TOKEN_BOB;
        await target.close();
      }
    });
  }

  /**
   * The control: the same canary with the flag the message names.
   *
   * Without it a CLI that refused every configuration would satisfy the two
   * cases above, and the message would be telling the reader to do something
   * that does not work.
   */
  it("accepts the same canary when --unsafe-methods is given", async () => {
    const target = await startRecordingTarget();
    const paths = await writeRun(configFor(target.port), ENDPOINT_LIST);
    process.env.UNSAFE_CANARY_TOKEN_BOB = "token-bob";

    try {
      const result = await runCli(
        "run",
        "--config",
        paths.configPath,
        "--endpoints",
        paths.endpointsPath,
        "--report",
        paths.reportPath,
        "--unsafe-methods",
        "--dry-run",
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("Dry run");
      expect(target.requests).toEqual([]);
    } finally {
      delete process.env.UNSAFE_CANARY_TOKEN_BOB;
      await target.close();
    }
  });
});

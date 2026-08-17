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

import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Severity } from "../src/core/index.js";

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

function configFor(port: number): string {
  return `
target:
  label: cli test stand
  baseUrl: http://127.0.0.1:${port}
  allowedHosts: [127.0.0.1]

accounts:
  - { id: alice, role: user, tenant: tenant-a, tokenEnv: CLI_TEST_TOKEN_ALICE, canary: me }

policy:
  fallback: denied
  rules:
    - { roles: [user], endpoints: [me], outcome: allowed }

tenants: [tenant-a]
`;
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

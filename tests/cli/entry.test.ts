/**
 * The entry point itself: the three subcommands, and what an exit code means.
 *
 * `src/cli.ts` carried the exemption the whole `src/cli/` directory then
 * inherited — "argument parsing and printing, checked by running the built
 * binary" — and of the four things it does beyond declaring flags, two were run
 * by no test in this process and one by no test at all: `diff` and `schema` were
 * reached only by the polygon, in a CI job of its own.
 *
 * What is checked from outside, by `tests/invariants/cli-surface.test.ts`
 * spawning the binary, is what cannot be seen from within: a missing
 * `exitOverride` takes the worker down with `process.exit()`, and a process
 * killed by a signal has no exit code to read from inside itself. Everything
 * else about this file is observable here, and the exit code of a mistyped flag
 * is the most load-bearing of it — 1 is this tool's "the platform disagrees with
 * the policy", so `--unsafe-metods` reported as a privilege escalation until
 * `USAGE_ERROR` was introduced (C-3/H-5).
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "barbican-cli-entry-"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface RunResult {
  readonly stderr: string;
  readonly stdout: string;
  readonly exitCode: number | undefined;
}

/**
 * Runs the CLI in this process and collects what it wrote.
 *
 * The module runs `parseAsync` at the top level, so importing it is running the
 * command; `vi.resetModules()` is what makes the second import execute rather
 * than return the cached module. `process.exitCode` is put back afterwards — the
 * CLI sets it, and vitest's own exit code is the same field.
 */
async function runCli(...argv: readonly string[]): Promise<RunResult> {
  const savedArgv = process.argv;
  const savedExitCode = process.exitCode;
  const savedIsTty = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
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
    await import("../../src/cli.js");
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

/** A report as the file holds one, cut down to what a comparison reads. */
function report(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "2",
    runId: "11111111-1111-4111-8111-111111111111",
    configDigest: "aaaa000000000000",
    startedAt: "2026-08-20T09:00:00.000Z",
    truncated: false,
    target: { baseUrl: "https://api.test", label: "staging" },
    defects: [],
    observations: [{ endpointId: "orders.list" }],
    coverage: { endpointsTotal: 1, endpointsProbed: 1, cellsObserved: 1, notProbed: {} },
    verdict: { code: 0, reason: "no discrepancy with the declared policy" },
    ...over,
  };
}

async function saved(name: string, document: unknown): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, JSON.stringify(document), "utf8");
  return path;
}

describe("barbican schema", () => {
  /**
   * stdout, so it can be redirected into a file; everything else the CLI says
   * goes to stderr, and mixing the two would make the redirect produce invalid
   * JSON on the first warning. `pnpm run schema` is that redirect.
   */
  it("prints the JSON Schema of the run configuration to stdout, and nothing else", async () => {
    const { stdout, stderr, exitCode } = await runCli("schema");

    const schema = JSON.parse(stdout) as { readonly $schema?: string; readonly type?: string };
    expect(schema.type).toBe("object");
    expect(stderr).toBe("");
    expect(exitCode).toBeUndefined();
  });
});

describe("barbican diff", () => {
  it("leaves with the comparison's own code", async () => {
    const before = await saved("before.json", report());
    const after = await saved(
      "after.json",
      report({ runId: "22222222-2222-4222-8222-222222222222" }),
    );

    const { stderr, exitCode } = await runCli("diff", before, after);

    expect(exitCode).toBe(0);
    expect(stderr).toContain("the same defects, over the same surface");
  });

  /**
   * 2 and not 64, and the line is the same one `run` draws: what the argument
   * parser rejects is a usage error, and everything after that — a path that is
   * not there, a file that is not JSON, a document that is not a report — is a
   * conclusion the tool refuses to draw.
   */
  it("refuses a path that is not a report with 2, not with a usage error", async () => {
    const before = await saved("before.json", report());

    const { stderr, exitCode } = await runCli("diff", before, join(directory, "absent.json"));

    expect(exitCode).toBe(2);
    expect(stderr).toContain("Comparison aborted:");
  });
});

describe("the exit code of a command line the tool would not read", () => {
  /**
   * 64 is `EX_USAGE` from `sysexits.h`, and the point is what it is not: 1 is
   * "checked, and reality does not match what you declared", so a typo used to
   * report as a finding about the platform — silently, in CI, where the exit
   * code is the whole interface.
   */
  it("is 64 for an unknown option", async () => {
    const { exitCode } = await runCli("run", "--unsafe-metods");

    expect(exitCode).toBe(64);
  });

  it("is 64 for a missing required option", async () => {
    const { exitCode } = await runCli("run");

    expect(exitCode).toBe(64);
  });

  /**
   * `--help` and `--version` come through the same catch — commander treats
   * printing them as an exit — and they are not failures. `exitCode: 0` on the
   * error is the only thing that separates them from a usage error.
   */
  it("is 0 for --version and for --help", async () => {
    const version = await runCli("--version");
    expect(version.exitCode).toBe(0);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);

    expect((await runCli("--help")).exitCode).toBe(0);
  });

  /**
   * A run that stopped for a reason of its own is 2 — the tool could not reach a
   * conclusion — and the message says which of the four paths was at fault.
   */
  it("is 2 for a run that could not start", async () => {
    const { stderr, exitCode } = await runCli("run", "--config", join(directory, "absent.yaml"));

    expect(exitCode).toBe(2);
    expect(stderr).toContain("Run aborted:");
    expect(stderr).toContain("--config cannot be read");
  });
});

/**
 * The order the steps of a run happen in, and the refusals that come before the
 * first request.
 *
 * `src/cli/run.ts` is the sequence and little else — nearly every comment in it
 * is about a line's **position** — and it spent the four days after ADR-0056
 * outside the coverage gate on an exemption written about argument parsing. What
 * that left unheld is the part of the module that is not parsing: the two
 * refusals a mistyped command line earns before any traffic is spent, the
 * removal of the stream once the report is safely on disk, and the branch that
 * saves a finished run from a filesystem error.
 *
 * `run` is called directly rather than through the entry point: the argument
 * parsing above it is commander's and is held from outside by
 * `tests/invariants/cli-surface.test.ts`, which spawns the built binary because
 * two of its invariants cannot be observed from inside this process.
 */

import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunFlags } from "../../src/cli/flags.js";
import { run } from "../../src/cli/run.js";
import { observationStreamPath } from "../../src/report/write.js";

const TOKEN = "run-test-token-alice";

let server: Server;
let port: number;
let directory: string;
let stderr: string[];
let stdout: string[];

/**
 * A deployment that tells a credentialed request from an anonymous one, and
 * refuses the admin surface to everybody. Enough for a walk that agrees with the
 * declaration below, which is what the cases here need: none of them is about a
 * finding.
 */
beforeAll(async () => {
  server = createServer((request, response) => {
    const token = (request.headers.authorization ?? "").replace("Bearer ", "");
    if (token !== TOKEN) {
      response.writeHead(401).end();
      return;
    }
    response.writeHead(request.url === "/v1/admin/accounts" ? 403 : 200).end();
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
  directory = await mkdtemp(join(tmpdir(), "barbican-cli-run-"));
  stderr = [];
  stdout = [];
  vi.stubEnv("CLI_RUN_TOKEN_ALICE", TOKEN);
  Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
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
  - id: admin.accounts
    method: GET
    path: /v1/admin/accounts
`;

/** A tenant with an address of its own: brands are often spread across subdomains. */
function configText(): string {
  return `
target:
  label: cli run test stand
  baseUrl: http://127.0.0.1:${port}
  allowedHosts: [127.0.0.1]
tenants:
  - { id: tenant-a, baseUrl: "http://127.0.0.1:${port}" }
accounts:
  - { id: alice, role: user, tenant: tenant-a, tokenEnv: CLI_RUN_TOKEN_ALICE, canary: me }
policy:
  fallback: denied
  rules:
    - { roles: [user], endpoints: [me], outcome: allowed }
`;
}

/**
 * The same run with no tenant list and a ceiling on the bytes read for signals.
 *
 * Two fields whose absence and presence the run branches on, and which the
 * declaration above does not exercise: `tenants` is what the report carries the
 * tree in, and `bodySignals.maxBodyBytes` is what puts a signal extractor into
 * the client at all.
 */
function bareConfigText(): string {
  return `
target:
  label: cli run test stand
  baseUrl: http://127.0.0.1:${port}
  allowedHosts: [127.0.0.1]
accounts:
  - { id: alice, role: user, tenant: tenant-a, tokenEnv: CLI_RUN_TOKEN_ALICE, canary: me }
policy:
  fallback: denied
  rules:
    - { roles: [user], endpoints: [me], outcome: allowed }
bodySignals:
  maxBodyBytes: 4096
  responseMustDifferByTenant: [me]
`;
}

/** The four files a run reads and writes, laid out in one temporary directory. */
async function fixture(
  text: string = configText(),
): Promise<{ readonly config: string; readonly endpoints: string }> {
  const config = join(directory, "barbican.run.yaml");
  const endpoints = join(directory, "endpoints.yaml");
  await writeFile(config, text, "utf8");
  await writeFile(endpoints, ENDPOINTS, "utf8");
  return { config, endpoints };
}

function flags(over: Partial<RunFlags> & { readonly config: string }): RunFlags {
  return { identify: true, ...over };
}

describe("what a run refuses before it sends anything", () => {
  /**
   * The stream a run is resumed from lives beside the report, so without a path
   * there is no stream to continue. Refused rather than started fresh: a resume
   * that silently walked the whole matrix again would spend exactly the traffic
   * the flag exists to save.
   */
  it("refuses --resume without --report", async () => {
    const { config, endpoints } = await fixture();

    await expect(run(flags({ config, endpoints, resume: true }))).rejects.toThrow(
      /--resume needs --report/,
    );
  });

  /**
   * Two sources would silently diverge and none would give a report with no
   * findings, indistinguishable from a successful one. The refusal names all
   * three flags, because the mistake is usually that one of them was forgotten.
   */
  it("refuses a command line with no endpoint source, and one with two", async () => {
    const { config, endpoints } = await fixture();
    const spec = join(directory, "spec.yaml");
    await writeFile(spec, "openapi: 3.0.0\n", "utf8");

    await expect(run(flags({ config }))).rejects.toThrow(/Give exactly one endpoint source/);
    await expect(run(flags({ config, endpoints, spec }))).rejects.toThrow(
      /Give exactly one endpoint source/,
    );
  });

  /** Nothing was sent for either of those: the checks sit above the first request. */
  it("says nothing about a walk it never began", async () => {
    const { config } = await fixture();

    await expect(run(flags({ config }))).rejects.toThrow();
    expect(stderr.join("")).not.toContain("Cells probed");
  });
});

describe("a run that finished", () => {
  /**
   * The stream is the safety net for a walk that did not finish, and this walk
   * did. Leaving it beside the report would be a second copy of the same data,
   * at the same sensitivity, that nobody asked for and nothing would delete.
   */
  it("writes the report and removes the stream beside it", async () => {
    const { config, endpoints } = await fixture();
    const report = join(directory, "run.json");

    const code = await run(flags({ config, endpoints, report }));

    expect(code).toBe(0);
    const written = JSON.parse(await readFile(report, "utf8")) as { readonly runId: string };
    expect(written.runId).toMatch(/^[0-9a-f-]{36}$/);
    await expect(stat(observationStreamPath(report))).rejects.toThrow();
    // The report is the artifact; nothing of it went to stdout.
    expect(stdout).toEqual([]);
  });

  /** Without `--report` the document goes to stdout, and the warning says so. */
  it("prints the report to stdout when no path was given, and warns that it did", async () => {
    const { config, endpoints } = await fixture(bareConfigText());

    const code = await run(flags({ config, endpoints }));

    expect(code).toBe(0);
    expect(stderr.join("")).toContain("The report has nowhere to go but stdout");
    expect(JSON.parse(stdout.join(""))).toMatchObject({ tool: { name: "barbican" } });
  });

  /**
   * The run is already paid for in traffic against somebody else's deployment,
   * so a filesystem error at the last step must not lose the result. The path
   * was checked before the first request, which is why reaching this branch
   * takes something that went wrong in between — here, a directory sitting where
   * the staging file has to be created.
   */
  it("prints the report to stdout when it cannot be written, and keeps the stream", async () => {
    const { config, endpoints } = await fixture();
    const report = join(directory, "run.json");
    await mkdir(`${report}.partial`);

    const code = await run(flags({ config, endpoints, report }));

    expect(code).toBe(0);
    expect(stderr.join("")).toContain("The report could not be written:");
    expect(JSON.parse(stdout.join(""))).toMatchObject({ tool: { name: "barbican" } });
    // A pipeline that loses stdout still has the walk on disk.
    expect((await stat(observationStreamPath(report))).isFile()).toBe(true);
  });
});

describe("a walk continued by a second process", () => {
  /**
   * ADR-0047 end to end, and the only place the two halves meet: a budget stops
   * the first run in the middle, the cells it did reach stay on disk, and the
   * second run adopts them along with the interrupted run's identifier and start
   * time — one walk over two processes, under one digest and one verdict.
   *
   * The ceiling is on the command line and not in the declaration, which is what
   * makes the second run's digest the same as the first's. Raising it is how an
   * operator continues a run their own limit stopped.
   */
  it("takes the cells the budget stopped over, and reports them as one run", async () => {
    const { config, endpoints } = await fixture();
    const report = join(directory, "run.json");

    const first = await run(flags({ config, endpoints, report, maxRequests: 3 }));

    expect(first).toBe(2);
    expect(stderr.join("")).toContain("The run was cut short");
    const carried = JSON.parse(await readFile(report, "utf8")) as {
      readonly runId: string;
      readonly startedAt: string;
      readonly truncated: boolean;
    };
    expect(carried.truncated).toBe(true);
    // The safety net outlives a walk that did not finish, and only that one.
    expect((await stat(observationStreamPath(report))).isFile()).toBe(true);

    stderr = [];
    const second = await run(flags({ config, endpoints, report, resume: true }));

    expect(second).toBe(0);
    expect(stderr.join("")).toContain("cells are already in");
    const finished = JSON.parse(await readFile(report, "utf8")) as {
      readonly runId: string;
      readonly startedAt: string;
      readonly summary: { readonly observations: number };
    };
    // One identifier on the wire across both processes, and a start time naming
    // the start of the walk rather than of the second process. See ADR-0045.
    expect(finished.runId).toBe(carried.runId);
    expect(finished.startedAt).toBe(carried.startedAt);
    expect(finished.summary.observations).toBe(2);
    await expect(stat(observationStreamPath(report))).rejects.toThrow();
  });

  /**
   * The stream is the safety net, and losing the net must not cost what it was
   * there to catch: the walk is already paid for in traffic. The failure is said
   * once, on the screen, and the report is complete for what was walked.
   *
   * A directory where the stream file has to be is the cheapest way to make
   * every write to it fail without touching the walk.
   */
  it("says once when the walk could not be streamed, and finishes the run", async () => {
    const { config, endpoints } = await fixture();
    const report = join(directory, "run.json");
    await mkdir(observationStreamPath(report));

    const code = await run(flags({ config, endpoints, report }));

    expect(code).toBe(0);
    expect(stderr.join("")).toContain("The walk could not be streamed to disk:");
    expect(stderr.join("")).toContain(observationStreamPath(report));
    expect(JSON.parse(await readFile(report, "utf8"))).toMatchObject({ truncated: false });
  });
});

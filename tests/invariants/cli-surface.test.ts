/**
 * The surface an operator and a pipeline actually touch: exit codes, refusals
 * and what the screen is allowed to say.
 *
 * `src/cli.ts` is excluded from the coverage thresholds on the grounds that it
 * is "argument parsing and printing, checked by running the built binary". The
 * audit of 20 August 2026 asked which test does that running, and the answer for
 * four separate invariants was `polygon/verify.mjs` — a CI job of its own — or
 * nothing at all. Each of them was mutated in `src/cli.ts` and the whole vitest
 * suite stayed green:
 *
 * - `exitCodeFrom` returning commander's own code instead of `USAGE_ERROR`, and
 *   `program.exitOverride()` deleted. Either way `barbican run --unsafe-metods`
 *   leaves with 1, which is this tool's "checked, and the platform disagrees
 *   with the policy" — a typo in a flag reported as a privilege escalation, in
 *   the one place where the exit code is the entire interface (C-3, H-5).
 * - SIGINT, about which the repository said nothing whatsoever (H-5).
 * - `positiveInteger` built from `Number()` and `Number.isInteger`, which let
 *   `--rps 1e23` through: a gap of 1e-20 ms between requests, which is the
 *   no-limits mode the project promises not to have (C-4, H-8).
 * - both `catch` blocks printing `error.message`, where `String(error)` or
 *   `error.stack` would have been an edit nothing objected to (A-9).
 *
 * Why a spawned process and not an import, the way `tests/cli.test.ts` drives
 * the same file: two of these cannot be observed in-process. Without
 * `exitOverride` commander calls `process.exit()`, which takes the vitest worker
 * with it rather than failing a test; and a process killed by a signal has no
 * exit code to read from inside itself — 130 exists only as something a parent
 * observes. The cost is that the tests need `dist/`, so they build it.
 */

import { execFile, spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { constants, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FAST_STAND } from "../fixtures/local-stand.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = resolve(ROOT, "dist/cli.js");

/**
 * The build, run by the tests that need it.
 *
 * `pnpm run check` is `lint && typecheck && test:coverage && build` — the build
 * comes *after* the suite, so `dist/` cannot be assumed to exist, and if it does
 * it is the previous edit's. Compiling here rather than reading whatever is
 * lying around is the difference between testing this working tree and testing
 * an artifact of unknown age. `tsc` is invoked directly, without the
 * `executable-bit` step that `pnpm run build` adds: these tests hand the file to
 * `node`, so its mode is not their business.
 */
beforeAll(async () => {
  await promisify(execFile)(
    process.execPath,
    [resolve(ROOT, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"],
    { cwd: ROOT },
  );
}, 180_000);

interface CliOutcome {
  /** What a shell would report, so that a signal and an exit code are comparable. */
  readonly status: number;
  /**
   * Which signal ended it, where one did.
   *
   * Kept apart from `status` because the two are not the same statement and the
   * number cannot tell them apart: a process that calls `process.exit(130)`
   * reports `code: 130, signal: null`, and everything asking `WIFSIGNALED` — a
   * shell deciding whether to abandon a loop, a supervisor deciding whether the
   * exit was the program's own decision — reads that as the program having
   * chosen to fail. Since 21 August 2026 `src/cli.ts` has a handler that could
   * make exactly that substitution while leaving every number on this screen
   * unchanged.
   */
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The number CI sees, whichever way the process ended.
 *
 * A process killed by a signal has no exit code of its own: `child_process`
 * reports `code: null, signal: "SIGINT"`, and the shell that started it turns
 * that into 128 + the signal's number. 130 is that convention and not a value
 * anything in `src/` assigns, which is exactly why it has to be observed from
 * out here.
 */
function statusOf(code: number | null, signal: NodeJS.Signals | null): number {
  if (signal !== null) {
    const number = constants.signals[signal as keyof typeof constants.signals];
    return 128 + (number ?? 0);
  }
  return code ?? 0;
}

interface RunningCli {
  readonly done: Promise<CliOutcome>;
  interrupt(): void;
  /** How CI kills a job that ran past its timeout. */
  terminate(): void;
}

function startCli(args: readonly string[], env: Readonly<Record<string, string>> = {}): RunningCli {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const done = new Promise<CliOutcome>((settle, fail) => {
    child.on("error", fail);
    child.on("close", (code, signal) => {
      settle({ status: statusOf(code, signal), signal, stdout, stderr });
    });
  });
  return {
    done,
    interrupt: () => {
      child.kill("SIGINT");
    },
    terminate: () => {
      child.kill("SIGTERM");
    },
  };
}

function cli(
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Promise<CliOutcome> {
  return startCli(args, env).done;
}

interface Stub {
  readonly port: number;
  /** Every path the deployment was asked for, so that "nothing was sent" is checked and not assumed. */
  readonly seen: readonly string[];
  /** Settles as soon as the run is genuinely in flight. */
  readonly firstRequest: Promise<void>;
  /** Settles once this many requests have arrived. */
  until(count: number): Promise<void>;
  close(): Promise<void>;
}

/**
 * A deployment that records what it was asked for.
 *
 * `answer: false` accepts the connection and never replies, which is what a run
 * has to be doing for an interruption to mean anything: the process is inside
 * the walk, with a request outstanding, rather than between two of them.
 *
 * `answerFirst` is the same thing one step later: the first few cells are
 * answered and the rest hang, so an interruption lands on a walk that has
 * something to lose rather than on one that has produced nothing yet. That is
 * the case the report has to be right about.
 */
async function startStub({
  answer,
  answerFirst,
  port,
}: {
  readonly answer: boolean;
  readonly answerFirst?: number;
  /** The port to bind, when a second deployment has to stand where the first one did. */
  readonly port?: number;
}): Promise<Stub> {
  const seen: string[] = [];
  let announce: () => void = () => {};
  const firstRequest = new Promise<void>((settle) => {
    announce = settle;
  });
  const waiting: { count: number; settle: () => void }[] = [];
  const server: Server = createServer((request, response) => {
    seen.push(request.url ?? "");
    announce();
    for (const one of waiting.splice(0)) {
      if (seen.length >= one.count) {
        one.settle();
      } else {
        waiting.push(one);
      }
    }
    if (answer || (answerFirst !== undefined && seen.length <= answerFirst)) {
      response.writeHead(403).end();
    }
  });
  await new Promise<void>((settle) => {
    server.listen(port ?? 0, "127.0.0.1", settle);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the stub deployment did not start");
  }
  return {
    port: address.port,
    seen,
    firstRequest,
    until: (count) =>
      seen.length >= count
        ? Promise.resolve()
        : new Promise<void>((settle) => {
            waiting.push({ count, settle });
          }),
    close: () =>
      new Promise<void>((settle, fail) => {
        server.closeAllConnections();
        server.close((error) => (error ? fail(error) : settle()));
      }),
  };
}

const ENDPOINTS = `endpoints:
  - id: orders.list
    method: GET
    path: /v1/orders
  - id: profile.me
    method: GET
    path: /v1/me
`;

/**
 * A matrix wide enough to be stopped in the middle of.
 *
 * Two endpoints is a walk that is either finished or not started; six is one an
 * interruption can leave half done, which is the state everything below is
 * about.
 */
const SIX_ENDPOINTS = `endpoints:
${["orders", "invoices", "reports", "users", "sessions", "payouts"]
  .map((name) => `  - id: ${name}.list\n    method: GET\n    path: /v1/${name}\n`)
  .join("")}`;

function anonymousConfig(port: number): string {
  return `target:
  label: cli surface stub
  baseUrl: http://127.0.0.1:${port}
  allowedHosts: [127.0.0.1]
accounts:
  - id: anonymous
    role: anonymous
policy:
  fallback: denied
  rules:
    - { roles: [anonymous], endpoints: "*", outcome: denied }
`;
}

interface Fixture {
  readonly config: string;
  readonly endpoints: string;
  readonly dir: string;
}

async function writeFixture(port: number, list: string = ENDPOINTS): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "barbican-cli-surface-"));
  const config = join(dir, "config.yaml");
  const endpoints = join(dir, "endpoints.yaml");
  await writeFile(config, anonymousConfig(port), "utf8");
  await writeFile(endpoints, list, "utf8");
  return { config, endpoints, dir };
}

/**
 * A mistake in the command line is 64, and 64 is not 1.
 *
 * The whole point of the constant is that 0, 1 and 2 are answers *about the
 * platform* — clean, discrepancies found, run untrustworthy — and a typo in a
 * flag is none of those. commander's own code for a usage error is 1, so both
 * ways of losing `USAGE_ERROR` land on the sentence "this deployment has a
 * privilege escalation", which a pipeline reads and no one reads afterwards.
 */
describe("a mistake on the command line", () => {
  let stub: Stub;
  let fixture: Fixture;

  beforeAll(async () => {
    stub = await startStub({ answer: true });
    fixture = await writeFixture(stub.port);
  });

  afterAll(async () => {
    await stub.close();
  });

  /**
   * The four shapes a command line goes wrong in, each built in full: a case
   * that patched a shared argument list would stop describing itself the first
   * time the list changed.
   */
  const cases: readonly (readonly [string, (fixture: Fixture) => readonly string[]])[] = [
    [
      "an option that does not exist",
      (f) => ["run", "-c", f.config, "-e", f.endpoints, "--unsafe-metods"],
    ],
    ["a required option left out", (f) => ["run", "-e", f.endpoints]],
    [
      "an option value the parser refuses",
      (f) => ["run", "-c", f.config, "-e", f.endpoints, "--rps", "not-a-number"],
    ],
    [
      "a value missing after the option",
      (f) => ["run", "-c", f.config, "-e", f.endpoints, "--rps"],
    ],
  ];

  for (const [what, build] of cases) {
    it(`exits 64 on ${what}`, async () => {
      const before = stub.seen.length;

      const outcome = await cli(build(fixture));

      // 64 is `EX_USAGE`. What it must not be is 1 — commander's own code for a
      // usage error, and this tool's code for "the platform disagrees with the
      // declared policy".
      expect(outcome.status).toBe(64);
      // And nothing was spent finding it out. A usage error discovered after the
      // walk would be the same waste `--report` used to cost.
      expect(stub.seen.length).toBe(before);
    }, 30_000);
  }

  it("exits 64 on a subcommand that does not exist", async () => {
    const outcome = await cli(["walk"]);

    expect(outcome.status).toBe(64);
  }, 30_000);

  /**
   * The other half of `exitCodeFrom`, and the reason it is not simply "always
   * 64": commander treats printing help or the version as an exit and hands it
   * over as a `CommanderError` too, marked with `exitCode: 0`. Turning those
   * into usage errors would make `barbican --version` fail in a pipeline.
   */
  it("leaves --version and --help at 0", async () => {
    const version = await cli(["--version"]);
    const help = await cli(["--help"]);

    expect(version.status).toBe(0);
    expect(help.status).toBe(0);
  }, 30_000);
});

const onPosix = process.platform === "win32" ? describe.skip : describe;
const onWindows = process.platform === "win32" ? describe : describe.skip;

/**
 * Windows is a different question, not a weaker answer to the one below.
 *
 * `subprocess.kill("SIGINT")` there does not deliver a signal — POSIX signals do
 * not exist, and node maps the call onto `TerminateProcess`, which ends the
 * target unconditionally. A handler cannot run, so the graceful half of ADR-0047
 * — stop the walk, write what was observed, re-raise — is unreachable from a
 * test and from CI alike. Asserting it there was asserting a promise the
 * platform does not let the tool make, and it is what made the Windows job red
 * on the release of 0.5.0.
 *
 * What Windows does answer for is the half that needs no handler: the stream is
 * written as the walk goes, so a process killed outright still leaves the cells
 * it had walked, and `--resume` still has something to continue from. That is
 * the assertion below, and it is the reason the stream exists at all.
 */
onWindows("a run killed outright, where no handler can run", () => {
  it("still leaves the cells the walk had reached", async () => {
    const reportDir = await mkdtemp(join(tmpdir(), "barbican-cli-killed-"));
    const report = join(reportDir, "run.json");
    const stub = await startStub({ answer: false, answerFirst: 2 });
    try {
      const fixture = await writeFixture(stub.port, SIX_ENDPOINTS);
      const running = startCli([
        "run",
        "-c",
        fixture.config,
        "-e",
        fixture.endpoints,
        "-r",
        report,
        "--rps",
        "50",
      ]);
      await stub.until(3);
      running.interrupt();
      await running.done;

      // No report: nothing ran to write one. The stream is what survived.
      const left = (await readdir(reportDir)).sort();
      expect(left).toContain("run.json.stream.ndjson");
      expect(left).not.toContain("run.json");
      const stream = await readFile(join(reportDir, "run.json.stream.ndjson"), "utf8");
      const lines = stream.split("\n").filter(Boolean);
      expect(JSON.parse(lines[0] ?? "")).toMatchObject({ kind: "header" });
      expect(lines.length).toBeGreaterThan(1);
    } finally {
      await stub.close();
    }
  });
});

/**
 * A signal ends the run at 130 or 143, and leaves behind what the run had.
 *
 * Nothing in `src/` mentioned SIGINT until 21 August 2026: 130 was node's
 * default behaviour, which is the correct **status** and also the kind that
 * disappears the first time someone adds a handler to "shut down gracefully".
 * That half is unchanged and still checked here, from out here, because a
 * process killed by a signal has no exit code to read from inside itself.
 *
 * What changed is the other half. This test used to assert that an interrupted
 * run leaves an empty directory, and that was the right assertion while nothing
 * reached disk before the last response: a half-written report is worse than
 * none. It is the wrong assertion now. The traffic a run spends against somebody
 * else's deployment is the expensive part of it and may not be spendable twice
 * inside an agreed window, so an interrupted run leaves a report that says the
 * tail was never probed, and a stream another run can continue from. See
 * ADR-0047. What must still never be there is `.partial` — a report caught
 * mid-write, which the rename exists to make impossible.
 */
onPosix("an interrupted run", () => {
  /** The files a run leaves in the directory it was given, minus the report itself. */
  const besides = (files: readonly string[]): readonly string[] =>
    files.filter((one) => one !== "run.json").sort();

  it("ends at 130 and leaves a report that says the tail was never probed", async () => {
    // Two cells answered, the rest held open: the interruption lands on a walk
    // that has something to lose, which is the case the report has to be right
    // about.
    const stub = await startStub({ answer: false, answerFirst: 2 });
    try {
      const fixture = await writeFixture(stub.port, SIX_ENDPOINTS);
      const reportDir = await mkdtemp(join(tmpdir(), "barbican-cli-report-"));
      const report = join(reportDir, "run.json");

      const running = startCli([
        "run",
        "-c",
        fixture.config,
        "-e",
        fixture.endpoints,
        "-r",
        report,
        "--rps",
        "50",
      ]);
      // Interrupted with two cells answered and two hanging.
      await stub.until(3);
      running.interrupt();
      const outcome = await running.done;

      // 128 + SIGINT, which is what the shell and CI see — and the signal
      // itself, because `process.exit(130)` produces the same number and a
      // different fact. The handler that now stands between the two must end
      // the process the way the signal would have.
      expect(outcome.status).toBe(130);
      expect(outcome.signal).toBe("SIGINT");

      const written = JSON.parse(await readFile(report, "utf8")) as {
        truncated: boolean;
        runId: string;
        verdict: { code: number; reason: string };
        observations: readonly unknown[];
        summary: { observations: number };
      };
      // The verdict, and not merely a file: a report of a stopped walk that came
      // back 0 would be the worst of both, an artifact saying "clean" about a
      // matrix nobody finished.
      expect(written.truncated).toBe(true);
      expect(written.verdict.code).toBe(2);
      expect(written.verdict.reason).toContain("cut short");
      // What it did observe is in it, and the cells it never reached are not
      // invented.
      expect(written.summary.observations).toBe(2);
      expect(written.observations).toHaveLength(2);

      // The stream is beside it, and nothing caught mid-write is.
      expect(besides(await readdir(reportDir))).toEqual(["run.json.stream.ndjson"]);
      const stream = await readFile(`${report}.stream.ndjson`, "utf8");
      const lines = stream.split("\n").filter((one) => one !== "");
      expect(lines).toHaveLength(3);
      expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
        kind: "header",
        runId: written.runId,
      });
      // Only the cells that were answered. A cell the interruption caught in
      // flight recorded here would be skipped by --resume — a request the
      // platform never answered, filed as an answer.
      expect(lines.slice(1).map((one) => JSON.parse(one).kind)).toEqual(["cell", "cell"]);
    } finally {
      await stub.close();
    }
  }, 60_000);

  /**
   * SIGTERM is how CI kills a job that ran past its timeout, and it was written
   * down nowhere. It ends the same way for the same reason.
   */
  it("ends at 143 on SIGTERM and leaves the same pair", async () => {
    const stub = await startStub({ answer: false, answerFirst: 1 });
    try {
      const fixture = await writeFixture(stub.port, SIX_ENDPOINTS);
      const reportDir = await mkdtemp(join(tmpdir(), "barbican-cli-report-"));
      const report = join(reportDir, "run.json");

      const running = startCli([
        "run",
        "-c",
        fixture.config,
        "-e",
        fixture.endpoints,
        "-r",
        report,
        "--rps",
        "50",
      ]);
      await stub.until(2);
      running.terminate();
      const outcome = await running.done;

      expect(outcome.status).toBe(143);
      expect(outcome.signal).toBe("SIGTERM");
      expect(outcome.stderr).toContain("Interrupted by SIGTERM");
      const written = JSON.parse(await readFile(report, "utf8")) as { truncated: boolean };
      expect(written.truncated).toBe(true);
      expect(besides(await readdir(reportDir))).toEqual(["run.json.stream.ndjson"]);
    } finally {
      await stub.close();
    }
  }, 60_000);
});

/**
 * `--resume` continues the walk, and refuses to continue a different one.
 *
 * The first half is the point of the exercise: an operator whose run hit the
 * budget on the 1900th cell of 9000 had one answer, which was to spend those
 * 1900 requests again. The second is the condition on it. A resumed run presents
 * itself as one walk — one `runId`, one `configDigest`, one verdict over cells
 * gathered by two processes — and that is honest only while the declaration is
 * the same one. Resuming into a changed declaration and calling the result one
 * run is the worst thing this tool could do with the feature.
 */
describe("a resumed run", () => {
  it("probes only what is left, and files it under the interrupted run's identifier", async () => {
    const reportDir = await mkdtemp(join(tmpdir(), "barbican-cli-resume-"));
    const report = join(reportDir, "run.json");
    const held = await startStub({ answer: true });
    let fixture: Fixture;
    let first: { runId: string };
    try {
      fixture = await writeFixture(held.port, SIX_ENDPOINTS);
      // Stopped by its own ceiling rather than by a signal, and deliberately so.
      // This is the case ADR-0047 is written from — an operator whose run hit the
      // budget with the matrix half walked — and it is reachable on every
      // platform. A signal is not: on Windows `kill` cannot deliver one, the
      // handler never runs, and a test that interrupted this way was asserting a
      // promise the platform does not let the tool make. Signals have their own
      // tests above, each on the platform that can answer for it.
      //
      // Three requests: one canary, one control, one cell. The ceiling stops the
      // walk with five of the six cells still ahead.
      const stopped = await cli([
        "run",
        "-c",
        fixture.config,
        "-e",
        fixture.endpoints,
        "-r",
        report,
        "--rps",
        "50",
        "--max-requests",
        "3",
      ]);
      expect(stopped.status).toBe(2);
      first = JSON.parse(await readFile(report, "utf8")) as { runId: string };
    } finally {
      await held.close();
    }

    // A deployment standing where the first one did. The address is in the
    // configuration and the configuration is in the digest, so a resumed run has
    // to knock at the same door — which is the gate working, not a limitation of
    // the test.
    const answering = await startStub({ answer: true, port: held.port });
    try {
      const resumed = await cli([
        "run",
        "-c",
        fixture.config,
        "-e",
        fixture.endpoints,
        "-r",
        report,
        "--rps",
        "50",
        "--resume",
      ]);

      expect(resumed.stderr).toContain("Resuming: 3 cells are already in");
      // Four requests, not six: the two the interrupted run paid for are not
      // paid for again.
      expect(answering.seen).toHaveLength(3);

      const written = JSON.parse(await readFile(report, "utf8")) as {
        truncated: boolean;
        runId: string;
        summary: { observations: number };
        verdict: { code: number };
      };
      expect(written.truncated).toBe(false);
      expect(written.summary.observations).toBe(6);
      // One walk, one identifier. Two would leave the owner of the platform
      // with two populations of traffic and one document to join them by.
      expect(written.runId).toBe(first.runId);
      expect(written.verdict.code).toBe(0);
      // A finished walk takes its stream with it: the report is the artifact,
      // and a second copy of the same data that nothing ever deletes is not.
      expect(await readdir(reportDir)).toEqual(["run.json"]);
    } finally {
      await answering.close();
    }
  }, 90_000);

  it("refuses when the declaration has changed, before sending anything", async () => {
    const stub = await startStub({ answer: false, answerFirst: 2 });
    const reportDir = await mkdtemp(join(tmpdir(), "barbican-cli-resume-no-"));
    const report = join(reportDir, "run.json");
    try {
      const fixture = await writeFixture(stub.port, SIX_ENDPOINTS);
      const running = startCli([
        "run",
        "-c",
        fixture.config,
        "-e",
        fixture.endpoints,
        "-r",
        report,
        "--rps",
        "50",
      ]);
      await stub.until(3);
      running.interrupt();
      expect((await running.done).status).toBe(130);

      // One endpoint added: the same six cells are still there, and the matrix
      // is not the one that was walked.
      await writeFile(
        fixture.endpoints,
        `${SIX_ENDPOINTS}  - id: settings.get\n    method: GET\n    path: /v1/settings\n`,
        "utf8",
      );
      const before = stub.seen.length;

      const outcome = await cli([
        "run",
        "-c",
        fixture.config,
        "-e",
        fixture.endpoints,
        "-r",
        report,
        "--rps",
        "50",
        "--resume",
      ]);

      // 2 is "this run cannot be trusted", which is what a refusal to start is.
      expect(outcome.status).toBe(2);
      expect(outcome.stderr).toContain("--resume refuses: the declaration has changed");
      // And nothing was spent finding out: the gate is ahead of the canaries and
      // of the walk.
      expect(stub.seen.length).toBe(before);
      // The stream is untouched, so the interrupted run can still be resumed
      // once the declaration is put back.
      expect(await readdir(reportDir)).toContain("run.json.stream.ndjson");
    } finally {
      await stub.close();
    }
  }, 90_000);

  it("refuses when there is no stream to continue", async () => {
    const stub = await startStub({ answer: true });
    try {
      const fixture = await writeFixture(stub.port);
      const reportDir = await mkdtemp(join(tmpdir(), "barbican-cli-resume-none-"));
      const before = stub.seen.length;

      const outcome = await cli([
        "run",
        "-c",
        fixture.config,
        "-e",
        fixture.endpoints,
        "-r",
        join(reportDir, "run.json"),
        "--resume",
      ]);

      expect(outcome.status).toBe(2);
      expect(outcome.stderr).toContain("there is no stream at");
      expect(stub.seen.length).toBe(before);
    } finally {
      await stub.close();
    }
  }, 30_000);

  it("refuses --resume without --report", async () => {
    const stub = await startStub({ answer: true });
    try {
      const fixture = await writeFixture(stub.port);

      const outcome = await cli(["run", "-c", fixture.config, "-e", fixture.endpoints, "--resume"]);

      expect(outcome.status).toBe(2);
      expect(outcome.stderr).toContain("--resume needs --report");
    } finally {
      await stub.close();
    }
  }, 30_000);
});

/**
 * The throttling flags take the digits an operator typed.
 *
 * `Number()` reads a great deal more than a person writes into `--rps`, and
 * `Number.isInteger` agrees with all of it. The forms below are not exotic
 * spellings of a limit: they are limits nobody set. `1e23` is the one that
 * matters — a gap of 1e-20 ms between requests means the sliding window admits
 * everything the instant it arrives, and "there must be no no-limits mode" is a
 * security invariant of this project, not a preference.
 *
 * The magnitude is deliberately not bounded. An operator raising a limit on
 * purpose is doing their job; what is refused is a notation they did not mean.
 */
describe("the throttling flags", () => {
  let stub: Stub;
  let fixture: Fixture;

  beforeAll(async () => {
    stub = await startStub({ answer: true });
    fixture = await writeFixture(stub.port);
  });

  afterAll(async () => {
    await stub.close();
  });

  const refused: readonly (readonly [string, string])[] = [
    ["1e23", "an exponent, which is how the no-limits mode gets in"],
    ["2e12", "an exponent that happens to be a safe integer"],
    ["0x10", "hexadecimal"],
    ["0b101", "binary"],
    ["5.0", "a decimal point"],
    [" 5 ", "surrounding spaces"],
    ["1_0", "a numeric separator"],
    ["Infinity", "a word Number() knows"],
    ["0", "zero, which is the absence of a limit"],
    ["-3", "a negative number"],
    ["", "nothing at all"],
  ];

  for (const flag of ["--rps", "--concurrency", "--max-requests"] as const) {
    for (const [value, why] of refused) {
      it(`refuses ${flag} ${JSON.stringify(value)} — ${why}`, async () => {
        const before = stub.seen.length;

        const outcome = await cli([
          "run",
          "-c",
          fixture.config,
          "-e",
          fixture.endpoints,
          "--dry-run",
          flag,
          value,
        ]);

        // A limit that was not set is a mistake in the command line, so it is
        // the command line's exit code.
        expect(outcome.status).toBe(64);
        expect(outcome.stderr).toContain(`option '${flag} <n>' argument`);
        expect(stub.seen.length).toBe(before);
      }, 30_000);
    }
  }

  /**
   * And the flags still work. A guard that refuses everything would satisfy
   * every case above and leave the tool without limits to set — so the accepted
   * value is checked by what the run does with it, not by the absence of a
   * complaint: `--max-requests 1` against two probeable endpoints is a budget
   * the plan cannot fit, and the preview says so.
   */
  it("accepts plain decimal digits and uses the number", async () => {
    const outcome = await cli([
      "run",
      "-c",
      fixture.config,
      "-e",
      fixture.endpoints,
      "--dry-run",
      "--rps",
      "5",
      "--concurrency",
      "3",
      "--max-requests",
      "1",
    ]);

    expect(outcome.status).toBe(0);
    expect(outcome.stderr).toContain("Only 1 of those 2 requests fit the budget");
  }, 30_000);

  /**
   * A large limit an operator means is theirs to set; a large one they cannot be
   * held to is not. Past 2^53 integers stop being exact, so the number enforced
   * would not be the number written.
   */
  it("takes a deliberately large decimal limit but not one past exact arithmetic", async () => {
    const large = await cli([
      "run",
      "-c",
      fixture.config,
      "-e",
      fixture.endpoints,
      "--dry-run",
      "--max-requests",
      "2000000000000",
    ]);
    const beyond = await cli([
      "run",
      "-c",
      fixture.config,
      "-e",
      fixture.endpoints,
      "--dry-run",
      "--max-requests",
      "99999999999999999999",
    ]);

    expect(large.status).toBe(0);
    expect(beyond.status).toBe(64);
  }, 30_000);
});

/**
 * An aborted run says what went wrong and nothing else.
 *
 * `error.message` is a sentence written for whoever is reading the terminal.
 * `String(error)` prefixes it with the class name and `error.stack` adds the
 * frames, and both are one-word edits that improve a debugging session and
 * degrade the artifact: the class name names internals nobody outside this
 * repository can act on, and the frames print absolute paths of the machine the
 * run happened on into whatever a pipeline captures.
 */
describe("an aborted run", () => {
  /**
   * A document the YAML parser cannot read: the adapter wraps the failure with a
   * `cause`, so the error under test carries both a cause chain and a stack.
   */
  const BROKEN_LIST = "endpoints:\n  - id: orders.list\n   method: [unclosed\n";

  /** Frames, as `error.stack` writes them: a line whose first word is `at`. */
  const STACK_FRAME = /^\s+at\s/m;

  /**
   * A class name as `String(error)` would prefix it. Deliberately not a plain
   * search for "Error": the sentences themselves may say "error", and the
   * failure worth catching is `EndpointListParseError: ` in front of the
   * message.
   */
  const CLASS_NAME = /\b[A-Z]\w*Error\b/;

  it("prints the message without the stack or the class name behind it", async () => {
    const stub = await startStub({ answer: true });
    try {
      const fixture = await writeFixture(stub.port);
      const broken = join(fixture.dir, "broken.yaml");
      await writeFile(broken, BROKEN_LIST, "utf8");

      const outcome = await cli(["run", "-c", fixture.config, "-e", broken]);

      expect(outcome.status).toBe(2);
      expect(outcome.stderr).toContain("Run aborted:");
      expect(outcome.stderr).toContain("Could not parse the endpoint list");
      // The two mutations this test exists for.
      expect(outcome.stderr).not.toMatch(STACK_FRAME);
      expect(outcome.stderr).not.toMatch(CLASS_NAME);
      // Nothing reached the deployment either: the source is read before the
      // first request.
      expect(stub.seen).toEqual([]);
    } finally {
      await stub.close();
    }
  }, 30_000);

  /**
   * And the value of a credential is not on the screen under any of it.
   *
   * A token that cannot be sent as a header value is refused by name — the
   * account and the variable — and the value is never quoted back. This is the
   * standing half of the invariant rather than the mutating half: neither
   * `String(error)` nor `error.stack` would print it, because neither renders a
   * cause chain or an argument. What it holds is the neighbouring edit, the one
   * that prints the error object itself.
   */
  it("never puts the value of a token on the screen", async () => {
    const stub = await startStub({ answer: true });
    try {
      const fixture = await writeFixture(stub.port);
      const withToken = join(fixture.dir, "with-token.yaml");
      const secret = "s3cr3t-ÿ-value";
      await writeFile(
        withToken,
        `target:
  label: cli surface stub
  baseUrl: http://127.0.0.1:${stub.port}
  allowedHosts: [127.0.0.1]
accounts:
  - id: alice
    role: user
    tenant: tenant-a
    tokenEnv: CLI_SURFACE_TOKEN
    canary: profile.me
policy:
  fallback: denied
  rules:
    - { roles: [user], endpoints: "*", outcome: allowed }
`,
        "utf8",
      );

      const outcome = await cli(["run", "-c", withToken, "-e", fixture.endpoints], {
        CLI_SURFACE_TOKEN: secret,
      });

      expect(outcome.status).toBe(2);
      expect(outcome.stderr).toContain("CLI_SURFACE_TOKEN");
      expect(outcome.stderr).not.toContain(secret);
      expect(outcome.stderr).not.toMatch(STACK_FRAME);
      expect(outcome.stderr).not.toMatch(CLASS_NAME);
      expect(stub.seen).toEqual([]);
    } finally {
      await stub.close();
    }
  }, 30_000);
});

/**
 * `barbican diff`, driven end to end over two reports the tool itself wrote.
 *
 * `tests/report/compare.test.ts` holds the comparison against hand-written
 * fixtures, which is where the awkward shapes belong. What cannot be asked
 * there is the pair of things this file exists for: the exit code a pipeline
 * reads, and whether the reports a real run produces are comparable at all —
 * the module's view of a report is a narrow structural one, and a structural
 * type agrees with any shape it never met.
 *
 * The deployment is one stub whose open set is switched between runs, so one
 * defect is fixed and another appears with nothing else moving. That is also
 * the only way to be sure `defects[].key` is stable across two runs: the whole
 * comparison joins on it, and a key carrying anything run-specific would make
 * every defect of every pair read as gone and new at once.
 */
describe("comparing two saved reports", () => {
  /** The paths the stub answers 200 to. Everything else is refused. */
  let open: ReadonlySet<string> = new Set();
  let server: Server;
  let port = 0;
  let dir = "";

  const DIFF_ENDPOINTS = `endpoints:
${["orders", "invoices", "reports", "payouts"]
  .map((name) => `  - id: ${name}.list\n    method: GET\n    path: /v1/${name}\n`)
  .join("")}`;

  const configFor = (exclude: string): string => `target:
  label: diff stub
  baseUrl: http://127.0.0.1:${port}
  allowedHosts: [127.0.0.1]
accounts:
  - id: anonymous
    role: anonymous
policy:
  fallback: denied
  rules:
    - { roles: [anonymous], endpoints: "*", outcome: denied }
${exclude}`;

  /** One run against the stub as it stands, written to a report file of its own. */
  async function walk(name: string, openPaths: readonly string[], exclude = ""): Promise<string> {
    open = new Set(openPaths);
    const config = join(dir, `${name}.yaml`);
    const report = join(dir, `${name}.json`);
    await writeFile(config, configFor(exclude), "utf8");
    const outcome = await cli([
      "run",
      "-c",
      config,
      "-e",
      join(dir, "endpoints.yaml"),
      "-r",
      report,
      ...FAST_STAND,
    ]);
    // A walk that produced no defects would make every assertion below pass
    // for the wrong reason.
    expect(outcome.status).toBe(1);
    return report;
  }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "barbican-diff-"));
    server = createServer((request, response) => {
      response.writeHead(open.has((request.url ?? "").split("?")[0] ?? "") ? 200 : 403).end();
    });
    await new Promise<void>((settle) => {
      server.listen(0, "127.0.0.1", settle);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("the diff stub deployment did not start");
    }
    port = address.port;
    await writeFile(join(dir, "endpoints.yaml"), DIFF_ENDPOINTS, "utf8");
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((settle, fail) => {
      server.closeAllConnections();
      server.close((error) => (error ? fail(error) : settle()));
    });
  });

  it("names what was fixed and what broke, and exits 1", async () => {
    // Yesterday: orders and invoices answered everybody.
    const before = await walk("before", ["/v1/orders", "/v1/invoices"]);
    // Today: orders was fixed and reports broke. invoices is untouched.
    const after = await walk("after", ["/v1/invoices", "/v1/reports"]);

    const outcome = await cli(["diff", before, after]);

    expect(outcome.status).toBe(1);
    // The declaration first, and it did not move — which is the sentence every
    // conclusion below rests on.
    expect(outcome.stderr).toContain("The declaration is the same in both runs");
    expect(outcome.stderr).toContain("1 new, 1 gone, 0 changed, 1 unchanged");
    expect(outcome.stderr).toContain("reports.list any-resource baseline");
    expect(outcome.stderr).toContain("the second run probed orders.list and found nothing there");
  }, 120_000);

  /**
   * The same platform seen through a narrower run.
   *
   * Nothing was fixed: `orders.list` is still wide open and the second run
   * never asked. A comparison that called that a disappearance would hand an
   * operator a clean line over an untouched hole, which is the one defect this
   * subcommand must not have.
   */
  it("will not call a narrowed run a fix, and exits 2", async () => {
    const before = await walk("wide", ["/v1/orders", "/v1/invoices"]);
    const narrow = await walk(
      "narrow",
      ["/v1/orders", "/v1/invoices"],
      "exclude: [orders.list, reports.list, payouts.list]\n",
    );

    const outcome = await cli(["diff", before, narrow]);

    expect(outcome.status).toBe(2);
    expect(outcome.stderr).toContain("Coverage shrank");
    expect(outcome.stderr).toContain("no longer probed: orders.list");
    expect(outcome.stderr).toContain(
      "the second run never probed orders.list: nothing was fixed, nothing was looked at",
    );
    // And the changed declaration is said before any of it: the exclusion list
    // is the reader's own edit, and it is what moved the digest.
    const declaration = outcome.stderr.indexOf("The declaration changed");
    const coverage = outcome.stderr.indexOf("Coverage shrank");
    expect(declaration).toBeGreaterThan(-1);
    expect(declaration).toBeLessThan(coverage);
  }, 120_000);

  /**
   * A report against itself: every difference is zero by construction, which is
   * indistinguishable from a quiet week.
   */
  it("refuses to compare one report with itself", async () => {
    const only = await walk("itself", ["/v1/orders"]);

    const outcome = await cli(["diff", only, only]);

    expect(outcome.status).toBe(2);
    expect(outcome.stderr).toContain("both files record the same run");
  }, 120_000);

  /**
   * Two runs of one unchanged platform under one unchanged declaration — the
   * only clean answer this subcommand gives. What makes it believable is the
   * two cases above.
   */
  it("exits 0 when nothing moved", async () => {
    const first = await walk("quiet-a", ["/v1/orders"]);
    const second = await walk("quiet-b", ["/v1/orders"]);

    const outcome = await cli(["diff", first, second]);

    expect(outcome.status).toBe(0);
    expect(outcome.stderr).toContain("Exit code 0: the same defects, over the same surface");
  }, 120_000);

  /**
   * `--json` and the summary come out of one comparison.
   *
   * The report layer and the console spent four days disagreeing about the
   * warnings because each built its own; two artifacts of one command must not
   * be able to repeat it.
   */
  it("writes the same conclusion to stdout as JSON", async () => {
    const before = await walk("json-a", ["/v1/orders"]);
    const after = await walk("json-b", ["/v1/invoices"]);

    const outcome = await cli(["diff", before, after, "--json"]);
    const document = JSON.parse(outcome.stdout) as {
      readonly verdict: { readonly code: number };
      readonly defects: {
        readonly gone: readonly unknown[];
        readonly appeared: readonly unknown[];
      };
    };

    expect(outcome.status).toBe(1);
    expect(document.verdict.code).toBe(outcome.status);
    expect(document.defects.gone).toHaveLength(1);
    expect(document.defects.appeared).toHaveLength(1);
    // The summary is on stderr, so redirecting stdout gives a JSON document and
    // not a JSON document with a paragraph in front of it.
    expect(outcome.stderr).toContain("Defects:");
  }, 120_000);

  /**
   * A mistake on this command line is 64, like every other.
   *
   * The constant is held for `run` further up this file, and a subcommand added
   * later is exactly what that guard cannot see: `program.exitOverride()` is
   * applied by walking `program.commands`, so a command registered after the
   * loop keeps commander's own `process.exit(1)` — which is this tool's "the
   * platform disagrees with the declared policy", reported for a typo in a
   * flag.
   */
  it("exits 64 on a command line it cannot parse", async () => {
    const only = await walk("usage", ["/v1/orders"]);

    const missingArgument = await cli(["diff", only]);
    const unknownFlag = await cli(["diff", only, only, "--jsn"]);

    expect(missingArgument.status).toBe(64);
    expect(unknownFlag.status).toBe(64);
  }, 120_000);

  /**
   * And a path that is not a report is 2, not 64.
   *
   * The line `docs/report.md` draws is where the run starts: what the argument
   * parser rejects is a usage error, and everything after it is a conclusion
   * the tool refuses to draw. A missing file is on the far side of that line.
   */
  it("exits 2 on a file that is not a report", async () => {
    const notJson = join(dir, "endpoints.yaml");
    const missing = join(dir, "nowhere.json");
    const only = await walk("unreadable", ["/v1/orders"]);

    const unparseable = await cli(["diff", notJson, only]);
    const absent = await cli(["diff", only, missing]);

    expect(unparseable.status).toBe(2);
    expect(unparseable.stderr).toContain("is not JSON");
    expect(absent.status).toBe(2);
    expect(absent.stderr).toContain("nowhere.json");
  }, 120_000);
});

/**
 * `barbican pack`, driven end to end over a report the tool itself wrote.
 *
 * `tests/cli/pack.test.ts` holds the subcommand against hand-written reports,
 * which is where the awkward shapes belong. What cannot be asked there is the
 * pair this file exists for: the exit code a pipeline reads, and whether the
 * report a real run produces can be packed at all — the pack's door names its
 * fields as string literals, so nothing but a report `buildReport` wrote keeps
 * them level with `shape.ts`.
 *
 * The usage case is the one this file was written for. `program.exitOverride()`
 * is applied by walking `program.commands`, so a subcommand registered after that
 * loop keeps commander's own `process.exit(1)` — this tool's "the platform
 * disagrees with the declared policy", reported for a forgotten flag. `pack` is
 * the fourth subcommand and the first one added since that trap was written down.
 */
describe("packing a saved report", () => {
  let server: Server;
  let port = 0;
  let dir = "";
  /** The paths the stub answers 200 to. Everything else is refused. */
  let open: ReadonlySet<string> = new Set();

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "barbican-pack-"));
    server = createServer((request, response) => {
      response.writeHead(open.has((request.url ?? "").split("?")[0] ?? "") ? 200 : 403).end();
    });
    await new Promise<void>((settle) => {
      server.listen(0, "127.0.0.1", settle);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("the pack stub deployment did not start");
    }
    port = address.port;
    await writeFile(join(dir, "endpoints.yaml"), ENDPOINTS, "utf8");
    await writeFile(join(dir, "config.yaml"), anonymousConfig(port), "utf8");
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((settle, fail) => {
      server.closeAllConnections();
      server.close((error) => (error ? fail(error) : settle()));
    });
  });

  /** One run against the stub as it stands, written to a report file of its own. */
  async function walk(name: string, openPaths: readonly string[], expected: number) {
    open = new Set(openPaths);
    const report = join(dir, `${name}.json`);
    const outcome = await cli([
      "run",
      "-c",
      join(dir, "config.yaml"),
      "-e",
      join(dir, "endpoints.yaml"),
      "-r",
      report,
      ...FAST_STAND,
    ]);
    expect(outcome.status).toBe(expected);
    return report;
  }

  it("writes one document, and leaves with 0 over a clean run", async () => {
    const report = await walk("clean", [], 0);
    const out = join(dir, "clean.html");

    const outcome = await cli(["pack", report, "--out", out]);

    expect(outcome.status).toBe(0);
    const page = await readFile(out, "utf8");
    expect(page.startsWith("<!doctype html>")).toBe(true);
    // Sixteen catalogued clauses, and a clean run answers for a handful of them.
    // The rest are unanswered, which is the row a pack exists to print.
    expect(page).toContain("unanswered");
    expect(page).not.toContain("<script");
    // The document is a file: stdout carries nothing, so `barbican pack … > x`
    // does not produce a page with a summary in front of it.
    expect(outcome.stdout).toBe("");
    expect(outcome.stderr).toContain("Exit code 0: the pack was built.");
  }, 120_000);

  it("leaves with 2 when the run it was built from could not answer for itself", async () => {
    // `--max-requests 1` stops the walk with cells still ahead, which is verdict
    // 2 and standing `withheld`.
    open = new Set();
    const report = join(dir, "cut.json");
    const stopped = await cli([
      "run",
      "-c",
      join(dir, "config.yaml"),
      "-e",
      join(dir, "endpoints.yaml"),
      "-r",
      report,
      "--max-requests",
      "1",
    ]);
    expect(stopped.status).toBe(2);

    const outcome = await cli(["pack", report, "--out", join(dir, "cut.html")]);

    expect(outcome.status).toBe(2);
    expect(outcome.stderr).toContain('the standing of this pack is "withheld"');
  }, 120_000);

  it("exits 64 on a command line it cannot parse", async () => {
    const report = await walk("usage", [], 0);

    const noOut = await cli(["pack", report]);
    const noReport = await cli(["pack", "--out", join(dir, "x.html")]);
    const unknownFlag = await cli(["pack", report, "--out", join(dir, "x.html"), "--jsn", "y"]);

    // 64 and not 1. Both of the ways `USAGE_ERROR` is lost land on "this
    // deployment has a privilege escalation", for a typo in a flag.
    expect(noOut.status).toBe(64);
    expect(noReport.status).toBe(64);
    expect(unknownFlag.status).toBe(64);
  }, 120_000);

  it("exits 2 on a file that is not a report, and writes no document", async () => {
    const notJson = join(dir, "endpoints.yaml");
    const out = join(dir, "never.html");

    const outcome = await cli(["pack", notJson, "--out", out]);

    expect(outcome.status).toBe(2);
    expect(outcome.stderr).toContain("Pack aborted:");
    expect(outcome.stderr).toContain("is not JSON");
    expect(await readdir(dir)).not.toContain("never.html");
  }, 120_000);
});

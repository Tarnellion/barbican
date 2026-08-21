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
describe("an interrupted run", () => {
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
    const held = await startStub({ answer: false, answerFirst: 2 });
    let fixture: Fixture;
    let first: { runId: string };
    try {
      fixture = await writeFixture(held.port, SIX_ENDPOINTS);
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
      await held.until(3);
      running.interrupt();
      expect((await running.done).status).toBe(130);
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

      expect(resumed.stderr).toContain("Resuming: 2 cells are already in");
      // Four requests, not six: the two the interrupted run paid for are not
      // paid for again.
      expect(answering.seen).toHaveLength(4);

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

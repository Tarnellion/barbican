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
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
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
      settle({ status: statusOf(code, signal), stdout, stderr });
    });
  });
  return {
    done,
    interrupt: () => {
      child.kill("SIGINT");
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
  close(): Promise<void>;
}

/**
 * A deployment that records what it was asked for.
 *
 * `answer: false` accepts the connection and never replies, which is what a run
 * has to be doing for an interruption to mean anything: the process is inside
 * the walk, with a request outstanding, rather than between two of them.
 */
async function startStub({ answer }: { readonly answer: boolean }): Promise<Stub> {
  const seen: string[] = [];
  let announce: () => void = () => {};
  const firstRequest = new Promise<void>((settle) => {
    announce = settle;
  });
  const server: Server = createServer((request, response) => {
    seen.push(request.url ?? "");
    announce();
    if (answer) {
      response.writeHead(403).end();
    }
  });
  await new Promise<void>((settle) => {
    server.listen(0, "127.0.0.1", settle);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the stub deployment did not start");
  }
  return {
    port: address.port,
    seen,
    firstRequest,
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

async function writeFixture(port: number): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "barbican-cli-surface-"));
  const config = join(dir, "config.yaml");
  const endpoints = join(dir, "endpoints.yaml");
  await writeFile(config, anonymousConfig(port), "utf8");
  await writeFile(endpoints, ENDPOINTS, "utf8");
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
 * Ctrl-C ends the run at 130 and leaves no half-written report behind.
 *
 * Nothing in `src/` mentions SIGINT: 130 is node's default behaviour, which is
 * the correct behaviour and also the kind that disappears the first time someone
 * adds a handler to "shut down gracefully". The file half matters because the
 * report is now written through `<path>.partial` and a rename — a write spread
 * over time is a write that can be interrupted, and the staging file is exactly
 * what an interruption could leave lying next to the real one.
 */
describe("an interrupted run", () => {
  it("ends at 130 and leaves neither a report nor a .partial beside it", async () => {
    const stub = await startStub({ answer: false });
    try {
      const fixture = await writeFixture(stub.port);
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
      ]);
      // Interrupted mid-walk, not before it: the stub holds the connection open,
      // so the first request having arrived means the process is inside the part
      // of the run that has something to lose.
      await stub.firstRequest;
      running.interrupt();
      const outcome = await running.done;

      // 128 + SIGINT, which is what the shell and CI see.
      expect(outcome.status).toBe(130);
      // An interrupted run is not a run. Neither the report nor the staging file
      // the rename would have consumed may be left where a pipeline could
      // publish it as this run's result.
      expect(await readdir(reportDir)).toEqual([]);
    } finally {
      await stub.close();
    }
  }, 60_000);
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

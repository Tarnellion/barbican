/**
 * The gate runs on the platforms the project says it supports.
 *
 * `engines` asks for node and names no operating system, and `package.json`
 * carries no `os` field — so the project claims every platform node runs on. It
 * did not have one: `build` ended in `chmod +x dist/cli.js`, `check` ends in
 * `build`, and Windows has no `chmod`. A contributor there could not run the
 * project's own gate, and nothing would ever have told them why, because every
 * job in `ci.yml` ran on `ubuntu-latest`. Found by the audit of 14 August 2026
 * (K-7).
 *
 * Three assertions, and none is a substitute for another. The first is that the
 * scripts stay spellable on every platform — a guard that runs here, on any
 * machine, the moment somebody reaches for a shell command again. The second is
 * that the code those scripts run spawns nothing Windows cannot start, which the
 * first cannot see: `package.json` said `vitest run`, and the platform defect was
 * a line inside a test file. The third is that a Windows job exists to actually
 * run them, because the other two only read files, and reading is not the
 * platform.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

interface Workflow {
  readonly jobs: Record<
    string,
    {
      readonly "runs-on"?: string;
      readonly strategy?: {
        readonly matrix?: { readonly include?: readonly Record<string, unknown>[] };
      };
      readonly steps?: readonly {
        readonly name?: string;
        readonly run?: string;
        readonly with?: Record<string, unknown>;
      }[];
    }
  >;
}

const CI = parseYaml(readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8")) as Workflow;

const SCRIPTS = (
  JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  }
).scripts;

/**
 * Commands a POSIX shell has and `cmd.exe` does not.
 *
 * `chmod` is the one that was there; the rest are the neighbours somebody
 * reaches for next, and each has a node spelling that works everywhere. This is
 * a list of names and therefore always short of the truth — which is what the
 * Windows job below is for.
 */
const NOT_ON_WINDOWS = ["chmod", "chown", "cp ", "rm ", "mv ", "ln ", "touch ", "sed ", "grep "];

describe("the scripts a contributor is told to run", () => {
  it("reads them, rather than agreeing with an empty object", () => {
    expect(Object.keys(SCRIPTS)).toContain("build");
    expect(Object.keys(SCRIPTS)).toContain("check");
  });

  /**
   * Named one by one, so a failure says which script and which command. The
   * cure is a `.mjs` under `tools/` — see `tools/executable-bit.mjs`, which is
   * what `chmod +x dist/cli.js` became.
   */
  it("use no command that only a POSIX shell has", () => {
    const offending: string[] = [];
    for (const [name, command] of Object.entries(SCRIPTS)) {
      for (const missing of NOT_ON_WINDOWS) {
        if (command.includes(missing)) {
          offending.push(`${name}: ${command}`);
        }
      }
    }

    expect(offending).toEqual([]);
  });
});

/**
 * `tests/` and `tools/`, because that is what `pnpm run check` runs.
 *
 * `polygons/` spawns `docker` and `node` and is not in the gate: it is run by
 * hand against a deployment somebody stood up, and its portability is a separate
 * question from whether a contributor can run the project's own checks.
 */
const GATE_SOURCES = ["tests", "tools"];

/** Every source file under those — this one excepted, see below. */
function gateSources(): readonly string[] {
  const self = fileURLToPath(import.meta.url);
  const found: string[] = [];
  for (const directory of GATE_SOURCES) {
    for (const entry of readdirSync(resolve(ROOT, directory), {
      recursive: true,
      withFileTypes: true,
    })) {
      const path = resolve(entry.parentPath, entry.name);
      // Excepted because it has to write the forbidden shape down in order to
      // look for it, and would otherwise be its own first finding.
      if (entry.isFile() && /\.[cm]?[jt]s$/.test(entry.name) && path !== self) {
        found.push(path);
      }
    }
  }
  return found;
}

/**
 * A `child_process` call whose command is written as a literal.
 *
 * Only a literal. `process.execPath` and a path assembled by `resolve` are not
 * names for the operating system to go looking for, and they are the cure here
 * rather than the disease.
 */
const SPAWN_CALL = /\b(?:execFile|exec|spawn|fork)(?:Sync)?\s*\(\s*"([^"]*)"/g;

/**
 * The names that really are executables everywhere, and nothing else.
 *
 * An allowlist, for the reason the response-header allowlist is one: the set
 * that breaks cannot be enumerated. `npx` was the name that broke, but so would
 * `pnpm`, `npm`, `yarn`, `biome`, `vitest` and every other `node_modules/.bin`
 * entry — npm writes them as `.cmd` and `.ps1` shims, there is no `.exe`, and
 * libuv resolves a bare name against `.com` and `.exe` only. Listing the ones to
 * refuse means being wrong about the next one. `git` and `gitleaks` ship a real
 * `git.exe` and `gitleaks.exe`; anything else earns a line here with its reason,
 * or is spawned as `process.execPath` plus a path.
 */
const REAL_EXECUTABLES = new Set(["git", "gitleaks"]);

describe("the commands that gate's own code spawns", () => {
  it("reads the files, rather than agreeing with an empty list", () => {
    const files = gateSources();

    expect(files.length).toBeGreaterThan(20);
    expect(files.some((path) => path.endsWith("pinned-versions.test.ts"))).toBe(true);
  });

  /**
   * Named one by one with the file they are in. The cure is the one
   * `tests/tools/pinned-versions.test.ts` uses: `process.execPath` and the path
   * to the entry point, which needs neither a shell nor a per-platform suffix.
   */
  it("start no launcher that Windows installs as a shim", () => {
    const offending: string[] = [];
    for (const path of gateSources()) {
      for (const [, command] of readFileSync(path, "utf8").matchAll(SPAWN_CALL)) {
        if (command !== undefined && !REAL_EXECUTABLES.has(command)) {
          offending.push(`${relative(ROOT, path)}: ${command}`);
        }
      }
    }

    expect(offending).toEqual([]);
  });
});

describe("the job that would notice", () => {
  /**
   * The half a list of forbidden names cannot give. Making the scripts portable
   * without somewhere to run them would be a claim about a platform nobody here
   * has — precisely the shape of defect this project exists to find.
   */
  it("runs the gate on Windows", () => {
    const entries = CI.jobs["check"]?.strategy?.matrix?.include ?? [];

    expect(entries.some((one) => String(one["os"]).startsWith("windows"))).toBe(true);
  });

  /** And still on Linux, on more than one version of node. */
  it("keeps running it on Linux", () => {
    const entries = CI.jobs["check"]?.strategy?.matrix?.include ?? [];
    const linux = entries.filter((one) => String(one["os"]).startsWith("ubuntu"));

    expect(linux.length).toBeGreaterThan(1);
  });
});

/**
 * `engines.node` is a promise, and something has to run at the number in it.
 *
 * It said `>=22.12.0` and CI said `node: 22`, which setup-node resolves to the
 * newest 22.x — so the one version the package promised to work on was the one
 * version nothing ran on. A floor nothing runs on is a number, not a bound.
 * Found by the audit of 14 August 2026 (F-4).
 *
 * Putting `22.12.0` into the gate's matrix was the first attempt and it failed
 * on both operating systems, which is the finding paying for itself twice over:
 * **pnpm 11.20.0 declares `>=22.13`**, so the project's own floor cannot install
 * the project's own dependencies. Those are two floors for two audiences — the
 * consumer's, set by `commander@15` at exactly `>=22.12.0`, and the
 * contributor's, set by the package manager — and lowering the promise to make a
 * job pass would refuse installation to a consumer for whom the package works.
 * So the `floor` job builds on the development version and then runs the built
 * CLI on the declared floor, which is what a consumer receives anyway.
 *
 * Asserted by relating the workflow to `package.json` rather than by pinning a
 * literal here: a literal would be a third copy of the same fact, and the next
 * person to raise the floor would have two places to remember instead of one.
 */
describe("the node versions the package claims", () => {
  const floor = (
    JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
      engines: { node: string };
    }
  ).engines.node;

  it("state a lower bound at all", () => {
    expect(floor).toMatch(/^>=\d+\.\d+\.\d+$/);
  });

  /**
   * Something runs at exactly the promised number. Read out of `package.json` by
   * the job itself, so the assertion is that the job reads it — not that
   * somebody remembered to copy it.
   */
  it("are exercised at exactly that lower bound", () => {
    const steps = CI.jobs["floor"]?.steps ?? [];
    const reads = steps.some((step) => (step.run ?? "").includes("engines.node"));
    const uses = steps.some((step) =>
      String(step.with?.["node-version"] ?? "").includes("floor.outputs.version"),
    );

    expect(reads).toBe(true);
    expect(uses).toBe(true);
  });

  /**
   * And what runs there is the built package, not the sources. `engines` is a
   * statement about what gets published; a job that ran `vitest` on the floor
   * would be answering a question nobody asked.
   */
  it("run the built artifact on it, not the repository", () => {
    const commands = (CI.jobs["floor"]?.steps ?? []).map((step) => step.run ?? "").join("\n");

    expect(commands).toContain("dist/cli.js");
    expect(commands).not.toContain("pnpm run test");
  });

  /**
   * And at the open end. `>=22.12.0` names no upper bound, so it promises every
   * node above it; running only the floor and the LTS leaves the newest major —
   * the one a fresh `nvm install node` gives — promised and untested.
   */
  it("are exercised above the current LTS as well", () => {
    const entries = CI.jobs["check"]?.strategy?.matrix?.include ?? [];
    const majors = entries.map((one) => Number.parseInt(String(one["node"]), 10));
    const lowest = Number.parseInt(floor.replace(">=", ""), 10);

    expect(Math.max(...majors)).toBeGreaterThan(lowest + 2);
  });
});

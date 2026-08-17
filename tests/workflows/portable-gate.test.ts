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
 * Two assertions, and neither is a substitute for the other. The first is that
 * the scripts stay spellable on every platform — a guard that runs here, on any
 * machine, the moment somebody reaches for a shell command again. The second is
 * that a Windows job exists to actually run them, because the first only checks
 * a list of names somebody thought of, and the list is not the platform.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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

  /** And still on Linux, on both declared versions of node. */
  it("keeps running it on Linux, on every node the project supports", () => {
    const entries = CI.jobs["check"]?.strategy?.matrix?.include ?? [];
    const linux = entries.filter((one) => String(one["os"]).startsWith("ubuntu"));

    expect(linux.map((one) => one["node"]).sort()).toEqual([22, 24]);
  });
});

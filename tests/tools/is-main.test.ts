/**
 * "Was this file the one node was told to run?"
 *
 * Both polygons' `tokens.mjs` are a script and a module at once: `verify.mjs`
 * imports `provision` and `USERS` from them, and an operator runs the same file
 * to get tokens into the environment. The line that tells the two apart was
 *
 *   process.argv[1] === fileURLToPath(import.meta.url)
 *
 * which is false whenever the path goes through a symlink — `import.meta.url` is
 * resolved through symlinks by node, `process.argv[1]` is not. The script then
 * decided it had been imported, did nothing, printed nothing and exited 0. The
 * operator sees a successful run that produced no tokens and goes looking at the
 * platform. Found by the audit of 14 August 2026 (K-9).
 *
 * The failure is entirely in how the process was launched, so it is proved by
 * launching one: a symlink in a temporary directory, and the real script behind
 * it. A unit test over the helper alone would have said nothing about the two
 * files that had the bug.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { isMainModule } from "../../tools/is-main.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * A port nothing can be listening on without root, so the scripts fail on the
 * first request instead of touching a real deployment.
 *
 * What is under test is whether the program ran at all, not what it answered:
 * every path out of `main()` in both scripts writes to stderr and exits 2, and
 * the broken idiom writes nothing and exits 0. Those are what the assertions
 * tell apart.
 */
const NOWHERE = "http://127.0.0.1:1";

const workspace = mkdtempSync(join(tmpdir(), "barbican-is-main-"));

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

/** The script reached through a symlink, which is the whole point of the case. */
function throughSymlink(script: string, name: string): string {
  const link = join(workspace, name);
  symlinkSync(resolve(ROOT, script), link);
  return link;
}

describe("a polygon's tokens.mjs run as a program", () => {
  it.each([
    ["polygons/vampi/tokens.mjs", "vampi-tokens.mjs", "VAMPI_BASE_URL"],
    ["polygons/crapi/tokens.mjs", "crapi-tokens.mjs", "CRAPI_BASE_URL"],
  ])("does its work when %s is reached through a symlink", (script, name, variable) => {
    const result = spawnSync(process.execPath, [throughSymlink(script, name)], {
      env: { ...process.env, [variable]: NOWHERE },
      encoding: "utf8",
    });

    // It tried, and it said so. Silence with a 0 is the bug: the script decided
    // it had been imported and returned without a word.
    expect(result.stderr).toContain("tokens:");
    expect(result.status).toBe(2);
  });

  /**
   * And the other direction, which is what the check is there for: imported by
   * `verify.mjs`, the file must hand out its exports and do nothing else. A fix
   * that made `main()` run unconditionally would pass every assertion above.
   */
  it.each([["polygons/vampi/tokens.mjs"], ["polygons/crapi/tokens.mjs"]])(
    "stays silent when %s is imported instead",
    (script) => {
      // A file URL, not the path. An absolute path is a valid ESM specifier on
      // POSIX and not on Windows, where `D:\...` is read as the scheme `d:` and
      // the loader refuses it — so this spawned a process that died before
      // reaching the module, and the assertion "it printed nothing" was then
      // true of a stack trace it never saw. Which is the very defect the file
      // under test is about, made twice in a row: node resolves a path and a url
      // by different rules, and only one of them is portable.
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `await import(${JSON.stringify(pathToFileURL(resolve(ROOT, script)).href)})`,
        ],
        { env: { ...process.env }, encoding: "utf8" },
      );

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    },
  );
});

describe("isMainModule", () => {
  /** Under vitest the entry point is vitest, so no test file is the program. */
  it("is false for a module somebody else loaded", () => {
    expect(isMainModule(import.meta.url)).toBe(false);
  });

  /**
   * A url that resolves to no file at all. `realpath` throws on it, and a throw
   * here would take down whatever imported the module — the one thing a check
   * this incidental must never do.
   */
  it("is false rather than a throw when the url names no file", () => {
    expect(isMainModule("file:///barbican/no/such/file.mjs")).toBe(false);
    expect(isMainModule("data:text/javascript,export%20default%201")).toBe(false);
  });
});

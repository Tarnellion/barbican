/**
 * What `package.json` pins, what the lockfile resolved, and what is installed.
 *
 * Three places, one number each, and nothing compared them. On 19 August 2026 a
 * commit titled "TypeScript 7" moved `package.json` to 7.0.2, and the very next
 * commit — a documentation change, staged with `git add -A` — moved it back to
 * 6.0.3 along with the lockfile. Six documents went on claiming the migration
 * while the installed compiler was 6.0.3 and every "the gate is green under 7"
 * had been measured against whatever happened to be in `node_modules`.
 *
 * The mechanism was never established. That is the reason for a check rather
 * than a resolution to be careful: an unexplained revert that leaves the tree
 * self-consistent and the documents wrong is invisible to review, and this one
 * survived a full `pnpm run check`, a pre-commit hook and a reading of the diff.
 *
 * All three are compared, not just the compiler. The defect had nothing to do
 * with TypeScript — it is the shape of the failure that recurs, and a guard
 * written for one package is a guard that does not fire for the next one.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..", "..");

interface Manifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

function manifest(): Manifest {
  return JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as Manifest;
}

/**
 * The file `node_modules/.bin/tsc` runs, read out of the compiler's own manifest.
 *
 * Taken from `bin` rather than spelled out here, so the path stays one fact in
 * one place: a package that renamed or moved its entry point would fail this
 * loudly instead of leaving the assertion measuring some other compiler.
 */
function compilerEntry(): string {
  const installed = resolve(ROOT, "node_modules", "typescript");
  const bin = (
    JSON.parse(readFileSync(resolve(installed, "package.json"), "utf8")) as {
      bin?: { tsc?: string };
    }
  ).bin?.tsc;
  if (bin === undefined) {
    throw new Error("typescript declares no `tsc` entry under `bin`");
  }
  return resolve(installed, bin);
}

/** Every direct dependency and the version this repository pins for it. */
function pinned(): readonly [string, string][] {
  const declared = manifest();
  return [
    ...Object.entries(declared.dependencies ?? {}),
    ...Object.entries(declared.devDependencies ?? {}),
  ].sort(([left], [right]) => left.localeCompare(right));
}

/**
 * What the lockfile's importer records for a package.
 *
 * Read with a regular expression over the one block that describes this project's
 * own direct dependencies. Parsing the whole lockfile as YAML would be heavier
 * and would still need the same anchoring: the file repeats a package name in
 * several sections, and only the importer says what this repository asked for.
 */
function lockedSpecifiers(): ReadonlyMap<string, { specifier: string; version: string }> {
  const text = readFileSync(resolve(ROOT, "pnpm-lock.yaml"), "utf8");
  const locked = new Map<string, { specifier: string; version: string }>();
  for (const [, name, specifier, version] of text.matchAll(
    /^ {6}'?([^'\s:]+)'?:\n {8}specifier: (\S+)\n {8}version: (\S+)/gm,
  )) {
    if (name !== undefined && specifier !== undefined && version !== undefined) {
      locked.set(name, { specifier, version });
    }
  }
  return locked;
}

describe("the versions this repository pins", () => {
  const pins = pinned();

  it("are exact, with no range left in", () => {
    // A range would make the three numbers below legitimately differ, and the
    // comparison meaningless. CLAUDE.md asks for exact versions; this is where
    // that stops being a habit.
    const ranged = pins.filter(([, version]) => !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version));

    expect(ranged).toEqual([]);
  });

  it("are what the lockfile resolved", () => {
    const locked = lockedSpecifiers();
    // A regex that matched nothing would agree with any lockfile.
    expect(locked.size).toBeGreaterThanOrEqual(pins.length);

    // The resolved version carries a peer suffix where there are peers —
    // `12.1.0(openapi-types@12.1.3)` — so it is compared by prefix. The specifier
    // is the number this repository asked for and is compared whole.
    const disagreeing = pins
      .map(([name, version]) => ({ name, version, locked: locked.get(name) }))
      .filter(
        (row) =>
          row.locked?.specifier !== row.version ||
          !(
            row.locked?.version === row.version || row.locked?.version.startsWith(`${row.version}(`)
          ),
      );

    expect(disagreeing).toEqual([]);
  });

  it("are what is actually installed", () => {
    const wrong = pins
      .map(([name, version]) => {
        let installed: string | undefined;
        try {
          installed = (
            JSON.parse(
              readFileSync(resolve(ROOT, "node_modules", name, "package.json"), "utf8"),
            ) as { version?: string }
          ).version;
        } catch {
          installed = undefined;
        }
        return { name, pinned: version, installed };
      })
      .filter((row) => row.installed !== row.pinned);

    expect(wrong).toEqual([]);
  });

  /**
   * And the compiler in particular, by asking it rather than by reading a file.
   *
   * `node_modules/typescript/package.json` and `tsc --version` can disagree —
   * a stale binary, a shadowing install higher up the tree — and it is the second
   * one that decides what the gate actually checked.
   *
   * Spawned as node plus the compiler's own entry point, and not through the
   * launcher that was here first. On Windows npm installs that launcher as a
   * `.cmd` and a `.ps1` and there is no `.exe`, while libuv resolves a bare name
   * against `.com` and `.exe` only — so the call threw ENOENT and, with no
   * `try`/`catch` around it, took the job down with it. That was the state from
   * the day `windows-latest` joined the matrix; on macOS and Linux the same line
   * works, which is why nobody's machine said so. A shell would also have found
   * the `.cmd`, and would have put an argument string in front of `cmd.exe` to
   * parse — `process.execPath` needs no quoting rules to be right.
   *
   * What is asked is unchanged: the same file `pnpm run typecheck` reaches
   * through `node_modules/.bin`, answering with the version it reports itself.
   */
  it("include a compiler that reports the version it was pinned at", () => {
    const declared = manifest().devDependencies?.typescript;
    expect(declared).toBeDefined();

    const reported = execFileSync(process.execPath, [compilerEntry(), "--version"], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim();

    expect(reported).toBe(`Version ${declared}`);
  });
});

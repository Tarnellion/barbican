#!/usr/bin/env node

/**
 * The gitleaks on this machine is the gitleaks CI pins.
 *
 * `ci.yml` says beside the pin that "the version matches the local one so that
 * CI and pre-commit never differ in their verdicts", and nothing held that: the
 * local binary comes from Homebrew and updates whenever its owner runs `brew
 * upgrade`, while the pin in the workflow is a string somebody has to remember
 * to change. Two numbers in two places with a sentence promising they agree —
 * the shape this project keeps finding stale.
 *
 * Non-blocking on purpose, and this is the one judgement in the file. A
 * mismatch is not a hole: CI runs gitleaks over the full history on every push
 * and, since `release.yml` calls `ci.yml` whole, on every release too, so the
 * backstop holds whichever way the versions differ. What a mismatch costs is
 * that a commit passing here can fail there, or the reverse — a nuisance worth
 * a sentence and not worth blocking a commit over. A hook that refuses for a
 * reason the person cannot fix in the moment is a hook people learn to pass
 * `--no-verify` to, and that switch turns off the scan itself.
 *
 * A missing pin is different and does exit non-zero: that is this repository
 * being wrong rather than the machine, and it means the workflow no longer says
 * which version it installs.
 *
 * gitleaks being absent is deliberately silent here. The hook next to this one
 * fails hard in that case — see lefthook.yml — and two messages about one cause
 * is how a hook's output stops being read.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const WORKFLOW = resolve(ROOT, ".github/workflows/ci.yml");

/**
 * The version `ci.yml` installs, read from the workflow itself.
 *
 * Every job is searched rather than one named job: the name of a job is not a
 * contract, and a rename would leave this reading `undefined` and reporting
 * agreement with nothing at all.
 */
export function pinnedGitleaksVersion(text = readFileSync(WORKFLOW, "utf8")) {
  const workflow = parseYaml(text);
  for (const job of Object.values(workflow?.jobs ?? {})) {
    const pinned = job?.env?.GITLEAKS_VERSION;
    if (typeof pinned === "string" && pinned !== "") {
      return pinned;
    }
  }
  return undefined;
}

/** What `gitleaks version` prints, or `undefined` when it is not installed. */
function installedGitleaksVersion() {
  try {
    return execFileSync("gitleaks", ["version"], { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pinned = pinnedGitleaksVersion();
  if (pinned === undefined) {
    process.stderr.write(
      `No GITLEAKS_VERSION in ${WORKFLOW}. CI no longer states which gitleaks it ` +
        `installs, so nothing here can agree with it.\n`,
    );
    process.exit(1);
  }

  const installed = installedGitleaksVersion();
  if (installed !== undefined && installed !== pinned) {
    process.stderr.write(
      `gitleaks ${installed} locally, ${pinned} pinned in ci.yml. The two scan with ` +
        `different rules, so this commit can pass here and fail there, or the ` +
        `reverse. Not blocking — CI scans the full history either way. To settle ` +
        `it: \`brew upgrade gitleaks\`, then set GITLEAKS_VERSION and ` +
        `GITLEAKS_SHA256 in .github/workflows/ci.yml to match.\n`,
    );
  }
}

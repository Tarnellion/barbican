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
 * Non-blocking on purpose, and this is the one judgement in the file. A hook
 * that refuses for a reason the person cannot fix in the moment is a hook people
 * learn to pass `--no-verify` to, and that switch turns off the scan itself.
 *
 * The first version of this comment justified it with "CI runs gitleaks over the
 * full history on every push", and that is not what `ci.yml` says: it runs on
 * pushes to `main` and on pull requests. A push to a branch with no pull request
 * is not scanned at all. Corrected on 19 August 2026 by adversarial review.
 *
 * Which makes the two directions unequal, and the message says which one this is.
 * A local gitleaks **newer** than the pin scans with rules CI does not have yet:
 * noise, nothing more. A local one **older** scans with fewer rules than CI, so a
 * secret this hook waves through is one CI would have caught — and this
 * repository is public, so by the time CI says so the secret is published and the
 * answer is rotation, not a fix. Still not blocking, because `brew upgrade
 * gitleaks` is a fix the committer can reach for and the sentence says so; but it
 * is a different sentence.
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
  let workflow;
  try {
    workflow = parseYaml(text);
  } catch {
    // A workflow being edited is not this hook's business. Thrown from here it
    // reached lefthook as an unhandled rejection and failed the commit — which is
    // exactly the refusal the comment above promises never to make, over a file
    // the commit may not even touch.
    return undefined;
  }
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

/**
 * Whether `left` is an earlier release than `right`. Both are `x.y.z`.
 *
 * @param {string} left
 * @param {string} right
 */
function isOlder(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let part = 0; part < 3; part += 1) {
    if ((a[part] ?? 0) !== (b[part] ?? 0)) {
      return (a[part] ?? 0) < (b[part] ?? 0);
    }
  }
  return false;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Read and parsed here rather than inside the reader, because the two failures
  // are different. A workflow that cannot be read or parsed is a file mid-edit,
  // and this hook has no business failing a commit over it — silence, like a
  // gitleaks that is not installed. A workflow that parses and carries no pin is
  // this repository being wrong, and that is worth an exit code.
  let text;
  try {
    text = readFileSync(WORKFLOW, "utf8");
    parseYaml(text);
  } catch {
    process.exit(0);
  }

  const pinned = pinnedGitleaksVersion(text);
  if (pinned === undefined) {
    process.stderr.write(
      `No GITLEAKS_VERSION in ${WORKFLOW}. CI no longer states which gitleaks it ` +
        `installs, so nothing here can agree with it.\n`,
    );
    process.exit(1);
  }

  const installed = installedGitleaksVersion();
  if (installed !== undefined && installed !== pinned) {
    const behind = isOlder(installed, pinned);
    process.stderr.write(
      `gitleaks ${installed} locally, ${pinned} pinned in ci.yml. ` +
        (behind
          ? `Yours is the older one, so this hook scans with fewer rules than CI: a ` +
            `secret it waves through is one CI would catch, and CI runs on pushes to ` +
            `main and on pull requests — not on every push. This repository is ` +
            `public, so that is a rotation and not a fix. \`brew upgrade gitleaks\`.`
          : `Yours is the newer one, which only means you may see findings CI does ` +
            `not. Set GITLEAKS_VERSION and GITLEAKS_SHA256 in ` +
            `.github/workflows/ci.yml to match when convenient.`) +
        `\n`,
    );
  }
}

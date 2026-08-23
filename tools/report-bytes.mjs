#!/usr/bin/env node

/**
 * The reports of the reference platform, reduced to one digest per combination.
 *
 * "The report is the same bytes over all 29 combinations" is the claim a
 * refactor of this tool has to make, and it is the claim that would have caught
 * most of what the audits of 20-23 August 2026 found — a run identifier written
 * onto the report after its own hash was taken, a set of conditions named
 * `__proto__` vanishing from the coverage, a finding pointing at a different
 * cell. `polygon/verify.mjs` cannot make it: it compares which cells are broken
 * against the ground truth, which is a statement about detection, not about the
 * document. Twice the byte comparison was made by hand instead, once per
 * refactor, by reading two directories of reports — and nothing repeated it.
 *
 * This is that comparison as a command. Run it on the revision before a change
 * and on the revision after, and diff the two manifests:
 *
 *   node tools/report-bytes.mjs --write before.manifest      # on the old tree
 *   node tools/report-bytes.mjs --baseline before.manifest   # on the new one
 *
 * It is **not** part of `pnpm run check`. It brings the platform up 29 times and
 * walks the whole matrix against each: about two minutes on the author's machine,
 * against seventeen seconds for the whole test suite. A gate people wait two
 * minutes for on every commit is a gate they learn to skip.
 *
 * Zero dependencies, built-in modules only, and the polygon does the work: this
 * file runs `polygon/verify.mjs --keep-reports` and reads what it left.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const VERIFY = join(REPO_ROOT, "polygon", "verify.mjs");

/**
 * What differs between two runs of the same declaration against the same
 * platform, and therefore says nothing about a refactor.
 *
 * By key name and everywhere in the document, not by path: the report is nested
 * and a path list would have to be re-checked against every schema change, which
 * is the kind of second copy this repository keeps finding wrong. A key name
 * that starts carrying something else is a change to the schema, and the schema
 * has its own gate.
 */
const VOLATILE = new Set([
  // Minted per run (ADR-0045), and by design not derivable from anything else.
  "runId",
  // Wall clock, three ways.
  "startedAt",
  "finishedAt",
  "at",
  "durationMs",
  // The response header the platform stamps with the time it answered.
  "date",
  // A hash over everything above (ADR-0058): it moves when they do.
  "contentDigest",
]);

/**
 * The salted body digests, compared by their equality relation rather than by
 * value.
 *
 * The salt is per run, so two runs of one platform produce different numbers for
 * the same body — and what the isolation checks read is not the number but
 * whether two of them are equal. Each distinct value becomes the index at which
 * it first appeared, in document order, so "these two tenants saw the same list"
 * survives the normalisation and the value does not.
 *
 * @param {unknown} value
 * @param {Map<number, number>} digests
 * @returns {unknown}
 */
function normalize(value, digests) {
  if (Array.isArray(value)) {
    return value.map((one) => normalize(one, digests));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    if (VOLATILE.has(key)) {
      out[key] = `<${key}>`;
    } else if (key === "digest" && typeof inner === "number") {
      if (!digests.has(inner)) {
        digests.set(inner, digests.size);
      }
      out[key] = `<digest ${digests.get(inner)}>`;
    } else {
      out[key] = normalize(inner, digests);
    }
  }
  return out;
}

/**
 * The digest of one report, over the document with the volatile parts named.
 *
 * @param {unknown} report
 * @returns {string}
 */
function digestOf(report) {
  return createHash("sha256")
    .update(JSON.stringify(normalize(report, new Map())))
    .digest("hex")
    .slice(0, 32);
}

/**
 * Runs the oracle, streaming its output, and returns where it left the reports.
 *
 * @param {readonly string[]} passthrough
 * @returns {Promise<{ directory: string, code: number | null }>}
 */
function runOracle(passthrough) {
  return new Promise((settle, fail) => {
    // `process.execPath` rather than "node": a bare name is resolved by the
    // operating system, and on Windows libuv looks for `.com` and `.exe` only.
    // `tests/workflows/portable-gate.test.ts` holds this, and held it here.
    const child = spawn(process.execPath, [VERIFY, "--keep-reports", ...passthrough], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let text = "";
    child.stdout.on("data", (chunk) => {
      text += String(chunk);
      process.stdout.write(chunk);
    });
    child.on("error", fail);
    child.on("close", (code) => {
      const where = /The reports are kept in (.+)\n/.exec(text);
      if (where === null || where[1] === undefined) {
        fail(new Error("the oracle did not say where it kept the reports"));
        return;
      }
      settle({ directory: where[1], code });
    });
  });
}

const argv = process.argv.slice(2);
/** @param {string} name */
const optionValue = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};
const write = optionValue("--write");
const baseline = optionValue("--baseline");
// Anything that is not one of ours goes to the oracle: a combination filter is
// useful while working on one, and a manifest of a subset is still a manifest.
const passthrough = argv.filter(
  (one, index) =>
    one !== "--write" &&
    one !== "--baseline" &&
    argv[index - 1] !== "--write" &&
    argv[index - 1] !== "--baseline",
);

const { directory, code } = await runOracle(passthrough);

let manifest = "";
try {
  const files = (await readdir(directory))
    .filter((/** @type {string} */ name) => name.endsWith(".report.json"))
    .sort();
  const lines = [];
  for (const name of files) {
    const report = JSON.parse(await readFile(join(directory, name), "utf8"));
    lines.push(`${digestOf(report)}  ${name.replace(".report.json", "")}`);
  }
  manifest = `${lines.join("\n")}\n`;
} finally {
  // The reports carry every address the run touched and every identifier it
  // named. They were a debugging aid here and are removed, the way the oracle
  // removes them when it is not asked to keep them.
  await rm(directory, { recursive: true, force: true });
}

process.stdout.write(
  `\nNormalised report digests (${manifest.trim().split("\n").length}):\n${manifest}`,
);

if (write !== undefined) {
  await writeFile(write, manifest, "utf8");
  process.stdout.write(`Written to ${write}\n`);
}

if (baseline !== undefined) {
  const expected = await readFile(baseline, "utf8");
  if (expected === manifest) {
    process.stdout.write(`\nEvery report is byte-identical to ${baseline} once normalised.\n`);
  } else {
    const was = new Map(
      expected
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => [line.slice(34), line.slice(0, 32)]),
    );
    const now = new Map(
      manifest
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => [line.slice(34), line.slice(0, 32)]),
    );
    for (const id of new Set([...was.keys(), ...now.keys()])) {
      if (was.get(id) !== now.get(id)) {
        process.stdout.write(
          `  DIFFERS: ${id} (${was.get(id) ?? "absent"} -> ${now.get(id) ?? "absent"})\n`,
        );
      }
    }
    process.stdout.write(`\nMISMATCH: the reports are not what ${baseline} recorded.\n`);
    process.exitCode = 1;
  }
}

// The oracle's own verdict still stands: a manifest of 29 reports that disagree
// with the ground truth is 29 digests of the wrong document.
if (code !== 0) {
  process.stdout.write(`\nThe oracle itself ended with ${code}: read its mismatches above.\n`);
  process.exitCode = code;
}

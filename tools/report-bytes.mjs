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
 * `tests/tools/report-bytes.test.ts` holds everything in it that is a decision
 * rather than a process.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isMainModule } from "./is-main.mjs";

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
 *
 * **This is a denylist and it stays one, which is the opposite of what
 * `VALUE_PRESERVED_HEADERS` did with the same argument** (ADR-0005 addendum), so
 * the difference is worth being explicit about. There the allowlist was
 * available: the few header values a verdict needs can be enumerated, and the
 * ones that will ever carry a secret cannot. Here the inverse list is the report
 * schema in full — every key path the document has — and that list already
 * exists, once, as `tests/report/report-shape.json`. Writing it out a second
 * time inside this tool is the duplication ADR-0064 is about.
 *
 * What a denylist costs is that its two failure modes are not symmetric. A name
 * **missing** from it is loud: two runs disagree and the manifest says so. A
 * name **added** to it is silent — the values stop being compared and both sides
 * agree about a document neither looked at. Three things answer for that:
 *
 * - every entry carries the reason it is here, and
 *   `tests/tools/report-bytes.test.ts` holds the table exact in both directions;
 * - the manifest carries a census — how many values each name masked, over all
 *   the reports — so a name added later changes the manifest even when the
 *   digests do not, and `--baseline` prints it;
 * - a name that masked nothing at all is reported, because it is either a typo
 *   or a field the report no longer has.
 *
 * What none of that answers for: whether a name in this table is **really**
 * volatile. Proving that needs two runs of the same tree, and this tool makes
 * one. A field wrongly listed here is a field two revisions will never be
 * compared on.
 */
export const VOLATILE = Object.freeze({
  // Minted per run (ADR-0045), and by design not derivable from anything else.
  runId: "minted per run",
  // Wall clock, three ways.
  startedAt: "wall clock",
  finishedAt: "wall clock",
  at: "wall clock",
  durationMs: "wall clock",
  // The response header the platform stamps with the time it answered. It
  // reaches the report because `VALUE_PRESERVED_HEADERS` in
  // `src/adapters/http.ts` keeps it — "the only handle for matching a finding
  // against the server log".
  date: "the response header the platform stamps with the time it answered",
  // A hash over everything above (ADR-0058): it moves when they do.
  contentDigest: "a hash over the fields above",
});

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
 * `Object.fromEntries` and not an object literal that is assigned into. Writing
 * `out[key] = …` on a `{}` swallows a key named `__proto__` — it walks into the
 * setter instead of defining a property — so a set of request conditions called
 * `__proto__` vanished from the normalised document entirely, which is the exact
 * defect this tool exists to have caught in the report. `Object.fromEntries`
 * defines own properties and keeps it. See ADR-0024 for the rule this is an
 * instance of.
 *
 * @param {unknown} value
 * @param {Map<number, number>} digests
 * @param {Map<string, number>} [census] how many values each name masked
 * @returns {unknown}
 */
export function normalize(value, digests, census = new Map()) {
  if (Array.isArray(value)) {
    return value.map((one) => normalize(one, digests, census));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => {
      if (Object.hasOwn(VOLATILE, key)) {
        census.set(key, (census.get(key) ?? 0) + 1);
        return [key, `<${key}>`];
      }
      if (key === "digest" && typeof inner === "number") {
        if (!digests.has(inner)) {
          digests.set(inner, digests.size);
        }
        return [key, `<digest ${digests.get(inner)}>`];
      }
      return [key, normalize(inner, digests, census)];
    }),
  );
}

/**
 * The digest of one report, over the document with the volatile parts named.
 *
 * @param {unknown} report
 * @param {Map<string, number>} [census]
 * @returns {string}
 */
export function digestOf(report, census) {
  return createHash("sha256")
    .update(JSON.stringify(normalize(report, new Map(), census)))
    .digest("hex")
    .slice(0, 32);
}

/**
 * The census, as the lines that go at the head of a manifest.
 *
 * Every name in {@link VOLATILE} gets a line whether it masked anything or not:
 * a zero is the interesting case, and a line that disappears when a count drops
 * to nothing would hide it.
 *
 * @param {Map<string, number>} census
 * @returns {string}
 */
export function censusLines(census) {
  return Object.keys(VOLATILE)
    .sort()
    .map((name) => `masked ${name} ${census.get(name) ?? 0}\n`)
    .join("");
}

/**
 * One manifest: the census, then a digest per report.
 *
 * @param {readonly { readonly name: string, readonly report: unknown }[]} reports
 * @returns {string}
 */
export function manifestOf(reports) {
  /** @type {Map<string, number>} */
  const census = new Map();
  const lines = [...reports]
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .map(({ name, report }) => `${digestOf(report, census)}  ${name}\n`)
    .join("");
  return `${censusLines(census)}${lines}`;
}

/**
 * What two manifests disagree about, as lines a reader can act on.
 *
 * The census is compared as well as the digests, and separately: two revisions
 * whose digests agree because one of them stopped comparing a field is the
 * failure mode a denylist has, and it shows up here and nowhere else.
 *
 * @param {string} expected
 * @param {string} actual
 * @returns {readonly string[]}
 */
export function manifestDifferences(expected, actual) {
  /** @param {string} text */
  const nonEmpty = (text) => text.split("\n").filter((line) => line !== "");
  /** @param {string} text */
  const censusOf = (text) =>
    new Map(
      nonEmpty(text)
        .filter((line) => line.startsWith("masked "))
        .map((line) => {
          const [, name, count] = line.split(" ");
          return [name ?? "", count ?? ""];
        }),
    );
  /** @param {string} text */
  const digestsOf = (text) =>
    new Map(
      nonEmpty(text)
        .filter((line) => !line.startsWith("masked "))
        .map((line) => [line.slice(34), line.slice(0, 32)]),
    );

  /** @type {string[]} */
  const differences = [];
  const wasMasked = censusOf(expected);
  const nowMasked = censusOf(actual);
  for (const name of new Set([...wasMasked.keys(), ...nowMasked.keys()])) {
    if (wasMasked.get(name) !== nowMasked.get(name)) {
      differences.push(
        `  MASKING: ${name} (${wasMasked.get(name) ?? "not in the list"} -> ` +
          `${nowMasked.get(name) ?? "not in the list"} values). A field that stopped being ` +
          `compared makes the digests below agree about something neither side read.`,
      );
    }
  }
  const was = digestsOf(expected);
  const now = digestsOf(actual);
  for (const id of new Set([...was.keys(), ...now.keys()])) {
    if (was.get(id) !== now.get(id)) {
      differences.push(
        `  DIFFERS: ${id} (${was.get(id) ?? "absent"} -> ${now.get(id) ?? "absent"})`,
      );
    }
  }
  return differences;
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

async function main() {
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
    /** @type {{ name: string, report: unknown }[]} */
    const reports = [];
    for (const name of files) {
      reports.push({
        name: name.replace(".report.json", ""),
        report: JSON.parse(await readFile(join(directory, name), "utf8")),
      });
    }
    manifest = manifestOf(reports);
  } finally {
    // The reports carry every address the run touched and every identifier it
    // named. They were a debugging aid here and are removed, the way the oracle
    // removes them when it is not asked to keep them.
    await rm(directory, { recursive: true, force: true });
  }

  process.stdout.write(`\nNormalised report digests, and what was not compared:\n${manifest}`);
  for (const [name, reason] of Object.entries(VOLATILE)) {
    if (!new RegExp(`^masked ${name} [1-9]`, "m").test(manifest)) {
      process.stdout.write(
        `\nNOTHING MASKED: "${name}" (${reason}) matched no key in any report. Either the ` +
          `report no longer carries it, or the run was filtered down to combinations that ` +
          `do not.\n`,
      );
    }
  }

  if (write !== undefined) {
    await writeFile(write, manifest, "utf8");
    process.stdout.write(`Written to ${write}\n`);
  }

  if (baseline !== undefined) {
    const expected = await readFile(baseline, "utf8");
    const differences = manifestDifferences(expected, manifest);
    if (differences.length === 0) {
      process.stdout.write(`\nEvery report is byte-identical to ${baseline} once normalised, `);
      process.stdout.write("and the same fields were compared on both sides.\n");
    } else {
      process.stdout.write(`\n${differences.join("\n")}\n`);
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
}

if (isMainModule(import.meta.url)) {
  await main();
}

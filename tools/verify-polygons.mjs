/**
 * Every ground truth this project has, run one after another.
 *
 * Four oracles exist — the reference platform in `polygon/`, and VAmPI, crAPI and
 * Juice Shop in `polygons/` — and until 24 August 2026 each was a command
 * somebody had to remember. The consequence was measured rather than imagined:
 * crAPI went eleven days without a run while `plan.md` said it had never had one,
 * and the whole of the module-cutting week happened over it unverified.
 *
 * Not in `pnpm run check` and not in CI, for the reason the table in `CLAUDE.md`
 * gives about the reference platform: this brings four deployments up. Measured
 * on 24 August 2026 — VAmPI 8 s, Juice Shop 54 s, the reference platform about
 * two minutes, and crAPI about five, plus an external clone it needs and about
 * 2.5 GB of images. It is the thing to run after a week of work, not before a
 * commit.
 *
 * crAPI is skipped unless `CRAPI_DEPLOY_DIR` is set, because its `deploy/docker`
 * is not vendored here — it is an external project under its own licence. A skip
 * is printed and counted; it is never silent, which is the property that failed
 * when nothing ran at all.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** @type {readonly {name: string, script: string, needs?: string}[]} */
const ORACLES = [
  { name: "the reference platform", script: "polygon/verify.mjs" },
  { name: "VAmPI", script: "polygons/vampi/verify.mjs" },
  { name: "Juice Shop", script: "polygons/juice-shop/verify.mjs" },
  { name: "crAPI", script: "polygons/crapi/verify.mjs", needs: "CRAPI_DEPLOY_DIR" },
];

const results = [];
for (const oracle of ORACLES) {
  const path = join(ROOT, oracle.script);
  if (!existsSync(path)) {
    console.error(`${oracle.name}: ${oracle.script} is not there`);
    results.push({ name: oracle.name, state: "missing" });
    continue;
  }
  if (oracle.needs !== undefined && process.env[oracle.needs] === undefined) {
    console.log(`\n=== ${oracle.name}: skipped, ${oracle.needs} is not set ===`);
    results.push({ name: oracle.name, state: "skipped" });
    continue;
  }
  console.log(`\n=== ${oracle.name} ===`);
  const started = process.hrtime.bigint();
  const run = spawnSync(process.execPath, [path], { cwd: ROOT, stdio: "inherit" });
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  results.push({
    name: oracle.name,
    state: run.status === 0 ? "matched" : "MISMATCHED",
    seconds,
  });
}

console.log("\n--- every ground truth ---");
for (const one of results) {
  const time = one.seconds === undefined ? "" : ` (${one.seconds.toFixed(0)} s)`;
  console.log(`  ${one.name}: ${one.state}${time}`);
}

const bad = results.filter((one) => one.state === "MISMATCHED" || one.state === "missing");
if (bad.length > 0) {
  console.error(`\n${bad.length} of ${results.length} did not match.`);
  process.exitCode = 1;
}

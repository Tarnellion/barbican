#!/usr/bin/env node

/**
 * What is behind, and what the cooldown is holding.
 *
 * `pnpm update` answers neither. Measured on 18 August 2026: it printed
 * "Lockfile passes supply-chain policies" and "Already up to date" while three
 * dependencies had newer versions, every one of them past the seven-day
 * threshold. The reason is not the cooldown — this project pins exact versions,
 * so nothing is ever in range and `update` has nothing to move. The message is
 * accurate about what it did and reads as an all-clear about what there is.
 *
 * `pnpm outdated` does not answer them either, and that is the part worth
 * knowing. It reports the newest version the cooldown allows, not the newest
 * published: with the window widened to 41 days as an experiment, `@types/node`
 * changed from "26.2.0 available" to "26.1.0 available" — 26.2.0 being 10 days
 * old — and the two packages whose only newer versions were younger than the
 * window disappeared from the list altogether. So the tool that exists to say
 * what is behind hides exactly the versions a cooldown is holding. That is why
 * this asks the registry rather than reading `pnpm outdated`: a report built on
 * it could never print the middle state, and a state that cannot be reached is
 * not a state, it is a comment.
 *
 * Three states, and the whole point is telling them apart:
 *
 * - **nothing newer** — the dependency is at the latest published version;
 * - **available** — a newer version exists and is older than `minimumReleaseAge`,
 *   so the only thing between here and there is a person deciding;
 * - **held** — a newer version exists and is younger than the threshold, with the
 *   date it becomes installable.
 *
 * Run by hand, and deliberately not part of `check`. It needs the network and it
 * goes red the day any dependency publishes, which in a gate is noise — and a
 * gate that is red for a reason nobody is expected to fix today is a gate people
 * stop reading.
 *
 * The publication date comes from the registry, the threshold from
 * `pnpm-workspace.yaml`. Neither is retyped here: a copy of the threshold in this
 * file is exactly the kind of second number this project keeps finding stale.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

/**
 * @typedef {object} CooldownPolicy
 * @property {number} windowMs how old a version must be before it may be installed
 * @property {ReadonlySet<string>} excluded entries of the form `pkg@1.2.3`, exempt
 *   from the wait one version at a time
 *
 * @typedef {object} CooldownVerdict
 * @property {"available" | "held" | "unknown"} state
 * @property {Date} [eligibleAt] when the wait ends; absent when there is nothing
 *   to wait for or nothing to compute it from
 * @property {string} [reason] why, when the state does not follow from a date
 *
 * @typedef {object} OutdatedEntry
 * @property {string} current
 * @property {string} latest
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = process.env.npm_config_registry ?? "https://registry.npmjs.org";

/**
 * The cooldown as configured, in milliseconds, with the packages exempt from it.
 *
 * `minimumReleaseAgeExclude` holds entries like `pkg@1.2.3` — an emergency patch
 * let through one at a time. A package named there is never reported as held,
 * because it is not.
 */
/**
 * @param {string} [text]
 * @returns {CooldownPolicy}
 */
export function cooldownPolicy(text = readFileSync(resolve(ROOT, "pnpm-workspace.yaml"), "utf8")) {
  const workspace = parseYaml(text);
  const minutes = workspace?.minimumReleaseAge;
  if (typeof minutes !== "number") {
    throw new Error("pnpm-workspace.yaml declares no minimumReleaseAge");
  }
  return {
    windowMs: minutes * 60 * 1000,
    excluded: new Set(/** @type {string[]} */ (workspace?.minimumReleaseAgeExclude ?? [])),
  };
}

/**
 * Where one candidate stands, from its publication date alone.
 *
 * Separated from the fetching so that it can be tested without a network: the
 * three states are the thing worth being sure about, and a test that needs the
 * registry to check them would be testing the registry.
 */
/**
 * @param {object} candidate
 * @param {string} candidate.name
 * @param {string} candidate.version
 * @param {string | undefined} candidate.publishedAt
 * @param {Date} candidate.now
 * @param {CooldownPolicy} candidate.policy
 * @returns {CooldownVerdict}
 */
export function cooldownVerdict({ name, version, publishedAt, now, policy }) {
  // A `Set`, so the lookup is by value and not by property name: the keys here
  // are package names this project did not choose, and `in` over a plain object
  // answers for `constructor` (ADR-0024).
  if (policy.excluded.has(`${name}@${version}`)) {
    return { state: "available", reason: "listed in minimumReleaseAgeExclude" };
  }
  if (publishedAt === undefined) {
    return { state: "unknown", reason: "the registry gives no publication date for it" };
  }
  const eligibleAt = new Date(Date.parse(publishedAt) + policy.windowMs);
  if (eligibleAt.getTime() <= now.getTime()) {
    return { state: "available", eligibleAt };
  }
  return { state: "held", eligibleAt };
}

/**
 * The direct dependencies and the versions this repository pins.
 *
 * package.json and not the lockfile: this is about the versions a person chose
 * and would have to change, not about the tree resolved underneath them. The
 * pins are exact — see CLAUDE.md — so the string is a version and not a range.
 *
 * @returns {readonly [string, string][]}
 */
function pinned() {
  const manifest =
    /** @type {{ dependencies?: Record<string, string>, devDependencies?: Record<string, string> }} */ (
      JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"))
    );
  return [
    ...Object.entries(manifest.dependencies ?? {}),
    ...Object.entries(manifest.devDependencies ?? {}),
  ].sort(([left], [right]) => left.localeCompare(right));
}

/**
 * What the registry currently calls the latest version, and when it was published.
 *
 * `dist-tags.latest` and not the newest entry in `time`: a package may publish a
 * `next` or a patch to an old line, and neither is what an update would move to.
 *
 * @param {string} name
 * @returns {Promise<{ version?: string | undefined, publishedAt?: string | undefined }>}
 */
async function latestOf(name) {
  const response = await fetch(`${REGISTRY}/${name.split("/").map(encodeURIComponent).join("/")}`);
  if (!response.ok) {
    return {};
  }
  const meta =
    /** @type {{ "dist-tags"?: Record<string, string>, time?: Record<string, string> }} */ (
      await response.json()
    );
  const version = meta["dist-tags"]?.latest;
  return version === undefined ? {} : { version, publishedAt: meta.time?.[version] };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Piping this into `head` closes the pipe halfway through, and an unhandled
  // EPIPE ends a report with a stack trace over the lines it did print.
  process.stdout.on("error", (error) => {
    if (error.code !== "EPIPE") {
      throw error;
    }
  });

  const policy = cooldownPolicy();
  const now = new Date();
  const days = policy.windowMs / 86_400_000;
  /** @type {[string, string, string, string][]} */
  const lines = [];

  for (const [name, version] of pinned()) {
    const latest = await latestOf(name);
    if (latest.version === undefined) {
      lines.push([name, version, "?", "unknown: the registry did not answer for it"]);
      continue;
    }
    if (latest.version === version) {
      continue;
    }
    const verdict = cooldownVerdict({
      name,
      version: latest.version,
      publishedAt: latest.publishedAt,
      now,
      policy,
    });
    const said =
      verdict.state === "held" && verdict.eligibleAt !== undefined
        ? `held until ${verdict.eligibleAt.toISOString().slice(0, 10)}`
        : verdict.state === "unknown"
          ? `unknown: ${verdict.reason}`
          : `available${verdict.reason === undefined ? "" : ` (${verdict.reason})`}`;
    lines.push([name, version, latest.version, said]);
  }

  if (lines.length === 0) {
    process.stdout.write("Every direct dependency is pinned at the registry's latest.\n");
    process.exit(0);
  }

  process.stdout.write(
    `${lines.length} behind the latest, against a cooldown of ${days} days:\n\n`,
  );
  for (const [name, from, to, said] of lines) {
    process.stdout.write(`  ${name.padEnd(24)} ${`${from} -> ${to}`.padEnd(22)} ${said}\n`);
  }
  process.stdout.write(
    `\nNothing here updates itself: versions are pinned exactly, so \`pnpm update\` ` +
      `has nothing in range to move and says "Already up to date" whatever this list ` +
      `holds. "available" is a decision to make, not a job that failed; "held" is the ` +
      `cooldown doing its work, and the date is when it stops.\n`,
  );
}

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
  if (Number.isNaN(Date.parse(publishedAt))) {
    // Neither available nor held: a date that does not parse is the registry
    // answering with something this cannot reason about, and folding it into
    // either side would let an unaged version through or name a date that is not
    // a date. The printer would then call `toISOString` on it and take the whole
    // report down.
    return {
      state: "unknown",
      reason: `the registry gave "${publishedAt}" as its publication date`,
    };
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

/** `1.2.3` and nothing else: a prerelease is not what an update moves to. */
const RELEASE = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * Whether `candidate` is a later release than `current`, by version and not by date.
 *
 * By date would be wrong in the one case that matters: a patch to an old line
 * published after a new major would then be recommended as an upgrade while being
 * a downgrade.
 *
 * @param {string} candidate
 * @param {string} current
 */
function isLater(candidate, current) {
  const left = RELEASE.exec(candidate);
  const right = RELEASE.exec(current);
  if (left === null || right === null) {
    return false;
  }
  for (let part = 1; part <= 3; part += 1) {
    const a = Number(left[part]);
    const b = Number(right[part]);
    if (a !== b) {
      return a > b;
    }
  }
  return false;
}

/**
 * One value out of a record whose keys somebody else chose.
 *
 * The registry picks these — they are version strings and tag names — so a plain
 * lookup answers for `constructor` and every check downstream reasons about a
 * function. ADR-0024.
 *
 * @param {Record<string, unknown>} record
 * @param {string} key
 */
function tabled(record, key) {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/**
 * What the registry calls latest, when it was published, and what is installable now.
 *
 * The third field answers the question the middle state raises, and it was
 * missing. Reporting `dist-tags.latest` alone gave worse advice than
 * `pnpm outdated` in exactly the case this tool exists for: on 19 August 2026 it
 * printed "@biomejs/biome 2.5.7 -> 2.5.9 held until 2026-08-24" and never
 * mentioned 2.5.8, published eight days earlier and installable that morning. A
 * reader took "the cooldown is holding it" and deferred an update that was
 * available — the reverse of what this is for.
 *
 * `dist-tags.latest` stays the headline: a package may publish a `next` or a
 * patch to an old line, and neither is what an update moves to. `installable` is
 * the newest plain release past the window that is later than what is pinned.
 *
 * The full document is fetched, and the obvious economy does not apply. npm's
 * abbreviated metadata — `application/vnd.npm.install-v1+json`, half the size —
 * carries no `time` field at all, and `time` is the one thing this tool is about.
 * Measured on 19 August 2026: abbreviated 0.17 MB with no dates, full 0.35 MB
 * with them. Written down because the header looks like free savings and costs
 * every verdict.
 *
 * @param {string} name
 * @param {string} pinnedVersion
 * @param {CooldownPolicy} policy
 * @param {Date} now
 * @returns {Promise<{ version?: string | undefined, publishedAt?: string | undefined, installable?: string | undefined }>}
 */
async function latestOf(name, pinnedVersion, policy, now) {
  const response = await fetch(`${REGISTRY}/${name.split("/").map(encodeURIComponent).join("/")}`);
  if (!response.ok) {
    return {};
  }
  let meta;
  try {
    meta = await response.json();
  } catch {
    // A proxy answering 200 with an error page. One unreadable package must not
    // take the whole report down with it.
    return {};
  }
  if (meta === null || typeof meta !== "object") {
    return {};
  }
  const tags = /** @type {Record<string, unknown>} */ (
    Object.hasOwn(meta, "dist-tags") ? Reflect.get(meta, "dist-tags") : {}
  );
  const times = /** @type {Record<string, unknown>} */ (
    Object.hasOwn(meta, "time") ? Reflect.get(meta, "time") : {}
  );
  const publishedOf = (/** @type {string} */ version) => {
    const at = tabled(times, version);
    return typeof at === "string" ? at : undefined;
  };

  const tag = tabled(tags, "latest");
  if (typeof tag !== "string") {
    return {};
  }

  let installable;
  for (const candidate of Object.keys(times)) {
    if (!RELEASE.test(candidate) || !isLater(candidate, pinnedVersion)) {
      continue;
    }
    const at = publishedOf(candidate);
    if (at === undefined || Number.isNaN(Date.parse(at))) {
      continue;
    }
    if (Date.parse(at) + policy.windowMs > now.getTime()) {
      continue;
    }
    if (installable === undefined || isLater(candidate, installable)) {
      installable = candidate;
    }
  }

  return { version: tag, publishedAt: publishedOf(tag), installable };
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
    const latest = await latestOf(name, version, policy, now);
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
    // The held state names what can be installed today as well as what cannot.
    // Saying only "held" there is the reverse of this tool's purpose: the reader
    // defers an update that is available.
    const alsoInstallable =
      latest.installable === undefined || latest.installable === latest.version
        ? ""
        : `; installable now: ${latest.installable}`;
    const said =
      verdict.state === "held" && verdict.eligibleAt !== undefined
        ? `held until ${verdict.eligibleAt.toISOString().slice(0, 10)}${alsoInstallable}`
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

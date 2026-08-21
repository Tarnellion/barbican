#!/usr/bin/env node

/**
 * The four questions only a release can be asked.
 *
 * `release.yml` calls `ci.yml` whole, so a tag is gated by everything a pull
 * request is gated by. That covers the tree. It says nothing about the tag,
 * because on a pull request there is no tag — and the audit of 20 August 2026
 * found every question about one either unasked or unheld:
 *
 * - **The tag against `package.json`.** The one check that existed. It was named
 *   in no assertion anywhere, so deleting the step left the whole suite green:
 *   a gate that does not hold itself, which is the defect this repository has
 *   now found in its own CI four times.
 * - **The commit under the tag.** The trigger is `v*` and nothing compared the
 *   commit with `main`. A tag on a branch that never merged publishes with
 *   provenance attesting to a repository whose `main` never held that code.
 * - **The dist-tag.** `npm publish` with no `--tag` writes `latest`, and
 *   `v0.5.0-rc.1` matches `v*`. A release candidate would become what
 *   `npm install barbican` hands out — for a tool that is pointed at other
 *   people's production with live credentials.
 * - **The registry.** That the version is new was learned from a 409, after four
 *   CI jobs, a build and a pack had run.
 *
 * A fifth thing is asked here that CI also asks, and deliberately so: whether
 * the README describes the version being released (ADR-0034). It is the same
 * function in both places rather than two spellings of one rule — `whyNotDescribed`
 * is called from `tests/docs/release-readme.test.ts` and from here. Two lists of
 * the same steps drift; one function called twice cannot.
 *
 * Zero dependencies, built-in modules only: this runs before `pnpm install` in
 * the publish job, so that a tag that is going to be refused is refused before
 * anything is built.
 *
 * Every decision is a function that returns **the reason it refuses, or
 * `undefined`**. They are pure but for the two that ask git, and none of them
 * touches the network — the registry's answer is passed in as a list of version
 * strings. `tests/tools/release-gate.test.ts` is what holds them; the step that
 * calls this script is held by `tests/workflows/release-gate.test.ts`. See
 * ADR-0049.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * How much text under `### What changed in <version>` counts as a description.
 *
 * The same number the `### Unreleased` guard uses, and for the same reason: a
 * heading with nothing under it satisfies the letter and none of the point.
 */
export const NOTES_MINIMUM = 80;

/** `major.minor.patch` with an optional prerelease. Build metadata is refused. */
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?$/;

/** A dist-tag this gate will publish under: one lowercase word. */
const DIST_TAG = /^[a-z][a-z0-9-]*$/;

/**
 * `main`, wherever this checkout keeps it. The remote-tracking ref first: on a
 * tag push there is no local branch, only what the fetch brought.
 */
const MAIN_REFS = ["refs/remotes/origin/main", "refs/heads/main"];

/**
 * @typedef {{ core: readonly number[]; pre: readonly string[] }} Version
 */

/**
 * A version, or `undefined` when the string is not one.
 *
 * Stricter than npm is on purpose. This decides what gets published under this
 * repository's name, and a version it cannot read is a version it must not
 * reason about — leading zeroes, empty identifiers and build metadata are all
 * refused rather than normalised. Modelling somebody else's parser is how the
 * address grammar was wrong the first time (ADR-0032).
 *
 * @param {string} version
 * @returns {Version | undefined}
 */
function parseVersion(version) {
  const match = SEMVER.exec(version);
  if (match === null) {
    return undefined;
  }
  const pre = match[4] === undefined ? [] : match[4].split(".");
  for (const identifier of pre) {
    // `rc..1` splits into an empty identifier, and `01` is a numeric identifier
    // with a leading zero. Semver forbids both.
    if (!/^[0-9A-Za-z-]+$/.test(identifier) || /^0\d+$/.test(identifier)) {
      return undefined;
    }
  }
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre };
}

/**
 * The version a tag names, or `undefined` when the tag does not name one.
 *
 * The workflow trigger is the glob `v*`, which starts a run for `vnext`, `v0.5`
 * and `v0.5.0.1` alike. This is where that becomes a refusal.
 *
 * @param {string} refName the tag, as `GITHUB_REF_NAME` gives it
 * @returns {string | undefined}
 */
export function versionOfTag(refName) {
  if (!refName.startsWith("v")) {
    return undefined;
  }
  const version = refName.slice(1);
  return parseVersion(version) === undefined ? undefined : version;
}

/**
 * Semver precedence: negative when `left` is the older version.
 *
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a === undefined || b === undefined) {
    throw new TypeError(`not a version: ${a === undefined ? left : right}`);
  }
  for (let part = 0; part < 3; part += 1) {
    const difference = (a.core[part] ?? 0) - (b.core[part] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  // A version with a prerelease is below the release of the same numbers.
  if (a.pre.length === 0 || b.pre.length === 0) {
    return a.pre.length === b.pre.length ? 0 : a.pre.length === 0 ? 1 : -1;
  }
  for (let part = 0; part < Math.max(a.pre.length, b.pre.length); part += 1) {
    const left1 = a.pre[part];
    const right1 = b.pre[part];
    // The one that ran out of identifiers is the lower version.
    if (left1 === undefined || right1 === undefined) {
      return left1 === undefined ? -1 : 1;
    }
    if (left1 === right1) {
      continue;
    }
    const leftNumeric = /^\d+$/.test(left1);
    const rightNumeric = /^\d+$/.test(right1);
    if (leftNumeric && rightNumeric) {
      return Number(left1) - Number(right1);
    }
    // Numeric identifiers are lower than alphanumeric ones; otherwise ASCII order.
    if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    }
    return left1 < right1 ? -1 : 1;
  }
  return 0;
}

/**
 * The dist-tag a version publishes under, or `undefined` when it has none this
 * gate will use.
 *
 * A release takes `latest`. A prerelease takes its own first identifier —
 * `0.5.0-rc.1` publishes under `rc` — which is a channel a consumer has to ask
 * for by name. A prerelease whose identifier is a number would give `--tag 1`,
 * and one spelled `latest` would take the stable channel by another road;
 * neither is guessed at.
 *
 * @param {string} version
 * @returns {string | undefined}
 */
export function distTagOf(version) {
  const parsed = parseVersion(version);
  if (parsed === undefined) {
    return undefined;
  }
  if (parsed.pre.length === 0) {
    return "latest";
  }
  const word = parsed.pre[0] ?? "";
  return DIST_TAG.test(word) && word !== "latest" ? word : undefined;
}

/**
 * Why this version has no dist-tag, or `undefined` when it has one.
 *
 * @param {string} version
 * @returns {string | undefined}
 */
export function whyNoDistTag(version) {
  if (distTagOf(version) !== undefined) {
    return undefined;
  }
  const parsed = parseVersion(version);
  if (parsed === undefined) {
    return `\`${version}\` is not a version this gate can read, so there is no channel to publish it under.`;
  }
  return (
    `\`${version}\` is a prerelease whose first identifier is \`${parsed.pre[0]}\`, and that is ` +
    `not a dist-tag this gate will publish under. Use a word — \`rc\`, \`beta\`, \`next\`. The ` +
    `dist-tag is the channel \`npm install\` reads, and \`latest\` is not a prerelease's to take.`
  );
}

/**
 * The named section of a document, up to the next heading of any level.
 *
 * @param {string} text
 * @param {string} heading
 * @returns {string | undefined}
 */
export function sectionOf(text, heading) {
  const start = text.indexOf(`${heading}\n`);
  if (start < 0) {
    return undefined;
  }
  const rest = text.slice(start + heading.length);
  const next = rest.search(/\n#{2,3} /);
  return next < 0 ? rest : rest.slice(0, next);
}

/**
 * Why the tag and `package.json` do not name the same version.
 *
 * @param {string | undefined} refName
 * @param {string} packageVersion
 * @returns {string | undefined}
 */
export function whyTagDisagrees(refName, packageVersion) {
  if (refName === undefined || refName === "") {
    return "There is no tag to check: GITHUB_REF_NAME is empty. This script answers for a tag, and without one it has nothing to answer for.";
  }
  const tagged = versionOfTag(refName);
  if (tagged === undefined) {
    return `The tag \`${refName}\` does not name a version. A release tag is \`v\` followed by a version — \`v0.5.0\`, \`v0.5.0-rc.1\`.`;
  }
  if (tagged !== packageVersion) {
    return (
      `The tag names ${tagged} and package.json declares ${packageVersion}. The registry would ` +
      `then hold a release nothing in history marks. Move package.json in the release commit, ` +
      `then tag that commit.`
    );
  }
  return undefined;
}

/**
 * Why the README does not describe the version being released.
 *
 * ADR-0034 requires the difference between `main` and the newest tag to be
 * written where a consumer reads it, and the release to rename that section.
 * What nothing asked until now is whether the renamed section still says
 * anything: `### Unreleased` needs a body of substance while it is unreleased,
 * and on the release commit the same text became a heading that only had to
 * exist. `0.3.0` shipped three breaking report changes described nowhere a
 * consumer looks; this is the check that would have refused it.
 *
 * @param {string} readme
 * @param {string} version
 * @returns {string | undefined}
 */
export function whyNotDescribed(readme, version) {
  if (sectionOf(readme, "### Unreleased") !== undefined) {
    return (
      `README still carries an \`### Unreleased\` section. The release renames that section to ` +
      `\`### What changed in ${version}\`; leaving both says two things about one release, and ` +
      `the one a reader believes is whichever they reach first.`
    );
  }
  const heading = `### What changed in ${version}`;
  const section = sectionOf(readme, heading);
  if (section === undefined) {
    return (
      `README has no \`${heading}\` section. Rename \`### Unreleased\` to it: that text was ` +
      `written as the changes landed, which is the whole of ADR-0034.`
    );
  }
  const body = section.trim();
  if (body.length <= NOTES_MINIMUM) {
    return (
      `\`${heading}\` has ${body.length} characters under it. A heading with nothing under it ` +
      `satisfies the letter and none of the point — a consumer of the previous version has to be ` +
      `able to read what changed for them.`
    );
  }
  return undefined;
}

/**
 * Why the registry refuses this version, asked before the work rather than after.
 *
 * Two rules. The version must not already be published — that one arrives as a
 * 409 anyway, but only after four CI jobs, a build and a pack. And a publish
 * that takes `latest` must be newer than every published release, because
 * `latest` is what `npm install barbican` resolves to and moving it backwards
 * walks every new consumer back with it. A patch on an older line is a real
 * thing to want; it just does not take `latest`.
 *
 * Prereleases are not counted among the releases `latest` is measured against: a
 * published `0.6.0-rc.1` must not block `0.5.1`, and a published `0.5.0-rc.1`
 * must not block `0.5.0`.
 *
 * @param {string} version
 * @param {readonly string[]} published every version the registry holds
 * @param {string} distTag
 * @returns {string | undefined}
 */
export function whyRegistryRefuses(version, published, distTag) {
  if (parseVersion(version) === undefined) {
    return `\`${version}\` is not a version this gate can read, so it cannot be compared with the registry.`;
  }
  if (published.includes(version)) {
    return `${version} is already published. A version in the registry is not replaceable — the next release is a new number.`;
  }
  if (distTag !== "latest") {
    return undefined;
  }
  /** @type {string | undefined} */
  let newest;
  for (const one of published) {
    const parsed = parseVersion(one);
    if (parsed === undefined || parsed.pre.length > 0) {
      continue;
    }
    if (newest === undefined || compareVersions(one, newest) > 0) {
      newest = one;
    }
  }
  if (newest !== undefined && compareVersions(version, newest) <= 0) {
    return (
      `${version} would take \`latest\`, and ${newest} is there now. \`latest\` is what ` +
      `\`npm install barbican\` resolves to, so this walks every new consumer backwards. A patch ` +
      `to an older line is a real thing to want — publish it under a dist-tag of its own.`
    );
  }
  return undefined;
}

/**
 * Whether a git command succeeds, which is the whole of what these two ask.
 *
 * @param {string} cwd
 * @param {readonly string[]} args
 * @returns {boolean}
 */
function gitSucceeds(cwd, args) {
  try {
    execFileSync("git", [...args], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Where this checkout keeps `main`, or `undefined` when it has no `main` at all.
 *
 * @param {string} cwd
 * @returns {string | undefined}
 */
export function mainRefIn(cwd) {
  return MAIN_REFS.find((ref) =>
    gitSucceeds(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]),
  );
}

/**
 * Why the commit under the tag is not one `main` carries.
 *
 * A missing `main` is a refusal and not a pass. The default checkout depth is
 * one commit at the tag, and an ancestry question asked of that history answers
 * "I cannot see" — which, taken as agreement, is the shape of guard this
 * repository keeps finding in its own CI.
 *
 * @param {string} cwd
 * @param {string} sha
 * @returns {string | undefined}
 */
export function whyNotOnMain(cwd, sha) {
  const ref = mainRefIn(cwd);
  if (ref === undefined) {
    return (
      `This checkout has no \`main\` to compare the tag against, so the question cannot be ` +
      `answered — and an unanswered question is not a pass. The publish job needs ` +
      `\`fetch-depth: 0\`, which is what brings the branches with it.`
    );
  }
  if (gitSucceeds(cwd, ["merge-base", "--is-ancestor", sha, ref])) {
    return undefined;
  }
  return (
    `The commit under this tag, ${sha}, is not on \`main\` (${ref}). Publishing it would attest ` +
    `with provenance to a repository whose \`main\` never held this code. Merge first, then tag ` +
    `the commit on \`main\`.`
  );
}

/**
 * Whatever a failed command printed, for a message that says what went wrong.
 *
 * @param {unknown} error
 * @returns {string}
 */
function outputOf(error) {
  if (typeof error !== "object" || error === null) {
    return String(error);
  }
  const failure = /** @type {{ stdout?: unknown; stderr?: unknown; message?: unknown }} */ (error);
  return [failure.stdout, failure.stderr, failure.message]
    .filter((part) => part !== undefined && part !== null)
    .map((part) => String(part).trim())
    .filter((part) => part !== "")
    .join(" ");
}

/**
 * Every version the registry holds for a package.
 *
 * Read over HTTP rather than through `npm view`, and not for elegance:
 * `tests/workflows/portable-gate.test.ts` refuses a spawn of `npm` by name,
 * because npm installs its launchers on Windows as `.cmd` shims that libuv will
 * not resolve. `fetch` needs no executable at all, and it makes the two answers
 * that matter distinct — a 404 and a failure — instead of both arriving as a
 * non-zero exit with text to grep.
 *
 * A package nobody has published yet is an empty list and not an error: that is
 * the first release, and it has to be possible. Any *other* failure throws. A
 * registry that could not be reached must not read as "nothing is published
 * there", which would turn a bad morning into a green light.
 *
 * The abbreviated packument, which is a fraction of the full one and carries the
 * version list. The host is the registry the publish step is configured for; a
 * gate that asked a different registry than the publish writes to would be
 * answering about somebody else's package.
 *
 * @param {string} name
 * @returns {Promise<readonly string[]>}
 */
async function publishedVersions(name) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}`;
  const answer = await fetch(url, {
    headers: { accept: "application/vnd.npm.install-v1+json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (answer.status === 404) {
    return [];
  }
  if (!answer.ok) {
    throw new Error(
      `${url} answered ${answer.status}, and that is not the same as an empty registry. ` +
        `Nothing is published from an unanswered question.`,
    );
  }
  const packument = /** @type {{ versions?: Record<string, unknown> }} */ (await answer.json());
  return Object.keys(packument.versions ?? {});
}

async function main() {
  const manifest = /** @type {{ name: string; version: string }} */ (
    JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"))
  );
  const readme = readFileSync(resolve(ROOT, "README.md"), "utf8");
  const version = manifest.version;
  const sha =
    process.env["GITHUB_SHA"] ??
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();

  /** @type {string[]} */
  const refusals = [];
  /** @param {string | undefined} reason */
  const refuseIf = (reason) => {
    if (reason !== undefined) {
      refusals.push(reason);
    }
  };

  refuseIf(whyTagDisagrees(process.env["GITHUB_REF_NAME"], version));
  refuseIf(whyNotOnMain(ROOT, sha));
  refuseIf(whyNoDistTag(version));
  refuseIf(whyNotDescribed(readme, version));

  const distTag = distTagOf(version);
  if (distTag !== undefined) {
    try {
      refuseIf(whyRegistryRefuses(version, await publishedVersions(manifest.name), distTag));
    } catch (error) {
      refuseIf(outputOf(error));
    }
  }

  if (refusals.length > 0 || distTag === undefined) {
    process.stderr.write(
      `This tag is not going to be published.\n\n${refusals.map((one) => `  - ${one}`).join("\n\n")}\n`,
    );
    process.exit(1);
  }

  process.stdout.write(
    `${manifest.name} ${version}: the tag names it, ${sha} is on main, the README describes it, ` +
      `and the registry does not have it. Publishing under \`${distTag}\`.\n`,
  );

  const output = process.env["GITHUB_OUTPUT"];
  if (output !== undefined && output !== "") {
    appendFileSync(output, `dist-tag=${distTag}\n`);
  }
}

if (isMainModule(import.meta.url)) {
  await main();
}

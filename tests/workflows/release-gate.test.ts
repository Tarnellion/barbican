/**
 * A release runs the whole CI gate, and answers for the tag on top of it.
 *
 * Found by the audit of 14 August. `release.yml` had one verification step —
 * `pnpm run check` — under a comment calling it "the same gate as CI". CI has
 * four jobs: that one, the secret scan over the full history, the verification
 * against the hand-written oracle, and the vulnerability scan. A tag could
 * therefore publish a commit that three quarters of CI had never seen, and npm
 * provenance would attest to it.
 *
 * The cure is that the release calls the CI workflow instead of repeating parts
 * of it. This test is what keeps the call there: inline a step back into the
 * release and the gate silently shrinks again, which is exactly how it shrank
 * the first time.
 *
 * The second half of the file was written after the audit of 20 August 2026, and
 * its finding was this file. CI answers for the tree; the four things only a
 * release knows — the tag, the commit under it, the dist-tag, the registry —
 * were either absent or, in the one case that existed, unheld: the step
 * comparing the tag with `package.json` was named in no assertion anywhere, so
 * deleting it left the suite green. A gate that does not hold itself is the
 * defect this repository has now found in its own CI four times.
 *
 * What is asserted here is that the questions get asked. Whether the answers are
 * right is `tests/tools/release-gate.test.ts`, next to the functions that give
 * them. Two guards, because they fail for different reasons: one for a step
 * somebody deleted, one for a decision somebody weakened.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

interface Step {
  readonly name?: string;
  readonly id?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly env?: Record<string, unknown>;
  readonly with?: Record<string, unknown>;
}

interface Workflow {
  readonly on?: Record<string, unknown>;
  readonly jobs: Record<
    string,
    {
      readonly uses?: string;
      readonly needs?: string | string[];
      readonly steps?: readonly Step[];
    }
  >;
}

function workflow(name: string): Workflow {
  return parseYaml(readFileSync(resolve(ROOT, ".github/workflows", name), "utf8")) as Workflow;
}

const CI = workflow("ci.yml");
const RELEASE = workflow("release.yml");

const MANIFEST = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
  readonly publishConfig?: Record<string, unknown>;
};

/** The script that answers the four release-only questions. */
const GATE_SCRIPT = "node tools/release-gate.mjs";

const publishSteps = (): readonly Step[] => RELEASE.jobs["publish"]?.steps ?? [];

/** Where a step sits in the publish job, or -1. Order is the whole point twice below. */
const indexOfStep = (matches: (step: Step) => boolean): number => publishSteps().findIndex(matches);

describe("the release gate", () => {
  it("sees both workflows, rather than an empty parse", () => {
    // A test that read nothing would agree with any pipeline.
    expect(Object.keys(CI.jobs).length).toBeGreaterThan(1);
    expect(Object.keys(RELEASE.jobs).length).toBeGreaterThan(0);
  });

  it("makes CI callable", () => {
    // Without this the release cannot reuse the jobs and would have to copy them.
    expect(CI.on).toHaveProperty("workflow_call");
  });

  it("calls the CI workflow rather than repeating a part of it", () => {
    const calls = Object.values(RELEASE.jobs).filter((job) =>
      job.uses?.endsWith(".github/workflows/ci.yml"),
    );

    expect(calls).toHaveLength(1);
  });

  it("publishes only after that call has passed", () => {
    const gateName = Object.entries(RELEASE.jobs).find(([, job]) =>
      job.uses?.endsWith(".github/workflows/ci.yml"),
    )?.[0];
    const publish = RELEASE.jobs["publish"];
    const needs = [publish?.needs ?? []].flat();

    expect(gateName).toBeDefined();
    expect(needs).toContain(gateName);
  });

  /**
   * The point of the call is that the gate cannot be a subset. If someone adds a
   * job to CI, the release gets it for nothing; if someone inlines a step into
   * the release instead, this is the assertion that notices.
   *
   * What the release *does* keep is the four questions CI cannot ask, because on
   * a pull request there is no tag to ask them about. They are not a copy of
   * anything: nothing in `ci.yml` mentions `GITHUB_REF_NAME` or the registry.
   * The list below is the CI gate's own work, and that is what must not come
   * back here.
   */
  it("leaves no verification step of its own in the release", () => {
    // The commands, not the file's text: a comment explaining why the gate is
    // called rather than copied would otherwise fail this by mentioning it.
    const commands = Object.values(RELEASE.jobs)
      .flatMap((job) => job.steps ?? [])
      .map((step) => step.run ?? "")
      .join("\n");

    for (const verification of ["pnpm run check", "gitleaks", "osv-scanner", "verify.mjs"]) {
      expect(commands).not.toContain(verification);
    }
  });
});

/**
 * And the four things a tag decides, which no pull request can be asked about.
 */
describe("what the release asks that CI cannot", () => {
  it("is triggered by a tag, which is why there is anything to ask", () => {
    const tags = (RELEASE.on?.["push"] as { tags?: readonly string[] } | undefined)?.tags ?? [];

    // A glob, not a grammar: `vnext` and `v0.5` start a run too, and the gate is
    // what turns that into a refusal instead of a publish.
    expect(tags).toContain("v*");
  });

  it("asks them, in one step, before anything is published", () => {
    const gate = indexOfStep((step) => (step.run ?? "").includes(GATE_SCRIPT));
    const publish = indexOfStep((step) => (step.run ?? "").includes("npm publish"));

    expect(gate, `no step runs \`${GATE_SCRIPT}\``).toBeGreaterThanOrEqual(0);
    expect(publish).toBeGreaterThanOrEqual(0);
    expect(gate).toBeLessThan(publish);
  });

  /**
   * The commit under the tag is compared against `main`, and `main` has to be in
   * the checkout for that to mean anything. The default depth is one commit at
   * the tag — every ancestry question then answers "I cannot see", which the
   * script turns into a refusal rather than a pass, but a release that always
   * refuses is a release somebody fixes by deleting the check.
   */
  it("checks out deeply enough for the ancestry question to have an answer", () => {
    const checkout = publishSteps().find((step) => (step.uses ?? "").includes("actions/checkout"));

    expect(checkout).toBeDefined();
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
  });

  /**
   * `npm publish` with no `--tag` writes `latest`. `v0.5.0-rc.1` matches the
   * trigger, so a release candidate became what `npm install barbican` hands
   * out — to a tool that is pointed at other people's production. The dist-tag
   * is computed from the version by the step above and passed here.
   */
  it("publishes under the dist-tag that step computed, not under the default", () => {
    const gate = publishSteps().find((step) => (step.run ?? "").includes(GATE_SCRIPT));
    const publish = publishSteps().find((step) => (step.run ?? "").includes("npm publish"));
    const command = publish?.run ?? "";

    // The argument is a reference and not a word. `--tag latest` would satisfy
    // "there is a --tag" and republish the defect one prerelease later.
    expect(command).toMatch(/--tag\s+"?\$/);

    // And what it refers to comes from the gate step, by that step's own id — so
    // renaming the step without rewiring this is a failure rather than an empty
    // expansion falling back to npm's default.
    expect(gate?.id).toBeDefined();
    expect(JSON.stringify(publish ?? {})).toContain(`steps.${gate?.id}.outputs.dist-tag`);
  });

  /**
   * And if that flag is ever lost, the fall is soft.
   *
   * `publishConfig.tag` is what npm uses when `--tag` is absent. Left unset it
   * is `latest`, so a dropped flag lands a release candidate on the channel
   * every consumer installs from. Set to anything else, the same accident lands
   * it where nobody is looking, which is a version to deprecate rather than an
   * incident. The gate passes the real tag explicitly on every run, so this is
   * only ever the value of a mistake.
   */
  it("defaults, in package.json, to a channel nobody installs by accident", () => {
    expect(MANIFEST.publishConfig?.["tag"]).toBeDefined();
    expect(MANIFEST.publishConfig?.["tag"]).not.toBe("latest");
  });
});

/**
 * A release runs the whole CI gate.
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
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

interface Workflow {
  readonly on?: Record<string, unknown>;
  readonly jobs: Record<
    string,
    {
      readonly uses?: string;
      readonly needs?: string | string[];
      readonly steps?: readonly { readonly run?: string }[];
    }
  >;
}

function workflow(name: string): Workflow {
  return parseYaml(readFileSync(resolve(ROOT, ".github/workflows", name), "utf8")) as Workflow;
}

const CI = workflow("ci.yml");
const RELEASE = workflow("release.yml");

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

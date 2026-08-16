/**
 * The limitation that makes a whole report wrong stays written down.
 *
 * barbican decides whether access was granted from the status code. A platform
 * that answers `200 OK` with the outcome in the body reads as "allowed"
 * everywhere: every cell the policy denies becomes a privilege escalation, and
 * — measured, not reasoned — two accounts both **refused** produce the same
 * digest and one more finding on top, a cross-tenant leak that is not there.
 * Six cells gave four false escalations, one false leak and exit code 1.
 *
 * `plan.md` names this risk first: "a tool that finds things that do not exist
 * loses trust on the first run". The audit of 14 August found it realised in
 * full and undocumented (L-3).
 *
 * There is no code to guard — the limitation is real and stays until a platform
 * can declare what a refusal looks like. What can be guarded is that the three
 * documents a reader actually opens keep saying so. A warning nothing checks is
 * a warning that survives exactly until the next edit; this repository has
 * already lost one sentence that way, which is why `release-readme.test.ts`
 * exists.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path: string) => readFileSync(resolve(ROOT, path), "utf8");

/**
 * The three places, and why each of them.
 *
 * The README is what a stranger reads before deciding whether the tool applies
 * to their platform at all. The guide is where "what the tool does not do"
 * lives. The report document is where somebody sits with a wall of findings and
 * needs to know it can be an artifact.
 */
const DOCUMENTS = ["README.md", "docs/guide.md", "docs/report.md"] as const;

describe("a platform that refuses with 200", () => {
  it.each(DOCUMENTS)("is warned about in %s", (path) => {
    const text = read(path);

    // The shape of the platform, so the reader can recognise their own.
    expect(text).toMatch(/refuses? with (?:a )?200|answers? .{0,40}200 OK/i);
    // And the consequence, which is the half that makes it worth reading.
    expect(text).toMatch(/privilege escalation|privilege-escalation/i);
  });

  /**
   * The counter-intuitive half. Comparing digests looks immune to a status-code
   * problem, and it is not: the checks run on cells whose outcome is `allowed`,
   * which there is all of them. An earlier draft of these documents claimed the
   * opposite in as many words before the claim was run.
   */
  it.each(DOCUMENTS)("says in %s that the body checks are not immune either", (path) => {
    expect(read(path)).toMatch(/digests? match|same digest|equal digests|poisoned/i);
  });

  /** The assumption, stated where it is made rather than only in prose. */
  it("is stated at classifyStatus, which is where the assumption lives", () => {
    const source = read("src/runner.ts");
    const doc = source.slice(0, source.indexOf("export function classifyStatus"));

    expect(doc).toMatch(/error envelope/i);
  });
});

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

import { describe, expect, it } from "vitest";
import { read, section } from "./markdown.js";

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

/**
 * The rest of the same boundary, written down the same way.
 *
 * "200 with the outcome in the body" is one member of a family, and it was the
 * only member anybody had written down. The other four are not hypothetical:
 * `docs/guide.md` offers `kind: cookie` as a first-class scheme and describes an
 * operator console behind a session cookie, and such a console refuses with a
 * redirect to its sign-in page. A run against one drops every refusal into
 * low-severity `probe-error`, which is outside the exit code, and comes back
 * green.
 *
 * None of these is fixed by this test and none is fixed in the code — each needs
 * the operator to declare something the tool cannot derive, and ADR-0006 is why
 * it may not be guessed at. What a test can hold is that they are named where
 * somebody will meet them, instead of being found again in six months. That is
 * the argument the block above makes, applied to the cases it left out; see
 * ADR-0044.
 */
const BOUNDARY_HEADING = "The statuses this tool cannot read";

/**
 * The named section, and nothing else — `section` from `./markdown.js`.
 *
 * Matching the whole file was the first version and it was false-green within
 * the hour: the README's `### Unreleased` entry describing this very change
 * repeats every keyword the patterns look for, so deleting the section itself
 * left the test passing off the changelog — and a changelog entry is renamed at
 * release and then kept forever, so it would have gone on passing. The section
 * has to be found by its heading, which also pins the name the three documents
 * cross-reference each other by.
 *
 * The helper moved out of this file once two more guards over prose needed the
 * same lesson. One spelling of one rule; the reasoning travels with it.
 */
const UNREADABLE_STATUSES = [
  {
    what: "a refusal that redirects",
    // The status, the mechanism, and the surface the reader recognises.
    patterns: [/\b30[123478]\b/, /redirect/i, /sign-in|sign in|login/i],
  },
  {
    what: "an outcome that is not final",
    patterns: [/\b202\b/, /worker|queue|asynchronous|later/i],
  },
  {
    what: "a delete that only hides the object",
    patterns: [/soft[- ]delete/i, /\b410\b/],
  },
  {
    what: "an answer about the endpoint rather than the account",
    patterns: [/\b405\b/],
  },
] as const;

describe("the statuses the tool cannot read", () => {
  /** The heading itself, so an empty slice fails as a missing section rather than four times over. */
  it.each(DOCUMENTS)("have a section of their own in %s", (path) => {
    expect(section(read(path), BOUNDARY_HEADING).trim().length).toBeGreaterThan(200);
  });

  for (const { what, patterns } of UNREADABLE_STATUSES) {
    it.each(DOCUMENTS)(`names ${what} in %s`, (path) => {
      const text = section(read(path), BOUNDARY_HEADING);

      for (const pattern of patterns) {
        expect(text).toMatch(pattern);
      }
    });
  }

  /**
   * And a reader who arrives from a report rather than from the documents finds
   * the same list at the function that made the choice.
   */
  it("names them at classifyStatus too", () => {
    const source = read("src/runner.ts");
    const doc = source.slice(0, source.indexOf("export function classifyStatus"));

    expect(doc).toMatch(/\b202\b/);
    expect(doc).toMatch(/\b405\b/);
    expect(doc).toMatch(/redirect/i);
  });
});

/**
 * What the run itself costs, in two halves nobody had written down.
 *
 * **The process holds every role's live credentials at once.** The tool does not
 * log in — `docs/guide.md` says so under "what the tool does not do" — so the
 * operator puts working tokens for every role side by side in the environment of
 * one process: the tenant administrator and the operator console among them. And
 * `barbican.run.yaml` is committed, by design, because `tokenEnv` names a
 * variable rather than a value — which makes the committed file a map of which
 * variable holds which role. Every document in this repository argues about what
 * the *report* is worth protecting; none of them said what the **job** becomes.
 *
 * **And the run is shaped like the thing it looks for.** By construction it
 * produces a long run of `401` and `403` from one subject in a few minutes,
 * which is the signature platforms hang an account lockout, a captcha step or an
 * anti-fraud flag on. `docs/report.md` knows the case where half the requests
 * failed; it did not know the case where the platform locked the account
 * half-way — and that one is different in two ways. The tool caused it, and
 * `staleCredentials` reports it as credentials going stale, which sends the
 * reader to look for an expired token that is not there.
 *
 * Neither half is a defect to fix, which is why this is a guard over prose and
 * not over code — the same argument `envelope-limitation.test.ts` makes. A
 * warning nothing checks survives exactly until the next edit.
 */

import { describe, expect, it } from "vitest";
import { read, section } from "./markdown.js";

/**
 * Two documents, two moments. The guide is read while deciding to run at all —
 * it already carries "before a run against something you do not own", which is
 * where a cost of running belongs. The report document is read afterwards, by
 * somebody holding a file whose `staleCredentials` may be naming this.
 */
const DOCUMENTS = ["docs/guide.md", "docs/report.md"] as const;

const HEADING = "The run's own blast radius";

describe("the run's own blast radius", () => {
  it.each(DOCUMENTS)("has a section of its own in %s", (path) => {
    expect(section(read(path), HEADING).trim().length).toBeGreaterThan(400);
  });

  describe("the credentials the run concentrates", () => {
    it.each(DOCUMENTS)("says in %s that one process holds every role at once", (path) => {
      const text = section(read(path), HEADING);

      expect(text).toMatch(/environment/i);
      expect(text).toMatch(/one process|a single process|the same process/i);
      // Named roles, so the reader pictures their own worst one rather than "an account".
      expect(text).toMatch(/administrator|operator console/i);
    });

    /**
     * And the committed half, which is the part that outlives the run: the
     * configuration is meant to be reviewed, and it says which variable holds
     * which role.
     */
    it.each(DOCUMENTS)("says in %s that the committed configuration maps them", (path) => {
      const text = section(read(path), HEADING);

      expect(text).toMatch(/tokenEnv|barbican\.run\.yaml/);
      expect(text).toMatch(/commit/i);
    });
  });

  describe("what the run does to the accounts it uses", () => {
    it.each(DOCUMENTS)("says in %s that a run is shaped like a credential attack", (path) => {
      const text = section(read(path), HEADING);

      expect(text).toMatch(/\b401\b/);
      expect(text).toMatch(/\b403\b/);
      expect(text).toMatch(/lock|captcha|anti-?fraud/i);
    });

    /**
     * The half that makes it worth reading rather than nodding at: the report
     * calls a lockout the tool caused an expiring token, and the reader goes
     * looking in the wrong place.
     */
    it.each(DOCUMENTS)("says in %s how the report misnames it", (path) => {
      expect(section(read(path), HEADING)).toMatch(/staleCredentials/);
    });
  });
});

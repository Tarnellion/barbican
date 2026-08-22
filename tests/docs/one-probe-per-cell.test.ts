/**
 * Every row of the report is one sample, and the report never says so.
 *
 * A cell is probed once. There is no second pass over a finding, and the retry
 * loop in `src/adapters/http.ts` fires on `429`, on `5xx` and on a request that
 * failed on the wire — `isRetryableStatus` is `status === 429 || status >= 500`
 * — never on an outcome that surprised anybody. So a single `200` off a stale
 * replica behind a cache, out of a permissions rollout, out of an A/B branch, is
 * a `critical` cross-tenant leak in the artifact; and a single lucky `403` hides
 * a real hole while the cell is counted in `coverage.cellsMatched` as tested and
 * agreed.
 *
 * The same shape as "a platform that refuses with 200" and "a difference in
 * digests is not proof of isolation", guarded next door: there is nothing to fix
 * in the code — one probe per cell is the design — and what a test can hold is
 * that the two documents a reader actually opens keep saying it. A boundary
 * nobody wrote down is found again in six months, by somebody arguing with a
 * ticket.
 */

import { describe, expect, it } from "vitest";
import { read, section } from "./markdown.js";

/**
 * Two documents, two moments.
 *
 * `docs/guide.md` is read before the run, by the operator deciding what a cell
 * is worth asking. `docs/report.md` is read after it, by whoever has to say out
 * loud whether the critical row in front of them is a defect.
 */
const DOCUMENTS = ["docs/guide.md", "docs/report.md"] as const;

const HEADING = "One probe per cell";

describe("one probe per cell", () => {
  /** The heading itself, so an empty slice fails once rather than six times. */
  it.each(DOCUMENTS)("has a section of its own in %s", (path) => {
    expect(section(read(path), HEADING).trim().length).toBeGreaterThan(400);
  });

  it.each(DOCUMENTS)("says in %s that a row is a single sample", (path) => {
    const text = section(read(path), HEADING);

    expect(text).toMatch(/\bone (?:request|probe|sample|observation)\b/i);
    // And that nothing re-asks: the absent thing is the one worth naming.
    expect(text).toMatch(/no second|not re-?probed|never re-?probed|does not repeat/i);
  });

  /**
   * Which retries exist, so the sentence above is not read as "the tool never
   * repeats a request". It does — for reasons that have nothing to do with the
   * verdict, which is exactly why they do not confirm one.
   */
  it.each(DOCUMENTS)("says in %s what the retries actually cover", (path) => {
    const text = section(read(path), HEADING);

    expect(text).toMatch(/retr(?:y|ies|ied)/i);
    expect(text).toMatch(/\b429\b/);
    expect(text).toMatch(/5xx|\b5\d\d\b/);
  });

  /**
   * Both directions. A reader who is told only about false positives discounts
   * findings and keeps trusting the clean cells, which is the more expensive
   * half of this boundary.
   */
  it.each(DOCUMENTS)("names in %s the false finding a single 200 can make", (path) => {
    const text = section(read(path), HEADING);

    expect(text).toMatch(/replica|cache|roll-?out|A\/B/i);
    expect(text).toMatch(/critical/i);
  });

  it.each(DOCUMENTS)("names in %s the real hole a single 403 can hide", (path) => {
    const text = section(read(path), HEADING);

    expect(text).toMatch(/\b403\b/);
    expect(text).toMatch(/cellsMatched/);
  });

  /** And that the report has no way to say a finding was confirmed twice. */
  it.each(DOCUMENTS)("says in %s that nothing in the file marks a finding confirmed", (path) => {
    expect(section(read(path), HEADING)).toMatch(/confirm/i);
  });
});

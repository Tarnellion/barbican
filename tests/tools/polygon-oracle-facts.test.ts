/**
 * The reference platform and its oracle, held against each other.
 *
 * `checkCoverage` in `tools/oracle/index.mjs` reads the ground truth and nothing
 * else, so both halves of its answer come from one file. Adversarial review of
 * 18 August 2026 measured what that costs: downgrade one defect to
 * `out-of-scope`, delete the two variants that switched it on, and the gate
 * reports 26 combinations, 0 mismatches and complete coverage. Nothing anywhere
 * counted how many defects the platform has, because nothing anywhere read the
 * platform.
 *
 * This file is the missing half. It cannot live in the shared module: the format
 * of ADR-0012 says nothing about how a polygon switches a defect on, and the two
 * polygons in the tree do it differently — this one by environment variables
 * named exactly like its defect ids, VAmPI by a single `vulnerable` flag. So the
 * claim is made where it is true, about this deployment, counting the switches
 * out of `polygon/server.mjs` the way `tests/docs/polygon-facts.test.ts` counts
 * them for the prose in the documents.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadGroundTruth, RELATIONS } from "../../tools/oracle/index.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const SERVER = readFileSync(resolve(ROOT, "polygon/server.mjs"), "utf8");
const GROUND_TRUTH = loadGroundTruth(
  readFileSync(resolve(ROOT, "polygon/ground-truth.json"), "utf8"),
);

/** The switches, counted where the platform declares them. */
const SWITCHES = [...SERVER.matchAll(/"(POLYGON_DEFECT_[A-Z_]+)"/g)].map((match) => match[1]);

/**
 * The four kinds a matrix discrepancy can have (`DiffKind`). Anything else in
 * the oracle's findings came from a check, and a check settles the severity of
 * its own findings.
 */
const MATRIX_KINDS = ["privilege-escalation", "unexpected-denial", "not-observed", "probe-error"];

const NUMBER_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
] as const;

/** A count this file did not read would agree with any platform. */
it("counts the switches out of the platform's source", () => {
  expect(SWITCHES.length).toBeGreaterThan(5);
  expect(new Set(SWITCHES).size).toBe(SWITCHES.length);
});

describe("every defect the platform has is in the oracle, and is switched on", () => {
  /**
   * A switch the oracle does not know about is a defect nobody declared a
   * visibility for — that is, one that cannot be told from a forgotten one,
   * which is the distinction ADR-0012 exists to keep.
   */
  it("declares exactly the platform's switches and no others", () => {
    expect([...Object.keys(GROUND_TRUTH.defects)].sort()).toEqual([...SWITCHES].sort());
  });

  /**
   * The half `checkCoverage` cannot state.
   *
   * It asks whether a defect is named by a finding, which a downgrade to
   * `out-of-scope` answers by making the question not apply. This asks whether
   * the platform was ever **run** with the defect on, and no edit to a
   * visibility field changes that answer: deleting the variants fails here.
   */
  it("switches every one of them on in some variant", () => {
    const on = new Set<string>();
    for (const variant of GROUND_TRUTH.variants) {
      for (const [id, value] of Object.entries(variant.selector)) {
        if (value === true) {
          on.add(id);
        }
      }
    }

    expect([...on].sort()).toEqual([...SWITCHES].sort());
  });

  /**
   * And every variant states every flag, rather than leaving some to the
   * environment.
   *
   * `verify.mjs` inherits `process.env` and then cross-checks the platform's
   * `/v1/health` against the selector — but only over the keys the selector
   * names. A flag left out of a selector is therefore a flag whose state in that
   * combination is whatever the operator's shell happened to hold, and the one
   * guard against a flag not arriving does not cover it.
   */
  it("states every flag in every variant, on or off", () => {
    for (const variant of GROUND_TRUTH.variants) {
      expect([...Object.keys(variant.selector)].sort(), variant.id).toEqual([...SWITCHES].sort());
    }
  });
});

/**
 * The numbers woven into the sentences in `polygon/server.mjs`.
 *
 * They had drifted: the module header still required "every defect must show
 * itself in the response status" two defects after ADR-0011 made that false, and
 * the comment on `DEFECT_FLAGS` said "eight of the ten" over an object holding
 * twelve. `polygon/README.md` beside them was corrected, the source was not.
 *
 * Counted rather than repeated: the total from the platform's own switches, the
 * split from the visibilities the oracle declares. The two sources are
 * independent of each other, which is what makes the sum below a check and not a
 * restatement.
 */
describe("the visibility split the platform's own comments claim", () => {
  const byStatus = Object.values(GROUND_TRUTH.defects).filter(
    (defect) => defect.visibility === "status",
  ).length;
  const byBodySignal = Object.values(GROUND_TRUTH.defects).filter(
    (defect) => defect.visibility === "body-signal",
  ).length;

  it("accounts for every switch: a defect is seen by status or by scalar, and by nothing else", () => {
    expect(byStatus + byBodySignal).toBe(SWITCHES.length);
  });

  it("matches the sentence about how many show in the status", () => {
    const claims = [...SERVER.matchAll(/(\w+) of the (\w+) are visible in the status/g)];

    expect(claims.length).toBeGreaterThan(0);
    for (const [, some = "", all = ""] of claims) {
      // Lowercased: both sentences open with the number, and a capital is a
      // property of where the sentence sits, not of the claim it makes.
      expect(some.toLowerCase()).toBe(NUMBER_WORDS[byStatus]);
      expect(all.toLowerCase()).toBe(NUMBER_WORDS[SWITCHES.length]);
    }
  });

  it("matches the sentence about how many show only by body", () => {
    const claims = [...SERVER.matchAll(/The other (\w+) are visible only/g)];

    expect(claims.length).toBeGreaterThan(0);
    for (const [, some = ""] of claims) {
      expect(some.toLowerCase()).toBe(NUMBER_WORDS[byBodySignal]);
    }
  });
});

/**
 * The relation table covers what the findings name, and nothing besides.
 *
 * The table is what makes a relation checkable at all — without it
 * `compareVariant` compares sets of cells and is blind to what the report says
 * on them. An entry missing means a finding whose weight nothing states; an
 * entry left over is a claim about a cell no run visits, which is the shape a
 * fixture rots into.
 */
describe("the relation table", () => {
  const named = new Set<string>();
  for (const variant of GROUND_TRUTH.variants) {
    for (const finding of variant.findings) {
      if (finding.resource !== undefined && finding.resource !== null) {
        named.add(`${finding.account.split("@")[0]} × ${finding.resource}`);
      }
    }
  }

  it("declares a relation for every cell the findings name, and only for those", () => {
    expect([...Object.keys(GROUND_TRUTH.relations ?? {})].sort()).toEqual([...named].sort());
  });

  /**
   * And it uses all five. The platform was built so that every relation of
   * ADR-0013 occurs on it — that is what the third tenant level and the second
   * holding are for — so a table down to four values is one that stopped
   * covering a relation, not one describing a simpler platform.
   */
  it("covers every relation the platform was built to produce", () => {
    const declared = new Set(Object.values(GROUND_TRUTH.relations ?? {}));

    expect([...declared].sort()).toEqual([...RELATIONS].sort());
  });
});

/**
 * A finding of a check carries the weight the check declares, and the oracle has
 * to state it: the table of ADR-0014 is about matrix discrepancies and does not
 * reach a check finding. Eighteen of the eighty-two findings of `all-nine` come
 * from a check.
 */
it("declares the severity of every check its findings come from", () => {
  const fromChecks = new Set<string>();
  for (const variant of GROUND_TRUTH.variants) {
    for (const finding of variant.findings) {
      if (!MATRIX_KINDS.includes(finding.kind)) {
        fromChecks.add(finding.kind);
      }
    }
  }

  expect(fromChecks.size).toBeGreaterThan(0);
  expect([...Object.keys(GROUND_TRUTH.checkSeverities ?? {})].sort()).toEqual(
    [...fromChecks].sort(),
  );
});

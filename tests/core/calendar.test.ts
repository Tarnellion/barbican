/**
 * One grammar for `YYYY-MM-DD`, and the two readers held against it.
 *
 * The format was decided in three places as two different regular expressions:
 * the schema's `.regex()` on `accepted[].until`, the `isCalendarDate` behind it,
 * and `acceptanceExpiresAt` in the core. All three agreed, which is exactly what
 * made it worth fixing — a copy that agrees now is a copy nobody is watching.
 *
 * The direction that matters is a loosening in the schema. A string the schema
 * admits and the expiry arithmetic cannot read yields `NaN`, `NaN` compares
 * false against every moment, and the acceptance is either permanently lapsed or
 * — read the other way round — permanently in force. One of those two outcomes
 * suppresses a finding, and a suppressed finding is the one result of this whole
 * feature that nobody goes looking for.
 *
 * The last test is the guard proper: it does not check that two copies of a
 * regular expression are spelled the same, it checks that the two layers answer
 * the same question the same way, whatever either one is written with.
 *
 * See ADR-0064.
 */

import { describe, expect, it } from "vitest";
import { acceptanceExpiresAt } from "../../src/core/accepted.js";
import { calendarDayOf, isCalendarDate } from "../../src/core/calendar.js";
import { ConfigValidationError, parseRunConfig } from "../../src/io/config.js";

const HEAD = `
target: { baseUrl: "https://a.test", allowedHosts: [a.test] }
accounts:
  - { id: alice, role: user, tenant: t-a, tokenEnv: A }
policy: { fallback: denied, rules: [] }
`;

function withDeadline(until: string) {
  return parseRunConfig(
    `${HEAD}accepted:\n  - { endpoint: orders.list, kind: privilege-escalation, ` +
      `reason: known, until: "${until}" }\n`,
  );
}

/**
 * Everything either layer has ever been asked about, in one list.
 *
 * The shapes that are not the shape, the shapes that are the shape and name no
 * day, and the days that exist — including 29 February of a leap year, which a
 * calendar written by hand gets wrong before it gets anything else wrong.
 */
const CASES: readonly (readonly [string, boolean])[] = [
  ["2026-11-30", true],
  ["2026-01-01", true],
  ["2026-12-31", true],
  ["2028-02-29", true],
  ["2026-02-28", true],
  ["2027-02-29", false],
  ["2026-11-31", false],
  ["2026-13-01", false],
  ["2026-00-10", false],
  ["2026-01-00", false],
  ["soon", false],
  ["30/11/2026", false],
  ["2026-11-30T00:00:00Z", false],
  ["2026-11-3", false],
  ["", false],
  [" 2026-11-30", false],
  ["2026-11-30 ", false],
];

describe("the calendar-date grammar", () => {
  it("admits a day that exists and refuses one that does not", () => {
    for (const [value, expected] of CASES) {
      expect(isCalendarDate(value), `disagreed about ${JSON.stringify(value)}`).toBe(expected);
    }
  });

  it("hands back the three numbers as they were written, not as Date counts them", () => {
    expect(calendarDayOf("2026-11-30")).toEqual({ year: 2026, month: 11, day: 30 });
  });

  it("hands back nothing for a day there is not", () => {
    expect(calendarDayOf("2026-11-31")).toBeUndefined();
  });
});

describe("the deadline arithmetic", () => {
  /** `until` is the last day the acceptance holds, inclusive, in UTC. */
  it("expires at the start of the day after the one named", () => {
    expect(acceptanceExpiresAt("2026-11-30")).toBe(Date.UTC(2026, 11 - 1, 30 + 1));
  });

  /** A year rolls over on its own: the arithmetic is `Date`'s, not ours. */
  it("rolls the year over without a calendar of its own", () => {
    expect(acceptanceExpiresAt("2026-12-31")).toBe(Date.UTC(2027, 0, 1));
  });

  /**
   * The gap the shared grammar closed, and the reason it is closed in this
   * direction. `2026-11-31` used to reach `Date.UTC` here, which rolled it into
   * 1 December and gave the acceptance a day it was never granted. The schema
   * refuses that string, but the schema is one of two doors — a consumer of the
   * library building an `Acceptance` by hand comes through the other. `NaN`
   * compares false, so the acceptance reads as lapsed and the finding is
   * reported again: recoverable, which the opposite is not.
   */
  it("reads a day that does not exist as no deadline at all", () => {
    expect(acceptanceExpiresAt("2026-11-31")).toBeNaN();
    expect(acceptanceExpiresAt("2026-13-01")).toBeNaN();
    expect(acceptanceExpiresAt("next quarter")).toBeNaN();
  });
});

describe("the schema and the core", () => {
  /**
   * Not "the two regular expressions are identical" — that would go stale the
   * moment either is rewritten into something equivalent, and it would pass
   * happily while a third copy appeared somewhere else. What is asserted is the
   * answer: for every string above, the door and the arithmetic behind it agree
   * about whether there is a deadline there.
   */
  it("agree about every string, in both directions", () => {
    for (const [value, valid] of CASES) {
      const parsed = () => withDeadline(value);
      if (valid) {
        expect(parsed().accepted, `the schema refused ${JSON.stringify(value)}`).toHaveLength(1);
        expect(acceptanceExpiresAt(value)).not.toBeNaN();
      } else {
        expect(parsed, `the schema admitted ${JSON.stringify(value)}`).toThrow(
          ConfigValidationError,
        );
        expect(acceptanceExpiresAt(value)).toBeNaN();
      }
    }
  });
});

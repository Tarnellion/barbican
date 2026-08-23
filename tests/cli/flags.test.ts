/**
 * The grammar of a limit typed on the command line.
 *
 * `--rps` divides a second by this number and `--max-requests` is the ceiling on
 * traffic against somebody else's deployment, so what the parser accepts is a
 * security decision and not a convenience. Written as `Number(raw)` guarded by
 * `Number.isInteger` it accepted `1e23` — an integer by both tests, and a gap of
 * 1e-20 ms between requests, which is the no-limits mode the project promises
 * not to have (C-4/H-8).
 *
 * `tests/invariants/cli-surface.test.ts` holds the same rule from outside, by
 * spawning the built binary, because that is where the exit code is observable.
 * It is a different claim: that test proves the flag reaches this function, and
 * these prove what the function decides — including the two refusals whose
 * wording is the only thing an operator gets back, and which were reached by no
 * test in this process until ADR-0063 put `src/cli/` inside the coverage gate.
 */

import { InvalidArgumentError } from "commander";
import { describe, expect, it } from "vitest";
import { positiveInteger } from "../../src/cli/flags.js";

describe("a limit an operator typed", () => {
  it("is read when it is written in decimal digits", () => {
    expect(positiveInteger("5")).toBe(5);
    expect(positiveInteger("100000")).toBe(100_000);
  });

  /**
   * The notation is what is refused, not the magnitude: an operator raising a
   * limit deliberately is doing their job, and every string here is a limit the
   * command line did not say which the report would then record as declared.
   */
  it.each(["1e23", "0x10", "0b101", "5.0", " 5 ", "-5", "five", ""])(
    "refuses %o, which Number() would read as a limit nobody typed",
    (raw) => {
      expect(() => positiveInteger(raw)).toThrow(InvalidArgumentError);
      expect(() => positiveInteger(raw)).toThrow(/decimal digits/);
    },
  );

  /** Zero is not a limit, it is the absence of one, and the throttle refuses it too. */
  it("refuses zero, in as many digits as it is written in", () => {
    expect(() => positiveInteger("0")).toThrow(/zero is not a limit/);
    expect(() => positiveInteger("000")).toThrow(/zero is not a limit/);
  });

  /**
   * Past 2^53 integers stop being exact, so the number enforced would not be the
   * number written. Refused rather than rounded: a limit the tool silently moved
   * is a limit the report records wrongly.
   */
  it("refuses a value past the point where integers stop being exact", () => {
    expect(positiveInteger("9007199254740991")).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => positiveInteger("9007199254740993")).toThrow(/9007199254740991/);
  });
});

/**
 * What a check said it was put, read out of its own coverage.
 *
 * A check that can tell "I was asked nothing" from "I looked and found nothing"
 * declares which of its `coverage()` counters says so (`Check.reachCounter`). This
 * file is the one reader of that declaration: it sums the counter, and the clause
 * coverage and the check's own helpers ask here instead of each summing a named
 * counter in their own way.
 *
 * Not re-exported from `src/core/index.ts`, on purpose: the package surface moves
 * only for a name a consumer is meant to call.
 */

import type { CheckCoverage, CheckReach, CheckRun } from "./types.js";

/**
 * The sum of one named counter over the rows one check returned.
 *
 * Own properties only and finite numbers only. A row read back from a saved report
 * is a plain object with `Object.prototype` behind it, and a counter named
 * `constructor` must not be answered by the prototype. A value that is not a
 * finite number is not a count, and counts as nothing rather than poisoning the
 * sum: the total is a claim about what the check was put, and `NaN` is no such
 * claim.
 */
export function counterTotal(
  coverage: readonly CheckCoverage[],
  checkId: string,
  counter: string,
): number {
  let total = 0;
  for (const row of coverage) {
    if (row.checkId !== checkId || !Object.hasOwn(row.counters, counter)) {
      continue;
    }
    const value = row.counters[counter];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      total += value;
    }
  }
  return total;
}

/**
 * Each declaring check's own reach, keyed by check id.
 *
 * Only the checks that declared a counter. A check that declared none has no
 * entry, and its absence is the whole of what is said about it.
 */
export function reachOf(
  checksRun: readonly CheckRun[],
  byCheck: readonly CheckCoverage[],
): ReadonlyMap<string, CheckReach> {
  const reach = new Map<string, CheckReach>();
  for (const check of checksRun) {
    if (check.reachCounter === undefined) {
      continue;
    }
    reach.set(check.id, {
      checkId: check.id,
      counter: check.reachCounter,
      total: counterTotal(byCheck, check.id, check.reachCounter),
    });
  }
  return reach;
}

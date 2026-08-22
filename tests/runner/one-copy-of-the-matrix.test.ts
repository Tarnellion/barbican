/**
 * The walk holds one copy of the matrix, not three.
 *
 * The measurement of 20 August 2026 (J-10) found the peak resident set growing
 * linearly with the number of cells and named three materialisations of the whole
 * matrix in a row: the observations, the cells of `describeMatrix`, and the
 * `ReportedObservation` rows of `withVerdicts`. It counted the walk as one of the
 * three. The walk was three by itself: a task list laid out before the first
 * request, an array of per-cell results filled during it, and the observations
 * drained out of that array at the end — all three alive together at the moment
 * the last cell came back.
 *
 * This is the guard on the two that went. See ADR-0053.
 *
 * ## Why it is measured this way
 *
 * Two readings of the live heap, both taken after a full collection, so what is
 * compared is what is **retained** and not what the collector has not got to yet:
 *
 * - at the moment the last cell is handed to `record`, when everything the walk
 *   holds is alive at once;
 * - after `collectObservations` has returned, when the observations are all that
 *   is left.
 *
 * Their ratio is the number of copies the walk holds, and it does not depend on
 * how heavy one observation is — which is what makes it a stable number rather
 * than a byte count somebody has to re-measure whenever a field is added. On this
 * matrix it read 1.478 before the change and 1.0 after, repeatably to three
 * decimals across sizes and runs; the threshold below sits between them with room
 * on both sides.
 */

import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import type { CredentialProvider, HttpClient } from "../../src/adapters/ports.js";
import type { Account, Endpoint } from "../../src/core/index.js";
import { collectObservations } from "../../src/runner.js";

/**
 * A collection on demand, without asking the whole suite to run under
 * `--expose-gc`.
 *
 * The flag is turned back off immediately: `gc` stays reachable through the
 * closure taken here, and no other test file gets a global it did not ask for.
 */
function collector(): () => void {
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  setFlagsFromString("--no-expose-gc");
  return gc;
}

const ACCOUNTS = 100;
const ENDPOINTS = 200;
const CELLS = ACCOUNTS * ENDPOINTS;

/**
 * How many copies of the matrix the walk may hold beyond the one it returns.
 *
 * Not 1.0: one worker per unit of concurrency has a cell in hand, the array of
 * observations is grown geometrically rather than exactly, and the reading is
 * taken from inside the callback of the last cell rather than after it. The
 * margin covers those and nothing the size of a second copy.
 */
const ALLOWED = 1.2;

describe("the walk holds one copy of the matrix", () => {
  it("retains no more while walking than it returns", async () => {
    const gc = collector();
    const settle = (): number => {
      gc();
      gc();
      gc();
      return process.memoryUsage().heapUsed;
    };

    const endpoints: readonly Endpoint[] = Array.from({ length: ENDPOINTS }, (_unused, index) => ({
      id: `endpoint.${index}`,
      method: "GET",
      path: `/v1/thing-${index}`,
    }));
    const accounts: readonly Account[] = Array.from({ length: ACCOUNTS }, (_unused, index) => ({
      id: `account-${index}`,
      roleId: "user",
    }));

    // A fresh header record per response, as a real client builds one: a shared
    // constant would make every observation point at one object and hide the
    // weight the walk is being measured for.
    const client: HttpClient = {
      send: async () => ({ status: 200, headers: { "content-type": "application/json" } }),
    };
    const credentials: CredentialProvider = { headersFor: () => ({}) };

    const base = settle();
    let recorded = 0;
    let walking = 0;

    const result = await collectObservations({
      baseUrl: "http://127.0.0.1:8787",
      endpoints,
      accounts,
      credentials,
      client,
      concurrency: 16,
      record: () => {
        recorded += 1;
        if (recorded === CELLS) {
          walking = settle();
        }
      },
    });

    const returned = settle();
    // Read after the measurement, so nothing above may collect the observations
    // early and make the walk look thriftier than it is.
    expect(result.observations).toHaveLength(CELLS);

    const held = returned - base;
    const inFlight = walking - base;
    const copies = inFlight / held;
    expect(
      copies,
      `the walk retained ${Math.round(inFlight / CELLS)} bytes per cell while it ran and ` +
        `${Math.round(held / CELLS)} bytes per cell once it returned — ${copies.toFixed(3)} ` +
        `copies of the matrix, where at most ${ALLOWED} is allowed`,
    ).toBeLessThan(ALLOWED);
  });
});

/**
 * The walk hands every finished cell over as it goes, and can be told which
 * cells are already walked.
 *
 * Until 21 August 2026 an observation existed in one place only — an array
 * inside `collectObservations` — and it stayed there until the walk returned.
 * Everything that ends a process short of that returns nothing: Ctrl-C because
 * the owner of the platform asked for it, the OOM killer, a CI job cancelled on
 * a timeout, the network going away. The traffic was spent on somebody else's
 * deployment and the result of it was gone, in a tool whose whole economics are
 * that the traffic is the expensive part.
 *
 * Three properties are checked here, and they are the three the CLI builds the
 * feature out of:
 *
 * - a cell reaches `record` when it is finished, not when the walk is;
 * - `abort` stops the walk where it stands and says so through `truncated`,
 *   without recording the cells it interrupted;
 * - `resumed` skips cells already walked, spends no request on them, and leaves
 *   the observations in the order an uninterrupted walk would have produced.
 *
 * The third is the one that decides whether a resumed run may call itself one
 * run: the report's `observations` array is drained in cell order, and a resumed
 * walk that appended its own results at the end would produce a different
 * document from the same matrix.
 */

import { describe, expect, it } from "vitest";
import type { CredentialProvider, HttpClient, HttpRequest } from "../../src/adapters/ports.js";
import type { Account, Endpoint } from "../../src/core/index.js";
import { safeHeaders } from "../../src/io/untrusted.js";
import type { CellRecord } from "../../src/runner.js";
import { collectObservations, ResumeDoesNotFitError } from "../../src/runner.js";

const endpoints: readonly Endpoint[] = [
  { id: "orders.list", method: "GET", path: "/v1/orders" },
  { id: "profile.me", method: "GET", path: "/v1/me" },
  { id: "reports.list", method: "GET", path: "/v1/reports" },
];

const accounts: readonly Account[] = [
  { id: "player-a", roleId: "player", tenantId: "tenant-a" },
  { id: "admin-a", roleId: "admin", tenantId: "tenant-a" },
];

const credentials: CredentialProvider = { headersFor: () => safeHeaders([]) };

/** A client that answers 403 and remembers what it was asked for. */
function fakeClient(reply: (request: HttpRequest) => number = () => 403): {
  client: HttpClient;
  seen: string[];
} {
  const seen: string[] = [];
  return {
    seen,
    client: {
      send(request) {
        seen.push(`${request.method} ${request.url}`);
        return Promise.resolve({ status: reply(request), headers: {} });
      },
    },
  };
}

const base = {
  baseUrl: "https://api.test",
  endpoints,
  accounts,
  credentials,
} as const;

describe("the walk records every cell as it finishes", () => {
  it("hands each observation over before the walk returns", async () => {
    const { client } = fakeClient();
    const recorded: CellRecord[] = [];
    let seenWhileWalking = 0;

    const result = await collectObservations({
      ...base,
      client,
      record: (record) => {
        recorded.push(record);
        seenWhileWalking = recorded.length;
      },
    });

    // Six cells, and every one of them was handed over.
    expect(result.observations).toHaveLength(6);
    expect(recorded).toHaveLength(6);
    expect(seenWhileWalking).toBe(6);
    // The record carries the coordinate of the cell, not only the observation:
    // the reader of a stream has to key on the cell without reconstructing it.
    for (const record of recorded) {
      expect(record.accountId).toBeTypeOf("string");
      expect(record.endpointId).toBeTypeOf("string");
      expect(record.observation.accountId).toBe(record.accountId);
    }
  });

  /**
   * A failure belongs to the record as much as the observation does.
   *
   * `summary.failures` is built from `failures[]`, and a resumed run that kept
   * only the observations would come back with a smaller number than the same
   * walk uninterrupted — the report would differ from itself over one matrix.
   */
  it("carries the failure row of a cell that produced one", async () => {
    const { client } = fakeClient((request) => (request.url.endsWith("/v1/me") ? 500 : 403));
    const recorded: CellRecord[] = [];

    await collectObservations({ ...base, client, record: (one) => void recorded.push(one) });

    const withFailure = recorded.filter((one) => one.failure !== undefined);
    expect(withFailure).toHaveLength(2);
    expect(withFailure[0]?.failure?.reason).toContain("500");
  });
});

describe("an aborted walk", () => {
  /**
   * The abort arrives in the middle: the client lets the first two cells
   * through and then signals, so what is left is a walk stopped where it stood.
   */
  it("stops, reports truncated, and does not record the cells it interrupted", async () => {
    const controller = new AbortController();
    const recorded: CellRecord[] = [];
    const seen: string[] = [];
    const client: HttpClient = {
      send(request) {
        seen.push(request.url);
        if (seen.length === 2) {
          controller.abort();
        }
        return Promise.resolve({ status: 403, headers: {} });
      },
    };

    const result = await collectObservations({
      ...base,
      client,
      concurrency: 1,
      abort: controller.signal,
      record: (one) => void recorded.push(one),
    });

    // The tail was never walked, and the flag is what says so: without it the
    // absence of findings there reads as the platform being clean.
    expect(result.truncated).toBe(true);
    // Exact numbers, not "fewer than six". Two requests went out and one cell
    // came back before the stop; the second is discarded although its answer
    // arrived, because nothing here can tell an answer that landed from a fetch
    // the abort rejected — and a cell kept on that guess is a cell `--resume`
    // will not probe, that is, a request the platform never answered filed as
    // an answer. One cell's worth of traffic is the price, bounded by the
    // concurrency the operator agreed to.
    expect(seen).toHaveLength(2);
    expect(result.observations).toHaveLength(1);
    expect(recorded).toHaveLength(1);
  });

  it("passes the signal to the client, so an outstanding request is dropped", async () => {
    const controller = new AbortController();
    const signals: (AbortSignal | undefined)[] = [];
    const client: HttpClient = {
      send(_request, signal) {
        signals.push(signal);
        return Promise.resolve({ status: 403, headers: {} });
      },
    };

    await collectObservations({ ...base, client, abort: controller.signal });

    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((one) => one === controller.signal)).toBe(true);
  });
});

describe("a resumed walk", () => {
  it("spends no request on a cell already walked and keeps the order", async () => {
    const straight = fakeClient();
    const complete = await collectObservations({ ...base, client: straight.client });

    // The first four cells, as an interrupted run would have left them.
    const already: CellRecord[] = complete.observations.slice(0, 4).map((observation) => ({
      accountId: observation.accountId,
      endpointId: observation.endpointId,
      ...(observation.resourceId === undefined ? {} : { resourceId: observation.resourceId }),
      observation,
    }));

    const resumedClient = fakeClient();
    const resumed = await collectObservations({
      ...base,
      client: resumedClient.client,
      resumed: already,
    });

    // Two requests, not six: that is the whole point of the exercise.
    expect(resumedClient.seen).toHaveLength(2);
    expect(resumed.truncated).toBe(false);
    // And the same document: the cells taken from the stream sit where the walk
    // would have put them, not appended after the ones probed now.
    expect(resumed.observations.map((one) => `${one.accountId}/${one.endpointId}`)).toEqual(
      complete.observations.map((one) => `${one.accountId}/${one.endpointId}`),
    );
    expect(resumed.observations.slice(0, 4)).toEqual(complete.observations.slice(0, 4));
  });

  /**
   * A record that fits no cell of this walk is refused, before a request.
   *
   * The declaration gate lives in the CLI and compares digests; this is the
   * second lock, on the one thing the digest cannot see — that the cells really
   * are the same cells. Resuming into a different matrix and presenting the
   * result as one run is the worst thing this tool could do with the feature.
   */
  it("refuses a record that matches no cell of this matrix", async () => {
    const { client, seen } = fakeClient();

    await expect(
      collectObservations({
        ...base,
        client,
        resumed: [
          {
            accountId: "player-a",
            endpointId: "endpoint.that.left",
            observation: {
              accountId: "player-a",
              endpointId: "endpoint.that.left",
              status: 403,
              headers: {},
              outcome: "denied",
              durationMs: 1,
              at: new Date(0).toISOString(),
            },
          },
        ],
      }),
    ).rejects.toBeInstanceOf(ResumeDoesNotFitError);

    // And nothing was sent while finding out.
    expect(seen).toEqual([]);
  });
});

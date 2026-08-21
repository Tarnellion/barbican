/**
 * The file a walk is streamed to, and the gate that decides whether another run
 * may continue it.
 *
 * Two properties carry the whole feature, and both are about being wrong in the
 * safe direction. A stream is read back by a process that will then present its
 * cells as its own observations, so anything the file cannot vouch for has to
 * stop the run rather than be guessed at: a half-written last line is dropped
 * because that is what a killed process leaves, and a broken line anywhere else
 * is refused because that is not. And the digest refuses more than it strictly
 * has to — a reformatted configuration costs a fresh run, while a missed change
 * costs a report assembled out of two declarations and presented as one.
 *
 * See ADR-0047.
 */

import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  declarationDigest,
  OBSERVATION_STREAM_FORMAT,
  observationStreamPath,
  openObservationStream,
  readObservationStream,
} from "../../src/report/write.js";
import type { CellRecord } from "../../src/runner.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "barbican-stream-"));
});

const header = {
  format: OBSERVATION_STREAM_FORMAT,
  tool: "barbican",
  version: "9.9.9",
  declaration: "0123456789abcdef",
  runId: "8b1f0a4e-0000-4000-8000-000000000000",
  startedAt: "2026-08-21T10:00:00.000Z",
};

function cell(endpointId: string): CellRecord {
  return {
    accountId: "player-a",
    endpointId,
    observation: {
      accountId: "player-a",
      endpointId,
      status: 403,
      headers: {},
      outcome: "denied",
      durationMs: 3,
      at: "2026-08-21T10:00:01.000Z",
    },
  };
}

describe("where the stream lives", () => {
  it("sits beside the report and is named after it", () => {
    expect(observationStreamPath("/tmp/out/run.json")).toBe("/tmp/out/run.json.stream.ndjson");
  });
});

describe("a stream on disk", () => {
  it("writes a header, then a line per cell, readable only by its owner", async () => {
    const path = join(directory, "run.json.stream.ndjson");

    const stream = await openObservationStream(path, header);
    await stream.append({ kind: "cell", ...cell("orders.list") });
    await stream.close();

    expect(stream.failure).toBeUndefined();
    // The same care the report is written with: this file carries every request
    // address and every account identifier.
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const lines = (await readFile(path, "utf8")).split("\n");
    expect(lines.at(-1)).toBe("");
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ kind: "header", runId: header.runId });
    expect(JSON.parse(lines[1] ?? "")).toMatchObject({ kind: "cell", endpointId: "orders.list" });
  });

  it("carries the cells of an interrupted run into the file it reopens", async () => {
    const path = join(directory, "run.json.stream.ndjson");
    const first = await openObservationStream(path, header);
    await first.append({ kind: "cell", ...cell("orders.list") });
    await first.close();

    const { records: carried } = await readObservationStream(path);
    const second = await openObservationStream(
      path,
      header,
      carried.map((one) => ({ kind: "cell", ...one })),
    );
    await second.append({ kind: "cell", ...cell("profile.me") });
    await second.close();

    const { header: read, records } = await readObservationStream(path);
    expect(read.runId).toBe(header.runId);
    expect(records.map((one) => one.endpointId)).toEqual(["orders.list", "profile.me"]);
  });

  /**
   * A disk that fills must cost the safety net and not the walk: the run's
   * traffic is already spent against somebody else's deployment. A closed handle
   * stands in for the full disk — the write fails the same way, and what is under
   * test is that the failure is reported rather than thrown.
   */
  it("keeps its failure to itself and says so afterwards", async () => {
    const path = join(directory, "run.json.stream.ndjson");
    const stream = await openObservationStream(path, header);
    await stream.close();

    await expect(stream.append({ kind: "cell", ...cell("orders.list") })).resolves.toBeUndefined();

    expect(stream.failure).toBeTypeOf("string");
    // And a second attempt is silent too, rather than piling one message per
    // remaining cell of the matrix onto the screen.
    await stream.append({ kind: "cell", ...cell("profile.me") });
    expect(stream.failure).toBeTypeOf("string");
  });
});

describe("reading a stream back", () => {
  const line = (value: object): string => `${JSON.stringify(value)}\n`;

  it("drops a half-written last line, because that is what a killed run leaves", async () => {
    const path = join(directory, "killed.ndjson");
    await writeFile(
      path,
      `${line({ kind: "header", ...header })}${line({ kind: "cell", ...cell("orders.list") })}{"kind":"cell","accou`,
      "utf8",
    );

    const { records, incomplete } = await readObservationStream(path);

    expect(records).toHaveLength(1);
    expect(incomplete).toBe(true);
  });

  it("refuses a broken line anywhere else, because that is not an interruption", async () => {
    const path = join(directory, "damaged.ndjson");
    await writeFile(
      path,
      `${line({ kind: "header", ...header })}not json\n${line({ kind: "cell", ...cell("orders.list") })}`,
      "utf8",
    );

    await expect(readObservationStream(path)).rejects.toThrow("is damaged");
  });

  it("refuses a file with no header, having nothing to check a declaration against", async () => {
    const path = join(directory, "headless.ndjson");
    await writeFile(path, line({ kind: "cell", ...cell("orders.list") }), "utf8");

    await expect(readObservationStream(path)).rejects.toThrow("does not begin with a header");
  });

  it("refuses a format this build does not write", async () => {
    const path = join(directory, "future.ndjson");
    await writeFile(
      path,
      line({ kind: "header", ...header, format: "barbican-observation-stream/2" }),
      "utf8",
    );

    await expect(readObservationStream(path)).rejects.toThrow("is in format");
  });

  it("refuses a cell that is not an observation of a cell", async () => {
    const path = join(directory, "nonsense.ndjson");
    await writeFile(
      path,
      `${line({ kind: "header", ...header })}${line({ kind: "cell", accountId: "player-a" })}`,
      "utf8",
    );

    await expect(readObservationStream(path)).rejects.toThrow("is not an observation of a cell");
  });

  it("ignores a line that is neither a header nor a cell", async () => {
    const path = join(directory, "noted.ndjson");
    await writeFile(
      path,
      `${line({ kind: "header", ...header })}${line({ kind: "resumed", at: header.startedAt, cells: 0 })}${line({ kind: "cell", ...cell("orders.list") })}`,
      "utf8",
    );

    const { records } = await readObservationStream(path);

    expect(records.map((one) => one.endpointId)).toEqual(["orders.list"]);
  });
});

describe("the digest a resumed run has to match", () => {
  const inputs = {
    version: "0.4.0",
    config: "target:\n  baseUrl: https://api.test\n",
    sourceFlag: "--endpoints",
    source: "endpoints:\n  - id: orders.list\n",
    unsafeMethods: false,
    identify: true,
    contextValues: new Map([["geo-blocked", { headers: { "x-country": "DE" }, query: {} }]]),
  };

  it("is the same over the same declaration", () => {
    expect(declarationDigest(inputs)).toBe(declarationDigest({ ...inputs }));
  });

  /**
   * Each of these changes what a run does, and none of them is visible in the
   * report's own `configDigest`: it is computed over the configuration alone, and
   * it is computed after the walk.
   */
  const changes: readonly (readonly [string, Partial<typeof inputs>])[] = [
    ["the configuration", { config: "target:\n  baseUrl: https://other.test\n" }],
    ["the endpoint document", { source: "endpoints:\n  - id: orders.get\n" }],
    ["which flag the endpoints came from", { sourceFlag: "--postman" }],
    ["--unsafe-methods", { unsafeMethods: true }],
    ["--no-identify", { identify: false }],
    ["the version of the tool", { version: "0.5.0" }],
    [
      "a value a condition takes from the environment",
      { contextValues: new Map([["geo-blocked", { headers: { "x-country": "FR" }, query: {} }]]) },
    ],
    [
      "the name of a condition",
      { contextValues: new Map([["kyc-pending", { headers: { "x-country": "DE" }, query: {} }]]) },
    ],
  ];

  for (const [what, change] of changes) {
    it(`changes when ${what} does`, () => {
      expect(declarationDigest({ ...inputs, ...change })).not.toBe(declarationDigest(inputs));
    });
  }

  /**
   * And not when the same declaration is merely built in another order. The
   * attributes of a condition are a record, and a record has no order to
   * disagree about — a digest that took one from the insertion order would
   * refuse a resume for nothing.
   */
  it("does not change when the same attributes are written in another order", () => {
    const one = declarationDigest({
      ...inputs,
      contextValues: new Map([
        ["geo-blocked", { headers: { "x-country": "DE", "x-device": "web" }, query: {} }],
      ]),
    });
    const other = declarationDigest({
      ...inputs,
      contextValues: new Map([
        ["geo-blocked", { headers: { "x-device": "web", "x-country": "DE" }, query: {} }],
      ]),
    });

    expect(one).toBe(other);
  });
});

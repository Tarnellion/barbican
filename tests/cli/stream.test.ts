/**
 * The gate on `--resume`, and the file the next process will present to it.
 *
 * `src/cli/` sat outside the coverage gate until ADR-0063, on an exemption
 * written about argument parsing, and this module is the least like argument
 * parsing of anything the split produced: `readCarriedWalk` is what decides
 * whether cells another process gathered may be counted as this run's. Its four
 * refusals were held by their own error strings and by nothing else — 42 % of
 * the module's statements were reached by the suite at all — so a run could
 * adopt half a matrix walked under another declaration or another build and
 * report the result under one digest and one verdict.
 *
 * The stream is read and written through `src/report/write.ts`, which has tests
 * of its own; what is under test here is only the decision this module makes
 * about what it read. See ADR-0047 for the feature.
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openWalkStream, readCarriedWalk } from "../../src/cli/stream.js";
import { OBSERVATION_STREAM_FORMAT, openObservationStream } from "../../src/report/write.js";
import type { CellRecord } from "../../src/runner.js";

let directory: string;
let said: string[];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "barbican-cli-stream-"));
  said = [];
  // The module writes to stderr on the paths that succeed, and a test suite is
  // not the place to read them. Collected rather than silenced: two of the cases
  // below are about what the sentence says.
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    said.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const DECLARATION = "0123456789abcdef";
const VERSION = "9.9.9";

const HEADER = {
  format: OBSERVATION_STREAM_FORMAT,
  tool: "barbican",
  version: VERSION,
  declaration: DECLARATION,
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

/** A stream on disk, of the shape an interrupted run leaves. */
async function leftBehind(path: string, overrides: Partial<typeof HEADER> = {}): Promise<void> {
  const stream = await openObservationStream(path, { ...HEADER, ...overrides });
  await stream.append({ kind: "cell", ...cell("orders.list") });
  await stream.close();
}

describe("the walk a resumed run carries in", () => {
  /**
   * The `--resume`-less run, which is nearly every run. Nothing is read, and the
   * presence of a stream is not an invitation: there is no walk to carry.
   */
  it("carries nothing when the flag was not given", async () => {
    const path = join(directory, "run.json.stream.ndjson");
    await leftBehind(path);

    await expect(
      readCarriedWalk({
        streamPath: path,
        resume: false,
        declaration: DECLARATION,
        version: VERSION,
      }),
    ).resolves.toEqual({ records: [], from: undefined });
  });

  /** `--resume` without `--report` is refused earlier; this is the other half. */
  it("carries nothing when there is nowhere for a stream to be", async () => {
    await expect(
      readCarriedWalk({
        streamPath: undefined,
        resume: true,
        declaration: DECLARATION,
        version: VERSION,
      }),
    ).resolves.toEqual({ records: [], from: undefined });
  });

  /**
   * Resuming from nothing would silently walk the whole matrix again, which is
   * the cost the flag exists to avoid — so the absence of the file is a refusal
   * and not an empty start.
   */
  it("refuses when the path names no stream", async () => {
    await expect(
      readCarriedWalk({
        streamPath: join(directory, "absent.json.stream.ndjson"),
        resume: true,
        declaration: DECLARATION,
        version: VERSION,
      }),
    ).rejects.toThrow(/there is no stream at/);
  });

  /**
   * The refusal the whole feature stands on. Cells walked under one declaration
   * and cells walked under another are not one run, and the report they would
   * produce carries a single digest and a single verdict over both.
   */
  it("refuses when the declaration moved", async () => {
    const path = join(directory, "run.json.stream.ndjson");
    await leftBehind(path);

    await expect(
      readCarriedWalk({
        streamPath: path,
        resume: true,
        declaration: "fedcba9876543210",
        version: VERSION,
      }),
    ).rejects.toThrow(/the declaration has changed/);
  });

  /** What a status means and which cells exist are this build's to decide. */
  it("refuses a stream written by another build", async () => {
    const path = join(directory, "run.json.stream.ndjson");
    await leftBehind(path, { version: "0.0.1" });

    await expect(
      readCarriedWalk({
        streamPath: path,
        resume: true,
        declaration: DECLARATION,
        version: VERSION,
      }),
    ).rejects.toThrow(/was written by barbican 0\.0\.1 and this is 9\.9\.9/);
  });

  /** A resumed run reports the start of the walk it continues, or it stops. */
  it("refuses a stream whose start time cannot be read", async () => {
    const path = join(directory, "run.json.stream.ndjson");
    await leftBehind(path, { startedAt: "the day before yesterday" });

    await expect(
      readCarriedWalk({
        streamPath: path,
        resume: true,
        declaration: DECLARATION,
        version: VERSION,
      }),
    ).rejects.toThrow(/carries no readable start time/);
  });

  /**
   * The path that lets a run through: the cells come back, and so does the
   * identity of the walk being continued — one `runId` on the wire across two
   * processes, and a `startedAt` naming the start of the walk (ADR-0045).
   */
  it("carries the cells and the identity of the walk being continued", async () => {
    const path = join(directory, "run.json.stream.ndjson");
    await leftBehind(path);

    const carried = await readCarriedWalk({
      streamPath: path,
      resume: true,
      declaration: DECLARATION,
      version: VERSION,
    });

    expect(carried.records.map((record) => record.endpointId)).toEqual(["orders.list"]);
    expect(carried.from).toEqual({ runId: HEADER.runId, startedAt: HEADER.startedAt });
    expect(said.join("")).toContain("1 cells are already in");
  });

  /**
   * A killed process leaves a half-written last line, and the operator is told
   * so: how many cells are carried in is one fact, and how the run that gathered
   * them ended is another.
   */
  it("says when the last line of the stream was half-written", async () => {
    const path = join(directory, "run.json.stream.ndjson");
    await leftBehind(path);
    const whole = await readFile(path, "utf8");
    await writeFile(path, `${whole}{"kind":"cell","accountId":"pla`, "utf8");

    await readCarriedWalk({
      streamPath: path,
      resume: true,
      declaration: DECLARATION,
      version: VERSION,
    });

    expect(said.join("")).toContain("that run was killed");
  });
});

describe("the stream a run leaves behind", () => {
  const opened = {
    version: VERSION,
    declaration: DECLARATION,
    runId: HEADER.runId,
    startedAt: new Date(HEADER.startedAt),
  };

  /** The ordinary case: a fresh file, and one sentence saying where it is. */
  it("opens beside the report and says so", async () => {
    const path = join(directory, "run.json.stream.ndjson");

    const stream = await openWalkStream({
      ...opened,
      streamPath: path,
      resume: false,
      carried: { records: [], from: undefined },
    });
    await stream.close();

    expect(said.join("")).toContain(`Streaming the walk to ${path}`);
    expect(said.join("")).not.toContain("was replaced");
  });

  /**
   * A run without `--resume` overwrites whatever was there, and that is an
   * earlier walk becoming uncontinuable. The size is quoted because it is the
   * only evidence left that anything was lost.
   */
  it("says when it replaced a stream an earlier run could have continued", async () => {
    const path = join(directory, "run.json.stream.ndjson");
    await leftBehind(path);

    const stream = await openWalkStream({
      ...opened,
      streamPath: path,
      resume: false,
      carried: { records: [], from: undefined },
    });
    await stream.close();

    expect(said.join("")).toMatch(/held \d+ bytes and --resume was not given/);
  });

  /**
   * The carried cells are written back into the fresh file, followed by a note
   * that this one spans more than one process. Without the replay the file would
   * hold the second half of the walk alone while the report assembled from both
   * presented itself as the whole of it.
   */
  it("replays the carried cells and marks where the second process began", async () => {
    const path = join(directory, "run.json.stream.ndjson");
    await leftBehind(path);
    const carried = await readCarriedWalk({
      streamPath: path,
      resume: true,
      declaration: DECLARATION,
      version: VERSION,
    });

    const stream = await openWalkStream({ ...opened, streamPath: path, resume: true, carried });
    await stream.close();

    const lines = (await readFile(path, "utf8")).trim().split("\n");
    const kinds = lines.map((line) => (JSON.parse(line) as { kind?: string }).kind);
    expect(kinds).toEqual(["header", "cell", "resumed"]);
    expect(JSON.parse(lines[2] ?? "{}")).toMatchObject({ kind: "resumed", cells: 1 });
  });
});

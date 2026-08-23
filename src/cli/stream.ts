/**
 * The walk on disk: the one a run continues, and the one it leaves behind.
 *
 * Both halves of ADR-0047 in one place. They were two hundred lines apart in the
 * run, and they are the same decision seen from either end — what a stream has to
 * prove before its cells may be counted as this run's, and what this run writes
 * so the next process can prove the same thing about it.
 */

import { stat } from "node:fs/promises";
import type { ObservationStream } from "../report/write.js";
import {
  OBSERVATION_STREAM_FORMAT,
  openObservationStream,
  readObservationStream,
} from "../report/write.js";
import type { CellRecord } from "../runner.js";
import { paint } from "./screen.js";

/** What an interrupted run left, and whose run it was. */
export interface CarriedWalk {
  readonly records: readonly CellRecord[];
  /**
   * The identity of the walk being continued, absent when nothing is.
   *
   * A resumed run adopts both: one identifier on the wire across two processes,
   * and a `startedAt` naming the start of the walk rather than of this process.
   */
  readonly from: { readonly runId: string; readonly startedAt: string } | undefined;
}

/**
 * The gate on resuming, and everything that has to be true before a request.
 *
 * A resumed run presents itself as one walk: one `runId`, one `configDigest`,
 * one verdict over cells gathered by two processes. That is only honest while
 * the declaration is the same one, so the digest is compared here — before the
 * canaries, before the walk, before anything is sent. Resuming into a changed
 * declaration and calling the result one run is the worst thing this feature
 * could do, and it is the one thing it refuses outright.
 *
 * @throws {Error} when there is no stream, when the declaration moved, when the
 *   build that wrote it was another one, or when its start time cannot be read
 */
export async function readCarriedWalk(options: {
  readonly streamPath: string | undefined;
  readonly resume: boolean;
  readonly declaration: string;
  readonly version: string;
}): Promise<CarriedWalk> {
  const { streamPath, resume, declaration, version } = options;
  if (!resume || streamPath === undefined) {
    return { records: [], from: undefined };
  }
  const existing = await stat(streamPath).catch(() => undefined);
  if (existing === undefined) {
    throw new Error(
      `--resume was given and there is no stream at "${streamPath}". A completed run ` +
        `removes it, so either this walk already finished — read the report — or the ` +
        `path is not the one the interrupted run was given. Resuming from nothing ` +
        `would silently spend the whole matrix again, which is the cost this flag ` +
        `exists to avoid.`,
    );
  }
  const stream = await readObservationStream(streamPath);
  if (stream.header.declaration !== declaration) {
    throw new Error(
      `--resume refuses: the declaration has changed since "${streamPath}" was ` +
        `written (${stream.header.declaration} then, ${declaration} now). The ` +
        `configuration, the endpoint document, a value a condition takes from the ` +
        `environment, or --unsafe-methods or --no-identify — one of them is not what ` +
        `it was. Cells walked under one declaration and cells walked under another ` +
        `are not one run, and a report that presented them as one would carry a ` +
        `single digest and a single verdict over both. Start a fresh run, or restore ` +
        `what changed.`,
    );
  }
  if (stream.header.version !== version) {
    throw new Error(
      `--resume refuses: "${streamPath}" was written by barbican ` +
        `${String(stream.header.version)} and this is ${version}. What a status means, ` +
        `which cells exist and how a verdict is reached are all this build's to ` +
        `decide, and half a matrix decided by another build is not a run this one can ` +
        `answer for. Start a fresh run.`,
    );
  }
  const from = { runId: stream.header.runId, startedAt: stream.header.startedAt };
  if (Number.isNaN(Date.parse(from.startedAt))) {
    throw new Error(
      `The observation stream "${streamPath}" carries no readable start time, and a ` +
        `resumed run reports the start of the walk it continues. Start a fresh run.`,
    );
  }
  process.stderr.write(
    `${paint("Resuming:", "green")} ${stream.records.length} cells are already in ` +
      `${streamPath} and will not be probed again${
        stream.incomplete ? ", and its last line was half-written — that run was killed" : ""
      }. The report will carry the interrupted run's identifier and start time.\n`,
  );
  return { records: stream.records, from };
}

/**
 * The walk on disk, opened before the first cell of it.
 *
 * Not before the canaries: a run stopped there has nothing to resume, and a
 * stream holding a header alone is a file the operator did not ask for. After
 * them, and from here on every finished cell is on disk within milliseconds of
 * the response.
 */
export async function openWalkStream(options: {
  readonly streamPath: string;
  readonly version: string;
  readonly declaration: string;
  readonly runId: string;
  readonly startedAt: Date;
  readonly resume: boolean;
  readonly carried: CarriedWalk;
}): Promise<ObservationStream> {
  const { streamPath, carried } = options;
  const replaced = !options.resume && (await stat(streamPath).catch(() => undefined));
  const stream = await openObservationStream(
    streamPath,
    {
      format: OBSERVATION_STREAM_FORMAT,
      tool: "barbican",
      version: options.version,
      declaration: options.declaration,
      runId: options.runId,
      startedAt: options.startedAt.toISOString(),
    },
    carried.from === undefined
      ? []
      : [
          ...carried.records.map((record) => ({ kind: "cell", ...record })),
          // A note that this file spans more than one process, for whoever
          // reads it afterwards. Ignored on the way back in — only `cell`
          // lines are.
          { kind: "resumed", at: new Date().toISOString(), cells: carried.records.length },
        ],
  );
  if (replaced !== undefined && replaced !== false) {
    process.stderr.write(
      `${paint("A stream from an earlier run was replaced:", "yellow")} ${streamPath} ` +
        `held ${replaced.size} bytes and --resume was not given, so that run can no ` +
        `longer be continued.\n`,
    );
  }
  process.stderr.write(
    `Streaming the walk to ${streamPath}: a run interrupted or killed leaves a ` +
      `partial report and can be continued with --resume. The file is removed when ` +
      `the walk completes.\n`,
  );
  return stream;
}

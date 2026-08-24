/**
 * What a run puts on disk: the report at the end, and the walk as it happens.
 *
 * The second half arrived on 21 August 2026 and is the reason this file is no
 * longer only about serialisation. Until then the report was the only artifact,
 * and it was written once, after the last response had come back — so a run that
 * did not reach that line left nothing at all. Ctrl-C because the owner of the
 * platform asked to stop, the OOM killer, a CI job cancelled on its timeout, the
 * network going away: every request already spent against somebody else's
 * deployment, and no trace of any of them. See ADR-0047.
 *
 * The stream below is that trace. It is not a second source of truth and must
 * not become one: the report is still assembled from observations, and what the
 * stream does is carry observations from a run that died into a run that
 * continues it.
 *
 * Writing the report without holding it as one string.
 *
 * `JSON.stringify(report, null, 2)` builds the whole file in memory before a
 * byte of it is written, and a string in node stops at 536 870 888 characters.
 * The project already met that wall once: `MAX_ROWS_PER_DEFECT` exists because
 * 2 000 accounts on one endpoint produced 1 999 000 evidence rows and
 * `RangeError: Invalid string length` at the last step of the run — see the
 * reasoning beside the constant in `build.ts`.
 *
 * The cap bounds `findings`. It does not bound `observations`, which carries one
 * row per cell whether anything was found there or not, so the wall stayed
 * reachable from the other side: the audit of 20 August 2026 (J-1) lost a run of
 * 57 826 cells against a platform that answers with 196 headers — every request
 * sent, every finding discarded, no file on disk, and an error naming a string
 * length rather than anything the operator did.
 *
 * Serialising in chunks removes the ceiling on the file. It does not remove the
 * report from memory — the object graph is still built in full, and the matrix
 * is still materialised three times over the course of a run (J-10). That is a
 * larger change and it is not this one.
 *
 * The output is byte-for-byte what `JSON.stringify(report, null, 2)` produced,
 * because things read it: the polygon's oracle parses the file and compares it
 * cell for cell, and a reader diffing two runs would see an unrelated change in
 * every line. `tests/report/write.test.ts` asserts the equality rather than
 * trusting this paragraph.
 */

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { readFile, rename, rm } from "node:fs/promises";
import { identifier } from "../core/identifiers.js";
import { byCodeUnits } from "../core/order.js";
import type { CellRecord } from "../runner.js";

/** Re-indents a serialised value so it sits at `depth` spaces inside the document. */
function reindent(value: string, depth: number): string {
  return value.split("\n").join(`\n${" ".repeat(depth)}`);
}

/**
 * The report as a sequence of chunks, in document order.
 *
 * Arrays are the point: their elements are serialised one at a time, so the
 * largest string this ever holds is one observation, not the whole file.
 */
export function* reportChunks(report: object): Generator<string> {
  const entries = Object.entries(report).filter(
    // `JSON.stringify` drops a key whose value is `undefined`, a function or a
    // symbol, and so must this: the two outputs have to agree on which keys exist
    // at all.
    //
    // Asked of the value itself rather than by serialising it. The first version
    // wrote `JSON.stringify(value) !== undefined` here, which serialises every
    // top-level value in full **before the first chunk is yielded** — so the
    // ceiling this whole function exists to remove was still there, one line
    // above the loop that avoids it. Found by adversarial review on 21 August
    // 2026 (V-3), with 700 megabyte-long strings in `observations`: the throw
    // came from the filter, not from the loop.
    ([, value]) => value !== undefined && typeof value !== "function" && typeof value !== "symbol",
  );

  // `JSON.stringify({}, null, 2)` is `{}` and not `{\n}`: an object with no keys
  // is the one case where the indented form has no newline in it.
  if (entries.length === 0) {
    yield "{}\n";
    return;
  }

  yield "{\n";
  for (const [index, [key, value]] of entries.entries()) {
    const last = index === entries.length - 1;
    yield `  ${JSON.stringify(key)}: `;

    if (Array.isArray(value) && value.length > 0) {
      yield "[\n";
      for (const [position, element] of value.entries()) {
        yield `    ${reindent(JSON.stringify(element, null, 2) ?? "null", 4)}`;
        yield position === value.length - 1 ? "\n" : ",\n";
      }
      yield "  ]";
    } else {
      yield reindent(JSON.stringify(value, null, 2) ?? "null", 2);
    }

    yield last ? "\n" : ",\n";
  }
  yield "}\n";
}

/**
 * The name of the format, in the file that carries it.
 *
 * A stream written by a build with a different shape is refused rather than
 * half-read: a resumed run whose skipped cells came out of a document nobody
 * agreed on is exactly the artifact ADR-0047 forbids.
 */
export const OBSERVATION_STREAM_FORMAT = "barbican-observation-stream/1";

/**
 * Where the walk is streamed, given where the report goes.
 *
 * Beside the report and nowhere else. The stream carries the observations the
 * report carries — every request address, every account, tenant and resource
 * identifier — so it belongs in the directory the operator already chose for a
 * document of that sensitivity, and it is created `0600` for the same reason.
 *
 * That is also why there is no stream when `--report` is absent: the report then
 * goes to stdout, which is the operator's own decision about where this data may
 * live, and inventing a path in the working directory would put the same
 * document somewhere nobody asked for.
 */
export function observationStreamPath(reportPath: string): string {
  return `${reportPath}.stream.ndjson`;
}

/**
 * The first line of a stream: what has to match before a run may continue it.
 *
 * `declaration` is a digest over everything that decides which cells exist and
 * what is sent in them — see `declarationDigest`. `configDigest` in the report
 * answers the neighbouring question, "did the declaration change between two
 * reports", and cannot be used here: it is minted by `buildReport` at the end of
 * a run, and this gate has to hold before the first request of the next one.
 *
 * `runId` and `startedAt` are the interrupted run's, and a run that resumes
 * adopts both. The traffic of both halves then carries one identifier on the
 * wire and the report is filed under it, which is the whole of what ADR-0045
 * bought: the owner of the platform filters one run out of their logs, not two.
 */
export interface ObservationStreamHeader {
  readonly format: string;
  readonly tool: string;
  readonly version: string;
  readonly declaration: string;
  readonly runId: string;
  readonly startedAt: string;
}

/**
 * The names above, for the one loop that reads them off a file.
 *
 * Written out because the interface is erased before the reader runs, and the
 * reader has to walk the fields of a document rather than of a value: an
 * `Object.keys` over what was parsed would put a key somebody else chose into a
 * message. A field added to the interface and not here is checked by nothing,
 * which `tests/report/write.test.ts` asserts against.
 */
const HEADER_FIELDS = [
  "format",
  "tool",
  "version",
  "declaration",
  "runId",
  "startedAt",
] as const satisfies readonly (keyof ObservationStreamHeader)[];

/** One line of the stream: a header, a resumption, or a cell that was walked. */
interface StreamLine {
  readonly kind: string;
}

/**
 * A stream open for appending, and the one thing it promises: it cannot take the
 * run down with it.
 *
 * A disk that fills in the middle of a walk must not cost the walk. The run is
 * already paid for in traffic against a deployment that is not ours, and the
 * stream is the safety net — losing the net is not a reason to drop what it was
 * there to catch. So `append` swallows its own failure, stops writing, and says
 * so through `failure`, which the caller reports once.
 */
export interface ObservationStream {
  /** Appends one line. Never throws. */
  append(record: object): Promise<void>;
  /** Flushes and closes. Never throws. */
  close(): Promise<void>;
  /** Why the stream stopped being written, if it did. */
  readonly failure: string | undefined;
  /** Where it is, for whoever has to say it on the screen. */
  readonly path: string;
}

/**
 * Opens the stream, carrying over whatever an interrupted run had already put in
 * it.
 *
 * Rewritten rather than appended to, and through a staging file with a rename,
 * for the reason `writeReportFile` uses the same pair: opening an existing path
 * for append follows a symlink sitting there, and this file holds every address
 * the run touched. `wx` on a path just unlinked cannot. The rewrite also compacts
 * the half-written last line a killed process leaves behind, so what is on disk
 * is always whole lines.
 */
export async function openObservationStream(
  path: string,
  header: ObservationStreamHeader,
  carried: readonly object[] = [],
): Promise<ObservationStream> {
  const staging = `${path}.next`;
  await rm(staging, { force: true });
  const handle = createWriteStream(staging, { encoding: "utf8", flags: "wx", mode: 0o600 });
  let failure: string | undefined;

  const put = async (value: object): Promise<void> => {
    if (failure !== undefined) {
      return;
    }
    try {
      await new Promise<void>((settle, reject) => {
        // The callback rather than the return value: it is what says the chunk
        // reached the operating system, which is both the backpressure and the
        // ordering this file needs. A machine that loses power still loses the
        // tail — nothing here calls fsync, and a per-cell fsync would cost more
        // than the request it accompanies.
        handle.write(`${JSON.stringify(value)}\n`, (error) =>
          error === null || error === undefined ? settle() : reject(error),
        );
      });
    } catch (cause) {
      failure = cause instanceof Error ? cause.message : String(cause);
    }
  };

  // The `kind` is added here rather than being a field of the header type: every
  // line of the file has one, and the reader refuses a file whose first line
  // does not say what it is.
  await put({ kind: "header", ...header });
  for (const record of carried) {
    await put(record);
  }
  try {
    await rename(staging, path);
  } catch (cause) {
    failure = cause instanceof Error ? cause.message : String(cause);
  }

  return {
    path,
    get failure() {
      return failure;
    },
    append: put,
    close: async () => {
      try {
        await new Promise<void>((settle, reject) => {
          handle.end((error?: Error | null) =>
            error === null || error === undefined ? settle() : reject(error),
          );
        });
      } catch (cause) {
        failure ??= cause instanceof Error ? cause.message : String(cause);
      }
    },
  };
}

/**
 * What a stream holds: its header, and every cell a run finished.
 *
 * A line that is not whole is dropped when it is the last one and refused
 * anywhere else. The last line is the one a killed process was in the middle of;
 * a broken line in the body of the file means something other than an
 * interruption happened to it, and continuing from a document in that state is
 * not a thing to do quietly.
 */
export async function readObservationStream(path: string): Promise<{
  readonly header: ObservationStreamHeader;
  readonly records: readonly CellRecord[];
  /** Whether the last line was half-written — that is, whether a run was killed here. */
  readonly incomplete: boolean;
}> {
  const text = await readFile(path, "utf8");
  const lines = text.split("\n");
  // A file ending in a newline gives one empty element; that is not a dropped
  // line, and calling it one would report every clean interruption as damage.
  const ended = lines.at(-1) === "";
  if (ended) {
    lines.pop();
  }
  let incomplete = false;

  const parsed: StreamLine[] = [];
  for (const [index, line] of lines.entries()) {
    const last = index === lines.length - 1;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      if (last && !ended) {
        // The line the killed process was in the middle of. Dropping it is what
        // the format is for.
        incomplete = true;
        break;
      }
      throw new Error(
        `The observation stream "${path}" is damaged: line ${index + 1} of ${lines.length} ` +
          `is not a JSON document, and it is not a half-written last line — so this is ` +
          `not a run that was killed mid-write. Nothing can be resumed from it: delete ` +
          `the file and start a fresh run.`,
      );
    }
    if (
      value === null ||
      typeof value !== "object" ||
      typeof (value as StreamLine).kind !== "string"
    ) {
      throw new Error(
        `The observation stream "${path}" is damaged: line ${index + 1} carries no kind. ` +
          `Delete the file and start a fresh run.`,
      );
    }
    parsed.push(value as StreamLine);
  }

  const [first, ...rest] = parsed;
  if (first === undefined || first.kind !== "header") {
    throw new Error(
      `The observation stream "${path}" does not begin with a header line, so there is ` +
        `nothing to check the declaration against. A stream is resumable only together ` +
        `with the run that wrote it; delete the file and start a fresh run.`,
    );
  }
  const header = first as unknown as ObservationStreamHeader;
  // Before the comparison below, because the comparison prints what it refuses.
  // Every one of these six is printed back at an operator — `format` two lines
  // down, `version` and `declaration` in the two refusals `readCarriedWalk`
  // raises, `runId` and `startedAt` because a resumed run adopts them and the
  // report then carries them — and `runId` goes on the wire as well, in the
  // `run=` marker of the identity header. A field that is missing or is not a
  // string is left exactly as it was: it is the shape of the file that is wrong
  // then, and the sentences below are the ones that say so.
  for (const name of HEADER_FIELDS) {
    const value = (header as unknown as Readonly<Record<string, unknown>>)[name];
    if (typeof value === "string") {
      identifier(value, `The ${name} in the header of the observation stream "${path}"`);
    }
  }
  if (header.format !== OBSERVATION_STREAM_FORMAT) {
    throw new Error(
      `The observation stream "${path}" is in format "${String(header.format)}", and this ` +
        `build writes "${OBSERVATION_STREAM_FORMAT}". A stream is read back into a run ` +
        `that then reports itself as one walk, so a shape this build does not know is ` +
        `refused rather than half-understood.`,
    );
  }

  // Checked rather than cast. The lines were written by this tool, but what is
  // on disk between two runs is not this tool's to vouch for, and a record that
  // is not a cell would arrive in the report as an observation of a request
  // nobody made.
  const records = rest
    .filter((line) => line.kind === "cell")
    .map((line, index) => asCellRecord(line, path, index));
  return { header, records, incomplete };
}

/**
 * One `cell` line, or a sentence saying why the file cannot be resumed from.
 *
 * ## The three ids are checked here, and not only under the seam
 *
 * ADR-0066's table lists a resume stream read back off disk as covered by "the
 * seam only": `joinKey` refuses a coordinate that is not an identifier, so a
 * hostile stream cannot glue two cells into one entry, and it never could reach a
 * key without being asked. What the seam cannot do is say which line of which
 * file to look at — it reports `A coordinate of a key carries U+0000` from inside
 * `cellKey`, half a walk later.
 *
 * A stream is a document the tool was handed in exactly the sense an OpenAPI file
 * is: it sits on disk between two processes, and `--resume` is a flag an operator
 * points at a path. So it gets a door, like the five parsers, and the door names
 * the cell. The division is ADR-0032's: the seam makes the refusal certain, the
 * door makes it useful.
 *
 * @throws {UnusableIdentifierError} naming the cell and the stream it came from
 */
function asCellRecord(line: StreamLine, path: string, index: number): CellRecord {
  const candidate = line as unknown as Record<string, unknown>;
  const observation = candidate.observation;
  if (
    typeof candidate.accountId !== "string" ||
    typeof candidate.endpointId !== "string" ||
    (candidate.resourceId !== undefined && typeof candidate.resourceId !== "string") ||
    observation === null ||
    typeof observation !== "object" ||
    typeof (observation as { status?: unknown }).status !== "number"
  ) {
    throw new Error(
      `The observation stream "${path}" is damaged: cell ${index + 1} is not an ` +
        `observation of a cell. Nothing can be resumed from it — delete the file and ` +
        `start a fresh run.`,
    );
  }
  const where = `of cell ${index + 1} in the observation stream "${path}"`;
  identifier(candidate.accountId, `The accountId ${where}`);
  identifier(candidate.endpointId, `The endpointId ${where}`);
  if (candidate.resourceId !== undefined) {
    identifier(candidate.resourceId, `The resourceId ${where}`);
  }
  return candidate as unknown as CellRecord;
}

/**
 * The fingerprint a run has to match to continue another one.
 *
 * Not `configDigest`. That field answers "did we change the declaration" between
 * two finished reports, and it is computed by `buildReport` after the walk — the
 * wrong end of a run for a gate that has to hold before the first request of the
 * next one. It is also narrower than this gate needs to be: which cells exist is
 * decided by the configuration **and** the endpoint document, and what is sent in
 * them by two flags on the command line, and `configDigest` sees only the first
 * of the three.
 *
 * So this digest is taken over the documents themselves rather than over what
 * they parse into. That is deliberately the conservative direction, and it is
 * strictly stronger where the two overlap: `parseRunConfig` is a function of the
 * text alone, so one text gives one configuration and a changed configuration
 * cannot come out of an unchanged text. A reformatted file with no change of
 * meaning costs a fresh run — traffic the operator was about to spend anyway —
 * while a missed change costs a report assembled out of two declarations and
 * presented as one. Those two prices are not comparable.
 *
 * The resolved condition values are in it because a `{ env: NAME }` attribute
 * changes what goes on the wire without changing a byte of any file. Token
 * values are **not**: a token is a secret, and this digest lives in a file. What
 * that leaves open is named in ADR-0047 and in the guide — a second, different
 * token for the same account passes the gate, and the canary is what confirms
 * the one in force works.
 */
export function declarationDigest(inputs: {
  readonly version: string;
  readonly config: string;
  readonly sourceFlag: string;
  readonly source: string;
  readonly unsafeMethods: boolean;
  readonly identify: boolean;
  readonly contextValues: ReadonlyMap<
    string,
    {
      readonly headers: Readonly<Record<string, string>>;
      readonly query: Readonly<Record<string, string>>;
    }
  >;
}): string {
  const sorted = (record: Readonly<Record<string, string>>): readonly (readonly string[])[] =>
    Object.entries(record)
      .map(([name, value]) => [name, value] as const)
      .sort((left, right) => byCodeUnits(left[0], right[0]));
  const contexts = [...inputs.contextValues.entries()]
    .sort(([left], [right]) => byCodeUnits(left, right))
    .map(([id, values]) => [id, sorted(values.headers), sorted(values.query)]);
  const material = JSON.stringify([
    OBSERVATION_STREAM_FORMAT,
    inputs.version,
    createHash("sha256").update(inputs.config).digest("hex"),
    inputs.sourceFlag,
    createHash("sha256").update(inputs.source).digest("hex"),
    inputs.unsafeMethods,
    inputs.identify,
    contexts,
  ]);
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

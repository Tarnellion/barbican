/**
 * The paths a command line names, read and written.
 *
 * Together because they answer one question in two directions, and the answer
 * is the same in both: a system error names neither the flag nor the path, and
 * a run takes up to four of them. Every refusal here says which argument it is
 * about, and the two checks that can be made before the walk are made before
 * the walk — traffic against somebody else's deployment is the expensive part,
 * and a wrong path must not cost it twice.
 */

import { constants, createWriteStream } from "node:fs";
import { access, chmod, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { OBSERVATION_STREAM_FORMAT, reportChunks } from "../report/write.js";

/**
 * A file named on the command line, read with the flag that named it.
 *
 * `readFile` on a directory throws `EISDIR: illegal operation on a directory,
 * read` — which names neither the path nor the flag, while a run takes up to
 * four of them. The operator is told that one of their paths is wrong and not
 * which. The same shape as `assertReportPathIsWritable` does for `--report`, and
 * for the same reason: this is the last place the flag is still known. Found by
 * the audit of 14 August 2026 (G-10).
 *
 * @throws {Error} with the flag named, because a command line carries several paths
 */
export async function readNamedFile(flag: string, path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (cause) {
    throw new Error(
      `${flag} cannot be read from "${path}": ${
        cause instanceof Error ? cause.message : String(cause)
      }. The system error names neither the flag nor the path, and a run takes up ` +
        `to four of them — --config, --spec, --endpoints, --postman — so check the ` +
        `one named here. A path pointing at a directory is the usual cause.`,
    );
  }
}

/**
 * A report file, read and parsed, with the argument that named it.
 *
 * `readNamedFile` above names the four flags a run takes, and "EISDIR: illegal
 * operation on a directory" says which argument went wrong no better here than it
 * did there. `role` is the caller's word for the one it is reading.
 *
 * Two subcommands read a saved report — `diff` takes two positional paths and
 * `pack` takes one — so the sentence below names neither of them. It said "a
 * comparison takes two paths" until 25 August 2026, which was a comparison's
 * sentence in the mouth of a function that two commands call: the same defect
 * `UnreadableReportError` was carrying next door (ADR-0067), one layer out.
 *
 * @throws {Error} naming which argument failed
 */
export async function readReport(role: string, path: string): Promise<unknown> {
  const text = await readFile(path, "utf8").catch((cause: unknown) => {
    throw new Error(
      `the ${role} report cannot be read from "${path}": ${
        cause instanceof Error ? cause.message : String(cause)
      }. The system error names neither the argument nor the path`,
    );
  });
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new Error(
      `the ${role} report at "${path}" is not JSON: ${
        cause instanceof Error ? cause.message : String(cause)
      }. This takes the file \`run --report\` writes, not the stream beside it ` +
        `(${OBSERVATION_STREAM_FORMAT} is one JSON document per line)`,
    );
  }
}

/**
 * Whether the report can be written, asked before anything is requested.
 *
 * Found by the audit of 14 August. The write sat 86 lines below the walk, so a
 * typo in `-r` cost the whole run: 152 requests against the deployment, then
 * `ENOENT`, no report on disk, nothing on stdout, and "Run aborted" — which is
 * false besides, since the run had finished and only the file had not. Throttling
 * is deliberately timid because traffic against someone else's system is
 * expensive; spending it twice for a wrong path is the same cost with none of
 * the caution.
 *
 * A check rather than a touch: creating the file here would leave an empty one
 * behind whenever the run stops for any other reason. The race it leaves — the
 * directory disappearing mid-run — is covered where the report is written, by
 * printing it instead of losing it.
 *
 * @throws {Error} with the flag named, because a command line carries several paths
 */
export async function assertReportPathIsWritable(path: string): Promise<void> {
  const directory = dirname(resolve(path));
  try {
    const info = await stat(directory);
    if (!info.isDirectory()) {
      throw new Error(`"${directory}" is not a directory`);
    }
    await access(directory, constants.W_OK);
  } catch (cause) {
    throw new Error(
      `--report cannot be written to "${path}": ${
        cause instanceof Error ? cause.message : String(cause)
      }. Checked now rather than after the walk: the report is written at the end, ` +
        `and a path that fails then costs the whole run's traffic against the platform.`,
    );
  }

  const existing = await stat(path).catch(() => undefined);
  if (existing?.isDirectory() === true) {
    throw new Error(
      `--report points at the directory "${path}", not at a file. The report is ` +
        `one JSON document and needs a name to be written under.`,
    );
  }
}

/**
 * Writes chunks to a stream, respecting backpressure.
 *
 * `Readable.from` plus `pipeline` rather than a loop of `write()`: the loop has
 * to wait for `drain` itself, and getting that wrong on a 60 MB report means
 * either an unbounded buffer or a truncated file.
 */
export async function writeChunks(destination: NodeJS.WritableStream, chunks: Iterable<string>) {
  await pipeline(Readable.from(chunks), destination, { end: destination !== process.stdout });
}

/**
 * The report on disk, written through a temporary file beside it.
 *
 * Two properties, and the second is new because the first made it matter. The
 * file is written in chunks (see `src/report/write.ts`), so it is no longer
 * bounded by the largest string node can hold — and a write spread over time is
 * a write that can be interrupted halfway, which would have left a truncated
 * document where a good report used to be. The rename is atomic, so the path
 * either holds the previous run or this one.
 *
 * 0o600 twice over: on the temporary file, and again on the destination after
 * the rename. `mode` on an open applies to a file being **created**, so a report
 * written a second time into the same path used to keep whatever permissions it
 * had — the audit of 20 August 2026 (L-10). The file carries every request
 * address, every response header and the identifiers of accounts, resources and
 * tenants; the project keeps tokens and bodies out of it by construction and
 * then wrote it world-readable on a shared build agent.
 */
export async function writeReportFile(path: string, report: object): Promise<void> {
  await writeArtifact(path, reportChunks(report));
}

/**
 * A rendered document, written under the same discipline as the report.
 *
 * The evidence pack and the page drawn from it are artifacts of the same run and
 * carry the same things: every address, every account and resource identifier,
 * the label of the deployment. ADR-0058's rule is that a guarantee holds where
 * the artifact goes, and a second writer with weaker rules would be that rule
 * broken by the second file rather than by the first. So this is
 * {@link writeReportFile} with a different source of chunks, and the discipline
 * itself is written once in {@link writeArtifact}.
 */
export async function writeDocumentFile(path: string, text: string): Promise<void> {
  await writeArtifact(path, [text]);
}

/**
 * An artifact of a run, written where it either lands whole or not at all.
 *
 * The body of what `writeReportFile` was until 25 August 2026, extracted when a
 * second artifact needed the same four properties rather than a second set of
 * three of them. What it holds is spelled out on the two callers above.
 */
async function writeArtifact(path: string, chunks: Iterable<string>): Promise<void> {
  const staging = `${path}.partial`;
  // Removed first, then created exclusively. Without `wx` the open follows a
  // symlink sitting at the staging path — the report, with every address and
  // every account identifier in it, lands wherever the link points, and `mode`
  // is ignored because nothing is being created. Unlinking a symlink removes
  // the link and not its target, so the pair is safe where the second half
  // alone is not. An interrupted run leaves a staging file behind, and this is
  // also how the next run gets past it. Found by adversarial review, 21 August
  // 2026 (V-7).
  await rm(staging, { force: true });
  await writeChunks(
    createWriteStream(staging, { encoding: "utf8", flags: "wx", mode: 0o600 }),
    chunks,
  );
  await rename(staging, path);
  await chmod(path, 0o600);
}

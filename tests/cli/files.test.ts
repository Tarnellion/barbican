/**
 * The paths a command line names, and what happens when one of them is wrong.
 *
 * Every refusal in this module exists because a system error names neither the
 * flag nor the path while a run carries up to four of them — that is the whole
 * of G-10 — and every one of those refusals was outside the coverage gate until
 * ADR-0063: a third of the module's statements and a quarter of its branches
 * were reached by the suite. What that leaves unheld is not decoration. The
 * check that `--report` can be written is what keeps a typo from costing the
 * whole run's traffic against somebody else's deployment, and `writeReportFile`
 * is where the report's 0600 and its atomic rename are decided.
 */

import { lstat, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  assertReportPathIsWritable,
  readNamedFile,
  readReport,
  writeReportFile,
} from "../../src/cli/files.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "barbican-cli-files-"));
});

describe("a file the command line named", () => {
  it("is read as it stands", async () => {
    const path = join(directory, "config.yaml");
    await writeFile(path, "target: {}\n", "utf8");

    await expect(readNamedFile("--config", path)).resolves.toBe("target: {}\n");
  });

  /**
   * The defect this function was written for. `readFile` on a directory throws
   * "EISDIR: illegal operation on a directory, read", which names neither the
   * flag nor the path, and the operator is told that one of their four paths is
   * wrong without being told which.
   */
  it("names the flag and the path when it cannot be read", async () => {
    await expect(readNamedFile("--spec", directory)).rejects.toThrow(
      new RegExp(`--spec cannot be read from "${directory}"`),
    );
  });
});

describe("a saved report read for a comparison", () => {
  it("comes back parsed", async () => {
    const path = join(directory, "before.json");
    await writeFile(path, JSON.stringify({ runId: "one" }), "utf8");

    await expect(readReport("first", path)).resolves.toEqual({ runId: "one" });
  });

  /** A comparison takes two positional paths, and the system error names neither. */
  it("says which of the two arguments could not be read", async () => {
    await expect(readReport("second", join(directory, "absent.json"))).rejects.toThrow(
      /the second report cannot be read from/,
    );
  });

  /**
   * The mistake the message is shaped around: the stream beside the report is
   * one JSON document per line, so a reader who reaches for it gets a parse
   * error on line two and no idea why.
   */
  it("says when the file is not JSON, and what the neighbouring file is", async () => {
    const path = join(directory, "run.json.stream.ndjson");
    await writeFile(path, '{"kind":"header"}\n{"kind":"cell"}\n', "utf8");

    await expect(readReport("first", path)).rejects.toThrow(/is not JSON/);
  });
});

describe("whether the report can be written, asked before the first request", () => {
  it("passes a path whose directory exists", async () => {
    await expect(assertReportPathIsWritable(join(directory, "run.json"))).resolves.toBeUndefined();
  });

  /**
   * The audit of 14 August: the write sat 86 lines below the walk, so a typo in
   * `-r` cost 152 requests against the deployment and then failed. Checked here,
   * the same typo costs nothing.
   */
  it("refuses a path whose directory is not there", async () => {
    await expect(
      assertReportPathIsWritable(join(directory, "no-such-place", "run.json")),
    ).rejects.toThrow(/--report cannot be written to/);
  });

  /** A file where a directory should be: the parent exists and is not one. */
  it("refuses a path whose parent is a file", async () => {
    const file = join(directory, "not-a-directory");
    await writeFile(file, "", "utf8");

    await expect(assertReportPathIsWritable(join(file, "run.json"))).rejects.toThrow(
      /is not a directory/,
    );
  });

  /** The report is one JSON document and needs a name to be written under. */
  it("refuses a path that is itself a directory", async () => {
    const path = join(directory, "reports");
    await mkdir(path);

    await expect(assertReportPathIsWritable(path)).rejects.toThrow(/points at the directory/);
  });
});

describe("the report on disk", () => {
  /**
   * The mode is the point. The file carries every request address, every
   * response header and the identifiers of accounts, resources and tenants; the
   * project keeps tokens and bodies out of it by construction and then wrote it
   * world-readable on a shared build agent until L-10.
   *
   * POSIX only for the mode, for the reason ADR-0047 records about the stream:
   * `chmod` on Windows sets one attribute and ignores the rest. What is asserted
   * there is what that platform does answer for.
   */
  it("is written 0600 and holds the document", async () => {
    const path = join(directory, "run.json");

    await writeReportFile(path, { runId: "one", findings: [] });

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ runId: "one", findings: [] });
    if (process.platform === "win32") {
      expect((await stat(path)).isFile()).toBe(true);
    } else {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  /**
   * `mode` on an open applies to a file being **created**, so a report written a
   * second time into the same path kept whatever permissions it had. The second
   * `chmod`, after the rename, is what fixes that — and a second write is the
   * ordinary case, since a pipeline writes the same path every night.
   */
  it("is 0600 again when it replaces one that was not", async () => {
    const path = join(directory, "run.json");
    await writeFile(path, "{}", { encoding: "utf8", mode: 0o644 });

    await writeReportFile(path, { runId: "two" });

    if (process.platform === "win32") {
      expect((await stat(path)).isFile()).toBe(true);
    } else {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  /**
   * V-7: without the `rm` before the exclusive create, the open follows a
   * symlink sitting at the staging path and the report — with every address and
   * every account identifier in it — lands wherever the link points. Unlinking a
   * symlink removes the link and not its target, so the pair is safe where the
   * second half alone is not.
   *
   * The link here points at a file outside the directory the report was asked
   * for, which is what makes the failure visible: if the staging open followed
   * it, that file would hold the report.
   */
  it("does not write through a symlink left at the staging path", async () => {
    const path = join(directory, "run.json");
    const elsewhere = join(directory, "elsewhere.json");
    await writeFile(elsewhere, "untouched", "utf8");
    await symlink(elsewhere, `${path}.partial`);

    await writeReportFile(path, { runId: "three" });

    expect(await readFile(elsewhere, "utf8")).toBe("untouched");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ runId: "three" });
    // The staging path holds nothing afterwards: the rename moved it away.
    await expect(lstat(`${path}.partial`)).rejects.toThrow();
  });
});

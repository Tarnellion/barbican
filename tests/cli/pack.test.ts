/**
 * The `pack` subcommand, from one path to an exit code and two files.
 *
 * The pack itself belongs to `src/report/pack.ts` and the page to
 * `src/report/page.ts`, and both are tested there on hand-written fixtures. What
 * cannot be asked in either place is the shape of the command: which file each
 * artifact lands in, what the operator is told, and what a pipeline reads — which
 * for this subcommand is the whole of the interface.
 *
 * The exit code is the decision worth arguing about. 2 when the pack's standing
 * is `withheld` is ADR-0067's recommendation taken: a pack built from a run that
 * exited 2 is a legitimate thing to look at, and a CI job that publishes one as
 * evidence with nobody noticing is defect B-4 with a document wrapped around it.
 *
 * See ADR-0068.
 */

import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pack } from "../../src/cli/pack.js";
import { UnusableIdentifierError } from "../../src/core/index.js";
import { CLAIMS, STANDINGS } from "../../src/report/pack.js";
import { UnrenderableClaimError } from "../../src/report/page.js";

let directory: string;
let stderr: string[];
let stdout: string[];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "barbican-cli-pack-"));
  stderr = [];
  stdout = [];
  // Pinned off, so that the assertions below compare sentences rather than
  // sentences wrapped in escape codes — vitest may be run on a terminal.
  Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A report as the file holds one, cut down to what a pack reads. */
function report(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "2",
    runId: "11111111-1111-4111-8111-111111111111",
    configDigest: "aaaa000000000000",
    startedAt: "2026-08-25T09:00:00.000Z",
    finishedAt: "2026-08-25T09:05:00.000Z",
    tool: {
      name: "barbican",
      version: "0.6.0",
      documentation: "https://example.test/docs/report.md",
    },
    target: { baseUrl: "http://127.0.0.1:8962", label: "a demonstration deployment" },
    verdict: { code: 0, reason: "no discrepancy with the declared policy" },
    coverage: {
      endpointsTotal: 7,
      endpointsProbed: 6,
      cellsObserved: 144,
      clauses: [
        {
          standard: "OWASP-ASVS-5.0",
          clause: "8.1.1",
          checkIds: [],
          matrixCells: {
            conclusive: 144,
            upheld: 144,
            breached: 0,
            inconclusive: { "not-observed": 0, "probe-error": 0 },
          },
          reservations: ["endpoints-not-probed"],
        },
      ],
    },
    warnings: ["one endpoint of seven was not probed"],
    findingsOmitted: 0,
    findings: [],
    ...over,
  };
}

async function saved(name: string, over: Record<string, unknown> = {}): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, JSON.stringify(report(over)), "utf8");
  return path;
}

describe("a report drawn into a pack", () => {
  it("writes one self-contained document and leaves with 0", async () => {
    const from = await saved("run.json");
    const out = join(directory, "pack.html");

    const code = await pack(from, { out });

    expect(code).toBe(0);
    const page = await readFile(out, "utf8");
    expect(page.startsWith("<!doctype html>")).toBe(true);
    expect(page.trimEnd().endsWith("</html>")).toBe(true);
    // The reservation on the clause row, which is what the whole artifact is for.
    expect(page).toContain("endpoints-not-probed");
    // Nothing to fetch, and nothing to run.
    expect(page).not.toContain("<script");
    expect(page).not.toContain("href");
    // And the document is a file. A rendered page on stdout is not a thing
    // anybody wants, and it would make a redirect produce a page with a summary
    // in front of it.
    expect(stdout).toEqual([]);
    expect(stderr.join("")).toContain("Written:");
  });

  /**
   * The document and `--json` come out of one `evidencePack`.
   *
   * Two artifacts of one command must not be able to repeat what the report layer
   * and the console spent four days doing: each building its own and disagreeing
   * about the same run.
   */
  it("writes the structure the document was drawn from when asked", async () => {
    const from = await saved("run.json");
    const out = join(directory, "pack.html");
    const json = join(directory, "pack.json");

    const code = await pack(from, { out, json });

    expect(code).toBe(0);
    const structure = JSON.parse(await readFile(json, "utf8")) as {
      schemaVersion: string;
      standing: string;
      run: { runId: string };
      clauses: readonly { standard: string; clause: string; claim: string }[];
    };
    expect(structure.schemaVersion).toBe("1");
    expect(structure.standing).toBe("evidence");
    expect(structure.run.runId).toBe("11111111-1111-4111-8111-111111111111");
    const page = await readFile(out, "utf8");
    expect(page).toContain(structure.run.runId);
    // Every clause of the catalogue is a row in both, which is the property the
    // pack exists for: a document built from what was cited lists what happened
    // to be checked.
    expect(structure.clauses.length).toBe(16);
    for (const row of structure.clauses) {
      expect(page).toContain(`${row.standard} ${row.clause}`);
    }
    expect(stderr.join("")).toContain("Pack:");
  });

  /** The catalogue is the bundled one, and the operator is told what stood at each claim. */
  it("tells the operator the standing and every claim of the vocabulary", async () => {
    const from = await saved("run.json");

    await pack(from, { out: join(directory, "pack.html") });

    const said = stderr.join("");
    expect(said).toContain("Evidence pack for a demonstration deployment");
    // The standing sentence out of the table, not a shorter version of it: a
    // second wording is the mistake `WARNINGS` spent four days being.
    expect(said).toContain(STANDINGS.evidence);
    for (const claim of Object.keys(CLAIMS)) {
      expect(said).toContain(claim);
    }
    expect(said).toContain("Exit code 0: the pack was built.");
  });

  /**
   * The artifact is written the way the report is: 0600, and through a rename.
   *
   * A pack carries every address, the label of the deployment and the identifiers
   * of the accounts, exactly as the report does. ADR-0058's rule is that a
   * guarantee holds where the artifact goes, and a second writer with weaker rules
   * would be that rule broken by the second file rather than by the first.
   */
  it.runIf(process.platform !== "win32")("writes the document 0600", async () => {
    const from = await saved("run.json");
    const out = join(directory, "pack.html");
    const json = join(directory, "pack.json");

    await pack(from, { out, json });

    expect((await stat(out)).mode & 0o777).toBe(0o600);
    expect((await stat(json)).mode & 0o777).toBe(0o600);
  });
});

describe("a run that could not answer for itself", () => {
  /**
   * Exit 2, and the page says on its face that nothing in it is upheld.
   *
   * The recommendation of ADR-0067, taken. The pack is still built and is still
   * worth reading — a hole found before the budget ran out is still a hole — and
   * the exit code is what stops a pipeline shipping it as evidence unnoticed.
   */
  it("is packed, says so, and leaves with 2", async () => {
    const from = await saved("cut-short.json", {
      verdict: { code: 2, reason: "the walk was cut short" },
    });
    const out = join(directory, "pack.html");

    const code = await pack(from, { out });

    expect(code).toBe(2);
    const page = await readFile(out, "utf8");
    // The sentence itself is asserted on the terminal, where it is not escaped;
    // `tests/report/pack-page.test.ts` asserts the whole of it in the document,
    // through the inverse of the escaping. Here it is the lead, read out of the
    // table rather than written out.
    expect(stderr.join("")).toContain(STANDINGS.withheld);
    expect(page).toContain(STANDINGS.withheld.split("platform")[0]);
    expect(page).toContain(CLAIMS.withheld);
    // Not one row claims a pass, including the one with 144 conclusive cells
    // behind it.
    expect(page).not.toContain(CLAIMS.upheld);
    expect(stderr.join("")).toContain('Exit code 2: the standing of this pack is "withheld"');
  });

  /** A verdict code this build does not recognise is withheld as well. */
  it("with a verdict code from nowhere is withheld too", async () => {
    const from = await saved("odd.json", { verdict: { code: 7, reason: "something else" } });

    expect(await pack(from, { out: join(directory, "pack.html") })).toBe(2);
  });
});

describe("a file that is not a report this build can read", () => {
  /**
   * Every refusal names the file, and none of them writes a document.
   *
   * The direction matters more here than anywhere: a pack built from a report
   * this build cannot read would report every clause as unanswered over a run
   * that may have answered for all of them, which is this module's own worst
   * failure pointed at itself.
   */
  const cases: readonly (readonly [string, Record<string, unknown>, string | RegExp])[] = [
    ["a schemaVersion from another vintage", { schemaVersion: "9" }, /schemaVersion 9/],
    ["no coverage.clauses at all", { coverage: { endpointsTotal: 1 } }, /coverage\.clauses/],
    ["a verdict that is not an object", { verdict: "clean" }, /"verdict" is missing/],
    [
      "a clause row that is not an object",
      {
        coverage: { endpointsTotal: 1, endpointsProbed: 1, cellsObserved: 1, clauses: ["8.1.1"] },
      },
      /coverage\.clauses\[0\] is not an object/,
    ],
  ];

  for (const [what, over, says] of cases) {
    it(`refuses ${what}, and writes nothing`, async () => {
      const from = await saved("broken.json", over);
      const out = join(directory, "pack.html");

      await expect(pack(from, { out })).rejects.toThrow(says);
      await expect(stat(out)).rejects.toThrow(/ENOENT/);
    });
  }

  it("refuses a path that is not there, naming it", async () => {
    const missing = join(directory, "nowhere.json");

    await expect(pack(missing, { out: join(directory, "pack.html") })).rejects.toThrow(
      /nowhere\.json/,
    );
  });

  it("refuses a file that is not JSON", async () => {
    const path = join(directory, "endpoints.yaml");
    await writeFile(path, "endpoints:\n  - id: a\n", "utf8");

    await expect(pack(path, { out: join(directory, "pack.html") })).rejects.toThrow(/is not JSON/);
  });

  /**
   * The ninth door still stands under the tenth.
   *
   * A string lifted out of a saved report goes through the identifier grammar
   * (ADR-0066), and the renderer above it is therefore right about one grammar
   * rather than two. This is that arrangement asserted from the command, so that
   * moving the check into the renderer would be a red test here.
   */
  it("refuses a control character in a field, naming the field and the file", async () => {
    const from = await saved("control.json", { runId: "11111111\u001b[2K" });

    await expect(pack(from, { out: join(directory, "pack.html") })).rejects.toThrow(
      UnusableIdentifierError,
    );
    await expect(pack(from, { out: join(directory, "pack.html") })).rejects.toThrow(
      /runId in the report ".*control\.json"/,
    );
  });

  /**
   * And a claim with no sentence is refused by the renderer rather than printed.
   *
   * Unreachable through `toPackableRun` today — the claim is computed — and
   * reachable the moment somebody builds a pack from the library or renders one
   * an older build wrote. The command turns it into exit 2 like every other
   * refusal, which is what `src/cli.ts` does with anything this throws.
   */
  it("cannot be made to render a claim the vocabulary does not have", () => {
    expect(new UnrenderableClaimError("S", "1", "made-up").message).toContain(
      "this build has no sentence for it",
    );
  });
});

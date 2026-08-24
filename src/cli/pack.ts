/**
 * `pack`: one saved report, drawn into a document an auditor opens.
 *
 * Short for the reason `compare.ts` next door is short — the pack is the report
 * layer's (ADR-0067) and the page is too (ADR-0068), so what is left here is the
 * paths, the catalogue and the exit code.
 *
 * The catalogue is `createBundledCatalog()`: the three public standards this
 * repository ships as data. A machine holding a private one registers it beside
 * its private checks and builds the pack through the library, which is the
 * arrangement ADR-0043 chose the per-instance catalogue for — the numbering of
 * GLI-19 cannot be in a public repository, and the CLI is a public repository.
 */

import { createBundledCatalog } from "../core/standards/bundled.js";
import type { EvidencePack } from "../report/pack.js";
import { CLAIMS, evidencePack, toPackableRun } from "../report/pack.js";
import { renderPack } from "../report/page.js";
import { readReport, writeDocumentFile } from "./files.js";
import { paint } from "./screen.js";

/**
 * What the operator is told, and it is the pack's own words wherever the pack
 * has any.
 *
 * The standing sentence is read out of the structure rather than summarised: a
 * shorter version of it here would be the second copy `WARNINGS` spent four days
 * being, and this one would be the copy a CI log keeps.
 *
 * The tally names every claim of `CLAIMS`, in the table's order, whether or not
 * any clause reached it. That is the same refusal the page makes: ADR-0067 turned
 * down a score, and a line that printed only the statuses with a count above zero
 * would be a score with the inconvenient half rounded off.
 */
function summary(pack: EvidencePack, out: string, json: string | undefined): readonly string[] {
  const at = [`Written: ${out}`];
  if (json !== undefined) {
    at.push(`Pack: ${json}`);
  }
  return [
    `Evidence pack for ${pack.run.target.label ?? pack.run.target.baseUrl}`,
    "",
    pack.notes[0] ?? "",
    "",
    `Clauses in the catalogue: ${pack.clauses.length}. ` +
      Object.keys(CLAIMS)
        .map((claim) => `${pack.clauses.filter((one) => one.claim === claim).length} ${claim}`)
        .join(", "),
    `Cited outside the catalogue: ${pack.outsideCatalogue.length}`,
    "",
    ...at,
  ];
}

/**
 * A saved report, an evidence pack, and the page drawn from it.
 *
 * The document is the product and `--json` is the thing it was drawn from, so
 * both come out of one `evidencePack` — the file and the page cannot come to
 * different conclusions, which is the split `run` and `diff` both make.
 *
 * **Exit 2 when the standing is `withheld`**, which is the decision worth arguing
 * about and is ADR-0067's recommendation taken. A pack built from a run that
 * exited 2 is a legitimate thing to look at, and the page says on its face that
 * no clause in it is reported as upheld; a pipeline that publishes one as
 * evidence with nobody noticing is defect B-4 with a document wrapped around it,
 * and the exit code is the only part of this a pipeline reads.
 *
 * Nothing is written to stdout. The document is a file by construction — a
 * rendered page printed to a terminal is not a thing anybody wants — so there is
 * no stream for the summary to be mixed into, and it goes to stderr with every
 * other thing this tool says.
 */
export async function pack(
  reportPath: string,
  flags: { readonly out: string; readonly json?: string },
): Promise<number> {
  const saved = await readReport("saved", reportPath);
  const built = evidencePack({
    run: toPackableRun(saved, reportPath),
    catalog: createBundledCatalog(),
  });

  await writeDocumentFile(flags.out, renderPack(built));
  if (flags.json !== undefined) {
    await writeDocumentFile(flags.json, `${JSON.stringify(built, null, 2)}\n`);
  }

  const withheld = built.standing === "withheld";
  process.stderr.write(
    `${[
      ...summary(built, flags.out, flags.json),
      "",
      withheld
        ? paint('Exit code 2: the standing of this pack is "withheld" — see above.', "yellow")
        : "Exit code 0: the pack was built.",
    ].join("\n")}\n`,
  );
  return withheld ? 2 : 0;
}

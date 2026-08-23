/**
 * Everything the operator reads, and the colour it is said in.
 *
 * One module because the defects this file's comments keep recounting were all
 * the same defect: a sentence written down twice, or a fact that reached the
 * report and never reached the screen. `WARNINGS` drifted apart from a second
 * copy of itself, `findingsCapped` was printed nowhere, `info` was counted and
 * never named, and a green headline cleared a run that had proved nothing.
 * Wording and colour live together here so that the next one of those is a
 * change to one file rather than an agreement between two.
 *
 * Nothing here decides what happens — only what is said about it.
 */

import { styleText } from "node:util";
import type { RunIdentity } from "../adapters/http.js";
import type { Severity } from "../core/index.js";
import { SEVERITY_ORDER } from "../core/index.js";
import type { AuthenticitySuspicion } from "../report/authenticity.js";
import type { RunReport, RunVerdict } from "../report/build.js";
import { WARNINGS } from "../report/build.js";
import type { ComparisonTone } from "../report/compare.js";

/**
 * The three colours this tool paints with.
 *
 * Written out rather than derived from `styleText`'s own parameter, because a
 * derived type puts `import … from "node:util"` into the emitted declaration,
 * and a shipped `.d.ts` that names anything but a relative path is a promise
 * about somebody else's versioning — the reason `configSchema` stopped being
 * exported (CI, "No dependency in the published types"). Here that promise
 * would be about `@types/node`, which a consumer picks and this package does
 * not depend on. The subset relation is not taken on trust: `styleText` is
 * called with this type below, so a palette Node stops accepting fails the
 * build in this repository rather than in a consumer's. The same three names
 * were already written out by hand in `WARNING_STYLE`; now they are written
 * once. Cutting `cli.ts` into modules is what made this visible — `paint` was
 * a file-local function, and a file-local function emits no declaration.
 */
export type Ink = "red" | "yellow" | "green";

export function paint(text: string, format: Ink): string {
  // Without a TTY, escape sequences only litter redirected output.
  // The stream is named, and that is the whole fix: `styleText` without it
  // validates `process.stdout`, while the decision above is made on
  // `process.stderr`. In the ordinary invocation — `barbican run -c … > report.json`
  // from a terminal — stderr is a TTY and stdout is not, so every colour this
  // file argues about was dropped on the floor. Found by the audit of
  // 20 August 2026 (H-3, L-4).
  return process.stderr.isTTY === true ? styleText(format, text, { stream: process.stderr }) : text;
}

/**
 * Why an endpoint is not probed, in two lengths.
 *
 * One map and not two: the summary counts the reasons and `--dry-run` explains
 * them one endpoint at a time, and a second list of the same keys goes stale the
 * first time a reason is added — silently, in the half nobody was editing.
 */
export const SKIP_REASONS: Readonly<
  Record<string, { readonly short: string; readonly long: string }>
> = {
  "path-parameters": {
    short: "have path parameters",
    long: "has path parameters and no resource declares values for them",
  },
  "unsafe-method": {
    short: "use an unsafe method",
    long: "a write method, and --unsafe-methods was not given",
  },
  excluded: { short: "excluded by hand", long: "named in exclude" },
  "escapes-target": {
    short: "path leaves the target",
    long: "the path leads outside the target address",
  },
};

/** Skips broken down: one number with no reasons reads as 'something was not tested'. */
function skipBreakdown(report: {
  readonly skipped: readonly { readonly reason: string }[];
}): string {
  const counts = new Map<string, number>();
  for (const item of report.skipped) {
    counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
  }
  const parts = [...counts].map(
    ([reason, count]) => `${SKIP_REASONS[reason]?.short ?? reason} ${count}`,
  );
  return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
}

/**
 * One severity line, built from the core's table rather than from a list beside it.
 *
 * A `Record<Severity, …>` and not a list of names: both severity lines used to
 * spell out four levels by hand, and `info` — the level a registry check may
 * report — was on neither, while the report counted it and the run's verdict
 * knew about it. A finding existed that the operator's screen said nothing
 * about. A list that misses a level compiles; the table does not, so the next
 * level added to `Severity` cannot reach the report without reaching the screen.
 * Found by the audit of 14 August 2026 (B-16).
 *
 * The table itself is `SEVERITY_ORDER` in `src/core/defects.ts`, imported and
 * not copied since 23 August 2026. It stood here as its own private duplicate,
 * identical byte for byte, and the type that held B-16 shut holds nothing at all
 * against the two copies being ranked **differently** — the console would then
 * print the levels in one order while the report file sorted its findings in
 * another. There was no reason for the copy: the CLI already imports `Severity`
 * from the same module, and the report layer already imports the table itself.
 * See ADR-0064.
 */
function bySeverityLine(label: string, counts: Readonly<Record<Severity, number>>): string {
  const levels = (Object.keys(SEVERITY_ORDER) as readonly Severity[])
    .slice()
    .sort((a, b) => SEVERITY_ORDER[a] - SEVERITY_ORDER[b]);
  return `${label}: ${levels.map((level) => `${level} ${counts[level]}`).join(", ")}`;
}

/**
 * How loudly each warning is said — and that is all this file decides about one.
 *
 * The sentences are `WARNINGS` in the report layer and are printed from there
 * verbatim. They used to be written out a second time here, while the comment on
 * `Report.warnings` claimed the console and the file showed "the same ones, from
 * the same constants": `WARNINGS` did not occur in this file at all, `noCanary`
 * and `nothingRefused` had already drifted apart in wording, and `findingsCapped`
 * reached no screen at any point — a run whose evidence rows were dropped by the
 * cap said so only in the file, while the terminal printed the uncapped row count
 * with nothing to say the file would not hold that many. Found by the adversarial
 * review of 18 August 2026.
 *
 * A `Record` over the keys of `WARNINGS` and not a list, for the reason
 * `SEVERITY_ORDER` above is one: a warning added to the report layer without a
 * colour here does not compile, so it cannot reach the file and miss the screen
 * the way `findingsCapped` did.
 *
 * Green appears nowhere in it. A warning is never good news, and the one thing
 * this screen must not do is make a caveat look like a clearance.
 */
export const WARNING_STYLE: Readonly<Record<keyof typeof WARNINGS, Ink>> = {
  // Both put every finding on the screen in doubt: one says the run may have
  // been talking to nobody, the other that a refusal was never seen.
  nothingRefused: "red",
  noCanary: "yellow",
  // Both are about reading the artifact afterwards, and neither changes a count
  // or the verdict.
  unnamedTarget: "yellow",
  findingsCapped: "yellow",
  // Yellow and not red: the findings on this screen stand, and what is unproved
  // is everything about the endpoints no request reached. That is a reservation
  // about the reach of the run, which is what yellow says here.
  endpointsNotProbed: "yellow",
};

export type WarningKey = keyof typeof WARNINGS;

/** One warning, in its own words and this screen's colour. */
export function warningLine(key: WarningKey): string {
  return paint(WARNINGS[key], WARNING_STYLE[key]);
}

/**
 * The same table read by sentence, for the warnings the report hands back as text.
 *
 * `Report.warnings` is a list of strings — it is a JSON document and can be
 * nothing else — so the colour has to be found from the sentence. Built from
 * `WARNING_STYLE` rather than written out again: a second table is the defect
 * this whole change is about.
 */
const WARNING_STYLE_BY_TEXT: ReadonlyMap<string, Ink> = new Map(
  (Object.keys(WARNING_STYLE) as readonly WarningKey[]).map((key) => [
    WARNINGS[key],
    WARNING_STYLE[key],
  ]),
);

/**
 * The headline of the screen, and the one line most readers stop at.
 *
 * It printed `No privilege escalation found` in green whenever
 * `byKind["privilege-escalation"]` was zero. On the polygon with
 * `POLYGON_DEFECT_LIST_NO_FILTER=1` that is a run with twelve cross-tenant leaks:
 * the green line, and four lines below it "Of those, found by body rather than
 * status: 12" — a sentence referring to the ones the green line had just called
 * absent. Literally true, since that counter holds matrix kinds only; and the
 * reader who stopped at the first green line took away the opposite of the run's
 * verdict, which was 1. Found by the adversarial review of 18 August 2026.
 *
 * The count is not deleted and the wording is not hedged into uselessness. The
 * argument is the one L-3 made about `nothingRefused` further down: a real result
 * must not be swallowed by a caveat, and a caveat must not be dressed as a
 * result. What was wrong here was only the second half — the **reassurance**. So:
 *
 * - green on a run that earned it, and only there: nothing found at all, and a
 *   verdict of 0. Not "zero escalations", which is one counter of several, and
 *   not the verdict alone, which is 0 on a run whose findings were all notes.
 * - the same fact in plain words otherwise, with what contradicts it named on the
 *   same line — the row count when something was found, and the run's own exit
 *   code when nothing was found and the run still cannot support the conclusion
 *   (no canary, cut short, credentials gone stale).
 *
 * Yellow and not red for the two: the findings have their own red lines below,
 * and a screen where everything is red says nothing by being red. What yellow
 * says here is "this line does not settle it", which is exactly the defect.
 */
function escalationLine(
  escalations: number,
  summary: { readonly findings: number },
  verdict: { readonly code: number },
  report: {
    readonly warnings: readonly string[];
    readonly coverage: {
      readonly resourcesNotFound: readonly string[];
      readonly notProbed: Readonly<Record<string, number>>;
    };
  },
): string {
  if (escalations > 0) {
    return paint(`Privilege escalation: ${escalations}`, "red");
  }
  const claim = "No privilege escalation found";
  // Five conditions, and the first version had two. Adversarial review of
  // 19 August 2026 built a run where every declared resource answered 404 to
  // everybody: no findings, verdict 0, and the green line printed unqualified
  // over a matrix whose whole isolation half had never been tested — with
  // `nothingRefused` in the report's own warnings, which this file paints red and
  // calls a sentence that puts every finding on the screen in doubt.
  //
  // So the counters are not enough: they say nothing was found, not that anything
  // was looked at. A run earns the bare sentence only when the report itself has
  // no reservation left — no warning, no resource that answered 404 to everyone,
  // and no endpoint the walk never reached.
  //
  // The last of those is the audit of 21 August 2026 (B-4), and the four
  // conditions before it could not see the run it built: eleven endpoints, nine
  // of them templated with no `resources` declared, so the walk covered two. No
  // request went to the nine, so they left no finding to be counted and nothing
  // in `resourcesNotFound` — which is about objects that were asked for and were
  // not there — and the bare green sentence printed over the object half of the
  // surface, where BOLA and IDOR live.
  //
  // `warnings` alone would carry it now that `endpointsNotProbed` exists. The
  // fact is named here as well, in the same shape `resourcesNotFound` already
  // sits in: this list is the screen's own account of what it has a reservation
  // about, and a headline whose only qualification is the report remembering to
  // warn is a headline `warningsFor` can clear by accident.
  const unreserved =
    report.warnings.length === 0 &&
    report.coverage.resourcesNotFound.length === 0 &&
    Object.keys(report.coverage.notProbed).length === 0;
  if (summary.findings === 0 && verdict.code === 0 && unreserved) {
    return paint(claim, "green");
  }
  if (summary.findings > 0) {
    return paint(
      `${claim} — but that is one kind of discrepancy out of several, and this run ` +
        `is not clean: ${summary.findings} finding ` +
        `${summary.findings === 1 ? "row" : "rows"} of other kinds are counted on ` +
        `the lines below.`,
      "yellow",
    );
  }
  // The reason is not repeated here: it is the last line of this same screen, in
  // red, and it is what CI reads. Two copies of one sentence would be the defect
  // above this function in miniature.
  // Nothing found, and the run still cannot support the conclusion. Exit code 0
  // is possible here — a clean walk over resources that were not there — so the
  // sentence names what is unresolved rather than the code alone.
  const unproved =
    Object.keys(report.coverage.notProbed).length > 0
      ? "endpoints no request went to"
      : report.coverage.resourcesNotFound.length > 0
        ? "resources nothing answered for"
        : "a reservation about this run";
  const because =
    verdict.code === 0
      ? `the lines above carry ${unproved}`
      : `this run ends with exit code ${verdict.code}, and the last line says why`;
  return paint(`${claim}, and nothing else either — but nothing was proved: ${because}.`, "yellow");
}

/**
 * Everything the finished run says, in the order it says it.
 *
 * Assembled from the report and not from the walk's own variables: the file is
 * the artifact, and a screen computed from anything else is a second opinion
 * about a run that already has one. The exceptions are the four facts the report
 * has no field for — which signal stopped the walk, where the stream was left,
 * what the platform's log will show the run as, and where the report went.
 */
export interface RunScreen {
  readonly report: RunReport;
  readonly verdict: RunVerdict;
  /** The accounts nothing opened up for, with the counts the line quotes. */
  readonly suspicions: readonly AuthenticitySuspicion[];
  readonly truncated: boolean;
  readonly interruptedBy: NodeJS.Signals | undefined;
  readonly streamPath: string | undefined;
  /** How many cells the walk got through, for the sentence that offers `--resume`. */
  readonly observations: number;
  /** Both paths off the command line, so the resume line can be copied as it stands. */
  readonly configPath: string;
  readonly reportPath: string | undefined;
  readonly identity: RunIdentity | undefined;
  /**
   * The report's own sentences already said before the walk.
   *
   * Two of the warnings are worth more early than late — they are about the run
   * being about to be wasted — and the summary would otherwise say them a second
   * time. Held as the report's strings rather than as keys because
   * `report.warnings` is a list of strings and the subtraction happens there.
   */
  readonly saidEarly: ReadonlySet<string>;
}

export function writeRunSummary(screen: RunScreen): void {
  const {
    report,
    verdict,
    suspicions,
    truncated,
    interruptedBy,
    streamPath,
    observations,
    configPath,
    reportPath,
    identity,
    saidEarly,
  } = screen;
  const { summary } = report;
  const escalations = summary.byKind["privilege-escalation"] ?? 0;
  if (truncated) {
    process.stderr.write(
      `${paint("The run was cut short:", "red")} ${
        interruptedBy === undefined
          ? "the request budget ran out or the circuit breaker tripped"
          : `${interruptedBy} stopped the walk`
      }. The tail of the matrix was never tested — the absence ` +
        `of findings there means nothing.\n${
          streamPath === undefined
            ? `Nothing was streamed to disk, so the cells that were walked cannot be ` +
              `carried into another run: give --report next time.\n`
            : `The ${observations} cells that were walked are in ${streamPath}. ` +
              `Continue where this stopped, without spending them again:\n  barbican run ` +
              `--config ${configPath} --report ${reportPath ?? ""} --resume …\n`
        }`,
    );
  }
  if (suspicions.length > 0) {
    process.stderr.write(
      `${paint("No access anywhere:", "red")} ${suspicions
        .map(
          (s) => `${s.accountId} (${s.refused}/${s.expectedAllowed}, mostly ${s.dominantStatus})`,
        )
        .join(", ")}. ` +
        `Not a single endpoint declared accessible opened up — that is a sign of ` +
        `broken credentials or a wrong address, not of policy. The results cannot ` +
        `be trusted.\n`,
    );
  }
  const lines = [
    // Not 'pairs': a cell is the triple 'account × endpoint × resource', and
    // 6×8 ≠ 80. A reader checking the arithmetic decided the report was lying.
    `Cells probed: ${summary.observations} (matrix rows ${summary.accountRows}` +
      (summary.accountRows === summary.accounts
        ? ""
        : `, of them accounts ${summary.accounts} and the same accounts under contexts`) +
      `, endpoints ${summary.endpoints}, resources ${summary.resources})`,
    summary.skipped > 0
      ? `Endpoints not probed: ${summary.skipped}${skipBreakdown(report)}`
      : undefined,
    summary.failures > 0
      ? paint(`Requests that failed: ${summary.failures} (reasons in the report)`, "yellow")
      : undefined,
    // A resource nobody could reach settles nothing about isolation: a 404
    // satisfies a denial whether the object is protected or simply absent. Said
    // out loud, because the cells for it otherwise read as "tested and agreed".
    report.coverage.resourcesNotFound.length > 0
      ? paint(
          `Resources answered 404 to everyone: ${report.coverage.resourcesNotFound.join(", ")}. ` +
            `Their cells say nothing about isolation — a missing object refuses ` +
            `exactly like a protected one.`,
          "yellow",
        )
      : undefined,
    escalationLine(escalations, summary, verdict, report),
    `Other discrepancies: unexpected denials ${summary.byKind["unexpected-denial"] ?? 0}, ` +
      `not observed ${summary.byKind["not-observed"] ?? 0}, ` +
      `probe errors ${summary.byKind["probe-error"] ?? 0}`,
    // Where the reader starts: 17 findings in one list is not a report.
    summary.findings === 0 ? undefined : bySeverityLine("Rows by severity", summary.bySeverity),
    // The same by defects, right next to it. Otherwise 'critical 10' reads as ten
    // problems, while it is one missing filter across ten cells.
    summary.findings === 0
      ? undefined
      : bySeverityLine("Defects by severity", summary.defectsBySeverity),
    // The number of rows tells the size of the matrix, the number of signatures
    // the number of problems. 'At least', not 'exactly': two defects with the same
    // signature are indistinguishable from the outside, and the precision must not
    // be overstated.
    summary.findings === 0
      ? undefined
      : `Distinct defects: at least ${summary.defectGroups} (finding rows ${summary.findings})`,
    // Check findings are named on a line of their own: they were seen by
    // something other than the status, and mixing them with escalation would
    // erase that difference.
    summary.checkFindings > 0
      ? paint(`Of those, found by body rather than status: ${summary.checkFindings}`, "red")
      : undefined,
    // Everything the file warns about, said here in the file's own words and
    // under the file's own conditions — `report.warnings` is the list, not a
    // second set of `if`s over the same numbers. Two of them were already said
    // before the walk and are not repeated.
    //
    // Below the counts rather than among them, which is where `nothingRefused`
    // wanted to be all along: it ends "making every finding above false" and used
    // to be printed above the findings. And it is still not an exit code — a
    // genuinely wide-open platform is the worst finding there is, and hiding it
    // behind "cannot be trusted" would be the opposite mistake. See L-3.
    ...report.warnings
      .filter((text) => !saidEarly.has(text))
      // A sentence with no colour in the table cannot arrive — `WARNING_STYLE` is
      // a total map over the keys of `WARNINGS` — but the lookup is by string and
      // the type system cannot see that, and an unstyled warning must still be
      // printed rather than swallowed.
      .map((text) => paint(text, WARNING_STYLE_BY_TEXT.get(text) ?? "yellow")),
    // What the platform's own records will show this run as. The report has no
    // field for it, so this line is the only account of whether the run
    // announced itself — and the run identifier is worth repeating where the
    // operator is looking, since the report it is also written in may have gone
    // past on stdout.
    identity === undefined
      ? paint(
          "This run did not name itself on the wire: --no-identify was given, and " +
            "the platform's logs cannot tell it from an attack.",
          "yellow",
        )
      : `Named on the wire as: ${identity.value}`,
    reportPath === undefined ? "Report: printed to stdout" : `Report: ${reportPath}`,
    // The last line, and the one CI acts on. Without it the reader is left to
    // reconcile "Distinct defects: at least 1" with a zero exit code by himself,
    // and the honest conclusion from that pair is that the exit code is unreliable.
    paint(`Exit code ${verdict.code}: ${verdict.reason}`, verdict.code === 0 ? "green" : "red"),
  ].filter((line): line is string => line !== undefined);

  process.stderr.write(`${lines.join("\n")}\n`);
}

/**
 * How the comparison's own tones reach a terminal.
 *
 * A `Record` over `ComparisonTone` and not a lookup with a default, for the
 * reason `WARNING_STYLE` above is one: a tone added to the report layer without
 * a colour here does not compile, so it cannot reach the screen unpainted.
 * Green appears exactly once, on the tone whose name is `good` — a comparison
 * screen that made a caveat look like a clearance would be `escalationLine`'s
 * defect in a new place.
 */
export const COMPARISON_STYLE: Readonly<Record<ComparisonTone, Ink | undefined>> = {
  plain: undefined,
  good: "green",
  warn: "yellow",
  bad: "red",
};

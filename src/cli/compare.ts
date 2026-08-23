/**
 * `diff`: two saved reports, read against each other.
 *
 * The whole subcommand, which is why it is short — the comparison itself is the
 * report layer's, and what is left here is the two paths and the two streams.
 */

import { compareRuns, renderComparison, toComparableRun } from "../report/compare.js";
import { readReport } from "./files.js";
import { COMPARISON_STYLE, paint } from "./screen.js";

/**
 * Two saved reports, read against each other.
 *
 * The summary goes to stderr and `--json` to stdout, which is the split `run`
 * already uses: the artifact is redirectable and the screen is not mixed into
 * it. Both are produced from one `compareRuns`, so the file and the terminal
 * cannot come to different conclusions — the mistake `WARNINGS` spent four days
 * being.
 */
export async function diff(
  beforePath: string,
  afterPath: string,
  asJson: boolean,
): Promise<number> {
  const [before, after] = await Promise.all([
    readReport("first", beforePath).then((one) => toComparableRun(one, beforePath)),
    readReport("second", afterPath).then((one) => toComparableRun(one, afterPath)),
  ]);
  const comparison = compareRuns(before, after);
  if (asJson) {
    process.stdout.write(`${JSON.stringify(comparison, null, 2)}\n`);
  }
  process.stderr.write(
    `${renderComparison(comparison)
      .map((line) => {
        const style = COMPARISON_STYLE[line.tone];
        return style === undefined ? line.text : paint(line.text, style);
      })
      .join("\n")}\n`,
  );
  return comparison.verdict.code;
}

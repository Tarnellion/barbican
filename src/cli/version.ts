/**
 * What this build says it is, to the report and to the platform's access log.
 *
 * Its own module because three of the entry point's parts ask for it — the run
 * that stamps a report, the stream header a resume is checked against, and the
 * `--version` option — and a value read in three places is a value that can be
 * read three different ways.
 */

import { createRequire } from "node:module";

// The version is read from package.json rather than duplicated in a constant:
// once they drift apart, the duplicate makes the CLI lie about its own version
// in run reports.
//
// `homepage` for the same reason, since 21 August 2026: it goes into the header
// the run names itself with, and the one thing an on-call engineer reading it at
// three in the morning wants is somewhere to go. A URL written out a second time
// here would be the project's address as of whenever this line was last touched.
const requireFromHere = createRequire(import.meta.url);
export const { version, homepage } = requireFromHere("../../package.json") as {
  readonly version: string;
  readonly homepage: string;
};

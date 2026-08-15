#!/usr/bin/env node

/**
 * The commit message is in English.
 *
 * CLAUDE.md has said so from the start, commit messages included, and nothing
 * checked it: the language guard in `tests/docs/language.test.ts` reads
 * `git ls-files`, which is the contents of tracked files, and history is outside
 * that entirely. The audit of 14 August counted 100 Russian messages out of 131.
 *
 * The history is left as it is — rewriting it would break every link to a commit
 * and buy little — so this guards the next one instead. The rule holds from the
 * 13 August 2026 translation; see the note in CLAUDE.md.
 *
 * Cyrillic only, and the range is written as escapes rather than as characters:
 * with literal endpoints this file breaks its own rule, which is exactly how the
 * first version of it was caught — by the guard it was written to complement.
 */

import { readFileSync } from "node:fs";

const CYRILLIC = /[\u0400-\u052f]/;

const path = process.argv[2];
if (path === undefined) {
  process.stderr.write("commit-msg-language: no message file given\n");
  process.exit(2);
}

const message = readFileSync(path, "utf8");
// Comment lines are git's own scaffolding and never reach the log.
const written = message
  .split("\n")
  .filter((line) => !line.startsWith("#"))
  .join("\n");

if (CYRILLIC.test(written)) {
  const line = written.split("\n").findIndex((one) => CYRILLIC.test(one)) + 1;
  process.stderr.write(
    `The commit message is not in English (line ${line}).\n\n` +
      `Everything that goes to GitHub is English, commit messages included: the\n` +
      `repository is public, and a mixed language closes off exactly the part where\n` +
      `decisions are explained. See CLAUDE.md, "Repository language".\n`,
  );
  process.exit(1);
}

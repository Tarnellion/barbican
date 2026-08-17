/**
 * Sets the executable bit on the built CLI entry point.
 *
 * `chmod +x dist/cli.js` stood in the `build` script, and `chmod` is not a
 * command on Windows. So `pnpm run build` failed there, and with it `pnpm run
 * check`, which build is the last step of — a contributor on Windows could not
 * run the project's own gate. CI would never have found it: every job runs on
 * `ubuntu-latest`. Found by the audit of 14 August 2026 (K-7).
 *
 * The bit matters on POSIX and nowhere else. `dist/cli.js` starts with a
 * shebang, and the `bin` entry in `package.json` makes a package manager link it
 * onto the path; without the bit the shell refuses to run the link. On Windows
 * there is no such bit — npm and pnpm write `.cmd` and `.ps1` shims that invoke
 * `node` explicitly, and `fs.chmodSync` there touches only the read-only flag,
 * which `0o755` leaves clear. So this is the operation that was wanted on both,
 * spelled in the one language both have.
 *
 * A file rather than `node -e "..."` in the script: this paragraph has to live
 * somewhere, and `package.json` has nowhere to put it.
 *
 * Zero dependencies: built-in modules only.
 */

import { chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Owner may write, everyone may read and execute — what `chmod +x` gave. */
const MODE = 0o755;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = join(ROOT, "dist", "cli.js");

try {
  chmodSync(TARGET, MODE);
} catch (error) {
  // Anything but a missing file is this machine's business — a read-only
  // checkout, a permission the user does not have — and the build should stop
  // and say so rather than ship an entry point the shell will refuse to run.
  const reason = error instanceof Error ? error.message : String(error);
  process.stderr.write(`could not make dist/cli.js executable: ${reason}\n`);
  process.exit(1);
}

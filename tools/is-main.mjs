/**
 * "Was this file the one node was told to run?"
 *
 * A script that is also a module needs to know whether to do its work or only
 * hand out its exports. The usual spelling of the question,
 *
 *   process.argv[1] === fileURLToPath(import.meta.url)
 *
 * compares two paths that are not resolved the same way. `import.meta.url` has
 * been through `realpath` — node resolves the entry point through symlinks
 * before it loads it — while `process.argv[1]` is what the command line said,
 * made absolute and nothing more. Put the script behind a symlink, or under a
 * directory that is one, and the two stop matching: the program starts, decides
 * it was imported, does nothing and exits 0. Nothing is printed, so the operator
 * sees a successful run that produced no tokens, and looks for the fault in the
 * platform.
 *
 * This is not a hypothetical. `/tmp` and `/var` are symlinks on macOS, and so is
 * every path under them; a checkout reached through a symlinked home directory,
 * a `pnpm` store, or a tool that stages scripts in a temporary directory all get
 * there the same way. Found by the audit of 14 August 2026 (K-9).
 *
 * Both sides go through `realpath` here, rather than only `argv[1]`: with
 * `--preserve-symlinks-main` it is `import.meta.url` that keeps the symlink, and
 * resolving one side alone would swap which invocation is the broken one.
 *
 * `import.meta.main` says exactly this and needs none of it, but it landed in
 * node 24 and the project supports 22.12 (`.nvmrc`, `engines`). When the floor
 * rises past 24, this file becomes one line and then no file at all.
 *
 * Zero dependencies: built-in modules only.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Whether `moduleUrl` names the file node was launched with.
 *
 * @param {string} moduleUrl the caller's own `import.meta.url`
 * @returns {boolean}
 */
export function isMainModule(moduleUrl) {
  const entry = process.argv[1];
  // `node --eval`, a REPL, or a worker started from source: there is no entry
  // file, so no module is the main one.
  if (entry === undefined) {
    return false;
  }
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    // `realpath` throws when the path is not there — an entry that was deleted
    // mid-run, or a module url that is not a file at all (`data:`, `node:`).
    // Neither is this module being run as a program.
    return false;
  }
}

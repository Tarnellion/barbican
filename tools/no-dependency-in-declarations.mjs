/**
 * The published types depend on nothing but themselves.
 *
 * `configSchema` used to be exported, which put 100 lines of `z.ZodObject<…>`
 * into `config.d.ts` — naming `z.core.$strip`, zod's internal namespace. A zod
 * major would then have changed the package's own types and broken every
 * consumer's build, for a value none of them has a use for. A dependency in a
 * public type is a version of that dependency the package has promised to keep.
 * Found by the audit of 14 August 2026 (E-6).
 *
 * This lived as a shell one-liner in CI alone until 23 August 2026, when cutting
 * `cli.ts` into modules turned a file-local `paint` into an exported one and
 * carried `import { styleText } from "node:util"` into a shipped declaration.
 * Nothing said so until the push: `pnpm run check` ends with `build`, so the
 * declarations existed locally and no one read them. A gate that only runs after
 * the work is pushed is a gate that reports rather than prevents. It runs here,
 * at the end of `build`, and CI calls this same file — the rule is written once.
 *
 * A `node:` builtin is not an exception. Its types come from `@types/node`, a
 * version the consumer picks and this package does not depend on, so it is the
 * same promise as zod's — see the `Ink` comment in `src/cli/screen.ts` for what
 * to do instead.
 */
import { readdir, readFile } from "node:fs/promises";

const NAMES_A_PACKAGE = /^(?:import|export)\b[^\n]*?\sfrom\s+"([^."][^"]*)"/gm;

/**
 * @param {string} directory
 * @returns {AsyncGenerator<string>}
 */
async function* declarations(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) yield* declarations(path);
    else if (entry.name.endsWith(".d.ts")) yield path;
  }
}

const leaks = [];
for await (const path of declarations("dist")) {
  const text = await readFile(path, "utf8");
  for (const [line, specifier] of text.matchAll(NAMES_A_PACKAGE)) {
    leaks.push(`${path}: ${line.trim()}   (names ${specifier})`);
  }
}

if (leaks.length > 0) {
  console.error("A shipped declaration names a package rather than a relative path:");
  for (const leak of leaks) console.error(`  ${leak}`);
  process.exitCode = 1;
} else {
  console.log("no dependency appears in any shipped .d.ts");
}

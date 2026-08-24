#!/usr/bin/env node

/**
 * The CLI entry point: the command line, and nothing that happens after it.
 *
 * The four subcommands are declared here and implemented in `src/cli/`, which
 * is what keeps this file readable as what it is — the surface an operator and a
 * pipeline touch. Every flag the tool accepts is on this page; what any of them
 * costs is a module away.
 *
 * The shape is load-bearing beyond taste. This module is the package's `bin`, it
 * carries the shebang and the executable bit `tools/executable-bit.mjs` sets,
 * and it runs `parseAsync` at the top level — so importing it is running the
 * command, which is how `tests/cli.test.ts` drives it. Splitting the work out
 * from under it must leave all three of those exactly as they were. See ADR-0056.
 */

import { Command, CommanderError } from "commander";
import { diff } from "./cli/compare.js";
import { positiveInteger, type RunFlags } from "./cli/flags.js";
import { pack } from "./cli/pack.js";
import { run } from "./cli/run.js";
import { paint } from "./cli/screen.js";
import { version } from "./cli/version.js";
import { configJsonSchema } from "./io/config.js";

/**
 * A mistake in the command line, not a finding about the platform.
 *
 * commander exits 1 on an unknown option or a missing required one, and 1 is
 * this tool's way of saying "checked, and reality does not match what you
 * declared". So `--unsafe-metods` reported as a privilege escalation, and in CI
 * — the one place the exit code is the whole interface — it reported as one
 * silently: the message goes to stderr, which a pipeline usually does not read
 * when the code already says "failed for a known reason".
 *
 * 64 is `EX_USAGE` from `sysexits.h`: the conventional "the command line was
 * wrong" of Unix CLIs, and outside the 0/1/2 the CI contract uses. Found by the
 * audit of 14 August 2026.
 */
const USAGE_ERROR = 64;

/**
 * The exit code for something commander threw.
 *
 * `--help` and `--version` come through here too — commander treats printing
 * them as an exit — and they are not failures. It marks them with `exitCode: 0`,
 * which is the only thing that separates them from a usage error.
 */
function exitCodeFrom(error: CommanderError): number {
  return error.exitCode === 0 ? 0 : USAGE_ERROR;
}

const program = new Command();

program
  .name("barbican")
  .description("Tests RBAC and tenant isolation in the APIs of multi-tenant platforms")
  .version(version);

program
  .command("run")
  .description("Walk the role × endpoint matrix and compare it with the declared policy")
  .requiredOption("-c, --config <path>", "run configuration (YAML or JSON)")
  .option("-s, --spec <path>", "OpenAPI specification of the API under test")
  .option("-e, --endpoints <path>", "hand-written endpoint list, when there is no spec")
  .option("-p, --postman <path>", "Postman collection v2.1")
  .option("-r, --report <path>", "where to write the JSON report (stdout by default)")
  .option("--checks <ids>", "run only these checks, comma separated (all by default)")
  .option("--unsafe-methods", "allow methods that change state")
  // A negated flag, because the answer is yes by default. The party the marking
  // is for is the owner of the platform, who cannot otherwise tell this run from
  // the intrusion it is shaped like; the party helped by silence is the operator
  // measuring what an unannounced sweep looks like, and that is a deliberate
  // exercise which can say so. The same side the tool takes on write methods and
  // on a mandatory scope. See ADR-0045.
  .option("--no-identify", "do not name the run on the wire (a marked run may be met differently)")
  .option("--dry-run", "print what would be probed and stop, sending nothing")
  // Beside --report rather than taking a path of its own: the stream lives next
  // to the report and is named after it, so a second path here could only ever
  // be a way to point the two at different runs.
  .option("--resume", "continue the walk left in the stream beside --report")
  .option("--concurrency <n>", "concurrent requests", positiveInteger)
  .option("--rps <n>", "requests per second", positiveInteger)
  .option("--max-requests <n>", "per-run request budget", positiveInteger)
  .action(async (flags: RunFlags) => {
    try {
      process.exitCode = await run(flags);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${paint("Run aborted:", "red")} ${message}\n`);
      process.exitCode = 2;
    }
  });

program
  .command("diff")
  .description("Compare two saved reports: what changed, and whether it was the platform")
  .argument("<before>", "the earlier report, written by `run --report`")
  .argument("<after>", "the later one")
  .option("--json", "write the comparison to stdout as JSON instead of a summary")
  .action(async (before: string, after: string, flags: { readonly json?: boolean }) => {
    try {
      process.exitCode = await diff(before, after, flags.json === true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 2 and not 64, and the line is the same one `run` draws: what the
      // argument parser rejects is a usage error, and everything after that —
      // a path that is not there, a file that is not JSON, a document that is
      // not a report — is a conclusion the tool refuses to draw.
      process.stderr.write(`${paint("Comparison aborted:", "red")} ${message}\n`);
      process.exitCode = 2;
    }
  });

program
  .command("pack")
  .description("Draw an evidence pack from a saved report: one clause of the catalogue per row")
  .argument("<report>", "the report, written by `run --report`")
  // Required, and the alternative was letting --json stand alone. The product of
  // this subcommand is the document; the pack is what the document was drawn
  // from, and a command that could produce the second without the first would be
  // `barbican pack` meaning two different things depending on the flags.
  .requiredOption("-o, --out <path>", "where to write the document (one self-contained HTML file)")
  .option("--json <path>", "also write the pack structure the document was drawn from")
  .action(async (report: string, flags: { readonly out: string; readonly json?: string }) => {
    try {
      process.exitCode = await pack(report, flags);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The same line `run` and `diff` draw: what the argument parser rejects is
      // a usage error, and everything past it — a path that is not there, a file
      // that is not JSON, a report of a shape this build cannot read — is a
      // conclusion the tool refuses to draw.
      process.stderr.write(`${paint("Pack aborted:", "red")} ${message}\n`);
      process.exitCode = 2;
    }
  });

program
  .command("schema")
  .description("Print the JSON Schema of the run configuration")
  .action(() => {
    // stdout, so it can be redirected into a file; everything else the CLI says
    // goes to stderr, and mixing the two would make the redirect produce invalid
    // JSON on the first warning.
    process.stdout.write(`${JSON.stringify(configJsonSchema(), null, 2)}\n`);
  });

// `exitOverride` rather than letting commander call `process.exit()` itself:
// with the report going to stdout by default, a hard exit can truncate a write
// that has not drained. Setting `process.exitCode` lets Node finish and leave
// on its own.
//
// On every command, not only the root: commander copies the callback into a
// subcommand when `.command()` creates one, and the subcommands above are
// created before this line runs, so there was nothing to copy. It is the
// subcommand that handles `barbican run --unsafe-metods` — that is, every usage
// error that matters here. Set on the list rather than in each chain, so a
// command added later cannot be forgotten.
program.exitOverride();
for (const command of program.commands) {
  command.exitOverride();
}

try {
  await program.parseAsync();
} catch (error) {
  if (error instanceof CommanderError) {
    process.exitCode = exitCodeFrom(error);
  } else {
    // Nothing else should reach here — the `run` action catches its own — but
    // an escape must not look like a clean run.
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${paint("Aborted:", "red")} ${message}\n`);
    process.exitCode = 2;
  }
}

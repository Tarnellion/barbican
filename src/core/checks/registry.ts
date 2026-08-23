/**
 * The check registry.
 *
 * Per-instance, not global: global state in the core is forbidden. The tool
 * creates the registry explicitly and passes it on.
 */

import type { DiffKind } from "../types.js";
import type { Check, CheckContext, CheckRun, ResolvedFinding } from "./types.js";

export class DuplicateCheckIdError extends Error {
  readonly checkId: string;

  constructor(checkId: string) {
    super(`A check with id "${checkId}" is already registered`);
    this.name = "DuplicateCheckIdError";
    this.checkId = checkId;
  }
}

/**
 * The kinds of matrix discrepancy, which a check may not take for its id.
 *
 * `summary.byKind` is one key space for both: a check id lands in it beside
 * `privilege-escalation` and the rest. A check registered under one of these
 * names would have its findings counted as matrix discrepancies — reported to
 * the reader as privilege escalations, and read by the exit code as such. The
 * names are reserved at registration for the same reason the signal name
 * `digest` is reserved when a configuration is parsed: a collision that can be
 * refused should not be left to be noticed. Found by the audit of 14 August
 * 2026 (B-4).
 *
 * A `Record<DiffKind, true>` and not a `readonly string[]`. The list was the
 * members of `DiffKind` written out a second time, as strings, so the compiler
 * promised nothing in either direction: a fifth kind added to the union would
 * not be reserved — and the first thing that goes wrong is a plugin taking that
 * name, which is the exact defect B-4 was about, now with the type system
 * watching it happen. A mapped type over the union is the one spelling that
 * fails **both** ways: a missing key does not compile, and a key that is not a
 * `DiffKind` does not compile either, so the table cannot reserve a name the
 * matrix does not use. `satisfies readonly DiffKind[]` on the array would have
 * held only the second half. The same shape as `EMPTY_BY_KIND` in
 * `src/report/findings.ts`, which counts the same union and for the same reason.
 * See ADR-0064.
 */
const RESERVED_CHECK_ID_TABLE: Readonly<Record<DiffKind, true>> = {
  "privilege-escalation": true,
  "unexpected-denial": true,
  "not-observed": true,
  "probe-error": true,
};

/**
 * The same table as a list, which is how it is read.
 *
 * `RESERVED_CHECK_ID_TABLE[check.id]` would be indexing an object literal with a
 * string this tool did not choose, and such an index answers for `constructor`
 * and `toString` — a check named `constructor` would be refused as a matrix
 * kind, with a message naming four ids that do not include it. That is the shape
 * ADR-0024 has `lookup()` for, and the core may not import `src/io`; a list and
 * `.includes` is the spelling that needs neither.
 */
const RESERVED_CHECK_IDS: readonly string[] = Object.keys(RESERVED_CHECK_ID_TABLE);

export class ReservedCheckIdError extends Error {
  override readonly name = "ReservedCheckIdError";
  readonly checkId: string;

  constructor(checkId: string) {
    super(
      `A check cannot be registered as "${checkId}": that is a kind of matrix ` +
        `discrepancy, and summary.byKind holds both in one key space. Its ` +
        `findings would be counted as matrix ones and read by the exit code as ` +
        `such. Reserved: ${RESERVED_CHECK_IDS.join(", ")}`,
    );
    this.checkId = checkId;
  }
}

/**
 * A check named on the command line that nobody registered.
 *
 * An error and not a warning: running the other checks quietly would leave the
 * typo's only trace in `checksRun` — an entry missing that nobody was looking
 * for — and the run would read as "checked, and clean here".
 *
 * This block sat above `RESERVED_CHECK_IDS`, four declarations away from the
 * class it describes, so the constant carried two doc comments and the class
 * carried none. Moved back on 23 August 2026.
 */
export class UnknownCheckError extends Error {
  override readonly name = "UnknownCheckError";
  readonly checkId: string;

  constructor(checkId: string, known: readonly string[]) {
    super(
      `No check is registered under "${checkId}". Registered: ${known.join(", ")}. ` +
        `--checks selects from these; omit it to run all of them.`,
    );
    this.checkId = checkId;
  }
}

/**
 * Runs the checks and settles the severity of everything they found.
 *
 * The one place a finding's severity is decided. A check declares `severity`
 * once, on itself; a finding that names none gets that one, and a finding that
 * names one of its own keeps it — a check whose findings genuinely differ in
 * weight can still say so.
 *
 * Here rather than in `src/cli.ts` for the same reason `select` is here: it is a
 * property of what a check is, the core is where that lives, and a test of it
 * should not have to import a module that parses argv on load. Before this, the
 * caller was `selected.flatMap((check) => check.run(context))` and the check
 * repeated its own severity as a literal inside `run()` — two declarations of
 * one fact that no compiler relates. See `Check.severity`; found by the audit of
 * 14 August 2026 (L-8).
 */
export function runChecks(
  checks: readonly Check[],
  context: CheckContext,
): readonly ResolvedFinding[] {
  return checks.flatMap((check) => {
    try {
      return check
        .run(context)
        .map((finding) => ({ ...finding, severity: finding.severity ?? check.severity }));
    } catch (cause) {
      // A check that threw takes itself out of the run and nothing else with it.
      //
      // It used to take everything: `runChecks` is called after the walk and
      // before `buildReport`, so an exception here reached the CLI's handler,
      // printed "Run aborted" and wrote no file — an hour of traffic against
      // somebody else's deployment discarded because one check met a shape it
      // did not expect, which is the ordinary condition of a check reading data
      // from a system nobody here controls. Twenty lines further on, the CLI
      // catches a failure to write the report and prints it to stdout instead,
      // with the reason spelled out: the run is already paid for in traffic, and
      // losing the result now would mean spending it twice. The same argument
      // had not been applied one step earlier.
      //
      // The failure becomes a finding rather than a log line, because a check
      // that crashed and a check that found nothing are indistinguishable
      // otherwise — the distinction `describeChecks` exists to make. A run-level
      // finding is the shape ADR-0025 introduced for exactly this class:
      // something to say about the run rather than about a cell.
      //
      // `error` and not the message: the class name is a bounded vocabulary, and
      // a message from a check is a string this project has not audited for
      // credentials. Found by the audit of 20 August 2026 (M-13).
      return [
        {
          checkId: check.id,
          severity: "high" as const,
          title: `The check "${check.id}" failed and judged nothing`,
          evidence: {
            error: cause instanceof Error ? cause.name : "unknown",
            checkFailed: true,
          },
        },
      ];
    }
  });
}

/**
 * The checks that ran, as the report names them.
 *
 * All of them, the ones that found nothing included: a check nobody registered,
 * or one that crashed, otherwise gives a report indistinguishable from a clean
 * one — its key shows up in `byKind` only once it has found something.
 *
 * In the core, and not two lines in `src/cli.ts` building the objects by hand,
 * because that is where `description` was lost: the mapping named `id` and
 * `standards`, the field existed, and nothing anywhere pointed out that the
 * third one had been left behind.
 */
export function describeChecks(checks: readonly Check[]): readonly CheckRun[] {
  return checks.map((check) => ({
    id: check.id,
    description: check.description,
    standards: check.standards,
  }));
}

export class CheckRegistry {
  readonly #checks = new Map<string, Check>();

  /**
   * Registers a check.
   *
   * @throws {DuplicateCheckIdError} if `id` is already taken — silently
   * overwriting a check would mean silently lost coverage.
   */
  register(check: Check): void {
    if (this.#checks.has(check.id)) {
      throw new DuplicateCheckIdError(check.id);
    }
    if (RESERVED_CHECK_IDS.includes(check.id)) {
      throw new ReservedCheckIdError(check.id);
    }
    this.#checks.set(check.id, check);
  }

  get(id: string): Check | undefined {
    return this.#checks.get(id);
  }

  list(): readonly Check[] {
    return [...this.#checks.values()];
  }

  get size(): number {
    return this.#checks.size;
  }

  /**
   * The checks a particular run will use.
   *
   * ADR-0003 speaks of "a registry assembled for a particular run" and there was
   * no way to assemble one — every registered check ran, always. Undefined keeps
   * that behaviour, which is the safe default: a check left out is coverage left
   * out, and the operator has to say so on purpose.
   *
   * Here rather than in the CLI, because it is a property of the registry and
   * because a test of it should not have to import a module that parses argv on
   * load.
   *
   * @throws {UnknownCheckError}
   */
  select(wanted?: string): readonly Check[] {
    if (wanted === undefined) {
      return this.list();
    }
    const known = this.list().map((check) => check.id);
    const names = wanted
      .split(",")
      .map((one) => one.trim())
      .filter((one) => one !== "");
    // An empty selection is a typo, not a choice.
    //
    // `--checks ""`, `--checks ,` and `--checks " "` all arrived here as "run
    // nothing" and were obeyed in silence: the body channel switched off, the
    // report carrying `checksRun: []`, no warning, and a leak visible only by
    // body leaving the run green. An unknown name is refused with a message
    // naming what is available, and an empty one deserves the same treatment
    // rather than the opposite. There is deliberately no way to spell "run no
    // checks": a check left out is coverage left out, and the flag exists to
    // narrow a run rather than to disarm it. Found by adversarial review on
    // 17 August 2026.
    if (names.length === 0) {
      throw new UnknownCheckError(wanted, known);
    }
    return names.map((id) => {
      const check = this.#checks.get(id);
      if (check === undefined) {
        throw new UnknownCheckError(id, known);
      }
      return check;
    });
  }
}

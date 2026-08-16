/**
 * The check registry.
 *
 * Per-instance, not global: global state in the core is forbidden. The tool
 * creates the registry explicitly and passes it on.
 */

import type { Check } from "./types.js";

export class DuplicateCheckIdError extends Error {
  readonly checkId: string;

  constructor(checkId: string) {
    super(`A check with id "${checkId}" is already registered`);
    this.name = "DuplicateCheckIdError";
    this.checkId = checkId;
  }
}

/**
 * A check named on the command line that nobody registered.
 *
 * An error and not a warning: running the other checks quietly would leave the
 * typo's only trace in `checksRun` — an entry missing that nobody was looking
 * for — and the run would read as "checked, and clean here".
 */
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
 */
const RESERVED_CHECK_IDS: readonly string[] = [
  "privilege-escalation",
  "unexpected-denial",
  "not-observed",
  "probe-error",
];

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
    return wanted
      .split(",")
      .map((one) => one.trim())
      .filter((one) => one !== "")
      .map((id) => {
        const check = this.#checks.get(id);
        if (check === undefined) {
          throw new UnknownCheckError(id, known);
        }
        return check;
      });
  }
}

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

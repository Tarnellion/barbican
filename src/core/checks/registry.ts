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
}

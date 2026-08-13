/**
 * Реестр проверок.
 *
 * Экземплярный, не глобальный: глобальное состояние в ядре запрещено.
 * Инструмент создаёт реестр явно и передаёт его дальше.
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
   * Регистрирует проверку.
   *
   * @throws {DuplicateCheckIdError} если `id` уже занят — молчаливая перезапись
   * проверки означала бы тихо потерянное покрытие.
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

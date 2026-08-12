/**
 * Публичный программный API пакета.
 *
 * Пакет работает и как CLI (bin), и как библиотека (exports).
 *
 * Реализации адаптеров экспортируются наравне с портами: иначе они попадали бы
 * в сборку, но оставались недостижимы для потребителя. Пока версия нулевая,
 * их контракт может меняться.
 */

export * from "./adapters/http.js";
export * from "./adapters/openapi.js";
export * from "./adapters/ports.js";
export * from "./adapters/throttle.js";
export * from "./core/index.js";

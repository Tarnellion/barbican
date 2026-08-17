/**
 * The public programmatic API of the package.
 *
 * The package works both as a CLI (bin) and as a library (exports).
 *
 * Adapter implementations are exported alongside the ports: otherwise they would
 * end up in the build but stay unreachable for a consumer. While the version is
 * zero, their contract may change.
 */

export * from "./adapters/credentials.js";
export * from "./adapters/endpoint-list.js";
export * from "./adapters/http.js";
export * from "./adapters/openapi.js";
export * from "./adapters/ports.js";
export * from "./adapters/postman.js";
// The one that was missing, until 17 August 2026. `createHttpClient` takes a
// `signalExtractor?: SignalExtractor` — a public option whose type a consumer
// could not name — and the whole body-signal half of the tool was unreachable
// from the library while the check that consumes its output was exported. The
// paragraph above is the policy this broke. Found by the audit of 14 August 2026
// (E-1 / B-8); `tests/public-surface.test.ts` is what keeps the list complete.
export * from "./adapters/signals.js";
export * from "./adapters/throttle.js";
export * from "./core/index.js";
export * from "./io/config.js";
export * from "./report/authenticity.js";
export * from "./report/build.js";
export * from "./runner.js";

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
// The grammar for a string from outside, and the whole of it, since 21 August
// 2026. This module was re-exported from nowhere, and the four promises that
// rest on it were all false through the library door. `CredentialProvider`
// returns `Readonly<Record<string, HeaderValue>>` and `HeaderValue` is a brand
// whose only constructors — `headerValue` and `safeHeaders` — were unreachable,
// so the signing provider ADR-0018 says is implementable "on top of the exported
// port" did not compile: TS2305 on the import, TS2322 on the return, and the one
// spelling that did compile was `as never`, which is the grammar bypassed
// entire. ADR-0024's "not from the CLI, and not from a consumer of the library"
// held for the CLI only. And the `UnusablePathTemplateError` ADR-0032 tells a
// consumer to expect could be recognised only by comparing `err.name` to a
// string, against a document that calls the error classes public on purpose
// because `instanceof` needs the class.
//
// Everything from the module, `openRecord` and `lookup` included. They read as
// internal mechanics and they are not: a record keyed by names the tool did not
// choose is the same rule as the others, and a consumer holds one as soon as it
// reads `observation.headers` — the target chose those names, and a report
// parsed back out of JSON carries `Object.prototype`, so indexing it answers for
// `constructor` and assigning to it swallows `__proto__`. Handing out the
// grammar while keeping back the two functions that make it usable is the split
// ADR-0024 exists against. A hand-picked subset would also be a second list
// beside the module's own exports, which is the shape of the fact that went
// stale here in the first place.
export * from "./io/untrusted.js";
export * from "./report/authenticity.js";
export * from "./report/build.js";
// Two saved reports read against each other (ADR-0050). Exported for the same
// reason `buildReport` is: a consumer running the walk from the library holds
// the reports afterwards, and the question "what changed since yesterday" does
// not become a different question because the walk was driven by code. Its
// input is a structural view a `RunReport` satisfies, so no conversion is
// needed; `toComparableRun` is for a report that came back off disk as JSON,
// and `UnreadableReportError` is what it throws — a class rather than a name,
// because telling a mistyped path from a report of another vintage is done in
// a `catch`.
export * from "./report/compare.js";
export * from "./runner.js";

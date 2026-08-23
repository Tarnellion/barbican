/**
 * The run: a walk over the "account × endpoint" matrix, collecting observations.
 *
 * Not the core — there is I/O here, through the `HttpClient` port. And not an
 * adapter — there is no knowledge of a concrete transport here. This is the
 * layer that binds them.
 *
 * The layer is `src/runner/`, and this file is the import path it kept when the
 * 1 726 lines were cut into six modules on 23 August 2026 (ADR-0057). Nothing
 * that imported `./runner.js` had to change, in this repository or in anybody
 * else's, and `src/index.ts` is untouched.
 *
 * Re-exported **by name** rather than with `export *`. The six modules hand each
 * other a good deal more than the package ever promised a consumer —
 * `TEMPLATE_PARAMETER`, `joinUrl`, `substitute`, `withQuery`,
 * `terminalCause`, `unreadableStatusReason` — and `src/index.ts` does
 * `export * from "./runner.js"`, so a star here would put every one of them on
 * the published surface, which the next release is then answerable for.
 * `tests/public-surface.test.ts` exists because a surface nobody enumerated is a
 * surface nobody noticed changing.
 *
 * Under `verbatimModuleSyntax` a type re-exported without the `type` modifier is
 * emitted as a runtime re-export of a name that does not exist at runtime, and
 * the package fails at import. Every type below therefore goes through
 * `export type`.
 */

export {
  PathEscapesTargetError,
  staysWithinTarget,
  UnusablePathValueError,
} from "./runner/address.js";
export type { CanaryResult } from "./runner/canaries.js";
export {
  assertCanariesUsable,
  DeniedCanaryError,
  ExcludedCanaryError,
  probeCanaries,
  TemplatedCanaryError,
  UndiscerningCanaryError,
  UnknownCanaryEndpointError,
  UnsafeCanaryError,
} from "./runner/canaries.js";
export type { ProbeFailure } from "./runner/outcome.js";
export { classifyStatus } from "./runner/outcome.js";
export type { EndpointPlan, SkippedEndpoint } from "./runner/plan.js";
export { planEndpoints } from "./runner/plan.js";
export type { CellRecord } from "./runner/stream.js";
export { ResumeDoesNotFitError } from "./runner/stream.js";
export type { CollectOptions, CollectResult } from "./runner/walk.js";
export { collectObservations } from "./runner/walk.js";

/**
 * The check interface.
 *
 * Checks are plugins rather than hardcode: Module 2 (the evidence pack) is added
 * by registering new checks, not by rewriting the core.
 * See docs/adr/0003-check-registry.md.
 */

import type { AccessMatrix, Severity } from "../types.js";

/**
 * A reference to a clause of an external standard.
 *
 * A hook for Module 2: the mapping of checks onto standard clauses lives next to
 * the check itself, not in a separate table that will drift.
 */
export interface StandardRef {
  /** The standard's identifier, for example `OWASP-API-2023`. */
  readonly standard: string;
  /** The clause inside the standard, for example `API1`. */
  readonly clause: string;
}

/** A single finding of a check. */
export interface Finding {
  readonly checkId: string;
  readonly severity: Severity;
  readonly title: string;
  readonly endpointId?: string;
  readonly accountId?: string;
  /**
   * The request conditions the finding was made under.
   *
   * Mandatory here for exactly the same reason as on matrix discrepancies:
   * without them a finding under conditions and the same one in the baseline
   * merge into a single defect group, and the report declares them one breakage
   * of the platform.
   */
  readonly contextId?: string;
  /**
   * The second account of a paired finding.
   *
   * A field, because it is a contract between layers and was not one. The report
   * reads it to print the other side's request and to group the two sides as one
   * defect, and it used to read it out of `evidence.otherAccountId` — a key by
   * convention, typed as "some scalar", documented nowhere, and impossible for a
   * new check to discover. Found by the audit of 14 August 2026 (L-4).
   *
   * `evidence` keeps carrying it too, for the reader of the JSON who is looking
   * at one finding and not at the schema.
   */
  readonly relatedAccountId?: string;
  /**
   * Machine-readable evidence for the finding.
   *
   * Scalars only, and non-confidential values only: statuses, flags,
   * identifiers. Response bodies and authorization headers do not get in here.
   */
  readonly evidence: Readonly<Record<string, string | number | boolean>>;
}

/**
 * What a run touched and what it did not.
 *
 * Shaped here rather than imported from `src/runner.ts`: the core does not
 * depend on the runner, and a check is core.
 */
export interface RunScope {
  /** Endpoints a request actually went to. */
  readonly probedEndpointIds: readonly string[];
  /** Endpoints left alone, and why. */
  readonly skipped: readonly { readonly endpointId: string; readonly reason: string }[];
  /** The walk was cut short: the tail of the matrix was never reached. */
  readonly truncated: boolean;
}

/**
 * The input of a check.
 *
 * Data only — a check does not go to the network and does not read files.
 *
 * `scope` is here because without it a whole class of statement is
 * inexpressible, not merely unwritten: "this clause was covered **enough**".
 * A check that sees only the matrix can say what it found; it cannot say that
 * four of the seven endpoints the clause is about were never probed, which is
 * the difference between an evidence pack and a list of findings. Added with
 * L-4; the field is optional so that a caller testing a check on a fixture need
 * not invent a run.
 */
export interface CheckContext {
  readonly matrix: AccessMatrix;
  readonly scope?: RunScope;
}

/**
 * What a check examined, in its own terms.
 *
 * The report used to carry `coverage.bodyComparison`, a shape belonging to one
 * particular check, and `src/report/build.ts` imported the type from that
 * check's module — the report layer knowing one plugin by name, which is the
 * arrangement `ADR-0003` exists to prevent. Counters are scalars and named by
 * the check, exactly as `evidence` is.
 *
 * Numbers only, and for the same reason `SignalValue` is a number or a boolean:
 * a string here would be a place for a response body to end up in the report.
 */
export interface CheckCoverage {
  readonly checkId: string;
  /** Absent when the statement is about the run rather than one endpoint. */
  readonly endpointId?: string;
  readonly counters: Readonly<Record<string, number>>;
}

export interface Check {
  readonly id: string;
  readonly description: string;
  readonly severity: Severity;
  readonly standards: readonly StandardRef[];
  /** Synchronous and pure: the same input always gives the same output. */
  run(context: CheckContext): readonly Finding[];
  /**
   * What the check looked at, whether or not it found anything.
   *
   * Optional: a check with nothing to say about its own reach says nothing. But
   * a check that examines pairs, or a subset of endpoints, has to — the absence
   * of a finding from it otherwise reads as "nothing matched" when it may mean
   * "nothing was compared".
   */
  coverage?(context: CheckContext): readonly CheckCoverage[];
}

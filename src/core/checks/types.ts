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
   * Machine-readable evidence for the finding.
   *
   * Scalars only, and non-confidential values only: statuses, flags,
   * identifiers. Response bodies and authorization headers do not get in here.
   */
  readonly evidence: Readonly<Record<string, string | number | boolean>>;
}

/**
 * The input of a check.
 *
 * Data only — a check does not go to the network and does not read files.
 */
export interface CheckContext {
  readonly matrix: AccessMatrix;
}

export interface Check {
  readonly id: string;
  readonly description: string;
  readonly severity: Severity;
  readonly standards: readonly StandardRef[];
  /** Synchronous and pure: the same input always gives the same output. */
  run(context: CheckContext): readonly Finding[];
}

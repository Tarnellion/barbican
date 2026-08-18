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
  /**
   * How bad this particular finding is.
   *
   * Optional, and absent is the ordinary case: it then means the severity the
   * check declares, which `runChecks` stamps on before the finding goes
   * anywhere. A check sets it only where one of its findings genuinely weighs
   * differently from the rest.
   *
   * It used to be required, and the one check in the tree wrote the same literal
   * here that it wrote on itself twelve lines above — two declarations of one
   * fact, in one file, with nothing to make them agree. See `Check.severity`.
   */
  readonly severity?: Severity;
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
   *
   * **That last sentence is a rule for whoever writes a check, and nothing
   * enforces it.** Worth saying plainly, because the neighbouring guarantee is of
   * a different kind: `SignalValue` is `number | boolean`, so a response body
   * cannot be expressed in it at all, and CLAUDE.md says the ban on PII in the
   * report rests on that type. Here `string` is allowed and has to be — a
   * counterpart account id, an endpoint, a reason are all strings, and the
   * evidence pack of Module 2 is built out of them.
   *
   * So the two channels are not equally strong and the difference is deliberate:
   * one is closed by the type system, the other by review of the check being
   * registered. Narrowing this type would close the extension point the registry
   * exists for; bounding the length of a value would stop a body and not a
   * credential, which is a bound rather than a guarantee and needs an ADR of its
   * own before it goes into an interface a future module is built on. Recorded
   * rather than papered over — found by adversarial review on 17 August 2026.
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

/**
 * A finding with its severity settled.
 *
 * What leaves `runChecks` and what the report is built from. The distinction is
 * the whole mechanism: a check may leave `severity` off, and past this point
 * nothing may — the report sorts by it, counts by it and decides the exit code
 * from it, and a `?? "medium"` in any of those places would be a fourth
 * declaration of the same fact.
 */
export interface ResolvedFinding extends Finding {
  readonly severity: Severity;
}

/**
 * A check that ran, as the report names it.
 *
 * Not a bare id: an evidence pack is read from the clause inwards — "what covers
 * ASVS 8.4.1" — and a list of identifiers answers only the other direction. Nor
 * an id and a clause list, which are two labels and no sentence.
 *
 * Shaped in the core rather than in `src/report/build.ts`, where it used to be,
 * because every field of it is the check's own. The report reads it and carries
 * it; it does not decide what is in it.
 */
export interface CheckRun {
  readonly id: string;
  /**
   * What the check asserts, in the check's own words.
   *
   * For the reader of the saved artifact, who has the report and not the source.
   * `standards` says which clause was exercised and the id says by what; neither
   * says what the thing actually looked at, and "identical-response-across-tenants
   * covers ASVS 8.4.1" is not a sentence anyone can audit.
   */
  readonly description: string;
  /** The clauses this check answers for. */
  readonly standards: readonly StandardRef[];
}

export interface Check {
  readonly id: string;
  /**
   * What this check asserts, for a human reading the report.
   *
   * Read by `describeChecks`, which puts it into `coverage.checksRun`.
   *
   * It was declared, filled and read by nobody until 17 August 2026, together
   * with `severity` below — the state `standards` was in until 15 August, and
   * `standards` was wired up rather than deleted. The same answer here, and for
   * the same reason: the field is not decoration, it is the only sentence in the
   * project that says what a check does in words, and a report is read by people
   * who cannot open `src/core/checks/`. Deleting it would also have meant
   * contradicting ADR-0003, which names both fields in the interface it records.
   * Found by the audit of 14 August 2026 (L-8).
   */
  readonly description: string;
  /**
   * How bad this check's findings are, declared once.
   *
   * `runChecks` puts it on every finding that does not carry one of its own, and
   * that is the whole of its use — deliberately, because the alternative is what
   * was here. The value stood on the check and again as a literal inside
   * `run()`, both saying `"high"`, and nothing in the language relates the two:
   * change one and the report goes out with a severity the check does not claim,
   * while the type checker sees two unrelated assignments of a valid `Severity`.
   * The report sorts findings by severity, groups defects by it and derives the
   * exit code from it, so the divergence would not have shown up as a wrong
   * label but as a run that exits 0.
   *
   * It is deliberately **not** carried into `CheckRun`. Putting it there would
   * restore the duplication in the artifact instead of the source: the same
   * number beside the check and on each of its findings, free to disagree.
   */
  readonly severity: Severity;
  readonly standards: readonly StandardRef[];
  /**
   * Synchronous and pure: the same input always gives the same output.
   *
   * Call it through `runChecks` rather than directly, unless the caller is a test
   * that means to look at what one check produces before its severity is settled.
   */
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

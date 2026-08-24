/**
 * The catalogue of standard clauses, and the two questions it exists to answer.
 *
 * Per-instance and not global, for the same reason `CheckRegistry` is: global
 * state in the core is forbidden, and a run assembles what it answers for.
 *
 * That property is not only hygiene here — it is what lets a second standard
 * arrive without this file changing. `OWASP ASVS 5.0` is public and ships as
 * data in `bundled.ts`. GLI-19 and the AGCO requirements are not public: their
 * numbering and their text cannot go into a public repository at all. Both kinds
 * reach the same catalogue through the same `register`, and the private one is
 * registered by whoever holds it, from a source this repository never sees,
 * beside the private checks that cite it. What is validated is never "every ref
 * resolves against the standards this repository ships" but "every ref resolves
 * against the catalogue assembled for this run" — which is exactly as strict on
 * a machine with the private catalogue as CI is here. See ADR-0043.
 */

import type { Check, StandardRef } from "../checks/types.js";
import { identifier } from "../identifiers.js";
import type { StandardClause, StandardDefinition } from "./types.js";

export class DuplicateStandardError extends Error {
  override readonly name = "DuplicateStandardError";
  readonly standard: string;

  constructor(standard: string) {
    super(
      `The standard "${standard}" is already in the catalogue. Registering it ` +
        `twice would silently replace its clauses, and a clause that quietly ` +
        `stopped existing is coverage that quietly stopped being claimed.`,
    );
    this.standard = standard;
  }
}

export class DuplicateClauseError extends Error {
  override readonly name = "DuplicateClauseError";
  readonly standard: string;
  readonly clause: string;

  constructor(standard: string, clause: string) {
    super(
      `The standard "${standard}" declares the clause "${clause}" twice. A ` +
        `clause is a coordinate: two records answering to one identifier make ` +
        `"covered" and "not covered" both true of it.`,
    );
    this.standard = standard;
    this.clause = clause;
  }
}

/**
 * A definition with a field left blank.
 *
 * Every field of a catalogue entry is load-bearing and each one fails
 * differently when it is empty, so the blank is refused at the door rather than
 * discovered in a report: a clause with no `url` is an unattributed paraphrase
 * of a document this repository deliberately does not carry, a standard with no
 * `scope` turns "answered by nothing here" into a claim about a whole standard,
 * a clause with a blank `unansweredBecause` puts an empty cell where a reader
 * will read a reason, and a standard with no clauses at all satisfies every
 * question about coverage by having nothing to be unanswered.
 */
export class IncompleteStandardError extends Error {
  override readonly name = "IncompleteStandardError";
  readonly standard: string;
  readonly field: string;

  constructor(standard: string, field: string) {
    super(`The standard "${standard}" is missing ${field}.`);
    this.standard = standard;
    this.field = field;
  }
}

/** Why a reference a check declared did not land on a catalogue entry. */
export type UnresolvedReason = "unknown-standard" | "unknown-clause";

/**
 * A reference that resolves to nothing.
 *
 * `reason` separates the two cases because their cures are opposite, and telling
 * them apart is what makes a catalogue usable for a standard this repository
 * cannot carry. `unknown-clause` is a typo: the standard is catalogued and the
 * number is not in it, so somebody wrote `8.4.11` for `8.4.1` and the report has
 * been claiming coverage of a clause that does not exist. `unknown-standard` is
 * an absent catalogue: on a machine that has not registered the private
 * definition, a check citing GLI-19 says so in these words rather than looking
 * like a misspelling.
 */
export interface UnresolvedStandardRef {
  readonly checkId: string;
  readonly standard: string;
  readonly clause: string;
  readonly reason: UnresolvedReason;
}

interface Registered {
  readonly definition: StandardDefinition;
  readonly byClause: ReadonlyMap<string, StandardClause>;
}

function blank(value: string): boolean {
  return value.trim() === "";
}

export class StandardCatalog {
  readonly #standards = new Map<string, Registered>();

  /**
   * Adds a standard to this catalogue.
   *
   * @throws {DuplicateStandardError} if the standard is already here.
   * @throws {DuplicateClauseError} if it declares one clause twice.
   * @throws {IncompleteStandardError} if any field of it is blank, or if it
   * carries no clauses.
   */
  register(definition: StandardDefinition): void {
    if (blank(definition.id)) {
      throw new IncompleteStandardError("(unnamed)", "an identifier");
    }
    // The grammar every other identifier in this tool passes. A standard id and
    // a clause id key the rows of `coverage.clauses` and travel into a pack, so
    // they are coordinates and not prose. This door had only a blankness check
    // until 24 August 2026: a private catalogue is registered from code this
    // repository never sees (ADR-0043), which is the same kind of door as a
    // consumer handing `Endpoint[]` to the core — the one ADR-0032 was written
    // about. `title`, `url` and `scope` are prose and are not held here; what
    // that leaves open is named in ADR-0069.
    identifier(definition.id, `The id of the standard "${definition.id}"`);
    if (this.#standards.has(definition.id)) {
      throw new DuplicateStandardError(definition.id);
    }
    if (blank(definition.scope)) {
      throw new IncompleteStandardError(definition.id, "a statement of what it covers");
    }
    if (definition.clauses.length === 0) {
      throw new IncompleteStandardError(definition.id, "clauses");
    }

    const byClause = new Map<string, StandardClause>();
    for (const clause of definition.clauses) {
      if (blank(clause.id)) {
        throw new IncompleteStandardError(definition.id, "an identifier on one of its clauses");
      }
      identifier(clause.id, `The id of clause "${clause.id}" of "${definition.id}"`);
      if (blank(clause.title)) {
        throw new IncompleteStandardError(definition.id, `a summary for the clause "${clause.id}"`);
      }
      if (blank(clause.url)) {
        throw new IncompleteStandardError(definition.id, `a source for the clause "${clause.id}"`);
      }
      // Absent is a state and blank is not. The field says why nothing here
      // answers the clause, and a blank one puts an empty cell where a reader
      // will read a reason — the same failure as a `scope` nobody wrote, one
      // row down. Whether it should have been present at all is not a question
      // this door can ask: the catalogue never sees a check.
      if (clause.unansweredBecause !== undefined && blank(clause.unansweredBecause)) {
        throw new IncompleteStandardError(
          definition.id,
          `a reason on the clause "${clause.id}", which declares that nothing answers it`,
        );
      }
      if (byClause.has(clause.id)) {
        throw new DuplicateClauseError(definition.id, clause.id);
      }
      byClause.set(clause.id, clause);
    }

    this.#standards.set(definition.id, { definition, byClause });
  }

  /** Whether this catalogue carries the standard at all, whatever the clause. */
  has(standard: string): boolean {
    return this.#standards.has(standard);
  }

  /** The clause a reference names, or nothing if either half of it is unknown. */
  clause(ref: StandardRef): StandardClause | undefined {
    return this.#standards.get(ref.standard)?.byClause.get(ref.clause);
  }

  /** What was registered, in the order it was registered. */
  definitions(): readonly StandardDefinition[] {
    return [...this.#standards.values()].map((one) => one.definition);
  }
}

/**
 * The references no catalogue entry answers to.
 *
 * The gate. Without it `StandardRef` is two free strings and a misspelt clause
 * number travels into the report as a coverage row for a requirement that does
 * not exist — a false claim in the direction that matters, since nobody audits a
 * pack for clauses it should not have mentioned.
 *
 * Deliberately a function returning rows rather than something that throws. The
 * caller decides what an unresolved reference is worth: in this repository it is
 * a red test, and on a machine where a private catalogue was not registered the
 * `unknown-standard` rows are the diagnosis rather than a crash.
 */
export function findUnresolvedStandardRefs(
  catalog: StandardCatalog,
  checks: readonly Check[],
): readonly UnresolvedStandardRef[] {
  const unresolved: UnresolvedStandardRef[] = [];
  for (const check of checks) {
    for (const ref of check.standards) {
      if (catalog.clause(ref) !== undefined) {
        continue;
      }
      unresolved.push({
        checkId: check.id,
        standard: ref.standard,
        clause: ref.clause,
        reason: catalog.has(ref.standard) ? "unknown-clause" : "unknown-standard",
      });
    }
  }
  return unresolved;
}

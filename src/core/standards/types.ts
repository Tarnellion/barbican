/**
 * What a clause of an external standard looks like as data in this repository.
 *
 * `StandardRef` — two free strings — is what a check declares, and until now
 * that was the whole of it: nothing said which pairs exist. The consequence was
 * not a wrong answer but a missing question. ADR-0025 took the filter off
 * findings that name no cell precisely so that "this clause is covered by
 * nothing" could be said, and it still could not be said, because there was
 * nothing to iterate over: naming an uncovered clause needs a list of clauses.
 *
 * Two things are deliberately not here.
 *
 * **The text of the requirement.** This repository is public and the standards
 * are published under their own terms. A catalogue entry carries an identifier,
 * one line of our own about what the clause is for, and the address where the
 * real wording lives. That is enough to trace a finding and to look the clause
 * up; it is not a copy of somebody else's document.
 *
 * **Anything a reader has not asked for.** Every field below is read by
 * something: two of them by `findUncoveredClauses`, one by resolution, and all
 * of them by the guard in `register` that refuses a blank. A field declared,
 * filled and read by nobody is the exact defect ADR-0025 was written from, and
 * writing a second one into the module that fixes the first would be a poor
 * joke.
 */

/** One clause, as much of it as this repository is willing to carry. */
export interface StandardClause {
  /**
   * The identifier inside the standard, spelled the way the standard spells it:
   * `8.4.1`, `API1`, `285`. This is the half of `StandardRef` a check declares.
   */
  readonly id: string;
  /**
   * One line of our own saying what the clause is about.
   *
   * Our own on purpose — see the note above. It is what makes a row of
   * `findUncoveredClauses` readable: a bare list of numbers tells whoever is
   * closing a gap nothing about which gap to close first.
   */
  readonly title: string;
  /**
   * Where the real wording is.
   *
   * Mandatory, and the reason is the paraphrase above it: a summary somebody
   * wrote here is not a requirement, and a reader who has to argue about
   * compliance needs the published text. Without this the catalogue would be an
   * unattributed retelling of a document it does not carry.
   */
  readonly url: string;
}

/** One standard, and the part of it this catalogue answers for. */
export interface StandardDefinition {
  /** Matches `StandardRef.standard` exactly: `OWASP-ASVS-5.0`, `CWE`. */
  readonly id: string;
  /**
   * Which part of the standard is catalogued here — and therefore what an
   * answer built on it does not cover.
   *
   * Mandatory, and it is the field that keeps the whole exercise honest.
   * `findUncoveredClauses` answers "covered by no check" **within the
   * catalogue**, and a catalogue that does not state its own boundary turns that
   * into a claim about the whole standard. That is the same false completeness
   * this module exists to remove, moved one level up: a pack that lists eight
   * clauses and says nothing about the other chapters reads as an audit of the
   * standard. So the boundary travels with the answer, on every row.
   */
  readonly scope: string;
  /** In the order a reader of the standard meets them. */
  readonly clauses: readonly StandardClause[];
}

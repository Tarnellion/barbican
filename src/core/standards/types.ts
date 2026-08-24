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
 * something: three of them by `findUnansweredClauses`, one by resolution, and
 * all of them by the guard in `register` that refuses a blank. A field declared,
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
   * `findUnansweredClauses` readable: a bare list of numbers tells whoever is
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
  /**
   * Why nothing in this tool answers this clause — and absent when something
   * does.
   *
   * The one thing on a catalogue entry that is a fact about **this tool** rather
   * than about somebody else's document, and it is here because
   * `src/core/standards/bundled.ts` already said where it belongs: the two CWE
   * weaknesses a status code cannot tell apart "are worth standing in the
   * catalogue as clauses nothing covers … and the reason belongs in the pack
   * rather than in a source comment nobody reading a report will see". It was in
   * a source comment. This is the field that carries it out of one.
   *
   * **Not a flag, and there is deliberately no flag.** Whether a clause is
   * answered is derived by `clauseAnswers` from the registered checks and from
   * the matrix channel's own mapping; there is no boolean here to set, so a
   * clause added tomorrow with nothing behind it cannot be declared covered. All
   * this field adds is the sentence a reader needs when the derivation comes
   * back empty, and `tests/invariants/a-clause-nothing-answers.test.ts` holds the
   * two to agree in both directions over the bundled catalogue: present with
   * something answering is as red as absent with nothing.
   *
   * Optional in the type because `register` cannot check it. The catalogue is
   * built without ever seeing a check — that is what lets a private standard be
   * registered at run time (ADR-0043) — so the door can only refuse a blank.
   * See ADR-0069.
   */
  readonly unansweredBecause?: string;
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
   * `findUnansweredClauses` answers "answered by nothing here" **within the
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

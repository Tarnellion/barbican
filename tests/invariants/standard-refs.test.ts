/**
 * Every clause this repository's checks cite is a clause that exists.
 *
 * The gate. `StandardRef` is two free strings, and until the catalogue arrived
 * there was nothing behind either of them: a check could declare
 * `OWASP-ASVS-5.0 / 8.4.11` and the run would put a coverage row for a
 * requirement that does not exist into the report, over and over, with the
 * mistake visible only to somebody who went and read the standard. It fails in
 * the direction that does not get audited — nobody checks an evidence pack for
 * clauses it should not have mentioned.
 *
 * The checks are discovered rather than listed. A second list beside
 * `src/core/checks/` would be the same fact written twice, and this repository
 * has already watched that shape go stale: `describeChecks` exists because the
 * CLI built `CheckRun` objects by hand and dropped `description` on the way. The
 * factory registered tomorrow is gated here whether or not anybody remembered
 * this file.
 */

import { describe, expect, it } from "vitest";
import type { Check } from "../../src/core/checks/types.js";
import * as api from "../../src/index.js";
import {
  createBundledCatalog,
  findUncoveredClauses,
  findUnresolvedStandardRefs,
} from "../../src/index.js";

/**
 * The check factories the package exports.
 *
 * A factory that one day needs options will stop being callable here, and this
 * is the right place to find that out: a check whose construction the rest of
 * the repository cannot reproduce is a check nothing can validate the claims of.
 */
const FACTORIES = Object.entries(api).filter(
  ([name, value]) => /^create[A-Za-z0-9]*Check$/.test(name) && typeof value === "function",
);

const CHECKS: readonly Check[] = FACTORIES.map(([, make]) => (make as () => Check)());

const CATALOG = createBundledCatalog();

describe("the standard references of the checks this repository ships", () => {
  it("has checks to answer for", () => {
    // A gate that discovered nothing is green for the same reason a passing one
    // is, and this one discovers by pattern rather than by list.
    expect(CHECKS.length).toBeGreaterThan(0);
    expect(CHECKS.every((check) => check.standards.length > 0)).toBe(true);
  });

  /**
   * The gate itself, and it is absolute: no allowance for a standard that is
   * "not catalogued yet".
   *
   * An exception list here would be the shape this repository refuses everywhere
   * else — a pin nobody removes, an entry in `osv-scanner.toml` with no expiry.
   * The consequence is deliberate: a check citing a standard nothing catalogues
   * turns this red until somebody either catalogues it or stops claiming it.
   * Both are the right move; carrying on is not.
   */
  it("all resolve to a clause of the catalogue", () => {
    const unresolved = findUnresolvedStandardRefs(CATALOG, CHECKS).map(
      (row) => `${row.checkId}: ${row.standard}/${row.clause} (${row.reason})`,
    );

    expect(unresolved).toEqual([]);
  });

  /**
   * And the gate is put to a reference that is wrong, so that "everything
   * resolves" is a result rather than a property of an empty comparison.
   *
   * Both spellings of the mistake, because they fail through different branches:
   * a wrong clause under a catalogued standard, and a standard nothing
   * catalogues.
   */
  it("would not stay green on a misspelt reference", () => {
    const first = CHECKS[0] as Check;
    const misspelt: Check = {
      ...first,
      standards: [
        { standard: "OWASP-ASVS-5.0", clause: "8.4.11" },
        { standard: "OWASP-ASVS-5.O", clause: "8.4.1" },
      ],
    };

    expect(findUnresolvedStandardRefs(CATALOG, [misspelt]).map((row) => row.reason)).toEqual([
      "unknown-clause",
      "unknown-standard",
    ]);
  });
});

/**
 * What nothing checks, named.
 *
 * The shape ADR-0025 took the filter off run-level findings for, and the reason
 * a catalogue had to exist before it could be written: naming an uncovered
 * clause needs a list of clauses to iterate over.
 *
 * Pinned by exact equality rather than counted. This is the current state of
 * Module 2's coverage, and it is the one fact about the evidence pack that must
 * not change quietly — a check added, a check's claims widened, or a clause
 * added to the catalogue all move this list, and all three deserve to be read in
 * a diff. The thirteen below are not a backlog of oversights: `tenant-isolation`
 * says in a comment why it does not claim API3 or CWE-862, and a gap with a
 * reason is still a gap worth printing.
 */
describe("the catalogued clauses no check answers for", () => {
  it("are these, and the list moves only on purpose", () => {
    const uncovered = findUncoveredClauses(CATALOG, CHECKS).map(
      (row) => `${row.standard}/${row.clause.id}`,
    );

    expect(uncovered).toEqual([
      "OWASP-ASVS-5.0/8.1.1",
      "OWASP-ASVS-5.0/8.1.3",
      "OWASP-ASVS-5.0/8.2.1",
      "OWASP-ASVS-5.0/8.2.2",
      "OWASP-ASVS-5.0/8.2.3",
      "OWASP-ASVS-5.0/8.3.1",
      "OWASP-ASVS-5.0/8.3.3",
      "OWASP-API-2023/API3",
      "OWASP-API-2023/API5",
      "CWE/284",
      "CWE/862",
      "CWE/863",
      "CWE/639",
    ]);
  });

  /**
   * And the answer is not the whole catalogue, which is what it would be if
   * coverage were never subtracted. 8.4.1 is the clause the one registered check
   * cites, and it is the one that has to be absent from the list above.
   */
  it("leaves out the clause the registered check does cover", () => {
    const uncovered = findUncoveredClauses(CATALOG, CHECKS).map((row) => row.clause.id);

    expect(uncovered).not.toContain("8.4.1");
  });
});

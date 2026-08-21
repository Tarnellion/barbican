/**
 * The clauses of external standards this tool cites, and which of them a matrix
 * discrepancy answers for.
 *
 * Two things live here on purpose, and the second is only affordable because of
 * the first.
 *
 * **The identifiers, spelled once.** A `StandardRef` is a family and a clause
 * number, and both are somebody else's vocabulary. Until now the only ones in
 * the tree sat inline in `tenant-isolation.ts`, which was fine while one check
 * was the only thing that cited a standard. It stopped being fine the moment a
 * second channel had to cite the same clause: two literals that agree today are
 * the shape of every drift this project has a rule about (ADR-0024 on strings
 * from outside, ADR-0030 on a fact described twice). Everything that assigns a
 * clause imports it from here, and `tests/report/matrix-findings-carry-clauses.test.ts`
 * reads `src/` to say that nothing spells one anywhere else.
 *
 * **The mapping for the matrix channel.** `standardsForDiff` is the counterpart
 * of `Check.standards` for findings that come from comparing the declared policy
 * against what the platform did. See ADR-0041 for why the matrix channel gets a
 * mapping rather than becoming a registered check, and for when that stops being
 * the right answer.
 *
 * **No text from a standard is reproduced here** — the identifier and a sentence
 * of this project's own about what the tool takes the clause to mean. The
 * repository is public and the standards are distributed on their own terms.
 * The wording below is therefore a gloss, not a quotation, and where it and the
 * standard disagree the standard wins.
 */

import type { DiffKind, ResourceRelation } from "../types.js";
import type { StandardRef } from "./types.js";

/** OWASP API Security Top 10, 2023 edition. */
export const OWASP_API_2023 = "OWASP-API-2023";
/** OWASP Application Security Verification Standard, version 5.0. */
export const OWASP_ASVS_5_0 = "OWASP-ASVS-5.0";
/** Common Weakness Enumeration. A class of defect, not a control to verify. */
export const CWE = "CWE";

/**
 * Access to a particular object is granted to whoever holds no permission over
 * it. What the tool finds as BOLA/IDOR and as a cross-tenant read of a resource.
 */
export const API_OBJECT_LEVEL_AUTHORIZATION: StandardRef = {
  standard: OWASP_API_2023,
  clause: "API1",
};

/**
 * Access to an operation is granted to whoever holds no permission over it —
 * the endpoint itself rather than an object behind it. The kind of escalation a
 * cell with no resource in it can show.
 */
export const API_FUNCTION_LEVEL_AUTHORIZATION: StandardRef = {
  standard: OWASP_API_2023,
  clause: "API5",
};

/**
 * The authorization rules are written down, so that an implementation can be
 * checked against something other than itself.
 *
 * The premise of this whole tool (ADR-0006): expected access is declared by a
 * human and never derived from the specification of the API under test. Every
 * matrix discrepancy is evidence about this clause first — it is the declaration
 * and the platform disagreeing — whatever else it is evidence about.
 */
export const ASVS_DOCUMENTED_RULES: StandardRef = {
  standard: OWASP_ASVS_5_0,
  clause: "8.1.1",
};

/** An operation is reachable only by a consumer with the permission for it. */
export const ASVS_FUNCTION_LEVEL_ACCESS: StandardRef = {
  standard: OWASP_ASVS_5_0,
  clause: "8.2.1",
};

/** A specific data item is reachable only by a consumer with permission over it. */
export const ASVS_OBJECT_LEVEL_ACCESS: StandardRef = {
  standard: OWASP_ASVS_5_0,
  clause: "8.2.2",
};

/**
 * One tenant's data and functions stay out of another tenant's reach.
 *
 * The clause `identical-response-across-tenants` has cited since it was written,
 * and the matrix channel reaches the same declaration rather than a copy of it.
 */
export const ASVS_TENANT_ISOLATION: StandardRef = {
  standard: OWASP_ASVS_5_0,
  clause: "8.4.1",
};

/**
 * Improper authorization — the parent class, deliberately.
 *
 * Not CWE-862 ("missing") or CWE-863 ("incorrect"): from outside the platform
 * the two are indistinguishable, and the tool only ever sees the outside. The
 * isolation check made this choice first and gave the reason; the matrix channel
 * is in exactly the same position.
 */
export const CWE_IMPROPER_AUTHORIZATION: StandardRef = {
  standard: CWE,
  clause: "285",
};

/**
 * Whether the cell reaches across a tenant boundary.
 *
 * Stated as "neither of the two relations inside one tenant" rather than as a
 * list of the three that cross, because that is the definition and not an
 * enumeration of today's values: `own` and `same-tenant` are exactly the cases
 * where the account is a member of the resource's tenant, and everything else is
 * a boundary crossing by construction. A sixth relation, were ADR-0013 ever to
 * gain one, would be a new kind of kinship between different tenants and belongs
 * on this side; a list of three would silently drop it.
 */
function crossesTenantBoundary(relation: ResourceRelation | undefined): boolean {
  return relation !== undefined && relation !== "own" && relation !== "same-tenant";
}

/**
 * The clauses a matrix discrepancy answers for.
 *
 * The same two axes `severityOf` takes, and for the same reason: what a
 * discrepancy means is a function of its kind and of the cell it stands on, and
 * neither axis alone settles it. `relation` is present exactly when the cell
 * names a resource — `AccessDiff` documents the two as absent together — so it
 * carries the object-level/function-level distinction as well as the kinship.
 *
 * The rule in one sentence: **the cell decides which control the row is evidence
 * about, and the kind decides what kind of evidence it is.**
 *
 * - Every discrepancy cites `ASVS_DOCUMENTED_RULES`: it is a declaration and a
 *   platform disagreeing, which is the one thing all four kinds have in common.
 * - The cell adds the level — object where it names a resource, function where
 *   it does not — and tenant isolation where it crosses a boundary.
 * - Only `privilege-escalation` adds a defect class (`API1`/`API5` and CWE-285).
 *   An unexpected denial is the platform being stricter than the declaration; an
 *   unobserved cell and a failed probe say nothing was learned. Crediting any of
 *   the three with a broken-authorization finding would be the inflated claim of
 *   coverage the isolation check dropped `API3` over.
 *
 * That last point is why the two inconclusive kinds still carry the level clause
 * rather than nothing: an evidence pack needs both directions, and "ASVS 8.2.2
 * was left unproved on 140 cells" is a statement about 8.2.2 that has to reach
 * the clause it is about. A row's `kind` and `severity` say which direction it
 * is; dropping the clause would leave the gap attached to nothing, which is the
 * failure this mapping exists to end.
 *
 * No clause is returned twice: each is appended on exactly one branch.
 */
export function standardsForDiff(
  kind: DiffKind,
  relation?: ResourceRelation,
): readonly StandardRef[] {
  const namesAResource = relation !== undefined;
  const refs: StandardRef[] = [
    ASVS_DOCUMENTED_RULES,
    namesAResource ? ASVS_OBJECT_LEVEL_ACCESS : ASVS_FUNCTION_LEVEL_ACCESS,
  ];
  if (crossesTenantBoundary(relation)) {
    refs.push(ASVS_TENANT_ISOLATION);
  }
  if (kind === "privilege-escalation") {
    refs.push(
      namesAResource ? API_OBJECT_LEVEL_AUTHORIZATION : API_FUNCTION_LEVEL_AUTHORIZATION,
      CWE_IMPROPER_AUTHORIZATION,
    );
  }
  return refs;
}

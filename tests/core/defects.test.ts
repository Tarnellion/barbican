/**
 * Tests for grouping discrepancies by signature.
 *
 * The task came from real runs: three BOLAs in crAPI gave six rows, one missing
 * filter on the reference platform gave ten. The numbers in the report spoke
 * about the size of the matrix, not about the number of problems.
 */

import { describe, expect, it } from "vitest";
import { groupDefects } from "../../src/core/defects.js";
import type { AccessDiff } from "../../src/core/types.js";

function escalation(
  accountId: string,
  endpointId: string,
  overrides: Partial<AccessDiff> = {},
): AccessDiff {
  return {
    accountId,
    endpointId,
    expected: "denied",
    actual: "allowed",
    kind: "privilege-escalation",
    severity: "high",
    ...overrides,
  };
}

describe("groupDefects", () => {
  /** Exactly the crAPI case: one defect seen by a user and by an admin. */
  it("collapses observations of one defect from different angles into one signature", () => {
    const groups = groupDefects([
      escalation("user", "orders.read", { resourceId: "o-1", relation: "foreign-tenant" }),
      escalation("admin", "orders.read", { resourceId: "o-1", relation: "foreign-tenant" }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.violations).toBe(2);
    expect(groups[0]?.accountIds).toEqual(["admin", "user"]);
  });

  /**
   * Different relations are different defects: BOLA inside a tenant and a
   * cross-tenant leak live on the same endpoint but break independently.
   */
  it("does not mix different relations on one endpoint", () => {
    const groups = groupDefects([
      escalation("a", "orders.read", { resourceId: "o-1", relation: "foreign-tenant" }),
      escalation("a", "orders.read", { resourceId: "o-2", relation: "same-tenant" }),
    ]);

    expect(groups).toHaveLength(2);
  });

  it("does not mix different endpoints or different kinds of discrepancy", () => {
    const groups = groupDefects([
      escalation("a", "orders.read"),
      escalation("a", "users.list"),
      escalation("a", "orders.read", { kind: "unexpected-denial", severity: "medium" }),
    ]);

    expect(groups).toHaveLength(3);
  });

  /** Role is not part of the signature: an endpoint open to all is one defect, not two. */
  it("collects the resources and the accounts of a group", () => {
    const groups = groupDefects([
      escalation("a", "orders.read", { resourceId: "o-1", relation: "foreign-tenant" }),
      escalation("b", "orders.read", { resourceId: "o-2", relation: "foreign-tenant" }),
    ]);

    expect(groups[0]?.resourceIds).toEqual(["o-1", "o-2"]);
    expect(groups[0]?.accountIds).toEqual(["a", "b"]);
    expect(groups[0]?.violations).toBe(2);
  });

  it("takes the highest severity of the group", () => {
    const groups = groupDefects([
      escalation("a", "orders.read", { relation: "foreign-tenant", severity: "high" }),
      escalation("b", "orders.read", { relation: "foreign-tenant", severity: "critical" }),
    ]);

    expect(groups[0]?.severity).toBe("critical");
  });

  it("puts critical ones first and does not depend on input order", () => {
    const low = escalation("a", "aaa", { kind: "not-observed", severity: "low" });
    const critical = escalation("b", "zzz", { relation: "foreign-tenant", severity: "critical" });

    expect(groupDefects([low, critical]).map((group) => group.severity)).toEqual([
      "critical",
      "low",
    ]);
    expect(groupDefects([critical, low])).toEqual(groupDefects([low, critical]));
  });

  it("invents no groups on empty input", () => {
    expect(groupDefects([])).toEqual([]);
  });
});

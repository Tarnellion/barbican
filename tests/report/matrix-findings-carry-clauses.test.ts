/**
 * A matrix discrepancy names the clauses it answers for, like a check finding.
 *
 * `standards` was substituted on one branch of `mergeFindings` only — the one
 * fed by the registry — and the field's own comment explained the other branch
 * away: matrix discrepancies "come from the declared policy, not from a check
 * mapped onto a standard". Formally true, and a dead end in practice. The matrix
 * channel is privilege escalation and cross-tenant access, which is everything
 * the tool exists to find; a traceability matrix built from today's report would
 * cover one registered check and none of that. Found as M-11.
 *
 * Two things are under test here and they are one requirement seen from two
 * sides. A finding of every kind carries clauses — the substitution happens —
 * and the identifiers come from a single declaration, so that the day a catalogue
 * of clauses arrives, both channels are pointing at the same names rather than at
 * two copies that agree today. See ADR-0041.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  API_FUNCTION_LEVEL_AUTHORIZATION,
  API_OBJECT_LEVEL_AUTHORIZATION,
  ASVS_DOCUMENTED_RULES,
  ASVS_FUNCTION_LEVEL_ACCESS,
  ASVS_OBJECT_LEVEL_ACCESS,
  ASVS_TENANT_ISOLATION,
  CWE_IMPROPER_AUTHORIZATION,
  standardsForDiff,
} from "../../src/core/checks/clauses.js";
import { createIdenticalResponseCheck } from "../../src/core/checks/tenant-isolation.js";
import type { StandardRef } from "../../src/core/checks/types.js";
import type { AccessDiff, DiffKind, ResourceRelation } from "../../src/core/types.js";
import { RESOURCE_RELATIONS } from "../../src/core/types.js";
import { parseRunConfig } from "../../src/io/config.js";
import type { BuildReportOptions, ReportFinding } from "../../src/report/build.js";
import { buildReport } from "../../src/report/build.js";

const CONFIG = parseRunConfig(`
target: { baseUrl: "https://a.test", allowedHosts: [a.test] }
tenants:
  - { id: t-a }
  - { id: t-b }
accounts:
  - { id: alice, role: user, tenant: t-a, tokenEnv: A }
  - { id: carol, role: user, tenant: t-b, tokenEnv: C }
policy: { fallback: denied, rules: [] }
`);

const ENDPOINTS = [
  { id: "orders.list", method: "GET" as const, path: "/v1/orders" },
  { id: "orders.read", method: "GET" as const, path: "/v1/orders/{id}" },
  { id: "cards.list", method: "GET" as const, path: "/v1/cards" },
];

/**
 * A canary per account with credentials: since ADR-0033 a run without one is
 * untrustworthy, and this file would then be asking its questions of a report
 * that answers 2 to everything.
 */
const CANARIES = [
  { accountId: "alice", endpointId: "orders.list", status: 200, authenticated: true },
  { accountId: "carol", endpointId: "orders.list", status: 200, authenticated: true },
];

/**
 * One discrepancy of each kind, written out by hand.
 *
 * Not driven through `diffAccess`: what is under test is what the report does
 * with a discrepancy, and a fixture produced by the differ would tie the file to
 * the differ's arithmetic instead. Two escalations, because the interesting axis
 * beside `kind` is whether the cell names a resource — that is what tells an
 * object-level clause from a function-level one.
 */
const DIFFS: readonly AccessDiff[] = [
  {
    accountId: "carol",
    endpointId: "orders.read",
    resourceId: "order-a1",
    relation: "foreign-tenant",
    expected: "denied",
    actual: "allowed",
    kind: "privilege-escalation",
    severity: "critical",
  },
  {
    accountId: "carol",
    endpointId: "orders.list",
    expected: "denied",
    actual: "allowed",
    kind: "privilege-escalation",
    severity: "high",
  },
  {
    accountId: "alice",
    endpointId: "orders.list",
    expected: "allowed",
    actual: "denied",
    kind: "unexpected-denial",
    severity: "medium",
  },
  {
    accountId: "alice",
    endpointId: "cards.list",
    expected: "allowed",
    kind: "not-observed",
    severity: "low",
  },
  {
    accountId: "alice",
    endpointId: "cards.list",
    expected: "denied",
    actual: "error",
    kind: "probe-error",
    severity: "low",
  },
];

function build(): readonly ReportFinding[] {
  const options: BuildReportOptions = {
    version: "test",
    config: CONFIG,
    endpoints: ENDPOINTS,
    observations: [],
    skipped: [],
    failures: [],
    unauthenticated: [],
    canariesChecked: 2,
    canaries: CANARIES,
    truncated: false,
    findings: DIFFS,
    policy: { fallback: "denied", rules: [] },
    startedAt: new Date(0),
    finishedAt: new Date(1),
  };
  return buildReport(options).findings;
}

/** The identifier of a clause as a reader of the JSON sees it. */
function idsOf(refs: readonly StandardRef[] = []): readonly string[] {
  return refs.map((ref) => `${ref.standard} ${ref.clause}`);
}

const KINDS: readonly DiffKind[] = [
  "privilege-escalation",
  "unexpected-denial",
  "not-observed",
  "probe-error",
];

describe("the clause mapping for a matrix discrepancy", () => {
  it.each(KINDS)("answers for at least one clause on kind %s", (kind) => {
    for (const relation of [undefined, ...RESOURCE_RELATIONS]) {
      expect(standardsForDiff(kind, relation).length).toBeGreaterThan(0);
    }
  });

  /**
   * A clause cited twice reads as two pieces of evidence in a traceability
   * matrix, and the arithmetic of "what covers this clause" is then wrong by
   * however many times the list repeats itself.
   */
  it.each(KINDS)("names no clause twice on kind %s", (kind) => {
    for (const relation of [undefined, ...RESOURCE_RELATIONS]) {
      const ids = idsOf(standardsForDiff(kind, relation));
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  /**
   * Whether the cell names a resource is what separates object-level access from
   * function-level access, and getting it backwards would credit the tool with a
   * class of finding the cell cannot hold.
   */
  it("cites object-level access where the cell names a resource", () => {
    const refs = standardsForDiff("privilege-escalation", "same-tenant");

    expect(refs).toContain(ASVS_OBJECT_LEVEL_ACCESS);
    expect(refs).toContain(API_OBJECT_LEVEL_AUTHORIZATION);
    expect(refs).not.toContain(ASVS_FUNCTION_LEVEL_ACCESS);
    expect(refs).not.toContain(API_FUNCTION_LEVEL_AUTHORIZATION);
  });

  it("cites function-level access where the cell names no resource", () => {
    const refs = standardsForDiff("privilege-escalation");

    expect(refs).toContain(ASVS_FUNCTION_LEVEL_ACCESS);
    expect(refs).toContain(API_FUNCTION_LEVEL_AUTHORIZATION);
    expect(refs).not.toContain(ASVS_OBJECT_LEVEL_ACCESS);
    expect(refs).not.toContain(API_OBJECT_LEVEL_AUTHORIZATION);
  });

  /** Every relation but the two inside one tenant crosses a tenant boundary. */
  it.each(["descendant-tenant", "ancestor-tenant", "foreign-tenant"] as const)(
    "cites tenant isolation on relation %s",
    (relation: ResourceRelation) => {
      expect(standardsForDiff("privilege-escalation", relation)).toContain(ASVS_TENANT_ISOLATION);
    },
  );

  it.each(["own", "same-tenant"] as const)(
    "does not cite tenant isolation on relation %s",
    (relation: ResourceRelation) => {
      expect(standardsForDiff("privilege-escalation", relation)).not.toContain(
        ASVS_TENANT_ISOLATION,
      );
    },
  );

  /**
   * Only an escalation claims a defect class. An unexpected denial, an
   * unobserved cell and a failed probe are evidence **about** a control, not a
   * demonstration that it is broken, and being credited with one would be the
   * inflated claim of coverage the isolation check dropped `API3` over.
   */
  it.each(["unexpected-denial", "not-observed", "probe-error"] as const)(
    "claims no defect class on kind %s",
    (kind: DiffKind) => {
      const refs = standardsForDiff(kind, "foreign-tenant");

      expect(refs).toContain(ASVS_DOCUMENTED_RULES);
      expect(refs).not.toContain(CWE_IMPROPER_AUTHORIZATION);
      expect(refs).not.toContain(API_OBJECT_LEVEL_AUTHORIZATION);
    },
  );
});

describe("a report built from matrix discrepancies", () => {
  it("carries clauses on a finding of every kind", () => {
    const found = build();

    expect(found.length).toBe(DIFFS.length);
    for (const finding of found) {
      expect(finding.source).toBe("matrix");
      expect(finding.standards ?? []).not.toHaveLength(0);
    }
    expect(new Set(found.map((finding) => finding.kind))).toEqual(new Set(KINDS));
  });

  it("names no clause twice on a finding", () => {
    for (const finding of build()) {
      const ids = idsOf(finding.standards);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("cites tenant isolation on a cross-tenant escalation", () => {
    const leak = build().find((finding) => finding.resourceId === "order-a1");

    expect(idsOf(leak?.standards)).toContain("OWASP-ASVS-5.0 8.4.1");
  });
});

describe("the clause identifiers", () => {
  /**
   * The registered check and the matrix mapping reach the same declarations, by
   * identity and not by two literals that happen to agree today. This is the
   * whole of what makes the second mapping affordable: there is a second place
   * where clauses are **assigned**, and no second place where they are spelled.
   */
  it("are one declaration for both channels", () => {
    const declared = createIdenticalResponseCheck().standards;

    expect(declared).toContain(API_OBJECT_LEVEL_AUTHORIZATION);
    expect(declared).toContain(ASVS_TENANT_ISOLATION);
    expect(declared).toContain(CWE_IMPROPER_AUTHORIZATION);
    expect(standardsForDiff("privilege-escalation", "foreign-tenant")).toContain(
      ASVS_TENANT_ISOLATION,
    );
  });

  /**
   * And nowhere else, which a test has to read the tree to say. A comment
   * claiming a single source cannot notice the next check written with its
   * clauses inline — the failure `untrusted.ts` collected eleven point fixes
   * before it was named a rule (ADR-0024).
   */
  it("are spelled in exactly one module", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const home = join(root, "src/core/checks/clauses.ts");
    const inline: string[] = [];

    for (const file of walk(join(root, "src"))) {
      if (file === home) {
        continue;
      }
      if (/standard:\s*["'`]/.test(readFileSync(file, "utf8"))) {
        inline.push(relative(root, file));
      }
    }

    expect(inline).toEqual([]);
  });
});

function* walk(directory: string): Generator<string> {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      yield* walk(path);
    } else if (path.endsWith(".ts")) {
      yield path;
    }
  }
}

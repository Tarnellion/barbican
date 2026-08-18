/**
 * The policy the guide shows for carrying over an existing roles matrix.
 *
 * "Carrying over a matrix you already have" is the most common way in — the sheet
 * of ticks down "role × endpoint" already exists — and the section turns one row
 * of it into rules. A reader copies that block. So it is parsed here with the
 * same function a run uses, out of the document itself rather than out of a copy:
 * a guide whose only configuration example does not parse teaches the format
 * wrong, and the README example was exactly that until 15 August (E-2).
 *
 * Read from the file and not duplicated, because a second copy is the failure
 * being guarded against.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertReferencesResolve, parseRunConfig } from "../../src/io/config.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const GUIDE = readFileSync(resolve(ROOT, "docs/guide.md"), "utf8");

/** The fenced block under the matrix section, by the heading above it. */
function policyBlock(): string {
  const section = GUIDE.slice(GUIDE.indexOf("## Carrying over a matrix you already have"));
  const start = section.indexOf("```yaml\n") + "```yaml\n".length;
  return section.slice(start, section.indexOf("```", start));
}

describe("the matrix-to-rules example in the guide", () => {
  it("is there to be checked", () => {
    // A test that found nothing would agree with any guide.
    expect(policyBlock()).toContain("policy:");
    expect(policyBlock()).toContain("scope:");
  });

  /**
   * Parsed with the function a run uses, and then checked against the endpoints
   * by `assertReferencesResolve`, which is where a **name** is resolved.
   *
   * Two wrong guesses preceded this one, and both are worth recording because
   * they are the same mistake this project keeps finding: a comment claiming what
   * the code beside it does not do. `parseRunConfig` alone does not resolve names,
   * and a deliberate typo in the example passed a test asserting only that.
   * Neither does `expandPolicy`, which the second attempt used — it expands
   * pattern objects and passes a plain string through untouched, so the typo
   * survived that too. The division is deliberate and documented in
   * `assertReferencesResolve`: patterns are checked where they are expanded,
   * literals where references are resolved.
   */
  it("parses as a run configuration and resolves against real endpoints", () => {
    const config = parseRunConfig(`
target: { baseUrl: "https://api.example.test", allowedHosts: [api.example.test] }
tenants:
  - { id: holding }
  - { id: brand, parent: holding }
accounts:
  - { id: player-1, role: player, tenant: brand, tokenEnv: T_PLAYER }
  - { id: support-1, role: support, tenant: brand, tokenEnv: T_SUPPORT }
  - { id: admin-1, role: admin, tenant: holding, tokenEnv: T_ADMIN }
resources:
  - { id: order-1, tenant: brand, owner: player-1, params: { orderId: "1" } }
${policyBlock()}`);

    expect(config.policy.rules).toHaveLength(5);

    assertReferencesResolve(config, [
      { id: "orders.read", method: "GET", path: "/v1/orders/{orderId}" },
    ]);
  });

  /**
   * And says what the section is about. The whole point of the row is that a tick
   * hides the question "own, or anyone's?", so the example is worth nothing
   * unless it answers it — and unless it states the denial that makes the answer
   * testable.
   */
  it("resolves the asterisk every tick carries", () => {
    const block = policyBlock();

    expect(block).toContain("scope: own");
    expect(block).toContain("scope: same-tenant");
    expect(block).toContain("scope: descendant-tenant");
    // The refusals are the half a spreadsheet never records.
    expect(block).toContain("scope: foreign-tenant, outcome: denied");
  });
});

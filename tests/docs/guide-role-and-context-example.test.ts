/**
 * The two modellings the guide puts side by side: a state as accounts, a
 * condition as a context.
 *
 * The section exists because the choice is easy to get wrong and the wrong one
 * fails quietly — a header nobody honours reads as a broken restriction. So the
 * configuration a reader copies out of it is parsed here with the functions a run
 * uses, out of the document itself rather than out of a copy. A second copy is
 * the failure being guarded against; `guide-matrix-example.test.ts` next door
 * takes the same shape for the same reason.
 *
 * Which function catches what was settled by experiment, not by reading the
 * names, and the answers are not where they look as though they should be:
 *
 * - `parseRunConfig` resolves the **context** a rule names and refuses a context
 *   no rule references. Both happen during parsing, before any endpoint exists.
 * - `assertReferencesResolve` resolves the **endpoint** literals — in rules, in
 *   resources, in contexts and in canaries. It is the only one that needs the
 *   parsed endpoints, which is why it takes them.
 * - `expandPolicy` expands pattern objects and passes a literal string through
 *   untouched, so it answers for neither.
 * - **Nothing at all resolves a role.** A rule reading `roles: [custommer]`
 *   survives `parseRunConfig`, `assertPolicyIsSound`, `expandPolicy` and
 *   `assertReferencesResolve` without a word; it then matches no account and
 *   sends its cells to the fallback. That is the claim the section makes about
 *   roles, and it is why the last test below checks the role names by hand: the
 *   guard this file needs is the one the tool does not have.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Endpoint } from "../../src/core/index.js";
import { ANY, expandPolicy } from "../../src/core/index.js";
import { assertReferencesResolve, parseRunConfig, type RunConfig } from "../../src/io/config.js";
import { assertCanariesUsable } from "../../src/runner.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const GUIDE = readFileSync(resolve(ROOT, "docs/guide.md"), "utf8");

const HEADING = "#### A role is a group of accounts, and a status is not a condition";

/** The endpoints the section's example refers to. Written by hand, like every fixture here. */
const ENDPOINTS: readonly Endpoint[] = [
  { id: "orders.list", method: "GET", path: "/v1/orders" },
  { id: "profile.read", method: "GET", path: "/v1/profile" },
];

/** Everything under the section's heading, up to the next one at any level. */
function section(): string {
  const start = GUIDE.indexOf(HEADING);
  const body = GUIDE.slice(start + HEADING.length);
  const next = body.search(/\n#{2,4} /);
  return next === -1 ? body : body.slice(0, next);
}

/** The fenced YAML blocks of the section, in the order the reader meets them. */
function yamlBlocks(): readonly string[] {
  return [...section().matchAll(/```yaml\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
}

/** What the two blocks leave out, because in the guide they are fragments. */
const TARGET = `
target: { baseUrl: "https://api.example.test", allowedHosts: [api.example.test] }
tenants: [brand-a]
`;

/** The role labels the declared accounts actually carry. */
function declaredRoles(config: RunConfig): ReadonlySet<string> {
  return new Set(config.accounts.map((account) => account.role));
}

/**
 * The check the tool does not make: every role a rule names is a role some
 * account has.
 *
 * A rule whose roles match nobody applies to no cell, and neither the parser nor
 * the reference check says so — see the note at the top of this file. In a
 * configuration that is the operator's problem; in the guide it would be a copied
 * example that silently declares nothing.
 */
function assertRolesMatchAnAccount(config: RunConfig): void {
  const roles = declaredRoles(config);
  for (const rule of config.policy.rules) {
    if (rule.roles === ANY) {
      continue;
    }
    for (const role of rule.roles) {
      expect(roles, `role "${role}" is named by a rule and carried by no account`).toContain(role);
    }
  }
}

/**
 * The other check the tool does not make: a canary points at an endpoint the
 * policy declares accessible to that account.
 *
 * This one caught a defect in the section's own example while it was being
 * written. `canary: profile.read` was declared with no rule covering
 * `profile.read`, so under `fallback: denied` the walk expected a refusal there
 * and the platform would have granted it — a fabricated `privilege-escalation`
 * on both accounts, in an example whose whole subject is a fabricated finding.
 * Nothing in `parseRunConfig` or `assertReferencesResolve` looks at this: a
 * canary resolves as an endpoint reference, and what the policy says about it is
 * a separate question nobody was asking.
 *
 * It is also the claim the last paragraph of the section rests on. A label denied
 * everywhere gives `findUnauthenticated` no cell to count, so the open endpoint
 * has to be declared open, not merely probed.
 */
function assertCanariesAreDeclaredAccessible(config: RunConfig, endpoints: readonly Endpoint[]) {
  // Through the tool's own check rather than a hand-written one.
  //
  // This function used to resolve the policy here and assert `allowed`, because
  // nothing in `src/` did — `assertCanariesUsable` checked that the endpoint
  // exists, is not templated and is not excluded, and stopped there. Writing this
  // example is what surfaced that: a canary the policy denies is a contradiction
  // between two of the operator's own statements, and the run reported it as a
  // privilege escalation on the platform. It is refused before the first request
  // now, so the guard here is the real one and this file no longer keeps a second
  // opinion about what a usable canary is.
  expect(() =>
    assertCanariesUsable({
      endpoints,
      canaries: config.accounts.flatMap((account) =>
        account.canary === undefined
          ? []
          : [{ accountId: account.id, endpointId: account.canary, roleId: account.role }],
      ),
      policy: expandPolicy(config.policy, endpoints),
    }),
  ).not.toThrow();
}

describe("the role-and-context example in the guide", () => {
  it("is there to be checked", () => {
    // A test that found nothing would agree with any guide.
    const blocks = yamlBlocks();
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain("accounts:");
    expect(blocks[1]).toContain("contexts:");
  });

  /**
   * The state: two accounts, two labels, and the canary that keeps the denied one
   * distinguishable from a token that never worked.
   */
  it("parses the state as a run configuration and resolves against real endpoints", () => {
    const config = parseRunConfig(`${TARGET}${yamlBlocks()[0]}`);

    expect(config.accounts).toHaveLength(2);
    expect(declaredRoles(config).size).toBe(2);
    // Every account here has credentials, so every one of them needs a canary —
    // and `assertReferencesResolve` is what refuses a canary pointing nowhere.
    expect(config.accounts.every((account) => account.canary !== undefined)).toBe(true);

    assertReferencesResolve(config, ENDPOINTS);
    assertRolesMatchAnAccount(config);
    assertCanariesAreDeclaredAccessible(config, ENDPOINTS);
  });

  /**
   * The condition: the same account under a tagged request. Its accounts come out
   * of the block above rather than being written again here — the prose says "one
   * account, alice above", and a copy would let that stop being true.
   */
  it("parses the condition as a run configuration and resolves against real endpoints", () => {
    const [state, context] = yamlBlocks();
    const alice = (state ?? "").split("\n").find((line) => line.includes("id: alice"));
    expect(alice, "the state block no longer declares alice").toBeDefined();

    const config = parseRunConfig(`${TARGET}accounts:\n${alice}\n${context}`);

    expect(config.contexts).toHaveLength(1);
    expect(config.contexts[0]?.endpointIds).toEqual(["orders.list"]);

    assertReferencesResolve(config, ENDPOINTS);
    assertRolesMatchAnAccount(config);
    assertCanariesAreDeclaredAccessible(config, ENDPOINTS);
  });

  /**
   * And the two blocks still say different things.
   *
   * The section is worth nothing if both examples collapse into one modelling: a
   * state is more accounts under more labels, a condition is more rows over one
   * account. Each half is asserted where it lives, so gutting either one is a red
   * test rather than a paragraph that no longer matches its example.
   */
  it("keeps the two modellings apart", () => {
    const [state, context] = yamlBlocks();

    // A state is groups of accounts: two labels, no conditions anywhere.
    expect(state).toContain("role: customer-blocked");
    expect(state).not.toContain("context");

    // A condition is one label and a rule that names the conditions explicitly —
    // without that rule the cells fall through to the fallback instead.
    expect(context).toContain("context: geo-blocked");
    expect(context).not.toContain("role:");
  });
});

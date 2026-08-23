/**
 * The number `--dry-run` bills, against the requests the run then makes.
 *
 * The preview's arithmetic and the traffic it describes live in different
 * modules and are computed by different code: `describePlan` counts cells and
 * multiplies canary accounts by `CANARY_REQUESTS_PER_ACCOUNT`, while the
 * requests come out of `probeBeforeWalk`, `collectObservations` and
 * `confirmAfterWalk`. Two computations of one number, which is the shape
 * ADR-0064 is about — and the one instance of it this repository held by
 * literals on both sides rather than by comparing them.
 *
 * What was already held, and is not what this file adds:
 * `tests/runner/canary-cost.test.ts` counts the requests the two canary passes
 * issue and compares them with the constant; `tests/cli/preview.test.ts` asserts
 * the sentences the preview prints for a fixture whose numbers a human worked
 * out. Both hold one side to a literal. Neither notices when the two sides stop
 * describing the same run.
 *
 * This is the link: one declaration, previewed and then walked against a
 * counting client, and the bill compared with the count. It fails when the
 * preview's canary arithmetic changes, when it counts the wrong accounts as
 * owing canaries, when the cell arithmetic and the walk's disagree, and when a
 * pass is added to or dropped from either end of the run.
 *
 * **What it does not hold**, deliberately:
 *
 * - The client is a stub. Retries on `429` and `5xx`, the throttle and the
 *   `--max-requests` ceiling all change how many requests reach a platform, and
 *   the preview models none of them — it says how many the walk asks for, and
 *   that is what is compared. The ceiling has a line of its own in the preview
 *   and a test of its own next door.
 * - It compares totals, not the placement of each request. A preview that
 *   overcounted cells by exactly as much as it undercounted canaries would pass
 *   here; the two numbers are printed separately and asserted separately below
 *   for that reason.
 * - Nothing here proves the polygon's numbers are the *right* ones. It proves
 *   the two halves of this tool agree about them.
 *
 * See ADR-0064.
 */

import { describe, expect, it } from "vitest";
import { CANARY_REQUESTS_PER_ACCOUNT } from "../../src/runner/canaries.js";
import {
  inlineDeclaration,
  polygonDeclaration,
  previewOf,
  requestsIssuedBy,
} from "../fixtures/preview-against-the-walk.js";

describe("what a dry run bills, against what the run sends", () => {
  /**
   * The reference polygon: nine accounts on three authentication surfaces, a
   * tenant tree three deep, two sets of request conditions, an excluded write
   * endpoint and seven endpoints of which one is skipped. A declaration big
   * enough that an arithmetic mistake has somewhere to hide.
   */
  it("sends exactly what it promised, on the reference polygon", async () => {
    const declaration = polygonDeclaration();

    const estimate = await previewOf(declaration);
    const sent = await requestsIssuedBy(declaration);

    expect(sent).toHaveLength(estimate.total);
  });

  /**
   * And the halves separately, so that two errors cancelling out cannot pass.
   * The canary half is the one with the history: counting the passes once made
   * the preview call a `--max-requests` ceiling sufficient that stops the second
   * pass, and a run whose authentication is never confirmed a second time reads
   * as clean.
   */
  it("bills the canary passes and the walk apart from each other", async () => {
    const declaration = polygonDeclaration();

    const estimate = await previewOf(declaration);
    const sent = await requestsIssuedBy(declaration);

    const withCanary = declaration.config.accounts.filter(
      (account) => account.canary !== undefined,
    ).length;
    expect(estimate.canaryRequests).toBe(withCanary * CANARY_REQUESTS_PER_ACCOUNT);
    expect(sent).toHaveLength(estimate.cells + withCanary * CANARY_REQUESTS_PER_ACCOUNT);
  });

  /**
   * A declaration cannot be walked past by accident: the numbers have to be big
   * enough that the comparison above is a comparison. A polygon reduced to one
   * account and one endpoint would still satisfy it, and would hold nothing.
   */
  it("is measured against a matrix with something in it", async () => {
    const estimate = await previewOf(polygonDeclaration());

    expect(estimate.cells).toBeGreaterThan(100);
    expect(estimate.canaryRequests).toBeGreaterThan(20);
  });

  /**
   * An account that has credentials and no canary of its own.
   *
   * The polygon has none — every account there with a `tokenEnv` declares one —
   * so on the polygon alone "accounts that declare a canary" and "accounts that
   * have a token" are the same set, and a preview billing either would agree
   * with the walk. This is the declaration that tells them apart: `bare` is
   * owed a canary, is warned about, and costs nothing, because a canary that is
   * not declared is not probed.
   */
  it("bills nothing for an account that has a token and no canary", async () => {
    const declaration = inlineDeclaration(
      `
target:
  baseUrl: http://127.0.0.1:8787
  allowedHosts: [127.0.0.1]
  label: an account owed a canary
accounts:
  - { id: alice, role: user, tenant: tenant-a, tokenEnv: T_ALICE, canary: orders.list }
  - { id: bare, role: user, tenant: tenant-a, tokenEnv: T_BARE }
resources:
  - { id: order-a-1, tenant: tenant-a, owner: alice, params: { orderId: "A-1" } }
policy:
  fallback: denied
  rules:
    - { roles: [user], endpoints: [orders.list], outcome: allowed }
`,
      `
endpoints:
  - { id: orders.list, method: GET, path: /v1/orders }
  - { id: orders.read, method: GET, path: "/v1/orders/{orderId}" }
`,
    );

    const estimate = await previewOf(declaration);
    const sent = await requestsIssuedBy(declaration);

    expect(estimate.screen).toContain("No canary is declared for: bare");
    expect(estimate.canaryRequests).toBe(CANARY_REQUESTS_PER_ACCOUNT);
    expect(sent).toHaveLength(estimate.total);
  });
});

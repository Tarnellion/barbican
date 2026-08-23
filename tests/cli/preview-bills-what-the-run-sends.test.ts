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
 * ## Both modes, because the undercount is worst in the second
 *
 * Until 23 August 2026 every case here ran one command line: no
 * `--unsafe-methods` on the flags, `allowUnsafeMethods: false` hardcoded on the
 * walk. So `allowUnsafeMethods: flags.unsafeMethods === true` in
 * `src/cli/preview.ts` could be replaced by the literal `false` with the whole
 * suite green — the preview would then bill a safe run's matrix while the walk
 * sent the write cells too.
 *
 * That is the worst place in this tool for an undercount. With
 * `--unsafe-methods` the run issues writes; an operator reads the bill, picks a
 * `--max-requests` ceiling the preview called sufficient, and the ceiling
 * truncates a run that has already changed objects on somebody else's
 * deployment. A truncated read is a gap in the report; a truncated write is a
 * platform left half-modified.
 *
 * The other switches that change what a run sends were looked at in the same
 * pass. `--resume` is here too: the preview subtracts the carried cells and the
 * walk does not probe them, which is two computations of one number. `--checks`
 * is not, and does not need to be — it selects what is compared once a response
 * is in hand, and neither side counts requests by it; the preview prints the
 * selection on a line of its own. A declared context set was already covered:
 * the polygon has two, and both halves read `endpointIds` from them.
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
 * - The two modes are compared per mode, not against each other's traffic. What
 *   a write cell *does* to the platform is the polygon oracle's subject, not
 *   this file's.
 *
 * See ADR-0064.
 */

import { describe, expect, it } from "vitest";
import { SAFE_METHODS } from "../../src/core/index.js";
import { CANARY_REQUESTS_PER_ACCOUNT } from "../../src/runner/canaries.js";
import {
  cellsWalkedBy,
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
   * And the same comparison with `--unsafe-methods`, which is the mode the
   * undercount is worst in.
   *
   * The polygon's `orders.cancel` is `POST /v1/orders/{orderId}/cancel`, skipped
   * without the flag and walked with it, so the two modes are two different
   * matrices and a preview that billed the safe one for an unsafe run would be
   * short by exactly those cells.
   */
  it("sends exactly what it promised with --unsafe-methods", async () => {
    const declaration = polygonDeclaration();
    const mode = { unsafeMethods: true };

    const estimate = await previewOf(declaration, mode);
    const sent = await requestsIssuedBy(declaration, mode);

    expect(sent).toHaveLength(estimate.total);
  });

  /**
   * The two halves apart from each other again, and in this mode it is the cell
   * half that moves: the canary passes are the same accounts and the same
   * endpoints whichever methods the walk is allowed.
   */
  it("bills the canary passes and the walk apart from each other with --unsafe-methods", async () => {
    const declaration = polygonDeclaration();
    const mode = { unsafeMethods: true };

    const estimate = await previewOf(declaration, mode);
    const sent = await requestsIssuedBy(declaration, mode);

    const withCanary = declaration.config.accounts.filter(
      (account) => account.canary !== undefined,
    ).length;
    expect(estimate.canaryRequests).toBe(withCanary * CANARY_REQUESTS_PER_ACCOUNT);
    expect(sent).toHaveLength(estimate.cells + withCanary * CANARY_REQUESTS_PER_ACCOUNT);
  });

  /**
   * And the two modes really are two, on both sides.
   *
   * Without this the case above is satisfied by a polygon that has no write
   * endpoint left: the bill and the count would agree at the safe number and
   * the mode would be tested by nothing. The walk's side is asserted from the
   * requests themselves rather than from the bill — a method outside
   * `SAFE_METHODS` went over the wire, which is the whole difference the flag
   * buys and the reason an undercount here is expensive.
   */
  it("walks a larger matrix under --unsafe-methods, and writes", async () => {
    const declaration = polygonDeclaration();

    const safe = await previewOf(declaration);
    const unsafe = await previewOf(declaration, { unsafeMethods: true });
    const sent = await requestsIssuedBy(declaration, { unsafeMethods: true });

    expect(unsafe.cells).toBeGreaterThan(safe.cells);
    const safeMethods = new Set<string>(SAFE_METHODS);
    expect(sent.filter((request) => !safeMethods.has(request.method)).length).toBeGreaterThan(0);
  });

  /**
   * `--resume`: the cells a previous walk finished come off the bill, and the
   * walk does not probe them again.
   *
   * Two computations of one number, like the canary passes: `describePlan`
   * subtracts `carried.records.length`, and `collectObservations` resolves each
   * record onto a cell of the matrix and skips it. The records come from a real
   * walk of the same declaration, because a hand-written one that fits no cell
   * is refused before the first request and would test the refusal instead.
   */
  it("bills a resumed run for what is left of it", async () => {
    const declaration = polygonDeclaration();
    const carried = (await cellsWalkedBy(declaration)).slice(0, 40);
    const mode = { resumed: carried };

    const whole = await previewOf(declaration);
    const estimate = await previewOf(declaration, mode);
    const sent = await requestsIssuedBy(declaration, mode);

    expect(carried).toHaveLength(40);
    expect(estimate.cells).toBe(whole.cells - carried.length);
    expect(sent).toHaveLength(estimate.total);
    expect(estimate.screen).toContain(`${carried.length} are already in the`);
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

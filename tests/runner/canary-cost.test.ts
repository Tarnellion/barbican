/**
 * What a canary costs in requests, counted rather than asserted.
 *
 * `--dry-run` bills the operator for canary traffic before a single request
 * exists, and it billed them with the literal `3`, twice, in
 * `src/cli/preview.ts`. The implementation of that number is somewhere else
 * entirely: two calls to `probeCanaries` from `src/cli/canaries.ts`, one of them
 * with `controlRequests: false`. Nothing linked the two, and the comment beside
 * the literal names the cost of getting it wrong — a preview that counts the
 * passes once calls a `--max-requests` ceiling sufficient that stops the second
 * pass, and a run whose authentication is never confirmed a second time reads as
 * clean.
 *
 * `CANARY_REQUESTS_PER_ACCOUNT` is now the one place the number is written, but
 * a constant is still only a claim about code sitting in another file. This is
 * what makes it true: both passes are driven exactly as the run drives them,
 * against a client that counts, and the count is compared with the number the
 * preview does its arithmetic with. Add a request to either pass, drop the
 * second pass, or re-rank the sum, and this fails.
 *
 * See ADR-0064.
 */

import { describe, expect, it } from "vitest";
import { createCredentialProvider, DEFAULT_AUTH_SCHEME } from "../../src/adapters/credentials.js";
import type { HttpClient, HttpRequest } from "../../src/adapters/ports.js";
import { confirmAfterWalk, probeBeforeWalk } from "../../src/cli/canaries.js";
import type { Account, Endpoint } from "../../src/core/index.js";
import { CANARY_REQUESTS_PER_ACCOUNT } from "../../src/runner/canaries.js";

const endpoints: readonly Endpoint[] = [{ id: "orders", method: "GET", path: "/v1/orders" }];

const accounts: readonly Account[] = [{ id: "bob", roleId: "support" }];

const canaries = [{ accountId: "bob", endpointId: "orders" }];

const credentials = createCredentialProvider(DEFAULT_AUTH_SCHEME, new Map([["bob", "tok"]]));

/**
 * A canary that tells a credentialed request from an anonymous one.
 *
 * The discerning answer and not a flat 200: a canary that answers everybody
 * stops the run with `UndiscerningCanaryError` before the second pass, and the
 * count taken from such a run would be the count of a run that never happened.
 */
function countingClient() {
  const seen: HttpRequest[] = [];
  const client: HttpClient = {
    send(request) {
      seen.push(request);
      return Promise.resolve({
        status: request.headers.authorization === undefined ? 401 : 200,
        headers: {},
      });
    },
  };
  return { client, seen };
}

async function walkWithCanaries() {
  const { client, seen } = countingClient();
  const pass = {
    baseUrl: "https://api.test",
    endpoints,
    canaries,
    credentials,
    client,
    exclude: [],
    allowUnsafeMethods: false,
    accounts,
    tenantBaseUrls: new Map(),
  };
  const before = await probeBeforeWalk(pass);
  const after = await confirmAfterWalk({ ...pass, before, truncated: false });
  return { seen, before, after };
}

describe("the cost of a canary, as the preview bills it", () => {
  it("issues exactly the number the preview does its arithmetic with", async () => {
    const { seen } = await walkWithCanaries();

    expect(seen).toHaveLength(CANARY_REQUESTS_PER_ACCOUNT * canaries.length);
  });

  /**
   * And the number is the one the preview prints, not merely some number both
   * sides agree on. A test that only compared the count with the constant would
   * stay green with both moved to 4 and the run made a third of a percent more
   * expensive on somebody else's deployment for no reason anybody wrote down.
   */
  it("is three: two credentialed passes and one anonymous control request", async () => {
    const { seen } = await walkWithCanaries();

    expect(CANARY_REQUESTS_PER_ACCOUNT).toBe(3);
    expect(seen.filter((request) => request.headers.authorization !== undefined)).toHaveLength(2);
    expect(seen.filter((request) => request.headers.authorization === undefined)).toHaveLength(1);
  });

  /**
   * The second pass is half the bill, and it is the half a preview that
   * undercounts talks the operator out of paying for. ADR-0033's later half
   * lives in it: a token that dies mid-walk turns every remaining cell into a
   * 401 that reads as a denial and agrees with a policy of denial.
   */
  it("spends its second credentialed request after the walk, not before it", async () => {
    const { client, seen } = countingClient();
    const pass = {
      baseUrl: "https://api.test",
      endpoints,
      canaries,
      credentials,
      client,
      exclude: [],
      allowUnsafeMethods: false,
      accounts,
      tenantBaseUrls: new Map(),
    };

    await probeBeforeWalk(pass);

    expect(seen).toHaveLength(CANARY_REQUESTS_PER_ACCOUNT - 1);
  });

  /** An account with no canary declared is billed nothing, and sends nothing. */
  it("costs nothing where no canary is declared", async () => {
    const { client, seen } = countingClient();
    const pass = {
      baseUrl: "https://api.test",
      endpoints,
      canaries: [],
      credentials,
      client,
      exclude: [],
      allowUnsafeMethods: false,
      accounts,
      tenantBaseUrls: new Map(),
    };
    const before = await probeBeforeWalk(pass);
    await confirmAfterWalk({ ...pass, before, truncated: false });

    expect(seen).toHaveLength(0);
  });
});

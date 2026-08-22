/**
 * A canary on an endpoint that answers everybody proves nothing.
 *
 * The fourth road to the state ADR-0033 was written to end, and the only one
 * that leaves a canary sitting in the configuration doing nothing at all. The
 * three closed before it were a dead token with no canary of its own, a typo in
 * the `tokenEnv` key that made the account anonymous, and a request ceiling that
 * ate the second pass. This one needs no mistake: `/health`, `/version`,
 * `/api/status` are what an operator reaches for when asked to name an endpoint
 * the account can reach, and every one of them answers 2xx to anybody.
 *
 * With one of those nominated, a dead token passed the canary, every cell of the
 * account came back 401, the policy declared it denied, and the report said
 * `match: true` on all of them with exit 0 — "tested and clean" about
 * credentials nothing had ever shown to work.
 *
 * See ADR-0040 and the adversarial review of 21 August 2026 (V-2).
 */

import { describe, expect, it } from "vitest";
import { createCredentialProvider, DEFAULT_AUTH_SCHEME } from "../../src/adapters/credentials.js";
import type { HttpClient, HttpRequest } from "../../src/adapters/ports.js";
import type { Endpoint } from "../../src/core/index.js";
import { probeCanaries, UndiscerningCanaryError } from "../../src/runner.js";

const endpoints: readonly Endpoint[] = [
  { id: "health", method: "GET", path: "/health" },
  { id: "orders", method: "GET", path: "/v1/orders" },
];

const credentials = createCredentialProvider(DEFAULT_AUTH_SCHEME, new Map([["bob", "tok"]]));

function clientThat(reply: (request: HttpRequest) => number) {
  const seen: HttpRequest[] = [];
  const client: HttpClient = {
    send(request) {
      seen.push(request);
      return Promise.resolve({ status: reply(request), headers: {} });
    },
  };
  return { client, seen };
}

async function probe(reply: (request: HttpRequest) => number, controlRequests?: boolean) {
  const { client, seen } = clientThat(reply);
  const results = await probeCanaries({
    baseUrl: "https://api.test",
    endpoints,
    canaries: [{ accountId: "bob", endpointId: "health" }],
    credentials,
    client,
    ...(controlRequests === undefined ? {} : { controlRequests }),
  });
  return { results, seen };
}

describe("the control request behind a canary", () => {
  it("asks the same endpoint with no credentials at all", async () => {
    const { seen } = await probe(() => 200);

    expect(seen).toHaveLength(2);
    expect(seen[0]?.headers.authorization).toBe("Bearer tok");
    expect(seen[1]?.url).toBe(seen[0]?.url);
    expect(seen[1]?.headers.authorization).toBeUndefined();
  });

  it("records what an endpoint that answers everybody said", async () => {
    const { results } = await probe(() => 200);

    expect(results[0]?.authenticated).toBe(true);
    expect(results[0]?.anonymousStatus).toBe(200);
  });

  it("records the refusal of an endpoint that tells them apart", async () => {
    const { results } = await probe((request) =>
      request.headers.authorization === undefined ? 401 : 200,
    );

    expect(results[0]?.anonymousStatus).toBe(401);
  });

  /**
   * Nothing to control against, and the run is stopping anyway: a request spent
   * here is spent on a platform that is not ours to spend requests on.
   */
  it("is not sent when the credentialed request did not succeed", async () => {
    const { results, seen } = await probe(() => 401);

    expect(seen).toHaveLength(1);
    expect(results[0]?.anonymousStatus).toBeUndefined();
  });

  /** The pass that follows the walk asks nothing new: see ADR-0040. */
  it("is not sent on the pass that follows the walk", async () => {
    const { seen } = await probe(() => 200, false);

    expect(seen).toHaveLength(1);
  });
});

describe("the error a canary that proves nothing raises", () => {
  it("names the account, the endpoint and what the endpoint answered", () => {
    const error = new UndiscerningCanaryError("bob", "health", 200);

    expect(error.name).toBe("UndiscerningCanaryError");
    expect(error.message).toContain('"bob"');
    expect(error.message).toContain('"health"');
    expect(error.message).toContain("200");
    expect(error.message).toContain("refuses an anonymous request");
  });
});

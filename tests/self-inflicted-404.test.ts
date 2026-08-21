/**
 * A 404 this run caused itself is not evidence of protection.
 *
 * With `--unsafe-methods` the walk stops being a read. The first account to
 * `DELETE` an order gets 200 and the order is gone; every later account gets
 * 404, which folds into a denial and agrees with a policy of denial. The tool
 * then reports "tested and agreed" about a protection it never observed, having
 * manufactured the answer itself — a false negative, and one that also makes the
 * report depend on the traversal order.
 *
 * Found by the audit of 14 August 2026 (L-7), which also notes why nothing
 * caught it: the polygon's one write endpoint was deliberately chosen to sidestep
 * the class — its `cancelled` flag is set and never read — so the oracle, the
 * strongest gate this project has, is blind to it by construction.
 */

import { describe, expect, it } from "vitest";
import { createCredentialProvider, DEFAULT_AUTH_SCHEME } from "../src/adapters/credentials.js";
import type { HttpClient, HttpRequest } from "../src/adapters/ports.js";
import type { Account, Endpoint, Resource } from "../src/core/index.js";
import { collectObservations } from "../src/runner.js";

const ACCOUNTS: readonly Account[] = [
  { id: "first", roleId: "r", tenantId: "t" },
  { id: "second", roleId: "r", tenantId: "t" },
  { id: "third", roleId: "r", tenantId: "t" },
];

const CREDENTIALS = createCredentialProvider(
  DEFAULT_AUTH_SCHEME,
  new Map(ACCOUNTS.map((account) => [account.id, `token-${account.id}`])),
);

const DELETE_ORDER: Endpoint = {
  id: "orders.delete",
  method: "DELETE",
  path: "/v1/orders/{orderId}",
};

const ORDER: readonly Resource[] = [{ id: "order-1", tenantId: "t", params: { orderId: "1" } }];

/** A platform that really deletes: the first caller wins, the rest get 404. */
function deletingPlatform(): HttpClient {
  const gone = new Set<string>();
  return {
    send(request: HttpRequest) {
      const url = new URL(request.url);
      if (gone.has(url.pathname)) {
        return Promise.resolve({ status: 404, headers: {} });
      }
      gone.add(url.pathname);
      return Promise.resolve({ status: 200, headers: {} });
    },
  };
}

async function walk() {
  return collectObservations({
    baseUrl: "https://a.test",
    endpoints: [DELETE_ORDER],
    accounts: ACCOUNTS,
    credentials: CREDENTIALS,
    resources: ORDER,
    client: deletingPlatform(),
    allowUnsafeMethods: true,
    // One at a time, so "earlier" means something: the point under test is the
    // order of the walk, and with several in flight the platform decides who is
    // first rather than the walk.
    concurrency: 1,
  });
}

describe("a 404 that follows this run's own write", () => {
  /**
   * The whole finding in one assertion. `not-found` folds into a denial, and a
   * denial agrees with a policy of denial — so before this, two of the three
   * cells read as "tested and agreed" about access nobody ever tested.
   */
  it("is not recorded as a denial", async () => {
    const { observations } = await walk();

    expect(observations).toHaveLength(3);
    expect(observations[0]?.outcome).toBe("allowed");
    for (const later of observations.slice(1)) {
      expect(later.status).toBe(404);
      expect(later.outcome).toBe("error");
      // `not-found` is what it would be without the fix, and it is the value
      // that folds into a denial.
      expect(later.outcome).not.toBe("not-found");
    }
  });

  /** And says why, in words that name the cause rather than the symptom. */
  it("says the run removed the object itself", async () => {
    const { failures } = await walk();

    expect(failures).toHaveLength(2);
    expect(failures[0]?.reason).toContain("already changed the object");
    expect(failures[0]?.reason).toContain("orders.delete");
  });

  /**
   * A 404 with no write behind it keeps meaning what it meant: the resource is
   * simply not there, which `coverage.resourcesNotFound` is for.
   */
  it("leaves an ordinary 404 alone", async () => {
    const { observations } = await collectObservations({
      baseUrl: "https://a.test",
      endpoints: [{ id: "orders.read", method: "GET", path: "/v1/orders/{orderId}" }],
      accounts: ACCOUNTS,
      credentials: CREDENTIALS,
      resources: ORDER,
      client: { send: () => Promise.resolve({ status: 404, headers: {} }) },
    });

    for (const one of observations) {
      expect(one.outcome).toBe("not-found");
    }
  });

  /**
   * And a write that was refused is still a refusal. Only a 404 **after** this
   * run changed the same object is suspect; a 403 is the platform answering.
   */
  it("leaves a refused write alone", async () => {
    const { observations } = await collectObservations({
      baseUrl: "https://a.test",
      endpoints: [DELETE_ORDER],
      accounts: ACCOUNTS,
      credentials: CREDENTIALS,
      resources: ORDER,
      client: { send: () => Promise.resolve({ status: 403, headers: {} }) },
      allowUnsafeMethods: true,
    });

    for (const one of observations) {
      expect(one.outcome).toBe("denied");
    }
  });

  /**
   * A platform that soft-deletes answers 410, not 404, and the trap is the same
   * one.
   *
   * It arrived with ADR-0046: 410 used to be an `error`, so the guard had
   * nothing to guard — an unreadable status is already no conclusion. Now that
   * 410 folds into a denial the way 404 does, the second and third accounts
   * would otherwise read as "tested and agreed" about a refusal this run
   * manufactured with its own `DELETE`.
   */
  it("covers a 410 after this run's own write as well", async () => {
    const gone = new Set<string>();
    const { observations, failures } = await collectObservations({
      baseUrl: "https://a.test",
      endpoints: [DELETE_ORDER],
      accounts: ACCOUNTS,
      credentials: CREDENTIALS,
      resources: ORDER,
      client: {
        send: (request) => {
          const url = new URL(request.url);
          if (gone.has(url.pathname)) {
            return Promise.resolve({ status: 410, headers: {} });
          }
          gone.add(url.pathname);
          return Promise.resolve({ status: 200, headers: {} });
        },
      },
      allowUnsafeMethods: true,
      concurrency: 1,
    });

    expect(observations[0]?.outcome).toBe("allowed");
    for (const later of observations.slice(1)) {
      expect(later.status).toBe(410);
      expect(later.outcome).toBe("error");
      expect(later.outcome).not.toBe("not-found");
    }
    expect(failures).toHaveLength(2);
    expect(failures[0]?.reason).toContain("already changed the object");
  });
});

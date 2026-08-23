/**
 * The one grammar for `{name}`, and the state it is not allowed to carry.
 *
 * `src/core/path-parameters.ts` replaced three copies of one expression: two in
 * `src/runner/address.ts` (a presence test and a global capture, with a comment
 * admitting they were one grammar written twice) and a third in
 * `src/core/matrix.ts`, character for character the second, in another layer and
 * named by neither.
 *
 * The obvious way to write that module is one `RegExp` with the `g` flag shared
 * by all three callers, and it is wrong. A global regex is stateful:
 * `RegExp.prototype.test` advances `lastIndex` on a match and resets it only on a
 * miss, and `String.prototype.matchAll` clones the regex *with the `lastIndex` it
 * was handed*, so a scan that follows a presence test begins in the middle of the
 * string. The tests below were written against that exact collapse — the module's
 * three functions rewritten over one `const PARAMETER = /\{([^}]+)\}/g` — and were
 * watched failing under it, in the unit and through `planEndpoints`.
 */

import { describe, expect, it } from "vitest";
import * as pathParameters from "../../src/core/path-parameters.js";
import {
  fillPathParameters,
  hasPathParameters,
  pathParameterNames,
} from "../../src/core/path-parameters.js";
import type { Endpoint, Resource } from "../../src/core/types.js";
import { planEndpoints } from "../../src/runner.js";

const TWO = "/v1/players/{playerId}/orders/{orderId}";

describe("the grammar reads what the three copies read", () => {
  it("names the parameters in the order the template writes them", () => {
    expect(pathParameterNames(TWO)).toEqual(["playerId", "orderId"]);
  });

  it("finds none in a path that has none", () => {
    expect(hasPathParameters("/v1/health")).toBe(false);
    expect(pathParameterNames("/v1/health")).toEqual([]);
  });

  it("finds one where there is one", () => {
    expect(hasPathParameters("/v1/players/{playerId}")).toBe(true);
  });

  /**
   * `[^}]+`, not `[^{}]+`, and this is not an accident to be tidied away.
   *
   * `src/adapters/postman.ts` reduces `{{playerId}}` to `{playerId}` precisely
   * because this grammar would otherwise read a parameter named `{playerId` out
   * of it — a name the collection's author never wrote and no declared resource
   * covers, so the endpoint would drop out of the run while `substitute`
   * assembled a garbage path from it. Widening the class here would silently
   * change what that adapter is defending against.
   */
  it("reads the character class the adapters were written against", () => {
    expect(pathParameterNames("/v1/players/{{playerId}}")).toEqual(["{playerId"]);
  });

  it("fills every parameter and takes the replacement literally", () => {
    expect(fillPathParameters(TWO, (name) => name.toUpperCase())).toBe(
      "/v1/players/PLAYERID/orders/ORDERID",
    );
    // A `$&` in a replacement string is a back-reference; returned from a
    // function it is four characters. `substitute` hands back a value that went
    // through `encodeURIComponent`, and this is what keeps that from being
    // re-read as a pattern.
    expect(fillPathParameters("/v1/players/{playerId}", () => "$&$1")).toBe("/v1/players/$&$1");
  });

  it("lets the filler's refusal out rather than swallowing it", () => {
    expect(() =>
      fillPathParameters(TWO, (name) => {
        throw new Error(`no value for ${name}`);
      }),
    ).toThrow("no value for playerId");
  });
});

/**
 * Mutation: `src/core/path-parameters.ts` rewritten so that all three functions
 * share one `const PARAMETER = /\{([^}]+)\}/g` — `hasPathParameters` calls
 * `PARAMETER.test`, `pathParameterNames` passes `PARAMETER` to `matchAll`,
 * `fillPathParameters` passes it to `replace`, and `everyParameter()` is gone.
 */
describe("the grammar carries no state between calls", () => {
  it("gives the same answer to the same question asked twice", () => {
    // Under the collapse the first call leaves `lastIndex` at 22, and the second
    // searches from there: `false`, for a path that plainly has parameters.
    expect(hasPathParameters(TWO)).toBe(true);
    expect(hasPathParameters(TWO)).toBe(true);
    expect(hasPathParameters(TWO)).toBe(true);
  });

  it("reads every name after the presence question has been asked", () => {
    expect(hasPathParameters(TWO)).toBe(true);

    // Under the collapse: `["orderId"]`. `matchAll` clones the regex with the
    // `lastIndex` the `test` above left on it, so the scan starts past the first
    // parameter. This is the failure that reaches `resourceApplies`.
    expect(pathParameterNames(TWO)).toEqual(["playerId", "orderId"]);
  });

  it("fills every parameter after the names have been read", () => {
    expect(pathParameterNames(TWO)).toEqual(["playerId", "orderId"]);
    expect(fillPathParameters(TWO, (name) => name)).toBe("/v1/players/playerId/orders/orderId");
  });

  /**
   * And the shape the collapse would need is refused outright.
   *
   * The three tests above catch a shared global regex by its symptom. This one
   * catches the thing itself: a module that hands a `RegExp` out cannot promise
   * anything about `lastIndex`, because the promise then depends on every caller.
   * A flagless regex would be safe to share and is refused too — the rule worth
   * holding is the simple one, and there is no reason to hand one out.
   */
  it("hands out no regular expression for a caller to share", () => {
    const exported = Object.entries(pathParameters)
      .filter(([, value]) => value instanceof RegExp)
      .map(([name]) => name);

    expect(exported).toEqual([]);
    // A guard over an empty module would agree with anything.
    expect(Object.keys(pathParameters).length).toBeGreaterThan(2);
  });
});

/**
 * The same mutation, seen where it decides what a run touches.
 *
 * `planEndpoints` asks both questions about the same string in one pass — first
 * whether the path names parameters, then, through `resourceApplies`, which
 * names those are. Shared state between the two turns a skip into a probe.
 */
describe("the plan, which asks both questions in one pass", () => {
  const endpoint = (id: string, path: string): Endpoint => ({ id, method: "GET", path });

  it("skips the second templated endpoint as well as the first", () => {
    const plan = planEndpoints({
      baseUrl: "https://api.test",
      endpoints: [
        endpoint("players.read", "/v1/players/{playerId}"),
        endpoint("orders.read", "/v1/orders/{orderId}"),
      ],
    });

    // Under the collapse the first path leaves `lastIndex` at 22, which is past
    // the end of the second (20 characters): the second endpoint reads as having
    // no parameters at all and is probed, at `/v1/orders/{orderId}` literally.
    expect(plan.skipped).toEqual([
      { endpointId: "players.read", reason: "path-parameters" },
      { endpointId: "orders.read", reason: "path-parameters" },
    ]);
    expect(plan.probeable).toEqual([]);
  });

  it("does not take a resource covering half the parameters for one that applies", () => {
    const resource: Resource = {
      id: "order-1001",
      tenantId: "acme",
      params: { orderId: "1001" },
    };

    const plan = planEndpoints({
      baseUrl: "https://api.test",
      endpoints: [endpoint("player.order.read", TWO)],
      resources: [resource],
    });

    // Under the collapse `resourceApplies` sees `["orderId"]` alone — the
    // presence test consumed `{playerId}` — declares the resource applicable, and
    // the run walks the cell. `substitute` has no value for `playerId` and yields
    // an empty segment, so the request goes to `/v1/players//orders/1001`: an
    // address the endpoint does not name, with the verdict for the endpoint it
    // does name computed from whatever answers.
    expect(plan.skipped).toEqual([{ endpointId: "player.order.read", reason: "path-parameters" }]);
    expect(plan.probeable).toEqual([]);
  });
});

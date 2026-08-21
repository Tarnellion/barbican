/**
 * A status the tool cannot read has to say so in the report.
 *
 * `classifyStatus` concludes only where the status is unambiguous, and that is
 * right. What was missing is the other half: such a cell produced an `error`
 * outcome and **no row in `failures` at all**, so the one thing `ProbeFailure`
 * exists for — "an `error` with no explanation makes it impossible to tell a
 * deployment that is down from a wrong configuration" — did not hold for the
 * commonest way of getting one. Only a thrown request and the self-inflicted 404
 * ever wrote a reason.
 *
 * The cost is concrete. `docs/guide.md` offers `kind: cookie` as a first-class
 * scheme and describes an operator console behind a session cookie; the
 * canonical answer such a console gives a refused caller is `302` to a sign-in
 * page, not `403`. Every denied cell of that surface became a low-severity
 * `probe-error` — outside the exit code — and `summary.failures` stayed `0`, so
 * the CLI printed no "Requests that failed" line either. A mixed run, an API
 * answering 401 beside a console answering 302, does not earn `nothingRefused`
 * either: that warning needs `denied === 0` across the whole run and names a
 * different cause. The run came back green with the refusals dropped.
 *
 * The conclusion is still not drawn — that needs a declaration from the operator
 * and there is none. What changes here is that the run stops being silent about
 * what it discarded. See ADR-0044.
 */

import { describe, expect, it } from "vitest";
import { createCredentialProvider, DEFAULT_AUTH_SCHEME } from "../src/adapters/credentials.js";
import type { HttpClient, HttpRequest } from "../src/adapters/ports.js";
import type { Account, Endpoint } from "../src/core/index.js";
import { collectObservations } from "../src/runner.js";

const ACCOUNTS: readonly Account[] = [{ id: "guest", roleId: "guest", tenantId: "t" }];
const CREDENTIALS = createCredentialProvider(DEFAULT_AUTH_SCHEME, new Map([["guest", "tok"]]));

const CONSOLE_PAGE: Endpoint = { id: "console.users", method: "GET", path: "/console/users" };

/** A console on a session cookie: a refused caller is sent to the sign-in page. */
function redirectingConsole(status: number): HttpClient {
  return {
    send: (_request: HttpRequest) =>
      Promise.resolve({ status, headers: { location: "/login" } as Record<string, string> }),
  };
}

async function walk(client: HttpClient) {
  return collectObservations({
    baseUrl: "https://a.test",
    endpoints: [CONSOLE_PAGE],
    accounts: ACCOUNTS,
    credentials: CREDENTIALS,
    client,
  });
}

describe("a cell answered with a status the tool cannot read", () => {
  /**
   * The finding in one assertion. The outcome was already `error`; the row
   * beside it was not there, and the row is what a reader has to act on.
   */
  it("leaves a failure saying why nothing follows", async () => {
    const { observations, failures } = await walk(redirectingConsole(302));

    expect(observations).toHaveLength(1);
    expect(observations[0]?.outcome).toBe("error");
    expect(failures).toHaveLength(1);
    expect(failures[0]?.accountId).toBe("guest");
    expect(failures[0]?.endpointId).toBe("console.users");
    expect(failures[0]?.reason).toContain("302");
  });

  /**
   * And names the case the reader is most likely to be in, because the report
   * cannot: a redirect is not followed, so the refusal behind it was never seen
   * and the run counted no denial for this cell.
   */
  it("names the sign-in redirect when the status is a 3xx", async () => {
    const { failures } = await walk(redirectingConsole(303));

    expect(failures[0]?.reason).toMatch(/redirect/i);
    expect(failures[0]?.reason).toMatch(/sign-in|sign in|login/i);
  });

  /** The same row for a status that is ambiguous for an entirely different reason. */
  it("leaves one for a 5xx and for a 405 too", async () => {
    for (const status of [405, 503]) {
      const { failures } = await walk(redirectingConsole(status));

      expect(failures).toHaveLength(1);
      expect(failures[0]?.reason).toContain(String(status));
      // Not the redirect sentence: it would be false, and a reason that says
      // something untrue about the cell is worse than a generic one.
      expect(failures[0]?.reason).not.toMatch(/redirect/i);
    }
  });

  /**
   * A status the tool **does** read leaves no failure row. Otherwise every
   * ordinary denial would carry one, and the count the CLI prints in yellow
   * would stop meaning anything.
   */
  it("leaves none where the status is unambiguous", async () => {
    for (const status of [200, 204, 401, 403, 404, 410, 451]) {
      const { failures } = await walk(redirectingConsole(status));

      expect(failures).toHaveLength(0);
    }
  });
});

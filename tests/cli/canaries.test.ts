/**
 * Authentication confirmed at both ends of the walk, and the three things that
 * can be wrong with a canary told apart.
 *
 * ADR-0033 made the rule per account and ADR-0040 gave the canary a control
 * request; what neither could do is make the run *say* which of three facts it
 * met. That distinction is this module's whole subject — our own ceiling, a
 * platform that did not answer, a refusal — and it was held by 64 % of its
 * branches being reached, from outside, by tests aimed at something else. Both
 * halves of the second pass were of that kind: a run that hit its own budget
 * during it came back reporting stale credentials, and a deployment that fell
 * over after the walk did too, sending the reader after a token while the stand
 * was down (V-6).
 *
 * `probeCanaries` in `src/runner/` does the asking and is tested there. What is
 * tested here is the reading of the answers.
 */

import { describe, expect, it, vi } from "vitest";
import { createCredentialProvider, DEFAULT_AUTH_SCHEME } from "../../src/adapters/credentials.js";
import type { HttpClient, HttpRequest } from "../../src/adapters/ports.js";
import type { CanaryPass } from "../../src/cli/canaries.js";
import {
  accountsOwedACanary,
  confirmAfterWalk,
  declaredCanaries,
  probeBeforeWalk,
} from "../../src/cli/canaries.js";
import type { Account, Endpoint } from "../../src/core/index.js";
import { parseRunConfig } from "../../src/io/config.js";
import type { CanaryOutcome } from "../../src/report/build.js";

const ENDPOINTS: readonly Endpoint[] = [
  { id: "me", method: "GET", path: "/v1/me" },
  { id: "orders.list", method: "GET", path: "/v1/orders" },
];

const ACCOUNTS: readonly Account[] = [
  { id: "alice-a", roleId: "user", tenantId: "tenant-a" },
  { id: "carol-b", roleId: "user", tenantId: "tenant-b" },
  // A row under declared conditions presents the same credentials as the row it
  // was derived from, so a canary for it would confirm nothing twice over.
  {
    id: "alice-a@geo-blocked",
    roleId: "user",
    tenantId: "tenant-a",
    contextId: "geo-blocked",
    baseAccountId: "alice-a",
  },
];

const CREDENTIALS = createCredentialProvider(
  DEFAULT_AUTH_SCHEME,
  new Map([
    ["alice-a", "alice-token"],
    ["carol-b", "carol-token"],
  ]),
);

/** A client answering by a table of statuses, and throwing where a table says to. */
function clientThat(reply: (request: HttpRequest) => number | Error) {
  const seen: HttpRequest[] = [];
  const client: HttpClient = {
    send(request) {
      seen.push(request);
      const answer = reply(request);
      return answer instanceof Error
        ? Promise.reject(answer)
        : Promise.resolve({ status: answer, headers: {} });
    },
  };
  return { client, seen };
}

function passWith(reply: (request: HttpRequest) => number | Error): CanaryPass & {
  readonly seen: readonly HttpRequest[];
} {
  const { client, seen } = clientThat(reply);
  return {
    baseUrl: "https://api.test",
    endpoints: ENDPOINTS,
    canaries: [
      { accountId: "alice-a", endpointId: "me" },
      { accountId: "carol-b", endpointId: "me" },
    ],
    credentials: CREDENTIALS,
    client,
    exclude: [],
    allowUnsafeMethods: false,
    accounts: ACCOUNTS,
    tenantBaseUrls: new Map(),
    seen,
  };
}

/** Who the request was sent as, read off the header the default scheme uses. */
function asAccount(request: HttpRequest): string | undefined {
  return String(request.headers.authorization ?? "").replace("Bearer ", "") || undefined;
}

/** A token that works, on an endpoint that refuses an anonymous request. */
const DISCERNING = (request: HttpRequest): number => (asAccount(request) === undefined ? 401 : 200);

const terminal = (name: string): Error => Object.assign(new Error(name), { name });

describe("the accounts a declaration owes a canary", () => {
  const config = parseRunConfig(`
target: { baseUrl: "https://api.test", allowedHosts: [api.test] }
accounts:
  - { id: alice-a, role: user, tenant: tenant-a, tokenEnv: T_ALICE, canary: me }
  - { id: carol-b, role: user, tenant: tenant-b, tokenEnv: T_CAROL }
  - { id: anonymous, role: anonymous }
policy: { fallback: denied, rules: [{ roles: [user], endpoints: [me], outcome: allowed }] }
`);

  /**
   * Names and not a count: a run where one account of three has a canary is not
   * a run with canaries, and "not one account declares a canary" was false about
   * it while the exit code was still 2. The anonymous account has nothing to
   * authenticate and is not owed one.
   */
  it("names the credentialed accounts with no canary, and leaves the anonymous one alone", () => {
    expect(accountsOwedACanary(config)).toEqual(["carol-b"]);
  });

  it("hands the runner the canaries that were declared", () => {
    expect(declaredCanaries(config)).toEqual([{ accountId: "alice-a", endpointId: "me" }]);
  });
});

describe("the canaries before the walk", () => {
  it("sends nothing when none are declared", async () => {
    const pass = passWith(() => 200);

    await expect(probeBeforeWalk({ ...pass, canaries: [] })).resolves.toEqual([]);
    expect(pass.seen).toHaveLength(0);
  });

  /**
   * A row under conditions is not asked about: the filter lives in this module
   * rather than at each call site, so that the two passes cannot end up asking
   * about different rows.
   */
  it("asks once per authenticating row, and not once per matrix row", async () => {
    const pass = passWith(DISCERNING);

    const outcomes = await probeBeforeWalk(pass);

    expect(outcomes.map((one) => one.accountId)).toEqual(["alice-a", "carol-b"]);
    expect(outcomes.every((one) => one.authenticated)).toBe(true);
  });

  /**
   * Three facts, and the message used to name one. A cold read hit a dead port
   * and was told "401 reads as a denial", so it went looking for a stale token;
   * the audit then hit its own `--max-requests` and was told to check the port.
   */
  it("tells a refusal from a dead port from the run's own ceiling", async () => {
    const refused = probeBeforeWalk(
      passWith((request) => (asAccount(request) === "carol-token" ? 401 : 200)),
    );
    await expect(refused).rejects.toThrow(/carol-b: me returned 401/);
    await expect(refused).rejects.toThrow(/Continuing past a denial is not an option/);

    const dead = probeBeforeWalk(passWith(() => new Error("ECONNREFUSED")));
    await expect(dead).rejects.toThrow(/did not answer \(TRANSPORT\)/);
    await expect(dead).rejects.toThrow(/The platform did not answer at all/);

    const ceiling = probeBeforeWalk(passWith(() => terminal("RunBudgetExhaustedError")));
    await expect(ceiling).rejects.toThrow(/RunBudgetExhaustedError/);
    await expect(ceiling).rejects.toThrow(/The run stopped itself before the canaries/);
    // Nothing here is about the platform or the tokens, and the message must not
    // send the reader to either.
    await expect(ceiling).rejects.not.toThrow(/Check the address, the port/);
  });

  /**
   * A canary that passed on an endpoint answering everybody confirms nothing —
   * and confirming is its whole job. Checked before the walk, because the answer
   * does not change once it starts and the traffic is somebody else's to pay
   * for.
   */
  it("refuses a canary the platform answers without credentials", async () => {
    await expect(probeBeforeWalk(passWith(() => 200))).rejects.toThrow(
      /answered 200 to a request carrying no credentials/,
    );
  });
});

describe("the canaries after the walk", () => {
  const before: readonly CanaryOutcome[] = [
    { accountId: "alice-a", endpointId: "me", status: 200, authenticated: true },
    { accountId: "carol-b", endpointId: "me", status: 200, authenticated: true },
  ];

  function probeAfterWalk(
    reply: (request: HttpRequest) => number | Error,
    over: { readonly truncated?: boolean; readonly before?: readonly CanaryOutcome[] } = {},
  ) {
    const pass = passWith(reply);
    return {
      pass,
      result: confirmAfterWalk({
        ...pass,
        before: over.before ?? before,
        truncated: over.truncated ?? false,
      }),
    };
  }

  /**
   * The walk is already over and the verdict is 2 either way; the budget that
   * ended the walk would end these requests too.
   */
  it("asks nothing after a walk that was already cut short", async () => {
    const { pass, result } = probeAfterWalk(DISCERNING, { truncated: true });

    await expect(result).resolves.toEqual({ staleCredentials: [], unverifiedAfterWalk: [] });
    expect(pass.seen).toHaveLength(0);
  });

  /** The ordinary end of a run: both tokens still work, and nothing is said. */
  it("says nothing when the tokens still work", async () => {
    const said = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const { result } = probeAfterWalk(DISCERNING);

      await expect(result).resolves.toEqual({ staleCredentials: [], unverifiedAfterWalk: [] });
      expect(said).not.toHaveBeenCalled();
    } finally {
      said.mockRestore();
    }
  });

  /**
   * The case ADR-0033 exists for: a token that dies mid-walk turns every
   * remaining cell into a 401, which reads as a denial, agrees with a policy of
   * denial and lands in `cellsMatched` as "tested and agreed".
   */
  it("names the account whose credentials went stale", async () => {
    const said: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      said.push(String(chunk));
      return true;
    });
    try {
      const { result } = probeAfterWalk((request) =>
        asAccount(request) === "carol-token" ? 401 : DISCERNING(request),
      );

      await expect(result).resolves.toEqual({
        staleCredentials: ["carol-b"],
        unverifiedAfterWalk: [],
      });
      expect(said.join("")).toContain("Credentials went stale during the run: carol-b");
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * Two facts that are not a stale token, and the difference between them and
   * one is the difference between "the results cannot be trusted" and "nothing
   * says they still worked". A ceiling is our own; a platform that stopped
   * answering is not, and the walk itself is untouched in both cases.
   */
  it("keeps a ceiling and a silent platform apart from a dead token", async () => {
    const said: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      said.push(String(chunk));
      return true;
    });
    try {
      await expect(probeAfterWalk(() => terminal("CircuitOpenError")).result).resolves.toEqual({
        staleCredentials: [],
        unverifiedAfterWalk: ["alice-a", "carol-b"],
      });
      await expect(probeAfterWalk(() => new Error("ECONNRESET")).result).resolves.toEqual({
        staleCredentials: [],
        unverifiedAfterWalk: ["alice-a", "carol-b"],
      });
      expect(said.join("")).toContain("Authentication was not confirmed a second time");
      expect(said.join("")).not.toContain("went stale");
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * An account whose canary did not pass before the walk is not judged again:
   * the first pass already stopped the run over it, and a second verdict on the
   * same account would be a second sentence about one fact.
   */
  it("judges only the accounts that passed the first time", async () => {
    const { result } = probeAfterWalk(() => 401, {
      before: [{ accountId: "alice-a", endpointId: "me", status: 401, authenticated: false }],
    });

    await expect(result).resolves.toEqual({ staleCredentials: [], unverifiedAfterWalk: [] });
  });
});

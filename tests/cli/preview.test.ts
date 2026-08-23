/**
 * `--dry-run`: the answer to "what exactly will you touch", given before the
 * first request exists.
 *
 * This is the command a reader is told to try first on somebody else's
 * deployment, and every sentence it prints is either a number about traffic or a
 * defect the run is about to hit. Half of them were held by nothing: the module
 * sat outside the coverage gate until ADR-0063, at 50 % of its branches, and the
 * branches missing were the ones each of those sentences hangs off.
 *
 * The plan itself comes from `planEndpoints`, which the run uses too and which
 * is tested with it. What is under test here is the arithmetic and the
 * reservations — the two things the preview says that the run does not.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runIdentity } from "../../src/adapters/http.js";
import type { RunFlags } from "../../src/cli/flags.js";
import { describePlan } from "../../src/cli/preview.js";
import type { Check, Endpoint } from "../../src/core/index.js";
import { createIdenticalResponseCheck } from "../../src/core/index.js";
import { applyBodySignals, parseRunConfig, resolveContextValues } from "../../src/io/config.js";

let said: string[];

beforeEach(() => {
  said = [];
  Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    said.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Everything a preview has an opinion about, in one declaration: a brand on a
 * host of its own, an endpoint excluded by hand, a templated path with a
 * resource for it, a write endpoint, and a set of conditions naming one endpoint
 * out of the four.
 */
const FULL = parseRunConfig(`
target:
  baseUrl: http://127.0.0.1:8787
  allowedHosts: [127.0.0.1]
  label: reference polygon
tenants:
  - { id: tenant-a }
  - { id: tenant-b, baseUrl: "http://127.0.0.1:8787" }
accounts:
  - { id: alice-a, role: user, tenant: tenant-a, tokenEnv: T_ALICE, canary: orders.list }
  - { id: anonymous, role: anonymous }
exclude: [health]
resources:
  - { id: order-a-1, tenant: tenant-a, owner: alice-a, params: { orderId: "A-1" } }
  - { id: order-a-2, tenant: tenant-a, owner: alice-a, params: { orderId: "A-2" } }
contexts:
  - id: geo-blocked
    description: a request from a prohibited jurisdiction
    headers: { cf-ipcountry: AQ }
    endpoints: [orders.list]
policy:
  fallback: denied
  rules:
    - { roles: [user], endpoints: [orders.list], outcome: allowed }
    - { roles: [user], endpoints: [orders.list], context: geo-blocked, outcome: denied }
`);

/** The other half of every branch: no tenants, no exclude, and a canary missing. */
const BARE = parseRunConfig(`
target: { baseUrl: "http://127.0.0.1:8787", allowedHosts: [127.0.0.1] }
accounts:
  - { id: alice-a, role: user, tenant: tenant-a, tokenEnv: T_ALICE }
policy:
  fallback: denied
  rules: [{ roles: [user], endpoints: [orders.list], outcome: allowed }]
`);

const ENDPOINTS: readonly Endpoint[] = [
  { id: "health", method: "GET", path: "/healthz" },
  { id: "orders.list", method: "GET", path: "/v1/orders" },
  { id: "orders.read", method: "GET", path: "/v1/orders/{orderId}" },
  { id: "orders.cancel", method: "POST", path: "/v1/orders/{orderId}/cancel" },
];

const CHECKS: readonly Check[] = [createIdenticalResponseCheck()];

const IDENTITY = runIdentity({
  version: "9.9.9",
  runId: "8b1f0a4e-0000-4000-8000-000000000000",
  homepage: "https://example.test/barbican",
});

/** The command line as commander fills it in, with only what a case is about. */
function flags(over: Partial<RunFlags> = {}): RunFlags {
  return { config: "barbican.run.yaml", dryRun: true, ...over };
}

function preview(
  over: {
    readonly config?: typeof FULL;
    readonly flags?: Partial<RunFlags>;
    readonly checks?: readonly Check[];
    readonly limits?: { readonly maxRequests: number } | undefined;
    readonly identity?: typeof IDENTITY | undefined;
    readonly alreadyWalked?: number;
  } = {},
): string {
  const config = over.config ?? FULL;
  const code = describePlan(
    config,
    applyBodySignals(ENDPOINTS, config),
    flags(over.flags ?? {}),
    over.checks ?? CHECKS,
    over.limits as never,
    resolveContextValues(config, {}),
    "identity" in over ? over.identity : IDENTITY,
    over.alreadyWalked ?? 0,
  );
  expect(code).toBe(0);
  return said.join("");
}

describe("what a dry run says it would do", () => {
  /**
   * The identifiers first: with `--spec` they come from `operationId`, and the
   * cold read of 14 August recovered them by running against the platform and
   * reading `endpoints[]` out of the report — a probe of somebody else's
   * deployment to answer a question about a local file.
   */
  it("names every endpoint, and which of them it would leave alone", () => {
    const screen = preview();

    expect(screen).toContain("nothing was sent to http://127.0.0.1:8787");
    expect(screen).toContain("Endpoints (4)");
    expect(screen).toContain("health  (GET /healthz)  skip: named in exclude");
    expect(screen).toContain("orders.list  (GET /v1/orders)  probe");
    expect(screen).toContain("orders.cancel  (POST /v1/orders/{orderId}/cancel)  skip: a write");
  });

  /**
   * An endpoint with parameters costs a request per resource that covers them,
   * and a row under conditions walks only the endpoints its context names. Two
   * accounts and two conditioned rows: three cells each for the plain rows —
   * `orders.list` once and `orders.read` once per resource — and one each for
   * the conditioned rows, whose context names `orders.list` alone.
   */
  it("counts cells the way the run will, resource by resource and context by context", () => {
    const screen = preview();

    expect(screen).toContain("Matrix rows: 4 (declared accounts 2)");
    expect(screen).toContain("Cells a run would probe: 8");
  });

  /** Canaries are probed at both ends of the walk, plus one anonymous control each. */
  it("counts the canary requests at three per account that declares one", () => {
    expect(preview()).toContain("plus 3 canary requests (1 accounts");
  });

  /**
   * The cells a resumed run will not probe again come off the bill, and the
   * total they came off is named rather than left to be worked out from a number
   * that shrank.
   */
  it("takes the cells already in the stream off the estimate", () => {
    const screen = preview({ alreadyWalked: 4 });

    expect(screen).toContain("Cells a run would probe: 4");
    expect(screen).toContain("Of the 8 cells in this matrix, 4 are already in the stream");
  });

  /**
   * A number about traffic that ignores the ceiling on traffic is worse than no
   * number: the preview promised 144 cells where the run made one request and
   * stopped.
   */
  it("says when the budget does not cover what it just counted", () => {
    expect(preview({ limits: { maxRequests: 4 } })).toContain("Only 4 of those 11 requests fit");
  });

  it("says nothing about a budget the run fits inside", () => {
    expect(preview({ limits: { maxRequests: 1_000 } })).not.toContain("fit the budget");
  });

  /**
   * The most expensive pre-flight defect is the one the pre-flight check does not
   * mention: without a canary the run walks the whole matrix and then exits 2.
   * Named per account, because the rule became per account on 19 August.
   */
  it("names the accounts that would walk the matrix and then exit 2", () => {
    const screen = preview({ config: BARE, identity: undefined, checks: [] });

    expect(screen).toContain("No canary is declared for: alice-a");
    expect(screen).toContain("Target: unnamed");
  });

  /** A pipeline that publishes the report after a dry run publishes yesterday's. */
  it("says that --report is not written by a dry run", () => {
    expect(preview({ flags: { report: "out/run.json" } })).toContain(
      "--report is not written by a dry run: out/run.json is left as it was",
    );
  });

  it("says nothing about a report the command line did not name", () => {
    expect(preview()).not.toContain("is not written by a dry run");
  });

  /** A check left out by `--checks` is coverage left out, and it is named here. */
  it("names the checks that will run, and says so when none will", () => {
    expect(preview()).toContain("Checks: identical-response-across-tenants");
    expect(preview({ checks: [] })).toContain("Checks: none will run");
  });

  /**
   * "What exactly are you going to touch" and "how will I recognise it in my own
   * records" are the same question asked by the same person, and the second is
   * answerable here for free. See ADR-0045.
   */
  it("says what the platform's access log will show, or that nothing will", () => {
    expect(preview()).toContain(`Named on the wire as: ${IDENTITY.value}`);
    expect(preview({ identity: undefined })).toContain("will not name itself on the wire");
  });
});

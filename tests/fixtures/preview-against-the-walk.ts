/**
 * One declaration, previewed and then walked, against a client that counts.
 *
 * `--dry-run` tells an operator how many requests a run will make against
 * somebody else's deployment, and the run then makes them somewhere else
 * entirely: `describePlan` does the arithmetic, `collectObservations` and the two
 * canary passes do the traffic. Nothing in this repository put the two side by
 * side until 23 August 2026, so this is the seam both callers meet at.
 *
 * The client is a stub rather than the real one on purpose: the number under
 * test is how many requests the walk *asks* for, and the HTTP adapter's retries,
 * throttle and request ceiling all change that number for reasons the preview
 * deliberately does not model. What is compared here is the walk's demand
 * against the preview's estimate of it.
 *
 * Both halves take a `RunMode`, because the command line changes what a run
 * sends and the first version of this fixture hardcoded one point of it:
 * `allowUnsafeMethods: false` on both sides and no `--unsafe-methods` on the
 * flags, so `flags.unsafeMethods === true` in `describePlan` could be replaced
 * by `false` with the whole suite green. See ADR-0064.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, vi } from "vitest";
import { createCredentialProvider } from "../../src/adapters/credentials.js";
import { createEndpointListParser } from "../../src/adapters/endpoint-list.js";
import type { HttpClient, HttpRequest } from "../../src/adapters/ports.js";
import { createThrottle } from "../../src/adapters/throttle.js";
import { confirmAfterWalk, declaredCanaries, probeBeforeWalk } from "../../src/cli/canaries.js";
import type { RunFlags } from "../../src/cli/flags.js";
import { describePlan } from "../../src/cli/preview.js";
import { createIdenticalResponseCheck } from "../../src/core/index.js";
import type { RunConfig } from "../../src/io/config.js";
import {
  applyBodySignals,
  parseRunConfig,
  resolveContextValues,
  resolveTokens,
  toAccounts,
} from "../../src/io/config.js";
import type { CellRecord } from "../../src/runner.js";
import { collectObservations } from "../../src/runner.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** A declaration in the two files the CLI is given: the run config and the endpoint list. */
export interface Declaration {
  readonly config: RunConfig;
  readonly endpointList: string;
}

/**
 * The command line, as far as it changes how many requests go out.
 *
 * Only the switches that move the number. `--checks` does not: it decides what
 * is compared once a response is in hand, and `describePlan` prints the
 * selection without counting it. `--report` and `--no-identify` do not either.
 * What is left is the two below, and both of them were outside this fixture
 * until 23 August 2026.
 */
export interface RunMode {
  /** `--unsafe-methods`: the write endpoints join the matrix on both sides. */
  readonly unsafeMethods?: boolean;
  /**
   * What `--resume` carries: cells a previous walk already finished.
   *
   * The preview subtracts their count from the bill and the walk does not probe
   * them again, which is two computations of one number in the shape ADR-0064 is
   * about. Take them from `cellsWalkedBy` on the same declaration and the same
   * mode — a record that fits no cell of this matrix is refused by the walk.
   */
  readonly resumed?: readonly CellRecord[];
}

/** The reference polygon's own declaration, read from the files the oracle runs. */
export function polygonDeclaration(): Declaration {
  return {
    config: parseRunConfig(readFileSync(resolve(ROOT, "polygon/barbican.run.yaml"), "utf8")),
    endpointList: readFileSync(resolve(ROOT, "polygon/endpoints.yaml"), "utf8"),
  };
}

/** A declaration written inline, for the shapes the polygon does not have. */
export function inlineDeclaration(config: string, endpointList: string): Declaration {
  return { config: parseRunConfig(config), endpointList };
}

/**
 * Every `tokenEnv` the declaration names, set to a value of its own.
 *
 * Distinct values because `resolveTokens` refuses two accounts presenting the
 * same one — a rule that exists so that a copy-pasted variable name cannot make
 * two rows of the matrix into one account.
 */
function environmentFor(config: RunConfig): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  config.accounts.forEach((account, index) => {
    if (account.tokenEnv !== undefined) {
      environment[account.tokenEnv] = `token-${index}`;
    }
  });
  return environment;
}

/**
 * A client that answers, and counts.
 *
 * The answer distinguishes a credentialed request from one with no headers at
 * all, which is what the canary's control request is: a canary that answers
 * everybody stops the run with `UndiscerningCanaryError` before the second pass,
 * and a count taken from such a run is the count of a run that never happened.
 */
function countingClient(): { readonly client: HttpClient; readonly seen: HttpRequest[] } {
  const seen: HttpRequest[] = [];
  const client: HttpClient = {
    send(request) {
      seen.push(request);
      return Promise.resolve({
        status: Object.keys(request.headers).length === 0 ? 401 : 200,
        headers: {},
      });
    },
  };
  return { client, seen };
}

/** What the preview printed, in the two numbers it bills. */
export interface Estimate {
  readonly screen: string;
  readonly cells: number;
  readonly canaryRequests: number;
  /** What the operator reads off the line and compares with `--max-requests`. */
  readonly total: number;
}

async function endpointsOf(declaration: Declaration) {
  const parsed = await createEndpointListParser().parse(declaration.endpointList);
  return applyBodySignals(parsed, declaration.config);
}

/**
 * The preview, driven as `src/cli/run.ts` drives it, with its output captured.
 *
 * `process.stderr.write` is stubbed rather than the module: the preview writes
 * its plan there and returns only an exit code, so the numbers under test exist
 * nowhere else.
 */
export async function previewOf(declaration: Declaration, mode: RunMode = {}): Promise<Estimate> {
  const said: string[] = [];
  const write = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    said.push(String(chunk));
    return true;
  });
  try {
    // Spelled as `src/cli/run.ts` receives it from commander: the switch is
    // absent rather than `false` when it was not given, because `describePlan`
    // asks `flags.unsafeMethods === true` and an explicit `false` would not tell
    // the two spellings apart.
    const flags: RunFlags = {
      config: "polygon/barbican.run.yaml",
      dryRun: true,
      ...(mode.unsafeMethods === true ? { unsafeMethods: true } : {}),
    };
    const code = describePlan(
      declaration.config,
      await endpointsOf(declaration),
      flags,
      [createIdenticalResponseCheck()],
      createThrottle({}).limits,
      resolveContextValues(declaration.config, environmentFor(declaration.config)),
      undefined,
      // `carried.records.length` in the CLI, which is where the number comes
      // from there too.
      mode.resumed?.length ?? 0,
    );
    expect(code).toBe(0);
  } finally {
    write.mockRestore();
  }

  const screen = said.join("");
  const billed = /Cells a run would probe: (\d+), plus (\d+) canary requests/.exec(screen);
  if (billed === null) {
    throw new Error(`the preview printed no bill:\n${screen}`);
  }
  const cells = Number(billed[1]);
  const canaryRequests = Number(billed[2]);
  return { screen, cells, canaryRequests, total: cells + canaryRequests };
}

/**
 * The run, driven as `src/cli/run.ts` drives it: canaries, walk, canaries again.
 *
 * The order and the arguments are the CLI's, because what is being measured is
 * the traffic that command makes. A shorter arrangement — the walk alone, or
 * `probeCanaries` called twice here — would measure an arrangement no operator
 * ever runs.
 */
export async function requestsIssuedBy(
  declaration: Declaration,
  mode: RunMode = {},
): Promise<readonly HttpRequest[]> {
  return (await walk(declaration, mode)).requests;
}

/**
 * The cells one walk finished, in the form `--resume` carries them.
 *
 * The same records `src/cli/run.ts` appends to the stream beside the report, and
 * the only honest source of a `resumed` list: a record that fits no cell of the
 * matrix being walked is refused by `collectObservations`, so a hand-written one
 * would test the refusal instead of the arithmetic.
 */
export async function cellsWalkedBy(
  declaration: Declaration,
  mode: RunMode = {},
): Promise<readonly CellRecord[]> {
  return (await walk(declaration, mode)).records;
}

interface Walked {
  readonly requests: readonly HttpRequest[];
  readonly records: readonly CellRecord[];
}

async function walk(declaration: Declaration, mode: RunMode): Promise<Walked> {
  const { config } = declaration;
  const environment = environmentFor(config);
  const endpoints = await endpointsOf(declaration);
  const contextValues = resolveContextValues(config, environment);
  const { accounts, attributes } = toAccounts(config, contextValues);
  const credentials = createCredentialProvider(
    config.auth,
    resolveTokens(config, environment),
    config.accountAuth,
  );
  const tenantBaseUrls = new Map(
    (config.tenants ?? [])
      .filter((tenant) => tenant.baseUrl !== undefined)
      .map((tenant) => [tenant.id, tenant.baseUrl ?? ""]),
  );
  const { client, seen } = countingClient();
  // One flag, read the way the CLI reads it — `flags.unsafeMethods === true` at
  // all three call sites. Hardcoded `false` here on both sides was the hole: the
  // preview's own `allowUnsafeMethods` could be pinned to `false` and nothing
  // measured the difference, in the one mode where an undercounted bill lets a
  // `--max-requests` ceiling truncate a run that has already written.
  const allowUnsafeMethods = mode.unsafeMethods === true;

  const canaryPass = {
    baseUrl: config.target.baseUrl,
    endpoints,
    canaries: declaredCanaries(config),
    credentials,
    client,
    exclude: config.exclude,
    allowUnsafeMethods,
    accounts,
    tenantBaseUrls,
  };

  const records: CellRecord[] = [];
  const before = await probeBeforeWalk(canaryPass);
  const { truncated } = await collectObservations({
    baseUrl: config.target.baseUrl,
    endpoints,
    accounts,
    credentials,
    client,
    allowUnsafeMethods,
    exclude: config.exclude,
    resources: config.resources,
    tenantBaseUrls,
    contextAttributes: attributes,
    ...(mode.resumed === undefined ? {} : { resumed: mode.resumed }),
    record: (record) => {
      records.push(record);
    },
  });
  await confirmAfterWalk({ ...canaryPass, before, truncated });

  return { requests: seen, records };
}

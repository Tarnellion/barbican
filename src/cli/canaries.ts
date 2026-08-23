/**
 * Authentication, confirmed at both ends of the walk.
 *
 * One module because the two passes are one claim made twice, and the second
 * exists only because the first is not enough: a canary answers "were we
 * authenticated when we began", and a token that dies in the middle turns every
 * remaining cell into a 401 that reads as a denial. Split between two distant
 * halves of the run they drifted — the first pass told a ceiling, a dead port
 * and a refusal apart, and the second told only two of the three, so a
 * deployment that fell over after the walk was reported as a stale token.
 *
 * The accounts a canary is owed for are asked here too: the preview names them
 * and the run warns about them, and the predicate behind both is this module's
 * subject rather than either caller's.
 */

import type { CredentialProvider, HttpClient } from "../adapters/ports.js";
import type { Account, Endpoint, TenantId } from "../core/index.js";
import type { RunConfig } from "../io/config.js";
import type { CanaryOutcome } from "../report/build.js";
// A canary failure that is the run's own doing rather than the platform's. The
// names come from the client's errors and reach here through
// `CanaryResult.failure`; they are kept apart from a transport failure below
// because the advice is opposite — nothing to check on the deployment,
// something to change in the invocation.
//
// The set was written out in this file as well until 23 August 2026: the same
// two members under a second name, which is the shape this repository has a
// rule about. It is `src/runner/outcome.ts`'s to state — that is where
// `terminalCause` reads it to decide whether the walk was cut short, and this
// module judges the same refusals the walk does. Imported from the module and
// not through `../runner.js` on purpose: the barrel is what `src/index.ts`
// re-exports whole, and this is an agreement between two layers rather than a
// promise to a consumer. See ADR-0061.
import { TERMINAL_ERROR_NAMES } from "../runner/outcome.js";
import { probeCanaries, UndiscerningCanaryError } from "../runner.js";
import { paint } from "./screen.js";

/**
 * The accounts a canary is owed for, by name.
 *
 * An anonymous account — "check that nobody at all can get in here" — has nothing
 * to authenticate, and `runVerdict` excludes it from the rule that ends such a
 * run with exit 2. The same predicate the report calls `!anonymous`, which is
 * `tokenEnv` being set. Asked here so that the screen's warning fires on exactly
 * the runs the file's does: a warning printed under a wider condition than the
 * one it describes is the same disagreement in a subtler form.
 *
 * Names and not a count, because the rule became per account on 19 August: a run
 * where one account of four has a canary is not a run with canaries, and "not one
 * account declares a canary" was false about it while the exit code was still 2.
 * The preview's job is to say which line of the configuration to add.
 */
export function accountsOwedACanary(config: RunConfig): readonly string[] {
  return config.accounts
    .filter((account) => account.tokenEnv !== undefined && account.canary === undefined)
    .map((account) => account.id);
}

/** The canaries a declaration asks for, as the runner wants them. */
export function declaredCanaries(
  config: RunConfig,
): readonly { readonly accountId: string; readonly endpointId: string }[] {
  return config.accounts
    .filter((account) => account.canary !== undefined)
    .map((account) => ({ accountId: account.id, endpointId: account.canary ?? "" }));
}

/** Everything both passes need, because both send the same requests to the same places. */
export interface CanaryPass {
  readonly baseUrl: string;
  readonly endpoints: readonly Endpoint[];
  readonly canaries: readonly { readonly accountId: string; readonly endpointId: string }[];
  readonly credentials: CredentialProvider;
  readonly client: HttpClient;
  /** As `RunConfig` holds it — a list that is empty rather than absent. */
  readonly exclude: readonly string[];
  readonly allowUnsafeMethods: boolean;
  /** Every matrix row; the rows under conditions are dropped below. */
  readonly accounts: readonly Account[];
  readonly tenantBaseUrls: ReadonlyMap<TenantId, string>;
}

/**
 * Canaries check authentication, not conditions: an account under conditions
 * presents the same credentials, so a second pass over it would confirm nothing
 * new while doubling the requests.
 *
 * Done here rather than at each call: the two passes had the same filter written
 * out twice, which is two chances for them to end up asking about different rows.
 */
function authenticatingRows(accounts: readonly Account[]): readonly Account[] {
  return accounts.filter((account) => account.contextId === undefined);
}

/**
 * The canaries before the walk, and the two things that stop the run outright.
 *
 * The report's own type on the way out rather than a structural copy: a copy
 * drifts, and a field it has not heard of is dropped in silence.
 *
 * @throws {Error} naming every canary that did not pass, and which of three
 *   things went wrong
 * @throws {UndiscerningCanaryError} when a canary answers an anonymous request too
 */
export async function probeBeforeWalk(pass: CanaryPass): Promise<readonly CanaryOutcome[]> {
  if (pass.canaries.length === 0) {
    return [];
  }
  const results = await probeCanaries({
    baseUrl: pass.baseUrl,
    endpoints: pass.endpoints,
    canaries: pass.canaries,
    credentials: pass.credentials,
    client: pass.client,
    exclude: pass.exclude,
    allowUnsafeMethods: pass.allowUnsafeMethods,
    accounts: authenticatingRows(pass.accounts),
    tenantBaseUrls: pass.tenantBaseUrls,
  });
  const broken = results.filter((result) => !result.authenticated);
  if (broken.length > 0) {
    const details = broken
      .map((r) =>
        r.status === 0
          ? `  ${r.accountId}: ${r.endpointId} did not answer (${r.failure ?? "TRANSPORT"})`
          : `  ${r.accountId}: ${r.endpointId} returned ${r.status}`,
      )
      .join("\n");

    // Three different facts, and the message used to name one. A cold read hit
    // a dead port and was told "401 reads as a denial", so it went looking for
    // a stale token; the audit then hit its own `--max-requests` and was told
    // to check the port, while the platform was up and had already answered.
    const stopped = broken.some((r) => TERMINAL_ERROR_NAMES.has(r.failure ?? ""));
    const unreachable = broken.some(
      (r) => r.status === 0 && !TERMINAL_ERROR_NAMES.has(r.failure ?? ""),
    );
    const refused = broken.some((r) => r.status !== 0);
    const why = [
      stopped
        ? `The run stopped itself before the canaries were through: the request ` +
          `budget ran out, or the circuit breaker tripped on a run of failures. ` +
          `Nothing here is about the platform or the tokens — raise ` +
          `--max-requests, or find out what the platform was answering.`
        : undefined,
      unreachable
        ? `The platform did not answer at all: nothing reached the application, so ` +
          `this says nothing about the tokens. Check the address, the port and that ` +
          `the deployment is up.`
        : undefined,
      refused
        ? `Continuing past a denial is not an option: 401 reads as a denial, and the ` +
          `report would come out clean.`
        : undefined,
    ]
      .filter((line) => line !== undefined)
      .join("\n");

    throw new Error(`The canaries did not pass, the run stopped:\n${details}\n${why}`);
  }

  // A canary that passed, on an endpoint that answers everybody, confirms
  // nothing — and confirming is its whole job. Checked after the failures
  // above, because a canary that did not pass has a more specific thing wrong
  // with it, and before the walk, because the answer does not change once the
  // walk starts and the traffic is somebody else's to pay for.
  const undiscerning = results.find(
    (result) => result.anonymousStatus !== undefined && result.anonymousStatus < 300,
  );
  if (undiscerning !== undefined) {
    throw new UndiscerningCanaryError(
      undiscerning.accountId,
      undiscerning.endpointId,
      undiscerning.anonymousStatus ?? 0,
    );
  }

  return results;
}

/** What the second pass leaves the report to answer for. */
export interface CanaryAftermath {
  readonly staleCredentials: readonly string[];
  readonly unverifiedAfterWalk: readonly string[];
}

/**
 * The canaries again, now that the walk is over.
 *
 * Checked once at the start, they answer "were we authenticated when we
 * began". A token that dies in the middle turns every remaining cell into a
 * 401, which reads as a denial, agrees with a policy of denial and lands in
 * `cellsMatched` as "tested and agreed". At the conservative default of five
 * requests a second a matrix of any size takes longer than a short-lived token
 * lives, so this is the ordinary case rather than the exotic one.
 *
 * `findUnauthenticated` cannot catch it: it asks whether an account was
 * granted access nowhere, and the first half of the walk succeeded.
 *
 * Skipped when the run was already cut short — the verdict is 2 either way,
 * and the budget that ended the walk would end these requests too.
 */
export async function confirmAfterWalk(
  pass: CanaryPass & {
    /** What the first pass concluded, so that only accounts that passed are judged. */
    readonly before: readonly CanaryOutcome[];
    readonly truncated: boolean;
  },
): Promise<CanaryAftermath> {
  const staleCredentials: string[] = [];
  const unverifiedAfterWalk: string[] = [];
  if (pass.canaries.length === 0 || pass.truncated) {
    return { staleCredentials, unverifiedAfterWalk };
  }
  const after = await probeCanaries({
    baseUrl: pass.baseUrl,
    endpoints: pass.endpoints,
    canaries: pass.canaries,
    credentials: pass.credentials,
    client: pass.client,
    exclude: pass.exclude,
    allowUnsafeMethods: pass.allowUnsafeMethods,
    accounts: authenticatingRows(pass.accounts),
    tenantBaseUrls: pass.tenantBaseUrls,
    // The control request belongs to the first pass: whether the endpoint
    // distinguishes is a property of the endpoint, and the walk does not change
    // it. Asking again spends a request on somebody else’s platform to learn
    // what is already known.
    controlRequests: false,
  });
  const passedBefore = new Set(
    pass.before.filter((one) => one.authenticated).map((one) => one.accountId),
  );
  for (const result of after) {
    // A terminal failure is our own ceiling, not a dead token: saying the
    // credentials went stale there would send the reader after the wrong thing.
    // It is not nothing either, and silence here is what the audit of 20 August
    // found: a ceiling of 14 requests, which the preview itself called enough,
    // ate the whole second pass and the run came back 0 with a dead token.
    const stopped = TERMINAL_ERROR_NAMES.has(result.failure ?? "");
    if (!passedBefore.has(result.accountId)) {
      continue;
    }
    if (stopped) {
      unverifiedAfterWalk.push(result.accountId);
    } else if (result.status === 0) {
      // Nothing came back at all, so nothing here is about the credentials.
      // The first pass tells these three apart — our own ceiling, a platform
      // that did not answer, a refusal — and the second told only two: a
      // deployment that died after the walk was reported as "the credentials
      // went stale", sending the reader after a token while the stand was
      // down. The walk itself is untouched in that case, which is why this is
      // the same reservation as a ceiling and not a finding about access.
      // Found by adversarial review, 21 August 2026 (V-6).
      unverifiedAfterWalk.push(result.accountId);
    } else if (!result.authenticated) {
      staleCredentials.push(result.accountId);
    }
  }
  if (unverifiedAfterWalk.length > 0) {
    process.stderr.write(
      `${paint("Authentication was not confirmed a second time:", "red")} ` +
        `${unverifiedAfterWalk.join(", ")}. The canaries could not be probed ` +
        `again — the run hit its own ceiling, or the platform stopped answering ` +
        `— so nothing says the tokens still worked at the end of the walk.\n`,
    );
  }
  if (staleCredentials.length > 0) {
    process.stderr.write(
      `${paint("Credentials went stale during the run:", "red")} ${staleCredentials.join(", ")}. ` +
        `Their canary passed before the walk and fails now, so every cell probed ` +
        `after that point recorded a refusal that says nothing about access. The ` +
        `results cannot be trusted.\n`,
    );
  }
  return { staleCredentials, unverifiedAfterWalk };
}

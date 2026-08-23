/**
 * Authentication, confirmed per account before the walk is allowed to mean
 * anything.
 *
 * Two halves that have to agree: what can be checked without sending anything —
 * `assertCanariesUsable`, called once above the `--dry-run` branch so that the
 * preview and the walk refuse the same declarations and every message is true of
 * both — and the pass that does send.
 *
 * A canary is refused up front for five reasons, and the relation to
 * `planEndpoints` is a partial mirror rather than a one-for-one one. Three of the
 * four reasons the plan has for not probing an endpoint have a refusal here —
 * `excluded`, `unsafe-method`, `path-parameters` — and adding a reason there
 * means asking whether one belongs here. The fourth, `escapes-target`, has none,
 * because no endpoint source can produce it (see `assertCanariesUsable`). The
 * remaining two refusals answer to nothing in the plan: an endpoint the
 * declaration does not name, and a canary the policy denies the account's role.
 * The header said "one for one" until 23 August 2026, contradicted a hundred
 * lines below by `UnsafeCanaryError`'s own comment, which counts the mirror
 * correctly.
 */

import type { CredentialProvider, HttpClient } from "../adapters/ports.js";
import type { Account, Endpoint, ResolvedAccessPolicy, TenantId } from "../core/index.js";
import { resolveExpectedVerdict, SAFE_METHODS } from "../core/index.js";
import { hasPathParameters } from "../core/path-parameters.js";
import { safeHeaders } from "../io/untrusted.js";
import { baseUrlForTenant, joinUrl } from "./address.js";
import { failureCode, terminalCause } from "./outcome.js";

export interface CanaryResult {
  readonly accountId: string;
  readonly endpointId: string;
  readonly status: number;
  readonly authenticated: boolean;
  /**
   * What the same endpoint answered with no credentials at all.
   *
   * Absent where the credentialed request did not succeed — there is nothing to
   * control against — and absent where the unauthenticated request failed on the
   * wire, which is a refusal loud enough to count as distinguishing.
   *
   * A canary that answers 2xx to nobody in particular confirms nothing: the
   * account's token could be a random string. See ADR-0040.
   */
  readonly anonymousStatus?: number;
  /**
   * Why the request never produced a status, when it did not: `ECONNREFUSED`,
   * `ENOTFOUND`, `UND_ERR_CONNECT_TIMEOUT` and their like.
   *
   * A code and not a message. Found by a cold read: a dead port made the canary
   * say "401 reads as a denial", and the reader spent a minute looking for a
   * stale token instead of a wrong port. The two facts deserve two sentences.
   *
   * A code rather than the error text for the same reason `SignalValue` admits
   * no strings: this field is serialized into the report, and a bounded
   * vocabulary of symbols structurally cannot carry a URL with a token in it.
   */
  readonly failure?: string;
}

export class UnknownCanaryEndpointError extends Error {
  constructor(accountId: string, endpointId: string) {
    super(`The canary of account "${accountId}" references an unknown endpoint "${endpointId}"`);
    this.name = "UnknownCanaryEndpointError";
  }
}

export class ExcludedCanaryError extends Error {
  constructor(accountId: string, endpointId: string) {
    super(
      `The canary of account "${accountId}" points at excluded endpoint "${endpointId}". ` +
        `The exclusion list exists precisely for addresses that must not be touched — ` +
        `a canary must not be a way around it.`,
    );
    this.name = "ExcludedCanaryError";
  }
}

/**
 * A canary that answers the same to nobody as it does to the account.
 *
 * The fourth road to the state ADR-0033 was written to end, and the only one
 * that leaves a canary in the configuration doing nothing. `/health`,
 * `/version`, `/api/status` are what an operator reaches for when asked to name
 * an endpoint the account can reach; every one of them answers 2xx without
 * credentials, so the canary passes with a dead token, every cell of the account
 * comes back 401, the policy declares it denied, and the report says
 * `match: true` on all of them with exit 0.
 *
 * See ADR-0040 and the adversarial review of 21 August 2026 (V-2).
 */
export class UndiscerningCanaryError extends Error {
  readonly accountId: string;
  readonly endpointId: string;
  readonly anonymousStatus: number;

  constructor(accountId: string, endpointId: string, anonymousStatus: number) {
    super(
      `The canary of account "${accountId}" points at "${endpointId}", which ` +
        `answered ${anonymousStatus} to a request carrying no credentials at all. ` +
        `A canary exists to show that this account's credentials work; an endpoint ` +
        `that answers everybody shows nothing, and the account's token could be a ` +
        `random string for all this run would notice. Pick an endpoint that ` +
        `refuses an anonymous request — the one the account needs its credentials ` +
        `for is the one worth naming here.`,
    );
    this.name = "UndiscerningCanaryError";
    this.accountId = accountId;
    this.endpointId = endpointId;
    this.anonymousStatus = anonymousStatus;
  }
}

/**
 * A canary the policy denies for that account's role.
 *
 * Two statements by the same person that cannot both be true. A canary is chosen
 * because the account demonstrably reaches the endpoint — the run stops if it
 * does not — and the policy says the role may not. Left alone, the walk probes
 * the same endpoint, gets the same 200, and files a `privilege-escalation`
 * against a platform that did nothing wrong.
 */
export class DeniedCanaryError extends Error {
  readonly accountId: string;
  readonly endpointId: string;

  constructor(accountId: string, endpointId: string, roleId: string) {
    super(
      `The canary of account "${accountId}" points at "${endpointId}", which the ` +
        `policy denies to role "${roleId}". A canary is a request the account is ` +
        `expected to succeed at, so this configuration says two things at once — ` +
        `and the run would report a privilege escalation on that cell no matter ` +
        `how the platform behaves. Pick a canary the policy allows this role, or ` +
        `declare a rule saying the access is expected.`,
    );
    this.name = "DeniedCanaryError";
    this.accountId = accountId;
    this.endpointId = endpointId;
  }
}

/**
 * A canary whose method a run without `--unsafe-methods` does not issue.
 *
 * The same class as `ExcludedCanaryError` — a canary pointing at something the
 * run will not probe — and the third of the four reasons `planEndpoints` has for
 * not probing to be mirrored here. The fourth, `escapes-target`, no endpoint
 * source can produce; see `assertCanariesUsable`.
 *
 * The safety held: `UnsafeMethodError` fires inside the client and nothing
 * reaches the wire. The diagnosis did not.
 * `failureCode` looks for a transport code on an error this project threw
 * itself, finds none, and the reason falls through to `TRANSPORT` — so a canary
 * on `POST /login` produced "the platform did not answer at all: check the
 * address, the port and that the deployment is up" about a deployment that was
 * up, while the mistake was in the operator's own file. The preview, from the
 * same configuration, printed the endpoint as skipped for its method and in the
 * same summary counted three canary requests against it.
 *
 * Found by adversarial review, 21 August 2026 (V-5). See ADR-0042.
 */
export class UnsafeCanaryError extends Error {
  readonly accountId: string;
  readonly endpointId: string;
  readonly method: string;

  constructor(accountId: string, endpointId: string, method: string) {
    super(
      `The canary of account "${accountId}" points at "${endpointId}", whose ` +
        `method is ${method}. Without --unsafe-methods a run issues ` +
        `${SAFE_METHODS.join(" and ")} only, so this is a request the run would ` +
        `never make — and an account whose canary is never made is one nothing ` +
        `confirms the credentials of. Name a canary on a ` +
        `${SAFE_METHODS.join(" or ")} endpoint: the one this account needs its ` +
        `credentials to read is the one worth naming here. With --unsafe-methods ` +
        `the run issues this one instead, up to three times — twice with ` +
        `credentials and once without.`,
    );
    this.name = "UnsafeCanaryError";
    this.accountId = accountId;
    this.endpointId = endpointId;
    this.method = method;
  }
}

export class TemplatedCanaryError extends Error {
  constructor(accountId: string, endpointId: string) {
    super(
      `The canary of account "${accountId}" points at "${endpointId}", which has path ` +
        `parameters. There is nothing to substitute — choose an endpoint without them.`,
    );
    this.name = "TemplatedCanaryError";
  }
}

/**
 * Whether the declared canaries can be probed at all.
 *
 * Pure, and called from two places on purpose: the walk, which would otherwise
 * discover it after authenticating; and `--dry-run`, which said "parses and
 * validates everything" and did not. A canary on an excluded endpoint passed the
 * preview and stopped the real run — the one command a reader is told to use
 * first against a deployment they do not own. Found by the audit of 14 August
 * 2026 (G-1).
 *
 * Because it is called from both, every message raised here has to be true of
 * both: the preview has sent nothing, so nothing here may say that a request was
 * made or that a platform answered. That is what the message the fifth check
 * replaces got wrong from the other direction — it was a sentence about the
 * platform, printed about a file.
 *
 * The checks that read the endpoint list alone come first, and the one needing
 * the policy last. Between them they now cover every reason `planEndpoints` has
 * for not probing an endpoint, except `escapes-target` — which no endpoint
 * source can produce, since `isUsablePathTemplate` refuses at the door every
 * path that would reach it, and which `joinUrl` names truthfully before any
 * request for the library door that can.
 *
 * @throws {UnknownCanaryEndpointError}
 * @throws {TemplatedCanaryError}
 * @throws {ExcludedCanaryError}
 * @throws {UnsafeCanaryError}
 * @throws {DeniedCanaryError}
 */
export function assertCanariesUsable(options: {
  readonly endpoints: readonly Endpoint[];
  readonly canaries: readonly {
    readonly accountId: string;
    readonly endpointId: string;
    /** The account's role, when the policy is given. */
    readonly roleId?: string;
  }[];
  readonly exclude?: readonly string[];
  /**
   * Whether the run may issue methods outside `SAFE_METHODS`.
   *
   * Absent means no, which is the tool's default everywhere else and the answer
   * that has to be the default here: a caller who forgets the flag gets the
   * strict reading, never a canary quietly cleared for a method the run will
   * not send.
   */
  readonly allowUnsafeMethods?: boolean;
  /**
   * The resolved policy, for the last check. Optional so that a caller with
   * nothing to compare against still gets the four that read the endpoint list
   * alone.
   */
  readonly policy?: ResolvedAccessPolicy;
}): void {
  const byId = new Map(options.endpoints.map((endpoint) => [endpoint.id, endpoint]));
  const safe = new Set<string>(SAFE_METHODS);
  for (const canary of options.canaries) {
    const endpoint = byId.get(canary.endpointId);
    if (endpoint === undefined) {
      throw new UnknownCanaryEndpointError(canary.accountId, canary.endpointId);
    }
    if (hasPathParameters(endpoint.path)) {
      throw new TemplatedCanaryError(canary.accountId, canary.endpointId);
    }
    if ((options.exclude ?? []).includes(canary.endpointId)) {
      throw new ExcludedCanaryError(canary.accountId, canary.endpointId);
    }
    // A canary on a method this run does not issue.
    //
    // The same shape as the exclusion above — a canary aimed at something the
    // run will not probe — and it is checked here for the same reason: the
    // client refuses the method, so the run learns about it as a request that
    // produced no status, and a failure with no transport code reads as
    // `TRANSPORT`. That is a sentence about the address, the port and the
    // liveness of a deployment, printed about a configuration.
    //
    // Ahead of the policy check, because it is the more fundamental of the two:
    // an operator who resolves a policy contradiction on this canary would meet
    // this one next, while resolving this one leaves them with a canary that can
    // actually be sent.
    if (options.allowUnsafeMethods !== true && !safe.has(endpoint.method)) {
      throw new UnsafeCanaryError(canary.accountId, canary.endpointId, endpoint.method);
    }
    // A canary the policy denies is a contradiction inside the declaration.
    //
    // Both halves are the operator's own statement, and they cannot both be
    // true: a canary is chosen because the account demonstrably reaches that
    // endpoint — the run aborts if it does not — while the policy says the role
    // may not. The walk then probes the same endpoint, gets the same 200, and
    // reports a `privilege-escalation` that is a defect in nobody's platform.
    //
    // Refused here rather than reported later, for the reason every other
    // contradiction in a configuration is: a finding that was inevitable before
    // the first request is not evidence, and it costs a reader the trust they
    // spend on the findings beside it. Found by a subagent writing the guide's
    // section on roles, in its own example, on 18 August 2026.
    if (options.policy !== undefined && canary.roleId !== undefined) {
      const verdict = resolveExpectedVerdict(options.policy, canary.roleId, canary.endpointId);
      if (verdict.outcome === "denied") {
        throw new DeniedCanaryError(canary.accountId, canary.endpointId, canary.roleId);
      }
    }
  }
}

/**
 * Checks that the accounts really are authenticated.
 *
 * A canary is an endpoint the account is known to have access to. If it answers
 * with a denial, the token does not work, and there is no point in continuing:
 * the result of such a run looks like "everything is clean", though nothing was
 * checked.
 */
export async function probeCanaries(options: {
  readonly baseUrl: string;
  readonly endpoints: readonly Endpoint[];
  readonly canaries: readonly { readonly accountId: string; readonly endpointId: string }[];
  readonly credentials: CredentialProvider;
  readonly client: HttpClient;
  readonly exclude?: readonly string[];
  /**
   * Whether the run may issue methods outside `SAFE_METHODS`.
   *
   * Passed straight to `assertCanariesUsable`, and absent means no. A client
   * built without the permission refuses the request itself, and what came back
   * from that was a canary with no status and no transport code — which the
   * summary read as a platform that never answered. Checked here so a consumer
   * of the library reaching `probeCanaries` directly gets the same sentence the
   * CLI does.
   */
  readonly allowUnsafeMethods?: boolean;
  /** The accounts — to know the tenant and pick its base address. */
  readonly accounts?: readonly Account[];
  readonly tenantBaseUrls?: ReadonlyMap<TenantId, string>;
  /**
   * Whether to send the control request that shows the canary distinguishes.
   *
   * True where it is not given. The caller sets it false for the pass that
   * follows the walk: what the control establishes is a property of the
   * endpoint, and that does not change while the walk runs — a second one would
   * be a request spent on a platform that is not ours to spend requests on. See
   * ADR-0040.
   */
  readonly controlRequests?: boolean;
}): Promise<readonly CanaryResult[]> {
  const byId = new Map(options.endpoints.map((endpoint) => [endpoint.id, endpoint]));
  // A canary must knock on the host of its own brand: on a platform spread
  // across subdomains a request to a foreign one gives a denial, and the run
  // stops on the false alarm "the token does not work".
  // Accounts outside tenants (anonymous ones) do not get into the map: they have
  // no address of their own, and the request goes to the base one. An account
  // with a set of memberships likewise: there exists no single "own" host for
  // it, and a canary for such an account is picked at the common address.
  const tenantOf = new Map(
    (options.accounts ?? []).flatMap((account) =>
      account.tenantId === undefined ? [] : [[account.id, account.tenantId] as const],
    ),
  );
  const results: CanaryResult[] = [];

  // The same checks the dry run makes, from the same function. Before a request
  // rather than during the loop: a canary that cannot be probed is a mistake in
  // the configuration, and half a run's worth of requests is a poor way to learn
  // about one.
  //
  // `options` is handed over whole, which is what carries `allowUnsafeMethods`
  // and `exclude` through without a second list of field names to keep in step.
  assertCanariesUsable(options);

  for (const canary of options.canaries) {
    const endpoint = byId.get(canary.endpointId);
    // Unreachable, and kept on purpose.
    //
    // `assertCanariesUsable` above resolved these same canaries against these
    // same endpoints and threw this same error for an id no endpoint carries.
    // The call is unconditional and sits in this function, so the guarantee holds
    // for the CLI, for a test and for a consumer of the library reaching
    // `probeCanaries` through `src/index.ts` alike: there is no door into this
    // loop that does not pass it.
    //
    // Deleting it would not leave "no check". `byId.get` is honestly
    // `Endpoint | undefined`, so the lines below would need a non-null assertion,
    // and an edit that ever separated the two — an early return added above the
    // assertion, a caller resolving endpoints of its own — would then read
    // `undefined.path` where today it prints a sentence naming the account and
    // the id. The assertion is what deleting this costs, and it is the dearer of
    // the two.
    //
    // Hence one of the two lines this file never covers: left uncovered rather
    // than reached by a fixture built to be inconsistent with itself.
    if (endpoint === undefined) {
      throw new UnknownCanaryEndpointError(canary.accountId, canary.endpointId);
    }

    const canaryUrl = joinUrl(
      baseUrlForTenant(tenantOf.get(canary.accountId), options.tenantBaseUrls, options.baseUrl),
      endpoint.path,
    );

    let status = 0;
    let failure: string | undefined;
    try {
      const response = await options.client.send({
        method: endpoint.method,
        url: canaryUrl,
        headers: options.credentials.headersFor(canary.accountId, {
          method: endpoint.method,
          url: canaryUrl,
        }),
      });
      status = response.status;
    } catch (error) {
      status = 0;
      // A terminal condition is our own doing, not the platform's silence. Left
      // as `TRANSPORT` it produced "the platform did not answer at all — check
      // the address, the port and that the deployment is up" while the platform
      // was up and had already answered: the run had simply hit the ceiling the
      // operator set. Found by the audit of 14 August.
      failure = terminalCause(error)?.name ?? failureCode(error) ?? "TRANSPORT";
    }

    const authenticated = status >= 200 && status < 300;

    // The control request: the same endpoint, with no credentials at all.
    //
    // A canary answers "these credentials work". A 2xx alone does not say that —
    // it says the endpoint answered. `/health`, `/version`, `/api/status` answer
    // 2xx to anybody, and they are the most natural thing an operator reaches for
    // when asked to name an endpoint the account can reach. With one of those
    // nominated, a dead token passed the canary, every cell of the account came
    // back 401, the policy declared it denied, and the report said `match: true`
    // on all of them with exit 0 — the state ADR-0033 was written to end, reached
    // by a fourth road. Found by adversarial review, 21 August 2026 (V-2).
    //
    // Sent only where the credentialed request succeeded: where it did not, the
    // run is stopping anyway and this would be a request spent on a platform that
    // is not ours to spend requests on. One per account, not per pass — what it
    // establishes is a property of the endpoint, and that does not change while
    // the walk runs.
    let anonymousStatus: number | undefined;
    if (authenticated && options.controlRequests !== false) {
      try {
        const response = await options.client.send({
          method: endpoint.method,
          url: canaryUrl,
          headers: safeHeaders([]),
        });
        anonymousStatus = response.status;
      } catch {
        // The endpoint refused an unauthenticated request loudly enough to fail
        // the request itself. That is the canary distinguishing, which is what
        // was being asked; a failure here says nothing about the credentials.
        anonymousStatus = undefined;
      }
    }

    results.push({
      accountId: canary.accountId,
      endpointId: canary.endpointId,
      status,
      authenticated,
      ...(anonymousStatus === undefined ? {} : { anonymousStatus }),
      ...(failure === undefined ? {} : { failure }),
    });
  }

  return results;
}

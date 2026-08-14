/**
 * The run: a walk over the "account × endpoint" matrix, collecting observations.
 *
 * Not the core — there is I/O here, through the `HttpClient` port. And not an
 * adapter — there is no knowledge of a concrete transport here. This is the
 * layer that binds them.
 */

import type { ContextAttributes, CredentialProvider, HttpClient } from "./adapters/ports.js";
import type {
  AccessObservation,
  AccessOutcome,
  Account,
  Endpoint,
  Resource,
  SignalSpec,
  SignalValue,
  TenantId,
} from "./core/index.js";
import { principalOf, resourceApplies, SAFE_METHODS } from "./core/index.js";

/**
 * What is computed over the body of a marked endpoint.
 *
 * One digest: it answers the question "did two tenants get one and the same
 * response", for the sake of which the relaxation was introduced at all.
 * Widening the set without need is pointless — every extra signal means one more
 * body read.
 */
const DIGEST_SIGNALS = [
  { name: "digest", kind: "digest" },
] as const satisfies readonly SignalSpec[];

/**
 * An endpoint that was not probed, and why.
 *
 * A skip decided by the tool itself is not a failure. The refusal of an unsafe
 * method used to land in `failures`, and normal operation looked like a breakage
 * in the report: on a real API every POST and PUT would give a "went wrong" row.
 */
export interface SkippedEndpoint {
  readonly endpointId: string;
  readonly reason: "path-parameters" | "unsafe-method" | "excluded" | "escapes-target";
}

/**
 * A failed request, with its reason.
 *
 * The reason is mandatory: an `error` with no explanation makes it impossible to
 * tell a deployment that is down from a wrong configuration, and such an entry
 * is useless in the report.
 */
export interface ProbeFailure {
  readonly accountId: string;
  readonly endpointId: string;
  readonly resourceId?: string;
  readonly reason: string;
}

export interface CollectOptions {
  readonly baseUrl: string;
  readonly endpoints: readonly Endpoint[];
  readonly accounts: readonly Account[];
  /** How an account presents itself to the system. The headers do not get into the observations. */
  readonly credentials: CredentialProvider;
  readonly client: HttpClient;
  readonly allowUnsafeMethods?: boolean;
  /** The resources being requested. Without them parameterized endpoints are not probed. */
  readonly resources?: readonly Resource[];
  /**
   * The identifiers of the endpoints not to touch.
   *
   * `SAFE_METHODS` protects against the semantics of the method, but not against
   * an endpoint that violates it: a GET that resets the database stays a GET.
   * Such addresses are excluded by name — there is no other way to tell them
   * apart.
   */
  readonly exclude?: readonly string[];
  /**
   * The base address for individual tenants.
   *
   * Multi-brand platforms often spread the brands across subdomains, and a
   * typical claim under test is "brand A's token does not work on brand B's
   * host". The address is chosen by the **resource's** tenant, not the
   * account's: what we ask for is precisely someone else's data, and it lives on
   * someone else's host. When there is no resource, the account's tenant is
   * taken — the question is then about its own scope.
   */
  readonly tenantBaseUrls?: ReadonlyMap<TenantId, string>;
  /**
   * The attributes of accounts under declared conditions: the id of the account
   * under conditions → what to add to the request and whose credentials to
   * present.
   *
   * The core knows nothing about this: the `contextId` label on the account is
   * enough for it. Here the conditions become request headers and parameters.
   * See ADR-0019.
   */
  readonly contextAttributes?: ReadonlyMap<string, ContextAttributes>;
}

export interface CollectResult {
  readonly observations: readonly AccessObservation[];
  readonly skipped: readonly SkippedEndpoint[];
  readonly failures: readonly ProbeFailure[];
  /**
   * The endpoints that were actually probed.
   *
   * The matrix is built out of these only: an endpoint that was not walked is a
   * gap in coverage, already listed in `skipped`, rather than a discrepancy on
   * every account. Otherwise one skip produces as many findings as there are
   * accounts, and the real signal drowns.
   */
  readonly probed: readonly Endpoint[];
  /**
   * The run broke off without reaching the end of the matrix.
   *
   * An exhausted request ceiling or a tripped circuit breaker cut the walk short
   * in the middle of the list. The tail stays unchecked, but there are no
   * findings in it precisely because it was never reached — and without this
   * flag the verdict "clean" is indistinguishable from a real one.
   */
  readonly truncated: boolean;
}

const TEMPLATE_PARAMETER = /\{[^}]+\}/;

/**
 * Reduces the response status to a conclusion about access.
 *
 * A conclusion is drawn only where it is unambiguous. Everything else —
 * including 3xx, 4xx other than the ones listed, and 5xx — is an `error`:
 * "cannot be judged". Stretching `denied` over them would mean recording the
 * absence of a conclusion as a successful denial, and such records are later
 * read as proof of protection.
 *
 * 451 is a denial on equal terms with 401 and 403. It is never ambiguous:
 * "unavailable for legal reasons" is a decision not to serve, not a failure and
 * not a missing resource. Added together with request conditions (ADR-0019): geo
 * and jurisdiction restrictions answer with exactly this, and without this line a
 * healthy platform would give a wall of `probe-error` right where it works
 * correctly.
 */
export function classifyStatus(status: number): AccessOutcome {
  if (status >= 200 && status < 300) {
    return "allowed";
  }
  if (status === 401 || status === 403 || status === 451) {
    return "denied";
  }
  if (status === 404) {
    return "not-found";
  }
  return "error";
}

export class PathEscapesTargetError extends Error {
  readonly endpointPath: string;

  constructor(endpointPath: string, resolved: string, expectedOrigin: string) {
    super(
      `Path "${endpointPath}" would send the request to "${resolved}" instead of ` +
        `"${expectedOrigin}". An endpoint path comes from the specification of the ` +
        `system under test and is not trusted: an absolute address in it would let ` +
        `that system choose the scheme and port.`,
    );
    this.name = "PathEscapesTargetError";
    this.endpointPath = endpointPath;
  }
}

/**
 * Assembles the address of the request.
 *
 * The origin of the result is compared against the origin of the target. The
 * reason was found by adversarial review: `new URL(path, base)` gives priority
 * to an absolute address, so a path like `http://the-same-host:9999/x` from the
 * specification overrode the base URL entirely — it downgraded https to http and
 * led to an arbitrary port. The allowlist check did not catch this: it compared
 * only the host name.
 *
 * A backslash and `..` are cut off as well: comparing origins makes the form of
 * the notation irrelevant.
 */
function joinUrl(baseUrl: string, path: string): string {
  const base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const resolved = new URL(path.replace(/^[/\\]+/, ""), base);
  // Both the origin and the path prefix are compared. The origin alone is not
  // enough: a `..` in a resource's value led the request above the declared base
  // path while staying on the same host — that is, to a neighbouring API of the
  // same system.
  if (resolved.origin !== base.origin || !resolved.pathname.startsWith(base.pathname)) {
    throw new PathEscapesTargetError(
      path,
      `${resolved.origin}${resolved.pathname}`,
      `${base.origin}${base.pathname}`,
    );
  }
  return resolved.toString();
}

/**
 * The base address for a request: the tenant's own address if declared, the
 * common one otherwise.
 *
 * A function of its own, because the case "there is no tenant at all" — an
 * account outside tenants, that is, an anonymous one — must be decided the same
 * way in the canary and in the main run. Placeholders like `?? ""` are
 * inadmissible here: an empty string would again become a tenant name, even if
 * one that matches nothing.
 *
 * For an account with a set of memberships (ADR-0017) `tenantId` is not set, and
 * `undefined` arrives here: such an account has no single host of its own,
 * picking one out of the set would be guessing, and the request goes to the
 * common address. This does not concern requests for a resource — there the
 * address is taken by the resource's tenant.
 */
function baseUrlForTenant(
  tenantId: TenantId | undefined,
  tenantBaseUrls: ReadonlyMap<TenantId, string> | undefined,
  fallback: string,
): string {
  if (tenantId === undefined) {
    return fallback;
  }
  return tenantBaseUrls?.get(tenantId) ?? fallback;
}

const PARAMETER_NAME = /\{([^}]+)\}/g;

/** Substitutes the resource's values into the path template. */
function substitute(path: string, resource: Resource): string {
  return path.replace(PARAMETER_NAME, (_match, name: string) =>
    encodeURIComponent(Object.hasOwn(resource.params, name) ? (resource.params[name] ?? "") : ""),
  );
}

function withQuery(
  url: string,
  resource: Resource | undefined,
  extra: Readonly<Record<string, string>> = {},
): string {
  const query = { ...resource?.query, ...extra };
  if (Object.keys(query).length === 0) {
    return url;
  }
  const parsed = new URL(url);
  for (const [name, value] of Object.entries(query)) {
    parsed.searchParams.set(name, value);
  }
  return parsed.toString();
}

/** Whether a request along this path stays within the target. */
export function staysWithinTarget(baseUrl: string, path: string): boolean {
  try {
    joinUrl(baseUrl, path);
    return true;
  } catch {
    return false;
  }
}

export interface CanaryResult {
  readonly accountId: string;
  readonly endpointId: string;
  readonly status: number;
  readonly authenticated: boolean;
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
  /** The accounts — to know the tenant and pick its base address. */
  readonly accounts?: readonly Account[];
  readonly tenantBaseUrls?: ReadonlyMap<TenantId, string>;
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

  for (const canary of options.canaries) {
    const endpoint = byId.get(canary.endpointId);
    if (endpoint === undefined) {
      throw new UnknownCanaryEndpointError(canary.accountId, canary.endpointId);
    }
    if (TEMPLATE_PARAMETER.test(endpoint.path)) {
      throw new TemplatedCanaryError(canary.accountId, canary.endpointId);
    }
    if ((options.exclude ?? []).includes(canary.endpointId)) {
      throw new ExcludedCanaryError(canary.accountId, canary.endpointId);
    }

    const canaryUrl = joinUrl(
      baseUrlForTenant(tenantOf.get(canary.accountId), options.tenantBaseUrls, options.baseUrl),
      endpoint.path,
    );

    let status = 0;
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
    } catch {
      status = 0;
    }

    results.push({
      accountId: canary.accountId,
      endpointId: canary.endpointId,
      status,
      authenticated: status >= 200 && status < 300,
    });
  }

  return results;
}

/**
 * Probes every "account × endpoint" pair.
 *
 * Endpoints with parameters in the path are skipped: there is nothing to
 * substitute an identifier from until the question of collecting values from
 * responses is settled. The skip is returned explicitly rather than by silence —
 * otherwise what was not checked would look as if it had been.
 */
export async function collectObservations(options: CollectOptions): Promise<CollectResult> {
  const probeable: Endpoint[] = [];
  const skipped: SkippedEndpoint[] = [];
  const excluded = new Set(options.exclude ?? []);
  const safe = new Set<string>(SAFE_METHODS);

  for (const endpoint of options.endpoints) {
    if (excluded.has(endpoint.id)) {
      skipped.push({ endpointId: endpoint.id, reason: "excluded" });
    } else if (options.allowUnsafeMethods !== true && !safe.has(endpoint.method)) {
      skipped.push({ endpointId: endpoint.id, reason: "unsafe-method" });
    } else if (
      TEMPLATE_PARAMETER.test(endpoint.path) &&
      !(options.resources ?? []).some((resource) => resourceApplies(endpoint, resource))
    ) {
      // There are parameters, but no resource with values for them is declared —
      // there is nothing to substitute.
      skipped.push({ endpointId: endpoint.id, reason: "path-parameters" });
    } else if (
      // Only what escapes EVERY declared address is filtered out: otherwise an
      // endpoint that is legitimate for a brand on a subdomain would be skipped
      // because it does not match the default address.
      ![options.baseUrl, ...(options.tenantBaseUrls?.values() ?? [])].some((base) =>
        staysWithinTarget(base, endpoint.path),
      )
    ) {
      // The path leads outside the target. That is a property of the endpoint
      // rather than a failure of the request, hence a skip and not an error: one
      // hostile path in a specification must not break off the whole run.
      skipped.push({ endpointId: endpoint.id, reason: "escapes-target" });
    } else {
      probeable.push(endpoint);
    }
  }

  const observations: AccessObservation[] = [];
  const failures: ProbeFailure[] = [];
  let truncated = false;

  // An endpoint without parameters is probed once; one with parameters — once
  // per resource that covers those parameters.
  const cells: Array<{ endpoint: Endpoint; resource?: Resource }> = [];
  for (const endpoint of probeable) {
    const applicable = (options.resources ?? []).filter((resource) =>
      resourceApplies(endpoint, resource),
    );
    if (applicable.length === 0) {
      cells.push({ endpoint });
      continue;
    }
    for (const resource of applicable) {
      cells.push({ endpoint, resource });
    }
  }

  for (const account of options.accounts) {
    const attributes = options.contextAttributes?.get(account.id);
    // Conditions do not change the account: it presents itself, and what changes
    // is the request. There is one source — `principalOf`: the same thing is
    // needed by the relation to the resource and by the report, and three
    // different "take the original account" would drift apart silently.
    const credentialAccountId = principalOf(account);
    for (const { endpoint, resource } of cells) {
      // An account under conditions exists only on the declared endpoints.
      if (account.endpointIds !== undefined && !account.endpointIds.includes(endpoint.id)) {
        continue;
      }
      const startedAt = Date.now();
      const path = resource === undefined ? endpoint.path : substitute(endpoint.path, resource);
      const tenantId = resource?.tenantId ?? account.tenantId;
      const baseUrl = baseUrlForTenant(tenantId, options.tenantBaseUrls, options.baseUrl);
      // The scope check is over the finished path, not over the template: a
      // resource value with `..` led the request above the declared base path,
      // because the template was checked before substitution.
      let url: string;
      try {
        url = withQuery(joinUrl(baseUrl, path), resource, attributes?.query);
      } catch (cause) {
        failures.push({
          accountId: account.id,
          endpointId: endpoint.id,
          ...(resource === undefined ? {} : { resourceId: resource.id }),
          reason: cause instanceof Error ? cause.message : String(cause),
        });
        continue;
      }
      // The body is read only where a human declared `responseMustDifferByTenant`:
      // where it is not declared, the stream is cancelled unread. See ADR-0011.
      // The digest is implied by that declaration itself — there is nothing else
      // to compare responses between tenants with — while the other scalars are
      // declared by a human explicitly. Empty means the body is not read at all.
      const specs: readonly SignalSpec[] = [
        ...(endpoint.responseMustDifferByTenant === true ? DIGEST_SIGNALS : []),
        ...(endpoint.signals ?? []),
      ];
      // The headers are taken for every request rather than once per account:
      // the signature depends on the method and the address, and a value hoisted
      // out of the loop would silently sign every cell with the first request.
      // See ADR-0018.
      //
      // The condition attributes are added **after** the credential ones: they
      // cannot replace a credential header — that is checked when the
      // configuration is parsed — and the order here is the second line of the
      // same defence, not a matter of style.
      const request = {
        method: endpoint.method,
        url,
        headers: {
          ...options.credentials.headersFor(credentialAccountId, {
            method: endpoint.method,
            url,
          }),
          ...attributes?.headers,
        },
        ...(specs.length === 0 ? {} : { signals: specs }),
      };

      let status: number;
      let headers: Readonly<Record<string, string>>;
      let signals: Readonly<Record<string, SignalValue>> | undefined;
      try {
        const response = await options.client.send(request);
        status = response.status;
        headers = response.headers;
        signals = response.signals;
      } catch (cause) {
        const name = cause instanceof Error ? cause.name : "";
        if (name === "RunBudgetExhaustedError" || name === "CircuitOpenError") {
          truncated = true;
        }
        // A failed request is the absence of a conclusion, not a denial of access.
        status = 0;
        headers = {};
        failures.push({
          accountId: account.id,
          endpointId: endpoint.id,
          ...(resource === undefined ? {} : { resourceId: resource.id }),
          reason: cause instanceof Error ? cause.message : String(cause),
        });
      }

      observations.push({
        accountId: account.id,
        endpointId: endpoint.id,
        method: endpoint.method,
        url,
        ...(resource === undefined ? {} : { resourceId: resource.id }),
        status,
        headers,
        outcome: status === 0 ? "error" : classifyStatus(status),
        durationMs: Date.now() - startedAt,
        // The moment of the request, not only the duration: otherwise there is
        // nothing to match the finding against the platform's log.
        at: new Date(startedAt).toISOString(),
        ...(signals === undefined ? {} : { signals }),
      });
    }
  }

  return { observations, skipped, failures, probed: probeable, truncated };
}

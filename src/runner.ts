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
import { DEFAULT_DIGEST_SIGNAL, principalOf, resourceApplies, SAFE_METHODS } from "./core/index.js";
import { pathSegment } from "./io/untrusted.js";

/**
 * What is computed over the body of a marked endpoint.
 *
 * One digest: it answers the question "did two tenants get one and the same
 * response", for the sake of which the relaxation was introduced at all.
 * Widening the set without need is pointless — every extra signal means one more
 * body read.
 */
const DIGEST_SIGNALS = [
  { name: DEFAULT_DIGEST_SIGNAL, kind: "digest" },
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
  /**
   * How many cells may be in flight at once.
   *
   * Taken from `throttle.limits`, the single place where the defaults and the
   * flags are merged — not re-derived here, or the walk and the limiter would
   * disagree about the same number and the report would print one of the two.
   * Absent means one at a time, which is what the walk did unconditionally
   * before: the flag was documented, printed into the report and had no effect.
   *
   * It bounds the walk, not the traffic. The ceiling lives in the throttle and
   * holds whatever this says.
   */
  readonly concurrency?: number;
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
 *
 * **The assumption this whole function rests on**: the platform states the
 * outcome in the status code. One that answers `200` with an error envelope in
 * the body is read as granting access everywhere, and every denied cell of the
 * policy becomes a privilege escalation — a hundred per cent false positives,
 * which is the risk `plan.md` names first.
 *
 * The body checks do not stand outside it, which is not obvious and was measured
 * rather than reasoned: they run on cells whose `outcome` is `allowed`, and here
 * that is every cell, so two accounts in different tenants both **refused** with
 * the same envelope produce equal digests and a cross-tenant leak that is not
 * there. Six cells, four false escalations, one false leak, exit code 1.
 *
 * There is no way to declare "a refusal looks like this" today. The limitation is
 * written down in the README, in `docs/guide.md` and in `docs/report.md` rather
 * than left for the reader of a bad report to work out. See L-3.
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

/**
 * Substitutes the resource's values into the path template.
 *
 * A value that is not a segment stops this cell rather than quietly changing the
 * address. Configuration refuses those three values at startup; this is the same
 * refusal for whoever assembles resources through the library, and the caller
 * records it as a failure of one cell.
 *
 * A missing name still yields an empty segment on purpose — the template asked
 * for a parameter the resource does not describe, and that is a mismatch between
 * the two, caught by `resourceApplies` before it gets here.
 */
function substitute(path: string, resource: Resource): string {
  return path.replace(PARAMETER_NAME, (_match, name: string) => {
    if (!Object.hasOwn(resource.params, name)) {
      return "";
    }
    const value = resource.params[name] ?? "";
    // `pathSegment` checks and escapes in one step. Written out here as two, the
    // check and the escaping could be separated by an edit — and it is the pair
    // that holds: `encodeURIComponent` leaves the dot alone, so a value of `.`
    // survives escaping and navigates.
    try {
      return pathSegment(value);
    } catch {
      throw new UnusablePathValueError(resource.id, name, value);
    }
  });
}

/**
 * A resource value that would change which endpoint is addressed.
 *
 * Found by the audit of 14 August: `.` in a path parameter sent the request to
 * the neighbouring collection endpoint, which the configuration had excluded,
 * and the verdict for the parameterised endpoint was then computed from that
 * answer.
 */
export class UnusablePathValueError extends Error {
  constructor(resourceId: string, name: string, value: string) {
    super(
      `Resource "${resourceId}" gives path parameter "${name}" the value ` +
        `"${value}", which is path navigation rather than an identifier: the ` +
        `request would go to a different address than the endpoint names.`,
    );
    this.name = "UnusablePathValueError";
  }
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

/**
 * The transport failure's code, if the error carries one.
 *
 * `fetch` wraps the cause: the outer error is an unhelpful `TypeError: fetch
 * failed`, and the code sits one or two levels down.
 */
function failureCode(error: unknown): string | undefined {
  for (const link of causeChain(error)) {
    const code = (link as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code)) {
      return code;
    }
  }
  return undefined;
}

/**
 * The error and everything it wraps, outermost first.
 *
 * Bounded rather than looping until `cause` runs out: a cycle would hang the
 * run, and nothing useful sits four wrappers deep.
 */
function* causeChain(error: unknown, limit = 4): Generator<unknown> {
  let current = error;
  for (let depth = 0; current !== undefined && current !== null && depth < limit; depth += 1) {
    yield current;
    current = (current as { cause?: unknown }).cause;
  }
}

/**
 * The names by which a client says "the walk cannot go on" rather than "this one
 * request failed".
 *
 * By name, because the runner sits above the ports and must not know the classes
 * of any particular client: `instanceof` here would tie it to one implementation
 * of `HttpClient`, which is the thing the port exists to prevent.
 */
const TERMINAL_ERROR_NAMES: ReadonlySet<string> = new Set([
  "RunBudgetExhaustedError",
  "CircuitOpenError",
]);

/**
 * Whether a failure cut the walk short.
 *
 * The whole chain is examined, not the outermost error. Found by the audit of 14
 * August: the client wraps everything in `RequestFailedError` before it leaves
 * (`http.ts`), and a match on the outer name therefore never saw
 * `RunBudgetExhaustedError` at all. An exhausted budget left three cells unprobed
 * and reported `truncated: false`, exit 0 — a clean verdict over a tail nobody
 * looked at.
 *
 * `CircuitOpenError` was recognised only because it happens to be thrown
 * directly, which is what made the defect look closed: past five consecutive
 * failures the breaker trips and sets the flag for its own reasons, so only the
 * last four cells of a run ever showed the fault.
 */
function terminalCause(error: unknown): Error | undefined {
  for (const link of causeChain(error)) {
    if (link instanceof Error && TERMINAL_ERROR_NAMES.has(link.name)) {
      return link;
    }
  }
  return undefined;
}

/** What to write in `failures[].reason`. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
 * @throws {UnknownCanaryEndpointError}
 * @throws {TemplatedCanaryError}
 * @throws {ExcludedCanaryError}
 */
export function assertCanariesUsable(options: {
  readonly endpoints: readonly Endpoint[];
  readonly canaries: readonly { readonly accountId: string; readonly endpointId: string }[];
  readonly exclude?: readonly string[];
}): void {
  const byId = new Map(options.endpoints.map((endpoint) => [endpoint.id, endpoint]));
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
  }
}

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

  // The same three checks the dry run makes, from the same function. Before a
  // request rather than during the loop: a canary that cannot be probed is a
  // mistake in the configuration, and half a run's worth of requests is a poor
  // way to learn about one.
  assertCanariesUsable(options);

  for (const canary of options.canaries) {
    const endpoint = byId.get(canary.endpointId);
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

    results.push({
      accountId: canary.accountId,
      endpointId: canary.endpointId,
      status,
      authenticated: status >= 200 && status < 300,
      ...(failure === undefined ? {} : { failure }),
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
/** What a run will and will not touch, decided before a single request goes out. */
export interface EndpointPlan {
  readonly probeable: readonly Endpoint[];
  readonly skipped: readonly SkippedEndpoint[];
}

/**
 * Splits the endpoints into the ones a run will probe and the ones it will not.
 *
 * A function of its own so that `--dry-run` can print the same answer the run
 * acts on. Recomputing it beside the run would give a preview that agrees with
 * reality until one of the two is edited — and a preview that lies about what
 * will be touched is worse than no preview on someone else's deployment.
 *
 * Pure: no network, no clock, no file system.
 */
export function planEndpoints(options: {
  readonly endpoints: readonly Endpoint[];
  readonly baseUrl: string;
  readonly resources?: readonly Resource[];
  readonly exclude?: readonly string[];
  readonly allowUnsafeMethods?: boolean;
  readonly tenantBaseUrls?: ReadonlyMap<TenantId, string>;
}): EndpointPlan {
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

  return { probeable, skipped };
}

export async function collectObservations(options: CollectOptions): Promise<CollectResult> {
  const { probeable, skipped } = planEndpoints(options);

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

  // Every cell of the run, laid out before the first request.
  //
  // The walk used to be two nested loops with `await client.send` in the middle,
  // so exactly one request was ever in flight and `--concurrency` changed
  // nothing — 615 requests at 20 ms latency took 13 766 ms at 1 and 13 754 ms at
  // 128, while the report printed the number as if it had been honoured. A flat
  // list is what a pool of workers can be handed. Found by the audit of
  // 14 August 2026.
  const tasks: Array<{
    readonly account: Account;
    readonly endpoint: Endpoint;
    readonly resource?: Resource;
    readonly credentialAccountId: string;
    readonly attributes?: ContextAttributes;
  }> = [];
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
      tasks.push({
        account,
        endpoint,
        ...(resource === undefined ? {} : { resource }),
        credentialAccountId,
        ...(attributes === undefined ? {} : { attributes }),
      });
    }
  }

  /**
   * Cells whose object this run has already changed.
   *
   * With `--unsafe-methods` the walk stops being a read. The first account to
   * `DELETE` an order gets 200 and the order is gone; every later account gets
   * 404, which folds into a denial and agrees with a policy of denial — so the
   * tool reports "tested and agreed" about a protection it never observed,
   * having manufactured the answer itself. Found by the audit of 14 August 2026
   * (L-7).
   *
   * Keyed by endpoint and resource, because that is the object: two accounts
   * deleting the same order collide, two accounts deleting different orders do
   * not.
   *
   * Best effort, and worth saying so: the walk is parallel, so two workers can
   * be inside the same cell at once and neither sees the other's write. What
   * this removes is the silent conclusion, not the race.
   */
  const changed = new Set<string>();
  const SAFE = new Set<string>(SAFE_METHODS);

  /** What one cell produced. A cell can yield a failure and an observation both. */
  interface CellResult {
    readonly failure?: ProbeFailure;
    readonly observation?: AccessObservation;
    readonly truncated?: true;
  }

  async function probe(task: (typeof tasks)[number]): Promise<CellResult> {
    const { account, endpoint, resource, credentialAccountId, attributes } = task;
    const startedAt = Date.now();
    const tenantId = resource?.tenantId ?? account.tenantId;
    const baseUrl = baseUrlForTenant(tenantId, options.tenantBaseUrls, options.baseUrl);
    // The scope check is over the finished path, not over the template: a
    // resource value with `..` led the request above the declared base path,
    // because the template was checked before substitution.
    let url: string;
    try {
      const path = resource === undefined ? endpoint.path : substitute(endpoint.path, resource);
      url = withQuery(joinUrl(baseUrl, path), resource, attributes?.query);
    } catch (cause) {
      return {
        failure: {
          accountId: account.id,
          endpointId: endpoint.id,
          ...(resource === undefined ? {} : { resourceId: resource.id }),
          reason: cause instanceof Error ? cause.message : String(cause),
        },
        // A row, and not only an entry in `failures`. A cell that could not even
        // be addressed used to leave no observation, so it produced no
        // `probe-error` and the untrustworthiness threshold could not see it:
        // four cells out of five failing this way exited 0 — "checked, clean" —
        // because the fifth was the whole denominator. Found by the audit of
        // 14 August (B-7).
        //
        // Status 0 is what the report already means by "no answer", and it says
        // the same thing here as it does for a request that failed on the wire.
        // No `url` and no `method`, because there are none: the address is
        // exactly what could not be built, and inventing one would tell the
        // reader a request went somewhere.
        observation: {
          accountId: account.id,
          endpointId: endpoint.id,
          ...(resource === undefined ? {} : { resourceId: resource.id }),
          status: 0,
          headers: {},
          outcome: "error",
          durationMs: Date.now() - startedAt,
          at: new Date(startedAt).toISOString(),
        },
      };
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

    const objectKey = `${endpoint.id}\u0000${resource?.id ?? ""}`;
    let status: number;
    let headers: Readonly<Record<string, string>>;
    let signals: Readonly<Record<string, SignalValue>> | undefined;
    let failure: ProbeFailure | undefined;
    let stopped: true | undefined;
    let selfInflicted = false;
    try {
      const response = await options.client.send(request);
      status = response.status;
      headers = response.headers;
      signals = response.signals;
      if (!SAFE.has(endpoint.method)) {
        if (status >= 200 && status < 300) {
          changed.add(objectKey);
        } else if (status === 404 && changed.has(objectKey)) {
          selfInflicted = true;
          failure = {
            accountId: account.id,
            endpointId: endpoint.id,
            ...(resource === undefined ? {} : { resourceId: resource.id }),
            reason:
              `404 after this run already changed the object with ${endpoint.method} ` +
              `${endpoint.id}. Nothing follows about access: the object is missing ` +
              `because we removed it, not because this account was refused.`,
          };
        }
      }
    } catch (cause) {
      const terminal = terminalCause(cause);
      if (terminal !== undefined) {
        stopped = true;
      }
      // A failed request is the absence of a conclusion, not a denial of access.
      status = 0;
      headers = {};
      failure = {
        accountId: account.id,
        endpointId: endpoint.id,
        ...(resource === undefined ? {} : { resourceId: resource.id }),
        // The terminal error's own words, not the wrapper's. "The request
        // failed after 3 attempts" describes the symptom and blames the
        // network; "the per-run request budget is exhausted" names the cause
        // and says it was our own doing.
        reason: reasonOf(terminal ?? cause),
      };
    }

    return {
      ...(failure === undefined ? {} : { failure }),
      ...(stopped === undefined ? {} : { truncated: stopped }),
      observation: {
        accountId: account.id,
        endpointId: endpoint.id,
        method: endpoint.method,
        url,
        ...(resource === undefined ? {} : { resourceId: resource.id }),
        status,
        headers,
        outcome:
          status === 0
            ? "error"
            : selfInflicted
              ? // Not `not-found`, which would fold into a denial and read as
                // proof of protection. There is no conclusion to draw here: the
                // object is missing because this run removed it.
                "error"
              : classifyStatus(status),
        durationMs: Date.now() - startedAt,
        // The moment of the request, not only the duration: otherwise there is
        // nothing to match the finding against the platform's log.
        at: new Date(startedAt).toISOString(),
        ...(signals === undefined ? {} : { signals }),
      },
    };
  }

  // A pool of workers pulling from one list, sized by the throttle's own limit.
  //
  // Not "start every task and let the throttle queue them": admission is honest
  // either way, but twenty thousand pending promises are held for the whole run,
  // and the first terminal error would still have to be dealt out to all of
  // them. The pool keeps exactly as many in flight as are allowed to be.
  //
  // The traffic ceiling does not move. `client.send` goes through
  // `throttle.run`, which is where concurrency, the rate window and the per-run
  // budget are enforced; the walk only stops starving it. What does change is
  // the circuit breaker's "consecutive": failures interleave now, so it means
  // "this many with no success in between", and up to `concurrency - 1`
  // requests are already in flight when it trips.
  const results = new Array<CellResult>(tasks.length);
  let next = 0;
  /**
   * Set by the first terminal error, and after it no worker takes another cell.
   *
   * The walk used to carry on to the end of the matrix. Every remaining cell
   * then met an exhausted budget, was retried three times with two backoffs, and
   * became a `probe-error` row — "we asked and it broke" about a request that
   * was never sent. Measured on 610 cells with a budget of 149: 3 184 ms and a
   * **512 KB report against 322 KB for the complete run**. A truncated run cost
   * more than a full one and said less. Found by the audit of 14 August (L-9).
   *
   * The cells not reached are simply not observed, and `truncated: true` is what
   * says the tail was never tested. The same run now takes 1 181 ms and 193 KB,
   * and its 461 rows are `not-observed` — which is true — instead of
   * `probe-error`, which was not.
   *
   * Up to `concurrency - 1` requests are already in flight when this is set;
   * they finish. That is bounded by the limit the operator agreed to.
   */
  let stop = false;
  const workers = Array.from(
    // `next++` needs no lock — nothing awaits between the read and the
    // increment, and there is one thread.
    { length: Math.max(1, Math.min(options.concurrency ?? 1, tasks.length)) },
    async () => {
      for (;;) {
        if (stop) {
          return;
        }
        const index = next;
        next += 1;
        if (index >= tasks.length) {
          return;
        }
        const task = tasks[index];
        if (task === undefined) {
          return;
        }
        const result = await probe(task);
        results[index] = result;
        if (result.truncated === true) {
          stop = true;
        }
      }
    },
  );
  await Promise.all(workers);

  // Drained in the order the cells were laid out, not the order they came back
  // in. Two runs of the same matrix have to produce the same file, or a diff
  // between two reports is unreadable and `configDigest` promises more than it
  // delivers.
  for (const result of results) {
    if (result === undefined) {
      continue;
    }
    if (result.failure !== undefined) {
      failures.push(result.failure);
    }
    if (result.observation !== undefined) {
      observations.push(result.observation);
    }
    if (result.truncated === true) {
      truncated = true;
    }
  }

  return { observations, skipped, failures, probed: probeable, truncated };
}

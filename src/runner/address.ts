/**
 * Where a request goes.
 *
 * `joinUrl` is the seam ADR-0032 moved the address grammar to: the one place an
 * address is built, and therefore the one place every door passes through — a
 * specification, an endpoint list, a Postman collection, and a consumer of the
 * library handing `Endpoint[]` straight to the walk. Everything that decides an
 * address is in this file for that reason. A check on one side of a module
 * boundary and the build on the other is the state that ADR was written from.
 */

import type { Resource, TenantId } from "../core/index.js";
import { isAddressablePath, pathSegment, UnusablePathTemplateError } from "../io/untrusted.js";

/**
 * Whether a path names parameters at all.
 *
 * Beside `PARAMETER_NAME` below, which reads the same `{name}` out of the same
 * template: one grammar, and the two spellings of it stay where a reader meets
 * both. Asked by the plan, by the canary checks and — through `substitute` — by
 * the walk.
 */
export const TEMPLATE_PARAMETER = /\{[^}]+\}/;

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
 * That paragraph used to end "a backslash and `..` are cut off as well:
 * comparing origins makes the form of the notation irrelevant", and it was
 * wrong in the half that mattered. Only a **leading** backslash was cut off, and
 * comparing origins says nothing about which path inside the origin was reached:
 * a template of `reports`, two navigating segments and `danger` joined by
 * backslashes kept the origin, kept the base prefix and arrived at `/danger` —
 * an endpoint the configuration had excluded, with the verdict for `reports`
 * computed from its answer. Adversarial review, 19 August 2026.
 *
 * Hence the grammar here, and not only in the adapters that read a document.
 * This is the one place an address is built, so it is the one place where every
 * door — a specification, an endpoint list, a Postman collection, and a consumer
 * of the library building `Endpoint[]` by hand — passes through the same check.
 * `isAddressablePath` is that grammar's literal half; see it for why the seam
 * does not decode percent-escapes the way the door does.
 */
export function joinUrl(baseUrl: string, path: string): string {
  const base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  if (!isAddressablePath(path)) {
    throw new UnusablePathTemplateError(
      path,
      "is not a path this tool can address: a query string, a fragment, a " +
        "backslash, a control character or a navigating segment makes the " +
        "address something other than what the endpoint names",
    );
  }
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
export function baseUrlForTenant(
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
export function substitute(path: string, resource: Resource): string {
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

export function withQuery(
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

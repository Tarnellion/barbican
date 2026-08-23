/**
 * What a run will and will not touch, decided before a single request goes out.
 *
 * Pure, and the same answer `--dry-run` prints and the walk acts on.
 */

import type { Endpoint, Resource, TenantId } from "../core/index.js";
import { resourceApplies, SAFE_METHODS } from "../core/index.js";
import { staysWithinTarget, TEMPLATE_PARAMETER } from "./address.js";

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

/**
 * Building the observed access matrix out of observations.
 *
 * Pure functions: no network, no file system. The input is observations already
 * collected.
 */

import type { TenantNode } from "./tenancy.js";
import type { AccessMatrix, AccessObservation, Account, Endpoint, Resource } from "./types.js";

export class DuplicateIdError extends Error {
  constructor(kind: "endpoint" | "account" | "resource", id: string) {
    super(`Duplicate ${kind} with id "${id}"`);
    this.name = "DuplicateIdError";
  }
}

export class UnknownReferenceError extends Error {
  constructor(kind: "endpoint" | "account" | "resource", id: string) {
    super(`An observation references an unknown ${kind} "${id}"`);
    this.name = "UnknownReferenceError";
  }
}

export class ConflictingObservationError extends Error {
  constructor(accountId: string, endpointId: string, resourceId?: string) {
    const cell = resourceId === undefined ? "" : ` × "${resourceId}"`;
    super(
      `More than one observation for "${accountId}" × "${endpointId}"${cell}. ` +
        `Which one reflects access cannot be determined.`,
    );
    this.name = "ConflictingObservationError";
  }
}

export interface AccessMatrixInput {
  readonly endpoints: readonly Endpoint[];
  readonly accounts: readonly Account[];
  /** The resources being requested. Empty when there are no parameterized endpoints. */
  readonly resources?: readonly Resource[];
  readonly observations: readonly AccessObservation[];
  /** The tenant tree. Absence means a forest of roots with no links. */
  readonly tenants?: readonly TenantNode[];
}

/**
 * The observation index: account → endpoint → resource → observation.
 *
 * Three levels of nested maps rather than a composite string key: gluing
 * identifiers together admits a collision, and silently mixing the results of
 * two accounts or two resources is unacceptable in a tool that judges access
 * rights. An absent resource is the key `undefined`, which Map supports on equal
 * terms with strings, so there is no need to invent a string marker for it.
 *
 * A resource here is a coordinate, not a flag: the same endpoint with one's own
 * resource and with someone else's are different cells with different expected
 * outcomes.
 */
export type ObservationIndex = ReadonlyMap<
  string,
  ReadonlyMap<string, ReadonlyMap<string | undefined, AccessObservation>>
>;

const PARAMETER_NAME = /\{([^}]+)\}/g;

/**
 * Whether the resource applies to the endpoint.
 *
 * One rule for the run and for the diff: if they drifted apart, they would give
 * observations with nothing to compare against, and findings with no
 * observations.
 */
export function resourceApplies(endpoint: Endpoint, resource: Resource): boolean {
  const names = [...endpoint.path.matchAll(PARAMETER_NAME)].map((match) => match[1] ?? "");
  // `Object.hasOwn`, not a check against undefined: the names come from the
  // path, that is, from an untrusted specification, and `{constructor}` would
  // answer for any object through the prototype chain — a hostile spec would get
  // requests from every account against every declared resource.
  const covered = names.every((name) => Object.hasOwn(resource.params, name));

  if (resource.endpointIds !== undefined) {
    return resource.endpointIds.includes(endpoint.id) && covered;
  }
  // Without an explicit list a resource applies only to endpoints with
  // parameters: otherwise a resource with nothing but a query would attach
  // itself to every endpoint in a row.
  return names.length > 0 && covered;
}

/**
 * Assembles the matrix, checking the integrity of the input.
 *
 * The checks are not a formality: an uncovered pair taken for a denial produces
 * a false positive, and a redundant observation an undetermined verdict.
 *
 * @throws {DuplicateIdError} a repeated endpoint or account id
 * @throws {UnknownReferenceError} an observation references an unknown resource
 * @throws {ConflictingObservationError} more than one observation for one pair
 */
export function buildAccessMatrix(input: AccessMatrixInput): AccessMatrix {
  const endpointIds = new Set<string>();
  for (const endpoint of input.endpoints) {
    if (endpointIds.has(endpoint.id)) {
      throw new DuplicateIdError("endpoint", endpoint.id);
    }
    endpointIds.add(endpoint.id);
  }

  const resourceIds = new Set<string>();
  for (const resource of input.resources ?? []) {
    if (resourceIds.has(resource.id)) {
      throw new DuplicateIdError("resource", resource.id);
    }
    resourceIds.add(resource.id);
  }

  const accountIds = new Set<string>();
  for (const account of input.accounts) {
    if (accountIds.has(account.id)) {
      throw new DuplicateIdError("account", account.id);
    }
    accountIds.add(account.id);
  }

  const seen = new Map<string, Map<string, Set<string | undefined>>>();
  for (const observation of input.observations) {
    if (!accountIds.has(observation.accountId)) {
      throw new UnknownReferenceError("account", observation.accountId);
    }
    if (!endpointIds.has(observation.endpointId)) {
      throw new UnknownReferenceError("endpoint", observation.endpointId);
    }
    if (observation.resourceId !== undefined && !resourceIds.has(observation.resourceId)) {
      throw new UnknownReferenceError("resource", observation.resourceId);
    }

    let byEndpoint = seen.get(observation.accountId);
    if (byEndpoint === undefined) {
      byEndpoint = new Map();
      seen.set(observation.accountId, byEndpoint);
    }
    let resourcesSeen = byEndpoint.get(observation.endpointId);
    if (resourcesSeen === undefined) {
      resourcesSeen = new Set();
      byEndpoint.set(observation.endpointId, resourcesSeen);
    }
    if (resourcesSeen.has(observation.resourceId)) {
      throw new ConflictingObservationError(
        observation.accountId,
        observation.endpointId,
        observation.resourceId,
      );
    }
    resourcesSeen.add(observation.resourceId);
  }

  return {
    endpoints: input.endpoints,
    accounts: input.accounts,
    resources: input.resources ?? [],
    observations: input.observations,
    // The tree must reach the diff: without it the relation is computed on the
    // flat model, and the declared kinship silently affects nothing.
    ...(input.tenants === undefined ? {} : { tenants: input.tenants }),
  };
}

export function indexObservations(matrix: AccessMatrix): ObservationIndex {
  const index = new Map<string, Map<string, Map<string | undefined, AccessObservation>>>();
  for (const observation of matrix.observations) {
    let byEndpoint = index.get(observation.accountId);
    if (byEndpoint === undefined) {
      byEndpoint = new Map();
      index.set(observation.accountId, byEndpoint);
    }
    let byResource = byEndpoint.get(observation.endpointId);
    if (byResource === undefined) {
      byResource = new Map();
      byEndpoint.set(observation.endpointId, byResource);
    }
    byResource.set(observation.resourceId, observation);
  }
  return index;
}

export function findObservation(
  index: ObservationIndex,
  accountId: string,
  endpointId: string,
  resourceId?: string,
): AccessObservation | undefined {
  return index.get(accountId)?.get(endpointId)?.get(resourceId);
}

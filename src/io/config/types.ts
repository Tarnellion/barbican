/**
 * The shapes a configuration is read into, and the ones a library consumer names.
 *
 * Written out by hand rather than inferred from the schema, and the reason is in
 * every one of them: `z.infer` gives back mutable shapes, so
 * `readonly allowedHosts: readonly string[]` would come out as
 * `allowedHosts: string[]` and a consumer would lose a guarantee to buy a rule
 * — and the prose above each field does not survive inference either, which is
 * where most of it gets read. What holds the two copies together is in
 * `schema.ts`, beside the schema: the ties can only be written where the
 * inferred type is in scope, and that is the one module allowed to name zod.
 *
 * The `Declared*` shapes are the other half of this module: a section of the
 * file as it was written, before `parseRunConfig` converts it. They are mirrors
 * of the schema — the same field names — which is what makes a tie the right
 * thing to ask of them, and they are not re-exported by `../config.js`:
 * publishing an intermediate form would offer a second answer to the question of
 * what a configuration is.
 */

import type { AuthScheme } from "../../adapters/credentials.js";
import type {
  Acceptance,
  ExpectedAccessPolicy,
  Resource,
  ResourceRelation,
  TenantNode,
} from "../../core/index.js";
import type { HeaderValue } from "../untrusted.js";

export interface AccountConfig {
  readonly id: string;
  readonly role: string;
  /** The tenant. Absent on an account outside of tenants, that is, an anonymous one. */
  readonly tenant?: string | undefined;
  /**
   * A set of tenants — when the account is meant to have nodes that do not form a
   * subtree.
   *
   * Mutually exclusive with `tenant`, and holds at least two names: a set of one
   * is `tenant`. See ADR-0017.
   */
  readonly tenants?: readonly string[] | undefined;
  /** The environment variable name, not the token itself. Absent on anonymous ones. */
  readonly tokenEnv?: string | undefined;
  /**
   * An endpoint this account is known to have access to.
   *
   * `| undefined` spelled out: under `exactOptionalPropertyTypes` zod returns
   * exactly this type for an optional field.
   */
  readonly canary?: string | undefined;
  /** The name of a scheme from `authSchemes`. Absent on an account using the default. */
  readonly authScheme?: string | undefined;
}

export interface RunTarget {
  readonly baseUrl: string;
  readonly allowedHosts: readonly string[];
  /** What the system under test is called. Declared by a human. */
  readonly label?: string | undefined;
}

/** A node of the tenant tree plus an optional base address of its own. */
export interface TenantConfig extends TenantNode {
  readonly baseUrl?: string;
}

export interface DeclaredSignal {
  readonly name: string;
  readonly kind: "count" | "present";
  readonly path: string;
  /** The endpoints this scalar is computed on. */
  readonly endpoints: readonly string[];
}

/**
 * The part of the body to compare on a set of endpoints.
 *
 * One entry per scope, and an endpoint may appear in only one of them: two
 * scopes for one endpoint would be two answers to a question that has one.
 */
export interface CompareSubtree {
  /** The endpoints this scope applies to. Each must be one whose bodies are compared. */
  readonly endpoints: readonly string[];
  /** A dotted path into the parsed body, in the syntax `parseSignalPath` states. */
  readonly path: string;
}

export interface BodySignalsConfig {
  /**
   * The endpoints whose response must differ between tenants.
   *
   * This is the operator's declaration, not a property of the API under test: the
   * tool derives it from nowhere, and without it it does not read the body at all.
   */
  readonly responseMustDifferByTenant: readonly string[];
  readonly maxBodyBytes?: number | undefined;
  readonly signals?: readonly DeclaredSignal[] | undefined;
  /**
   * Where to compare only part of the body. Absent means the whole of it.
   *
   * The envelope is what makes this necessary — see the schema above and
   * ADR-0044.
   */
  readonly compareSubtree?: readonly CompareSubtree[] | undefined;
}

export interface RunConfig {
  /** The default scheme: an account that named none of its own goes by it. */
  readonly auth: AuthScheme;
  /**
   * The scheme per account: account id → the resolved scheme. Empty when there
   * are no overrides.
   *
   * A ready map rather than reference names: references are resolved during
   * parsing, so that a typo fails at startup instead of turning into a run without
   * authentication.
   */
  readonly accountAuth: ReadonlyMap<string, AuthScheme>;
  readonly target: RunTarget;
  readonly accounts: readonly AccountConfig[];
  readonly policy: ExpectedAccessPolicy;
  readonly exclude: readonly string[];
  readonly resources: readonly Resource[];
  readonly bodySignals?: BodySignalsConfig | undefined;
  /** The tenant tree. Absent means a forest of roots with no links between them. */
  readonly tenants?: readonly TenantConfig[] | undefined;
  /** The request conditions. Empty when none are declared. */
  readonly contexts: readonly RequestContextConfig[];
  /**
   * Findings held out of the verdict until a date. Empty when none are declared.
   *
   * The core's shape rather than the declared one: `endpoint` and `context`
   * become `endpointId` and `contextId` here, exactly as a resource's `tenant`
   * becomes `tenantId`. See ADR-0048.
   */
  readonly accepted: readonly Acceptance[];
}

/**
 * The value of an attribute: either a string or a reference to an environment
 * variable.
 *
 * Exactly this form travels into the report, so a secret cannot get there:
 * `{ env: "DEVICE_SIGNATURE" }` names the variable, not the value.
 */
export type ContextAttributeValue = string | { readonly env: string };

/**
 * The declared request conditions.
 *
 * The attributes — headers and query parameters — live here rather than in the
 * core: the core knows nothing about HTTP and must not, the `contextId` label is
 * enough for it.
 */
export interface RequestContextConfig {
  readonly id: string;
  readonly description?: string | undefined;
  readonly headers: Readonly<Record<string, ContextAttributeValue>>;
  /** Literals only: a query value is printed in the report, so it cannot be a secret. */
  readonly query: Readonly<Record<string, string>>;
  /** The endpoints the conditions apply on. Never empty. */
  readonly endpointIds: readonly string[];
  /** The accounts they apply to. Empty means all of them. */
  readonly accountIds: readonly string[];
}

/**
 * One set of conditions as it was written, before `normalizeContexts` converts it.
 *
 * Named rather than spelled out in that function's signature so the tie in
 * `schema.ts` can reach it. This shape is a mirror of a `contexts` entry — the
 * same field names — which is what makes the tie the right thing to ask of it;
 * `RequestContextConfig` above is not, because the conversion renames `endpoints`
 * and `accounts` and turns two optional records into required ones.
 *
 * Not part of the published surface: what a library consumer gets back from
 * `parseRunConfig` is the converted form, and publishing the intermediate one
 * would offer a second answer to the question of what a context is. It is
 * exported from this module and left out of `../config.js`, which is the list
 * that decides.
 */
export interface DeclaredContext {
  readonly id: string;
  readonly description?: string | undefined;
  readonly headers?: Readonly<Record<string, ContextAttributeValue>> | undefined;
  /** A literal: the schema admits no `{ env: … }` here, and the report prints it. */
  readonly query?: Readonly<Record<string, string>> | undefined;
  readonly endpoints: readonly string[];
  readonly accounts?: readonly string[] | undefined;
}

/**
 * One accepted finding as it was written, before the coordinates are renamed.
 *
 * The same arrangement as `DeclaredContext` and for the same reason: `Acceptance`
 * in the core spells the coordinates `endpointId` and `contextId`, so it is not a
 * mirror of this section and equal field names would be the wrong thing to
 * demand of it. This shape is the mirror, and the tie in `schema.ts` is what
 * notices a field added to the schema and carried by nobody.
 */
export interface DeclaredAcceptance {
  readonly endpoint: string;
  readonly relation?: ResourceRelation | undefined;
  readonly context?: string | undefined;
  readonly kind: string;
  readonly reason: string;
  readonly until: string;
  readonly ticket?: string | undefined;
}

/**
 * A resource as it was written, before its coordinates are renamed.
 *
 * The same arrangement as `DeclaredContext` and `DeclaredAcceptance`, and it
 * had to be written down when this module was cut out of the parser: the
 * validated document now crosses a module boundary, and a boundary has to be
 * named by a type that does not come from zod. Naming it tied two shapes that
 * nothing had tied before — this one and `DeclaredTenant` below.
 */
export interface DeclaredResource {
  readonly id: string;
  readonly tenant: string;
  readonly owner?: string | undefined;
  readonly params?: Readonly<Record<string, string>> | undefined;
  readonly query?: Readonly<Record<string, string>> | undefined;
  /** The endpoints the resource belongs to, when the identifier sits in the query. */
  readonly endpoints?: readonly string[] | undefined;
}

/**
 * One node of the tenant tree as it was written.
 *
 * The long form only: the short one is a bare string, and the union of the two
 * is what `DeclaredConfig.tenants` carries.
 */
export interface DeclaredTenant {
  readonly id: string;
  /** The parent. Absent means the root. See ADR-0013. */
  readonly parent?: string | undefined;
  /** A base address of its own. The host must be in `allowedHosts`. */
  readonly baseUrl?: string | undefined;
}

/**
 * The whole document, validated, before any of it is converted.
 *
 * This is what `parseConfigDocument` hands back and what `parseRunConfig`
 * reads. Hand-written for the same reason everything else here is, plus one the
 * others do not have: the type of the validated document is zod's, and a
 * declaration that names zod may not be shipped. The package already refuses one
 * in its own published types — the CI job that reads `dist` for a
 * non-relative import in a `.d.ts` — and this is that rule applied one level
 * in, at the edge of the module that owns the schema.
 *
 * The fields that already had a mirror keep it, so there is one description of
 * an account and not two.
 */
export interface DeclaredConfig {
  readonly target: RunTarget;
  readonly accounts: readonly AccountConfig[];
  readonly policy: ExpectedAccessPolicy;
  readonly exclude?: readonly string[] | undefined;
  readonly resources?: readonly DeclaredResource[] | undefined;
  /** A forest of roots as bare strings, or the long form that declares kinship. */
  readonly tenants?: readonly (string | DeclaredTenant)[] | undefined;
  readonly auth?: AuthScheme | undefined;
  readonly authSchemes?: Readonly<Record<string, AuthScheme>> | undefined;
  readonly contexts?: readonly DeclaredContext[] | undefined;
  readonly accepted?: readonly DeclaredAcceptance[] | undefined;
  readonly bodySignals?: BodySignalsConfig | undefined;
}

/** The resolved attribute values of one set of conditions. */
export interface ContextValues {
  readonly headers: Readonly<Record<string, HeaderValue>>;
  readonly query: Readonly<Record<string, string>>;
}

/**
 * Core domain types.
 *
 * Data only. No HTTP, no file system, no global state —
 * see docs/adr/0002-pure-core-and-json-source-of-truth.md.
 */

import type { TenantHierarchy, TenantNode } from "./tenancy.js";
import { FLAT_HIERARCHY } from "./tenancy.js";

/** Tenant identifier in the platform under test. */
export type TenantId = string;

/** Role identifier in the platform under test. */
export type RoleId = string;

export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";

/**
 * Every method of the domain, as data.
 *
 * A type does not exist at runtime, and four places need the set as values: the
 * two endpoint sources, the OpenAPI parser and the run configuration's schema.
 * Each of them used to write the set out again, and two of those copies were tied
 * to nothing the compiler reads — the audit of 14 August 2026 (B-10). A method
 * added to `HttpMethod` passed both of them by in silence: every operation of
 * that method dropped out of the matrix while coverage went on reporting a
 * hundred percent of what was parsed, and a policy rule naming the method was
 * refused as invalid.
 *
 * `Record<HttpMethod, …>` rather than a list, which is the tie the endpoint
 * sources already used: the type forces every method to be listed.
 * `satisfies readonly HttpMethod[]` cannot do that — it checks that the entries
 * belong to the set, never that the set is covered.
 *
 * The value repeats the key because `Object.keys` hands back plain strings: it is
 * the values that carry the type on to whoever reads the set.
 */
export const HTTP_METHODS: Readonly<Record<HttpMethod, HttpMethod>> = {
  GET: "GET",
  HEAD: "HEAD",
  POST: "POST",
  PUT: "PUT",
  PATCH: "PATCH",
  DELETE: "DELETE",
  OPTIONS: "OPTIONS",
};

/**
 * The methods performed without the explicit `--unsafe-methods` flag.
 *
 * A security invariant: extending this list changes the tool's default behaviour
 * and requires an entry in an ADR.
 */
export const SAFE_METHODS = ["GET", "HEAD"] as const satisfies readonly HttpMethod[];

export type SafeMethod = (typeof SAFE_METHODS)[number];

interface AccountIdentity {
  readonly id: string;
  readonly roleId: RoleId;
  /**
   * The request conditions this account exists in.
   *
   * The minimal useful piece of ABAC: the same account with the same role, but
   * the request is tagged with attributes — an address in another country, a
   * device, KYC not passed. The tool does not model the platform's decision
   * logic, it compares the **outcomes** of two declared sets of conditions.
   *
   * In the core this is only a label: the attributes themselves — request
   * headers and parameters — live in the adapters, because the core knows
   * nothing about HTTP. See ADR-0019.
   *
   * Absence means baseline conditions: a request with no added attributes.
   */
  readonly contextId?: string;
  /**
   * The original account, when this row is that same account under declared
   * conditions.
   *
   * Not decoration for the report but identity: resource ownership is checked
   * against it. While it was missing, `order-a-1001` stopped being **own** for
   * `alice-a@geo-blocked` — the owner on record is `alice-a` — the relation
   * drifted into `same-tenant`, severity rose from medium to high, and the `own`
   * defect group vanished entirely. Found by a cold read of the report.
   */
  readonly baseAccountId?: string;
  /**
   * The endpoints on which the account exists at all. Absence means all of them.
   *
   * Needed by an account under conditions: conditions are declared on specific
   * endpoints, and on the rest such a cell **does not exist**. Without this
   * field they would land in the report as "declared by the policy but not
   * observed" — that is, a hole in coverage where there is no hole.
   */
  readonly endpointIds?: readonly string[];
}

/** An account in a single node of the tenant tree, or outside tenants entirely. */
export interface SingleTenantAccount extends AccountIdentity {
  /**
   * The account's tenant. **Absence means "the account is outside tenants"** —
   * that is an anonymous account.
   *
   * This field cannot be mandatory. An anonymous account would have to invent a
   * tenant, and a reserved name like `none` would sit in the same value space as
   * the real ones: a platform with a tenant that really is called that would
   * silently break the classification — the anonymous account would become a
   * neighbor inside that tenant. Deeper still: an anonymous account has **no**
   * tenant, and making it take part in `relationOf` on equal terms with the rest
   * is wrong in substance, not only in notation.
   */
  readonly tenantId?: TenantId;
  readonly tenantIds?: undefined;
}

/**
 * An account that is a member of several tenants at once, not joined by a subtree.
 *
 * Support staff over two brands of different holdings, an affiliate over some of
 * a group's brands — a case a tree cannot express: such tenants have no common
 * ancestor other than the platform root, and by seating the account at the root
 * you hand it the whole subtree. Reasoning and experiment — ADR-0017.
 */
export interface MultiTenantAccount extends AccountIdentity {
  readonly tenantId?: undefined;
  /** Memberships. The order carries no meaning; computing the relation does not depend on it. */
  readonly tenantIds: readonly TenantId[];
}

/**
 * The account a request is made as.
 *
 * A union rather than two optional fields in one type: "one tenant" and "a set
 * of tenants" are mutually exclusive statements, and the ban on writing both at
 * once is held by the compiler, not by convention. A duplicate the compiler
 * cannot check drifts apart sooner or later — that is exactly how the
 * hand-written list of relations in the configuration schema ended.
 */
export type Account = SingleTenantAccount | MultiTenantAccount;

/**
 * The account's memberships as a single list.
 *
 * An empty list means "outside tenants": an anonymous account has no
 * memberships, and that is a statement, not an omission.
 */
export function tenantIdsOf(account: Account): readonly TenantId[] {
  if (account.tenantIds !== undefined) {
    return account.tenantIds;
  }
  return account.tenantId === undefined ? [] : [account.tenantId];
}

/** An endpoint as a template, with no values substituted. */
export interface Endpoint {
  readonly id: string;
  readonly method: HttpMethod;
  /** The path template, for example `/v1/players/{playerId}`. */
  readonly path: string;
  readonly operationId?: string;
  /**
   * An expectation declared by a human: the response of this endpoint must
   * differ between tenants.
   *
   * The name is imperative on purpose. The former `tenantScoped` read as a
   * property of the API under test ("the endpoint is scoped to a tenant"), which
   * the tool does not know and cannot know: `orders.read` did not have it, even
   * though it is tenant-scoped by its very nature and was exactly the one
   * leaking. What is encoded here is the operator's expectation — the same claim
   * of intent as the access policy (ADR-0006).
   *
   * Never derived: `GET /v1/health`, which returns the same `{"status":"ok"}` to
   * everyone, is legitimate sameness rather than a leak, and without an explicit
   * declaration one cannot be told from the other. See ADR-0011.
   */
  readonly responseMustDifferByTenant?: boolean;
  /**
   * Extra scalars computed over the body of this endpoint.
   *
   * Separate from `responseMustDifferByTenant`: that declaration implies the
   * digest by itself, while these are what a human declared for digging into a
   * finding, not for the finding itself.
   */
  readonly signals?: readonly SignalSpec[];
}

/**
 * The value of a signal computed over a response body.
 *
 * There is no string variant on purpose: a string holds the whole body, and the
 * ban on PII in the report would turn from structural into disciplinary.
 * Extending the type requires an ADR of its own — see ADR-0011.
 */
export type SignalValue = number | boolean;

/**
 * What to compute over the body. Declared by a human, not derived.
 *
 * `digest` carries an optional `path`: the part of the body to compare, instead
 * of the whole of it. Without it the digest is over the raw bytes, which is what
 * ADR-0011 introduced and what real list endpoints defeat — a response wrapped
 * in an envelope with a `requestId` or a `generatedAt` differs on every request,
 * so two bodies carrying **both** tenants' records got different digests and the
 * check found nothing. The path is a human's declaration like every other one in
 * this model, never read off a response: deriving it would mean picking the
 * fields that happen to agree, which is choosing the answer. See ADR-0044.
 */
export type SignalSpec =
  | { readonly name: string; readonly kind: "digest"; readonly path?: string }
  | { readonly name: string; readonly kind: "count"; readonly path: string }
  | { readonly name: string; readonly kind: "present"; readonly path: string };

/**
 * Whether a value can stand in for a path parameter.
 *
 * Three cannot, and they are the same three everywhere a path is assembled: an
 * empty string, `.` and `..`. Substituted into a template they are not
 * identifiers but navigation — `/v1/orders/{orderId}` with `.` becomes
 * `/v1/orders/`, which is a different endpoint.
 *
 * `encodeURIComponent` is no defence: a dot is unreserved and comes through
 * untouched. Nor is the scope guard when the address is assembled, because
 * nothing left the base path — the request simply went somewhere else inside it.
 *
 * In the core, and not beside either place that needs it, because both do: the
 * configuration refuses such a value at startup, and the walk refuses to build
 * an address from one for whoever assembles resources through the library.
 */
export function isUsablePathSegment(value: string): boolean {
  // A separator in the value is refused rather than escaped. `encodeURIComponent`
  // turns `/` into `%2F` and `\` into `%5C`, which this side then treats as one
  // ordinary segment — and Spring with `urlDecode` on, or Tomcat with
  // `ALLOW_ENCODED_SLASH`, decodes it back before routing. So `../../admin` in a
  // resource value arrived as `..%2F..%2Fadmin`, passed the seam and reached a
  // different endpoint, past an exclusion list that works on ids.
  //
  // The template grammar in `io/untrusted.ts` already reads the percent-encoded
  // spellings for exactly this reason; the value grammar did not, and the two
  // halves of one rule disagreed. Found by the audit of 20 August 2026 (A-2).
  if (value.includes("/") || value.includes("\\")) {
    return false;
  }
  return value !== "" && value !== "." && value !== "..";
}

/**
 * The resource being requested: parameter values plus the owner.
 *
 * Declared by a human rather than fished out of responses — the reasoning is in
 * ADR-0010. The statement "resource 1001 belongs to player A" is a claim of
 * intent, exactly like the access policy itself.
 */
export interface Resource {
  readonly id: string;
  readonly tenantId: TenantId;
  /** The owning account. Absent when the resource belongs to the tenant as a whole. */
  readonly ownerAccountId?: string;
  /**
   * Values for the path parameters, by the names in the template.
   *
   * Every value is a segment, never navigation: see {@link isUsablePathSegment}.
   */
  readonly params: Readonly<Record<string, string>>;
  /** Query string parameters. */
  readonly query?: Readonly<Record<string, string>>;
  /**
   * The endpoints the resource applies to.
   *
   * Needed when the identifier sits in the query string rather than in the path:
   * such an endpoint has no parameters in its template, and it cannot be tied to
   * a resource by matching names. Recon on crAPI showed that a whole BOLA is
   * built that way (`mechanic_report?report_id=N`).
   *
   * Absence means "by matching path parameters".
   */
  readonly endpointIds?: readonly string[];
}

/**
 * Every relation in one list — the **source of truth**.
 *
 * The type is derived from here rather than declared separately. The reason is
 * concrete: the configuration parsing schema kept a hand-written duplicate of
 * this list, it drifted from the type when the hierarchy was introduced, and
 * `scope: descendant-tenant` was rejected at startup — that is, the capability
 * existed in the core and was unreachable through the CLI. A duplicate the
 * compiler cannot check drifts apart sooner or later.
 */
export const RESOURCE_RELATIONS = [
  /** The owner of the resource is the account itself. */
  "own",
  /** Same tenant, different owner: BOLA inside a tenant lands here. */
  "same-tenant",
  /** The resource is lower in the tree: a holding reads its own brand. Usually allowed. */
  "descendant-tenant",
  /** The resource is higher in the tree: a brand reads the holding level. Usually not allowed. */
  "ancestor-tenant",
  /** No kinship at all: a different holding. Never allowed. */
  "foreign-tenant",
] as const;

/**
 * The account's relation to the resource.
 *
 * More than a flag on purpose: a tenant administrator is usually meant to have
 * access to every resource of their own tenant and to none of anyone else's,
 * and a single "not own" flag cannot express that.
 *
 * Five-valued, and the count is the history. Three said as much as a flat world
 * has to say — `own`, `same-tenant`, `foreign-tenant` — and the tenant hierarchy
 * of ADR-0013 exists precisely against that state: with three values a holding
 * reading its own brand and a holding reading a stranger's were both "foreign",
 * so the one relation a platform is usually meant to allow and the one it must
 * never allow were the same answer. `descendant-tenant` and `ancestor-tenant`
 * are that answer split. The list above is where they are written; this type is
 * derived from it rather than declared beside it.
 */
export type ResourceRelation = (typeof RESOURCE_RELATIONS)[number];

/**
 * Who is really making the request: a matrix row can be an account under conditions.
 *
 * A function of its own, because three places ask this — the relation, the
 * credentials, the report — and three `?? account.id` written apart would drift.
 */
export function principalOf(account: Account): string {
  return account.baseAccountId ?? account.id;
}

/**
 * Determines the account's relation to the resource.
 *
 * Without a tenant tree (`FLAT_HIERARCHY`) it answers exactly as it did before
 * ADR-0013: `descendant` and `ancestor` never arise, and any two different
 * tenants are foreign.
 *
 * For an account with a set of memberships the relation is computed for **every**
 * membership, and the nearest of the results wins, in the same order as the
 * checks below. ADR-0017 deliberately introduces no sixth value: a set is a
 * property of the account, not a new kind of kinship, and an extra value would
 * silently narrow the existing rules (see the comment about an account outside
 * tenants). On a set of one element the result matches the previous one byte for
 * byte.
 */
export function relationOf(
  account: Account,
  resource: Resource,
  hierarchy: TenantHierarchy = FLAT_HIERARCHY,
): ResourceRelation {
  // An account outside tenants (anonymous) is foreign to every resource. None of
  // the other relations fits it by construction: ownership is a relation inside
  // a tenant, being a neighbor inside a tenant requires a tenant, and there is
  // no kinship along the tree, because there is no node to count it from. That
  // leaves `foreign-tenant`, which ADR-0013 defines as "no kinship at all" — an
  // account without a tenant satisfies that definition more strictly than every
  // other one, rather than being an exception to it.
  //
  // A sixth value (something like `no-tenant`) is deliberately not introduced,
  // and not only because five is already five ways to miss in a policy. It would
  // silently narrow the existing rules: `scope: foreign-tenant`, written to mean
  // "an outsider must not", would stop covering the anonymous account, the cell
  // would fall through to `fallback`, and `severityOf` would lower an
  // unauthenticated read from `critical` to `high`. That is exactly the way of
  // hiding a finding that ADR-0013 was written against.
  //
  // The check comes first, before the owner comparison: an account without a
  // tenant cannot own a resource of a tenant, and `own` must not arise here even
  // when the `owner` field has a typo.
  const memberships = tenantIdsOf(account);
  if (memberships.length === 0) {
    return "foreign-tenant";
  }
  if (memberships.includes(resource.tenantId)) {
    // By the original account, not by the matrix row: request conditions do not
    // cancel ownership — what changes is the request, not who makes it.
    return resource.ownerAccountId === principalOf(account) ? "own" : "same-tenant";
  }
  if (memberships.some((membership) => hierarchy.isAncestor(membership, resource.tenantId))) {
    return "descendant-tenant";
  }
  if (memberships.some((membership) => hierarchy.isAncestor(resource.tenantId, membership))) {
    return "ancestor-tenant";
  }
  return "foreign-tenant";
}

/** How the request ended from the point of view of access. */
export type AccessOutcome = "allowed" | "denied" | "not-found" | "error";

/**
 * The observed result of one request.
 *
 * The response body is absent on purpose: it holds client PII. In its place come
 * `signals` — irreversible scalars computed over the body that do not allow it
 * to be reconstructed. The bounds of that relaxation are set in ADR-0011;
 * `SignalValue` must not be extended with a string or an object without an ADR
 * of its own.
 */
export interface AccessObservation {
  readonly endpointId: string;
  readonly accountId: string;
  /** The resource being requested. Absent on endpoints without parameters. */
  readonly resourceId?: string;
  readonly status: number;
  /**
   * The response headers, kept by allowlist and otherwise redacted.
   *
   * Optional, because nothing in `src/core` reads them: they travel through the
   * matrix to reach the report, where one line puts them on a finding. Required,
   * they were the core demanding data on another layer's behalf — and a consumer
   * feeding observations from their own harness, which is what the README
   * invites, had to write `headers: {}` on every row. That empty object is not
   * cheap: it says "the response carried no headers we keep", when the truth is
   * that nobody recorded any. Absent says the second thing, which is the true
   * one. Found by the audit of 14 August 2026 (E-8).
   */
  readonly headers?: Readonly<Record<string, string>>;
  readonly outcome: AccessOutcome;
  /**
   * How long the request took.
   *
   * Optional for the same reason, and more so: no code anywhere reads it. The
   * runner writes it and the report carries it into the file, where it is for a
   * person looking at a row and wondering whether a denial came back instantly
   * or after a timeout. That is worth keeping and is not worth requiring of
   * somebody who has no clock in their harness.
   */
  readonly durationMs?: number;
  /**
   * The moment of the request, ISO-8601.
   *
   * Without it there is nothing to match the finding against the platform's log:
   * a run has a start and an end, while a cell has only a duration. The first
   * thing the team that receives the ticket will ask is "when was this". Found
   * by the third cold read of the report.
   */
  readonly at?: string;
  /**
   * What exactly was sent: the method and the address with values substituted.
   *
   * Without this a finding cannot be reproduced: the reader has to glue the path
   * together from the endpoint, the parameters from the resource, and guess at
   * the base address. There are no credentials here — they are forbidden in
   * `baseUrl` — and the parameter values were declared by a human rather than
   * taken from a response.
   */
  readonly method?: HttpMethod;
  readonly url?: string;
  /**
   * Scalars computed over the body. The body itself is stored nowhere — ADR-0011.
   */
  readonly signals?: Readonly<Record<string, SignalValue>>;
}

/** The observed access matrix: who went where and with what result. */
export interface AccessMatrix {
  readonly endpoints: readonly Endpoint[];
  readonly accounts: readonly Account[];
  readonly resources: readonly Resource[];
  readonly observations: readonly AccessObservation[];
  /**
   * The tenant tree. Absence means a forest of roots with no links, that is, the
   * behaviour from before ADR-0013.
   */
  readonly tenants?: readonly TenantNode[];
}

export type Severity = "info" | "low" | "medium" | "high" | "critical";

/**
 * The expected outcome is binary.
 *
 * The observed outcome is richer (`not-found`, `error`), but declaring "I expect
 * a 404" is meaningless: the intent is whether access exists or not. Reducing
 * the observed one to the expected one is the diff's job. See ADR-0006.
 */
export type ExpectedOutcome = "allowed" | "denied";

/**
 * Every kind of matrix discrepancy in one list — the **source of truth**.
 *
 * The same shape as `RESOURCE_RELATIONS` above and for a reason of its own. The
 * matrix channel cites clauses of external standards (ADR-0041), and the
 * question "which clauses can this channel ever cite" is answered by asking
 * `standardsForDiff` about every kind there is. That answer is only as complete
 * as the list it iterates, so the list has to be the union rather than a copy of
 * it: a fifth kind added here is in the enumeration whether or not anybody
 * remembered, and one added to a union with the list written out separately
 * would leave a clause quietly reading as answered by nothing. See ADR-0069.
 *
 * ADR-0064 rejected `satisfies readonly DiffKind[]` on an array for the half it
 * does not hold — a member of the union left out of the array still compiles.
 * Deriving the union from the array is the spelling that has no second half to
 * lose, and it leaves the `Record<DiffKind, …>` tables that ADR chose exactly as
 * they are.
 */
export const DIFF_KINDS = [
  /** A denial was expected, access was granted. The tool's main finding. */
  "privilege-escalation",
  /**
   * Access was expected, a denial came back. Not a vulnerability, but a
   * discrepancy with the intent.
   */
  "unexpected-denial",
  /**
   * The "account × endpoint" pair is not covered by observations — no conclusion
   * can be drawn.
   */
  "not-observed",
  /** The request ended in an error: access cannot be judged. */
  "probe-error",
] as const;

/**
 * The nature of the discrepancy between intent and implementation.
 *
 * Derived from the list above rather than declared beside it, exactly as
 * `ResourceRelation` is.
 */
export type DiffKind = (typeof DIFF_KINDS)[number];

/** A discrepancy between expected and observed access. */
export interface AccessDiff {
  readonly accountId: string;
  readonly endpointId: string;
  /**
   * The request conditions. Absence means baseline, with no added attributes.
   *
   * A discrepancy under conditions and the same one in the baseline are
   * different findings: the platform may close an endpoint correctly and break
   * only when the country is substituted.
   */
  readonly contextId?: string;
  /** The resource being requested. Absent on endpoints without parameters. */
  readonly resourceId?: string;
  /** The account's relation to the resource. Absent together with the resource. */
  readonly relation?: ResourceRelation;
  readonly expected: ExpectedOutcome;
  /** Absent when there is no observation for the pair. */
  readonly actual?: AccessOutcome;
  readonly kind: DiffKind;
  /**
   * What declared the expectation: a rule of the policy, or the fallback.
   *
   * Written by `diffAccess` on every discrepancy since the cell verdicts were
   * introduced, and declared here only from 17 August 2026 — so a consumer of
   * the library could not read `finding.basis` without the compiler refusing a
   * field that was in the value all along. The same family as B-12, one layer
   * down: a shape described in two places, where the copy that describes it to
   * everyone else went stale.
   *
   * The reason it exists at all: absence of `ruleIndex` cannot be told from a
   * field the tool failed to fill in, so "the fallback decided this" is said in
   * a field rather than inferred from a hole.
   */
  readonly basis?: "rule" | "fallback";
  /**
   * The policy rule that declared the expectation. Present only when `basis` is
   * `rule`; absence means the fallback answered, which is a decision and not an
   * omission.
   */
  readonly ruleIndex?: number;
  /**
   * Computed from the kind of discrepancy and the relation, not declared by a
   * human.
   *
   * A human declares the expectation — what is meant to be allowed and what is
   * not. Severity is a property of the discrepancy already found: a leak into a
   * foreign tenant is plainly heavier than access to someone else's resource
   * inside one's own. See ADR-0014.
   */
  readonly severity: Severity;
}

/** The severity of a discrepancy. The table and the reasoning — ADR-0014. */
export function severityOf(kind: DiffKind, relation?: ResourceRelation): Severity {
  if (kind === "not-observed" || kind === "probe-error") {
    return "low";
  }
  if (kind === "unexpected-denial") {
    return "medium";
  }
  if (relation === "foreign-tenant") {
    return "critical";
  }
  // Access to one's own resource, declared forbidden, is almost always a mistake
  // in the policy rather than a hole in the platform. A false alarm at high here
  // would cost more than lowering it.
  if (relation === "own") {
    return "medium";
  }
  return "high";
}

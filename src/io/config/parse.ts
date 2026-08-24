/**
 * The document becomes a `RunConfig`.
 *
 * Everything here needs nothing but the configuration file itself, which is what
 * separates it from `references.ts`: those checks need the endpoint list, these
 * are answerable the moment the document is read. That matters beyond tidiness —
 * parsing is the one gate a library consumer cannot walk past, so a rule that can
 * be asked here is asked here.
 *
 * The conversions are all of one kind: a coordinate written for a human becomes
 * the one the core uses. `tenant` becomes `tenantId`, `endpoint` becomes
 * `endpointId`, the short form of a tenant expands, and a scheme reference is
 * resolved to the scheme.
 */

import type { AuthScheme } from "../../adapters/credentials.js";
import { assertAuthSchemeIsSound, DEFAULT_AUTH_SCHEME } from "../../adapters/credentials.js";
import type { Acceptance, ExpectedAccessPolicy, Resource } from "../../core/index.js";
import {
  acceptanceKeyOf,
  assertIndependentMemberships,
  assertPolicyIsSound,
  BODY_OVER_LIMIT_SIGNAL,
  citableDefectKey,
  createTenantHierarchy,
  DEFAULT_DIGEST_SIGNAL,
  DIGEST_SCOPE_MISSING_SIGNAL,
  describeAcceptance,
  FLAT_HIERARCHY,
  isUsablePathSegment,
} from "../../core/index.js";
import { FORBIDDEN_QUERY_KEYS, ForbiddenResourceQueryError, WRITE_METHOD_WORDS } from "./basis.js";
import { normalizeContexts } from "./contexts.js";
import { parseConfigDocument } from "./schema.js";
import type { AccountConfig, RunConfig, TenantConfig } from "./types.js";

/**
 * A scope declared for an endpoint whose bodies are never compared.
 *
 * The digest exists only where `responseMustDifferByTenant` says so — that
 * declaration is what makes the body be read at all. A scope on any other
 * endpoint therefore scopes nothing, and it fails in the worst way available: the
 * operator believes the envelope is being skipped, the run goes on comparing
 * whole bodies, and every `requestId` in the response keeps the check silent.
 * Nothing in the report would contradict them.
 *
 * Refused rather than ignored, for the same reason `ReservedSignalNameError` is:
 * a declaration that quietly does nothing is the failure this tool exists to
 * find, arriving through its own configuration file. See ADR-0044.
 */
export class CompareSubtreeWithoutComparisonError extends Error {
  constructor(endpointId: string) {
    super(
      `compareSubtree names endpoint "${endpointId}", which is not under ` +
        `responseMustDifferByTenant. No digest is computed there, so the scope would ` +
        `scope nothing and the declaration would be silently dead. Add the endpoint to ` +
        `responseMustDifferByTenant, or drop it from compareSubtree.`,
    );
    this.name = "CompareSubtreeWithoutComparisonError";
  }
}

/**
 * Two scopes for one endpoint.
 *
 * One endpoint yields one digest, so the second declaration could only replace
 * the first or be dropped, and both readings are defensible — which is exactly
 * why the operator has to say which they meant. Left to a rule, this is a
 * configuration whose meaning depends on the order of two lines in a file.
 */
export class DuplicateCompareSubtreeError extends Error {
  constructor(endpointId: string) {
    super(
      `Endpoint "${endpointId}" is named by more than one compareSubtree entry. One ` +
        `endpoint produces one digest, so a second scope for it would either replace the ` +
        `first or be dropped, and the file would not say which.`,
    );
    this.name = "DuplicateCompareSubtreeError";
  }
}

/**
 * The name the tool computes for itself is not available to a declaration.
 *
 * Found by the audit of 14 August. One line — a declared signal named `digest`
 * on an endpoint marked `responseMustDifferByTenant` — turned eighteen
 * cross-tenant findings into zero while `coverage.checksRun` went on saying the
 * check had run. With `kind: count` the mirror image: sixteen fabricated
 * findings on a healthy platform.
 *
 * Neither direction announced itself. That is the exact failure this tool exists
 * to prevent, reachable from a configuration file, so the name is refused rather
 * than resolved: an operator who wanted a scalar of their own gets to rename it,
 * and nobody gets a report that lies in silence.
 */
export class ReservedSignalNameError extends Error {
  constructor(name: string) {
    super(
      `Signal name "${name}" is reserved: the tool computes a signal of that name ` +
        `itself on every endpoint declared under responseMustDifferByTenant, and ` +
        `the tenant-isolation check reads it. A declared signal with this name ` +
        `would take its place — the check would then compare something else, or ` +
        `stop comparing altogether, and the report would say neither. Pick ` +
        `another name.`,
    );
    this.name = "ReservedSignalNameError";
  }
}

/**
 * A kind of finding an acceptance may not be written for.
 *
 * `not-observed` and `probe-error` are the two kinds that say nothing about the
 * platform: the first means no request covered the cell, the second that the
 * request did not come back. Accepting either is accepting "we did not look",
 * and for `probe-error` it is worse than that — half a matrix failing to answer
 * is the exit code 2 that says the report describes the state of the network
 * rather than of the platform, and that conclusion must not be purchasable from
 * a configuration file.
 *
 * Neither is a thing an operator needs to accept, which is what makes the rule
 * cheap: `not-observed` is `low` and fails no run, and `probe-error` fails one
 * only at half the matrix, where the run is telling the truth.
 */
export class UnacceptableFindingKindError extends Error {
  constructor(where: string, kind: string) {
    super(
      `${where} is written for kind "${kind}", which says nothing about the platform: ` +
        `it says the run did not reach the cell, or that the cell did not answer. ` +
        `Accepting it would accept "we did not look" — and for probe errors it would ` +
        `buy the exit code 2 that reports a broken deployment. Fix the reach of the ` +
        `run instead: coverage.notProbed and failures[] say what stopped it.`,
    );
    this.name = "UnacceptableFindingKindError";
  }
}

/**
 * Two acceptances naming one defect and one kind.
 *
 * They carry different reasons and different deadlines, so which of them applies
 * decides when the finding comes back — and either resolution would be a silent
 * choice made for the operator. The same objection as two `compareSubtree`
 * scopes on one endpoint.
 */
export class DuplicateAcceptanceError extends Error {
  constructor(where: string, defect: string, kind: string) {
    super(
      `${where} names the defect "${defect}" and kind "${kind}", which an earlier ` +
        `entry already names. Two acceptances of one finding carry two deadlines, and ` +
        `which one holds would decide when the finding comes back — the file has to ` +
        `say, rather than the order of two lines in it.`,
    );
    this.name = "DuplicateAcceptanceError";
  }
}

/**
 * An acceptance written for conditions that are not declared.
 *
 * A defect under conditions and the same defect in the baseline are different
 * findings — the whole reason `contextId` is part of the signature — so a typo
 * here does not widen the acceptance, it empties it. The operator believes a
 * finding is held and it is not; the run fails for a reason the file appears to
 * have answered.
 */
export class UnknownAcceptanceContextError extends Error {
  constructor(where: string, contextId: string, declared: readonly string[]) {
    super(
      `${where} names context "${contextId}", which is not declared. ` +
        `Declared: ${declared.length === 0 ? "none" : declared.join(", ")}. ` +
        `Conditions are part of a defect's identity, so this acceptance would match ` +
        `no finding at all — leave the field out to accept the baseline defect.`,
    );
    this.name = "UnknownAcceptanceContextError";
  }
}

/** Whether the address's host is in scope. An entry with a port is matched with it. */
function hostAllowed(url: URL, allowedHosts: readonly string[]): boolean {
  const allowed = allowedHosts.map((entry) => entry.trim().toLowerCase());
  return allowed.includes(url.hostname.toLowerCase()) || allowed.includes(url.host.toLowerCase());
}

export class HostOutsideScopeError extends Error {
  constructor(host: string, allowedHosts: readonly string[]) {
    super(
      `Host "${host}" from baseUrl is not in allowedHosts (${allowedHosts.join(", ")}). ` +
        `The scope is declared explicitly: a typo in an address must not widen it.`,
    );
    this.name = "HostOutsideScopeError";
  }
}

export class CredentialsInUrlError extends Error {
  constructor(where = "baseUrl") {
    super(
      `${where} carries a login and password. Credentials are passed only through ` +
        "environment variables: the address is copied into the report verbatim, " +
        "and the report goes to stdout by default.",
    );
    this.name = "CredentialsInUrlError";
  }
}

export class DuplicateAccountIdError extends Error {
  constructor(id: string) {
    super(`An account with id "${id}" is declared more than once`);
    this.name = "DuplicateAccountIdError";
  }
}

/**
 * A reference to a scheme that was never declared.
 *
 * It fails at startup on purpose. An account with an unresolved reference would go
 * by the default scheme, the platform would answer 401 — and a blanket denial
 * agrees with the policy wherever access is not meant to be granted. The report
 * would come out clean, and that cleanliness would mean 'we did not present
 * ourselves', not 'there are no holes'. A canary would catch this, but a canary is
 * optional, whereas a typo is not.
 */
export class UnknownAuthSchemeError extends Error {
  constructor(accountId: string, name: string, known: readonly string[]) {
    super(
      `Account "${accountId}" references authentication scheme "${name}", which is not ` +
        `declared in authSchemes ` +
        `(${known.length === 0 ? "none are declared" : known.join(", ")}). ` +
        `A typo here hides the result: the account would run with someone else's scheme, ` +
        `get 401 everywhere, and a blanket denial agrees with the policy wherever access ` +
        `is not meant to be granted — so the report would come out clean.`,
    );
    this.name = "UnknownAuthSchemeError";
  }
}

/**
 * A declared scheme nobody refers to.
 *
 * The same class as an endpoint pattern that matched nothing: a declaration that
 * never applied looks like a tested statement without being one. In practice it is
 * a forgotten `authScheme` on an account — that is, exactly the case where the run
 * goes through the wrong surface and says nothing about it.
 */
export class UnusedAuthSchemeError extends Error {
  constructor(name: string) {
    super(
      `Authentication scheme "${name}" is declared, but no account references it. ` +
        `Most likely an account is missing its authScheme: it will fall back to the ` +
        `default scheme, get 401 — and the run will say nothing. A dead declaration ` +
        `looks like a tested statement without being one.`,
    );
    this.name = "UnusedAuthSchemeError";
  }
}

/**
 * A scheme on an account that has nothing to present.
 *
 * An account without `tokenEnv` makes its requests anonymously, and a scheme does
 * not apply to it: there is nothing to put into the header. That is harmless in
 * itself, but the reference 'uses' the scheme, and a real account of the same
 * surface whose `authScheme` was forgotten stops being visible to the check for an
 * unused scheme.
 */
export class AuthSchemeWithoutTokenError extends Error {
  constructor(accountId: string, name: string) {
    super(
      `Account "${accountId}" references scheme "${name}" but names no tokenEnv. ` +
        `An account without a token calls anonymously, so the scheme has nothing to ` +
        `present: either tokenEnv is missing, or the scheme reference is redundant.`,
    );
    this.name = "AuthSchemeWithoutTokenError";
  }
}

export class DuplicateResourceIdError extends Error {
  constructor(id: string) {
    super(`A resource with id "${id}" is declared more than once`);
    this.name = "DuplicateResourceIdError";
  }
}

/**
 * A path parameter whose value is not a segment.
 *
 * Found by the audit of 14 August. `params: { orderId: "." }` on the template
 * `/v1/orders/{orderId}` produced a request to `/v1/orders/` — the **list**
 * endpoint, which the configuration had put in `exclude`. Two things broke at
 * once: the exclusion list, which exists precisely for addresses that must not
 * be touched, and the verdict, which was computed for `orders.read` from an
 * answer that `orders.list` gave.
 *
 * `encodeURIComponent` does not catch it: a dot is unreserved, so it survives
 * encoding and then works as navigation. The scope guard in `joinUrl` does not
 * either, and cannot — this is not a request leaving the base path but a request
 * addressing a different endpoint inside it.
 *
 * Refused at parsing: a resource identifier is written by a human, and none of
 * these three is ever a real one.
 */
export class UnusablePathParameterError extends Error {
  constructor(resourceId: string, name: string, value: string) {
    const shown = value === "" ? "an empty string" : `"${value}"`;
    super(
      `Resource "${resourceId}" gives path parameter "${name}" ${shown}, which is ` +
        `not an identifier but a piece of path navigation. Substituted into a ` +
        `template it changes which endpoint is addressed: the request goes to a ` +
        `neighbouring address, the exclusion list is bypassed, and the verdict is ` +
        `computed for the endpoint that was declared rather than the one that ` +
        `answered.`,
    );
    this.name = "UnusablePathParameterError";
  }
}

export class UnknownResourceOwnerError extends Error {
  constructor(resourceId: string, owner: string) {
    super(
      `Resource "${resourceId}" is declared as owned by account "${owner}", which is ` +
        `not among the declared accounts. The 'own or foreign' relation would be undefined.`,
    );
    this.name = "UnknownResourceOwnerError";
  }
}

export class UnknownTenantError extends Error {
  constructor(where: string, tenant: string, known: readonly string[]) {
    super(
      `${where} belongs to tenant "${tenant}", which is not among the declared ones ` +
        `(${known.join(", ")}). A typo here hides a finding: the resource drifts ` +
        `into 'foreign tenant', a rule with a scope stops applying, and a real ` +
        `leak falls through to the fallback.`,
    );
    this.name = "UnknownTenantError";
  }
}

/**
 * Resolves accounts' references to named authentication schemes.
 *
 * All three errors are about the same thing: a run that goes through the wrong
 * surface looks not like a failure but like a clean report. That is why they fail
 * here, before the first request.
 *
 * @throws {InvalidAuthSchemeError} the scheme cannot be sent
 * @throws {UnknownAuthSchemeError} the reference does not resolve
 * @throws {UnusedAuthSchemeError} the scheme is declared but not used
 * @throws {AuthSchemeWithoutTokenError} a scheme on an account without a token
 */
function resolveAccountAuth(
  declared: Readonly<Record<string, AuthScheme>> | undefined,
  accounts: readonly {
    readonly id: string;
    readonly tokenEnv?: string | undefined;
    readonly authScheme?: string | undefined;
  }[],
): ReadonlyMap<string, AuthScheme> {
  // A map, not indexing into an object: `authScheme: constructor` on a plain
  // object would return an inherited property instead of `undefined`, and the
  // reference would 'resolve' to whatever came back.
  const schemes = new Map<string, AuthScheme>(Object.entries(declared ?? {}));
  for (const [name, scheme] of schemes) {
    assertAuthSchemeIsSound(scheme, `scheme "${name}"`);
  }

  const resolved = new Map<string, AuthScheme>();
  const used = new Set<string>();
  for (const account of accounts) {
    if (account.authScheme === undefined) {
      continue;
    }
    const scheme = schemes.get(account.authScheme);
    if (scheme === undefined) {
      throw new UnknownAuthSchemeError(account.id, account.authScheme, [...schemes.keys()]);
    }
    if (account.tokenEnv === undefined) {
      throw new AuthSchemeWithoutTokenError(account.id, account.authScheme);
    }
    used.add(account.authScheme);
    resolved.set(account.id, scheme);
  }

  for (const name of schemes.keys()) {
    if (!used.has(name)) {
      throw new UnusedAuthSchemeError(name);
    }
  }

  return resolved;
}

/**
 * Parses and validates the configuration.
 *
 * @param source the text of the file, in YAML or JSON
 * @throws {ConfigParseError} the document does not parse
 * @throws {ConfigValidationError} the document does not match the schema
 * @throws {HostOutsideScopeError} the host from baseUrl is outside allowedHosts
 * @throws {DuplicateAccountIdError} a repeated account id
 * @throws {UnknownAuthSchemeError} an account references an undeclared scheme
 * @throws {UnusedAuthSchemeError} a declared scheme is used by nobody
 * @throws {AuthSchemeWithoutTokenError} a scheme on an account without tokenEnv
 */
export function parseRunConfig(source: string): RunConfig {
  const config = parseConfigDocument(source);

  const seen = new Set<string>();
  for (const account of config.accounts) {
    if (seen.has(account.id)) {
      throw new DuplicateAccountIdError(account.id);
    }
    seen.add(account.id);
  }

  // Here rather than beside the duplicate-name check in assertReferencesResolve:
  // this one needs nothing but the configuration, and parsing is the one gate a
  // library consumer cannot walk past.
  for (const signal of config.bodySignals?.signals ?? []) {
    if (signal.name === BODY_OVER_LIMIT_SIGNAL) {
      throw new ReservedSignalNameError(signal.name);
    }
    if (signal.name === DEFAULT_DIGEST_SIGNAL) {
      throw new ReservedSignalNameError(signal.name);
    }
    if (signal.name === DIGEST_SCOPE_MISSING_SIGNAL) {
      throw new ReservedSignalNameError(signal.name);
    }
  }

  // A scope on an endpoint whose bodies nobody compares is a line that reads as
  // a decision and does nothing, and a second scope on one endpoint is two
  // answers to one question. Here rather than in the schema because both are
  // statements about how two sections of the file relate, which zod sees one
  // field at a time — and here rather than in `assertReferencesResolve` because
  // neither needs to know what endpoints exist.
  const compared = new Set(config.bodySignals?.responseMustDifferByTenant ?? []);
  const scoped = new Set<string>();
  for (const subtree of config.bodySignals?.compareSubtree ?? []) {
    for (const endpointId of subtree.endpoints) {
      if (!compared.has(endpointId)) {
        throw new CompareSubtreeWithoutComparisonError(endpointId);
      }
      if (scoped.has(endpointId)) {
        throw new DuplicateCompareSubtreeError(endpointId);
      }
      scoped.add(endpointId);
    }
  }

  const accountAuth = resolveAccountAuth(config.authSchemes, config.accounts);

  // Whitespace around a tenant name is always a typo, and a dangerous one:
  // 'tenant-a ' and 'tenant-a' give different relations and different verdicts.
  //
  // The short form (a list of strings) means a forest of roots with no links —
  // the behaviour before ADR-0013. The long form declares kinship explicitly.
  const tenantNodes: readonly TenantConfig[] | undefined = config.tenants?.map((entry) =>
    typeof entry === "string"
      ? { id: entry.trim() }
      : {
          id: entry.id.trim(),
          ...(entry.parent === undefined ? {} : { parentId: entry.parent.trim() }),
          ...(entry.baseUrl === undefined ? {} : { baseUrl: entry.baseUrl }),
        },
  );
  // The tree is built here so that an unknown parent and a cycle fail at startup
  // rather than in the middle of a run against someone else's deployment.
  const hierarchy = tenantNodes === undefined ? FLAT_HIERARCHY : createTenantHierarchy(tenantNodes);
  if (tenantNodes !== undefined) {
    for (const node of tenantNodes) {
      if (node.baseUrl === undefined) {
        continue;
      }
      const url = new URL(node.baseUrl);
      if (url.username !== "" || url.password !== "") {
        throw new CredentialsInUrlError(`The base address of tenant "${node.id}"`);
      }
      // There is one scope per run: a tenant's address does not widen it.
      if (!hostAllowed(url, config.target.allowedHosts)) {
        throw new HostOutsideScopeError(url.host, config.target.allowedHosts);
      }
    }
  }
  const declaredTenants = tenantNodes?.map((node) => node.id);
  // The account's memberships as one list: an ordinary account has zero or one of
  // them, an account with a set has several. Every check downstream walks that
  // list, so the 'set' case does not get a branch of its own in each of them.
  const membershipsOf = (account: AccountConfig): readonly string[] =>
    account.tenants?.map((tenant) => tenant.trim()) ??
    (account.tenant === undefined ? [] : [account.tenant.trim()]);
  // An account without a tenant takes no part in the check and needs no entry in
  // the list: it is declared outside of tenants, not assigned to one of them.
  // Demanding a line in `tenants` for it would bring the sentinel back through the
  // back door.
  const accountTenants = config.accounts.flatMap(membershipsOf);
  for (const account of config.accounts) {
    const memberships = membershipsOf(account);
    if (declaredTenants !== undefined) {
      for (const tenant of memberships) {
        if (!declaredTenants.includes(tenant)) {
          throw new UnknownTenantError(`Account "${account.id}"`, tenant, declaredTenants);
        }
      }
    }
    // A repeat and nesting inside a set change the relation silently — see
    // ADR-0017. The check runs after the names are verified: on an unknown tenant
    // nesting is undefined anyway, and it is clearer to speak about the name.
    assertIndependentMemberships(`Account "${account.id}"`, memberships, hierarchy);
  }

  // Checked here rather than on the first request: a run must fail before it
  // reaches the network.
  const target = new URL(config.target.baseUrl);
  if (target.username !== "" || target.password !== "") {
    throw new CredentialsInUrlError();
  }
  // An entry with a port is matched together with the port — the same logic as in
  // the HTTP client. The configuration used to understand only the name, and the
  // client's capability was unreachable through the CLI.
  if (!hostAllowed(target, config.target.allowedHosts)) {
    throw new HostOutsideScopeError(target.host, config.target.allowedHosts);
  }

  const policy: ExpectedAccessPolicy = config.policy;
  assertPolicyIsSound(policy);

  const resources: Resource[] = [];
  const resourceIds = new Set<string>();
  for (const declared of config.resources ?? []) {
    if (resourceIds.has(declared.id)) {
      throw new DuplicateResourceIdError(declared.id);
    }
    resourceIds.add(declared.id);
    if (declared.owner !== undefined && !seen.has(declared.owner)) {
      throw new UnknownResourceOwnerError(declared.id, declared.owner);
    }
    for (const [name, value] of Object.entries(declared.params ?? {})) {
      if (!isUsablePathSegment(value)) {
        throw new UnusablePathParameterError(declared.id, name, value);
      }
    }
    const tenant = declared.tenant.trim();
    // A resource's tenant is checked against the declared ones, and when there are
    // none, against the accounts' tenants. The second is weaker (a resource of a
    // foreign tenant with no account in it is a legitimate case), which is why
    // `tenants` exists for the strict check.
    const knownTenants = declaredTenants ?? accountTenants;
    if (declaredTenants !== undefined && !knownTenants.includes(tenant)) {
      throw new UnknownTenantError(`Resource "${declared.id}"`, tenant, knownTenants);
    }
    // The same two rules a context's query already lives by, on the twin nobody
    // guarded. A resource's query goes into the request address exactly as a
    // context's does, and `assertContextsCannotWrite` — the three-layer check
    // written for precisely this — reads only contexts. Two things came through:
    // a credential named in a query key, which the report then prints verbatim in
    // `observations[].url`, and a method override by **value**, which performs a
    // write with `--unsafe-methods` absent. Found by adversarial review on
    // 17 August 2026.
    for (const [key, value] of Object.entries(declared.query ?? {})) {
      if (FORBIDDEN_QUERY_KEYS.has(key.toLowerCase())) {
        throw new ForbiddenResourceQueryError(
          declared.id,
          key,
          "credentials are presented through this: the platform would serve the " +
            "request as a different account while the report names the original one — " +
            "and the address is printed in the report as it was sent",
        );
      }
      if (WRITE_METHOD_WORDS.has(value.trim().toUpperCase())) {
        throw new ForbiddenResourceQueryError(
          declared.id,
          key,
          `the value "${value}" is the name of a write method, and a platform ` +
            `honouring an override would perform it while the run believes it sent ` +
            `a read`,
        );
      }
    }
    resources.push({
      id: declared.id,
      tenantId: tenant,
      ...(declared.owner === undefined ? {} : { ownerAccountId: declared.owner }),
      params: declared.params ?? {},
      ...(declared.query === undefined ? {} : { query: declared.query }),
      ...(declared.endpoints === undefined ? {} : { endpointIds: declared.endpoints }),
    });
  }

  // The kinds a run may never buy its way out of, hardcoded here rather than
  // read from anywhere: they are the two that describe the run's own reach, and
  // the list is not an operator's to extend. `probe-error` in particular is what
  // exit code 2 is computed from.
  const UNACCEPTABLE_KINDS = new Set(["not-observed", "probe-error"]);
  const accepted: Acceptance[] = [];
  const acceptedKeys = new Set<string>();
  for (const [index, declared] of (config.accepted ?? []).entries()) {
    const where = describeAcceptance(index);
    if (UNACCEPTABLE_KINDS.has(declared.kind)) {
      throw new UnacceptableFindingKindError(where, declared.kind);
    }
    const acceptance: Acceptance = {
      endpointId: declared.endpoint,
      ...(declared.relation === undefined ? {} : { relation: declared.relation }),
      ...(declared.context === undefined ? {} : { contextId: declared.context }),
      kind: declared.kind,
      reason: declared.reason,
      until: declared.until,
      ...(declared.ticket === undefined ? {} : { ticket: declared.ticket }),
    };
    // Keyed by `acceptanceKeyOf` — the function the report matches a finding
    // with — and not by the citable form, which is what this did until
    // 24 August 2026 and which is a different key.
    //
    // The citable form joins with a space and writes `baseline` for an absent
    // context; the signature joins with NUL and writes nothing. `context` is any
    // non-empty string, so it can be spelled `baseline`, and then an acceptance
    // with no context and one naming the context `baseline` had the same citable
    // key and different signatures: refused here as one entry twice, while the
    // report would have matched them to two different findings. A space is a
    // separator that occurs in the parts, which is why the signature does not
    // use one — this check had borrowed the human-readable string as a map key.
    //
    // The citable form is still what the message prints, because that is the
    // string the operator wrote and will search their file for.
    const defect = citableDefectKey(acceptance);
    if (acceptedKeys.has(acceptanceKeyOf(acceptance, acceptance.kind))) {
      throw new DuplicateAcceptanceError(where, defect, acceptance.kind);
    }
    acceptedKeys.add(acceptanceKeyOf(acceptance, acceptance.kind));
    accepted.push(acceptance);
  }

  const contexts = normalizeContexts(config.contexts ?? [], {
    accountIds: seen,
    policy,
    auth: config.auth ?? DEFAULT_AUTH_SCHEME,
    accountAuth,
    // The query-string keys that belong to resources: a context attribute matching
    // such a key would silently rewrite the resource's address — see below.
    resourceQueryKeys: new Set(resources.flatMap((r) => Object.keys(r.query ?? {}))),
  });

  // After `normalizeContexts`, which is where the declared conditions are
  // verified and where a typo in a **rule's** reference is reported. An
  // acceptance naming conditions that do not exist matches no finding at all —
  // the operator believes something is held, and the run fails for a reason the
  // file appears to have answered.
  const contextIds = new Set(contexts.map((context) => context.id));
  for (const [index, acceptance] of accepted.entries()) {
    if (acceptance.contextId !== undefined && !contextIds.has(acceptance.contextId)) {
      throw new UnknownAcceptanceContextError(describeAcceptance(index), acceptance.contextId, [
        ...contextIds,
      ]);
    }
  }

  return {
    auth: config.auth ?? DEFAULT_AUTH_SCHEME,
    accountAuth,
    target: config.target,
    accounts: config.accounts,
    policy,
    exclude: config.exclude ?? [],
    ...(config.bodySignals === undefined ? {} : { bodySignals: config.bodySignals }),
    ...(tenantNodes === undefined ? {} : { tenants: tenantNodes }),
    resources,
    contexts,
    accepted,
  };
}

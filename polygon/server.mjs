#!/usr/bin/env node

/**
 * The reference platform: a minimal multi-tenant API as an oracle for barbican.
 *
 * Why it exists. VAmPI and crAPI are single-tenant — there is no "foreign tenant"
 * in them at all — and VAmPI's vulnerability switch turned out to be useless,
 * because its modes differed only by response bodies (ADR-0009). The tool stores
 * no response body, so a hard requirement holds here:
 *
 *   **every defect must be visible without keeping one.**
 *
 * Ten of the twelve are visible in the status: 200 where a correct implementation
 * answers 403 or 451. The other two are visible only through an irreversible
 * scalar read over the body in transit — a number or a boolean, kept nowhere
 * (ADR-0011). A difference that is neither is invisible to the tool and cannot
 * serve as an oracle.
 *
 * The requirement used to be written here as "every defect must show itself in
 * the response status", and it stayed that way for the two body-signal defects
 * that came after ADR-0011: `polygon/README.md` beside this file was corrected
 * and the source was not. Both numbers above are now counted out of this file and
 * out of the oracle by `tests/tools/polygon-oracle-facts.test.ts` — prose with a
 * number in it goes stale, and the only cure that holds is a test that reads it.
 *
 * Zero runtime dependencies: the built-in `node:http` only. It listens strictly on
 * 127.0.0.1 — a deployment with deliberate defects must not be reachable from
 * outside.
 */

import { createServer } from "node:http";

/** Loopback only. Deliberately not parameterized. */
const HOST = "127.0.0.1";

const DEFAULT_PORT = 8787;

/**
 * The platform's tenants: two holdings, a brand under each, and under one of the
 * brands an affiliate.
 *
 * Kinship is declared as a separate field rather than encoded in the identifier —
 * for the same reason as in the tool itself (ADR-0013): a typo in a parsed path
 * silently re-parents a tenant, and "my own brand" turns into "a foreign one".
 *
 * The second holding is there precisely as a **foreign branch**. Without it the
 * brand `tenant-b` would just be a root, and "a leak into a foreign holding" would
 * be no different from "a leak to a tenant with no kinship" — that is, the new
 * defect would be testing the old relation.
 *
 * The third level is there for a related reason, but it is not about the tree's
 * width, it is about its **depth**. While the tree is two-level, "the direct
 * parent" and "any ancestor" are one and the same single-element set for every
 * account, and an implementation that walks up one step instead of the whole chain
 * behaves indistinguishably from one that walks the chain. They can be told apart
 * only where there are **two** ancestors: for `affiliate-a1` these are `tenant-a`
 * (one step) and `holding-1` (two).
 */
const TENANTS = [
  { id: "holding-1", parent: undefined },
  { id: "holding-2", parent: undefined },
  { id: "tenant-a", parent: "holding-1" },
  { id: "tenant-b", parent: "holding-2" },
  { id: "affiliate-a1", parent: "tenant-a" },
];

const PARENT_OF = new Map(TENANTS.map((tenant) => [tenant.id, tenant.parent]));

/**
 * The tenant lies strictly below the ancestor in the tree.
 *
 * An implementation of its own rather than an import from `src`: the platform is
 * the system under test, and taking from the tool the very thing it checks on the
 * platform would mean comparing it against itself.
 */
function isBelow(tenantId, ancestorId) {
  let current = PARENT_OF.get(tenantId);
  while (current !== undefined) {
    if (current === ancestorId) {
      return true;
    }
    current = PARENT_OF.get(current);
  }
  return false;
}

/**
 * The direct parent of a tenant. `undefined` at a root.
 *
 * A separate function rather than a parameter of `isBelow`: the difference between
 * "the parent" and "any ancestor" is exactly what separates the `ancestorLeak` and
 * `parentLeak` defects, and it must be visible in the code rather than hidden in
 * an argument.
 */
function parentOf(tenantId) {
  return PARENT_OF.get(tenantId);
}

/**
 * The platform's accounts.
 *
 * Two brands with two users each: the owner of a resource and another user of the
 * same tenant. Without the second one there is no telling BOLA inside a tenant from
 * a cross-tenant leak — both would look like "access to something not one's own".
 *
 * On top of them, a holding-level account. It sits **on the holding itself**, not
 * on one of its brands: attributing it to a brand is possible, but then the
 * holding's own brand becomes a "foreign tenant", and the tool is wrong twice — it
 * picks on a lawful read and misses a real cross-holding leak. That is the very
 * case ADR-0013 was written for.
 *
 * Lower still, an affiliate account brought under a brand. It is there for exactly
 * what the third level of the tree is there for: it has **two** ancestors, and only
 * on it can you see whether the implementation walks the whole chain or a single
 * step. The affiliate is meant to get its own statistics and nothing of the
 * brand's — neither the order list nor the settlement statement — and the holding
 * level all the more so.
 *
 * Tokens come from environment variables and are not kept in the code. The variable
 * names match `tokenEnv` in `barbican.run.yaml`.
 *
 * The `auth` field is a **surface**, not decoration. On a multi-brand platform the
 * affiliate cabinet, the operator console and the customer API authenticate
 * differently, and a run that covers them all at once must knock on each in its own
 * way. That is modelled here literally: customer accounts present Bearer, the
 * operator console a session cookie, the affiliate cabinet a key in its own header.
 *
 * A token presented over the **wrong** transport is not accepted by the platform
 * (see `authenticate`). Otherwise the check would be a stage prop: a tool that
 * sends everything as Bearer would sail straight through it, and the polygon would
 * be confirming that something works which the tool does not do.
 */
const ACCOUNTS = [
  {
    id: "alice-a",
    role: "user",
    tenant: "tenant-a",
    tokenEnv: "POLYGON_TOKEN_ALICE_A",
    auth: { kind: "bearer" },
  },
  {
    id: "bob-a",
    role: "user",
    tenant: "tenant-a",
    tokenEnv: "POLYGON_TOKEN_BOB_A",
    auth: { kind: "bearer" },
  },
  {
    id: "carol-b",
    role: "user",
    tenant: "tenant-b",
    tokenEnv: "POLYGON_TOKEN_CAROL_B",
    auth: { kind: "bearer" },
  },
  {
    id: "dave-b",
    role: "user",
    tenant: "tenant-b",
    tokenEnv: "POLYGON_TOKEN_DAVE_B",
    auth: { kind: "bearer" },
  },
  {
    id: "admin-a",
    role: "admin",
    tenant: "tenant-a",
    tokenEnv: "POLYGON_TOKEN_ADMIN_A",
    auth: { kind: "cookie", name: "opsid" },
  },
  {
    id: "helen-h1",
    role: "holding",
    tenant: "holding-1",
    tokenEnv: "POLYGON_TOKEN_HELEN_H1",
    auth: { kind: "bearer" },
  },
  {
    id: "ivan-af1",
    role: "affiliate",
    tenant: "affiliate-a1",
    tokenEnv: "POLYGON_TOKEN_IVAN_AF1",
    auth: { kind: "header", name: "x-affiliate-key" },
  },
  /**
   * Support over two brands of **different holdings** — an account a tree cannot
   * express (ADR-0017).
   *
   * `tenant-a` and `tenant-b` have no common ancestor at all: the holdings are
   * different, and no root above them exists on this platform. Such an account
   * cannot be seated in a single node in any way — the second brand would become
   * foreign — while introducing a common root above the holdings would mean handing
   * it the whole rest of the subtree as well.
   *
   * The field `tenants` instead of `tenant`, not in addition to it: a single node
   * and a set of nodes are mutually exclusive claims.
   */
  {
    id: "sara-ac",
    role: "support",
    tenants: ["tenant-a", "tenant-b"],
    tokenEnv: "POLYGON_TOKEN_SARA_AC",
    auth: { kind: "bearer" },
  },
];

/**
 * The headers in which the platform looks for affiliate-style keys at all.
 *
 * Derived from the accounts rather than written out as a list: once the two
 * diverged, the list would silently stop seeing the presented key, and the account
 * would get a 401 — that is, a denial that looks lawful.
 */
const CUSTOM_AUTH_HEADERS = new Set(
  ACCOUNTS.filter((account) => account.auth.kind === "header").map((account) =>
    account.auth.name.toLowerCase(),
  ),
);

/**
 * The account's tenants as a single list.
 *
 * For everyone but support it holds one element. The branch "is there a set or not"
 * stands here exactly once: further down the code the difference between one tenant
 * and a set must not be visible at all — otherwise every authorization site would
 * have to be fixed separately, and a forgotten one would silently keep behaving the
 * old way.
 */
function tenantsOf(account) {
  return account.tenants ?? [account.tenant];
}

/**
 * Orders — the resources that requests address.
 *
 * The identifiers match `params.orderId` in the run configuration: the tool
 * substitutes them into the path template, while the owner and the tenant are
 * declared by a human (ADR-0010).
 */
const ORDERS = [
  { id: "A-1001", tenant: "tenant-a", owner: "alice-a" },
  { id: "A-1002", tenant: "tenant-a", owner: "bob-a" },
  { id: "B-2001", tenant: "tenant-b", owner: "carol-b" },
  { id: "B-2002", tenant: "tenant-b", owner: "dave-b" },
];

/**
 * Tenant-level summary settlement statements: one of the holding, one of the brand.
 *
 * A separate collection rather than an order with an empty owner. The reason is not
 * tidiness: a statement belongs to the **tenant as a whole**, it has no user owner
 * at all, and that is exactly the case for which `ownerAccountId` in the tool is
 * optional. An order with no owner would be an order nobody placed.
 *
 * This kind of resource exists here for its sake: without a holding-level resource
 * the relation `ancestor-tenant` ("a brand reads the level of its holding") is
 * inexpressible, and of the two relations introduced by ADR-0013 only
 * `descendant-tenant` was tested by an end-to-end run.
 *
 * The second statement is the brand's. It lives on the same endpoint deliberately,
 * even though by its name ("the summary over the brand's players") it would ask for
 * one of its own. A separate endpoint would spread the two disclosure defects
 * across different addresses, and they would become distinguishable by endpoint —
 * that is, the check would stop being a check of the **tree's depth**, which is
 * what it exists for. Here both statements are read by one authorization function,
 * and the only thing by which "one step up" differs from "the whole chain" is the
 * cell `ivan-af1 × H1-0001`.
 */
const STATEMENTS = [
  { id: "H1-0001", tenant: "holding-1" },
  { id: "A-0001", tenant: "tenant-a" },
];

/**
 * The defect switches.
 *
 * Ten of the twelve are visible in the status: 200 where a correct implementation
 * answers 403 or 451. The other two are visible only through a signal over the
 * body — `listNoFilter` and `scopeAllHonored` change no status at all, which
 * makes them a different kind of thing entirely (ADR-0011).
 *
 * The count said "eight of the ten" while this object held twelve, from the day
 * the two write defects were added until 18 August 2026. It is checked now rather
 * than kept by hand: see the note in the module header.
 *
 * The sets of cells do not intersect — except for the pair `ancestorLeak` and
 * `parentLeak`, where the second is wholly contained in the first. That exception
 * is not a side effect but a testable claim: see README, "The defect that only
 * depth catches".
 */
const DEFECT_FLAGS = {
  /** No tenant filter: a resource of a foreign tenant is served 200 instead of 403. */
  crossTenant: "POLYGON_DEFECT_CROSS_TENANT",
  /** The role is not checked: an ordinary user gets 200 on the admin endpoint. */
  noRoleCheck: "POLYGON_DEFECT_NO_ROLE_CHECK",
  /** IDOR inside a tenant: another user's resource of one's own tenant is served 200 instead of 403. */
  idorSameTenant: "POLYGON_DEFECT_IDOR_SAME_TENANT",
  /**
   * No tenant filter in the list: GET /v1/orders serves the orders of all tenants.
   *
   * The status does not change — 200 both with the defect and without it. Exactly
   * the class that was invisible to the tool before ADR-0011, and for whose sake
   * bodies started being read.
   */
  listNoFilter: "POLYGON_DEFECT_LIST_NO_FILTER",
  /**
   * The holding rollup is not limited to its own subtree: the holding is served
   * resources of a brand of a foreign holding.
   *
   * A separate flag rather than a special case of `crossTenant`, because it is a
   * separate path in the code: "my orders" and "my group's orders" are different
   * queries with different filters, and they break independently. Their sets of
   * cells do not intersect either: `crossTenant` lives on the brand accounts, this
   * one on the holding accounts.
   */
  crossHolding: "POLYGON_DEFECT_CROSS_HOLDING",
  /**
   * The visibility of the summary statements is disclosed **upwards** along the
   * tree: a brand gets the statement of its holding — 200 instead of 403.
   *
   * The mirror of `crossHolding`, and a separate flag for that reason. That one
   * breaks the view top-down (the holding sees a foreign branch), this one
   * bottom-up (a brand sees the level of its group). ADR-0013 separates
   * `descendant-tenant` and `ancestor-tenant` precisely because these are different
   * defects with different costs; merging them into one flag would put back on the
   * polygon a distinction the tool was taught to make.
   *
   * The foreign brand is not hit by this flag: `holding-1` is not its ancestor. So
   * the defect stays a claim about a relation rather than about "the statement
   * became public" — and the cells of `carol-b` and `dave-b` work as a control.
   */
  ancestorLeak: "POLYGON_DEFECT_ANCESTOR_LEAK",
  /**
   * The same upward disclosure, but **exactly one level**: what becomes visible is
   * the statement of the direct parent, not that of the whole chain of ancestors.
   *
   * Plausibility here is not decoration but a condition: the platform takes a
   * denormalized "parent tenant" field out of the token instead of walking the
   * tree. That is written more often than recursion — and that is exactly why such
   * a defect is worth being able to catch.
   *
   * The only flag whose set of cells **intersects** another's: on the two-level part
   * of the tree it matches `ancestorLeak` cell for cell. That is not an oversight
   * but the testable claim itself — see README, "The defect that only depth
   * catches".
   */
  parentLeak: "POLYGON_DEFECT_PARENT_LEAK",
  /**
   * The platform remembers only the **first** membership of an account: the set of
   * tenants is collapsed to a "primary tenant".
   *
   * The plausibility here is the same as with `parentLeak`: the token carries a
   * single `tenant_id` field because every account used to have one tenant — and
   * the set of memberships never reaches authorization. Support over two brands is
   * served the first and denied the second.
   *
   * The only defect of the platform that shows itself as a **denial** rather than
   * as excess access: 403 where a human declared access to be granted. Before
   * ADR-0017 such a claim was inexpressible — there was nothing to declare the
   * second brand one's own with — so the defect too would have been
   * indistinguishable from correct behaviour.
   */
  primaryTenantOnly: "POLYGON_DEFECT_PRIMARY_TENANT_ONLY",
  /**
   * The jurisdiction of the request is not checked: orders are served from a
   * prohibited country too — 200 instead of 451.
   *
   * The only defect of the polygon that is **not visible through permissions
   * alone**: the cell "alice-a × orders.read × her own order" lawfully gives 200 in
   * the base conditions and must give a denial when the request is tagged with a
   * country from the prohibition. They can be told apart only by declaring
   * conditions as a separate dimension (ADR-0019): the role, the tenant and the
   * resource here are one and the same.
   *
   * Plausibility: the geo restriction lives in the CDN or on the entry gateway
   * rather than in the main authorization, and "slipping past" it is the most common
   * way to break such a thing.
   */
  geoBypass: "POLYGON_DEFECT_GEO_BYPASS",
  /**
   * A hidden query parameter widens the scope of the listing: `?scope=all` removes
   * the tenant filter in the brand list.
   *
   * The status does not change, as with `listNoFilter`, but what breaks here is
   * different: there the filter is absent altogether, here it is in place and is
   * removed by a **context attribute**. Hence the different sets of cells: this flag
   * is visible only under the conditions where the parameter is declared, and on
   * base requests it does not show at all.
   *
   * Plausibility: such parameters are introduced for an internal admin panel or for
   * debugging, and the permission check on them is forgotten — it stayed on a role
   * that is no longer in the request.
   */
  scopeAllHonored: "POLYGON_DEFECT_SCOPE_ALL_HONORED",
  /**
   * No tenant filter on a **write**: an order of another tenant is cancelled
   * instead of being refused.
   *
   * A mirror of `crossTenant` on POST, and a separate flag for the same reason
   * the read one is separate from the rollup: reading and cancelling are
   * different branches of the code and break independently. What makes this one
   * worth having is not the branch, though, but the method — the whole write path
   * of the tool (`--unsafe-methods`, the skip of write endpoints without it,
   * `writeMethodsProbed` in the report) had no cell proving it worked.
   */
  writeCrossTenant: "POLYGON_DEFECT_WRITE_CROSS_TENANT",
  /**
   * No owner check on a write: a player cancels a neighbour's order inside their
   * own tenant.
   *
   * The write counterpart of `idorSameTenant`. On a real platform this is the
   * more expensive of the two: reading someone else's order leaks data, whereas
   * cancelling it takes money away from them.
   */
  writeNoOwnerCheck: "POLYGON_DEFECT_WRITE_NO_OWNER_CHECK",
};

class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigurationError";
  }
}

/**
 * Reads a boolean flag from the environment.
 *
 * An unfamiliar value is an error, not "off". A silently accepted typo of the form
 * `POLYGON_DEFECT_CROSS_TENANT=yes` would give a run with no findings,
 * indistinguishable from a successful check of a correct platform.
 */
function readFlag(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return false;
  }
  if (raw === "0" || raw === "false") {
    return false;
  }
  if (raw === "1" || raw === "true") {
    return true;
  }
  throw new ConfigurationError(
    `The variable ${name} has the value "${raw}"; only 0, 1, false, true ` +
      `or the absence of the variable are allowed. A typo here would silently switch the defect off.`,
  );
}

function readDefects() {
  return {
    crossTenant: readFlag(DEFECT_FLAGS.crossTenant),
    noRoleCheck: readFlag(DEFECT_FLAGS.noRoleCheck),
    idorSameTenant: readFlag(DEFECT_FLAGS.idorSameTenant),
    listNoFilter: readFlag(DEFECT_FLAGS.listNoFilter),
    crossHolding: readFlag(DEFECT_FLAGS.crossHolding),
    ancestorLeak: readFlag(DEFECT_FLAGS.ancestorLeak),
    parentLeak: readFlag(DEFECT_FLAGS.parentLeak),
    primaryTenantOnly: readFlag(DEFECT_FLAGS.primaryTenantOnly),
    geoBypass: readFlag(DEFECT_FLAGS.geoBypass),
    scopeAllHonored: readFlag(DEFECT_FLAGS.scopeAllHonored),
    writeCrossTenant: readFlag(DEFECT_FLAGS.writeCrossTenant),
    writeNoOwnerCheck: readFlag(DEFECT_FLAGS.writeNoOwnerCheck),
  };
}

/**
 * The tenants the platform actually counts for an account.
 *
 * Separate from `tenantsOf`: there the declared membership, here what is left of it
 * after the defect. The split is not cosmetic, it is the very substance of the
 * `primaryTenantOnly` flag.
 */
function visibleTenants(account, defects) {
  const declared = tenantsOf(account);
  return defects.primaryTenantOnly ? declared.slice(0, 1) : declared;
}

/**
 * Builds the "token → account" map.
 *
 * A missing variable is a refusal at startup. An empty authorization header in the
 * middle of a run would look like a lawful 401 and would devalue the whole result.
 */
function readTokens() {
  const byToken = new Map();
  for (const account of ACCOUNTS) {
    const value = process.env[account.tokenEnv];
    if (value === undefined || value.trim() === "") {
      throw new ConfigurationError(
        `The variable ${account.tokenEnv} for account "${account.id}" is not set. ` +
          `Tokens are passed through the environment only and are not kept in the repository.`,
      );
    }
    if (byToken.has(value)) {
      throw new ConfigurationError(
        `The token of account "${account.id}" matches the token of another account. ` +
          `Then tenant isolation is untestable: the requests are indistinguishable.`,
      );
    }
    byToken.set(value, account);
  }
  return byToken;
}

/**
 * Everything in the request that looks like presented credentials.
 *
 * Returns "transport → value" pairs: the Bearer from `Authorization`, every cookie
 * by name and every known key header. All of them are parsed rather than the first
 * that fits: the platform must be able to say "the token is right, but it was
 * presented the wrong way", and for that it has to see how exactly it was presented.
 */
function presentedCredentials(headers) {
  const presented = [];

  const authorization = headers.authorization;
  if (typeof authorization === "string") {
    const match = /^Bearer[ \t]+(.+)$/i.exec(authorization.trim());
    if (match !== null) {
      presented.push({ kind: "bearer", value: match[1].trim() });
    }
  }

  const cookie = headers.cookie;
  if (typeof cookie === "string") {
    for (const pair of cookie.split(";")) {
      const separator = pair.indexOf("=");
      if (separator <= 0) {
        continue;
      }
      presented.push({
        kind: "cookie",
        name: pair.slice(0, separator).trim(),
        value: pair.slice(separator + 1).trim(),
      });
    }
  }

  for (const name of CUSTOM_AUTH_HEADERS) {
    const value = headers[name];
    if (typeof value === "string" && value.trim() !== "") {
      presented.push({ kind: "header", name, value: value.trim() });
    }
  }

  return presented;
}

/** Was it presented exactly the way this account is supposed to present it. */
function matchesScheme(scheme, presented) {
  if (scheme.kind !== presented.kind) {
    return false;
  }
  if (scheme.kind === "bearer") {
    return true;
  }
  // Node lowercases header names; cookie names are case-sensitive.
  return scheme.kind === "header"
    ? scheme.name.toLowerCase() === presented.name
    : scheme.name === presented.name;
}

/**
 * The account behind the presented credentials. `undefined` — the anonymous
 * account, a wrong token, or a right token presented over the wrong transport.
 *
 * The last case is not pedantry. Were the platform to accept the operator cookie as
 * a Bearer as well, a tool with the default scheme on every account would sail
 * straight through the run, and the polygon would be confirming that an override
 * works which is not there.
 */
function authenticate(headers, tokensByValue) {
  for (const presented of presentedCredentials(headers)) {
    const account = tokensByValue.get(presented.value);
    if (account !== undefined && matchesScheme(account.auth, presented)) {
      return account;
    }
  }
  return undefined;
}

/**
 * Access to an order.
 *
 * Exactly one branch per cell — which is why switching any flag on changes only its
 * own set of cells and does not touch the neighbouring ones.
 */
function authorizeOrder(account, order, defects) {
  if (account.role === "affiliate") {
    // The brand's orders are not for the affiliate in any mode: it has a surface of
    // its own (`/v1/affiliate/stats`), and the brand's players are not its data.
    //
    // The branch stands first and looks at no flag. This is not over-caution:
    // without it the affiliate would fall through into the brand branch below, and
    // `crossTenant` would add four cells to it. The defect "no tenant filter on the
    // brand accounts" would become a claim about affiliates as well, and the set of
    // cells of the previous flag would stop being what it was.
    return 403;
  }

  if (account.role === "support") {
    // Support sees the orders of the brands it belongs to — and only those.
    // The branch is its own for the same reason the affiliate's is: the brand branch
    // below asks "is the order's tenant equal to the account's tenant?", and this
    // account does not have one tenant, so a shared branch would either serve it too
    // much or deny it the second brand — that is, it would build a defect into the
    // correct mode.
    return visibleTenants(account, defects).includes(order.tenant) ? 200 : 403;
  }

  if (account.role === "holding") {
    // The holding surface is a separate branch in its entirety, and the brand one
    // below stays untouched. This is not a matter of style: it is how the set of
    // cells of `crossHolding` cannot intersect the set of `crossTenant`, while the
    // previous combinations must give exactly the same results as they did before
    // holdings appeared.
    if (isBelow(order.tenant, account.tenant)) {
      // The holding's own brand is meant for it. This is exactly the relation the
      // tool could not express before ADR-0013 and declared an escalation.
      return 200;
    }
    return defects.crossHolding ? 200 : 403;
  }

  if (order.tenant !== account.tenant) {
    // Defect #1: the tenant filter is absent.
    return defects.crossTenant ? 200 : 403;
  }
  if (account.role === "admin") {
    // The tenant's administrator is meant to have every resource of its tenant —
    // this is not a defect.
    return 200;
  }
  if (order.owner === account.id) {
    return 200;
  }
  // Defect #3: IDOR inside a tenant.
  return defects.idorSameTenant ? 200 : 403;
}

/**
 * Access to cancelling an order — a **write**.
 *
 * A branch of its own rather than a reuse of `authorizeOrder`, and the difference
 * is not cosmetic: a holding may read the rollup of its brands but may not cancel
 * their orders. Reading and writing have different rules on a real platform, and
 * a polygon where they coincide would not be able to show that.
 */
function authorizeCancel(account, order, defects) {
  if (account.role === "affiliate") {
    // Orders of a brand are not the affiliate's business, in any mode.
    return 403;
  }
  if (account.role === "holding") {
    // The point of the endpoint: the sweeping read of a licensee is not a right
    // to act. Declared denied in the policy, and denied here.
    return 403;
  }
  if (account.role === "support") {
    return visibleTenants(account, defects).includes(order.tenant) ? 200 : 403;
  }
  if (order.tenant !== account.tenant) {
    return defects.writeCrossTenant ? 200 : 403;
  }
  if (account.role === "admin") {
    // An administrator of a tenant may cancel anything inside it.
    return 200;
  }
  if (order.owner === account.id) {
    return 200;
  }
  return defects.writeNoOwnerCheck ? 200 : 403;
}

/**
 * Access to a summary settlement statement.
 *
 * The statement has no user owner, so "one's own" here means exactly a match of
 * tenants — neither `own` nor BOLA inside a tenant arises here.
 *
 * A separate function rather than a branch in `authorizeOrder`: orders and summary
 * statements have different visibility rules, and they break independently. A side
 * effect, and an important one, is that the brand branch of the orders stayed
 * untouched, so not one previous cell could change its outcome.
 *
 * The correct rule is "my own level and everything below it": visibility goes down
 * the tree. Both defects break its direction; they differ only in how far up they
 * walk.
 */
function authorizeStatement(account, statement, defects) {
  // Here and below — a walk over all the account's tenants. There is deliberately no
  // separate branch for support: the statement visibility rule for it is the same
  // one, and a branch of its own would mean that the upward-disclosure defects do
  // not hit it — a claim nobody has tested. Let them hit it: then the run tests that
  // the ancestors are computed per membership as well.
  const tenants = visibleTenants(account, defects);
  if (tenants.includes(statement.tenant)) {
    return 200;
  }
  // Down the tree — allowed: the holding must see the settlement statement of its
  // brand, otherwise the licensee has no consolidated view at all. This is correct
  // behaviour, not a concession, and no flag touches it.
  if (tenants.some((tenant) => isBelow(statement.tenant, tenant))) {
    return 200;
  }
  // Defect #6: the filter is disclosed up the tree instead of down. The
  // implementation asks "a statement of my tenant or of any of its ancestors?"
  // instead of "of my tenant?" — and a brand gets the statement of its group's
  // level, while the affiliate gets both the brand's statement and the holding's.
  if (defects.ancestorLeak && tenants.some((tenant) => isBelow(tenant, statement.tenant))) {
    return 200;
  }
  // Defect #7: the same upward disclosure, but exactly one step — "a statement of my
  // tenant or of my parent?". The affiliate gets the brand's statement and does not
  // get the holding's; the brand accounts do not tell this defect from the previous
  // one at all, because they have exactly one ancestor.
  if (defects.parentLeak && tenants.some((tenant) => parentOf(tenant) === statement.tenant)) {
    return 200;
  }
  return 403;
}

/**
 * Access to the affiliate's own statistics.
 *
 * An endpoint with no resource and no switches: it answers 200 to the `affiliate`
 * role only and 403 to everyone else in any mode. Two jobs at once — the affiliate's
 * canary (the one place where its token must give 200, so a wrong token will stop
 * the run instead of passing itself off as a lawful denial) and a control: an extra
 * finding on it would mean a false positive.
 */
function authorizeAffiliateStats(account) {
  return account.role === "affiliate" ? 200 : 403;
}

/** Access to the admin endpoint. Defect #2: the role check is switched off. */
function authorizeAdmin(account, defects) {
  if (account.role === "admin") {
    return 200;
  }
  return defects.noRoleCheck ? 200 : 403;
}

function send(res, status, payload) {
  const body = `${JSON.stringify(payload)}\n`;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    // A cached response would distort the matrix: one cell would answer for another.
    "cache-control": "no-store",
  });
  // Node drops the body for HEAD itself; a separate branch is not needed.
  res.end(body);
}

/** The list of endpoints. Duplicated in `endpoints.yaml` — there it is the human's declaration. */
const ORDER_PATH = /^\/v1\/orders\/([^/]+)$/;
const CANCEL_PATH = /^\/v1\/orders\/([^/]+)\/cancel$/;
const STATEMENT_PATH = /^\/v1\/statements\/([^/]+)$/;

/**
 * The prohibited jurisdiction.
 *
 * `AQ` is Antarctica: a real ISO code, but knowingly not a market. There is no
 * reason to put a real country here in a public repository, while a made-up code
 * would not pass with a reader who knows the standard.
 */
const BLOCKED_COUNTRY = "AQ";

/**
 * The geo restriction: orders are not served from the prohibited jurisdiction.
 *
 * It returns 451, not 403: the denial here is legal rather than by permissions, and
 * that is how platforms answer. For the tool it is a denial too — see ADR-0019.
 */
function geoBlocked(headers, defects) {
  if (defects.geoBypass) {
    return false;
  }
  const country = headers["cf-ipcountry"];
  return typeof country === "string" && country.toUpperCase() === BLOCKED_COUNTRY;
}

/**
 * Cancelling an order.
 *
 * The write changes state but not the outcome of any authorization: `cancelled`
 * is set and never consulted. That is deliberate. The tool probes each cell once,
 * but the cells share resources, and a write whose result depended on the order
 * of the probes would make the oracle a function of the traversal order rather
 * than of the platform.
 */
function handleCancel(req, res, context, pathname) {
  const account = authenticate(req.headers, context.tokensByValue);
  if (account === undefined) {
    send(res, 401, { error: "unauthorized" });
    return;
  }
  const orderId = decodeURIComponent(CANCEL_PATH.exec(pathname)?.[1] ?? "");
  const order = ORDERS.find((entry) => entry.id === orderId);
  if (order === undefined) {
    send(res, 404, { error: "not_found" });
    return;
  }
  const status = authorizeCancel(account, order, context.defects);
  if (status !== 200) {
    send(res, status, { error: "forbidden" });
    return;
  }
  order.cancelled = true;
  send(res, 200, { id: order.id, cancelled: true });
}

function handle(req, res, context) {
  const { pathname, searchParams: query } = new URL(req.url ?? "/", `http://${HOST}`);

  // One write endpoint, and everything else is read-only. The tool does not send
  // unsafe methods without `--unsafe-methods`, so in an ordinary run this branch
  // is never reached — which is exactly what the skipped-endpoint entry in the
  // report has to prove.
  if (req.method === "POST" && CANCEL_PATH.test(pathname)) {
    handleCancel(req, res, context, pathname);
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, { error: "method_not_allowed" });
    return;
  }

  // A public endpoint: it answers everyone, the anonymous account included. It is
  // needed both as a readiness probe for verify.mjs and as a control — it is not
  // changed by a single flag, so an extra finding on it would mean a false positive.
  if (pathname === "/v1/health") {
    send(res, 200, { status: "ok", defects: context.defects });
    return;
  }

  const account = authenticate(req.headers, context.tokensByValue);
  if (account === undefined) {
    // Authentication is checked before authorization, so no defect flag opens
    // access to the anonymous account.
    send(res, 401, { error: "unauthorized" });
    return;
  }

  if (pathname === "/v1/orders") {
    if (geoBlocked(req.headers, context.defects)) {
      send(res, 451, { error: "unavailable_for_legal_reasons" });
      return;
    }
    if (account.role === "affiliate") {
      // The brand's order list is not for the affiliate. The branch stands before
      // the brand one and before `listNoFilter`: otherwise, with that defect, the
      // affiliate would get the common list, its body would match the body of a
      // foreign brand, and the previous flag would gain pairs — that is, its set of
      // cells would stop being what it was.
      send(res, 403, { error: "forbidden" });
      return;
    }

    if (account.role === "support") {
      // The list over its own brands. The rows carry the brand for the same reason
      // as in the holding rollup: a list of two brands cannot be read without
      // attribution. The side effect is the same and just as useful — the body does
      // not match a brand one in any mode.
      const visible = ORDERS.filter((order) =>
        visibleTenants(account, context.defects).includes(order.tenant),
      );
      send(res, 200, {
        orders: visible.map((order) => ({
          id: order.id,
          owner: order.owner,
          tenant: order.tenant,
        })),
      });
      return;
    }

    if (account.role === "holding") {
      // The rollup over its own subtree. Every row carries the brand: a rollup
      // without attribution is useless — there is no telling whose order it is.
      //
      // The side effect of this attribution matters and is worth naming out loud. A
      // holding with a single brand sees exactly the same orders as the brand
      // itself, and without the `tenant` field the bodies would match byte for byte.
      // The `identical-response-across-tenants` check was later taught the tree and
      // skips pairs in kinship — but the attribution is what makes the rollup body
      // differ from a brand's in the first place, and the check only skips the
      // holding-versus-its-own-brand pair, not every pair the rollup takes part in.
      // See "Boundaries" in README.md.
      const rollup = ORDERS.filter((order) => isBelow(order.tenant, account.tenant));
      send(res, 200, {
        orders: rollup.map((order) => ({
          id: order.id,
          owner: order.owner,
          tenant: order.tenant,
        })),
      });
      return;
    }

    // The brand list. With the defect the orders of all tenants are served — and the
    // status stays 200 all the same, as in a correct implementation. They can be
    // told apart only by the body: a correct one differs between tenants, a
    // defective one is the same.
    // A correct implementation ignores an unknown parameter. A defective one honours
    // it: `?scope=all` removes the tenant filter. No permission check on this
    // parameter was made at all, which is why there is none in the condition below.
    const wideScope = context.defects.scopeAllHonored && query.get("scope") === "all";
    const visible =
      context.defects.listNoFilter || wideScope
        ? ORDERS
        : ORDERS.filter((order) => order.tenant === account.tenant);
    send(res, 200, { orders: visible.map((order) => ({ id: order.id, owner: order.owner })) });
    return;
  }

  if (pathname === "/v1/affiliate/stats") {
    const status = authorizeAffiliateStats(account);
    if (status !== 200) {
      send(res, status, { error: "forbidden" });
      return;
    }
    // The body decides nothing here: `responseMustDifferByTenant` is not declared
    // for this endpoint, no signals are computed over it, and a defect — were there
    // one here — would be visible in the status.
    send(res, 200, { affiliate: account.id, tenant: account.tenant });
    return;
  }

  if (pathname === "/v1/admin/accounts") {
    const status = authorizeAdmin(account, context.defects);
    if (status !== 200) {
      send(res, status, { error: "forbidden" });
      return;
    }
    const visible = tenantsOf(account);
    const own = ACCOUNTS.filter((entry) =>
      tenantsOf(entry).some((tenant) => visible.includes(tenant)),
    );
    send(res, 200, { accounts: own.map((entry) => ({ id: entry.id, role: entry.role })) });
    return;
  }

  const orderMatch = ORDER_PATH.exec(pathname);
  if (orderMatch !== null) {
    if (geoBlocked(req.headers, context.defects)) {
      send(res, 451, { error: "unavailable_for_legal_reasons" });
      return;
    }
    const orderId = decodeURIComponent(orderMatch[1]);
    const order = ORDERS.find((entry) => entry.id === orderId);
    if (order === undefined) {
      // A non-existent resource — 404 for everyone alike: there is no need to mask a
      // denial as "not found" here, the defects are visible in the status anyway.
      send(res, 404, { error: "not_found" });
      return;
    }
    const status = authorizeOrder(account, order, context.defects);
    if (status !== 200) {
      send(res, status, { error: "forbidden" });
      return;
    }
    send(res, 200, { id: order.id, tenant: order.tenant, owner: order.owner });
    return;
  }

  const statementMatch = STATEMENT_PATH.exec(pathname);
  if (statementMatch !== null) {
    const statementId = decodeURIComponent(statementMatch[1]);
    const statement = STATEMENTS.find((entry) => entry.id === statementId);
    if (statement === undefined) {
      send(res, 404, { error: "not_found" });
      return;
    }
    const status = authorizeStatement(account, statement, context.defects);
    if (status !== 200) {
      send(res, status, { error: "forbidden" });
      return;
    }
    // There is no owner in the body: the holding's statement does not have one.
    send(res, 200, { id: statement.id, tenant: statement.tenant });
    return;
  }

  send(res, 404, { error: "not_found" });
}

function main() {
  const defects = readDefects();
  const tokensByValue = readTokens();
  const context = { defects, tokensByValue };

  const rawPort = process.env.POLYGON_PORT;
  const port = rawPort === undefined || rawPort === "" ? DEFAULT_PORT : Number(rawPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ConfigurationError(`POLYGON_PORT="${rawPort}" is not a port number`);
  }
  const verbose = readFlag("POLYGON_LOG");

  const server = createServer((req, res) => {
    try {
      handle(req, res, context);
    } catch (error) {
      // A 500 breaks the verdict about access: the tool reads it as "no conclusion
      // can be drawn". So it is visible in the log rather than dissolving silently.
      process.stderr.write(`polygon: request handling failed: ${error}\n`);
      send(res, 500, { error: "internal" });
    }
    if (verbose) {
      // Headers are deliberately not logged: a token must reach neither the logs nor
      // the reports — and that goes for all three transports, not only for
      // `Authorization`.
      process.stderr.write(`polygon: ${req.method} ${req.url} -> ${res.statusCode}\n`);
    }
  });

  server.listen(port, HOST, () => {
    const enabled = Object.entries(defects)
      .filter(([, on]) => on)
      .map(([name]) => name);
    process.stderr.write(
      `polygon: http://${HOST}:${port} defects: ${enabled.length === 0 ? "none" : enabled.join(", ")}\n`,
    );
  });

  const stop = () => {
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

try {
  main();
} catch (error) {
  process.stderr.write(`polygon: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

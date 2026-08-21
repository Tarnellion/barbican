/**
 * Parsing and validation of the run configuration.
 *
 * The format and the reasoning behind it — ADR-0008. The key point: **no
 * credentials are kept in the file**. An account names the environment variable,
 * not the token, so the configuration can be committed and reviewed — which is
 * what the declaration was introduced for.
 */

import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { AuthScheme } from "../adapters/credentials.js";
import { assertAuthSchemeIsSound, DEFAULT_AUTH_SCHEME } from "../adapters/credentials.js";
import type { ContextAttributes } from "../adapters/ports.js";
import { parseSignalPath } from "../adapters/signals.js";
import type {
  Account,
  Endpoint,
  ExpectedAccessPolicy,
  Resource,
  SignalSpec,
  TenantNode,
} from "../core/index.js";
import {
  ANY,
  assertIndependentMemberships,
  assertPolicyIsSound,
  BODY_OVER_LIMIT_SIGNAL,
  createTenantHierarchy,
  DEFAULT_DIGEST_SIGNAL,
  DIGEST_SCOPE_MISSING_SIGNAL,
  describePolicyRule,
  FLAT_HIERARCHY,
  HTTP_METHODS,
  isUsablePathSegment,
  RESOURCE_RELATIONS,
  resourceApplies,
} from "../core/index.js";
import { byCodeUnits } from "../core/order.js";
import type { HeaderValue } from "./untrusted.js";
import { isHeaderName, isHeaderValue, lookup, safeHeaders } from "./untrusted.js";

/** The same limit on alias expansion as for specifications. */
const MAX_ALIAS_COUNT = 100;

/**
 * The size and nesting limits on a run configuration.
 *
 * The three endpoint sources have had these since they were written, and this
 * path had only the alias count — the billion-laughs defence. The other two
 * mattered less here and did matter: a configuration is a file an operator may
 * receive from somebody else along with a report to reproduce, and "the parser
 * ran out of stack" is not a refusal a reader can act on. Found by the audit of
 * 14 August 2026 (D-7), whose wording overstates it — the alias limit was
 * already in place.
 *
 * Smaller than a specification's five megabytes: a specification is generated,
 * a configuration is written by a human.
 */
const MAX_CONFIG_BYTES = 1_000_000;
const MAX_CONFIG_DEPTH = 32;

export class ConfigTooLargeError extends Error {
  override readonly name = "ConfigTooLargeError";
  constructor(actualBytes: number, maxBytes: number) {
    super(
      `The run configuration is ${actualBytes} bytes, the limit is ${maxBytes}. ` +
        `A configuration is written by a human; a file this size is more likely ` +
        `generated or wrong than large.`,
    );
  }
}

export class ConfigTooDeepError extends Error {
  override readonly name = "ConfigTooDeepError";
  constructor(maxDepth: number) {
    super(
      `The run configuration nests deeper than ${maxDepth} levels. Nothing this ` +
        `format describes needs that depth, and a parser that runs out of stack ` +
        `instead gives an error nobody can act on.`,
    );
  }
}

/**
 * Refuses a document that is too deep before anything walks it.
 *
 * The same shape as `assertSafeShape` in the OpenAPI parser, and deliberately so
 * — a second way of counting depth would be a second thing to get wrong.
 */
function assertDepth(root: unknown, maxDepth: number): void {
  const seen = new WeakSet<object>();
  const walk = (node: unknown, depth: number): void => {
    if (depth > maxDepth) {
      throw new ConfigTooDeepError(maxDepth);
    }
    if (node === null || typeof node !== "object" || seen.has(node)) {
      return;
    }
    seen.add(node);
    for (const value of Object.values(node)) {
      walk(value, depth + 1);
    }
  };
  walk(root, 0);
}

/**
 * The expected outcome. There is no default on purpose — and the message explains
 * why.
 *
 * Found by a cold read: `Invalid option: expected one of "allowed"|"denied"` reads
 * as nitpicking about the form, while the point is the substance — the absence of
 * a default here is the decision itself.
 */
const outcomeSchema = z.enum(["allowed", "denied"], {
  error:
    'expected "allowed" or "denied". `fallback` has no default on purpose: ' +
    "a silent 'everything is allowed' or 'everything is denied' is equally " +
    "dangerous when a verdict about a vulnerability rests on it. Say plainly " +
    "what cells no rule covers should count as",
});

const selectorSchema = z.union([z.literal(ANY), z.array(z.string().min(1)).min(1)]);

/**
 * Endpoint selection: identifiers mixed with patterns.
 *
 * Listing by `id` does not scale: across a hundred endpoints the rule 'the admin
 * is meant to have everything under /v1/admin' becomes a list that parts with
 * reality at the very first new endpoint — and does so silently.
 */
const endpointSelectorSchema = z.union([
  z.literal(ANY),
  z
    .array(
      z.union([
        z.string().min(1),
        z.strictObject({
          // The set comes from the core, like `RESOURCE_RELATIONS` below and for
          // the same reason: a list written out here read the type nowhere, so a
          // method added to the domain would be refused by this schema as
          // invalid — a rule about the new method could not be declared at all,
          // and the endpoints it covers would fall through to the fallback.
          method: z.enum(HTTP_METHODS).optional(),
          path: z.string().min(1),
        }),
      ]),
    )
    .min(1),
]);

// The list comes from the core instead of being rewritten here: a hand-written
// duplicate already drifted from the type and made the tenant hierarchy
// unreachable through the CLI.
const relationSchema = z.enum(RESOURCE_RELATIONS);

/**
 * A policy rule. The object is strict: an extra key is an error, not a dropped
 * field.
 *
 * Found by running the polygon against an old build: an unrecognized `context` was
 * silently dropped, and the rule 'deny under these conditions' turned into 'deny
 * always' — 19 findings on a healthy platform. The same typo in `scope` widens the
 * rule to every relation and, the other way round, **hides** a finding. Silently
 * in both directions.
 */
const ruleSchema = z.strictObject({
  roles: selectorSchema,
  endpoints: endpointSelectorSchema,
  /** Absent means 'under any relation', requests without a resource included. */
  scope: relationSchema.optional(),
  /**
   * The name of the request conditions from `contexts`.
   *
   * Absent means **baseline** conditions, not 'any': otherwise declaring new
   * conditions would silently extend every previous expectation to them, and a
   * platform that lawfully blocks a bet from a prohibited country would give an
   * 'unexpected denial' on every endpoint. See ADR-0019.
   */
  context: z.string().min(1).optional(),
  outcome: outcomeSchema,
});

/**
 * An authentication scheme.
 *
 * The objects are strict on purpose: an extra key is an error, not a silently
 * dropped field. That way `{ kind: bearer, token: "…" }` is rejected instead of
 * pretending to work while leaving a secret in a file that is meant to be
 * committed. There are no values in a scheme in any form: the only source is the
 * environment variable the account names (ADR-0008).
 */
const authSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("bearer") }),
  z.strictObject({ kind: z.literal("header"), header: z.string().min(1) }),
  z.strictObject({ kind: z.literal("cookie"), name: z.string().min(1) }),
  z.strictObject({ kind: z.literal("basic") }),
]);

/**
 * The value of a context attribute: a literal or the name of an environment
 * variable.
 *
 * Introduced because an attribute's value is printed in the report verbatim — and
 * someone who needs a device signature or a partner key among the conditions had
 * nowhere to go but plain text in the configuration. The form `{ env: NAME }`
 * repeats the account's `tokenEnv`: the **name** travels into the report, the
 * value lives only in the environment.
 */
const contextValueSchema = z.union([z.string(), z.strictObject({ env: z.string().min(1) })]);

/**
 * The validator a run configuration is parsed with. Not exported.
 *
 * It was, and that put zod's own types into the published surface of this
 * package: the declaration came out as 100 lines of `z.ZodObject<…>` — 18% of
 * `config.d.ts` — naming `z.core.$strip`, which is zod's **internal** namespace.
 * A zod major would have changed those types and broken every consumer's build,
 * for a value none of them has any use for: `parseRunConfig` validates and
 * returns a `RunConfig`, `configJsonSchema()` hands out the JSON Schema an
 * editor completes from, and between them there is nothing the raw schema
 * answers. A dependency in a public type is a version of that dependency the
 * package has promised to keep. Found by the audit of 14 August 2026 (E-6).
 */
const configSchema = z.strictObject({
  target: z.strictObject({
    baseUrl: z.url({ protocol: /^https?$/ }),
    allowedHosts: z
      .array(z.string().min(1), {
        error:
          "a list of hosts is required: without an explicitly drawn scope, a run " +
          "against an undeclared host is not testing, it is scanning someone " +
          "else's system. An entry without a port allows any port, with a port — " +
          "exactly that one",
      })
      .min(1, "the host list cannot be empty: there would be nothing to allow"),
    /**
     * What the system under test is called: the environment, the version,
     * anything that identifies it.
     *
     * Declared by a human, because the tool cannot know it: a `baseUrl` like
     * `http://127.0.0.1:8787` does not tell a run against a production-like
     * deployment from a run against a demo polygon, and the configuration
     * fingerprint identifies **our declaration**, not the target. Without this
     * field the reader of the report has no right to file a ticket against the
     * platform: the artefact does not name the platform.
     */
    label: z.string().min(1).optional(),
  }),
  accounts: z
    .array(
      z
        .strictObject({
          id: z.string().min(1),
          role: z.string().min(1),
          /**
           * The account's tenant.
           *
           * Optional: an account without it is declared **outside of tenants**,
           * and that is an anonymous one. There must be no reserved name like
           * `none` here — it would sit in the same value space as real names, and
           * a platform with a tenant of that name would break the classification
           * silently.
           */
          tenant: z.string().min(1).optional(),
          /**
           * Several tenants at once — when the account is meant to have tenants
           * that do not form a subtree (ADR-0017).
           *
           * A key of its own rather than a second value for `tenant`: 'one
           * tenant' and 'a set of tenants' are different statements about the
           * platform under test, and writing them with one word encourages a
           * slip. Fewer than two entries is not accepted: a set of one is
           * `tenant`, and two ways of writing the same thing would diverge in the
           * reading and in the report.
           */
          tenants: z
            .array(z.string().min(1))
            .min(2, "at least two tenants are required: a set of one is the `tenant` field")
            .optional(),
          /**
           * The name of the environment variable holding the token.
           *
           * Optional: an account without it makes its requests anonymously.
           * Without this there is no way to check the claim 'this address must
           * not be public'.
           */
          tokenEnv: z.string().min(1).optional(),
          /**
           * An endpoint this account is known to have access to.
           *
           * Checked before the main run. Without it there is no telling 'access
           * really is absent' from 'we failed to authenticate': a 401 reads as a
           * denial, a denial agrees with the expectation wherever access is not
           * meant to be granted — and the run reports 'no escalations found'
           * having tested nothing.
           */
          canary: z.string().min(1).optional(),
          /**
           * The name of an authentication scheme from `authSchemes`.
           *
           * Optional: without it the account goes by the root `auth`. A
           * **reference** here, not the whole scheme — a scheme's parameters (the
           * header name, the cookie name) belong to the surface, not to the
           * account, and repeated on every account they will sooner or later
           * drift apart through a typo. See ADR-0016.
           */
          authScheme: z.string().min(1).optional(),
        })
        // Both fields at once is a contradiction, not a refinement: it is unclear
        // which of them counts as the membership, and any resolution of that
        // conflict would be a silent choice made for the human.
        .refine((account) => account.tenant === undefined || account.tenants === undefined, {
          error:
            'the account declares both "tenant" and "tenants". These are mutually ' +
            "exclusive statements: one node of the tree, or a set of nodes",
          path: ["tenants"],
        }),
    )
    .min(1),
  policy: z.strictObject({
    fallback: outcomeSchema,
    rules: z.array(ruleSchema),
  }),
  /**
   * Endpoints not to touch even with a safe method.
   *
   * Needed because a GET is not obliged to be safe in practice: an address like
   * `/createdb` resets the database while remaining a GET.
   */
  exclude: z.array(z.string().min(1)).optional(),
  /** The resources requested and their owners — see ADR-0010. */
  resources: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        tenant: z.string().min(1),
        owner: z.string().min(1).optional(),
        params: z.record(z.string().min(1), z.string()).optional(),
        query: z.record(z.string().min(1), z.string()).optional(),
        /**
         * The endpoints the resource belongs to.
         *
         * Required when the identifier sits in the query string: such an endpoint
         * has no path parameters, so it cannot be bound by matching names.
         */
        endpoints: z.array(z.string().min(1)).min(1).optional(),
      }),
    )
    .optional(),
  /**
   * The list of tenants.
   *
   * Optional, but once it is given, the tenant names on accounts and resources are
   * checked against it. Needed because a typo in a tenant name **hides a
   * finding**: the resource drifts into `foreign-tenant`, a rule with a `scope`
   * stops applying, and a real leak falls through to the `fallback`.
   */
  tenants: z
    .union([
      z.array(z.string().min(1)).min(1),
      z
        .array(
          z.strictObject({
            id: z.string().min(1),
            /** The parent. Absent means the root. See ADR-0013. */
            parent: z.string().min(1).optional(),
            /**
             * A base address of its own: brands are often spread across
             * subdomains. The host must be in `allowedHosts` — there is one scope
             * per run, and declaring a tenant does not widen it.
             */
            baseUrl: z.url({ protocol: /^https?$/ }).optional(),
          }),
        )
        .min(1),
    ])
    .optional(),
  /**
   * The default authentication scheme. Bearer if unset — the most common case.
   *
   * The **default** precisely: an account that names no scheme goes by it. A run
   * against a single surface needs nothing more than this.
   */
  auth: authSchema.optional(),
  /**
   * Named schemes for the surfaces.
   *
   * A multi-brand platform has several surfaces, and they authenticate
   * differently: the customer API by Bearer, the operator console by a session
   * cookie, the affiliate cabinet by a key in a header of its own. The name is
   * declared here once, and an account refers to it. See ADR-0016.
   */
  authSchemes: z.record(z.string().min(1), authSchema).optional(),
  /**
   * Request conditions — the minimal useful piece of ABAC.
   *
   * The same account with the same role, but the request is tagged with
   * attributes: an address in another country, a device, KYC not passed. The tool
   * does not model the platform's decision logic — it compares the **outcomes** of
   * two declared sets of conditions. See ADR-0019.
   *
   * `endpoints` is required: conditions without bounds would multiply the matrix
   * by the entire API surface, and the cost of a run on someone else's deployment
   * is not a small matter.
   */
  contexts: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        /** A human description: what exactly these attributes declare. */
        description: z.string().min(1).optional(),
        headers: z.record(z.string().min(1), contextValueSchema).optional(),
        /**
         * A literal only — `{ env: NAME }` is not accepted here, and the type is
         * what refuses it rather than a check somewhere later.
         *
         * A query attribute is substituted into the address, and addresses are
         * printed in the report verbatim: the observation's `url`, the request
         * of every finding. The audit of 14 August put a token in a query
         * attribute through `{ env: … }` and found 24 copies of it in the report,
         * across nine accounts. The guard at the time was a denylist of thirteen
         * key names — `sig`, `hmac`, `secret` walked straight through it, and a
         * list of every name that will ever carry a secret cannot be written.
         *
         * A header keeps the declared form all the way into the report, so that
         * is where a secret goes. There is nothing to lose here: a per-request
         * signature cannot come from a static variable anyway, and a key that
         * authenticates belongs to a scheme, not to conditions (ADR-0018).
         */
        query: z
          .record(
            z.string().min(1),
            z.string({
              error:
                "a query attribute takes a literal, not { env: NAME }. Query " +
                "parameters are substituted into the address, and addresses are " +
                "printed in the report as they were sent — the value would land " +
                "there in the clear. Declare a secret as a header instead: there " +
                "the report keeps the declaration and never the value",
            }),
          )
          .optional(),
        endpoints: z.array(z.string().min(1)).min(1),
        /** The accounts the conditions apply to. Absent means all of them. */
        accounts: z.array(z.string().min(1)).min(1).optional(),
      }),
    )
    .min(1)
    .optional(),
  /**
   * Reading response bodies for the sake of scalar signals. Off when the section
   * is absent.
   *
   * The body is read **only** on the endpoints listed here: the ones where the
   * response must differ between tenants and a match is a sign of a missing
   * filter. That these two lists coincide is not accidental: reading a body where
   * no conclusion follows from it widens the risk surface for nothing.
   * See ADR-0011.
   */
  bodySignals: z
    .strictObject({
      responseMustDifferByTenant: z.array(z.string().min(1)).min(1),
      maxBodyBytes: z.number().int().positive().optional(),
      /**
       * Extra scalars for the report.
       *
       * They produce no findings by themselves — they are there for whoever digs
       * into a digest finding. 'The responses matched for alice and carol' is the
       * alarm, but triage starts with the question of how many records each
       * account saw.
       *
       * `digest` is not declared here: its meaning is set by the
       * `responseMustDifferByTenant` declaration and by the check that reads it.
       * A digest with no consumer is useless.
       */
      signals: z
        .array(
          z.strictObject({
            name: z.string().min(1),
            kind: z.enum(["count", "present"]),
            path: z.string(),
            endpoints: z.array(z.string().min(1)).min(1),
          }),
        )
        .min(1)
        .optional(),
      /**
       * The part of the body to compare, instead of the whole of it.
       *
       * A digest over raw bytes is defeated by the envelope real list endpoints
       * come wrapped in: two responses carrying **both** tenants' records differ
       * by one `requestId`, the digests differ with them, and the check that the
       * "bodies are not read" invariant was relaxed for finds nothing. A
       * `serverTime`, a `generatedAt`, a pagination cursor, an echoed ETag do
       * the same.
       *
       * The path is declared here and never read off a response. Deriving it —
       * "compare the fields that happen to agree" — would be the tool choosing
       * its own answer, which is the mistake ADR-0006 exists against. See
       * ADR-0044.
       */
      compareSubtree: z
        .array(
          z.strictObject({
            endpoints: z.array(z.string().min(1)).min(1),
            /**
             * The grammar is `parseSignalPath`, called rather than copied: a
             * second spelling of one grammar is the drift ADR-0024 is about. The
             * root is refused — comparing the whole body is what happens without
             * this section, so declaring it would be a line that reads as a
             * decision and is not one.
             */
            path: z
              .string()
              .min(1)
              .refine(
                (path) => {
                  try {
                    parseSignalPath(path);
                    return true;
                  } catch {
                    return false;
                  }
                },
                { message: "the path has an empty segment" },
              ),
          }),
        )
        .min(1)
        .optional(),
    })
    .optional(),
});

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

/** The fields one of two shapes declares and the other does not. */
type ExtraFields<A, B> = Exclude<keyof A, keyof B>;

/**
 * `true` when two shapes declare the same fields, and otherwise an object type
 * that names the ones that drifted apart.
 *
 * The object branch is what a reader sees in the error, so it says which
 * direction the drift went: the compiler prints the type it could not satisfy.
 */
type SameFields<Declared, Parsed> = [ExtraFields<Parsed, Declared>] extends [never]
  ? [ExtraFields<Declared, Parsed>] extends [never]
    ? true
    : { readonly declaredHereButNotInTheSchema: ExtraFields<Declared, Parsed> }
  : { readonly inTheSchemaButNotDeclaredHere: ExtraFields<Parsed, Declared> };

/** Compiles only for `true`. The constraint is where a drift is reported. */
type Tied<Same extends true> = Same;

type ParsedConfig = z.infer<typeof configSchema>;

/**
 * The published configuration types, tied to the schema that produces them.
 *
 * Every one of them is written out by hand beside a schema that says the same
 * thing, and nothing related the two copies: the audit of 14 August 2026 (B-11).
 * Measured before this was written — adding a field to the `accounts` schema,
 * required or optional, left `pnpm run typecheck` silent, because a value with
 * extra fields is still assignable to a narrower type. So "the schema grew, the
 * interface did not" was not a thing anyone could be told about; the field would
 * simply be absent from the type a library consumer names, while the validator
 * accepted it.
 *
 * Tied rather than derived, and deliberately. These are the package's published
 * types (`src/index.ts` re-exports this module in full), and `z.infer` gives back
 * mutable shapes: `readonly allowedHosts: readonly string[]` would become
 * `allowedHosts: string[]`, and a consumer would lose a guarantee to buy a rule.
 * The prose above each field would go too — it does not survive inference, and
 * hovering a name is where most of it gets read.
 *
 * The tie is over the field names; their types are held by the assignments in
 * `parseRunConfig`, which is where the parsed value becomes a `RunConfig`. Two
 * halves, and neither is enough alone: an assignment does not see a new field,
 * and a name does not see a changed type.
 *
 * `TenantConfig` and `RequestContextConfig` are not here. They are not copies of
 * a schema shape but the result of a conversion — `parent` becomes `parentId`,
 * `endpoints` becomes `endpointIds`, the short string form of a tenant expands —
 * so equal field names would be the wrong thing to demand of them. What a context
 * is converted **from** is a mirror, and it is tied: `DeclaredContext`, below.
 * `ContextAttributeValue` needs no line here either — it is a union, where field
 * names say nothing, and passing the parsed contexts into `normalizeContexts`
 * already refuses a member the type does not name.
 */
type _RunTargetIsTiedToTheSchema = Tied<SameFields<RunTarget, ParsedConfig["target"]>>;
type _AccountConfigIsTiedToTheSchema = Tied<
  SameFields<AccountConfig, ParsedConfig["accounts"][number]>
>;
type _BodySignalsConfigIsTiedToTheSchema = Tied<
  SameFields<BodySignalsConfig, NonNullable<ParsedConfig["bodySignals"]>>
>;
type _DeclaredSignalIsTiedToTheSchema = Tied<
  SameFields<
    DeclaredSignal,
    NonNullable<NonNullable<ParsedConfig["bodySignals"]>["signals"]>[number]
  >
>;
type _CompareSubtreeIsTiedToTheSchema = Tied<
  SameFields<
    CompareSubtree,
    NonNullable<NonNullable<ParsedConfig["bodySignals"]>["compareSubtree"]>[number]
  >
>;

export class DuplicateSignalNameError extends Error {
  constructor(name: string) {
    super(
      `Signal name "${name}" is declared more than once. Names are keys in the ` +
        `observation, so a repeated name would silently overwrite the previous scalar.`,
    );
    this.name = "DuplicateSignalNameError";
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
}

/**
 * The declared request conditions.
 *
 * The attributes — headers and query parameters — live here rather than in the
 * core: the core knows nothing about HTTP and must not, the `contextId` label is
 * enough for it.
 */
/**
 * The value of an attribute: either a string or a reference to an environment
 * variable.
 *
 * Exactly this form travels into the report, so a secret cannot get there:
 * `{ env: "DEVICE_SIGNATURE" }` names the variable, not the value.
 */
export type ContextAttributeValue = string | { readonly env: string };

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
 * Named rather than spelled out in that function's signature so the tie below can
 * reach it. This shape is a mirror of a `contexts` entry — the same field names —
 * which is what makes the tie the right thing to ask of it; `RequestContextConfig`
 * above is not, because the conversion renames `endpoints` and `accounts` and
 * turns two optional records into required ones.
 *
 * Not exported: what a library consumer gets back from `parseRunConfig` is the
 * converted form, and publishing the intermediate one would offer a second answer
 * to the question of what a context is.
 */
interface DeclaredContext {
  readonly id: string;
  readonly description?: string | undefined;
  readonly headers?: Readonly<Record<string, ContextAttributeValue>> | undefined;
  /** A literal: the schema admits no `{ env: … }` here, and the report prints it. */
  readonly query?: Readonly<Record<string, string>> | undefined;
  readonly endpoints: readonly string[];
  readonly accounts?: readonly string[] | undefined;
}

type _DeclaredContextIsTiedToTheSchema = Tied<
  SameFields<DeclaredContext, NonNullable<ParsedConfig["contexts"]>[number]>
>;

export class ConfigParseError extends Error {
  constructor(message: string, options?: { cause: unknown }) {
    super(`Could not parse the configuration: ${message}`, options);
    this.name = "ConfigParseError";
  }
}

export class ConfigValidationError extends Error {
  constructor(details: string) {
    super(`The configuration is invalid:\n${details}`);
    this.name = "ConfigValidationError";
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
 * Context attributes cannot replace credential and control headers.
 *
 * The list is hardcoded and never taken from user input. Conditions that quietly
 * rewrote `Authorization` would give a run where half the cells go out as a
 * different account — and it would look like findings about the platform.
 */
export class ForbiddenContextHeaderError extends Error {
  constructor(contextId: string, header: string, reason: string) {
    super(
      `Context "${contextId}" sets header "${header}": ${reason}. ` +
        `Context attributes are added to a request, they do not replace its substance.`,
    );
    this.name = "ForbiddenContextHeaderError";
  }
}

/**
 * A resource's query string carries what a context's may not.
 *
 * The two go into the request address by the same route, and only one of them
 * was guarded: `assertContextsCannotWrite` and `FORBIDDEN_QUERY_KEYS` read
 * contexts, the channel an operator fills in by hand, and never resources. A
 * credential named here is printed verbatim in `observations[].url`, and a write
 * method named here is performed by a platform that honours overrides while the
 * run believes it sent a read. Found by adversarial review on 17 August 2026.
 */
export class ForbiddenResourceQueryError extends Error {
  readonly resourceId: string;
  readonly key: string;

  constructor(resourceId: string, key: string, reason: string) {
    super(`Resource "${resourceId}" declares the query parameter "${key}": ${reason}`);
    this.name = "ForbiddenResourceQueryError";
    this.resourceId = resourceId;
    this.key = key;
  }
}

export class ForbiddenContextQueryError extends Error {
  constructor(contextId: string, key: string, reason: string) {
    super(
      `Context "${contextId}" sets query parameter "${key}": ${reason}. ` +
        `Context attributes are added to a request, they do not replace its substance.`,
    );
    this.name = "ForbiddenContextQueryError";
  }
}

export class DuplicateContextIdError extends Error {
  constructor(contextId: string) {
    super(
      `Context "${contextId}" is declared twice. Which one would apply cannot be ` +
        `determined, and the outcome depends on the answer.`,
    );
    this.name = "DuplicateContextIdError";
  }
}

export class UnusedContextError extends Error {
  constructor(contextId: string) {
    super(
      `Context "${contextId}" is declared, but no policy rule references it. ` +
        `Expectations under a context are declared explicitly: without a rule, every ` +
        `cell of that context falls through to the fallback, and the report fills up ` +
        `with discrepancies nobody claimed. Write a rule with "context: ${contextId}" ` +
        `— at least one, declaring the general outcome.`,
    );
    this.name = "UnusedContextError";
  }
}

export class UnknownContextReferenceError extends Error {
  constructor(index: number, contextId: string, declared: readonly string[]) {
    super(
      `${describePolicyRule(index)} references context "${contextId}", which does not exist. ` +
        `Declared: ${declared.length === 0 ? "none" : declared.join(", ")}. ` +
        `A typo here silently changes the verdict: the rule applies to no cell at all.`,
    );
    this.name = "UnknownContextReferenceError";
  }
}

export class UnknownContextAccountError extends Error {
  constructor(contextId: string, accountId: string) {
    super(
      `Context "${contextId}" references account "${accountId}", which is not among ` +
        `the declared accounts. The context would simply apply to nobody.`,
    );
    this.name = "UnknownContextAccountError";
  }
}

/**
 * How many parsed identifiers the error lists.
 *
 * A specification with two hundred operations would otherwise bury the sentence
 * that explains the problem under the answer to it.
 */
const LISTED_ENDPOINTS = 12;

/**
 * The parsed identifiers, nearest first.
 *
 * A typo keeps the prefix — `invoices.reed` for `invoices.read`, `orders.lst`
 * for `orders.list` — so the longest shared prefix puts the intended name at the
 * top of a truncated list far more often than alphabetical order does.
 */
function nearestFirst(target: string, known: readonly string[]): readonly string[] {
  const sharedPrefix = (id: string): number => {
    let length = 0;
    while (length < id.length && length < target.length && id[length] === target[length]) {
      length += 1;
    }
    return length;
  };

  // The tie-break under the prefix rule is by code units, not by the machine's
  // locale: these lists go into CI output that gets diffed between runs, and
  // `localeCompare()` with no argument put them in a different order on a
  // different `LC_ALL`. See `../core/order.js`; found by the audit of
  // 21 August 2026 (L-2).
  return [...known].sort((a, b) => sharedPrefix(b) - sharedPrefix(a) || byCodeUnits(a, b));
}

/**
 * A declared resource that fits none of the endpoints.
 *
 * Almost always a misspelled parameter name: the names in `params` have to match
 * the ones in an endpoint's path exactly, and nothing else in a configuration
 * makes a silent hole of a typo this small.
 */
export class UnusedResourceError extends Error {
  readonly resourceId: string;

  constructor(resourceId: string, parameterNames: readonly string[]) {
    super(
      `Resource "${resourceId}" fits no endpoint, so every cell declared for it ` +
        `is left unwalked and the report says nothing about it. Its parameters are ` +
        `${parameterNames.length === 0 ? "(none)" : parameterNames.map((one) => `"${one}"`).join(", ")} — ` +
        `these names must match the ones in an endpoint's path exactly, and a ` +
        `resource with no path parameters has to name its endpoints in ` +
        `\`endpoints\`. A misspelled parameter is the usual cause.`,
    );
    this.name = "UnusedResourceError";
    this.resourceId = resourceId;
  }
}

/**
 * A rule written for a role no account carries.
 *
 * The one reference in a configuration that used to fail in silence, and
 * `docs/guide.md` said so in as many words — "read a role selector twice;
 * nothing else will". Measured on the reference platform on 18 August 2026:
 * `roles: [admin]` misspelled `admni` takes a clean run from exit 0 and no
 * findings to exit 1 with a privilege escalation against `admin-a ×
 * admin.accounts` that is not there, `warnings: []`, and nothing anywhere saying
 * a rule never applied. The tell is in the report — the finding's `basis` is
 * `fallback` where a rule was meant to decide — and nothing surfaces it.
 *
 * That direction manufactures a finding, which a reader eventually chases down.
 * The other direction is worse and quieter: the same typo on a rule with
 * `outcome: denied` removes an expectation, and a cell that should have been
 * called out agrees with the fallback instead.
 *
 * Refused rather than warned about, which is what this project does with every
 * other declaration matching nothing — an unknown endpoint id, an empty rule
 * selector, a policy pattern that fits nothing, a resource that fits no
 * endpoint. Accounts and policy are declared in the same document, so a rule
 * naming a role absent from it is a typo or dead weight in that same file, and
 * neither is worth a silent run.
 *
 * The reverse direction is deliberately not checked: an account whose role no
 * rule mentions is a real declaration — everything about it falls through to
 * `fallback`, and with `fallback: denied` that is the statement "this role may
 * do nothing", which is worth making.
 */
export class UnknownRoleReferenceError extends Error {
  readonly roleId: string;

  constructor(where: string, roleId: string, known: readonly string[]) {
    const ordered = nearestFirst(roleId, known);

    super(
      `${where} applies to role "${roleId}", which no account declares. The rule ` +
        `matches nothing, so every cell it was written for falls through to the ` +
        `policy fallback and the report never says the rule did not apply. Roles ` +
        `are not read from a token or checked against the platform — the set is ` +
        `exactly what the accounts in this file declare: ` +
        `${ordered.length === 0 ? "(none)" : ordered.map((one) => `"${one}"`).join(", ")}.`,
    );
    this.name = "UnknownRoleReferenceError";
    this.roleId = roleId;
  }
}

export class UnknownEndpointReferenceError extends Error {
  constructor(where: string, endpointId: string, known: readonly string[]) {
    const ordered = nearestFirst(endpointId, known);
    const shown = ordered.slice(0, LISTED_ENDPOINTS);
    const hidden = ordered.length - shown.length;

    // An empty list is a different fact, and a worse one: the source gave no
    // endpoints at all, and every reference in the configuration is about to
    // fail for a reason that has nothing to do with this one.
    const parsed =
      ordered.length === 0
        ? `\n\nNothing was parsed from the endpoint source — check it before this reference.`
        : `\n\nParsed (${ordered.length}): ${shown.join(", ")}` +
          (hidden > 0 ? `, and ${hidden} more` : "");

    super(
      `${where} references endpoint "${endpointId}", which is not among the parsed ones. ` +
        `A typo here is not harmless: a rule silently stops applying and a resource ` +
        `silently stops binding — both change the verdict without leaving a trace ` +
        `in the report.` +
        parsed,
    );
    this.name = "UnknownEndpointReferenceError";
  }
}

/**
 * Checks endpoint references against the list that was actually parsed.
 *
 * Called after the specification is parsed: before that there are no endpoints yet.
 *
 * Found by a run against crAPI. A one-character typo gave two different bad
 * outcomes. In a resource, four BOLA findings vanished silently while the resource
 * stayed in the report as declared. In a policy rule, the other way round,
 * findings were fabricated: a user reading **his own** order was declared a
 * privilege escalation, because the rule that granted access stopped applying.
 *
 * This is the same class `UnknownCanaryEndpointError` and `EmptyRuleSelectorError`
 * already catch; here it had been missed.
 *
 * @throws {UnknownEndpointReferenceError}
 */
export function assertReferencesResolve(config: RunConfig, endpoints: readonly Endpoint[]): void {
  const known = new Set(endpoints.map((endpoint) => endpoint.id));

  const declaredRoles = new Set(config.accounts.map((account) => account.role));

  config.policy.rules.forEach((rule, index) => {
    if (rule.roles !== ANY) {
      for (const roleId of rule.roles) {
        if (!declaredRoles.has(roleId)) {
          throw new UnknownRoleReferenceError(describePolicyRule(index), roleId, [
            ...declaredRoles,
          ]);
        }
      }
    }
    if (rule.endpoints === ANY) {
      return;
    }
    for (const entry of rule.endpoints) {
      // Patterns are checked by expandPolicy: there it shows whether one matched
      // anything at all.
      if (typeof entry !== "string") {
        continue;
      }
      if (!known.has(entry)) {
        throw new UnknownEndpointReferenceError(describePolicyRule(index), entry, [...known]);
      }
    }
  });

  for (const resource of config.resources) {
    for (const endpointId of resource.endpointIds ?? []) {
      if (!known.has(endpointId)) {
        throw new UnknownEndpointReferenceError(`Resource "${resource.id}"`, endpointId, [
          ...known,
        ]);
      }
    }
    // A resource that fits no endpoint is a declaration that never took effect.
    //
    // `resourceApplies` asks that every parameter in an endpoint's path be an own
    // property of `params`, so one wrong letter — `orderid` for `orderId` — makes
    // the resource fit nothing, and every cell it was declared for is simply not
    // walked. Measured on the reference platform: that single typo takes a run
    // from 144 cells to 126 and privilege escalations from 10 to 7, with
    // `warnings: []`, `resourcesNotFound: []`, and the resource still listed in
    // the report among the inputs. Nothing anywhere says a declaration did
    // nothing.
    //
    // Refused at startup, which is what this project already does with every
    // other declaration that matches nothing: a policy pattern matching no
    // endpoint stops the run, and so does an empty rule selector, both because
    // staying silent about them is not allowed. A resource was the one left out.
    // Found by adversarial review on 18 August 2026.
    if (!endpoints.some((endpoint) => resourceApplies(endpoint, resource))) {
      throw new UnusedResourceError(resource.id, Object.keys(resource.params));
    }
  }

  for (const context of config.contexts) {
    for (const endpointId of context.endpointIds) {
      if (!known.has(endpointId)) {
        throw new UnknownEndpointReferenceError(`Context "${context.id}"`, endpointId, [...known]);
      }
    }
  }

  for (const account of config.accounts) {
    if (account.canary !== undefined && !known.has(account.canary)) {
      throw new UnknownEndpointReferenceError(
        `The canary of account "${account.id}"`,
        account.canary,
        [...known],
      );
    }
  }

  // A typo here fails silently and closed: the body is not read, the check does
  // not fire, the report looks clean. The same class as a typo in a tenant name —
  // a silent narrowing of the scope.
  for (const endpointId of config.bodySignals?.responseMustDifferByTenant ?? []) {
    if (!known.has(endpointId)) {
      throw new UnknownEndpointReferenceError(
        "The responseMustDifferByTenant declaration",
        endpointId,
        [...known],
      );
    }
  }

  const seenNames = new Set<string>();
  for (const signal of config.bodySignals?.signals ?? []) {
    if (seenNames.has(signal.name)) {
      throw new DuplicateSignalNameError(signal.name);
    }
    seenNames.add(signal.name);
    for (const endpointId of signal.endpoints) {
      if (!known.has(endpointId)) {
        throw new UnknownEndpointReferenceError(`Signal "${signal.name}"`, endpointId, [...known]);
      }
    }
  }

  // A typo here fails the same way as one in `responseMustDifferByTenant`: the
  // scope lands on nothing, the whole body goes on being compared, and the
  // report says neither. The other two things a scope can be wrong about — the
  // endpoint's bodies not being compared at all, and two scopes for one
  // endpoint — need no endpoint list and are refused at the parse gate, which a
  // library consumer cannot walk past.
  for (const subtree of config.bodySignals?.compareSubtree ?? []) {
    for (const endpointId of subtree.endpoints) {
      if (!known.has(endpointId)) {
        throw new UnknownEndpointReferenceError("The compareSubtree declaration", endpointId, [
          ...known,
        ]);
      }
    }
  }
}

/**
 * Carries the `responseMustDifferByTenant` declaration from the configuration over
 * to the endpoints.
 *
 * Endpoint sources (a specification, a list, a Postman collection) know nothing
 * about tenants and must not: this is a human's statement of intent, exactly like
 * the access policy. See ADR-0006 and ADR-0011.
 */
export function applyBodySignals(
  endpoints: readonly Endpoint[],
  config: RunConfig,
): readonly Endpoint[] {
  const mustDiffer = new Set(config.bodySignals?.responseMustDifferByTenant ?? []);
  const declared = config.bodySignals?.signals ?? [];
  const scopes = config.bodySignals?.compareSubtree ?? [];
  if (mustDiffer.size === 0 && declared.length === 0) {
    return endpoints;
  }
  return endpoints.map((endpoint) => {
    const extra: SignalSpec[] = declared
      .filter((signal) => signal.endpoints.includes(endpoint.id))
      .map(({ name, kind, path }) => ({ name, kind, path }) as const);

    // The scoped digest travels as one of the endpoint's own signals, under the
    // name the tool reserves for itself. The runner prepends the whole-body
    // digest that `responseMustDifferByTenant` implies and appends these, and
    // the extractor resolves a digest name to its **last** spec — so the
    // declared scope replaces the default rather than sitting beside it. The
    // validation above is what makes the pair well defined: at most one scope
    // per endpoint, and only on endpoints whose bodies are compared at all.
    // See ADR-0044.
    const scope = scopes.find((one) => one.endpoints.includes(endpoint.id));
    if (scope !== undefined) {
      extra.push({ name: DEFAULT_DIGEST_SIGNAL, kind: "digest", path: scope.path });
    }

    return {
      ...endpoint,
      ...(mustDiffer.has(endpoint.id) ? { responseMustDifferByTenant: true } : {}),
      ...(extra.length === 0 ? {} : { signals: extra }),
    };
  });
}

export class MissingCredentialError extends Error {
  readonly accountId: string;
  readonly variable: string;

  constructor(accountId: string, variable: string) {
    super(
      `Environment variable ${variable} is not set for account "${accountId}". ` +
        `Tokens are passed through the environment only and are never stored in ` +
        `the configuration.`,
    );
    this.name = "MissingCredentialError";
    this.accountId = accountId;
    this.variable = variable;
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
export class UncarriableKeyError extends Error {
  constructor(path: string) {
    super(
      `The configuration contains a key "${path}" that JavaScript cannot carry as ` +
        `data: assigning it sets an object's prototype instead of adding a key, so ` +
        `the entry silently disappears. A declaration that does nothing and says ` +
        `nothing is worse than an error — rename the key.`,
    );
    this.name = "UncarriableKeyError";
  }
}

/**
 * Rejects keys that silently disappear during parsing.
 *
 * `__proto__` does not become a key in an object literal, and a declared context
 * header would vanish without going over the wire and without complaining. No
 * prototype pollution happens along the way — that has been checked — but the
 * silent disappearance of a declaration is exactly the class of bug the whole tool
 * is written against. Checked on the **raw** document: by the time validation runs
 * the key is already gone.
 *
 * @throws {UncarriableKeyError}
 */
function assertNoUncarriableKeys(node: unknown, path = ""): void {
  if (typeof node !== "object" || node === null) {
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, index) => {
      assertNoUncarriableKeys(item, `${path}[${index}]`);
    });
    return;
  }
  for (const key of Object.getOwnPropertyNames(node)) {
    const where = path === "" ? key : `${path}.${key}`;
    if (key === "__proto__") {
      throw new UncarriableKeyError(where);
    }
    assertNoUncarriableKeys((node as Record<string, unknown>)[key], where);
  }
}

/** Where the published schema answers to, so `$schema:` in a file can find it. */
export const CONFIG_SCHEMA_ID =
  "https://raw.githubusercontent.com/Tarnellion/barbican/main/schema/barbican.run.schema.json";

/**
 * The run configuration as a JSON Schema.
 *
 * Every field of this format is written by hand, and an editor offered no
 * completion for any of it — a cold read of 14 August spent its first minutes
 * guessing at the shape of the whole file, which appears nowhere in the guide as
 * a whole file.
 *
 * Derived from the same zod schema that validates a run, never written out by
 * hand: a second description of one format is a description that disagrees with
 * the first, silently, in the direction of whichever one is read.
 *
 * `io: "input"` — the schema describes what a person writes, before defaults are
 * applied and shorthands expanded. Draft-07 because that is what editors and the
 * YAML language server understand; the later drafts buy nothing here.
 */
export function configJsonSchema(): Record<string, unknown> {
  return {
    $id: CONFIG_SCHEMA_ID,
    title: "barbican run configuration",
    ...z.toJSONSchema(configSchema, { io: "input", target: "draft-07" }),
  };
}

export function parseRunConfig(source: string): RunConfig {
  // Before parsing: a size limit that only applies after the document is built
  // is a limit on the wrong thing.
  const bytes = Buffer.byteLength(source, "utf8");
  if (bytes > MAX_CONFIG_BYTES) {
    throw new ConfigTooLargeError(bytes, MAX_CONFIG_BYTES);
  }

  let document: unknown;
  try {
    document = parseYaml(source, { maxAliasCount: MAX_ALIAS_COUNT });
  } catch (cause) {
    throw new ConfigParseError(cause instanceof Error ? cause.message : String(cause), { cause });
  }

  assertDepth(document, MAX_CONFIG_DEPTH);
  assertNoUncarriableKeys(document);

  const parsed = configSchema.safeParse(document);
  if (!parsed.success) {
    throw new ConfigValidationError(z.prettifyError(parsed.error));
  }
  const config = parsed.data;

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

  const contexts = normalizeContexts(config.contexts ?? [], {
    accountIds: seen,
    policy,
    auth: config.auth ?? DEFAULT_AUTH_SCHEME,
    accountAuth,
    // The query-string keys that belong to resources: a context attribute matching
    // such a key would silently rewrite the resource's address — see below.
    resourceQueryKeys: new Set(resources.flatMap((r) => Object.keys(r.query ?? {}))),
  });

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
  };
}

export class MethodOverrideInContextError extends Error {
  /**
   * @param subject where the value was declared — `Context` or `Resource`. The
   * message names the section of the file the operator has to go and edit, and
   * the two are different sections; the seam checks both, so it cannot call
   * either one by the other's name.
   */
  constructor(contextId: string, where: string, value: string, subject = "Context") {
    super(
      `${subject} "${contextId}" sets ${where} to "${value}" — that is the name of an ` +
        `HTTP method. Platforms that honour method override (Rails, Laravel, Symfony, ` +
        `Spring, most API gateways) will perform a write for such a request even ` +
        `while a GET goes over the wire: the safe-method gate looks at the request ` +
        `method and cannot see that bypass. If writing is the intention, run with ` +
        `--unsafe-methods and the report will say so honestly.`,
    );
    this.name = "MethodOverrideInContextError";
  }
}

/**
 * Rejects context attributes that override the method of the request.
 *
 * The check goes **by value**, not by name, and that is the whole point. Method
 * override has a dozen names and will have more; its value, though, is always the
 * same one — the name of a method. The rule catches `x-http-method-override`, a
 * vendor header I have never heard of, and `_method` in the query string alike.
 *
 * It lives apart from configuration parsing because it depends on a run flag: with
 * `--unsafe-methods` the human has already agreed to writes, and there is nothing
 * to forbid.
 *
 * Found by adversarial review. The deployment deleted a resource on a request the
 * tool considered a read, while the report said `writeMethodsProbed: false`.
 *
 * @throws {MethodOverrideInContextError}
 */
export function assertContextsCannotWrite(
  contexts: ReadonlyMap<string, ContextValues>,
  options: { readonly allowUnsafeMethods: boolean },
): void {
  if (options.allowUnsafeMethods) {
    return;
  }
  // The **resolved** values are checked, not the declared ones: a value from an
  // environment variable is not yet known when the configuration is parsed, and
  // checking the declaration would let `x-vendor-verb: { env: VERB }` through with
  // `VERB=DELETE` in the environment.
  for (const [contextId, values] of contexts) {
    for (const [name, value] of Object.entries(values.headers)) {
      if (WRITE_METHOD_WORDS.has(value.trim().toUpperCase())) {
        throw new MethodOverrideInContextError(contextId, `header "${name}"`, value);
      }
    }
    for (const [key, value] of Object.entries(values.query)) {
      if (WRITE_METHOD_WORDS.has(value.trim().toUpperCase())) {
        throw new MethodOverrideInContextError(contextId, `query parameter "${key}"`, value);
      }
    }
  }
}

/**
 * The same three rules, asked at the seam where the request is assembled.
 *
 * `assertContextsCannotWrite` above and the checks in `normalizeContexts` read a
 * parsed configuration, which is one door of four. `collectObservations` takes
 * `contextAttributes` straight from a consumer of the library, and that door had
 * nothing between it and the wire: the audit of 20 August 2026 (A-1, E-02, E-03)
 * sent `?_method=DELETE` and `x-http-method-override: DELETE` through it with
 * `allowUnsafeMethods: false`, and put a credential from `resources[].query`
 * into the report.
 *
 * ADR-0032 moved the address grammar to the seam for this reason and moved only
 * that; this is the rest of the same move. The door keeps its checks: it knows
 * the context id, the declared auth schemes and the resource keys, so it says
 * more about what is wrong and says it before a single request goes out. What
 * cannot be said here is said there — but what is said here is said for every
 * door there will ever be.
 *
 * Cheap on purpose: two sets and a prefix list against the attributes of one
 * request, next to a network call.
 *
 * @throws {MethodOverrideInContextError} a value names a method that writes
 * @throws {ForbiddenContextHeaderError} a name decides the basis of the request
 * @throws {ForbiddenContextQueryError} a key presents credentials
 */
export function assertAttributesKeepTheBasis(
  /**
   * Where these values were declared, so the message names the line to go and
   * edit. A resource and a set of conditions are different sections of the file,
   * and calling a resource a context sends the reader to the wrong one — the
   * class of defect this project keeps finding in its own diagnostics.
   */
  subject: { readonly kind: "context" | "resource"; readonly id: string },
  attributes: {
    readonly headers: Readonly<Record<string, string>>;
    readonly query: Readonly<Record<string, string>>;
  },
  options: { readonly allowUnsafeMethods: boolean },
): void {
  const { kind, id: contextId } = subject;
  for (const [name, value] of Object.entries(attributes.headers)) {
    const lower = name.toLowerCase();
    const forbidden =
      FORBIDDEN_CONTEXT_HEADERS.get(lower) ??
      FORBIDDEN_HEADER_PREFIXES.find(([prefix]) => lower.startsWith(prefix))?.[1];
    if (forbidden !== undefined) {
      throw new ForbiddenContextHeaderError(contextId, name, forbidden);
    }
    if (!options.allowUnsafeMethods && WRITE_METHOD_WORDS.has(value.trim().toUpperCase())) {
      throw new MethodOverrideInContextError(
        contextId,
        `header "${name}"`,
        value,
        kind === "resource" ? "Resource" : "Context",
      );
    }
  }
  for (const [key, value] of Object.entries(attributes.query)) {
    if (FORBIDDEN_QUERY_KEYS.has(key.toLowerCase())) {
      const why =
        "credentials are presented through this: the platform would serve the " +
        "request as a different account while the report names the original one";
      throw kind === "resource"
        ? new ForbiddenResourceQueryError(contextId, key, why)
        : new ForbiddenContextQueryError(contextId, key, why);
    }
    if (!options.allowUnsafeMethods && WRITE_METHOD_WORDS.has(value.trim().toUpperCase())) {
      throw new MethodOverrideInContextError(
        contextId,
        `query parameter "${key}"`,
        value,
        kind === "resource" ? "Resource" : "Context",
      );
    }
  }
}

/** The resolved attribute values of one set of conditions. */
export interface ContextValues {
  readonly headers: Readonly<Record<string, HeaderValue>>;
  readonly query: Readonly<Record<string, string>>;
}

export class MissingContextValueError extends Error {
  constructor(contextId: string, attribute: string, variable: string) {
    super(
      `Environment variable ${variable} is not set for ${attribute} of context ` +
        `"${contextId}". Context attributes may take their value from the environment ` +
        `exactly like account tokens do — and for the same reason: the value would ` +
        `otherwise sit in a configuration file that is meant to be committed.`,
    );
    this.name = "MissingContextValueError";
  }
}

export class InvalidContextValueError extends Error {
  constructor(contextId: string, attribute: string, variable: string) {
    super(
      `The value from ${variable} for ${attribute} of context "${contextId}" contains ` +
        `characters that cannot be carried in a request. Check the variable: usually ` +
        `a stray line break or text pasted from a non-ASCII source.`,
    );
    this.name = "InvalidContextValueError";
  }
}

/**
 * Resolves the values of context attributes: literals as they are, references from
 * the environment.
 *
 * A separate step, like `resolveTokens`: the environment is passed in explicitly
 * rather than read from inside. A value from the environment never lands in the
 * report — the declaration `{ env: NAME }` stays there.
 *
 * Only headers can carry one. A query attribute is a literal by its type, because
 * it is substituted into the address and addresses are printed as they were sent.
 *
 * @throws {MissingContextValueError} the variable is unset or empty
 * @throws {InvalidContextValueError} the value cannot be sent in a request
 */
export function resolveContextValues(
  config: RunConfig,
  environment: Readonly<Record<string, string | undefined>>,
): ReadonlyMap<string, ContextValues> {
  const resolved = new Map<string, ContextValues>();
  for (const context of config.contexts) {
    const take = (
      source: Readonly<Record<string, ContextAttributeValue>>,
      kind: "header" | "query parameter",
    ): Record<string, string> => {
      const out: Record<string, string> = Object.create(null);
      for (const [name, declared] of Object.entries(source)) {
        if (typeof declared === "string") {
          out[name] = declared;
          continue;
        }
        const where = `${kind} "${name}"`;
        // Not `environment[declared.env]`: the name comes from the configuration
        // and the lookup walks the prototype chain. `{ env: constructor }`
        // returned a function and the caller got `value.trim is not a function`.
        const value = lookup(environment, declared.env);
        if (value === undefined || value.trim() === "") {
          throw new MissingContextValueError(context.id, where, declared.env);
        }
        if (!isHeaderValue(value)) {
          throw new InvalidContextValueError(context.id, where, declared.env);
        }
        out[name] = value;
      }
      return out;
    };
    resolved.set(context.id, {
      // Through `safeHeaders`, the only producer of the type the client accepts.
      // The names were checked when the configuration was parsed and the values
      // just now; this is the seam where both are turned into something the
      // compiler will carry the rest of the way.
      headers: safeHeaders(Object.entries(take(context.headers, "header"))),
      // Nothing to resolve: the schema admits no `{ env: … }` here.
      query: { ...context.query },
    });
  }
  return resolved;
}

/**
 * The headers conditions are not allowed to set.
 *
 * Hardcoded, not configurable: the list guards the substance of a request, and
 * taking it from the same file as the conditions themselves would mean guarding a
 * door with the key hanging on its outside. `authorization` and `cookie` are
 * credentials; `host` takes the request outside the scope while the address stays
 * unchanged; the rest break the exchange itself.
 */
const FORBIDDEN_CONTEXT_HEADERS: ReadonlyMap<string, string> = new Map([
  ["authorization", "these are the account's credentials"],
  ["proxy-authorization", "these are credentials"],
  ["cookie", "these are the account's credentials"],
  ["host", "overriding the host takes the request outside the declared scope"],
  ["forwarded", "a routing header: it changes the recipient, not the conditions"],
  ["content-length", "a transport header, not an attribute of the request"],
  ["transfer-encoding", "a transport header, not an attribute of the request"],
  ["connection", "a transport header, not an attribute of the request"],
  ["te", "a transport header, not an attribute of the request"],
  ["upgrade", "a transport header, not an attribute of the request"],
  ["expect", "a transport header, not an attribute of the request"],
]);

/**
 * Families of headers that change the **meaning** of a request, not its conditions.
 *
 * Found by adversarial review, and the finding was of the worst kind: conditions
 * carrying `x-http-method-override: DELETE` made the platform delete a resource
 * while a GET went over the wire — and the report meanwhile said
 * `writeMethodsProbed: false`. The `SAFE_METHODS` gate looks at the method in the
 * request and does not see that bypass.
 *
 * By prefix, not by exact name: the override header has a dozen spellings
 * (`X-HTTP-Method`, `X-HTTP-Method-Override`, `X-Method-Override`), and a list of
 * exact names will fall behind the next framework. `x-forwarded-for` is allowed on
 * purpose — it is the typical attribute of geo conditions; only those
 * `x-forwarded-*` that change the recipient are forbidden.
 */
const FORBIDDEN_HEADER_PREFIXES: readonly (readonly [string, string])[] = [
  ["x-http-method", "a method-override header: the platform will write behind a GET"],
  ["x-method", "a method-override header: the platform will write behind a GET"],
  ["x-original-", "a path-override header: the request would go past the declared path"],
  ["x-rewrite-", "a path-override header: the request would go past the declared path"],
  ["x-forwarded-host", "a routing header: it changes the recipient, not the conditions"],
  ["x-forwarded-proto", "a routing header: it changes the recipient, not the conditions"],
  ["x-forwarded-port", "a routing header: it changes the recipient, not the conditions"],
  ["x-forwarded-prefix", "a routing header: it changes the recipient, not the conditions"],
  ["x-forwarded-uri", "a routing header: it changes the recipient, not the conditions"],
];

/**
 * The query-string keys that present credentials.
 *
 * A token in the query string means a different account: the platform will serve
 * the request as that account, while the report will write the original
 * `baseAccountId`. Found by adversarial review: an `access_token` in the conditions
 * was served as someone else's account, and a whole half of the matrix went out as
 * somebody other than the one the report named. On top of that the value itself
 * would land in the report in the clear — request addresses are printed there.
 */
/**
 * Words that name a write, for the check by **value**.
 *
 * Wider than `HttpMethod`: `CONNECT` is not in the domain and a platform
 * honouring an override does not care what this tool's type says. One source
 * because two places read it — the conditions an operator declares and the query
 * a resource declares — and a set written twice is the shape B-10 was about.
 *
 * The seven original words were the methods this tool knows. That is not the set
 * a platform will execute: adversarial review of 19 August 2026 got `MOVE`
 * through as a resource query and as an attribute value, and `MOVE` deletes the
 * source. The WebDAV and versioning methods are here now, with `PURGE` for the
 * caches that honour it.
 *
 * An enumeration, and this one is allowed to be an enumeration — unlike the
 * denylist of header names ADR-0005's addendum threw out. The difference is what
 * the set has to be complete against: header names that will ever carry a secret
 * are unbounded and belong to whoever wrote the platform, while a method a
 * platform can be talked into performing is a registered token — IANA's method
 * registry plus the handful of vendor verbs below. Where a name outside it does
 * turn out to perform a write, the entry to add is here, in the one set both
 * readers share.
 */
const WRITE_METHOD_WORDS: ReadonlySet<string> = new Set([
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "TRACE",
  "CONNECT",
  // RFC 4918 (WebDAV): every one of these changes something on the target.
  "COPY",
  "LOCK",
  "MKCOL",
  "MOVE",
  "PROPPATCH",
  "UNLOCK",
  // RFC 3253 and RFC 5842: versioning and binding.
  "BASELINE-CONTROL",
  "BIND",
  "CHECKIN",
  "CHECKOUT",
  "LABEL",
  "MERGE",
  "MKACTIVITY",
  "MKWORKSPACE",
  "REBIND",
  "UNBIND",
  "UNCHECKOUT",
  "UPDATE",
  "VERSION-CONTROL",
  // The rest of the registry that writes, and the reason this list is written
  // out rather than described: the second adversarial review of 19 August took
  // the paragraph above at its word — "IANA's method registry" — and found six
  // registered methods missing from it. A claim about a registry has to be the
  // registry.
  "LINK",
  "MKCALENDAR",
  "MKREDIRECTREF",
  "ORDERPATCH",
  "UNLINK",
  "UPDATEREDIRECTREF",
  // RFC 3744: access control. A method that rewrites permissions on a run
  // checking permissions is the worst of the lot.
  "ACL",
  // Vendor, and common enough to matter: cache invalidation.
  "PURGE",
]);

const FORBIDDEN_QUERY_KEYS: ReadonlySet<string> = new Set([
  "access_token",
  "accesstoken",
  "api_key",
  "apikey",
  "auth",
  "auth_token",
  "authorization",
  "id_token",
  "jwt",
  "session",
  "sessionid",
  "session_id",
  "token",
]);

/**
 * Brings the declared conditions into working form and rejects the unfit ones.
 *
 * Every check here is about silent substitution: conditions that rewrote a
 * credential header give a run made as a different account; conditions with no rule
 * give a pile of discrepancies nobody claimed; a typo in a name gives a rule that
 * applies to nothing.
 */
function normalizeContexts(
  declared: readonly DeclaredContext[],
  options: {
    readonly accountIds: ReadonlySet<string>;
    readonly resourceQueryKeys: ReadonlySet<string>;
    readonly policy: ExpectedAccessPolicy;
    readonly auth: AuthScheme;
    readonly accountAuth: ReadonlyMap<string, AuthScheme>;
  },
): readonly RequestContextConfig[] {
  // The header name and the cookie name are declared by a human, so they get into
  // the forbidden list from the parsed schemes, not from a line of configuration.
  const inUse = new Set<string>();
  for (const scheme of [options.auth, ...options.accountAuth.values()]) {
    if (scheme.kind === "header") {
      inUse.add(scheme.header.toLowerCase());
    }
  }

  const referenced = new Set(
    options.policy.rules
      .map((rule) => rule.context)
      .filter((context): context is string => context !== undefined),
  );
  const ids = new Set(declared.map((context) => context.id));
  // The rules' references are checked before the unused-conditions check: a typo
  // in a reference gives both symptoms at once, but telling someone who did use
  // the conditions that they 'are declared but referenced by nobody' leads him the
  // wrong way. What he was actually editing is reported first.
  options.policy.rules.forEach((rule, index) => {
    if (rule.context !== undefined && !ids.has(rule.context)) {
      throw new UnknownContextReferenceError(index, rule.context, [...ids]);
    }
  });

  const contexts: RequestContextConfig[] = [];
  const seenIds = new Set<string>();

  for (const context of declared) {
    if (seenIds.has(context.id)) {
      throw new DuplicateContextIdError(context.id);
    }
    seenIds.add(context.id);

    // Without a prototype: the name `__proto__` in a plain object literal does not
    // become a key but silently disappears — a declared header would not go over
    // the wire, and nobody would learn about it. Found by the review that followed
    // an adversarial review.
    const headers: Record<string, ContextAttributeValue> = Object.create(null);
    for (const [name, value] of Object.entries(context.headers ?? {})) {
      const lower = name.toLowerCase();
      if (!isHeaderName(name)) {
        throw new ForbiddenContextHeaderError(
          context.id,
          name,
          "this is not a header name per RFC 9110 — a request carrying it would not " +
            "be sent at all",
        );
      }
      // A value from the environment cannot be checked here — it does not exist
      // yet. It is verified at resolution time, exactly like an account's token.
      if (typeof value === "string" && !isHeaderValue(value)) {
        throw new ForbiddenContextHeaderError(
          context.id,
          name,
          "the value contains characters a header cannot carry: every cell of such " +
            "a run would die with an opaque request failure",
        );
      }
      const forbidden =
        FORBIDDEN_CONTEXT_HEADERS.get(lower) ??
        FORBIDDEN_HEADER_PREFIXES.find(([prefix]) => lower.startsWith(prefix))?.[1];
      if (forbidden !== undefined) {
        throw new ForbiddenContextHeaderError(context.id, name, forbidden);
      }
      if (inUse.has(lower)) {
        throw new ForbiddenContextHeaderError(
          context.id,
          name,
          "credentials are presented through this header",
        );
      }
      headers[lower] = value;
    }

    for (const [key, value] of Object.entries(context.query ?? {})) {
      const lower = key.toLowerCase();
      if (FORBIDDEN_QUERY_KEYS.has(lower)) {
        throw new ForbiddenContextQueryError(
          context.id,
          key,
          "credentials are presented through this: the platform would serve the " +
            "request as a different account while the report names the original one",
        );
      }
      // A resource's key rewritten by conditions is the quietest substitution of
      // all: the verdict is computed for the declared resource while a different
      // one is asked for. Found by adversarial review: a cross-tenant leak landed
      // in the report as 'own resource, tested and agreed'.
      if (options.resourceQueryKeys.has(key)) {
        throw new ForbiddenContextQueryError(
          context.id,
          key,
          "resources identify themselves with this key in the query string: the " +
            "context would rewrite the resource address while the verdict was computed " +
            "for the declared one",
        );
      }
      if (typeof value === "string" && !isHeaderValue(value)) {
        throw new ForbiddenContextQueryError(
          context.id,
          key,
          "the value contains characters a request URL cannot carry",
        );
      }
    }

    for (const accountId of context.accounts ?? []) {
      if (!options.accountIds.has(accountId)) {
        throw new UnknownContextAccountError(context.id, accountId);
      }
    }

    if (!referenced.has(context.id)) {
      throw new UnusedContextError(context.id);
    }

    contexts.push({
      id: context.id,
      ...(context.description === undefined ? {} : { description: context.description }),
      headers,
      query: context.query ?? {},
      endpointIds: context.endpoints,
      accountIds: context.accounts ?? [],
    });
  }

  return contexts;
}

/**
 * The separator in the identifier of an account under conditions.
 *
 * An account under conditions is a matrix row of its own, and it needs an
 * identifier of its own. A collision with an actually declared account (for
 * example, when accounts are named by email addresses) will not pass silently:
 * building the matrix rejects duplicate identifiers.
 */
const CONTEXT_SEPARATOR = "@";

/**
 * Converts the configuration's accounts into the core's domain type, adding the
 * accounts under conditions.
 *
 * Returns the attribute map as well: the core neither needs the headers and query
 * parameters nor receives them, while the run does need them. One function rather
 * than two, because two walks over the same derivation would drift apart — and
 * drift silently: an account without attributes would go out in baseline
 * conditions while answering for findings made under the declared ones.
 */
export function toAccounts(
  config: RunConfig,
  /**
   * The resolved attribute values. Required when at least one attribute takes its
   * value from the environment: without them it would silently go out in the
   * request as an object.
   */
  contextValues: ReadonlyMap<string, ContextValues> = new Map(),
): {
  readonly accounts: readonly Account[];
  readonly attributes: ReadonlyMap<string, ContextAttributes>;
} {
  const base = baseAccounts(config);
  const attributes = new Map<string, ContextAttributes>();
  const derived: Account[] = [];

  for (const context of config.contexts) {
    for (const account of base) {
      if (context.accountIds.length > 0 && !context.accountIds.includes(account.id)) {
        continue;
      }
      const id = `${account.id}${CONTEXT_SEPARATOR}${context.id}`;
      derived.push({
        ...account,
        id,
        contextId: context.id,
        // Ownership of a resource is checked against the original account:
        // conditions do not cancel it. Without this reference one's own order
        // stopped being one's own, the relation drifted to `same-tenant`, and the
        // severity drifted upwards.
        baseAccountId: account.id,
        endpointIds: context.endpointIds,
      });
      const values = contextValues.get(context.id) ?? literalValues(context);
      attributes.set(id, {
        contextId: context.id,
        headers: values.headers,
        query: values.query,
      });
    }
  }

  return { accounts: [...base, ...derived], attributes };
}

/**
 * The values of conditions when no resolution was passed in.
 *
 * A reference to the environment turns into a refusal here, not into an object in
 * a header: a skipped resolution step has to be heard.
 */
function literalValues(context: RequestContextConfig): ContextValues {
  const take = (source: Readonly<Record<string, ContextAttributeValue>>, kind: string) => {
    const out: Record<string, string> = Object.create(null);
    for (const [name, value] of Object.entries(source)) {
      if (typeof value !== "string") {
        throw new MissingContextValueError(context.id, `${kind} "${name}"`, value.env);
      }
      out[name] = value;
    }
    return out;
  };
  return {
    headers: safeHeaders(Object.entries(take(context.headers, "header"))),
    query: take(context.query, "query parameter"),
  };
}

function baseAccounts(config: RunConfig): readonly Account[] {
  return config.accounts.map((account) => {
    if (account.tenants !== undefined) {
      // A set reaches the core as a set. Reducing it to 'the first tenant' would
      // declare the remaining memberships foreign — exactly the substitution that
      // made a lawful read of the second brand look like an escalation.
      return {
        id: account.id,
        roleId: account.role,
        tenantIds: account.tenants.map((tenant) => tenant.trim()),
      };
    }
    return {
      id: account.id,
      roleId: account.role,
      // The field is not set at all rather than filled with a placeholder: the
      // absence of a tenant is the statement 'the account is outside of tenants',
      // and it has to reach `relationOf` as an absence.
      ...(account.tenant === undefined ? {} : { tenantId: account.tenant.trim() }),
    };
  });
}

export class InvalidCredentialError extends Error {
  readonly accountId: string;
  readonly variable: string;

  constructor(accountId: string, variable: string) {
    super(
      `The token from ${variable} for account "${accountId}" contains characters that ` +
        `an HTTP header value cannot carry. Check the variable: usually a stray line ` +
        `break or text pasted from a non-ASCII source.`,
    );
    this.name = "InvalidCredentialError";
    this.accountId = accountId;
    this.variable = variable;
  }
}

/**
 * Two accounts present the same token.
 *
 * The whole tool rests on the platform being able to tell the accounts apart. If
 * two of them hand over the same credential, every request the run makes "as
 * carol" arrives as alice, and the central claim — "carol cannot read alice's
 * order" — is proved by carol *being* alice. Nothing downstream can notice:
 * the canaries pass, every status is what the policy expects, the report comes
 * back clean and the run reads as evidence of isolation.
 *
 * A refusal rather than a warning, and before the first request, for the same
 * reason a missing host allowlist is one: a result that cannot mean what it says
 * is worse than no result. The reference platform has refused this since the day
 * it was written (`readTokens` in `polygon/server.mjs`) — the tool that checks
 * platforms did not. Found by the audit of 14 August 2026 (K-8).
 *
 * Neither the message nor the fields carry the token: the two variable names are
 * what the operator has to go and look at, and a value that reaches an error
 * message reaches a log.
 */
export class SharedCredentialError extends Error {
  readonly accountId: string;
  readonly variable: string;
  readonly otherAccountId: string;
  readonly otherVariable: string;

  constructor(accountId: string, variable: string, other: { id: string; variable: string }) {
    super(
      `Accounts "${other.id}" and "${accountId}" present the same token, so the ` +
        `platform cannot tell them apart: every cross-account check would compare ` +
        `an account with itself and report the match as isolation. ` +
        (variable === other.variable
          ? `Both read it from ${variable} — give each account a variable of its own.`
          : `${other.variable} and ${variable} hold the same value — the same once ` +
            `surrounding whitespace is removed, which is what a platform compares.`),
    );
    this.name = "SharedCredentialError";
    this.accountId = accountId;
    this.variable = variable;
    this.otherAccountId = other.id;
    this.otherVariable = other.variable;
  }
}

/**
 * Takes the tokens out of the environment.
 *
 * Returns a separate map rather than a field in the configuration: that way a
 * token cannot accidentally travel into the report along with the serialized
 * configuration.
 *
 * Fitness for a header is checked here rather than on the first request: otherwise
 * one typo in a variable would turn into dozens of identical failures in the
 * middle of a run instead of one clear error at startup.
 *
 * @throws {MissingCredentialError} the variable is unset or empty
 * @throws {InvalidCredentialError} the token is unfit as a header value
 * @throws {SharedCredentialError} two accounts present the same token
 */
export function resolveTokens(
  config: RunConfig,
  environment: Readonly<Record<string, string | undefined>>,
): ReadonlyMap<string, string> {
  const tokens = new Map<string, string>();
  /**
   * Who already presents each token, so that a second account presenting it can
   * be named against the first.
   *
   * A `Map` keyed by the token value, which never leaves this function: the
   * accounts derived for request conditions share their principal's credential
   * by design (`principalOf`), so the check is over declared accounts only —
   * exactly the set this loop walks.
   */
  const presentedBy = new Map<string, { id: string; variable: string }>();
  for (const account of config.accounts) {
    if (account.tokenEnv === undefined) {
      // An anonymous account: there are no credentials on purpose.
      continue;
    }
    // `tokenEnv: constructor` used to return `Object.prototype.constructor` and
    // fail with `TypeError: value.trim is not a function` instead of naming the
    // variable. The class was already recognised and closed once in this file,
    // which is what makes it a class. Found by the audit of 14 August (D-3).
    const value = lookup(environment, account.tokenEnv);
    if (value === undefined || value.trim() === "") {
      throw new MissingCredentialError(account.id, account.tokenEnv);
    }
    if (!isHeaderValue(value)) {
      throw new InvalidCredentialError(account.id, account.tokenEnv);
    }
    // Keyed by the **trimmed** value, because that is what the platform compares.
    //
    // Raw values were compared until 17 August 2026, and one trailing space took
    // the whole check off: `tok-alice` and `"tok-alice "` are two different
    // strings and one credential — every parser trims the optional whitespace a
    // header value may carry, and the reference platform in this repository does
    // it in the regular expression that reads `Authorization`. Both accounts then
    // authenticated as alice, both canaries passed, and the run reported
    // isolation proved by comparing an account with itself: exactly the failure
    // this check exists to refuse, wearing a space. Found by adversarial review.
    //
    // Trimming is the only normalisation applied. What a platform does beyond it
    // — case, encoding, a prefix of its own — is unknown here, and guessing would
    // trade a refusal that is right for one that is plausible.
    const presented = value.trim();
    const other = presentedBy.get(presented);
    if (other !== undefined) {
      throw new SharedCredentialError(account.id, account.tokenEnv, other);
    }
    presentedBy.set(presented, { id: account.id, variable: account.tokenEnv });
    tokens.set(account.id, value);
  }
  return tokens;
}

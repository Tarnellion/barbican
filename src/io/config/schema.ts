/**
 * What a run configuration may say, and what stops a file before anyone believes
 * it.
 *
 * The format and the reasoning behind it — ADR-0008. The key point: **no
 * credentials are kept in the file**. An account names the environment variable,
 * not the token, so the configuration can be committed and reviewed.
 *
 * This is the one module that names zod, and it hands nothing zod-shaped out:
 * `parseConfigDocument` returns `DeclaredConfig`, written out by hand in
 * `types.ts`. Both halves of that arrangement matter — a shipped declaration
 * that imports a package is a version of that package the tool has promised to
 * keep (the audit of 14 August 2026, E-6), and a schema behind a hand-written
 * type is a schema that can drift from it, which is what the ties at the bottom
 * of this file are for.
 */

import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { parseSignalPath } from "../../adapters/signals.js";
// The date grammar is reached for directly rather than through
// `../../core/index.js`: it is deliberately off the barrel and so off the
// package's public surface, the same standing `../../core/order.js` has. See the
// header of `src/core/calendar.ts` for why one grammar and why it lives in the
// core.
import { CALENDAR_DATE, isCalendarDate } from "../../core/calendar.js";
import { ANY, HTTP_METHODS, RESOURCE_RELATIONS } from "../../core/index.js";
import type {
  AccountConfig,
  BodySignalsConfig,
  CompareSubtree,
  DeclaredAcceptance,
  DeclaredConfig,
  DeclaredContext,
  DeclaredResource,
  DeclaredSignal,
  DeclaredTenant,
  RunTarget,
} from "./types.js";

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
   * Findings that are known, accepted, and held out of the verdict until a date.
   *
   * The second channel for intent. `policy` says what access is *meant* to
   * exist; this says what is not meant to exist, is known to exist, and is not
   * being fixed this quarter. Before it there was one way to stop a finding
   * failing a build — declare the cell allowed — and that erases the finding
   * from the report altogether, which is the difference an evidence pack is for.
   * See ADR-0048.
   *
   * A row here is addressed the way a defect is addressed: endpoint, relation to
   * the resource, request conditions, and the way the defect showed itself.
   * Neither the account nor the resource is part of it — a key carrying either
   * would come apart the moment one more of them is declared.
   */
  accepted: z
    .array(
      z.strictObject({
        endpoint: z.string().min(1),
        /**
         * The relation the finding was made under. Absent means the defect on
         * cells with no resource at all — printed as `any-resource` in
         * `defects[].key`, and a coordinate of its own rather than a wildcard.
         */
        relation: relationSchema.optional(),
        /** The conditions. Absent means baseline, exactly as in a policy rule. */
        context: z.string().min(1).optional(),
        /**
         * A kind of matrix discrepancy, or the id of the check that found it.
         *
         * Not an enum: check ids come from a registry this schema cannot see,
         * and half of what an operator most wants to accept on a first run is
         * found by a check. The two kinds nothing may accept are refused below,
         * where the reason can be stated.
         */
        kind: z.string().min(1),
        reason: z
          .string()
          .min(
            1,
            "an accepted finding needs a reason. A suppression nobody can read is a " +
              "pin nobody notices — the same failure as an `overrides` entry with no " +
              "condition for its own removal, and here what it hides is a finding",
          ),
        /**
         * The last day the acceptance holds, `YYYY-MM-DD`, inclusive, UTC.
         *
         * The shape is checked here rather than left to the expiry arithmetic,
         * which answers `NaN` for anything it cannot read — and `NaN` compares
         * false, so an unreadable date would silently mean one of the two
         * extremes instead of what the file says.
         */
        until: z
          .string()
          // The same `RegExp` object the expiry arithmetic parses with, and the
          // same one `isCalendarDate` on the next line matches — one grammar,
          // asked twice for two different messages. It was three expressions in
          // two spellings until 23 August 2026; loosening this one alone would
          // have admitted a string that `acceptanceExpiresAt` cannot read, and
          // an unreadable deadline is an acceptance that never lapses or one
          // that lapsed on the day it was written. See ADR-0064.
          .regex(
            CALENDAR_DATE,
            'the deadline is a date in the form YYYY-MM-DD, for example "2026-11-30". ' +
              "It is the last day the acceptance holds, in UTC — not the machine's " +
              "zone, so that the verdict does not depend on which runner picked the " +
              "job up",
          )
          .refine(isCalendarDate, {
            error:
              "there is no such day. A deadline that does not exist would be read by " +
              "the calendar as some other day, and the file would not say which",
          }),
        /** Where the fix is tracked. Optional: not every team has a tracker to cite. */
        ticket: z.string().min(1).optional(),
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
                { error: "the path has an empty segment" },
              ),
          }),
        )
        .min(1)
        .optional(),
    })
    .optional(),
});

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
 * Tied rather than derived, and deliberately. Most of them are the package's
 * published types (`src/index.ts` re-exports `../config.js` in full, and that
 * file lists what leaves), and `z.infer` gives back
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
type _DeclaredContextIsTiedToTheSchema = Tied<
  SameFields<DeclaredContext, NonNullable<ParsedConfig["contexts"]>[number]>
>;
type _DeclaredAcceptanceIsTiedToTheSchema = Tied<
  SameFields<DeclaredAcceptance, NonNullable<ParsedConfig["accepted"]>[number]>
>;
type _DeclaredResourceIsTiedToTheSchema = Tied<
  SameFields<DeclaredResource, NonNullable<ParsedConfig["resources"]>[number]>
>;
type _DeclaredTenantIsTiedToTheSchema = Tied<
  SameFields<DeclaredTenant, Exclude<NonNullable<ParsedConfig["tenants"]>[number], string>>
>;
/**
 * And the document itself, which is the tie the boundary needs.
 *
 * `parseConfigDocument` returns a `DeclaredConfig`, and assignability alone
 * would not notice a section added to the schema: a value with extra fields is
 * still assignable to a narrower type, which is exactly the hole B-11 was about.
 * This is what notices.
 */
type _DeclaredConfigIsTiedToTheSchema = Tied<SameFields<DeclaredConfig, ParsedConfig>>;

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

/**
 * Reads the text of a configuration into a document the schema accepts.
 *
 * Everything a file has to get past before any of it is believed, in the order
 * it has to be got past: the size, the parser, the depth, the keys JavaScript
 * cannot carry, and then the schema. The result is the hand-written
 * `DeclaredConfig` rather than zod's inferred shape — see the note at the top
 * of this file.
 *
 * @throws {ConfigTooLargeError} the file is larger than a human writes
 * @throws {ConfigParseError} the document does not parse
 * @throws {ConfigTooDeepError} the document nests deeper than anything needs
 * @throws {UncarriableKeyError} a key would silently disappear
 * @throws {ConfigValidationError} the document does not match the schema
 */
export function parseConfigDocument(source: string): DeclaredConfig {
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
  return parsed.data;
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

/**
 * Request conditions, from the declaration to the matrix rows they add.
 *
 * The minimal useful piece of ABAC (ADR-0019): the same account with the same
 * role, but the request is tagged with attributes — an address in another
 * country, a device, KYC not passed. The tool does not model the platform's
 * decision logic; it compares the **outcomes** of two declared sets.
 *
 * Every check in `normalizeContexts` is about silent substitution: conditions
 * that rewrote a credential header give a run made as a different account,
 * conditions with no rule give a pile of discrepancies nobody claimed, a typo in
 * a name gives a rule that applies to nothing.
 *
 * `toAccounts` is here rather than beside the accounts because the rows it adds
 * are the conditions' doing: an account under conditions is a row of its own,
 * and the attributes it carries are resolved from the same declaration.
 */

import type { AuthScheme } from "../../adapters/credentials.js";
import type { ContextAttributes } from "../../adapters/ports.js";
import type { Account, ExpectedAccessPolicy } from "../../core/index.js";
import { describePolicyRule } from "../../core/index.js";
import { isHeaderName, isHeaderValue, safeHeaders } from "../untrusted.js";
import {
  ForbiddenContextHeaderError,
  ForbiddenContextQueryError,
  forbiddenHeaderReason,
  forbiddenQueryKeyReason,
} from "./basis.js";
import { MissingContextValueError } from "./environment.js";
import type {
  ContextAttributeValue,
  ContextValues,
  DeclaredContext,
  RequestContextConfig,
  RunConfig,
} from "./types.js";

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
 * Brings the declared conditions into working form and rejects the unfit ones.
 *
 * Every check here is about silent substitution: conditions that rewrote a
 * credential header give a run made as a different account; conditions with no rule
 * give a pile of discrepancies nobody claimed; a typo in a name gives a rule that
 * applies to nothing.
 */
export function normalizeContexts(
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
      // The two layers are composed in `./basis.js` and not here. They were
      // composed in both, expression for expression, and the rule they compose
      // is on record as having been wrong when it had one layer instead of two
      // (ADR-0019) — so the thing most likely to happen to it next is a third
      // layer, added to whichever copy the author had open. See ADR-0064.
      const forbidden = forbiddenHeaderReason(name);
      if (forbidden !== undefined) {
        throw new ForbiddenContextHeaderError(context.id, name, forbidden);
      }
      // This one stays at the door, and it is not part of that composition: it
      // needs the declared authentication schemes, which exist in a parsed
      // configuration and nowhere else. The seam's copy of the rule cannot ask
      // it, which is the reason the door keeps checks of its own at all.
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
      const credentials = forbiddenQueryKeyReason(key);
      if (credentials !== undefined) {
        throw new ForbiddenContextQueryError(context.id, key, credentials);
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

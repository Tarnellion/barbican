/**
 * The half of the validation that only the parsed endpoint list can answer.
 *
 * Everything here runs after the specification, the endpoint list or the
 * collection has been read: before that there are no endpoints to check a
 * reference against. The rest of the validation needs nothing but the
 * configuration and happens at the parse gate, which is the one gate a library
 * consumer cannot walk past.
 *
 * What they have in common is the failure they refuse. A reference that resolves
 * to nothing does not announce itself: a rule silently stops applying, a
 * resource silently stops binding, a body is silently not read — and each of
 * them changes the verdict without leaving a trace in the report.
 */

import type { Endpoint, SignalSpec } from "../../core/index.js";
import {
  ANY,
  DEFAULT_DIGEST_SIGNAL,
  describeAcceptance,
  describePolicyRule,
  resourceApplies,
} from "../../core/index.js";
import { byCodeUnits } from "../../core/order.js";
import type { RunConfig } from "./types.js";

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

  // An acceptance whose endpoint does not exist matches nothing, and the
  // direction it fails in is the harmless one: the finding is reported, CI stays
  // red, somebody looks. It is refused all the same, because that is what this
  // project does with every reference resolving to nothing, and because the
  // operator who wrote it believes the opposite has happened — that a finding is
  // held, and that a deadline is running against it.
  for (const [index, acceptance] of config.accepted.entries()) {
    if (!known.has(acceptance.endpointId)) {
      throw new UnknownEndpointReferenceError(describeAcceptance(index), acceptance.endpointId, [
        ...known,
      ]);
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
  //
  // Unreachable through `parseRunConfig`, and kept on purpose. Measured on
  // 24 August 2026, against the built tree: the parse gate raises
  // `CompareSubtreeWithoutComparisonError` for a scope whose endpoint is not
  // under `responseMustDifferByTenant`, so an unknown id here has to be named in
  // both — and the loop twenty lines above walks `responseMustDifferByTenant`
  // first and throws there. Every spelling of the typo ends at one of those two,
  // which is why no test reaches these four lines. Seven of the eight places
  // this function raises `UnknownEndpointReferenceError` from are exercised; this
  // is the eighth.
  //
  // What holds it up is a rule in another module, and the check it makes is
  // three lines. `assertReferencesResolve` takes a `RunConfig` — an interface,
  // not a brand — so a consumer that assembles one by hand is a door this
  // reasoning says nothing about, and the day the parse gate learns to accept a
  // scope on an endpoint whose bodies are not compared, this is the line that
  // decides whether the typo is refused or walked past in silence. The same
  // argument `probeCanaries` keeps its unreachable `UnknownCanaryEndpointError`
  // on. See ADR-0074.
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

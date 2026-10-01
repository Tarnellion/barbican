/**
 * Permissive cross-origin sharing over response headers.
 *
 * A sibling of `identical-response-across-tenants`, and the second check to read
 * something a status code cannot show: there the body, here two response
 * headers. A platform that answers a cross-origin request with
 * `Access-Control-Allow-Origin` **and** `Access-Control-Allow-Credentials: true`
 * is telling the browser to hand an authenticated response to script on another
 * origin. Who that other origin may be is the whole of the question, and two of
 * the answers are wrong by construction rather than by context:
 *
 * - **`*` with credentials.** The Fetch standard forbids the pair — a browser in
 *   credentials mode rejects a wildcard — so a platform that emits it has a CORS
 *   layer that is not reasoning about credentials at all. It is not directly
 *   reachable from a browser, which is why it is reported below the next one,
 *   but it is a broken policy and the kind that reflects a real origin once the
 *   wildcard is removed.
 * - **`null` with credentials.** The `null` origin is what a sandboxed iframe, a
 *   `data:` document and a `file:` page send, and any attacker can put their
 *   script in one. Echoing `null` and allowing credentials hands the response to
 *   exactly those, so this one is exploitable from a browser as it stands.
 *
 * ## Reflection, and why it needs a declaration
 *
 * **Reflection of an arbitrary origin** — the common and more dangerous case,
 * where the platform copies whatever `Origin` it was sent into
 * `Access-Control-Allow-Origin` and allows credentials — cannot be found from the
 * response alone, and this check does not pretend otherwise. A specific origin
 * echoed back with credentials is indistinguishable from a legitimately
 * allowlisted partner: both are one string in one header. Flagging it would be a
 * guess, and this tool does not guess about access (the false-positives risk in
 * `plan.md`).
 *
 * What settles it is a fact only a human has: **which origin the platform must not
 * trust.** That is the same move as the expected-access policy (ADR-0006), made for
 * a cross-origin policy — the expectation is declared and never derived. An
 * operator marks a context's `origin` as foreign (`originIsForeign: true`, ADR-0078)
 * and the run hands this check a map from that context to the origin it sent. For
 * a cell under such a context, an `Access-Control-Allow-Origin` equal to the
 * declared origin, with credentials, is a platform that trusts the one origin the
 * operator said it must not. It is conclusive because the operator made it so; a
 * partner's origin is simply not marked, and the platform's correct answer to it
 * stays silent.
 *
 * The two shapes below need no declaration at all: `*` and `null` are wrong
 * whatever was asked.
 *
 * ## Where the headers come from
 *
 * A server emits CORS headers only in answer to a request that carried an
 * `Origin`, and nothing this tool sends carries one on its own initiative. An
 * operator declares a request condition with `{ headers: { origin: "..." } }`
 * — `origin` is not among the names a condition may not set — and the cells
 * under that condition are the ones this check reads. With no such condition the
 * check examines nothing and says so through its coverage, which is the honest
 * reading: the question was not asked, not that it was asked and came back
 * clean.
 *
 * Pure over the matrix, like every check: it reads `observation.headers`, which
 * the HTTP adapter has already kept by allowlist and spelled out, and never goes
 * to the network. See ADR-0076.
 */

import { byCodeUnits } from "../order.js";
import type { AccessObservation } from "../types.js";
import { API_SECURITY_MISCONFIGURATION } from "./clauses.js";
import type { Check, CheckContext, CheckCoverage, Finding } from "./types.js";

export const CORS_CHECK_ID = "permissive-cors";

/**
 * The two response headers this check reads, lower-cased.
 *
 * The adapter lower-cases header names on the way in (`toHttpResponse`), so a
 * comparison here is against the lower-case spelling and no other. Written once,
 * because both the check and its coverage read them and a second copy is the
 * shape every drift in this repository starts as.
 */
const ALLOW_ORIGIN_HEADER = "access-control-allow-origin";
const ALLOW_CREDENTIALS_HEADER = "access-control-allow-credentials";

/**
 * Reads one header by its fixed name, and only as an own property.
 *
 * `observation.headers` is a record keyed by names the **platform** chose, and a
 * report parsed back from JSON carries `Object.prototype`, so a plain index
 * would answer for `constructor` and `toString`. The names read here are this
 * tool's own and none of them is a prototype key, so the risk is not an attacker
 * reaching one of them — it is that a consumer feeding observations from their
 * own harness hands over an object whose prototype happens to carry the name.
 * `Object.hasOwn` refuses the prototype in both cases. This is the same concern
 * `lookup()` answers in `src/io/untrusted.ts`, open in the core by hand because
 * the core may not import `src/io` — the ring ADR-0024 keeps from closing.
 */
function ownHeader(
  headers: Readonly<Record<string, string>> | undefined,
  name: string,
): string | undefined {
  if (headers === undefined || !Object.hasOwn(headers, name)) {
    return undefined;
  }
  return headers[name];
}

/**
 * Whether the cell got an answer to read at all.
 *
 * A probe that failed — a 5xx, a redirect the tool does not follow, any status the
 * outcome classification files under `error` — is not a response to judge: it may
 * be a gateway's error page that has nothing to do with the platform's CORS
 * policy, and a finding on it would be reported on a cell the report itself lists
 * as a probe error. 401 and 403 are answers and are read. The finding and the
 * coverage ask this one question, so a cell cannot be judged and counted as
 * unanswered at once, which is what adversarial review of ADR-0078 measured.
 */
function wasAnswered(observation: AccessObservation): boolean {
  return observation.outcome !== "error";
}

/** Whether the response allows credentials on the cross-origin read. */
function allowsCredentials(headers: Readonly<Record<string, string>> | undefined): boolean {
  // The header is a boolean spelled as text, and the only value the Fetch
  // standard reads as true is the exact lower-case word. A platform that writes
  // `True` or `1` has not enabled credentials in any browser, so trimming and
  // lower-casing here would report a danger that does not exist. The one
  // concession is surrounding whitespace, which a header may carry and no
  // browser treats as meaningful.
  return ownHeader(headers, ALLOW_CREDENTIALS_HEADER)?.trim() === "true";
}

/** The dangerous shapes of `Access-Control-Allow-Origin`, with credentials on. */
type OriginVerdict =
  | "wildcard-with-credentials"
  | "null-with-credentials"
  | "reflects-foreign-origin-with-credentials";

/**
 * What, if anything, is wrong with one observation's CORS headers.
 *
 * `undefined` for every cell that is not conclusively broken: a missing header,
 * credentials off, or a specific origin that nobody declared foreign — which may
 * be a reflection and may be an allowlist, a difference this check cannot settle
 * and so does not report. See the module comment.
 *
 * The order is the rule: `*` and `null` are settled before the declared origin is
 * looked at, so a platform answering `*` under a foreign-origin context is one
 * finding and not two, and a mistaken `foreignOrigins` entry of `*` cannot
 * double-report.
 */
function verdictOf(
  observation: AccessObservation,
  foreignOrigin: string | undefined,
): OriginVerdict | undefined {
  if (!wasAnswered(observation)) {
    return undefined;
  }
  const origin = ownHeader(observation.headers, ALLOW_ORIGIN_HEADER)?.trim();
  if (origin === undefined || !allowsCredentials(observation.headers)) {
    return undefined;
  }
  if (origin === "*") {
    return "wildcard-with-credentials";
  }
  if (origin === "null") {
    return "null-with-credentials";
  }
  if (foreignOrigin !== undefined && origin === foreignOrigin) {
    return "reflects-foreign-origin-with-credentials";
  }
  return undefined;
}

const TITLE: Readonly<Record<OriginVerdict, string>> = {
  "wildcard-with-credentials":
    "Cross-origin sharing allows any origin with credentials (a wildcard the " +
    "Fetch standard forbids with credentials)",
  "null-with-credentials":
    "Cross-origin sharing allows the null origin with credentials, which a " +
    "sandboxed document can present",
  "reflects-foreign-origin-with-credentials":
    "Cross-origin sharing allows an origin the operator declared foreign, with " +
    "credentials, so it trusts the origin it was sent",
};

const SEVERITY: Readonly<Record<OriginVerdict, "medium" | "high">> = {
  // Contradictory and browser-rejected as it stands, but a CORS layer that
  // emits it is not reasoning about credentials and is the kind that reflects a
  // real origin once the wildcard is gone.
  "wildcard-with-credentials": "medium",
  // Reachable from a browser as it stands: any script can run in a null-origin
  // document.
  "null-with-credentials": "high",
  // The case the two above stand in for: a page on any origin an attacker
  // controls reads the authenticated response. Reachable as it stands.
  "reflects-foreign-origin-with-credentials": "high",
};

export interface CorsCheckOptions {
  /**
   * The origin each context sends, for the contexts the operator declared
   * foreign: context id to origin. ADR-0078.
   *
   * Handed in at registration, the way `identical-response-across-tenants` is
   * handed its digest signal, and for the same reason: the core knows a request
   * condition only as a `contextId` label and the attributes live in the adapters
   * (ADR-0019), so what the condition **sent** has to arrive from the layer that
   * knows it. The check does not parse an origin and does not judge whether one
   * is well formed — the configuration refuses a malformed one at startup — and a
   * consumer building this map by hand is trusted to hand over what their harness
   * sent. An empty origin is ignored rather than matched: no header value is
   * "the origin" of nothing.
   *
   * Absent or empty means no origin was declared foreign, and the check then
   * reports only the two shapes that need no declaration.
   */
  readonly foreignOrigins?: ReadonlyMap<string, string>;
}

export function createCorsCheck(options: CorsCheckOptions = {}): Check {
  // Copied, and emptied of what cannot be an origin: the check holds its own
  // table, so a caller changing the map they passed after registration cannot
  // change what a run that is already under way judges.
  //
  // Trimmed, as the header it is compared with is: whitespace around a header value
  // is not part of it, and a declared origin with a trailing space would otherwise
  // never match a real echo — a silent miss on exactly the platform it was meant to
  // catch. Measured by adversarial review of ADR-0078. Nothing else is done to it:
  // the check does not parse an origin (see `CorsCheckOptions`).
  const foreignOrigins = new Map(
    [...(options.foreignOrigins ?? new Map<string, string>())]
      .map(([contextId, origin]) => [contextId, origin.trim()] as const)
      .filter(([, origin]) => origin !== ""),
  );

  /** The condition each account was walked under, `undefined` for the baseline. */
  function contextsOf(context: CheckContext): ReadonlyMap<string, string | undefined> {
    return new Map(context.matrix.accounts.map((account) => [account.id, account.contextId]));
  }

  return {
    id: CORS_CHECK_ID,
    description:
      "Reads Access-Control-Allow-Origin and Access-Control-Allow-Credentials on " +
      "the cells under a declared origin condition, and reports the origins that " +
      "are wrong with credentials: the wildcard and the null origin whatever was " +
      "asked, and an origin the operator declared foreign (originIsForeign) that " +
      "the platform trusts. A specific origin nobody declared foreign is not " +
      "judged — see ADR-0076 and ADR-0078.",
    severity: "high",
    standards: [API_SECURITY_MISCONFIGURATION],
    run(context: CheckContext): readonly Finding[] {
      const contextByAccount = contextsOf(context);
      const findings: Finding[] = [];
      // One finding per endpoint × condition × shape: the CORS policy is a
      // property of the endpoint under one condition, not of the account that
      // happened to reach it, so two accounts seeing the same wildcard are one
      // finding. The condition is a coordinate for the reason every finding
      // carries it (`Finding.contextId`): the same shape under two declared
      // origins is two facts, and merging them would read as one.
      //
      // Nested maps rather than a glued string key, for the reason the matrix
      // index gives (`ObservationIndex`): gluing identifiers admits a collision,
      // and the one place a key is built from a separator is `joinKey`, which
      // this file may not reach — `one-decision-one-home.test.ts` pins that
      // import to `defects.ts` alone. `undefined` is the baseline condition and
      // Map keys it on equal terms with a string, so no sentinel is invented.
      const seen = new Map<string, Map<string | undefined, Set<OriginVerdict>>>();
      for (const observation of context.matrix.observations) {
        const contextId = contextByAccount.get(observation.accountId);
        const foreignOrigin = contextId === undefined ? undefined : foreignOrigins.get(contextId);
        const verdict = verdictOf(observation, foreignOrigin);
        if (verdict === undefined) {
          continue;
        }
        const byContext = seen.get(observation.endpointId) ?? new Map();
        const verdicts = byContext.get(contextId) ?? new Set<OriginVerdict>();
        if (verdicts.has(verdict)) {
          continue;
        }
        verdicts.add(verdict);
        byContext.set(contextId, verdicts);
        seen.set(observation.endpointId, byContext);
        const origin = ownHeader(observation.headers, ALLOW_ORIGIN_HEADER)?.trim() ?? "";
        findings.push({
          checkId: CORS_CHECK_ID,
          severity: SEVERITY[verdict],
          title: TITLE[verdict],
          endpointId: observation.endpointId,
          accountId: observation.accountId,
          ...(contextId === undefined ? {} : { contextId }),
          evidence: {
            allowOrigin: origin,
            allowCredentials: true,
            status: observation.status,
            ...(verdict === "reflects-foreign-origin-with-credentials"
              ? { foreignOriginDeclared: true }
              : {}),
          },
        });
      }
      // Deterministic order: the run must not depend on the order observations
      // arrived in. Severity is settled later, in `runChecks`, so this orders by
      // the coordinates a reader scans.
      return findings.sort((a, b) => {
        const byEndpoint = byCodeUnits(a.endpointId ?? "", b.endpointId ?? "");
        if (byEndpoint !== 0) {
          return byEndpoint;
        }
        const byContext = byCodeUnits(a.contextId ?? "", b.contextId ?? "");
        return byContext !== 0 ? byContext : byCodeUnits(a.title, b.title);
      });
    },
    coverage(context: CheckContext): readonly CheckCoverage[] {
      // Per endpoint, how many of its observations carried a CORS response header
      // at all. Zero everywhere is the signal that no origin condition was
      // declared, which is the difference between "asked and clean" and "never
      // asked" — the same distinction the isolation check's coverage exists to
      // keep, and the one an evidence pack needs.
      //
      // The reflection question has the same two readings and gets its own
      // counter: `foreignOriginCellsAnswered` is how many cells under a context
      // declared foreign got an answer at all, a probe that failed excluded. An
      // endpoint with that counter above zero and no finding was **asked** whether
      // it trusts the declared origin and said it does not — which an endpoint
      // with no such counter was never asked. It is absent when no origin was
      // declared foreign, as `skippedDifferentContextPairs` is absent when no
      // conditions are declared: a zero there would claim a question was put.
      const contextByAccount = contextsOf(context);
      const perEndpoint = new Map<
        string,
        { responses: number; credentialed: number; foreignAnswered: number }
      >();
      for (const observation of context.matrix.observations) {
        if (!wasAnswered(observation)) {
          continue;
        }
        const contextId = contextByAccount.get(observation.accountId);
        const askedForeign = contextId !== undefined && foreignOrigins.has(contextId);
        const sawCors = ownHeader(observation.headers, ALLOW_ORIGIN_HEADER) !== undefined;
        if (!sawCors && !askedForeign) {
          continue;
        }
        const tally = perEndpoint.get(observation.endpointId) ?? {
          responses: 0,
          credentialed: 0,
          foreignAnswered: 0,
        };
        if (sawCors) {
          tally.responses += 1;
          if (allowsCredentials(observation.headers)) {
            tally.credentialed += 1;
          }
        }
        if (askedForeign) {
          tally.foreignAnswered += 1;
        }
        perEndpoint.set(observation.endpointId, tally);
      }
      return [...perEndpoint.entries()]
        .sort(([a], [b]) => byCodeUnits(a, b))
        .map(([endpointId, tally]) => ({
          checkId: CORS_CHECK_ID,
          endpointId,
          counters: {
            corsResponsesSeen: tally.responses,
            corsResponsesAllowingCredentials: tally.credentialed,
            ...(foreignOrigins.size === 0
              ? {}
              : { foreignOriginCellsAnswered: tally.foreignAnswered }),
          },
        }));
    },
  };
}

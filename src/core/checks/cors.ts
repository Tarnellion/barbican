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
 * ## What this check deliberately does not claim
 *
 * **Reflection of an arbitrary origin** — the common and more dangerous case,
 * where the platform copies whatever `Origin` it was sent into
 * `Access-Control-Allow-Origin` and allows credentials — is **not** found here,
 * and cannot be from the matrix alone. A conclusive verdict needs the origin
 * that was sent, and in the core an observation carries the response but not the
 * request's `Origin`: that attribute lives in the adapters (ADR-0019), and the
 * core knows a request condition only by its `contextId` label. A specific
 * origin echoed back with credentials is indistinguishable here from a
 * legitimately allowlisted partner, so flagging it would be a guess, and this
 * tool does not guess about access (the false-positives risk in `plan.md`). The
 * two cases above need no sent origin: `*` and `null` are wrong whatever was
 * asked. Closing the reflection gap means carrying the sent origin into the
 * matrix, which is a decision of its own — see ADR-0076.
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
type OriginVerdict = "wildcard-with-credentials" | "null-with-credentials";

/**
 * What, if anything, is wrong with one observation's CORS headers.
 *
 * `undefined` for every cell that is not conclusively broken: a missing header,
 * credentials off, or a specific origin — the last of which may be a reflection
 * and may be an allowlist, a difference this check cannot settle and so does not
 * report. See the module comment.
 */
function verdictOf(observation: AccessObservation): OriginVerdict | undefined {
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
  return undefined;
}

const TITLE: Readonly<Record<OriginVerdict, string>> = {
  "wildcard-with-credentials":
    "Cross-origin sharing allows any origin with credentials (a wildcard the " +
    "Fetch standard forbids with credentials)",
  "null-with-credentials":
    "Cross-origin sharing allows the null origin with credentials, which a " +
    "sandboxed document can present",
};

const SEVERITY: Readonly<Record<OriginVerdict, "medium" | "high">> = {
  // Contradictory and browser-rejected as it stands, but a CORS layer that
  // emits it is not reasoning about credentials and is the kind that reflects a
  // real origin once the wildcard is gone.
  "wildcard-with-credentials": "medium",
  // Reachable from a browser as it stands: any script can run in a null-origin
  // document.
  "null-with-credentials": "high",
};

export function createCorsCheck(): Check {
  return {
    id: CORS_CHECK_ID,
    description:
      "Reads Access-Control-Allow-Origin and Access-Control-Allow-Credentials on " +
      "the cells under a declared origin condition, and reports the two origins " +
      "that are wrong with credentials whatever was asked: the wildcard and the " +
      "null origin. Reflection of an arbitrary origin is out of its reach and " +
      "out of its claim — see ADR-0076.",
    severity: "high",
    standards: [API_SECURITY_MISCONFIGURATION],
    run(context: CheckContext): readonly Finding[] {
      const contextByAccount = new Map(
        context.matrix.accounts.map((account) => [account.id, account.contextId]),
      );
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
        const verdict = verdictOf(observation);
        if (verdict === undefined) {
          continue;
        }
        const contextId = contextByAccount.get(observation.accountId);
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
      const perEndpoint = new Map<string, { responses: number; credentialed: number }>();
      for (const observation of context.matrix.observations) {
        if (ownHeader(observation.headers, ALLOW_ORIGIN_HEADER) === undefined) {
          continue;
        }
        const tally = perEndpoint.get(observation.endpointId) ?? { responses: 0, credentialed: 0 };
        tally.responses += 1;
        if (allowsCredentials(observation.headers)) {
          tally.credentialed += 1;
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
          },
        }));
    },
  };
}

/**
 * An HTTP client on the built-in global fetch.
 *
 * A separate undici is not installed: in Node 22 fetch already runs on top of
 * it, and we need neither interceptors nor connection pools.
 *
 * Limits built into the construction rather than left to call-site discipline:
 *
 * - The response body is **never stored**. By default it is not even read: the
 *   stream is cancelled to free the connection. Where a human declared
 *   `bodySignals`, it is read in transit and stays inside the extractor, which
 *   returns numbers and booleans only (ADR-0011) — so the path by which a body
 *   could reach the report is absent by type, not by discipline. This header
 *   said "never read" for a while after that stopped being true.
 * - A mandatory host allowlist. An empty list is an error, not "allow
 *   everything".
 * - Redirects are not followed (`redirect: "manual"`). Following a 3xx to
 *   another host would take the request outside the allowlist — that is SSRF
 *   around the check.
 * - Without explicit permission only the methods from `SAFE_METHODS` are
 *   performed.
 * - Response header **values** are kept by an allowlist and redacted otherwise.
 *   A denylist stood here first and was replaced: the names that will ever carry
 *   a secret cannot be enumerated, and `x-auth-token` on an unfamiliar platform
 *   would have gone into the report. The names are always kept — that a header
 *   is present is itself a signal.
 */

import type { HttpMethod } from "../core/types.js";
import { SAFE_METHODS } from "../core/types.js";
import { openRecord } from "../io/untrusted.js";
import type { HttpClient, HttpRequest, HttpResponse, Throttle } from "./ports.js";
import type { SignalExtractor } from "./signals.js";
import { createSignalExtractor } from "./signals.js";
import type { Clock } from "./throttle.js";
import { systemClock } from "./throttle.js";

/**
 * Response headers whose values are kept. **Everything else is redacted.**
 *
 * An allowlist, precisely, and not a denylist. Adversarial review showed that a
 * list of forbidden names is wrong structurally: `x-auth-token`,
 * `authentication-info`, `x-amz-security-token` and `x-user-email` with a
 * client's mail address all walked past it. Every name that will ever carry a
 * secret cannot be enumerated — but the few that are needed for a verdict about
 * access can be.
 *
 * The list is set here and is never taken from user input.
 */
const VALUE_PRESERVED_HEADERS: ReadonlySet<string> = new Set([
  "content-type",
  "content-length",
  "allow",
  "retry-after",
  "www-authenticate",
  // Added after a cold read of the report. Neither carries credentials, and both
  // were redacted for nothing — with direct damage to digging into a finding:
  //
  // `cache-control` changes the DAMAGE ESTIMATE of a cross-tenant leak: a
  // response with someone else's data and `public` is multiplied through a CDN,
  // and the blast radius is quite different.
  // `date` is the only handle for matching a finding against the server log.
  "cache-control",
  "date",
  // Transport noise with no secrets. The "redacted" mark on them created the
  // false impression that something sensitive had been there, and undermined
  // trust in the list as a whole: if these got in here, what else did?
  "connection",
  "keep-alive",
  "transfer-encoding",
  // Correlation with the platform's logs. Request identifiers are not
  // credentials: nothing can be presented with them, yet without them there is
  // nothing to match a finding against a record on the platform's side, and that
  // is the first thing the team that receives the ticket will ask for. Found by
  // the third cold read.
  "x-request-id",
  "x-correlation-id",
  "x-trace-id",
  "x-amzn-trace-id",
  "traceparent",
]);

/**
 * `location` is useful for digging into a 3xx, but its query and fragment carry
 * tokens: an OAuth redirect returns `access_token` in the fragment precisely. We
 * keep only the address without parameters.
 */
function sanitizeLocation(value: string): string {
  try {
    const url = new URL(value, "https://placeholder.invalid");
    const path = `${url.origin === "https://placeholder.invalid" ? "" : url.origin}${url.pathname}`;
    return url.search === "" && url.hash === "" ? path : `${path}?[REDACTED]`;
  } catch {
    return REDACTED;
  }
}

const REDACTED = "[REDACTED]";

export interface RetryPolicy {
  /** Attempts in total, the first one included. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
};

export interface BreakerPolicy {
  /** After how many consecutive failed responses the run stops. */
  readonly consecutiveFailures: number;
}

export const DEFAULT_BREAKER_POLICY: BreakerPolicy = { consecutiveFailures: 5 };

export const DEFAULT_TIMEOUT_MS = 15_000;

export class EmptyScopeError extends Error {
  constructor() {
    super(
      "No host allowlist was given. The tool does not run without an explicitly drawn " +
        "scope: a run against an undeclared host is not testing, it is scanning " +
        "someone else's system.",
    );
    this.name = "EmptyScopeError";
  }
}

export class HostNotAllowedError extends Error {
  readonly host: string;

  constructor(host: string) {
    super(`Host "${host}" is outside the declared scope`);
    this.name = "HostNotAllowedError";
    this.host = host;
  }
}

export class UnsupportedProtocolError extends Error {
  constructor(protocol: string) {
    super(`Protocol "${protocol}" is not supported: only http and https are allowed`);
    this.name = "UnsupportedProtocolError";
  }
}

export class UnsafeMethodError extends Error {
  readonly method: HttpMethod;

  constructor(method: HttpMethod) {
    super(
      `Method ${method} changes state and is forbidden by default. ` +
        `It is allowed only by explicitly enabling unsafe methods.`,
    );
    this.name = "UnsafeMethodError";
    this.method = method;
  }
}

export class CircuitOpenError extends Error {
  constructor(failures: number) {
    super(
      `The run stopped after ${failures} consecutive failed responses. ` +
        `Continuing would mean hammering a system that is already unwell.`,
    );
    this.name = "CircuitOpenError";
  }
}

/**
 * Strips from the address everything that may carry a secret.
 *
 * The text of the error lands in `failures[].reason`, that is, in the JSON
 * report. A full URL dragged query parameters (`?api_key=…`) and credentials
 * from userinfo in there.
 */
function safeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    const query = parsed.search === "" ? "" : "?[REDACTED]";
    return `${parsed.origin}${parsed.pathname}${query}`;
  } catch {
    return REDACTED;
  }
}

export class RequestFailedError extends Error {
  constructor(url: string, attempts: number, options?: { cause: unknown }) {
    super(`The request to "${safeUrl(url)}" failed after ${attempts} attempts`, options);
    this.name = "RequestFailedError";
  }
}

export interface HttpClientOptions {
  /** The hosts it is allowed to address. An empty list is rejected. */
  readonly allowedHosts: readonly string[];
  readonly throttle: Throttle;
  readonly allowUnsafeMethods?: boolean;
  readonly retry?: Partial<RetryPolicy>;
  readonly breaker?: Partial<BreakerPolicy>;
  readonly timeoutMs?: number;
  readonly clock?: Clock;
  /**
   * The extractor of signals over the body. The body is read only for those
   * requests where signals are declared explicitly; in all the others the stream
   * is cancelled unread, as it was before ADR-0011.
   */
  readonly signalExtractor?: SignalExtractor;
  /** The source of randomness for the jitter. Separate, so that tests are reproducible. */
  readonly random?: () => number;
}

const SAFE: ReadonlySet<string> = new Set<string>(SAFE_METHODS);

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Parses `Retry-After`: both in seconds and as an HTTP date. */
export function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (value === null) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return undefined;
  }

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    return seconds <= 0 ? 0 : seconds * 1000;
  }

  const timestamp = Date.parse(trimmed);
  if (Number.isNaN(timestamp)) {
    return undefined;
  }
  return Math.max(0, timestamp - now);
}

function toHttpResponse(response: Response): HttpResponse {
  // Without a prototype. A response header named `__proto__` assigned into a
  // plain object literal calls the prototype setter and vanishes — eighteen
  // lines below a comment promising that the name of a header is always kept,
  // because the presence of a header is itself a signal. Found by the audit of
  // 14 August (D-4). Nothing is validated here on purpose: the target chooses
  // these names, and refusing one would hand it a way to blind the run.
  const headers = openRecord<string>();
  response.headers.forEach((value, name) => {
    const key = name.toLowerCase();
    // The name is kept even for redacted ones: the fact that a header is present
    // is a signal for digging into the run, while its value is not.
    if (VALUE_PRESERVED_HEADERS.has(key)) {
      headers[key] = value;
    } else if (key === "location") {
      headers[key] = sanitizeLocation(value);
    } else {
      headers[key] = REDACTED;
    }
  });
  return { status: response.status, headers };
}

export function createHttpClient(options: HttpClientOptions): HttpClient {
  const allowedHosts = new Set(options.allowedHosts.map((host) => host.trim().toLowerCase()));
  allowedHosts.delete("");
  if (allowedHosts.size === 0) {
    throw new EmptyScopeError();
  }

  const retry: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...options.retry };
  const breaker: BreakerPolicy = { ...DEFAULT_BREAKER_POLICY, ...options.breaker };
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const clock = options.clock ?? systemClock;
  const random = options.random ?? Math.random;
  const allowUnsafeMethods = options.allowUnsafeMethods ?? false;
  const signalExtractor = options.signalExtractor ?? createSignalExtractor();

  let consecutiveFailures = 0;
  let circuitOpen = false;

  function assertRequestAllowed(request: HttpRequest): void {
    if (!allowUnsafeMethods && !SAFE.has(request.method)) {
      throw new UnsafeMethodError(request.method);
    }

    const url = new URL(request.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new UnsupportedProtocolError(url.protocol);
    }
    // An entry with a port is matched together with the port, one without a port
    // by name only. So "api.test" still allows any port, while "api.test:8443"
    // allows exactly one, and the scope can be narrowed without breaking already
    // written configurations.
    const hostname = url.hostname.toLowerCase();
    const hostWithPort = url.host.toLowerCase();
    if (!allowedHosts.has(hostname) && !allowedHosts.has(hostWithPort)) {
      throw new HostNotAllowedError(hostWithPort);
    }
  }

  function backoffFor(attempt: number): number {
    const exponential = retry.baseDelayMs * 2 ** (attempt - 1);
    const capped = Math.min(retry.maxDelayMs, exponential);
    // Full jitter: without it parallel attempts retry in lockstep.
    return Math.round(capped * random());
  }

  async function attemptOnce(request: HttpRequest, signal?: AbortSignal): Promise<HttpResponse> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const composed = signal === undefined ? timeout : AbortSignal.any([timeout, signal]);

    const response = await fetch(request.url, {
      method: request.method,
      headers: { ...request.headers },
      // The redirect is not followed: a 3xx to a foreign host would get around
      // the allowlist.
      redirect: "manual",
      signal: composed,
    });

    const result = toHttpResponse(response);

    const specs = request.signals ?? [];
    if (specs.length === 0) {
      // The body is not read: it holds PII. The stream is cancelled to free the
      // connection.
      await response.body?.cancel();
      return result;
    }

    // The body is read in transit and stays inside the extractor. Only scalars
    // go outward: the `SignalValue` type physically cannot hold the content.
    const signals = await signalExtractor.extract(response.body, specs);
    return { ...result, signals };
  }

  return {
    async send(request: HttpRequest, signal?: AbortSignal): Promise<HttpResponse> {
      assertRequestAllowed(request);
      if (circuitOpen) {
        throw new CircuitOpenError(breaker.consecutiveFailures);
      }

      let lastCause: unknown;

      /**
       * A request counts as failed once, not on every attempt.
       *
       * The counter used to grow inside the retry loop, and with the defaults
       * (3 attempts, threshold 5) the run stopped after **two** failed requests
       * instead of five. The threshold is described as "consecutive failed
       * responses" — which means responses must be counted, not our own attempts
       * to get them.
       */
      function markFailure(): void {
        consecutiveFailures += 1;
        if (consecutiveFailures >= breaker.consecutiveFailures) {
          circuitOpen = true;
        }
      }

      for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
        let response: HttpResponse | undefined;
        try {
          response = await options.throttle.run(() => attemptOnce(request, signal));
        } catch (cause) {
          lastCause = cause;
        }

        if (response !== undefined && !isRetryableStatus(response.status)) {
          consecutiveFailures = 0;
          return response;
        }

        if (attempt === retry.maxAttempts) {
          markFailure();
          if (circuitOpen) {
            throw new CircuitOpenError(breaker.consecutiveFailures);
          }
          if (response !== undefined) {
            return response;
          }
          break;
        }

        const advised =
          response === undefined
            ? undefined
            : parseRetryAfter(response.headers["retry-after"] ?? null, clock.now());
        // The server's instruction outranks our formula — but not our own
        // ceiling. Without that bound a huge Retry-After removed the delay
        // entirely: setTimeout clamps values above 2^31-1 ms down to one
        // millisecond, and three attempts went through in a matter of
        // milliseconds instead of an exponential backoff.
        const retryAfter = advised === undefined ? undefined : Math.min(advised, retry.maxDelayMs);
        await clock.sleep(retryAfter ?? backoffFor(attempt));
      }

      throw new RequestFailedError(request.url, retry.maxAttempts, { cause: lastCause });
    },
  };
}

/**
 * Adapter ports: interfaces only, no implementations.
 *
 * The core depends on these types, but never on concrete HTTP clients and
 * parsers. Replacing the client or the parser must not touch src/core.
 * The implementations will arrive in session 3.
 */

import type { Endpoint, HttpMethod, SignalSpec, SignalValue } from "../core/types.js";
import type { HeaderValue } from "../io/untrusted.js";

export type { SignalSpec, SignalValue };

export interface HttpRequest {
  readonly method: HttpMethod;
  readonly url: string;
  /**
   * Checked values, not any strings.
   *
   * The brand is what makes the guarantee reach a consumer of the library. The
   * CLI path validated header names and values on the way in; a caller building
   * a request by hand went past all four checks and got
   * `RequestFailedError: Cannot convert argument to a ByteString` out of the
   * retry loop, after three attempts, naming neither the header nor the account.
   * `safeHeaders` in `src/io/untrusted.ts` is now the only way to obtain this
   * type. Found by the audit of 14 August 2026 (D-6).
   */
  readonly headers: Readonly<Record<string, HeaderValue>>;
  /**
   * The signals for the sake of which the body will be read. Empty or absent —
   * the stream is cancelled unread, as it was before ADR-0011.
   */
  readonly signals?: readonly SignalSpec[];
}

/**
 * A response without a body.
 *
 * This is not an oversight: bodies are not stored, because they contain PII. The
 * port gives no way to smuggle them through "by accident" — there simply is no
 * field for a body, and `signals` by its type holds nothing but scalars.
 */
export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly signals?: Readonly<Record<string, SignalValue>>;
}

export interface HttpClient {
  send(request: HttpRequest, signal?: AbortSignal): Promise<HttpResponse>;
}

export interface SpecParser {
  /**
   * Parses a specification into a list of endpoints.
   *
   * `source` is the **text of the document**, not a path to a file. Reading the
   * file stays with `src/io`: a parser with nothing to open cannot become a
   * primitive for path traversal.
   *
   * The implementation must switch off the resolution of external `$ref`s —
   * both over http and through the file system. That is a defence against SSRF
   * and path traversal, not an optimization. A test that proves this behaviour
   * is mandatory.
   */
  parse(source: string): Promise<readonly Endpoint[]>;
}

/**
 * How an account presents itself to the system under test.
 *
 * A port rather than a constant in the code: real platforms diverge here
 * categorically — a JWT in `Authorization`, a key in a header of its own, a
 * session in a cookie, Basic. Binding to a single scheme made the tool
 * inapplicable to most APIs.
 */
export interface CredentialProvider {
  /**
   * The headers for a request made as the account.
   *
   * An empty set means a request without credentials, that is, an anonymous one.
   *
   * `request` is passed because credentials are not always static: an HMAC
   * signature over the method and the path is the norm in fintech, and a
   * provider that knows only the account identifier cannot express it in
   * principle. The signature format is platform-specific (SigV4, Stripe-like,
   * homegrown), and its general shape is not described in the configuration; but
   * the port must **allow** a signature, otherwise it is unreachable for a
   * consumer of the library as well. See ADR-0018.
   *
   * The four built-in schemes ignore the argument: their header is the same for
   * every request of the account.
   */
  headersFor(accountId: string, request: SignedRequest): Readonly<Record<string, HeaderValue>>;
}

/**
 * What the provider knows about the request it issues headers for.
 *
 * There is no body here: the tool does not send them. Once sending appears, a
 * body will be added here, and that will be a decision of its own, not a silent
 * extension.
 */
/**
 * What the adapters need to know about an account under declared request conditions.
 *
 * The core makes do with the `contextId` label; the headers and query parameters
 * live here, because the core knows nothing about HTTP. See ADR-0019.
 */
export interface ContextAttributes {
  readonly contextId: string;
  readonly headers: Readonly<Record<string, HeaderValue>>;
  readonly query: Readonly<Record<string, string>>;
}

export interface SignedRequest {
  readonly method: string;
  /** The full address of the request, with path parameters already substituted. */
  readonly url: string;
}

export interface Throttle {
  /** Lets a task through the concurrency and rate limits. */
  run<T>(task: () => Promise<T>): Promise<T>;
  /**
   * The limits the implementation declares to be in force.
   *
   * The report needs them: otherwise the invariant "throttling is always on" has
   * to be taken on trust. Optional, because someone else's implementation may
   * count differently — and then absence is more honest than invented numbers.
   */
  readonly limits?: {
    readonly concurrency: number;
    readonly requestsPerSecond: number;
    readonly maxRequests: number;
  };
}

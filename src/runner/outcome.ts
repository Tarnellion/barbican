/**
 * What came back, and what follows from it — which is usually nothing.
 *
 * `ProbeFailure.reason` has exactly two sources and they are both here: a status
 * this tool does not read, and an error that arrived instead of a status. The
 * type's own comment says why the field is mandatory, and
 * `unreadableStatusReason` was written to satisfy that sentence — so the two are
 * in one file, where the sentence is still about the file it is in.
 *
 * The list of statuses is likewise read twice, by `classifyStatus` and by the
 * reason it produces for the ones it cannot read. Splitting the two would put
 * that list on either side of a boundary.
 */

import type { AccessOutcome } from "../core/index.js";

/**
 * A failed request, with its reason.
 *
 * The reason is mandatory: an `error` with no explanation makes it impossible to
 * tell a deployment that is down from a wrong configuration, and such an entry
 * is useless in the report.
 */
export interface ProbeFailure {
  readonly accountId: string;
  readonly endpointId: string;
  readonly resourceId?: string;
  readonly reason: string;
}

/**
 * Reduces the response status to a conclusion about access.
 *
 * A conclusion is drawn only where it is unambiguous. Everything else —
 * including 3xx, 4xx other than the ones listed, and 5xx — is an `error`:
 * "cannot be judged". Stretching `denied` over them would mean recording the
 * absence of a conclusion as a successful denial, and such records are later
 * read as proof of protection.
 *
 * 451 is a denial on equal terms with 401 and 403. It is never ambiguous:
 * "unavailable for legal reasons" is a decision not to serve, not a failure and
 * not a missing resource. Added together with request conditions (ADR-0019): geo
 * and jurisdiction restrictions answer with exactly this, and without this line a
 * healthy platform would give a wall of `probe-error` right where it works
 * correctly.
 *
 * **The assumption this whole function rests on**: the platform states the
 * outcome in the status code. One that answers `200` with an error envelope in
 * the body is read as granting access everywhere, and every denied cell of the
 * policy becomes a privilege escalation — a hundred per cent false positives,
 * which is the risk `plan.md` names first.
 *
 * The body checks do not stand outside it, which is not obvious and was measured
 * rather than reasoned: they run on cells whose `outcome` is `allowed`, and here
 * that is every cell, so two accounts in different tenants both **refused** with
 * the same envelope produce equal digests and a cross-tenant leak that is not
 * there. Six cells, four false escalations, one false leak, exit code 1.
 *
 * There is no way to declare "a refusal looks like this" today. The limitation is
 * written down in the README, in `docs/guide.md` and in `docs/report.md` rather
 * than left for the reader of a bad report to work out. See L-3.
 *
 * **410 joins 404**, and that is the one line of this list that moved since. It
 * says what 404 says and says it harder — the resource was not served, and it
 * will not be. The reason `toBinary` gives for folding `not-found` into a denial
 * holds here word for word: telling "410 instead of 403, to hide existence" from
 * "the object really is gone" needs to know that the object exists, and that
 * belongs to the checks rather than to the base diff. As an `error` such a cell
 * was lost quietly, as a low-severity `probe-error` outside the exit code, on a
 * request the platform had in fact refused. See ADR-0046.
 *
 * **The rest of the list stays unreadable, and the classes are named rather than
 * left to be rediscovered.** None of them can be fixed here: each needs the
 * operator to declare something this tool must not derive from the system under
 * test (ADR-0006).
 *
 * - **A refusal that redirects.** A console on a session cookie answers a
 *   refused caller with `302 Location: /login`, not with 403 — and redirects are
 *   not followed, so what is behind it was never fetched. Every denied cell of
 *   such a surface is an `error` here. Reading a 3xx as a denial would be a
 *   guess at somebody else's convention; what it needs is a declaration of what
 *   this platform refuses with.
 * - **An outcome that is not final.** `202` is "accepted, the answer comes
 *   later". A platform that queues the request and refuses it in a worker is
 *   read here as having granted access, and a cell the policy denies becomes a
 *   privilege escalation where there was a refusal arriving late.
 * - **A delete that only hides the object.** Soft delete makes 404 and 410
 *   indistinguishable from a refusal for everyone, including the accounts that
 *   should have been served.
 * - **An answer about the endpoint rather than the account.** `405` says this
 *   method is not offered here. Nothing about who asked.
 *
 * What the run does do for all of them: a cell whose status this function cannot
 * read leaves a row in `failures` saying so. The conclusion is still not drawn —
 * the run merely stops being silent about what it discarded.
 */
export function classifyStatus(status: number): AccessOutcome {
  if (status >= 200 && status < 300) {
    return "allowed";
  }
  if (status === 401 || status === 403 || status === 451) {
    return "denied";
  }
  if (status === 404 || status === 410) {
    return "not-found";
  }
  return "error";
}

/**
 * Why nothing follows from this cell, in words for the report.
 *
 * `ProbeFailure` requires a reason because "an `error` with no explanation makes
 * it impossible to tell a deployment that is down from a wrong configuration".
 * That held for a thrown request and for the self-inflicted 404, and not for the
 * commonest way of earning an `error`: a status this tool does not read. Such a
 * cell used to leave an `error` outcome and no row at all, so `summary.failures`
 * stayed 0 and the CLI printed no line about it either.
 *
 * The 3xx sentence is separate because it is the only one that names something
 * the report cannot show on its own. The status is already in the row; that a
 * redirect was not followed, and that a sign-in redirect is how a whole class of
 * surface refuses, is not.
 */
export function unreadableStatusReason(status: number): string {
  if (status >= 300 && status < 400) {
    return (
      `Status ${status} is a redirect, and a redirect is not an outcome: they are ` +
      `not followed, so whatever stands behind it was never fetched. A console on ` +
      `a session cookie refuses by sending the caller to its sign-in page and ` +
      `answers exactly this — if that is this surface, the run counted no denial ` +
      `here. See "The statuses this tool cannot read" in docs/guide.md.`
    );
  }
  return (
    `Status ${status} is not one this tool reads as an outcome: access is concluded ` +
    `from 2xx, from 401, 403 and 451, and from 404 and 410. Nothing follows about ` +
    `this cell. See "The statuses this tool cannot read" in docs/guide.md.`
  );
}

/**
 * The transport failure's code, if the error carries one.
 *
 * `fetch` wraps the cause: the outer error is an unhelpful `TypeError: fetch
 * failed`, and the code sits one or two levels down.
 */
export function failureCode(error: unknown): string | undefined {
  for (const link of causeChain(error)) {
    const code = (link as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code)) {
      return code;
    }
  }
  return undefined;
}

/**
 * The error and everything it wraps, outermost first.
 *
 * Bounded rather than looping until `cause` runs out: a cycle would hang the
 * run, and nothing useful sits four wrappers deep.
 */
function* causeChain(error: unknown, limit = 4): Generator<unknown> {
  let current = error;
  for (let depth = 0; current !== undefined && current !== null && depth < limit; depth += 1) {
    yield current;
    current = (current as { cause?: unknown }).cause;
  }
}

/**
 * The names by which a client says "the walk cannot go on" rather than "this one
 * request failed".
 *
 * By name, because the runner sits above the ports and must not know the classes
 * of any particular client: `instanceof` here would tie it to one implementation
 * of `HttpClient`, which is the thing the port exists to prevent.
 */
const TERMINAL_ERROR_NAMES: ReadonlySet<string> = new Set([
  "RunBudgetExhaustedError",
  "CircuitOpenError",
]);

/**
 * Whether a failure cut the walk short.
 *
 * The whole chain is examined, not the outermost error. Found by the audit of 14
 * August: the client wraps everything in `RequestFailedError` before it leaves
 * (`http.ts`), and a match on the outer name therefore never saw
 * `RunBudgetExhaustedError` at all. An exhausted budget left three cells unprobed
 * and reported `truncated: false`, exit 0 — a clean verdict over a tail nobody
 * looked at.
 *
 * `CircuitOpenError` was recognised only because it happens to be thrown
 * directly, which is what made the defect look closed: past five consecutive
 * failures the breaker trips and sets the flag for its own reasons, so only the
 * last four cells of a run ever showed the fault.
 */
export function terminalCause(error: unknown): Error | undefined {
  for (const link of causeChain(error)) {
    if (link instanceof Error && TERMINAL_ERROR_NAMES.has(link.name)) {
      return link;
    }
  }
  return undefined;
}

/** What to write in `failures[].reason`. */
export function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A setup call that a container can refuse once while it is still warming up.
 *
 * Written for VAmPI's `GET /createdb`. Its banner endpoint answers before the
 * database layer is ready — `GET /` touches no database — so provisioning could
 * ask for the schema a moment too early and get a 500. The run then failed at
 * setup, and re-running it worked.
 *
 * Measured on 18 August 2026 by bringing the container up cold 31 times and
 * calling `/createdb` the instant the banner answered: one 500, which was a 200
 * a second later. Roughly three per cent, which is exactly often enough to lose
 * a run and rare enough that nobody ever catches it in the act. The cause was
 * not captured — the failing run could not be reproduced again with the
 * container log in hand, and guessing at it here would be the kind of claim this
 * repository keeps having to correct.
 *
 * The retry is bounded and it is **not silent**: the caller is handed the number
 * of attempts it took, so that a deployment which needs three every time says so
 * instead of looking healthy. That is the whole reason this is a helper and not
 * a loop written inline — a retry nobody counts turns a broken polygon into a
 * slow one.
 *
 * Safe to retry only where the work is idempotent, which is the caller's to
 * know. `/createdb` qualifies by construction: it drops the schema and creates
 * it again.
 */

/**
 * Not everything that fails is cold.
 *
 * `retryable` exists because the first caller got this wrong. Registration
 * against Juice Shop was wrapped without it, and a second run answered 400
 * "email must be unique" — a definitive answer, repeated five times before the
 * error the operator needed finally surfaced. A 4xx is the server saying what it
 * thinks; only a 5xx or a refused connection is the server not being ready.
 *
 * The default retries everything, because the caller that needs no distinction
 * should not have to write one, and because a predicate that silently skips
 * retries is worse than a few wasted ones.
 *
 * @template T
 * @param {() => Promise<T>} work what to do, throwing when it did not take
 * @param {{ attempts?: number, delayMs?: number, retryable?: (error: unknown) => boolean }} [limits]
 * @returns {Promise<{ value: T, taken: number }>} the result, and how many
 *   attempts it cost — 1 when it worked the first time
 */
export async function throughColdStart(work, limits = {}) {
  const { attempts = 5, delayMs = 500, retryable = () => true } = limits;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError(`attempts must be a positive integer, got ${attempts}`);
  }
  // Validated for the same reason `attempts` is, and it was not. A caller asking
  // for a long pause and getting none has a hot loop against a cold container:
  // 2**31 overflows `setTimeout` to 1 ms, a negative fires immediately, and NaN
  // does too. Three ways to turn a wait into five requests in as many
  // milliseconds.
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new RangeError(`delayMs must be a non-negative finite number, got ${delayMs}`);
  }

  for (let taken = 1; ; taken += 1) {
    try {
      return { value: await work(), taken };
    } catch (error) {
      // The last failure is thrown as it came: a wrapper here would bury the
      // reason the setup gave, and that reason is the whole diagnosis when the
      // deployment is genuinely broken rather than cold.
      // The predicate is asked inside a guard of its own. Called bare, a predicate
      // that throws — `e.response.status` against a `fetch` TypeError, or the
      // `(error) => !error.definitive` shape this repository's own test uses,
      // against a `null` thrown by `await response.json()` on an empty body —
      // replaces the failure the caller needed with its own. That is the one
      // property this helper exists to keep.
      let again = taken < attempts;
      if (again) {
        try {
          again = retryable(error);
        } catch {
          again = false;
        }
      }
      if (!again) {
        throw error;
      }
      await new Promise((done) => setTimeout(done, delayMs));
    }
  }
}

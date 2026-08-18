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
 * @template T
 * @param {() => Promise<T>} work what to do, throwing when it did not take
 * @param {{ attempts?: number, delayMs?: number }} [limits]
 * @returns {Promise<{ value: T, taken: number }>} the result, and how many
 *   attempts it cost — 1 when it worked the first time
 */
export async function throughColdStart(work, limits = {}) {
  const { attempts = 5, delayMs = 500 } = limits;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError(`attempts must be a positive integer, got ${attempts}`);
  }

  for (let taken = 1; ; taken += 1) {
    try {
      return { value: await work(), taken };
    } catch (error) {
      // The last failure is thrown as it came: a wrapper here would bury the
      // reason the setup gave, and that reason is the whole diagnosis when the
      // deployment is genuinely broken rather than cold.
      if (taken >= attempts) {
        throw error;
      }
      await new Promise((done) => setTimeout(done, delayMs));
    }
  }
}

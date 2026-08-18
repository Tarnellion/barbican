/**
 * Retrying a cold container's refusal, without turning a broken one into a slow one.
 *
 * VAmPI's `GET /createdb` fails at about three per cent of cold starts — measured
 * on 18 August 2026 over 31 runs, one 500 that was a 200 a second later — and
 * provisioning threw on the first non-200, so the run died at setup.
 *
 * Two properties, and the second is the one worth the file. Retrying is easy; the
 * trap is a retry nobody counts, which makes a deployment that fails four times
 * out of five indistinguishable from a healthy one.
 */

import { describe, expect, it } from "vitest";
import { throughColdStart } from "../../tools/cold-start.mjs";

const NO_WAIT = { delayMs: 0 };

describe("a setup call against a container still warming up", () => {
  it("passes the value through when it works the first time", async () => {
    const result = await throughColdStart(async () => "schema", NO_WAIT);

    expect(result.value).toBe("schema");
    expect(result.taken).toBe(1);
  });

  it("retries a refusal and says how many attempts it cost", async () => {
    let calls = 0;
    const result = await throughColdStart(async () => {
      calls += 1;
      if (calls < 3) {
        throw new Error("GET /createdb returned 500");
      }
      return "schema";
    }, NO_WAIT);

    expect(result.value).toBe("schema");
    // Not a boolean "it retried": a deployment that needs three attempts every
    // time is broken, and the only way that shows is the number reaching a caller.
    expect(result.taken).toBe(3);
  });

  /**
   * The last failure arrives as it was thrown. A wrapper would bury the status
   * the setup reported, and that status is the entire diagnosis when the
   * container is broken rather than cold.
   */
  it("gives up after the bound, throwing what the work threw", async () => {
    let calls = 0;
    const attempt = throughColdStart(
      async () => {
        calls += 1;
        throw new Error(`GET /createdb returned 500 (call ${calls})`);
      },
      { attempts: 4, delayMs: 0 },
    );

    await expect(attempt).rejects.toThrow("GET /createdb returned 500 (call 4)");
    expect(calls).toBe(4);
  });

  /**
   * Found by using it. Registration against Juice Shop was wrapped without a
   * predicate, and a second run answered 400 "email must be unique" — a
   * definitive answer, retried five times before the error the operator needed
   * reached them. A 4xx is the server saying what it thinks; a 5xx or a refused
   * connection is the server not being ready.
   */
  it("does not repeat a failure the caller calls definitive", async () => {
    let calls = 0;
    const attempt = throughColdStart(
      async () => {
        calls += 1;
        throw Object.assign(new Error("email must be unique"), { definitive: true });
      },
      {
        attempts: 5,
        delayMs: 0,
        retryable: (error) => !(error as { definitive?: boolean }).definitive,
      },
    );

    await expect(attempt).rejects.toThrow("email must be unique");
    expect(calls).toBe(1);
  });

  it("still repeats one the predicate lets through", async () => {
    let calls = 0;
    const result = await throughColdStart(
      async () => {
        calls += 1;
        if (calls < 2) {
          throw Object.assign(new Error("503"), { definitive: false });
        }
        return "ok";
      },
      {
        attempts: 5,
        delayMs: 0,
        retryable: (error) => !(error as { definitive?: boolean }).definitive,
      },
    );

    expect(result.taken).toBe(2);
  });

  it("tries exactly once when asked for one attempt", async () => {
    let calls = 0;
    await expect(
      throughColdStart(
        async () => {
          calls += 1;
          throw new Error("no");
        },
        { attempts: 1, delayMs: 0 },
      ),
    ).rejects.toThrow("no");

    expect(calls).toBe(1);
  });

  /**
   * A bound of zero would mean "never try", which is not a cautious setting but a
   * call that silently does nothing. Refused rather than clamped: a caller asking
   * for it has made a mistake worth hearing about.
   */
  it("refuses a bound below one instead of quietly doing nothing", async () => {
    let calls = 0;
    await expect(
      throughColdStart(
        async () => {
          calls += 1;
        },
        { attempts: 0 },
      ),
    ).rejects.toThrow(RangeError);

    expect(calls).toBe(0);
  });
});

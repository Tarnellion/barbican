/**
 * `--dry-run`: what a run would do, told before the first request exists.
 *
 * Its own module because it is the one part of this entry point that must not
 * touch the platform, and the polygon proves that the only way that admits no
 * argument — by previewing a configuration whose deployment is not running. A
 * file that cannot reach the network is a file where that promise is visible.
 */

import type { RunIdentity } from "../adapters/http.js";
import type { ThrottleLimits } from "../adapters/throttle.js";
import type { Check, Endpoint } from "../core/index.js";
import { resourceApplies } from "../core/index.js";
import type { RunConfig } from "../io/config.js";
import { toAccounts } from "../io/config.js";
import { planEndpoints } from "../runner.js";
import { accountsOwedACanary } from "./canaries.js";
import type { RunFlags } from "./flags.js";
import { paint, SKIP_REASONS, WARNING_STYLE } from "./screen.js";

/**
 * What a run would do, printed without touching the platform.
 *
 * Two things sent a cold read of 14 August guessing. The identifiers: with
 * `--spec` they come from `operationId`, and the reader recovered them by
 * running against the platform and reading `endpoints[]` out of the report —
 * a probe of someone else's deployment to answer a question about a local file.
 * And the skips: which endpoints a run will leave alone is a fair question to
 * ask before the run, not after.
 *
 * The plan comes from `planEndpoints`, the same function the run itself uses.
 * A preview computed separately would agree with reality only until one of the
 * two was edited.
 */
export function describePlan(
  config: RunConfig,
  endpoints: readonly Endpoint[],
  flags: RunFlags,
  checks: readonly Check[],
  limits: ThrottleLimits | undefined,
  contextValues: Parameters<typeof toAccounts>[1],
  identity: RunIdentity | undefined,
  /** Cells a stream beside `--report` already holds, and which `--resume` will not probe. */
  alreadyWalked: number,
): number {
  const tenantBaseUrls = new Map(
    (config.tenants ?? [])
      .filter((tenant) => tenant.baseUrl !== undefined)
      .map((tenant) => [tenant.id, tenant.baseUrl ?? ""]),
  );
  const { probeable, skipped } = planEndpoints({
    endpoints,
    baseUrl: config.target.baseUrl,
    resources: config.resources,
    ...(config.exclude === undefined ? {} : { exclude: config.exclude }),
    allowUnsafeMethods: flags.unsafeMethods === true,
    tenantBaseUrls,
  });

  const byId = new Map(skipped.map((entry) => [entry.endpointId, entry.reason]));
  const rows = endpoints.map((endpoint) => {
    const reason = byId.get(endpoint.id);
    const mark =
      reason === undefined
        ? paint("probe", "green")
        : `${paint("skip", "yellow")}: ${SKIP_REASONS[reason]?.long ?? reason}`;
    return `  ${endpoint.id}  (${endpoint.method} ${endpoint.path})  ${mark}`;
  });

  // An endpoint without parameters costs one request; one with parameters, a
  // request per resource that covers them. Counted the way the run counts it —
  // and counted once per endpoint rather than once per account × endpoint.
  //
  // The audit of 14 August measured the difference: at 1600 endpoints, 41
  // accounts and 320 resources the preview made 20 992 000 calls to
  // `resourceApplies` and took 5.48 s, while the real run of the same
  // configuration reached its first request in 0.606 s. A dry run that costs
  // nine times more than starting the thing it previews is not a pre-flight
  // check, and this is the flag people are told to use first on someone else's
  // deployment.
  const cost = new Map<string, number>(
    endpoints.map((endpoint) => [
      endpoint.id,
      Math.max(
        config.resources.filter((resource) => resourceApplies(endpoint, resource)).length,
        1,
      ),
    ]),
  );
  const costOf = (endpoint: Endpoint): number => cost.get(endpoint.id) ?? 1;

  // A row under conditions walks only the endpoints its context names — that is
  // why a context has to name them. An estimate that ignored this overstated the
  // matrix by roughly a factor of two, and a wrong number about traffic is worse
  // on someone else's deployment than no number at all.
  const contextEndpoints = new Map(
    config.contexts.map((context) => [context.id, new Set(context.endpointIds)]),
  );
  const { accounts } = toAccounts(config, contextValues);
  const cells = accounts.reduce((total, account) => {
    const named =
      account.contextId === undefined ? undefined : contextEndpoints.get(account.contextId);
    const reachable =
      named === undefined ? probeable : probeable.filter((one) => named.has(one.id));
    return total + reachable.reduce((sum, endpoint) => sum + costOf(endpoint), 0);
  }, 0);

  const withCanary = config.accounts.filter((account) => account.canary !== undefined).length;
  const withoutCanary = accountsOwedACanary(config);
  const budget = limits?.maxRequests;
  // Twice: the canaries are probed before the walk and again after it
  // (`probeCanaries` is called at both ends). Counting them once made the
  // preview call a ceiling sufficient that stops the second pass — and a run
  // whose authentication is never confirmed a second time reads as clean. The
  // rule this line stands on is three lines below: a number about traffic that
  // ignores the ceiling on traffic is worse than no number.
  //
  // The cells a resumed run will not probe again come off it for the same
  // reason. A preview that counted them would overstate the traffic by exactly
  // the amount the feature exists to save.
  const remaining = Math.max(cells - alreadyWalked, 0);
  const wanted = remaining + withCanary * 3;

  process.stderr.write(
    `${[
      `${paint("Dry run:", "green")} nothing was sent to ${config.target.baseUrl}.`,
      `Target: ${config.target.label ?? paint("unnamed", "yellow")}`,
      `Endpoints (${endpoints.length}):`,
      ...rows,
      `Matrix rows: ${accounts.length} (declared accounts ${config.accounts.length})`,
      `Cells a run would probe: ${remaining}, plus ${withCanary * 3} canary requests ` +
        `(${withCanary} accounts, probed before the walk and again after it, plus ` +
        `one request each with no credentials to show the canary tells them apart)`,
      // What --resume takes off the bill, named rather than left to be worked
      // out from a number that shrank.
      alreadyWalked === 0
        ? undefined
        : `Of the ${cells} cells in this matrix, ${alreadyWalked} are already in the ` +
          `stream and would not be probed again.`,
      // The budget is on the same command line and used to be left out of the
      // arithmetic: the preview promised 144 cells where the run made one
      // request and stopped. A number about traffic that ignores the ceiling on
      // traffic is worse than no number.
      budget !== undefined && wanted > budget
        ? paint(
            `Only ${budget} of those ${wanted} requests fit the budget: the run stops ` +
              `at --max-requests and reports truncated, so the tail of the matrix ` +
              `stays untested. Raise --max-requests or narrow the run.`,
            "yellow",
          )
        : undefined,
      // The most expensive pre-flight defect is the one the pre-flight check does
      // not mention. Without a canary the run cannot confirm it authenticated at
      // all and ends with exit 2 whatever the platform answered — after the whole
      // matrix has been walked.
      withoutCanary.length > 0
        ? paint(
            `No canary is declared for: ${withoutCanary.join(", ")}. The run will walk ` +
              `the whole matrix and then exit 2: nothing would confirm those accounts ` +
              `were authenticated, and every cell walked under one of them would say ` +
              `what an unauthenticated request says. Declare ` +
              `"canary: <endpointId>" on each account that has credentials.`,
            // The same colour the finished run's warning gets. They said the same
            // thing in two colours until 19 August, and a reader who sees red on
            // the preview and yellow on the run reads them as two different
            // conditions.
            WARNING_STYLE.noCanary,
          )
        : undefined,
      // A pipeline that publishes the report after a dry run publishes
      // yesterday's, and nothing said so. The path is still checked — that is
      // G-8 — it is just never written to.
      flags.report === undefined
        ? undefined
        : paint(
            `--report is not written by a dry run: ${flags.report} is left as it was. ` +
              `Anything reading it afterwards reads the previous run.`,
            "yellow",
          ),
      // Which checks will run, because `--checks` can leave one out and a check
      // left out is coverage left out. Named here for the same reason the
      // endpoint list is: the preview has to answer "what exactly will you do"
      // before the first request, not after.
      checks.length === 0
        ? paint("Checks: none will run — nothing will be compared by body.", "yellow")
        : `Checks: ${checks.map((check) => check.id).join(", ")}`,
      // What the platform's access log will hold, before the first line of it
      // exists. "What exactly are you going to touch" and "how will I recognise
      // it in my own records" are the same question asked by the same person,
      // and the second one is answerable here for free.
      identity === undefined
        ? paint(
            `The run will not name itself on the wire: --no-identify was given, so ` +
              `the requests are indistinguishable from an attack in the platform's ` +
              `logs. Agree with the owner how they are to be recognised.`,
            "yellow",
          )
        : `Named on the wire as: ${identity.value} (a fresh run= identifier each ` +
          `run, and the report carries the same one)`,
      `The identifiers above are what policy, resources, contexts and canaries refer to.`,
      // The same filter the run's summary applies in `screen.ts`. Without it
      // every warning this preview decided not to print left a blank line in the
      // middle of the plan — three of them on an ordinary configuration.
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n")}\n`,
  );

  return 0;
}

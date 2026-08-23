/**
 * One run, from the declaration on the command line to the exit code.
 *
 * What is left here after the screen, the files, the preview, the canaries and
 * the stream have been given modules of their own: the order the steps happen
 * in, and the reasons that order is what it is. Nearly every comment below is
 * about a line's **position** — validation before the first request, the report
 * path before the traffic, the canaries before the preview claims to have
 * checked everything, the second canary pass after the walk — so this module is
 * the sequence and little else.
 *
 * Security limits are not implemented here, only configured: the mandatory host
 * allowlist, the ban on unsafe methods, throttling and the refusal to follow
 * redirects live in the HTTP client and hold whatever the CLI passes in.
 */

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { constants as signalNumbers } from "node:os";
import { createCredentialProvider } from "../adapters/credentials.js";
import { createEndpointListParser } from "../adapters/endpoint-list.js";
import { createHttpClient, runIdentity } from "../adapters/http.js";
import { createOpenApiParser } from "../adapters/openapi.js";
import type { SpecParser } from "../adapters/ports.js";
import { createPostmanCollectionParser } from "../adapters/postman.js";
import { createSignalExtractor } from "../adapters/signals.js";
import { createThrottle } from "../adapters/throttle.js";
import type { RunScope } from "../core/index.js";
import {
  buildAccessMatrix,
  CheckRegistry,
  createIdenticalResponseCheck,
  describeChecks,
  describeMatrix,
  expandPolicy,
  runChecks,
} from "../core/index.js";
import {
  applyBodySignals,
  assertContextsCannotWrite,
  assertReferencesResolve,
  parseRunConfig,
  resolveContextValues,
  resolveTokens,
  toAccounts,
} from "../io/config.js";
import { findUnauthenticated } from "../report/authenticity.js";
import type { RunReport } from "../report/build.js";
import { buildReport, runVerdict, WARNINGS } from "../report/build.js";
import type { ObservationStream } from "../report/write.js";
import { declarationDigest, observationStreamPath, reportChunks } from "../report/write.js";
import type { CellRecord } from "../runner.js";
import { assertCanariesUsable, collectObservations } from "../runner.js";
import {
  accountsOwedACanary,
  type CanaryPass,
  confirmAfterWalk,
  declaredCanaries,
  probeBeforeWalk,
} from "./canaries.js";
import {
  assertReportPathIsWritable,
  readNamedFile,
  writeChunks,
  writeReportFile,
} from "./files.js";
import type { RunFlags } from "./flags.js";
import { describePlan } from "./preview.js";
import { paint, type WarningKey, warningLine, writeRunSummary } from "./screen.js";
import { openWalkStream, readCarriedWalk } from "./stream.js";
import { homepage, version } from "./version.js";

export async function run(flags: RunFlags): Promise<number> {
  const configText = await readNamedFile("--config", flags.config);
  const config = parseRunConfig(configText);

  /**
   * The warnings already said before the walk, so the summary does not repeat them.
   *
   * Two of the four are worth more early than late: they are about the run being
   * about to be wasted, and the summary arrives after the traffic has been spent.
   * The other two cannot be known until the report exists. Either way the words
   * are the report's, so this set holds the report's own strings and the summary
   * subtracts it from `report.warnings` — the screen ends up saying everything
   * the file says, once each.
   */
  const saidEarly = new Set<string>();
  const sayEarly = (key: WarningKey): void => {
    saidEarly.add(WARNINGS[key]);
    process.stderr.write(`${warningLine(key)}\n`);
  };

  // A warning, not a refusal: on your own polygon the label is not needed, while
  // on someone else's platform a report without it cannot go into a ticket — it
  // does not name the target.
  if (config.target.label === undefined) {
    sayEarly("unnamedTarget");
  }

  /**
   * Where the report goes when the command line did not say.
   *
   * It goes to stdout, and in the invocation this tool is written for — a step
   * in a pipeline — stdout is the build log: readable by everyone who can see
   * the build, kept for as long as the build is kept, and copied into whatever
   * collects logs. The same document written with `--report` is created `0600`
   * through a staging file, deliberately, because it holds every request
   * address, every account, tenant and resource identifier and a list of the
   * places this platform's authorization does not hold. The stronger of the two
   * paths was the one an operator had to ask for, and nothing anywhere said so.
   *
   * A warning and not a refusal: `barbican run … > report.json` is a legitimate
   * and common way to run this, and so is piping it into `jq`. What is not
   * legitimate is not knowing.
   *
   * Said before the walk for the same reason `assertReportPathIsWritable` is
   * checked there — this is the point at which the answer can still be changed
   * without spending somebody else's traffic twice. Not on `--dry-run`, which
   * produces no report to misplace.
   */
  if (flags.report === undefined && flags.dryRun !== true) {
    process.stderr.write(
      `${paint("The report has nowhere to go but stdout:", "yellow")} no --report was ` +
        `given. On a pipeline that is the build log — every request address, every ` +
        `account and resource identifier, and a map of where this platform's ` +
        `authorization does not hold, kept as long as the build is and readable by ` +
        `everyone who can see it. The same document under --report is written 0600. ` +
        `Redirect it or name a path.\n` +
        // The second half of the same sentence, and the one that costs traffic
        // rather than confidentiality. The stream lives beside the report, so
        // without a path there is nowhere to put it: nothing this walk observes
        // reaches disk until the last response is in, and anything that ends the
        // process before then — Ctrl-C, the OOM killer, a cancelled job — takes
        // every request with it. See ADR-0047.
        `${paint("Nothing is written to disk until the walk is over:", "yellow")} the ` +
        `observation stream lives beside --report, so there is none. A run ` +
        `interrupted or killed leaves no partial report and cannot be resumed — ` +
        `every request it made is spent again.\n`,
    );
  }
  if (flags.resume === true && flags.report === undefined) {
    throw new Error(
      "--resume needs --report: the stream a run is resumed from lives beside the " +
        "report, and without a path there is no stream to continue. Name the same " +
        "--report the interrupted run was given.",
    );
  }

  // Exactly one endpoint source: two would silently diverge, and none would give
  // a report with no findings, indistinguishable from a successful one.
  // The flag travels with the path: below this point only the path is left, and a
  // failure to read it could then name neither.
  const sources = [
    { flag: "--spec", path: flags.spec, create: createOpenApiParser },
    { flag: "--endpoints", path: flags.endpoints, create: createEndpointListParser },
    { flag: "--postman", path: flags.postman, create: createPostmanCollectionParser },
  ].filter(
    (entry): entry is { flag: string; path: string; create: () => SpecParser } =>
      entry.path !== undefined,
  );
  const [source] = sources;
  if (sources.length !== 1 || source === undefined) {
    throw new Error(
      "Give exactly one endpoint source: --spec (OpenAPI), " +
        "--endpoints (a hand-written list) or --postman (a Postman collection).",
    );
  }
  const sourceText = await readNamedFile(source.flag, source.path);
  const parsed = await source.create().parse(sourceText);
  // References are checked after the spec is parsed: before that there are no
  // endpoints yet.
  assertReferencesResolve(config, parsed);
  // The values of the context attributes: literals as they are, references from
  // the environment. Resolved before the method-override check, because what has
  // to be checked is what really goes over the wire, not what is written in the
  // file.
  //
  // And used by `--dry-run` as well, which built its accounts with an empty map:
  // any attribute written as `{ env: NAME }` then threw
  // `MissingContextValueError`, so the dry run refused a configuration the real
  // run executes and named a variable that was set the whole time. The command a
  // reader is told to try first on somebody else's deployment failed and blamed
  // them for it. Found by adversarial review on 17 August 2026.
  const contextValues = resolveContextValues(config, process.env);
  assertContextsCannotWrite(contextValues, { allowUnsafeMethods: flags.unsafeMethods === true });
  // responseMustDifferByTenant is a human's statement of expectation; endpoint
  // sources (a spec, a list, a collection) do not know about it and must not.
  const endpoints = applyBodySignals(parsed, config);
  // Patterns are expanded here, before the matrix is built: a pattern that matched
  // no endpoint must fail at startup instead of dropping the pairs into fallback.
  const policy = expandPolicy(config.policy, endpoints);

  // Before anything is sent: a path that fails at the end costs the whole run.
  if (flags.report !== undefined) {
    await assertReportPathIsWritable(flags.report);
  }

  // The stream lives beside the report and the declaration is what a resumed run
  // is let through on. Both are settled here — before the canaries, before the
  // walk, before anything is sent — because `readCarriedWalk` refuses on them,
  // and a refusal after the first request is a refusal that cost traffic.
  const streamPath = flags.report === undefined ? undefined : observationStreamPath(flags.report);
  const declaration = declarationDigest({
    version,
    config: configText,
    sourceFlag: source.flag,
    source: sourceText,
    unsafeMethods: flags.unsafeMethods === true,
    identify: flags.identify !== false,
    contextValues,
  });
  const carried = await readCarriedWalk({
    streamPath,
    resume: flags.resume === true,
    declaration,
    version,
  });

  /**
   * The run's identifier, minted here rather than by the report.
   *
   * `buildReport` mints one too, and it runs after the last response has come
   * back — the wrong end of a run for a value that has to be on the **first**
   * request. So the CLI decides it before anything is sent and the report
   * carries the CLI's; `buildReport` keeps its own for a consumer of the library
   * assembling a report without having gone through this command. Where a run
   * happened, the identifier the platform saw is the one the artifact is filed
   * under, because a second identifier would let the owner of the target filter
   * the traffic out of their graphs and still not know which report it produced.
   *
   * A resumed run adopts the interrupted one's rather than minting a second.
   * Both halves of the walk then carry one identifier on the wire, and the one
   * report they produce is filed under it — which is the whole of what ADR-0045
   * bought. Two identifiers would leave the owner of the platform with two
   * populations of traffic and one document, and no way to join them.
   *
   * See ADR-0045.
   */
  const runId = carried.from?.runId ?? randomUUID();
  const identity = flags.identify === false ? undefined : runIdentity({ version, runId, homepage });

  // The registry is created explicitly and locally: there is no global state in
  // the core (ADR-0003). Assembled here, before the first request, and not next
  // to where the checks run — a typo in `--checks` discovered after the walk is
  // the same waste `--report` used to cost, and a `--dry-run` that says nothing
  // about it is a preview that hides the mistake it exists to surface.
  const registry = new CheckRegistry();
  registry.register(createIdenticalResponseCheck());
  const selected = registry.select(flags.checks);

  // Built here rather than beside the client: the preview needs the limits that
  // will actually be in force, and reading the defaults a second time would be a
  // duplicate that drifts. Pure construction — nothing is sent by making it.
  const throttle = createThrottle({
    ...(flags.concurrency === undefined ? {} : { concurrency: flags.concurrency }),
    ...(flags.rps === undefined ? {} : { requestsPerSecond: flags.rps }),
    ...(flags.maxRequests === undefined ? {} : { maxRequests: flags.maxRequests }),
  });

  // The canaries, before anything is sent and before the preview claims to have
  // validated everything. One of these on an excluded endpoint used to pass the
  // dry run and stop the real one.
  assertCanariesUsable({
    endpoints,
    canaries: config.accounts.flatMap((account) =>
      account.canary === undefined
        ? []
        : [{ accountId: account.id, endpointId: account.canary, roleId: account.role }],
    ),
    ...(config.exclude === undefined ? {} : { exclude: config.exclude }),
    // The method check needs the flag, and the flag lives on the command line
    // rather than in the configuration: a canary on `POST /login` is a mistake
    // only while this run refuses write methods. Without it the preview printed
    // the endpoint as skipped for its method and counted three canary requests
    // against it in the same summary, and the run reached the platform's silence
    // for a reason that was never the platform's.
    allowUnsafeMethods: flags.unsafeMethods === true,
    // The last check needs the expanded policy: a canary the policy denies is a
    // contradiction the run would otherwise report as a platform defect.
    policy,
  });

  // Everything above this line is validation and parsing; nothing has reached the
  // network. That is what makes this the honest place to stop and show what a run
  // would do — on someone else's deployment the question "what exactly will you
  // touch" deserves an answer before the first request, not after.
  if (flags.dryRun === true) {
    return describePlan(
      config,
      endpoints,
      flags,
      selected,
      throttle.limits,
      contextValues,
      identity,
      carried.records.length,
    );
  }

  const credentials = createCredentialProvider(
    config.auth,
    resolveTokens(config, process.env),
    config.accountAuth,
  );

  const client = createHttpClient({
    allowedHosts: config.target.allowedHosts,
    throttle,
    allowUnsafeMethods: flags.unsafeMethods === true,
    // Into the client and not into each request the walk builds: the client is
    // the one seam every request of a run passes through, canaries included.
    ...(identity === undefined ? {} : { identity }),
    ...(config.bodySignals?.maxBodyBytes === undefined
      ? {}
      : {
          signalExtractor: createSignalExtractor({ maxBodyBytes: config.bodySignals.maxBodyBytes }),
        }),
  });

  // Accounts under declared conditions are separate matrix rows. The attributes
  // (headers, query parameters) do not go into the core: the label is enough there.
  const { accounts, attributes: contextAttributes } = toAccounts(config, contextValues);

  // Brands are often spread across subdomains; the address is chosen by the
  // resource's tenant, because what we ask for is someone else's data, and it
  // lives on someone else's host.
  const tenantBaseUrls = new Map(
    (config.tenants ?? [])
      .filter((tenant) => tenant.baseUrl !== undefined)
      .map((tenant) => [tenant.id, tenant.baseUrl ?? ""]),
  );

  /** One bundle for both passes: they knock on the same doors with the same keys. */
  const canaryPass: CanaryPass = {
    baseUrl: config.target.baseUrl,
    endpoints,
    canaries: declaredCanaries(config),
    credentials,
    client,
    exclude: config.exclude,
    allowUnsafeMethods: flags.unsafeMethods === true,
    accounts,
    tenantBaseUrls,
  };

  // Said before the walk when **any** credentialed account lacks a canary, not
  // only when the run has none at all: the condition here is the one the verdict
  // will apply, and a warning that fires on less than the verdict does is a
  // warning that lets a run end with an exit code nothing on screen predicted.
  if (accountsOwedACanary(config).length > 0) {
    sayEarly("noCanary");
  }
  const canaryOutcomes = await probeBeforeWalk(canaryPass);
  const canariesChecked = canaryOutcomes.length;

  // The start of the walk this report is about — the interrupted run's where
  // there is one. A resumed report whose `startedAt` named the second process
  // would put a duration next to observations timed hours before it.
  const startedAt =
    carried.from === undefined ? new Date() : new Date(Date.parse(carried.from.startedAt));

  let stream: ObservationStream | undefined;
  if (streamPath !== undefined) {
    stream = await openWalkStream({
      streamPath,
      version,
      declaration,
      runId,
      startedAt,
      resume: flags.resume === true,
      carried,
    });
  }

  /**
   * The stop an operator or a scheduler asks for, and what is left on disk after.
   *
   * SIGINT is Ctrl-C — often because the owner of the platform asked for it —
   * and SIGTERM is how CI kills a job that ran past its timeout. Both used to
   * end the process where it stood, and everything the walk had observed went
   * with them: node's default is the right exit status and the wrong amount of
   * work saved.
   *
   * The handler does not change the status. It stops the walk, lets the report
   * be assembled from what was observed, and then re-raises the signal with the
   * default disposition restored — so a shell and a pipeline still see 130 and
   * 143, which is the contract `tests/invariants/cli-surface.test.ts` holds. A
   * second signal is taken as impatience and goes straight through.
   */
  const walking = new AbortController();
  let interruptedBy: NodeJS.Signals | undefined;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (interruptedBy !== undefined) {
      void endBySignal(signal, onSignal);
      return;
    }
    interruptedBy = signal;
    process.stderr.write(
      `\n${paint(`Interrupted by ${signal}:`, "red")} the walk stops here. What was ` +
        `observed is being written out, and the report will say the tail was never ` +
        `probed — the absence of findings in it means nothing.\n`,
    );
    walking.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const { observations, skipped, failures, probed, truncated } = await collectObservations({
    baseUrl: config.target.baseUrl,
    endpoints,
    accounts,
    credentials,
    client,
    allowUnsafeMethods: flags.unsafeMethods === true,
    exclude: config.exclude,
    resources: config.resources,
    tenantBaseUrls,
    contextAttributes,
    abort: walking.signal,
    ...(carried.records.length === 0 ? {} : { resumed: carried.records }),
    ...(stream === undefined
      ? {}
      : {
          // The stream swallows its own failures: a disk that fills must cost
          // the safety net and not the walk, whose traffic is already spent.
          record: (record: CellRecord) => stream?.append({ kind: "cell", ...record }),
        }),
    // From the throttle's own merge of defaults and flags, so the walk and the
    // limiter cannot end up with two different numbers for the same limit. A
    // port implementation that declares no limits gets a walk of one: the walk
    // must never be the wider of the two.
    ...(throttle.limits === undefined ? {} : { concurrency: throttle.limits.concurrency }),
  });
  const finishedAt = new Date();
  await stream?.close();
  if (stream?.failure !== undefined) {
    process.stderr.write(
      `${paint("The walk could not be streamed to disk:", "yellow")} ${stream.failure}. ` +
        `The run itself was not affected and the report below is complete for what was ` +
        `walked — but ${streamPath ?? "the stream"} is not, so this run cannot be ` +
        `resumed from it.\n`,
    );
  }

  const { staleCredentials, unverifiedAfterWalk } = await confirmAfterWalk({
    ...canaryPass,
    before: canaryOutcomes,
    truncated,
  });

  // The matrix is built only from what was probed: a skip is a gap in coverage,
  // not a discrepancy per account. Otherwise one skip gives as many findings as
  // there are accounts.
  const matrix = buildAccessMatrix({
    endpoints: probed,
    accounts,
    resources: config.resources,
    observations,
    ...(config.tenants === undefined ? {} : { tenants: config.tenants }),
  });
  // One walk for both answers: the findings and the verdicts over every cell, the
  // matching ones included. A second pass would diverge, and the report would
  // claim 'tested and agreed' about a cell that landed in the findings.
  // See ADR-0020.
  //
  // One call, and not `describeCells` followed by `diffAccess`: those are two
  // walks, which is what stood here until the audit of 14 August found it — the
  // comment above promising a shared walk while the lines below took two.
  const { cells, diffs: findings } = describeMatrix(matrix, policy);

  // The registry is created explicitly and locally: there is no global state in
  // ADR-0003 speaks of "a registry assembled for a particular run", and there was
  // no way to assemble one: every registered check ran, always. The selection was
  // made above, before the first request. A check stays silent by itself when
  // nothing in the configuration concerns it.
  // Built in the core rather than by a mapping written out here. That mapping
  // named `id` and `standards`, `Check.description` existed all along, and
  // nothing pointed out that the third field had been left behind — so the one
  // sentence in the project saying what a check does never reached the report.
  // Found by the audit of 14 August 2026 (L-8).
  const checksRun = describeChecks(selected);
  // What a run touched and what it did not, so that a check can say "this clause
  // was covered enough" rather than only "here is what I found".
  const scope: RunScope = {
    probedEndpointIds: probed.map((endpoint) => endpoint.id),
    skipped: skipped.map((one) => ({ endpointId: one.endpointId, reason: one.reason })),
    truncated,
  };
  const context = { matrix, scope };
  // Each check reports its own reach. It used to be one function exported from
  // one check and called by name here, with its type imported into the report
  // layer — the arrangement ADR-0003 exists to prevent.
  // The same isolation `runChecks` gives `run`: a `coverage` that throws would
  // otherwise discard a finished walk at the step that only counts what it
  // looked at. Silence here rather than a finding: the finding for a broken
  // check is already made by `runChecks` a few lines below, and saying it twice
  // would print one breakage as two.
  const byCheck = selected.flatMap((check) => {
    try {
      return check.coverage?.(context) ?? [];
    } catch {
      return [];
    }
  });
  // Through `runChecks`, which settles each finding's severity from the check
  // that made it. Calling `run` directly here is what let the severity be
  // declared twice — once on the check and once as a literal inside it.
  const checks = runChecks(selected, context);
  const suspicions = findUnauthenticated(
    accounts,
    observations,
    policy,
    config.resources,
    config.tenants,
  );
  const unauthenticated = suspicions.map((s) => s.accountId);

  const report: RunReport = buildReport({
    /**
     * The identifier the platform saw, in the document the platform's owner gets.
     *
     * `buildReport` mints a `runId` of its own when it is given none, and it has
     * to: a report without one cannot be told from the next report. But it runs
     * at the end of the walk, and the value has to exist before the first
     * request or it cannot be on the wire at all. So the run's own identifier
     * wins here — which is the whole of what makes marking the traffic useful,
     * since a filter in a SIEM has to lead back to *this* file. See ADR-0045.
     *
     * Passed in rather than written onto the finished report, and that is the
     * whole of ADR-0058: `contentDigest` is taken over the document as the last
     * thing `buildReport` does, so `{ ...built, runId }` — which is what stood
     * here — hashed a report carrying a different identifier from the one that
     * reached the disk. Every artifact this tool wrote failed its own check.
     */
    runId,
    // The same rows the matrix has: a finding refers to an account under
    // conditions, and that account must be in the account list, or the reference
    // dangles.
    accounts,
    version,
    config,
    endpoints,
    probed,
    observations,
    skipped,
    failures,
    unauthenticated,
    canariesChecked,
    staleCredentials,
    unverifiedAfterWalk,
    canaries: canaryOutcomes,
    truncated,
    unsafeMethods: flags.unsafeMethods === true,
    findings,
    policy,
    checks,
    cells,
    checksRun,
    byCheck,
    // As throttling itself resolved them, not as the flags spelled them out: the
    // defaults live in the adapter, and a second source of them in the report
    // would drift silently.
    ...(throttle.limits === undefined ? {} : { throttle: throttle.limits }),
    startedAt,
    finishedAt,
  });

  let reportWritten = false;
  if (flags.report === undefined) {
    await writeChunks(process.stdout, reportChunks(report));
  } else {
    try {
      await writeReportFile(flags.report, report);
      reportWritten = true;
    } catch (cause) {
      // The path was checked before the first request, so getting here means the
      // directory went away underneath us or the disk filled. The run is already
      // paid for in traffic against someone else's deployment: losing the result
      // now would mean spending it twice.
      //
      // A second generator: the first one was consumed by the attempt above, and
      // a generator does not rewind.
      await writeChunks(process.stdout, reportChunks(report));
      process.stderr.write(
        `${paint("The report could not be written:", "red")} ${
          cause instanceof Error ? cause.message : String(cause)
        }\nIt has been printed to stdout instead — the run is done and its result ` +
          `is not worth losing to a filesystem error.\n`,
      );
    }
  }

  /**
   * The stream outlives only a walk that did not finish.
   *
   * A complete walk has the report, which is the artifact; leaving the stream
   * beside it would be a second copy of the same data, at the same sensitivity,
   * that nobody asked for and nothing would ever delete. An incomplete one keeps
   * it, because it is the only thing that makes the traffic already spent worth
   * anything.
   *
   * The failed-write branch above keeps it too: the report went to stdout, and a
   * pipeline that loses stdout still has this.
   */
  if (streamPath !== undefined && !truncated && reportWritten) {
    await rm(streamPath, { force: true }).catch(() => undefined);
  }

  const verdict = runVerdict(report);
  writeRunSummary({
    report,
    verdict,
    suspicions,
    truncated,
    interruptedBy,
    streamPath,
    observations: observations.length,
    configPath: flags.config,
    reportPath: flags.report,
    identity,
    saidEarly,
  });

  // A run stopped by a signal ends the way a signal ends a process, and the
  // report it now leaves behind does not change that: 130 and 143 are what a
  // shell and a pipeline read, and the verdict's own code would be a different
  // statement in the same field.
  if (interruptedBy !== undefined) {
    return await endBySignal(interruptedBy, onSignal);
  }
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  return verdict.code;
}

/**
 * Ends the process the way the signal would have, now that the work is saved.
 *
 * The handler is removed first, which restores the default disposition, and the
 * signal is then sent again — so `child_process` reports `signal: "SIGINT"` and
 * a shell turns that into 130, exactly as it did when nothing here handled the
 * signal at all. `process.exit(130)` would be a different fact in the same
 * field: an exit code says the program decided, a signal says it was stopped.
 *
 * stderr is drained before the raise. It is a pipe under CI and a pipe is
 * written asynchronously, so the summary this run just produced would otherwise
 * be cut off by its own exit.
 *
 * The wait afterwards never returns on any platform this runs on — the kernel
 * delivers a signal a process sends itself before the call comes back. The
 * number below it is the answer if some platform disagrees, and it is the same
 * number a shell would have printed.
 */
async function endBySignal(
  signal: NodeJS.Signals,
  handler: NodeJS.SignalsListener,
): Promise<number> {
  process.off("SIGINT", handler);
  process.off("SIGTERM", handler);
  await new Promise<void>((settle) => {
    process.stderr.write("", () => settle());
  });
  process.kill(process.pid, signal);
  await new Promise<void>((settle) => {
    setTimeout(settle, 1_000);
  });
  return 128 + (signalNumbers.signals[signal] ?? 0);
}

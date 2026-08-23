/**
 * The walk itself: every cell of the matrix, in order, through a pool of
 * workers.
 *
 * One module and a long one, on purpose. Nearly every comment in
 * `collectObservations` is about the **position** of a line — the resume gate
 * before the first request, the attribute check before the credentials are
 * merged over it, the stop honoured before a cell is recorded, the holes closed
 * only at the end. Cut further, those reasons would be spread over files that
 * cannot enforce them.
 */

import type { ContextAttributes, CredentialProvider, HttpClient } from "../adapters/ports.js";
import type {
  AccessObservation,
  Account,
  Endpoint,
  Resource,
  SignalSpec,
  SignalValue,
  TenantId,
} from "../core/index.js";
import {
  DEFAULT_DIGEST_SIGNAL,
  principalOf,
  resourceApplies,
  SAFE_METHODS,
} from "../core/index.js";
import { cellKey, objectKey } from "../core/keys.js";
import { assertAttributesKeepTheBasis } from "../io/config.js";
import { baseUrlForTenant, joinUrl, substitute, withQuery } from "./address.js";
import type { ProbeFailure } from "./outcome.js";
import { classifyStatus, reasonOf, terminalCause, unreadableStatusReason } from "./outcome.js";
import type { SkippedEndpoint } from "./plan.js";
import { planEndpoints } from "./plan.js";
import type { CellRecord } from "./stream.js";
import { ResumeDoesNotFitError } from "./stream.js";

/**
 * What is computed over the body of a marked endpoint.
 *
 * One digest: it answers the question "did two tenants get one and the same
 * response", for the sake of which the relaxation was introduced at all.
 * Widening the set without need is pointless — every extra signal means one more
 * body read.
 */
const DIGEST_SIGNALS = [
  { name: DEFAULT_DIGEST_SIGNAL, kind: "digest" },
] as const satisfies readonly SignalSpec[];

export interface CollectOptions {
  readonly baseUrl: string;
  readonly endpoints: readonly Endpoint[];
  readonly accounts: readonly Account[];
  /** How an account presents itself to the system. The headers do not get into the observations. */
  readonly credentials: CredentialProvider;
  readonly client: HttpClient;
  readonly allowUnsafeMethods?: boolean;
  /** The resources being requested. Without them parameterized endpoints are not probed. */
  readonly resources?: readonly Resource[];
  /**
   * The identifiers of the endpoints not to touch.
   *
   * `SAFE_METHODS` protects against the semantics of the method, but not against
   * an endpoint that violates it: a GET that resets the database stays a GET.
   * Such addresses are excluded by name — there is no other way to tell them
   * apart.
   */
  readonly exclude?: readonly string[];
  /**
   * The base address for individual tenants.
   *
   * Multi-brand platforms often spread the brands across subdomains, and a
   * typical claim under test is "brand A's token does not work on brand B's
   * host". The address is chosen by the **resource's** tenant, not the
   * account's: what we ask for is precisely someone else's data, and it lives on
   * someone else's host. When there is no resource, the account's tenant is
   * taken — the question is then about its own scope.
   */
  readonly tenantBaseUrls?: ReadonlyMap<TenantId, string>;
  /**
   * The attributes of accounts under declared conditions: the id of the account
   * under conditions → what to add to the request and whose credentials to
   * present.
   *
   * The core knows nothing about this: the `contextId` label on the account is
   * enough for it. Here the conditions become request headers and parameters.
   * See ADR-0019.
   */
  readonly contextAttributes?: ReadonlyMap<string, ContextAttributes>;
  /**
   * Every cell, handed over the moment it is finished.
   *
   * The walk holds its observations in an array and returns them at the end,
   * and everything that ends a process short of that returns nothing: Ctrl-C
   * because the owner of the platform asked to stop, the OOM killer, a CI job
   * cancelled on its timeout, the network going away. What is lost is the
   * traffic already spent against somebody else's deployment — the most
   * expensive and the most politically awkward resource this tool consumes, and
   * one that may not be spendable a second time inside the agreed window.
   *
   * A callback and not a path: the runner sits above the ports and has no file
   * system in it. Where the CLI puts the lines, and in what format, is
   * `src/report/write.ts` and ADR-0047.
   *
   * The record arrives **after** the cell is complete and never for a cell the
   * walk did not finish — a cell recorded here is a cell `--resume` will not
   * probe again, so recording an interrupted one would file a request the
   * platform never answered as an answer.
   *
   * Awaited, so a sink with backpressure can apply it. A sink that throws stops
   * the walk: the caller that cannot afford that is the caller who must catch
   * inside it. The CLI does, and says so — a stream that cannot be written is a
   * reason to lose the safety net, not the run.
   */
  readonly record?: (record: CellRecord) => void | Promise<void>;
  /**
   * The cells a previous run already walked.
   *
   * They are not probed again, and they take their place in the result at the
   * index the walk would have put them at — not appended after the cells probed
   * now. The report drains its observations in cell order precisely so that two
   * runs over one matrix produce one document; a resumed walk that reordered
   * them would make `configDigest` promise more than it delivers.
   *
   * A record that fits no cell of this matrix is refused rather than ignored.
   * See `ResumeDoesNotFitError`.
   */
  readonly resumed?: readonly CellRecord[];
  /**
   * A stop asked for from outside, mid-walk.
   *
   * Two things follow from it, and they are not the same thing: no worker takes
   * another cell, and the signal is handed to `client.send`, so a request
   * already on the wire is dropped rather than waited out. An operator who was
   * asked to stop touching a platform has stopped touching it.
   *
   * The cells not reached are simply not observed, and the walk comes back
   * `truncated: true` — the same word an exhausted budget earns, and it means
   * the same thing: there are no findings in the tail because nothing looked.
   */
  readonly abort?: AbortSignal;
  /**
   * How many cells may be in flight at once.
   *
   * Taken from `throttle.limits`, the single place where the defaults and the
   * flags are merged — not re-derived here, or the walk and the limiter would
   * disagree about the same number and the report would print one of the two.
   * Absent means one at a time, which is what the walk did unconditionally
   * before: the flag was documented, printed into the report and had no effect.
   *
   * It bounds the walk, not the traffic. The ceiling lives in the throttle and
   * holds whatever this says.
   */
  readonly concurrency?: number;
}

export interface CollectResult {
  readonly observations: readonly AccessObservation[];
  readonly skipped: readonly SkippedEndpoint[];
  readonly failures: readonly ProbeFailure[];
  /**
   * The endpoints that were actually probed.
   *
   * The matrix is built out of these only: an endpoint that was not walked is a
   * gap in coverage, already listed in `skipped`, rather than a discrepancy on
   * every account. Otherwise one skip produces as many findings as there are
   * accounts, and the real signal drowns.
   */
  readonly probed: readonly Endpoint[];
  /**
   * The run broke off without reaching the end of the matrix.
   *
   * An exhausted request ceiling or a tripped circuit breaker cut the walk short
   * in the middle of the list. The tail stays unchecked, but there are no
   * findings in it precisely because it was never reached — and without this
   * flag the verdict "clean" is indistinguishable from a real one.
   */
  readonly truncated: boolean;
}

/**
 * Probes every "account × endpoint" pair.
 *
 * Endpoints with parameters in the path are skipped: there is nothing to
 * substitute an identifier from until the question of collecting values from
 * responses is settled. The skip is returned explicitly rather than by silence —
 * otherwise what was not checked would look as if it had been.
 */
export async function collectObservations(options: CollectOptions): Promise<CollectResult> {
  const { probeable, skipped } = planEndpoints(options);

  let truncated = false;

  // An endpoint without parameters is probed once; one with parameters — once
  // per resource that covers those parameters.
  const cells: Array<{ endpoint: Endpoint; resource?: Resource }> = [];
  for (const endpoint of probeable) {
    const applicable = (options.resources ?? []).filter((resource) =>
      resourceApplies(endpoint, resource),
    );
    if (applicable.length === 0) {
      cells.push({ endpoint });
      continue;
    }
    for (const resource of applicable) {
      cells.push({ endpoint, resource });
    }
  }

  /**
   * One account, and which cells of the matrix it walks.
   *
   * The walk used to lay out one task object per cell before the first request —
   * the account, the endpoint, the resource, and the two values derived from the
   * account, held from before the first request until after the last. Everything
   * in that object except the cell is a property of the account, and there are as
   * many accounts as an operator wrote down.
   *
   * So the account's half is held once per account and the cell's half once per
   * `endpoint × resource` pair, and a cell of the walk is a pair of indices into
   * the two lists. That is the first of the two full copies of the matrix the
   * walk carried beside the observations it returns. See ADR-0053.
   */
  interface Walker {
    readonly account: Account;
    readonly credentialAccountId: string;
    readonly attributes?: ContextAttributes;
    /**
     * The cells this account walks, by index into `cells`, when it does not walk
     * all of them.
     *
     * `undefined` is the ordinary account — every cell, and no list to hold. An
     * account under conditions exists only on the endpoints the conditions were
     * declared on, and ADR-0019 makes that declaration mandatory precisely so
     * that conditions do not multiply the matrix by the whole surface: the list
     * is short, and there is one per such account rather than one per cell.
     */
    readonly cellIndices?: readonly number[];
    /** Where this account's cells begin in the flat numbering of the walk. */
    readonly offset: number;
    /** How many cells this account walks. */
    readonly count: number;
  }

  const walkers: Walker[] = [];
  let total = 0;
  for (const account of options.accounts) {
    const attributes = options.contextAttributes?.get(account.id);
    // Conditions do not change the account: it presents itself, and what changes
    // is the request. There is one source — `principalOf`: the same thing is
    // needed by the relation to the resource and by the report, and three
    // different "take the original account" would drift apart silently.
    const credentialAccountId = principalOf(account);
    // Built once per account, for the same reason as in `describeMatrix`: asked
    // with `includes` for every cell, this list is walked once per cell, and it
    // is as long as the endpoints the conditions were declared on.
    const declaredOn = account.endpointIds === undefined ? undefined : new Set(account.endpointIds);
    let cellIndices: number[] | undefined;
    if (declaredOn !== undefined) {
      cellIndices = [];
      for (const [index, cell] of cells.entries()) {
        // An account under conditions exists only on the declared endpoints.
        if (declaredOn.has(cell.endpoint.id)) {
          cellIndices.push(index);
        }
      }
    }
    const count = cellIndices?.length ?? cells.length;
    walkers.push({
      account,
      credentialAccountId,
      ...(attributes === undefined ? {} : { attributes }),
      ...(cellIndices === undefined ? {} : { cellIndices }),
      offset: total,
      count,
    });
    total += count;
  }

  /**
   * The observations, in cell order, with a hole wherever a cell was not walked.
   *
   * The array the walk returns, written into directly at the index the cell has.
   * It used to be filled at the end out of a second array of per-cell results —
   * the other full copy of the matrix the walk carried, alive beside this one for
   * as long as the drain took. A result is now a value one worker holds for the
   * length of one cell.
   *
   * Holes are the cells a stop or a terminal error left unreached; they are
   * closed up in one pass at the end, in place, so the compaction does not
   * allocate a second array either.
   */
  const observations = new Array<AccessObservation>(total);
  /**
   * The failures, by the index of the cell that produced them.
   *
   * A map rather than a second array of the matrix's length: a run where every
   * cell fails is possible, and a run where none does is the ordinary one, so the
   * cost should follow the failures rather than the cells. Drained in index order
   * together with the observations, which is what keeps `failures[]` in the order
   * the cells were laid out.
   */
  const failuresByIndex = new Map<number, ProbeFailure>();

  /**
   * The cells a previous run already walked, put where this walk would have put
   * them.
   *
   * Resolved from the record's own coordinate rather than by walking the matrix
   * and asking after every cell of it: that loop minted a key string per cell,
   * before the first request, on every run — including the overwhelmingly common
   * one that resumes nothing.
   *
   * A record that fits no cell of this matrix is refused rather than ignored: the
   * walk being resumed is then not the walk that was interrupted. Refused here,
   * after the shape of the matrix is known so the answer is exact, and before the
   * first request of the walk so it costs nothing.
   */
  if (options.resumed !== undefined && options.resumed.length > 0) {
    // First wins in both of the maps below, which is what the loop over the task
    // list did: it took the earliest cell whose key matched. Neither list should
    // hold a duplicate — `buildAccessMatrix` refuses one — but that runs after the
    // walk, and "the earliest" is a rule while "whichever the map happened to
    // keep" is not.
    const walkerOf = new Map<string, Walker>();
    for (const walker of walkers) {
      if (!walkerOf.has(walker.account.id)) {
        walkerOf.set(walker.account.id, walker);
      }
    }
    const cellAt = new Map<string, number>();
    for (const [index, cell] of cells.entries()) {
      const key = objectKey({ endpointId: cell.endpoint.id, resourceId: cell.resource?.id });
      if (!cellAt.has(key)) {
        cellAt.set(key, index);
      }
    }
    // Where a cell sits inside an account that walks only some of them. Built on
    // demand and only for such accounts: for every other one the position in the
    // account is the position in `cells`.
    const positionsIn = new Map<Walker, ReadonlyMap<number, number>>();
    // A set, because its size goes into the message: two records naming one
    // absent cell are one cell this matrix does not contain.
    const missing = new Set<string>();
    for (const record of options.resumed) {
      const walker = walkerOf.get(record.accountId);
      const cellIndex = cellAt.get(objectKey(record));
      if (walker === undefined || cellIndex === undefined) {
        missing.add(cellKey(record));
        continue;
      }
      let position: number | undefined = cellIndex;
      if (walker.cellIndices !== undefined) {
        let positions = positionsIn.get(walker);
        if (positions === undefined) {
          positions = new Map(walker.cellIndices.map((at, index) => [at, index]));
          positionsIn.set(walker, positions);
        }
        position = positions.get(cellIndex);
      }
      if (position === undefined) {
        missing.add(cellKey(record));
        continue;
      }
      const index = walker.offset + position;
      observations[index] = record.observation;
      if (record.failure !== undefined) {
        failuresByIndex.set(index, record.failure);
      }
    }
    if (missing.size > 0) {
      throw new ResumeDoesNotFitError([...missing]);
    }
  }

  /**
   * Cells whose object this run has already changed.
   *
   * With `--unsafe-methods` the walk stops being a read. The first account to
   * `DELETE` an order gets 200 and the order is gone; every later account gets
   * 404, which folds into a denial and agrees with a policy of denial — so the
   * tool reports "tested and agreed" about a protection it never observed,
   * having manufactured the answer itself. Found by the audit of 14 August 2026
   * (L-7).
   *
   * Keyed by endpoint and resource, because that is the object: two accounts
   * deleting the same order collide, two accounts deleting different orders do
   * not.
   *
   * Best effort, and worth saying so: the walk is parallel, so two workers can
   * be inside the same cell at once and neither sees the other's write. What
   * this removes is the silent conclusion, not the race.
   */
  const changed = new Set<string>();
  const SAFE = new Set<string>(SAFE_METHODS);

  /**
   * What one cell produced. A cell can yield a failure and an observation both.
   *
   * One of these is alive per worker for the length of one cell. There used to be
   * one per cell of the matrix, in an array that outlived the walk — see
   * `observations` above and ADR-0053.
   */
  interface CellResult {
    readonly failure?: ProbeFailure;
    readonly observation?: AccessObservation;
    readonly truncated?: true;
  }

  async function probe(walker: Walker, cell: (typeof cells)[number]): Promise<CellResult> {
    const { account, credentialAccountId, attributes } = walker;
    const { endpoint, resource } = cell;
    const startedAt = Date.now();
    const tenantId = resource?.tenantId ?? account.tenantId;
    const baseUrl = baseUrlForTenant(tenantId, options.tenantBaseUrls, options.baseUrl);
    // The scope check is over the finished path, not over the template: a
    // resource value with `..` led the request above the declared base path,
    // because the template was checked before substitution.
    let url: string;
    try {
      // Both query channels, before either of them reaches the address.
      // `resources[].query` is the twin of `contexts[].query` and was left at the
      // configuration door when the conditions moved to the seam: through the
      // library door it put `?_method=DELETE` on the wire with
      // `allowUnsafeMethods: false` and printed a credential into
      // `observations[].url`. Found by adversarial review on 21 August 2026 (V-1),
      // one day after ADR-0037 moved the other half.
      //
      // The resource's id stands where a context's id stands in the message: it
      // is what the operator has to go and edit.
      if (resource?.query !== undefined) {
        assertAttributesKeepTheBasis(
          { kind: "resource", id: resource.id },
          { headers: {}, query: resource.query },
          { allowUnsafeMethods: options.allowUnsafeMethods === true },
        );
      }
      const path = resource === undefined ? endpoint.path : substitute(endpoint.path, resource);
      url = withQuery(joinUrl(baseUrl, path), resource, attributes?.query);
    } catch (cause) {
      return {
        failure: {
          accountId: account.id,
          endpointId: endpoint.id,
          ...(resource === undefined ? {} : { resourceId: resource.id }),
          reason: cause instanceof Error ? cause.message : String(cause),
        },
        // A row, and not only an entry in `failures`. A cell that could not even
        // be addressed used to leave no observation, so it produced no
        // `probe-error` and the untrustworthiness threshold could not see it:
        // four cells out of five failing this way exited 0 — "checked, clean" —
        // because the fifth was the whole denominator. Found by the audit of
        // 14 August (B-7).
        //
        // Status 0 is what the report already means by "no answer", and it says
        // the same thing here as it does for a request that failed on the wire.
        // No `url` and no `method`, because there are none: the address is
        // exactly what could not be built, and inventing one would tell the
        // reader a request went somewhere.
        observation: {
          accountId: account.id,
          endpointId: endpoint.id,
          ...(resource === undefined ? {} : { resourceId: resource.id }),
          status: 0,
          headers: {},
          outcome: "error",
          durationMs: Date.now() - startedAt,
          at: new Date(startedAt).toISOString(),
        },
      };
    }
    // The body is read only where a human declared `responseMustDifferByTenant`:
    // where it is not declared, the stream is cancelled unread. See ADR-0011.
    // The digest is implied by that declaration itself — there is nothing else
    // to compare responses between tenants with — while the other scalars are
    // declared by a human explicitly. Empty means the body is not read at all.
    const specs: readonly SignalSpec[] = [
      ...(endpoint.responseMustDifferByTenant === true ? DIGEST_SIGNALS : []),
      ...(endpoint.signals ?? []),
    ];

    // The condition attributes go in **first** and the credential ones over
    // them. This used to be the other way round, with a comment calling the
    // order "the second line of the same defence" — and it was the opening, not
    // the defence: a later spread wins, so `authorization` declared as an
    // attribute replaced the account's own header and the run went out as
    // somebody else while the report named the original account. The first line
    // it leaned on — "that is checked when the configuration is parsed" — holds
    // for the configuration door and for no other.
    //
    // The headers are taken for every request rather than once per account: the
    // signature depends on the method and the address, and a value hoisted out
    // of the loop would silently sign every cell with the first request. See
    // ADR-0018.
    if (attributes !== undefined) {
      assertAttributesKeepTheBasis({ kind: "context", id: attributes.contextId }, attributes, {
        allowUnsafeMethods: options.allowUnsafeMethods === true,
      });
    }
    const request = {
      method: endpoint.method,
      url,
      headers: {
        ...attributes?.headers,
        ...options.credentials.headersFor(credentialAccountId, {
          method: endpoint.method,
          url,
        }),
      },
      ...(specs.length === 0 ? {} : { signals: specs }),
    };

    const object = objectKey({ endpointId: endpoint.id, resourceId: resource?.id });
    let status: number;
    let headers: Readonly<Record<string, string>>;
    let signals: Readonly<Record<string, SignalValue>> | undefined;
    let failure: ProbeFailure | undefined;
    let stopped: true | undefined;
    let selfInflicted = false;
    try {
      // The stop travels to the client as well as to the loop: a request
      // already on the wire is dropped rather than waited out, so an operator
      // who was asked to stop touching a platform has stopped touching it.
      const response = await options.client.send(request, options.abort);
      status = response.status;
      headers = response.headers;
      signals = response.signals;
      if (!SAFE.has(endpoint.method)) {
        if (status >= 200 && status < 300) {
          changed.add(object);
          // Asked of `classifyStatus` rather than of a list written out here.
          // 410 joined 404 in ADR-0046 and had to be moved into this guard by
          // hand as well; it was, and the next status will be found by whoever
          // is not looking. What is guarded is precisely the classification: a
          // status that folds into `not-found` folds on into a denial in
          // `toBinary`, so one this run caused with its own write reads as
          // protection observed — the L-7 false negative, over an answer the
          // walk manufactured. While 410 was still an `error` the guard had
          // nothing to guard, because an unreadable status is already no
          // conclusion; that is the same equivalence, which is why the guard
          // now reads it off the function that decides it. See ADR-0061.
        } else if (classifyStatus(status) === "not-found" && changed.has(object)) {
          selfInflicted = true;
          failure = {
            accountId: account.id,
            endpointId: endpoint.id,
            ...(resource === undefined ? {} : { resourceId: resource.id }),
            reason:
              `${status} after this run already changed the object with ` +
              `${endpoint.method} ${endpoint.id}. Nothing follows about access: the ` +
              `object is missing because we removed it, not because this account was ` +
              `refused.`,
          };
        }
      }
      // A status the tool does not read leaves a row saying so. Without it the
      // commonest `error` in a run was the one with no explanation — the exact
      // case `ProbeFailure` above exists against. Not where a failure is already
      // set: the self-inflicted branch has a more specific thing to say about
      // the same cell.
      if (failure === undefined && classifyStatus(status) === "error") {
        failure = {
          accountId: account.id,
          endpointId: endpoint.id,
          ...(resource === undefined ? {} : { resourceId: resource.id }),
          reason: unreadableStatusReason(status),
        };
      }
    } catch (cause) {
      const terminal = terminalCause(cause);
      if (terminal !== undefined) {
        stopped = true;
      }
      // A failed request is the absence of a conclusion, not a denial of access.
      status = 0;
      headers = {};
      failure = {
        accountId: account.id,
        endpointId: endpoint.id,
        ...(resource === undefined ? {} : { resourceId: resource.id }),
        // The terminal error's own words, not the wrapper's. "The request
        // failed after 3 attempts" describes the symptom and blames the
        // network; "the per-run request budget is exhausted" names the cause
        // and says it was our own doing.
        reason: reasonOf(terminal ?? cause),
      };
    }

    return {
      ...(failure === undefined ? {} : { failure }),
      ...(stopped === undefined ? {} : { truncated: stopped }),
      observation: {
        accountId: account.id,
        endpointId: endpoint.id,
        method: endpoint.method,
        url,
        ...(resource === undefined ? {} : { resourceId: resource.id }),
        status,
        headers,
        outcome:
          status === 0
            ? "error"
            : selfInflicted
              ? // Not `not-found`, which would fold into a denial and read as
                // proof of protection. There is no conclusion to draw here: the
                // object is missing because this run removed it.
                "error"
              : classifyStatus(status),
        durationMs: Date.now() - startedAt,
        // The moment of the request, not only the duration: otherwise there is
        // nothing to match the finding against the platform's log.
        at: new Date(startedAt).toISOString(),
        ...(signals === undefined ? {} : { signals }),
      },
    };
  }

  // A pool of workers pulling from one list, sized by the throttle's own limit.
  //
  // Not "start every task and let the throttle queue them": admission is honest
  // either way, but twenty thousand pending promises are held for the whole run,
  // and the first terminal error would still have to be dealt out to all of
  // them. The pool keeps exactly as many in flight as are allowed to be.
  //
  // The traffic ceiling does not move. `client.send` goes through
  // `throttle.run`, which is where concurrency, the rate window and the per-run
  // budget are enforced; the walk only stops starving it. What does change is
  // the circuit breaker's "consecutive": failures interleave now, so it means
  // "this many with no success in between", and up to `concurrency - 1`
  // requests are already in flight when it trips.
  let next = 0;
  /**
   * Which account the next cell belongs to, and how far into it the walk is.
   *
   * The cursor stands in for the task list: the pair `(walkers[cursor],
   * cells[…])` is what an entry of that list held, and the flat index `next` is
   * where the entry sat. Advanced only by `take`, which does not await, so a
   * worker holds the three values it returns until its own first `await` — the
   * same argument `next` itself rests on, and the same one thread.
   */
  let cursor = 0;
  let within = 0;
  /**
   * Set by the first terminal error, and after it no worker takes another cell.
   *
   * The walk used to carry on to the end of the matrix. Every remaining cell
   * then met an exhausted budget, was retried three times with two backoffs, and
   * became a `probe-error` row — "we asked and it broke" about a request that
   * was never sent. Measured on 610 cells with a budget of 149: 3 184 ms and a
   * **512 KB report against 322 KB for the complete run**. A truncated run cost
   * more than a full one and said less. Found by the audit of 14 August (L-9).
   *
   * The cells not reached are simply not observed, and `truncated: true` is what
   * says the tail was never tested. The same run now takes 1 181 ms and 193 KB,
   * and its 461 rows are `not-observed` — which is true — instead of
   * `probe-error`, which was not.
   *
   * Up to `concurrency - 1` requests are already in flight when this is set;
   * they finish. That is bounded by the limit the operator agreed to.
   */
  let stop = false;
  /** Whether the stop was asked for from outside, rather than earned by the run. */
  const aborted = (): boolean => options.abort?.aborted === true;

  /**
   * The next cell of the walk, or `undefined` when there are none left.
   *
   * Nothing awaits in here, so the claim on a cell and the advance of the cursor
   * cannot interleave with another worker's — one thread, and no suspension
   * point between the two. That is the same argument the flat `next++` rested on
   * before the cursor replaced the list it indexed into.
   */
  function take(): { index: number; walker: Walker; cell: (typeof cells)[number] } | undefined {
    for (;;) {
      const walker = walkers[cursor];
      if (walker === undefined) {
        return undefined;
      }
      if (within >= walker.count) {
        cursor += 1;
        within = 0;
        continue;
      }
      const cell = cells[walker.cellIndices?.[within] ?? within];
      const index = next;
      within += 1;
      next += 1;
      // Unreachable: `count` is the length of `cellIndices` or of `cells`, and
      // both are read at an index below it. Answered rather than asserted —
      // `noNonNullAssertion` is on, and a `!` here would be the one place in the
      // walk where the checker was told to stop looking.
      if (cell === undefined) {
        continue;
      }
      return { index, walker, cell };
    }
  }

  const workers = Array.from(
    { length: Math.max(1, Math.min(options.concurrency ?? 1, total)) },
    async () => {
      for (;;) {
        if (stop || aborted()) {
          return;
        }
        const taken = take();
        if (taken === undefined) {
          return;
        }
        const { index, walker, cell } = taken;
        // A cell taken from the stream: already answered by the run that was
        // interrupted, and not a request this one gets to spend.
        if (observations[index] !== undefined) {
          continue;
        }
        const result = await probe(walker, cell);
        // A cell the stop caught mid-flight is not a cell that was walked. It
        // is neither kept nor recorded: recorded, `--resume` would skip it, and
        // a request the platform never answered would be filed as an answer.
        if (aborted()) {
          return;
        }
        if (result.observation !== undefined) {
          observations[index] = result.observation;
        }
        if (result.failure !== undefined) {
          failuresByIndex.set(index, result.failure);
        }
        if (result.truncated === true) {
          // A terminal condition — an exhausted budget, a tripped breaker — is
          // not an answer either, and it is deliberately not recorded: the cell
          // has to be probed again by whoever resumes.
          truncated = true;
          stop = true;
          return;
        }
        if (options.record !== undefined && result.observation !== undefined) {
          await options.record({
            accountId: walker.account.id,
            endpointId: cell.endpoint.id,
            ...(cell.resource === undefined ? {} : { resourceId: cell.resource.id }),
            observation: result.observation,
            ...(result.failure === undefined ? {} : { failure: result.failure }),
          });
        }
      }
    },
  );
  const walk = Promise.all(workers);
  if (options.abort === undefined) {
    await walk;
  } else {
    // Raced rather than awaited: a request outstanding against a platform that
    // has stopped answering would otherwise hold the whole run for the client's
    // timeout, and the operator pressing Ctrl-C is asking for the opposite of
    // waiting. Whatever those workers do afterwards is discarded by the guard
    // above them.
    await Promise.race([walk, stopped(options.abort)]);
  }

  // Drained in the order the cells were laid out, not the order they came back
  // in. Two runs of the same matrix have to produce the same file, or a diff
  // between two reports is unreadable and `configDigest` promises more than it
  // delivers.
  //
  // In place: the observations are already in that order, at the index of their
  // cell, and what this pass does is close up the holes a stop or a terminal
  // error left. Copying them into a second array instead would put two copies of
  // the matrix in memory at the last step of the walk, which is the thing this
  // arrangement exists to avoid.
  const failures: ProbeFailure[] = [];
  let unreached = false;
  let kept = 0;
  for (let index = 0; index < total; index += 1) {
    const failure = failuresByIndex.get(index);
    if (failure !== undefined) {
      failures.push(failure);
    }
    const observation = observations[index];
    if (observation === undefined) {
      unreached = true;
      continue;
    }
    observations[kept] = observation;
    kept += 1;
  }
  observations.length = kept;
  // A stop from outside that left a cell unwalked is truncation in the sense the
  // word already has here: the tail was never probed, and there are no findings
  // in it because nothing looked. Asked together with `unreached` rather than on
  // its own — a signal arriving after the last cell came back interrupts
  // nothing, and a report calling that walk incomplete would be lying in the
  // direction that costs a rerun.
  if (unreached && aborted()) {
    truncated = true;
  }

  return { observations, skipped, failures, probed: probeable, truncated };
}

/**
 * A promise that settles when the stop is asked for.
 *
 * Resolves rather than rejects: an interruption is a decision, not a failure,
 * and the caller of `collectObservations` has a report to finish writing.
 */
function stopped(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((settle) => {
    signal.addEventListener("abort", () => settle(), { once: true });
  });
}

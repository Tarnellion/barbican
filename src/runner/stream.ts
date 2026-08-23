/**
 * One finished cell on its way out of the walk, and on its way back into one.
 *
 * The record, the key that says which cell it belongs to, and the refusal when a
 * record belongs to no cell of the matrix being walked. `src/report/write.ts`
 * puts these on disk and `src/cli/stream.ts` reads them back; ADR-0047 is the
 * whole of it.
 */

import type { AccessObservation } from "../core/index.js";
import type { ProbeFailure } from "./outcome.js";

/**
 * One finished cell, as it leaves the walk and as it comes back into one.
 *
 * The coordinate is written out beside the observation although the observation
 * carries the same three fields. A reader of the stream keys on the cell, and
 * making it reconstruct the key out of a record whose shape may grow is the kind
 * of duplicate that drifts in the direction nobody watches — here, towards
 * skipping a cell that is not the one that was walked.
 *
 * The failure travels with it. `summary.failures` is built from `failures[]`,
 * and a resumed run that kept the observations only would come back with a
 * smaller number over the same matrix — one walk, two documents.
 */
export interface CellRecord {
  readonly accountId: string;
  readonly endpointId: string;
  readonly resourceId?: string;
  readonly observation: AccessObservation;
  readonly failure?: ProbeFailure;
}

/** The cell a record belongs to: account × endpoint × resource, and nothing else. */
export function cellKey(cell: {
  readonly accountId: string;
  readonly endpointId: string;
  readonly resourceId?: string;
}): string {
  return `${cell.accountId}\u0000${cell.endpointId}\u0000${cell.resourceId ?? ""}`;
}

/**
 * A resumed record that fits no cell of the matrix being walked.
 *
 * The gate on resuming is a digest over the declaration, and it lives where the
 * declaration is read. This is the second lock, on the one thing a digest cannot
 * check — that the cells really are the same cells — and it fires before a
 * single cell of the walk is probed.
 *
 * Left to itself the mismatch is silent and its result is the worst artifact
 * this tool can produce: half a matrix walked under one declaration, half under
 * another, presented as one run with one `configDigest` and one verdict. See
 * ADR-0047.
 */
export class ResumeDoesNotFitError extends Error {
  readonly cells: readonly string[];

  constructor(cells: readonly string[]) {
    super(
      `The walk being resumed does not contain ${cells.length} of the cells the ` +
        `stream already holds, among them ${cells.slice(0, 3).join(", ")}. A resumed ` +
        `run has to be the same run: cells that have gone missing mean the accounts, ` +
        `the endpoints or the resources are not the ones that were walked, and a ` +
        `report assembled out of two declarations would carry one digest and one ` +
        `verdict over both. Start a fresh run, or restore the declaration this ` +
        `stream was made under.`,
    );
    this.name = "ResumeDoesNotFitError";
    this.cells = cells;
  }
}

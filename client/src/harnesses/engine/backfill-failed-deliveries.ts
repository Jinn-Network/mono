/**
 * Administrative backfill (#506): scan FAILED task_runs for ones whose
 * delivery transaction actually landed on-chain and reclassify them as
 * COMPLETE.
 *
 * Background: `insertArtifact()` used to throw on databases still carrying
 * the legacy `artifacts.desired_state_id NOT NULL` column (fixed in #511).
 * The engine's error path (`_runTransition` catch → `_classifyAndMarkTerminal`
 * → `markFailed()`) turned that throw into a FAILED run even though the
 * on-chain delivery — the thing that actually matters for reward eligibility
 * — had already succeeded. This backfill corrects the historical DB rows
 * left behind by that bug; it does not change any live engine behavior.
 *
 * Scope: a FAILED row is only a reclassification candidate when its
 * `failureReason` carries the `artifacts.desired_state_id` NOT NULL
 * constraint signature (see `DESIRED_STATE_ID_FAILURE_SIGNATURE` below).
 * A `deliveryTxHash` + successful receipt alone is NOT sufficient — the
 * daemon persists `deliveryTxHash` after `deliverToMarketplace` lands but
 * *before* `claimDelivery` runs (crash-recovery design, see
 * `client/src/harnesses/engine/delivery.ts`), so a row that genuinely failed
 * at the `claimDelivery` step also carries a `deliveryTxHash` with a
 * successful receipt — reclassifying it would hide a real failure. The
 * receipt check below is a secondary confirmation, applied only after the
 * failure-reason signature already narrows the candidate set to the #506
 * bug.
 *
 * Caveat: because the failure in every #506 case happened at the
 * `insertArtifact()` step, reclassified rows have no corresponding
 * `artifacts` row and no ERC-8004 on-chain metadata anchor — that write is
 * exactly what failed. This backfill does not attempt to reconstruct either;
 * it only corrects `task_runs.state`.
 */

import type { PublicClient } from 'viem';
import { TaskRunPersistence } from './persistence.js';
import { TaskRunState } from './state.js';

/**
 * Substring present in every `failureReason` produced by the #506 bug.
 * The raw SqliteError message is exactly
 * `NOT NULL constraint failed: artifacts.desired_state_id`; `markFailed`
 * persists it verbatim when invoked from `_runTransition`'s 'transition'
 * context, or prefixed with `recovery: ` when invoked from the 'recovery'
 * context (see `_classifyAndMarkTerminal` in engine.ts). This substring
 * survives both forms.
 */
const DESIRED_STATE_ID_FAILURE_SIGNATURE = 'artifacts.desired_state_id';

export interface BackfillFailedDeliveriesDeps {
  persistence: TaskRunPersistence;
  /** Only `.getTransactionReceipt` is used. */
  publicClient: PublicClient;
  /** When true, report what would be reclassified without writing to the DB. Default false. */
  dryRun?: boolean;
}

export interface BackfillFailedDeliveriesResult {
  /** Rows reclassified FAILED → COMPLETE (or that would be, under dryRun). */
  reclassified: Array<{ requestId: string; originalFailureReason: string | null }>;
  /** Request IDs left FAILED because they aren't #506 candidates, or their delivery didn't succeed. */
  skipped: Array<{ requestId: string; reason: string }>;
  /** Request IDs whose receipt lookup errored — left FAILED, not retried within this run. */
  failed: Array<{ requestId: string; error: string }>;
}

export async function backfillFailedDeliveries(
  deps: BackfillFailedDeliveriesDeps,
): Promise<BackfillFailedDeliveriesResult> {
  const { persistence, publicClient, dryRun = false } = deps;
  const result: BackfillFailedDeliveriesResult = { reclassified: [], skipped: [], failed: [] };

  const failedRuns = persistence.getByState(TaskRunState.FAILED);
  for (const run of failedRuns) {
    if (!run.failureReason || !run.failureReason.includes(DESIRED_STATE_ID_FAILURE_SIGNATURE)) {
      result.skipped.push({
        requestId: run.requestId,
        reason: 'failure reason does not match the desired_state_id constraint signature',
      });
      continue;
    }

    if (!run.deliveryTxHash) {
      result.skipped.push({ requestId: run.requestId, reason: 'no deliveryTxHash recorded' });
      continue;
    }

    let receipt;
    try {
      receipt = await publicClient.getTransactionReceipt({
        hash: run.deliveryTxHash as `0x${string}`,
      });
    } catch (err) {
      result.failed.push({
        requestId: run.requestId,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (receipt.status !== 'success') {
      result.skipped.push({
        requestId: run.requestId,
        reason: `delivery tx did not succeed (status=${receipt.status})`,
      });
      continue;
    }

    if (dryRun) {
      result.reclassified.push({ requestId: run.requestId, originalFailureReason: run.failureReason });
      continue;
    }

    const wrote = persistence.reclassifyFailedAsComplete(run.requestId);
    if (wrote) {
      result.reclassified.push({ requestId: run.requestId, originalFailureReason: run.failureReason });
    } else {
      result.skipped.push({ requestId: run.requestId, reason: 'row state changed concurrently' });
    }
  }

  return result;
}

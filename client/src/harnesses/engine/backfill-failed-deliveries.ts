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
 * left behind by that bug; it does not change any live engine behaviour.
 */

import type { PublicClient } from 'viem';
import { TaskRunPersistence } from './persistence.js';
import { TaskRunState } from './state.js';

export interface BackfillFailedDeliveriesDeps {
  persistence: TaskRunPersistence;
  /** Only `.getTransactionReceipt` is used. */
  publicClient: PublicClient;
  /** When true, report what would be reclassified without writing to the DB. Default false. */
  dryRun?: boolean;
}

export interface BackfillFailedDeliveriesResult {
  /** Request IDs reclassified FAILED → COMPLETE (or that would be, under dryRun). */
  reclassified: string[];
  /** Request IDs left FAILED because their delivery didn't succeed (or has no tx hash). */
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

    if (!dryRun) {
      persistence.reclassifyFailedAsComplete(run.requestId);
    }
    result.reclassified.push(run.requestId);
  }

  return result;
}

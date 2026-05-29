import type { Store } from '../store/store.js';
import { resolveCredentialId } from './credential.js';
import { harvestHarnessUsage } from './usage.js';

/**
 * Record the cost of one finished harness run as a `task_cost` activity row.
 * Called once per harness run (at the POST_SNAPSHOT transition). Best-effort:
 * never throws — a parse failure must not break task execution.
 */
export function recordTaskCost(
  store: Store,
  args: {
    requestId: string;
    harness: string;
    model: string | undefined;
    workingDir: string;
    solverType: string | null;
  },
  env: NodeJS.ProcessEnv = process.env,
): void {
  try {
    const credentialId = resolveCredentialId(args.harness, env);
    if (!credentialId) return;
    const usage = harvestHarnessUsage(args.harness, args.workingDir, args.model);
    const actualCostUsdMicros = Math.round(usage.costUsd * 1_000_000);
    store.recordActivityEvent({
      ts: new Date().toISOString(),
      kind: 'task_cost',
      requestId: args.requestId,
      solverType: args.solverType,
      credentialId,
      costUsdMicros: actualCostUsdMicros,
      model: usage.model,
      detail: usage.estimated ? 'estimated' : 'observed',
    });
    // Issue #815: fill actual_cost_usd_micros on the per-request claimed
    // row + set claim_status='delivered'. ai_units stays as captured at
    // claim time (estimates are the gate input, never recomputed).
    // Idempotent: no-op when no claimed row exists for this request id.
    store.finalizeClaimDelivered(args.requestId, actualCostUsdMicros);
  } catch (err) {
    console.warn(
      `[spend] failed to record task cost for ${args.requestId}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

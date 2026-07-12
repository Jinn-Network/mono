/**
 * Pre-claim spend-cap check: skips claims for a credential once today's
 * spend reaches its daily USD cap; logs on under ↔ over transitions only.
 *
 * See docs/superpowers/specs/2026-05-21-per-credential-spend-budget-design.md.
 */
import type { GateLogger } from './gate-logger.js';
import { isOverSpendCap } from '../spend/spend-cap.js';

/** Per-credential paused state, so the warn/info logs fire once per transition. */
const lastPausedByCredential = new Map<string, boolean>();

/**
 * Decide whether a claim may proceed for a credential given today's spend.
 * Mirrors `gateClaimByReadiness`. `newlyPaused` is true only on the first skip
 * of an under->over transition — the daemon emits one event on that edge.
 */
export function gateClaimBySpendCap(args: {
  credentialId: string;
  capUsd: number;
  spentTodayUsd: number;
  logger: GateLogger;
}): { proceed: true } | { proceed: false; reason: string; newlyPaused: boolean } {
  const over = isOverSpendCap(args.spentTodayUsd, args.capUsd);
  const wasPaused = lastPausedByCredential.get(args.credentialId) ?? false;

  if (!over) {
    if (wasPaused) {
      args.logger.info(`[spend-cap] ${args.credentialId} under cap again; resuming claims`);
    }
    lastPausedByCredential.set(args.credentialId, false);
    return { proceed: true };
  }

  const reason =
    `daily spend cap reached for ${args.credentialId} ` +
    `($${args.spentTodayUsd.toFixed(2)} / $${args.capUsd.toFixed(2)})`;
  if (!wasPaused) {
    args.logger.warn(`[spend-cap] ${reason}; pausing claims until 00:00 UTC`);
  }
  lastPausedByCredential.set(args.credentialId, true);
  return { proceed: false, reason, newlyPaused: !wasPaused };
}

/**
 * Test-only: reset the per-credential paused-state memo between tests.
 *
 * IMPORTANT: any test file that imports `gateClaimBySpendCap` must call this
 * in a `beforeEach` hook — the `lastPausedByCredential` map is module-level
 * state that persists across tests in the same Vitest worker. Without the
 * reset, the transition-memo logic will produce false positives based on
 * prior test runs.
 */
export function _resetSpendCapGateMemoForTests(): void {
  lastPausedByCredential.clear();
}

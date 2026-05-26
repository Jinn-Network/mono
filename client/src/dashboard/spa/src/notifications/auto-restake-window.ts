/**
 * Auto-restake suppression-window predicate (#651).
 *
 * Shared by the notifications deriver (`derive.ts`) and the Overview
 * eviction banner (`pages/Overview.tsx`). Mirrors the daemon's gating
 * rule: when auto-restake is enabled, an evicted service is "within
 * window" for `2 × checkIntervalMs` after its `evictedSince` timestamp;
 * during that window the operator is not alarmed so the EvictionLoop
 * has time to settle a restake.
 *
 * Bad data falls through to "outside window" so the operator is alerted
 * — silent suppression is never the safe failure mode.
 */

/**
 * Daemon-emitted eviction-loop gating block (a subset of `/v1/status`).
 * The canonical type lives daemon-side in `client/src/api/status-build.ts`;
 * this alias captures only the fields the SPA reads.
 */
export interface AutoRestakeStatus {
  enabled: boolean;
  checkIntervalMs: number;
}

/** Minimal service shape this predicate reads. */
interface ServiceForWindow {
  evictedSince?: string | null;
}

/**
 * Returns `true` when the service is still inside the auto-restake
 * suppression window (loop enabled, valid `evictedSince`, and now is
 * within `2 × checkIntervalMs` of first observation).
 *
 * Loop disabled, missing timestamp, malformed timestamp, or aged-past
 * window all return `false` (i.e. surface the notification / banner).
 */
export function isWithinAutoRestakeWindow(
  service: ServiceForWindow,
  autoRestake: AutoRestakeStatus | undefined,
  nowMs: number,
): boolean {
  if (autoRestake?.enabled !== true) return false;
  if (typeof service.evictedSince !== 'string') return false;
  const seenAt = Date.parse(service.evictedSince);
  if (Number.isNaN(seenAt)) return false;
  return nowMs - seenAt <= 2 * autoRestake.checkIntervalMs;
}

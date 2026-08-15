/**
 * Dedupes "[daemon] skipping task X — reason" log lines so the engine-watcher
 * loop doesn't emit hundreds of identical lines per minute when a single in-flight
 * slot is occupied. The original loop logged once per `(taskId, reason)` per
 * pass; this helper collapses repeat lines down to one per `(taskId, reason)`
 * pair until the reason changes (or the entry is evicted to keep memory bounded).
 *
 * It additionally maintains a TTL-bounded *work-skip cache*: once `canAcceptTask`
 * rejects a task, the engine-watcher records the skip here and — for
 * `SKIP_RECHECK_TTL_MS` afterwards — fast-skips the task without re-running the
 * (expensive) `canAcceptTask` work at all. With a large backlog of
 * persistently-unacceptable tasks (e.g. ~40 evaluation tasks whose harness is
 * not enabled), re-running manifest resolution + schema validation +
 * `impl.isReady()` for every task every cycle blocks the Node event loop ~1-2s
 * and starves the HTTP API. The cache makes a repeat cycle a Map lookup.
 *
 * SAFETY: the TTL re-check is mandatory and bounded. A task is NEVER skip-cached
 * forever — once `SKIP_RECHECK_TTL_MS` has elapsed the cache reports the task as
 * due for re-check, so a task that becomes acceptable (operator enables the
 * harness, a slot frees up) is always picked up within the TTL.
 *
 * See jinn-mono-kzan (log dedup).
 */

/**
 * How long a task that `canAcceptTask` rejected stays in the work-skip cache
 * before the engine-watcher re-evaluates it. Bounded on purpose: a false
 * permanent skip (a claimable task that is never picked up) is a serious bug,
 * so the cache is only ever a short-lived optimization.
 */
export const SKIP_RECHECK_TTL_MS = 30_000;

interface SkipEntry {
  /** The last skip reason recorded for this task (used for log dedup). */
  reason: string;
  /** Wall-clock time (`Date.now()`) the skip was recorded — drives the TTL. */
  checkedAt: number;
}

export class SkipLogDeduper {
  private entriesByTaskId = new Map<string, SkipEntry>();
  private readonly maxEntries: number;
  private readonly recheckTtlMs: number;

  constructor(maxEntries = 1024, recheckTtlMs = SKIP_RECHECK_TTL_MS) {
    this.maxEntries = Math.max(1, maxEntries);
    this.recheckTtlMs = Math.max(0, recheckTtlMs);
  }

  /**
   * Returns true when the engine-watcher should re-run `canAcceptTask` for
   * `taskId` — i.e. there is no cached skip, or the cached skip is older than
   * `recheckTtlMs`. Returns false when a recent skip is still within the TTL,
   * meaning the caller should fast-skip the task without doing the work.
   *
   * `now` is injectable for deterministic tests; defaults to `Date.now()`.
   */
  shouldRecheck(taskId: string, now: number = Date.now()): boolean {
    const entry = this.entriesByTaskId.get(taskId);
    if (entry === undefined) return true;
    return now - entry.checkedAt >= this.recheckTtlMs;
  }

  /**
   * Records that `canAcceptTask` rejected `taskId` with `reason`, stamping the
   * skip with the current time so subsequent `shouldRecheck` calls can apply
   * the TTL. Refreshes recency for the FIFO memory bound.
   *
   * `now` is injectable for deterministic tests; defaults to `Date.now()`.
   */
  recordSkip(taskId: string, reason: string, now: number = Date.now()): boolean {
    const previous = this.entriesByTaskId.get(taskId);
    const shouldLog = previous?.reason !== reason;
    // Delete-then-set so the entry moves to the end of insertion order, keeping
    // actively-skipped tasks away from the FIFO eviction front.
    this.entriesByTaskId.delete(taskId);
    this.entriesByTaskId.set(taskId, { reason, checkedAt: now });
    if (this.entriesByTaskId.size > this.maxEntries) {
      // Map iteration is insertion-order; evict the oldest entry.
      const oldestKey = this.entriesByTaskId.keys().next().value;
      if (oldestKey !== undefined) {
        this.entriesByTaskId.delete(oldestKey);
      }
    }
    return shouldLog;
  }

  /**
   * Returns true when this `(taskId, reason)` pair has not been logged yet
   * (or the previous reason for this `taskId` was different). Returns false
   * when the previous skip for this task had the same reason — operators
   * already saw the line; another copy is noise.
   *
   * This only governs log output; it does NOT record a work-skip TTL entry.
   * Callers that want the work-skip fast path must also call `recordSkip`.
   */
  shouldLog(taskId: string, reason: string): boolean {
    const previous = this.entriesByTaskId.get(taskId);
    if (previous?.reason === reason) {
      // Refresh recency so we don't evict an actively-skipped task, but keep
      // the original `checkedAt` so the TTL keeps counting from the first skip.
      this.entriesByTaskId.delete(taskId);
      this.entriesByTaskId.set(taskId, previous);
      return false;
    }
    // New or changed reason: this is a fresh skip. Stamp it now so the
    // work-skip TTL and the log-dedup state stay consistent for a caller that
    // only calls `shouldLog`.
    this.recordSkip(taskId, reason);
    return true;
  }

  /**
   * Forget all skip state for `taskId` — both the last-logged reason and the
   * work-skip TTL entry. Called when the task is accepted/claimed so a future
   * skip logs once and is re-checked immediately rather than fast-skipped.
   */
  forget(taskId: string): void {
    this.entriesByTaskId.delete(taskId);
  }
}

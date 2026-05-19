/**
 * Dedupes "[daemon] skipping task X — reason" log lines so the engine-watcher
 * loop doesn't emit hundreds of identical lines per minute when a single in-flight
 * slot is occupied. The original loop logged once per `(taskId, reason)` per
 * pass; this helper collapses repeat lines down to one per `(taskId, reason)`
 * pair until the reason changes (or the entry is evicted to keep memory bounded).
 *
 * See jinn-mono-kzan.
 */
export class SkipLogDeduper {
  private lastReasonByTaskId = new Map<string, string>();
  private readonly maxEntries: number;

  constructor(maxEntries = 1024) {
    this.maxEntries = Math.max(1, maxEntries);
  }

  /**
   * Returns true when this `(taskId, reason)` pair has not been logged yet
   * (or the previous reason for this `taskId` was different). Returns false
   * when the previous skip for this task had the same reason — operators
   * already saw the line; another copy is noise.
   */
  shouldLog(taskId: string, reason: string): boolean {
    const previous = this.lastReasonByTaskId.get(taskId);
    if (previous === reason) {
      // Refresh recency so we don't evict an actively-skipped task.
      this.lastReasonByTaskId.delete(taskId);
      this.lastReasonByTaskId.set(taskId, reason);
      return false;
    }
    this.lastReasonByTaskId.set(taskId, reason);
    if (this.lastReasonByTaskId.size > this.maxEntries) {
      // Map iteration is insertion-order; evict the oldest entry.
      const oldestKey = this.lastReasonByTaskId.keys().next().value;
      if (oldestKey !== undefined) {
        this.lastReasonByTaskId.delete(oldestKey);
      }
    }
    return true;
  }

  /** Forget the last-logged reason for `taskId` (e.g. when the task is claimed). */
  forget(taskId: string): void {
    this.lastReasonByTaskId.delete(taskId);
  }
}

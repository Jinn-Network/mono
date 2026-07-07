import { describe, it, expect } from 'vitest';
import { SkipLogDeduper, SKIP_RECHECK_TTL_MS } from '../../src/daemon/skip-log-dedup.js';

describe('SkipLogDeduper (jinn-mono-kzan)', () => {
  it('logs the first skip for a (taskId, reason) pair and suppresses repeats', () => {
    const dedup = new SkipLogDeduper();
    const reason = 'another swe-rebench-v2.v1/restoration task is already in flight';

    expect(dedup.shouldLog('84', reason)).toBe(true);
    expect(dedup.shouldLog('84', reason)).toBe(false);
    expect(dedup.shouldLog('84', reason)).toBe(false);
  });

  it('re-logs when the reason for the same taskId changes', () => {
    const dedup = new SkipLogDeduper();
    expect(dedup.shouldLog('84', 'slot busy')).toBe(true);
    expect(dedup.shouldLog('84', 'slot busy')).toBe(false);
    expect(dedup.shouldLog('84', 'harness not ready')).toBe(true);
    expect(dedup.shouldLog('84', 'harness not ready')).toBe(false);
  });

  it('treats different taskIds independently', () => {
    const dedup = new SkipLogDeduper();
    const reason = 'slot busy';
    expect(dedup.shouldLog('84', reason)).toBe(true);
    expect(dedup.shouldLog('85', reason)).toBe(true);
    expect(dedup.shouldLog('84', reason)).toBe(false);
    expect(dedup.shouldLog('85', reason)).toBe(false);
  });

  it('forget() re-arms logging for a taskId', () => {
    const dedup = new SkipLogDeduper();
    expect(dedup.shouldLog('84', 'slot busy')).toBe(true);
    expect(dedup.shouldLog('84', 'slot busy')).toBe(false);
    dedup.forget('84');
    expect(dedup.shouldLog('84', 'slot busy')).toBe(true);
  });

  it('evicts oldest entries when maxEntries is exceeded (FIFO bound)', () => {
    const dedup = new SkipLogDeduper(2);
    expect(dedup.shouldLog('1', 'reason')).toBe(true);
    expect(dedup.shouldLog('2', 'reason')).toBe(true);
    // '1' and '2' are still tracked; logging them again is a dedup hit.
    expect(dedup.shouldLog('1', 'reason')).toBe(false);
    expect(dedup.shouldLog('2', 'reason')).toBe(false);
    // Inserting a third entry evicts the oldest ('1').
    expect(dedup.shouldLog('3', 'reason')).toBe(true);
    // '1' was evicted, so the next skip for '1' logs again.
    expect(dedup.shouldLog('1', 'reason')).toBe(true);
  });
});

describe('SkipLogDeduper work-skip cache', () => {
  it('shouldRecheck is true for a task never skipped', () => {
    const dedup = new SkipLogDeduper();
    expect(dedup.shouldRecheck('84')).toBe(true);
  });

  it('fast-skips a recently-skipped task within the TTL', () => {
    const dedup = new SkipLogDeduper();
    const t0 = 1_000_000;
    dedup.recordSkip('84', 'slot busy', t0);
    // Same instant and any time strictly inside the TTL: fast-skip (no recheck).
    expect(dedup.shouldRecheck('84', t0)).toBe(false);
    expect(dedup.shouldRecheck('84', t0 + SKIP_RECHECK_TTL_MS - 1)).toBe(false);
  });

  it('re-checks a task once the TTL has elapsed', () => {
    const dedup = new SkipLogDeduper();
    const t0 = 1_000_000;
    dedup.recordSkip('84', 'slot busy', t0);
    // At exactly the TTL boundary and beyond, the task is due for re-check.
    expect(dedup.shouldRecheck('84', t0 + SKIP_RECHECK_TTL_MS)).toBe(true);
    expect(dedup.shouldRecheck('84', t0 + SKIP_RECHECK_TTL_MS + 5_000)).toBe(true);
  });

  it('never skip-caches a task forever — a stale skip always re-checks', () => {
    const dedup = new SkipLogDeduper();
    const t0 = 0;
    dedup.recordSkip('84', 'harness not ready', t0);
    // Even a very old skip must re-check: a task that became acceptable
    // (operator enabled the harness) must not be stuck behind the cache.
    expect(dedup.shouldRecheck('84', t0 + 24 * 60 * 60 * 1_000)).toBe(true);
  });

  it('recordSkip refreshes the TTL window from the latest skip', () => {
    const dedup = new SkipLogDeduper();
    const t0 = 1_000_000;
    dedup.recordSkip('84', 'slot busy', t0);
    // Re-record near the end of the first window: checkedAt moves to the new
    // time, so the TTL counts afresh from there.
    const t1 = t0 + SKIP_RECHECK_TTL_MS - 1;
    dedup.recordSkip('84', 'slot busy', t1);
    // A point past the *first* window but inside the *second* still fast-skips.
    expect(dedup.shouldRecheck('84', t0 + SKIP_RECHECK_TTL_MS)).toBe(false);
    expect(dedup.shouldRecheck('84', t1 + SKIP_RECHECK_TTL_MS - 1)).toBe(false);
    // At the new window's boundary it re-checks again.
    expect(dedup.shouldRecheck('84', t1 + SKIP_RECHECK_TTL_MS)).toBe(true);
  });

  it('recordSkip returns whether the skip reason should be logged', () => {
    const dedup = new SkipLogDeduper();

    expect(dedup.recordSkip('84', 'slot busy')).toBe(true);
    expect(dedup.recordSkip('84', 'slot busy')).toBe(false);
    expect(dedup.recordSkip('84', 'harness not ready')).toBe(true);
    expect(dedup.recordSkip('85', 'harness not ready')).toBe(true);
  });

  it('forget() clears the work-skip cache so the task re-checks immediately', () => {
    const dedup = new SkipLogDeduper();
    const t0 = 1_000_000;
    dedup.recordSkip('84', 'slot busy', t0);
    expect(dedup.shouldRecheck('84', t0)).toBe(false);
    // Accepting the task forgets it; the next skip must re-check, not fast-skip.
    dedup.forget('84');
    expect(dedup.shouldRecheck('84', t0)).toBe(true);
  });

  it('forget() clears both the log-dedup and the work-skip state', () => {
    const dedup = new SkipLogDeduper();
    const t0 = 1_000_000;
    dedup.recordSkip('84', 'slot busy', t0);
    expect(dedup.shouldLog('84', 'slot busy')).toBe(false);
    expect(dedup.shouldRecheck('84', t0)).toBe(false);
    dedup.forget('84');
    // Log re-arms.
    expect(dedup.shouldLog('84', 'slot busy')).toBe(true);
  });

  it('shouldLog stamps a fresh skip so a shouldLog-only caller still gets the TTL', () => {
    const dedup = new SkipLogDeduper();
    // A caller that only calls shouldLog (no explicit recordSkip) still gets a
    // work-skip cache entry, so the work-skip fast path applies.
    expect(dedup.shouldLog('84', 'slot busy')).toBe(true);
    expect(dedup.shouldRecheck('84')).toBe(false);
  });

  it('shouldLog with an unchanged reason preserves the original checkedAt', () => {
    const dedup = new SkipLogDeduper();
    const t0 = 1_000_000;
    dedup.recordSkip('84', 'slot busy', t0);
    // A repeat shouldLog for the same reason refreshes recency but must NOT
    // reset the TTL — otherwise a task that keeps re-skipping would never
    // re-check.
    dedup.shouldLog('84', 'slot busy');
    expect(dedup.shouldRecheck('84', t0 + SKIP_RECHECK_TTL_MS)).toBe(true);
  });

  it('treats different taskIds independently in the work-skip cache', () => {
    const dedup = new SkipLogDeduper();
    const t0 = 1_000_000;
    dedup.recordSkip('84', 'slot busy', t0);
    expect(dedup.shouldRecheck('84', t0)).toBe(false);
    // '85' was never skipped, so it must be re-checked.
    expect(dedup.shouldRecheck('85', t0)).toBe(true);
  });
});

describe('engine-watcher work-skip semantics (integration)', () => {
  /**
   * Mirrors the engine-watcher loop's decision logic against a fake
   * `canAcceptTask`, asserting the expensive call is NOT re-run within the TTL
   * and IS re-run once the TTL elapses. This is the unit-level proxy for the
   * loop in `_runEngineWatcherLoop` (which is private and would otherwise need
   * a full Daemon to drive).
   */
  function runCycle(
    dedup: SkipLogDeduper,
    taskId: string,
    now: number,
    canAcceptTask: () => { ok: boolean; reason: string },
  ): { checked: boolean; accepted: boolean } {
    if (!dedup.shouldRecheck(taskId, now)) {
      return { checked: false, accepted: false };
    }
    const accept = canAcceptTask();
    if (!accept.ok) {
      dedup.recordSkip(taskId, accept.reason, now);
      dedup.shouldLog(taskId, accept.reason);
      return { checked: true, accepted: false };
    }
    dedup.forget(taskId);
    return { checked: true, accepted: true };
  }

  it('does not re-run canAcceptTask within the TTL', () => {
    const dedup = new SkipLogDeduper();
    let calls = 0;
    const canAccept = () => {
      calls++;
      return { ok: false, reason: 'evaluator harness not enabled' };
    };
    const t0 = 1_000_000;
    // First cycle: checks and records the skip.
    expect(runCycle(dedup, '84', t0, canAccept).checked).toBe(true);
    expect(calls).toBe(1);
    // Subsequent cycles within the TTL: fast-skipped, canAcceptTask NOT called.
    runCycle(dedup, '84', t0 + 1, canAccept);
    runCycle(dedup, '84', t0 + 10_000, canAccept);
    runCycle(dedup, '84', t0 + SKIP_RECHECK_TTL_MS - 1, canAccept);
    expect(calls).toBe(1);
  });

  it('re-runs canAcceptTask after the TTL elapses', () => {
    const dedup = new SkipLogDeduper();
    let calls = 0;
    const canAccept = () => {
      calls++;
      return { ok: false, reason: 'evaluator harness not enabled' };
    };
    const t0 = 1_000_000;
    runCycle(dedup, '84', t0, canAccept);
    expect(calls).toBe(1);
    // Once the TTL has elapsed the task is re-checked.
    runCycle(dedup, '84', t0 + SKIP_RECHECK_TTL_MS, canAccept);
    expect(calls).toBe(2);
  });

  it('processes a task that becomes acceptable after the TTL', () => {
    const dedup = new SkipLogDeduper();
    let acceptable = false;
    const canAccept = () =>
      acceptable
        ? { ok: true, reason: '' }
        : { ok: false, reason: 'evaluator harness not enabled' };
    const t0 = 1_000_000;
    // Skipped initially.
    expect(runCycle(dedup, '84', t0, canAccept).accepted).toBe(false);
    // Operator enables the harness mid-TTL — but the cache fast-skips until TTL.
    acceptable = true;
    expect(runCycle(dedup, '84', t0 + 5_000, canAccept).accepted).toBe(false);
    // After the TTL the task is re-checked and now accepted — never stuck.
    expect(runCycle(dedup, '84', t0 + SKIP_RECHECK_TTL_MS, canAccept).accepted).toBe(true);
  });

  it('forgets an accepted task so a future skip re-checks immediately', () => {
    const dedup = new SkipLogDeduper();
    let calls = 0;
    let acceptable = true;
    const canAccept = () => {
      calls++;
      return acceptable
        ? { ok: true, reason: '' }
        : { ok: false, reason: 'slot busy' };
    };
    const t0 = 1_000_000;
    // Task accepted → forgotten from both caches.
    expect(runCycle(dedup, '84', t0, canAccept).accepted).toBe(true);
    expect(calls).toBe(1);
    // Slot fills again: the very next cycle must re-check (not fast-skip),
    // because the accept path cleared the work-skip entry.
    acceptable = false;
    expect(runCycle(dedup, '84', t0 + 1, canAccept).checked).toBe(true);
    expect(calls).toBe(2);
  });
});

import { describe, it, expect } from 'vitest';
import { SkipLogDeduper } from '../../src/daemon/skip-log-dedup.js';

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

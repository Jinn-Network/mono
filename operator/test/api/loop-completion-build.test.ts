import { describe, expect, it } from 'vitest';
import type { TaskRunReadModel } from '../../src/types/task-run-read-model.js';
import type { PersistedTaskRun, TaskRunState } from '../../src/types/task-run.js';
import {
  gatherLoopCompletion,
  LOOP_COMPLETION_TTL_MS,
} from '../../src/api/loop-completion-build.js';

/** Minimal counting fake — only `getGatingRows` is exercised. */
class CountingGatingReadModel implements TaskRunReadModel {
  calls = 0;
  constructor(
    private readonly gating: Array<{ phasesJson: string | null; deliveredTxHash: string | null }>,
  ) {}
  getInFlight(): PersistedTaskRun[] {
    return [];
  }
  getByState(_state: TaskRunState): PersistedTaskRun[] {
    return [];
  }
  getGatingRows(): Array<{ phasesJson: string | null; deliveredTxHash: string | null }> {
    this.calls += 1;
    return this.gating;
  }
}

const SAMPLE_ROWS = [
  { phasesJson: JSON.stringify(['execute', 'improve']), deliveredTxHash: '0xabc' },
  { phasesJson: null, deliveredTxHash: null },
] as const;

const EXPECTED = {
  total: 2,
  delivered: 1,
  withGating: 1,
  reachedExecute: 1,
  reachedImprove: 1,
  reachedMemoryConsolidation: 0,
  fullLoop: 0,
  phaseCounts: { execute: 1, improve: 1 },
};

describe('gatherLoopCompletion short-TTL memo (#999)', () => {
  it('exports LOOP_COMPLETION_TTL_MS = 30_000', () => {
    expect(LOOP_COMPLETION_TTL_MS).toBe(30_000);
  });

  it('within TTL, second call skips getGatingRows and returns the same rollup', () => {
    const runs = new CountingGatingReadModel([...SAMPLE_ROWS]);
    const cacheKey = {};
    const ttlMs = 1_000;
    const now = 1_000_000;

    const first = gatherLoopCompletion(runs, { cacheKey, now, ttlMs });
    const second = gatherLoopCompletion(runs, { cacheKey, now: now + 500, ttlMs });

    expect(runs.calls).toBe(1);
    expect(first).toEqual(EXPECTED);
    expect(second).toEqual(first);
  });

  it('after TTL expiry, recomputes via a second getGatingRows call', () => {
    const runs = new CountingGatingReadModel([...SAMPLE_ROWS]);
    const cacheKey = {};
    const ttlMs = 1_000;
    const now = 1_000_000;

    gatherLoopCompletion(runs, { cacheKey, now, ttlMs });
    const after = gatherLoopCompletion(runs, { cacheKey, now: now + ttlMs, ttlMs });

    expect(runs.calls).toBe(2);
    expect(after).toEqual(EXPECTED);
  });

  it('without cacheKey, every call hits getGatingRows (preserves #1584 fake behavior)', () => {
    const runs = new CountingGatingReadModel([...SAMPLE_ROWS]);

    gatherLoopCompletion(runs);
    gatherLoopCompletion(runs, { now: 1, ttlMs: 60_000 });

    expect(runs.calls).toBe(2);
  });

  it('on getGatingRows throw, returns empty without caching (next within-TTL call rescans)', () => {
    const gating = [...SAMPLE_ROWS];
    let shouldThrow = true;
    const runs: TaskRunReadModel & { calls: number } = {
      calls: 0,
      getInFlight: () => [],
      getByState: () => [],
      getGatingRows() {
        runs.calls += 1;
        if (shouldThrow) throw new Error('transient read failure');
        return gating;
      },
    };
    const cacheKey = {};
    const ttlMs = 1_000;
    const now = 1_000_000;

    const first = gatherLoopCompletion(runs, { cacheKey, now, ttlMs });
    shouldThrow = false;
    const second = gatherLoopCompletion(runs, { cacheKey, now: now + 500, ttlMs });

    expect(first).toEqual({
      total: 0,
      delivered: 0,
      withGating: 0,
      reachedExecute: 0,
      reachedImprove: 0,
      reachedMemoryConsolidation: 0,
      fullLoop: 0,
      phaseCounts: {},
    });
    expect(runs.calls).toBe(2);
    expect(second).toEqual(EXPECTED);
  });

  it('after TTL expiry, recomputes reflects mutated gating rows', () => {
    const gating: Array<{ phasesJson: string | null; deliveredTxHash: string | null }> = [
      ...SAMPLE_ROWS,
    ];
    const runs = new CountingGatingReadModel(gating);
    const cacheKey = {};
    const ttlMs = 1_000;
    const now = 1_000_000;

    const first = gatherLoopCompletion(runs, { cacheKey, now, ttlMs });
    gating.push({
      phasesJson: JSON.stringify(['execute', 'improve', 'memory-consolidation']),
      deliveredTxHash: '0xdef',
    });
    const after = gatherLoopCompletion(runs, { cacheKey, now: now + ttlMs, ttlMs });

    expect(runs.calls).toBe(2);
    expect(first).toEqual(EXPECTED);
    expect(after).toEqual({
      total: 3,
      delivered: 2,
      withGating: 2,
      reachedExecute: 2,
      reachedImprove: 2,
      reachedMemoryConsolidation: 1,
      fullLoop: 1,
      phaseCounts: { execute: 2, improve: 2, 'memory-consolidation': 1 },
    });
  });

  it('distinct cacheKeys do not share a memo (ephemeral keys always miss)', () => {
    const runs = new CountingGatingReadModel([...SAMPLE_ROWS]);
    const ttlMs = 1_000;
    const now = 1_000_000;

    gatherLoopCompletion(runs, { cacheKey: {}, now, ttlMs });
    gatherLoopCompletion(runs, { cacheKey: {}, now: now + 100, ttlMs });

    expect(runs.calls).toBe(2);
  });
});

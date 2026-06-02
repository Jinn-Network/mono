import { describe, expect, it } from 'vitest';
import { buildTrainSequence, TrainTestOverlapError } from '@/eval/train-sequence.js';
import type { PoolTask } from '@/solver-types/_swe-rebench-v2-pool.js';

function pool(...ids: string[]): PoolTask[] {
  return ids.map((instance_id) => ({
    instance_id,
    hf_dataset: 'nebius/SWE-rebench-leaderboard',
    hf_split: '2026_02',
    base_commit: 'a'.repeat(40),
    problem_statement: `fix ${instance_id}`,
  }));
}

describe('buildTrainSequence', () => {
  it('picks N distinct training tasks excluding the held-out slate (AC#2)', () => {
    const slate = new Set(['s1', 's2', 's3']);
    const seq = buildTrainSequence({
      pool: pool('s1', 't1', 's2', 't2', 't3', 's3', 't4'),
      slateIds: slate,
      count: 3,
    });
    expect(seq).toHaveLength(3);
    const ids = seq.map((t) => t.instance_id);
    // No training task is in the slate — the load-bearing AC#2 guarantee.
    for (const id of ids) expect(slate.has(id)).toBe(false);
    // Distinct.
    expect(new Set(ids).size).toBe(3);
  });

  it('intersection of the built sequence with the slate is empty', () => {
    const slate = new Set(['s1', 's2']);
    const seq = buildTrainSequence({
      pool: pool('t1', 's1', 't2', 's2', 't3'),
      slateIds: slate,
      count: 3,
    });
    const overlap = seq.map((t) => t.instance_id).filter((id) => slate.has(id));
    expect(overlap).toEqual([]);
  });

  it('is deterministic: same pool + count yields the same instance_ids in order', () => {
    const args = { pool: pool('t3', 't1', 't2', 't4'), slateIds: new Set<string>(), count: 3 };
    const a = buildTrainSequence(args).map((t) => t.instance_id);
    const b = buildTrainSequence(args).map((t) => t.instance_id);
    expect(a).toEqual(b);
  });

  it('throws when the eligible pool cannot supply N distinct training tasks', () => {
    expect(() =>
      buildTrainSequence({ pool: pool('s1', 't1', 's2'), slateIds: new Set(['s1', 's2']), count: 3 }),
    ).toThrow(/only 1 eligible/);
  });

  it('fails loud if a hand-picked sequence overlaps the slate (assertNoOverlap)', () => {
    const slate = new Set(['s1']);
    expect(() =>
      buildTrainSequence({
        pool: pool('t1', 't2'),
        slateIds: slate,
        count: 2,
        explicitIds: ['t1', 's1'],
      }),
    ).toThrow(TrainTestOverlapError);
  });

  it('honours an explicit, non-overlapping hand-picked sequence', () => {
    const seq = buildTrainSequence({
      pool: pool('t1', 't2', 't3'),
      slateIds: new Set(['s1']),
      count: 2,
      explicitIds: ['t2', 't1'],
    });
    expect(seq.map((t) => t.instance_id)).toEqual(['t2', 't1']);
  });
});

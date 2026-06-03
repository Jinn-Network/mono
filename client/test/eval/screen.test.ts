import { describe, it, expect } from 'vitest';
import { repoOf, stratifyByRepo } from '../../src/eval/screen.js';
import type { PoolTask } from '../../src/solver-types/_swe-rebench-v2-pool.js';

const t = (instance_id: string): PoolTask => ({ instance_id }) as PoolTask;

describe('repoOf', () => {
  it('returns the org prefix before the first __', () => {
    expect(repoOf(t('tobymao__sqlglot-4661'))).toBe('tobymao');
    expect(repoOf(t('All-Hands-AI__OpenHands-11914'))).toBe('All-Hands-AI');
  });
});

describe('stratifyByRepo', () => {
  it('round-robins across repos, deterministic within and across groups', () => {
    const pool = [
      t('b__r-2'), t('a__r-3'), t('a__r-1'), t('b__r-1'), t('a__r-2'),
    ];
    // groups sorted by repo: a=[a__r-1,a__r-2,a__r-3], b=[b__r-1,b__r-2]
    // round-robin: a__r-1, b__r-1, a__r-2, b__r-2, a__r-3
    expect(stratifyByRepo(pool).map((x) => x.instance_id)).toEqual([
      'a__r-1', 'b__r-1', 'a__r-2', 'b__r-2', 'a__r-3',
    ]);
  });
});

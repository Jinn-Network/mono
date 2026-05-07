import { describe, it, expect } from 'vitest';
import { listMonthlyPartitions, buildHistoricalPool } from '../../src/solver-types/_swe-rebench-v2-pool.js';

describe('listMonthlyPartitions', () => {
  it('detects month-shaped split names from the dataset config', () => {
    const splits = ['2025_01', '2025_02', 'test', 'lite', '2026_02'];
    const months = listMonthlyPartitions(splits);
    expect(months).toEqual(['2025_01', '2025_02', '2026_02']);
  });

  it('returns months sorted ascending', () => {
    const months = listMonthlyPartitions(['2026_02', '2025_03', '2025_01']);
    expect(months).toEqual(['2025_01', '2025_03', '2026_02']);
  });
});

describe('buildHistoricalPool', () => {
  it('aggregates instance_ids across monthly partitions, deduplicated', async () => {
    const fakeFetcher = async (split: string) => {
      if (split === '2025_01') return [{ instance_id: 'a' }, { instance_id: 'b' }];
      if (split === '2025_02') return [{ instance_id: 'b' }, { instance_id: 'c' }];
      return [];
    };
    const pool = await buildHistoricalPool({
      months: ['2025_01', '2025_02'],
      fetchSplit: fakeFetcher,
    });
    expect(pool.map((t) => t.instance_id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('preserves task language for round-robin balancing later', async () => {
    const fakeFetcher = async () => [{ instance_id: 'x', language: 'python' }];
    const pool = await buildHistoricalPool({
      months: ['2025_01'],
      fetchSplit: fakeFetcher,
    });
    expect(pool[0].language).toBe('python');
  });
});

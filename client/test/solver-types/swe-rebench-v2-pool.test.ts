import { describe, it, expect, vi } from 'vitest';
import {
  listMonthlyPartitions,
  buildHistoricalPool,
  fetchHfSplit,
} from '../../src/solver-types/_swe-rebench-v2-pool.js';

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

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

describe('fetchHfSplit', () => {
  it('retries on 429 then succeeds, returning the parsed row array', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(
        jsonResponse({
          rows: [
            { row: { instance_id: 'a', repo: 'r' } },
            { row: { instance_id: 'b', repo: 'r' } },
          ],
        }),
      );
    const rows = await fetchHfSplit(
      { dataset: 'nebius/SWE-rebench-leaderboard', split: '2026_02', limit: 100 },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        retryBackoffMs: [1, 2],
        minRequestIntervalMs: 0,
        sleep: async () => undefined,
      },
    );
    expect(rows.map((r: { instance_id: string }) => r.instance_id)).toEqual(['a', 'b']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('throws loudly on a non-2xx after retry exhaustion (regression: previously returned [] silently)', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response('', { status: 500 });
    }) as unknown as typeof fetch;
    await expect(
      fetchHfSplit(
        { dataset: 'nebius/SWE-rebench-leaderboard', split: '2026_02', limit: 100 },
        {
          fetchImpl,
          retryBackoffMs: [1, 2],
          minRequestIntervalMs: 0,
          sleep: async () => undefined,
        },
      ),
    ).rejects.toThrow(/500/);
    expect(calls).toBe(3); // 1 initial + 2 retries
  });
});

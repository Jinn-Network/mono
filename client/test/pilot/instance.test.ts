import { describe, it, expect, vi } from 'vitest';
import { fetchPilotRawRow, parsePilotInstanceRow } from '../../src/pilot/instance.js';
import type { HfRequestLimiter } from '../../src/harnesses/impls/swe-rebench-v2-evaluator/hf-fetcher.js';

describe('pilot instance parse', () => {
  it('pulls the solve-side fields the grader HfRow omits', () => {
    const row = { instance_id: 'pilosus__pip-license-checker-119', repo: 'pilosus/pip-license-checker',
      base_commit: '22d2f959', problem_statement: 'pin the API version header' };
    expect(parsePilotInstanceRow(row, { hf_dataset: 'ds', hf_split: 'train' })).toEqual({
      instance_id: 'pilosus__pip-license-checker-119', repo: 'pilosus/pip-license-checker',
      base_commit: '22d2f959', problem_statement: 'pin the API version header',
      hf_dataset: 'ds', hf_split: 'train',
    });
  });
  it('throws when base_commit or problem_statement is missing', () => {
    expect(() => parsePilotInstanceRow({ instance_id: 'x', repo: 'a/b', base_commit: 'c' }, { hf_dataset: 'ds', hf_split: 't' })).toThrow(/problem_statement/);
  });
  it('extracts the optional interface (acceptance spec) when present, omits it when absent', () => {
    const base = { instance_id: 'x', repo: 'a/b', base_commit: 'c', problem_statement: 'p' };
    expect(parsePilotInstanceRow({ ...base, interface: 'get-headers must return ...' }, { hf_dataset: 'ds', hf_split: 't' }).interface)
      .toBe('get-headers must return ...');
    expect(parsePilotInstanceRow(base, { hf_dataset: 'ds', hf_split: 't' })).not.toHaveProperty('interface');
  });
});

describe('pilot raw-row fetch', () => {
  it('retries a transient HF 429 through the shared retry helper', async () => {
    const row = {
      instance_id: 'alpha__repo-1',
      repo: 'alpha/repo',
      base_commit: 'a'.repeat(40),
      problem_statement: 'Fix it.',
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ rows: [{ row }] }), { status: 200 }));
    const limiter: HfRequestLimiter = { schedule: (fn) => fn() };

    await expect(fetchPilotRawRow({
      instance_id: row.instance_id,
      hf_dataset: 'dataset',
      hf_split: 'train',
    }, {
      fetchImpl,
      retryBackoffMs: [0],
      minRequestIntervalMs: 0,
      sleep: async () => undefined,
      limiter,
      random: () => 0.5,
    })).resolves.toEqual(row);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

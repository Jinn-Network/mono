import { describe, it, expect, vi } from 'vitest';
import { HttpHfFetcher } from '../../../../src/harnesses/impls/swe-rebench-v2-evaluator/hf-fetcher.js';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('HttpHfFetcher', () => {
  it('finds the matching instance_id on the first page', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        rows: [
          {
            row: {
              instance_id: 'unidata__netcdf-c-1925',
              repo: 'Unidata/netcdf-c',
              image_name: 'docker.io/swerebenchv2/netcdf-c:1925',
              FAIL_TO_PASS: ['test_a'],
              PASS_TO_PASS: ['test_b'],
              test_patch: 'diff --git ...',
              install_config: { install: 'pip install -e .', test_cmd: 'make test', log_parser: 'pytest' },
            },
          },
        ],
      }),
    );
    const fetcher = new HttpHfFetcher({ fetchImpl, pageSize: 100, maxRows: 200 });
    const row = await fetcher.fetchTaskRow({
      hf_dataset: 'nebius/SWE-rebench-leaderboard',
      hf_split: '2026_02',
      instance_id: 'unidata__netcdf-c-1925',
    });
    expect(row.instance_id).toBe('unidata__netcdf-c-1925');
    expect(row.repo).toBe('Unidata/netcdf-c');
    expect(row.image_name).toBe('docker.io/swerebenchv2/netcdf-c:1925');
    expect(row.FAIL_TO_PASS).toEqual(['test_a']);
    expect(row.install_config.install).toBe('pip install -e .');
    expect(row.install_config.test_cmd).toBe('make test');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('paginates until the instance_id is found', async () => {
    const fetchImpl = vi.fn();
    // First page: 100 rows that don't match.
    fetchImpl.mockResolvedValueOnce(
      jsonResponse({
        rows: Array.from({ length: 100 }, (_, i) => ({
          row: {
            instance_id: `irrelevant-${i}`,
            image_name: `img-${i}`,
            FAIL_TO_PASS: [],
            PASS_TO_PASS: [],
            test_patch: '',
            install_config: { test_cmd: '', log_parser: '' },
          },
        })),
      }),
    );
    // Second page: contains the target.
    fetchImpl.mockResolvedValueOnce(
      jsonResponse({
        rows: [
          {
            row: {
              instance_id: 'target-instance',
              repo: 'owner/target',
              image_name: 'img-target',
              FAIL_TO_PASS: [],
              PASS_TO_PASS: [],
              test_patch: '',
              install_config: { test_cmd: 'pytest', log_parser: 'pytest' },
            },
          },
        ],
      }),
    );
    const fetcher = new HttpHfFetcher({ fetchImpl, pageSize: 100 });
    const row = await fetcher.fetchTaskRow({
      hf_dataset: 'nebius/SWE-rebench-leaderboard',
      hf_split: '2026_03',
      instance_id: 'target-instance',
    });
    expect(row.instance_id).toBe('target-instance');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const secondCallUrl = fetchImpl.mock.calls[1]![0] as string;
    expect(secondCallUrl).toContain('offset=100');
  });

  it('throws when the instance_id is not found within maxRows', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        rows: Array.from({ length: 50 }, (_, i) => ({
          row: {
            instance_id: `mismatch-${i}`,
            repo: 'owner/repo',
            image_name: 'img',
            FAIL_TO_PASS: [],
            PASS_TO_PASS: [],
            test_patch: '',
            install_config: { test_cmd: '', log_parser: '' },
          },
        })),
      }),
    );
    const fetcher = new HttpHfFetcher({ fetchImpl, pageSize: 100, maxRows: 50 });
    await expect(
      fetcher.fetchTaskRow({
        hf_dataset: 'nebius/SWE-rebench-leaderboard',
        hf_split: '2026_02',
        instance_id: 'never-found',
      }),
    ).rejects.toThrow(/not found in nebius\/SWE-rebench-leaderboard\/2026_02/);
  });

  it('throws when HF datasets-server returns non-2xx', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 }));
    const fetcher = new HttpHfFetcher({ fetchImpl });
    await expect(
      fetcher.fetchTaskRow({
        hf_dataset: 'nebius/SWE-rebench-leaderboard',
        hf_split: '2026_02',
        instance_id: 'whatever',
      }),
    ).rejects.toThrow(/HF datasets-server returned 429/);
  });

  it('throws when image_name is missing on the matching row', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        rows: [
          {
            row: {
              instance_id: 'target',
              FAIL_TO_PASS: [],
              PASS_TO_PASS: [],
              test_patch: '',
              install_config: { test_cmd: '', log_parser: '' },
            },
          },
        ],
      }),
    );
    const fetcher = new HttpHfFetcher({ fetchImpl });
    await expect(
      fetcher.fetchTaskRow({
        hf_dataset: 'nebius/SWE-rebench-leaderboard',
        hf_split: '2026_02',
        instance_id: 'target',
      }),
    ).rejects.toThrow(/missing image_name/);
  });
});

describe('HttpHfFetcher — retry budget for transient failures', () => {
  it('retries on transient HTTP 5xx and succeeds on the third try', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls < 3) return new Response('', { status: 503 });
      return new Response(JSON.stringify({
        rows: [{ row: makeRow('a__1') }],
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const fetcher = new HttpHfFetcher({ fetchImpl, retryBackoffMs: [1, 2, 4] });
    const row = await fetcher.fetchTaskRow({ hf_dataset: 'd', hf_split: 's', instance_id: 'a__1' });
    expect(row.instance_id).toBe('a__1');
    expect(calls).toBe(3);
  });

  it('gives up after exhausting the retry budget and throws', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response('', { status: 503 });
    }) as unknown as typeof fetch;
    const fetcher = new HttpHfFetcher({ fetchImpl, retryBackoffMs: [1, 2, 4] });
    await expect(
      fetcher.fetchTaskRow({ hf_dataset: 'd', hf_split: 's', instance_id: 'a__1' }),
    ).rejects.toThrow(/503/);
    expect(calls).toBe(4); // 1 initial + 3 retries
  });

  it('does not retry on 4xx (client errors are not transient)', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response('', { status: 404 });
    }) as unknown as typeof fetch;
    const fetcher = new HttpHfFetcher({ fetchImpl, retryBackoffMs: [1, 2, 4] });
    await expect(
      fetcher.fetchTaskRow({ hf_dataset: 'd', hf_split: 's', instance_id: 'a__1' }),
    ).rejects.toThrow(/404/);
    expect(calls).toBe(1);
  });
});

function makeRow(instance_id: string) {
  return {
    instance_id,
    repo: 'acme/widget',
    image_name: 'img:latest',
    FAIL_TO_PASS: [],
    PASS_TO_PASS: [],
    test_patch: '',
    install_config: { install: [], test_cmd: [], log_parser: 'parse_log_pytest' },
  };
}

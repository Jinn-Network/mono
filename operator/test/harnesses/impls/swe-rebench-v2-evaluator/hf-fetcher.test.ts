import { describe, it, expect, vi } from 'vitest';
import {
  HttpHfFetcher,
  fetchHfWithRetry,
  DEFAULT_RETRY_BACKOFF_MS,
} from '../../../../src/harnesses/impls/swe-rebench-v2-evaluator/hf-fetcher.js';

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
    const fetcher = new HttpHfFetcher({ fetchImpl, retryBackoffMs: [] });
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
  it('retries on HTTP 429 and succeeds on the second try', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({ rows: [{ row: makeRow('a__1') }] }));
    const sleep = vi.fn(async () => undefined);
    const fetcher = new HttpHfFetcher({
      fetchImpl,
      retryBackoffMs: [25],
      minRequestIntervalMs: 0,
      sleep,
      // Deterministic centred jitter (random()=0.5 → factor 0 → exact base).
      random: () => 0.5,
    });

    const row = await fetcher.fetchTaskRow({ hf_dataset: 'd', hf_split: 's', instance_id: 'a__1' });

    expect(row.instance_id).toBe('a__1');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(25);
  });

  it('clamps Retry-After to the configured finite retry schedule', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('rate limited', {
        status: 429,
        headers: { 'Retry-After': '2' },
      }))
      .mockResolvedValueOnce(jsonResponse({ rows: [{ row: makeRow('a__1') }] }));
    const sleep = vi.fn(async () => undefined);
    const fetcher = new HttpHfFetcher({
      fetchImpl,
      retryBackoffMs: [25],
      minRequestIntervalMs: 0,
      sleep,
      random: () => 0.5,
    });

    await fetcher.fetchTaskRow({ hf_dataset: 'd', hf_split: 's', instance_id: 'a__1' });

    expect(sleep).toHaveBeenCalledWith(25);
  });

  it('serializes requests through the shared throttle', async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstRequest = new Promise<Response>((resolve) => {
      releaseFirst = () => {
        events.push('first released');
        resolve(jsonResponse({ rows: [{ row: makeRow('a__1') }] }));
      };
    });
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(async () => {
        events.push('first fetch');
        return firstRequest;
      })
      .mockImplementationOnce(async () => {
        events.push('second fetch');
        return jsonResponse({ rows: [{ row: makeRow('b__2') }] });
      });
    const sleep = vi.fn(async () => undefined);
    const fetcherA = new HttpHfFetcher({ fetchImpl, minRequestIntervalMs: 10, sleep });
    const fetcherB = new HttpHfFetcher({ fetchImpl, minRequestIntervalMs: 10, sleep });

    const first = fetcherA.fetchTaskRow({ hf_dataset: 'd', hf_split: 's', instance_id: 'a__1' });
    const second = fetcherB.fetchTaskRow({ hf_dataset: 'd', hf_split: 's', instance_id: 'b__2' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      expect(events).toEqual(['first fetch']);
    } finally {
      releaseFirst();
    }

    await Promise.all([first, second]);

    expect(events).toEqual(['first fetch', 'first released', 'second fetch']);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0]?.[0]).toBeGreaterThan(0);
  });

  it('retries on transient HTTP 5xx and succeeds on the third try', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls < 3) return new Response('', { status: 503 });
      return new Response(JSON.stringify({
        rows: [{ row: makeRow('a__1') }],
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const fetcher = new HttpHfFetcher({ fetchImpl, retryBackoffMs: [1, 2, 4], minRequestIntervalMs: 0 });
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
    const fetcher = new HttpHfFetcher({ fetchImpl, retryBackoffMs: [1, 2, 4], minRequestIntervalMs: 0 });
    await expect(
      fetcher.fetchTaskRow({ hf_dataset: 'd', hf_split: 's', instance_id: 'a__1' }),
    ).rejects.toThrow(/503/);
    expect(calls).toBe(4); // 1 initial + 3 retries
  });

  it('surfaces httpStatus on the thrown error when retries are exhausted against a 429', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response('rate limited', { status: 429 });
    }) as unknown as typeof fetch;
    const fetcher = new HttpHfFetcher({ fetchImpl, retryBackoffMs: [1, 2], minRequestIntervalMs: 0 });
    let caught: unknown;
    try {
      await fetcher.fetchTaskRow({ hf_dataset: 'd', hf_split: 's', instance_id: 'a__1' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { httpStatus?: number }).httpStatus).toBe(429);
    expect(calls).toBe(3); // 1 initial + 2 retries
  });

  it('does not retry on 4xx (client errors are not transient)', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response('', { status: 404 });
    }) as unknown as typeof fetch;
    const fetcher = new HttpHfFetcher({ fetchImpl, retryBackoffMs: [1, 2, 4], minRequestIntervalMs: 0 });
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

describe('fetchHfWithRetry — shared helper', () => {
  it('retries 429 and succeeds on the second try, sleeping within the jittered band on the first delay', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const sleep = vi.fn(async () => undefined);
    // Use a known-stable random for deterministic jitter check.
    const random = () => 0.5; // jitter factor (0.5 * 2 - 1) * 0.33 = 0 → exact base
    const res = await fetchHfWithRetry('https://example/test', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryBackoffMs: [1000, 2000],
      minRequestIntervalMs: 0,
      sleep,
      random,
    });
    expect(res.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // jitter band: 1000 × [0.67, 1.33] = [670, 1330]
    const firstSleep = sleep.mock.calls[0]?.[0] as number;
    expect(firstSleep).toBeGreaterThanOrEqual(670);
    expect(firstSleep).toBeLessThanOrEqual(1330);
    // With random=0.5 (centred), expect exactly the base.
    expect(firstSleep).toBe(1000);
  });

  it('exhausts the default schedule (1000/2000/4000/8000 ms; 4 retries → 5 attempts) and throws with httpStatus 429', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response('rate limited', { status: 429 });
    }) as unknown as typeof fetch;
    const sleep = vi.fn(async () => undefined);
    let caught: unknown;
    try {
      await fetchHfWithRetry('https://example/test', {
        fetchImpl,
        retryBackoffMs: DEFAULT_RETRY_BACKOFF_MS,
        minRequestIntervalMs: 0,
        sleep,
        random: () => 0.5,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { httpStatus?: number }).httpStatus).toBe(429);
    expect(calls).toBe(5); // 1 initial + 4 retries
    expect(DEFAULT_RETRY_BACKOFF_MS).toEqual([1000, 2000, 4000, 8000]);
  });

  it('uses the smaller of Retry-After and the finite jittered schedule', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('rate limited', {
        status: 429,
        headers: { 'Retry-After': '2' },
      }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const sleep = vi.fn(async () => undefined);
    await fetchHfWithRetry('https://example/test', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryBackoffMs: [1000, 2000],
      minRequestIntervalMs: 0,
      sleep,
      random: () => 0.5,
    });
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it('does not let an arbitrary Retry-After stall beyond the finite retry schedule', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('rate limited', {
        status: 429,
        headers: { 'Retry-After': '999999999' },
      }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const sleep = vi.fn(async () => undefined);

    await fetchHfWithRetry('https://example/test', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryBackoffMs: [4000],
      minRequestIntervalMs: 0,
      sleep,
      random: () => 0.5,
    });

    expect(sleep).toHaveBeenCalledWith(4000);
  });

  it('does not retry on 4xx that is not 408/429 (404)', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response('', { status: 404 });
    }) as unknown as typeof fetch;
    const res = await fetchHfWithRetry('https://example/test', {
      fetchImpl,
      retryBackoffMs: [1000, 2000, 4000],
      minRequestIntervalMs: 0,
      sleep: async () => undefined,
    });
    expect(res.status).toBe(404);
    expect(calls).toBe(1);
  });
});

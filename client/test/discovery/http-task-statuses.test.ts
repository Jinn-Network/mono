/**
 * Tests for HttpDiscoveryAPI.getTaskStatuses (#579) — the per-task on-chain
 * finalization snapshot backing the Launcher "Recent posted Tasks" status chip.
 *
 * Mirrors the http.test.ts mock-fetch pattern: a stub fetchImpl serves the
 * `/ready` probe and paginated GraphQL legs (tasks, attempts, verdicts).
 */
import { describe, it, expect, vi } from 'vitest';
import { createHttpDiscoveryAPI } from '../../src/discovery/http.js';
import { DiscoveryUnavailableError } from '../../src/discovery/types.js';

/** True for the host-root `/ready` readiness probe HttpDiscoveryAPI issues. */
function isReadyProbe(url: string): boolean {
  return url.endsWith('/ready');
}

const hex32 = (n: string) => `0x${n.repeat(32)}`;
const addr = (n: string) => `0x${n.repeat(20)}`;

function statusTaskRow(over: Record<string, unknown> = {}) {
  return {
    id: '100',
    chainId: 84532,
    manifestDigest: hex32('11'),
    taskCidDigest: hex32('22'),
    creator: addr('aa'),
    maxClaims: 1,
    requiredVerdicts: 1,
    createdAtBlock: '10',
    refunded: false,
    claimWindowEnd: null,
    ...over,
  };
}

function statusFetch(pages: Record<string, unknown>[]): typeof fetch {
  let i = 0;
  return vi.fn(async (url: string) => {
    if (isReadyProbe(url)) return new Response('ok', { status: 200 });
    return new Response(JSON.stringify(pages[i++] ?? { data: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

const emptyPage = { items: [] as unknown[], pageInfo: { hasNextPage: false, endCursor: null } };

describe('HttpDiscoveryAPI.getTaskStatuses (#579)', () => {
  it('maps derived finalized/refunded/claimWindowEnd across two task pages', async () => {
    const pages = [
      {
        data: {
          tasks: {
            items: [
              statusTaskRow({
                id: '100',
                refunded: false,
                claimWindowEnd: '1700000000',
              }),
              statusTaskRow({
                id: '101',
                refunded: true,
                claimWindowEnd: '1700000500',
              }),
            ],
            pageInfo: { hasNextPage: true, endCursor: 'cursor1' },
          },
        },
      },
      {
        data: {
          tasks: {
            items: [
              statusTaskRow({
                id: '102',
                refunded: false,
                claimWindowEnd: '1700001000',
              }),
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
      {
        data: {
          attempts: {
            items: [{
              taskId: '100', chainId: 84532, attemptIndex: 0,
              requestId: hex32('b0'), operator: addr('b0'), priorityMech: addr('c0'),
              deliveryRate: '1', createdAtBlock: '20',
            }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
      {
        data: {
          verdicts: {
            items: [{
              taskId: '100', chainId: 84532, attemptIndex: 0, verdictIndex: 0,
              requestId: hex32('d0'), evaluator: addr('e0'),
              verdictCode: 1, createdAtBlock: '30',
            }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ];
    const api = createHttpDiscoveryAPI({
      url: 'http://stub/graphql',
      fetchImpl: statusFetch(pages),
    });
    const statuses = await api.getTaskStatuses({ manifestCid: 'bafymanifest' });

    expect(statuses.get('100')).toEqual({
      taskId: '100', finalized: true, refunded: false, claimWindowEnd: 1700000000,
    });
    expect(statuses.get('101')).toEqual({
      taskId: '101', finalized: false, refunded: true, claimWindowEnd: 1700000500,
    });
    expect(statuses.get('102')).toEqual({
      taskId: '102', finalized: false, refunded: false, claimWindowEnd: 1700001000,
    });
    expect(statuses.size).toBe(3);
  });

  it('returns an empty Map when the SolverNet has no tasks', async () => {
    const empty = {
      data: { tasks: { items: [], pageInfo: { hasNextPage: false, endCursor: null } } },
    };
    const fetchImpl = vi.fn(async (url: string) => {
      if (isReadyProbe(url)) return new Response('ok', { status: 200 });
      return new Response(JSON.stringify(empty), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const api = createHttpDiscoveryAPI({ url: 'http://stub/graphql', fetchImpl });
    const statuses = await api.getTaskStatuses({ manifestCid: 'bafymanifest' });
    expect(statuses.size).toBe(0);
  });

  it('maps a null claimWindowEnd to undefined', async () => {
    const pages = [
      {
        data: {
          tasks: {
            items: [statusTaskRow({ id: '200', claimWindowEnd: null })],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
      { data: { attempts: emptyPage } },
      { data: { verdicts: emptyPage } },
    ];
    const api = createHttpDiscoveryAPI({
      url: 'http://stub/graphql',
      fetchImpl: statusFetch(pages),
    });
    const statuses = await api.getTaskStatuses({ manifestCid: 'bafymanifest' });
    expect(statuses.get('200')).toEqual({
      taskId: '200', finalized: false, refunded: false, claimWindowEnd: undefined,
    });
  });

  it('strictly parses invalid claimWindowEnd values', async () => {
    const pages = [
      {
        data: {
          tasks: {
            items: [statusTaskRow({ id: '201', claimWindowEnd: 'not-a-number' })],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
      { data: { attempts: emptyPage } },
      { data: { verdicts: emptyPage } },
    ];
    const api = createHttpDiscoveryAPI({
      url: 'http://stub/graphql',
      fetchImpl: statusFetch(pages),
    });
    const statuses = await api.getTaskStatuses({ manifestCid: 'bafymanifest' });
    expect(statuses.get('201')).toEqual({
      taskId: '201', finalized: false, refunded: false, claimWindowEnd: undefined,
    });
  });

  it('treats blank claimWindowEnd as missing instead of zero', async () => {
    const pages = [
      {
        data: {
          tasks: {
            items: [statusTaskRow({ id: '202', claimWindowEnd: '   ' })],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
      { data: { attempts: emptyPage } },
      { data: { verdicts: emptyPage } },
    ];
    const api = createHttpDiscoveryAPI({
      url: 'http://stub/graphql',
      fetchImpl: statusFetch(pages),
    });
    const statuses = await api.getTaskStatuses({ manifestCid: 'bafymanifest' });
    expect(statuses.get('202')).toEqual({
      taskId: '202', finalized: false, refunded: false, claimWindowEnd: undefined,
    });
  });

  it('omits task rows with invalid spine identity fields', async () => {
    const pages = [
      {
        data: {
          tasks: {
            items: [
              statusTaskRow({ id: '203', creator: 'not-hex' }),
              statusTaskRow({ id: '204', manifestDigest: 'bad' }),
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ];
    const api = createHttpDiscoveryAPI({
      url: 'http://stub/graphql',
      fetchImpl: statusFetch(pages),
    });
    const statuses = await api.getTaskStatuses({ manifestCid: 'bafymanifest' });
    expect(statuses.has('203')).toBe(false);
    expect(statuses.has('204')).toBe(false);
  });

  it('ignores hostile finalized when attempt/verdict spine is empty; keeps row refunded (#2241)', async () => {
    const pages = [
      {
        data: {
          tasks: {
            items: [statusTaskRow({ id: '7', refunded: true })],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
      { data: { attempts: emptyPage } },
      { data: { verdicts: emptyPage } },
    ];
    const api = createHttpDiscoveryAPI({
      url: 'http://stub/graphql',
      fetchImpl: statusFetch(pages),
    });
    const statuses = await api.getTaskStatuses({ manifestCid: 'bafymanifest' });
    expect(statuses.get('7')).toEqual({
      taskId: '7', finalized: false, refunded: true, claimWindowEnd: undefined,
    });
  });

  it('sets finalized true from co-fetched spine (#2241)', async () => {
    const pages = [
      {
        data: {
          tasks: {
            items: [statusTaskRow({ id: '7', refunded: false })],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
      {
        data: {
          attempts: {
            items: [{
              taskId: '7', chainId: 84532, attemptIndex: 0,
              requestId: hex32('b0'), operator: addr('b0'), priorityMech: addr('c0'),
              deliveryRate: '1', createdAtBlock: '20',
            }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
      {
        data: {
          verdicts: {
            items: [{
              taskId: '7', chainId: 84532, attemptIndex: 0, verdictIndex: 0,
              requestId: hex32('d0'), evaluator: addr('e0'),
              verdictCode: 1, createdAtBlock: '30',
            }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ];
    const api = createHttpDiscoveryAPI({
      url: 'http://stub/graphql',
      fetchImpl: statusFetch(pages),
    });
    const statuses = await api.getTaskStatuses({ manifestCid: 'bafymanifest' });
    expect(statuses.get('7')!.finalized).toBe(true);
    expect(statuses.get('7')!.refunded).toBe(false);
  });

  it('throws DiscoveryUnavailableError when the network fetch throws', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (isReadyProbe(url)) return new Response('ok', { status: 200 });
      throw new Error('fetch failed');
    }) as unknown as typeof fetch;
    const api = createHttpDiscoveryAPI({ url: 'http://stub/graphql', fetchImpl });
    await expect(api.getTaskStatuses({ manifestCid: 'bafymanifest' }))
      .rejects.toBeInstanceOf(DiscoveryUnavailableError);
  });
});

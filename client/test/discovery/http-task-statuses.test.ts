/**
 * Tests for HttpDiscoveryAPI.getTaskStatuses (#579) — the per-task on-chain
 * finalization snapshot backing the Launcher "Recent posted Tasks" status chip.
 *
 * Mirrors the http.test.ts mock-fetch pattern: a stub fetchImpl serves the
 * `/ready` probe and the paginated `task` query.
 */
import { describe, it, expect, vi } from 'vitest';
import { createHttpDiscoveryAPI } from '../../src/discovery/http.js';
import { DiscoveryUnavailableError } from '../../src/discovery/types.js';

/** True for the host-root `/ready` readiness probe HttpDiscoveryAPI issues. */
function isReadyProbe(url: string): boolean {
  return url.endsWith('/ready');
}

describe('HttpDiscoveryAPI.getTaskStatuses (#579)', () => {
  it('maps finalized/refunded/claimWindowEnd across two pages', async () => {
    const page1 = {
      data: {
        tasks: {
          items: [
            { id: '100', finalized: true, refunded: false, claimWindowEnd: '1700000000' },
            { id: '101', finalized: false, refunded: true, claimWindowEnd: '1700000500' },
          ],
          pageInfo: { hasNextPage: true, endCursor: 'cursor1' },
        },
      },
    };
    const page2 = {
      data: {
        tasks: {
          items: [
            { id: '102', finalized: false, refunded: false, claimWindowEnd: '1700001000' },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    };
    let leg = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (isReadyProbe(url)) return new Response('ok', { status: 200 });
      leg += 1;
      return new Response(JSON.stringify(leg === 1 ? page1 : page2), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const api = createHttpDiscoveryAPI({ url: 'http://stub/graphql', fetchImpl });
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
    const page = {
      data: {
        tasks: {
          items: [{ id: '200', finalized: false, refunded: false, claimWindowEnd: null }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    };
    const fetchImpl = vi.fn(async (url: string) => {
      if (isReadyProbe(url)) return new Response('ok', { status: 200 });
      return new Response(JSON.stringify(page), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const api = createHttpDiscoveryAPI({ url: 'http://stub/graphql', fetchImpl });
    const statuses = await api.getTaskStatuses({ manifestCid: 'bafymanifest' });
    expect(statuses.get('200')).toEqual({
      taskId: '200', finalized: false, refunded: false, claimWindowEnd: undefined,
    });
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

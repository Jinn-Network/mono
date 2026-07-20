/**
 * Tests for HttpDiscoveryAPI.getVerdictTallies (#502) — the per-task resolved
 * verdict tally backing the operator Activity table's task-relative Outcome
 * column.
 *
 * Mirrors http-task-statuses.test.ts: a stub fetchImpl serves the `/ready`
 * probe and the paginated `verdictEnvelopeMeta` query.
 */
import { describe, it, expect, vi } from 'vitest';
import { createHttpDiscoveryAPI } from '../../src/discovery/http.js';
import { DiscoveryUnavailableError } from '../../src/discovery/types.js';

/** True for the host-root `/ready` readiness probe HttpDiscoveryAPI issues. */
function isReadyProbe(url: string): boolean {
  return url.endsWith('/ready');
}

describe('HttpDiscoveryAPI.getVerdictTallies (#502)', () => {
  it('tallies PASS/FAIL poles across two pages', async () => {
    const page1 = {
      data: {
        verdictEnvelopeMetas: {
          items: [
            { taskId: '100', evaluatorVerdict: 'PASS', chainId: 84532, requestId: '0x01' },
            { taskId: '100', evaluatorVerdict: 'FAIL', chainId: 84532, requestId: '0x02' },
          ],
          pageInfo: { hasNextPage: true, endCursor: 'cursor1' },
        },
      },
    };
    const page2 = {
      data: {
        verdictEnvelopeMetas: {
          items: [
            { taskId: '100', evaluatorVerdict: 'PASS', chainId: 84532, requestId: '0x03' },
            { taskId: '101', evaluatorVerdict: 'FAIL', chainId: 84532, requestId: '0x04' },
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
    const tallies = await api.getVerdictTallies({ taskIds: ['100', '101'] });

    expect(tallies.get('100')).toEqual({ pass: 2, fail: 1 });
    expect(tallies.get('101')).toEqual({ pass: 0, fail: 1 });
    expect(tallies.size).toBe(2);
  });

  it('excludes non-pole verdicts (INVALID/INDETERMINATE/UNKNOWN)', async () => {
    const page = {
      data: {
        verdictEnvelopeMetas: {
          items: [
            { taskId: '200', evaluatorVerdict: 'PASS', chainId: 84532, requestId: '0x11' },
            { taskId: '200', evaluatorVerdict: 'INDETERMINATE', chainId: 84532, requestId: '0x12' },
            { taskId: '200', evaluatorVerdict: 'UNKNOWN', chainId: 84532, requestId: '0x13' },
            { taskId: '200', evaluatorVerdict: 'INVALID', chainId: 84532, requestId: '0x14' },
          ],
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
    const tallies = await api.getVerdictTallies({ taskIds: ['200'] });
    expect(tallies.get('200')).toEqual({ pass: 1, fail: 0 });
  });

  it('dedupes rows on requestId|chainId across pages', async () => {
    const dup = { taskId: '300', evaluatorVerdict: 'PASS', chainId: 84532, requestId: '0x21' };
    const page1 = {
      data: {
        verdictEnvelopeMetas: {
          items: [dup],
          pageInfo: { hasNextPage: true, endCursor: 'cursor1' },
        },
      },
    };
    const page2 = {
      data: {
        verdictEnvelopeMetas: {
          items: [dup],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    };
    let leg = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (isReadyProbe(url)) return new Response('ok', { status: 200 });
      leg += 1;
      return new Response(JSON.stringify(leg === 1 ? page1 : page2), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const api = createHttpDiscoveryAPI({ url: 'http://stub/graphql', fetchImpl });
    const tallies = await api.getVerdictTallies({ taskIds: ['300'] });
    expect(tallies.get('300')).toEqual({ pass: 1, fail: 0 });
  });

  it('fails closed when competing candidates disagree on the verdict pole', async () => {
    const page = {
      data: {
        verdictEnvelopeMetas: {
          items: [
            { taskId: '300', evaluatorVerdict: 'PASS', chainId: 84532, requestId: '0x21' },
            { taskId: '300', evaluatorVerdict: 'FAIL', chainId: 84532, requestId: '0x21' },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    };
    const fetchImpl = vi.fn(async (url: string) => {
      if (isReadyProbe(url)) return new Response('ok', { status: 200 });
      return new Response(JSON.stringify(page), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const api = createHttpDiscoveryAPI({ url: 'http://stub/graphql', fetchImpl });

    const tallies = await api.getVerdictTallies({ taskIds: ['300'] });

    expect(tallies.size).toBe(0);
  });

  it('returns an empty Map and issues no query for an empty taskIds array', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (isReadyProbe(url)) return new Response('ok', { status: 200 });
      throw new Error('should not query');
    }) as unknown as typeof fetch;
    const api = createHttpDiscoveryAPI({ url: 'http://stub/graphql', fetchImpl });
    const tallies = await api.getVerdictTallies({ taskIds: [] });
    expect(tallies.size).toBe(0);
    // Only the readiness probe (if any) — never a GraphQL query.
    const graphqlCalls = fetchImpl.mock.calls.filter((c) => !isReadyProbe(c[0] as string));
    expect(graphqlCalls.length).toBe(0);
  });

  it('throws DiscoveryUnavailableError when the network fetch throws', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (isReadyProbe(url)) return new Response('ok', { status: 200 });
      throw new Error('fetch failed');
    }) as unknown as typeof fetch;
    const api = createHttpDiscoveryAPI({ url: 'http://stub/graphql', fetchImpl });
    await expect(api.getVerdictTallies({ taskIds: ['1'] }))
      .rejects.toBeInstanceOf(DiscoveryUnavailableError);
  });

  it('warns once (not per page) and returns the truncated tally when the page cap is hit', async () => {
    // Every page reports hasNextPage: true, so the loop exhausts MAX_PAGES (10)
    // while more rows remain — the silent-truncation case the warning covers.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let leg = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (isReadyProbe(url)) return new Response('ok', { status: 200 });
      leg += 1;
      const body = {
        data: {
          verdictEnvelopeMetas: {
            items: [
              { taskId: '400', evaluatorVerdict: 'PASS', chainId: 84532, requestId: `0x${leg}` },
            ],
            pageInfo: { hasNextPage: true, endCursor: `cursor${leg}` },
          },
        },
      };
      return new Response(JSON.stringify(body), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const api = createHttpDiscoveryAPI({ url: 'http://stub/graphql', fetchImpl });
    // Does not throw — truncates rather than failing the display read.
    const tallies = await api.getVerdictTallies({ taskIds: ['400'] });

    // The tally still returns the rows scanned before the cap (one PASS per page).
    expect(tallies.get('400')).toEqual({ pass: 10, fail: 0 });

    // Exactly one warning — not one per page.
    const capWarnings = warn.mock.calls.filter((c) =>
      typeof c[0] === 'string' && c[0].includes('getVerdictTallies'),
    );
    expect(capWarnings.length).toBe(1);
    expect(capWarnings[0]?.[0]).toContain('[discovery]');

    warn.mockRestore();
  });
});

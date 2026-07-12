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
  it('tallies PASS/FAIL across two pages and collects lowercased evaluators', async () => {
    const page1 = {
      data: {
        verdictEnvelopeMetas: {
          items: [
            { taskId: '100', evaluatorVerdict: 'PASS', evaluator: '0xAAA', chainId: 84532, requestId: '0x01' },
            { taskId: '100', evaluatorVerdict: 'FAIL', evaluator: '0xBBB', chainId: 84532, requestId: '0x02' },
          ],
          pageInfo: { hasNextPage: true, endCursor: 'cursor1' },
        },
      },
    };
    const page2 = {
      data: {
        verdictEnvelopeMetas: {
          items: [
            { taskId: '100', evaluatorVerdict: 'PASS', evaluator: '0xCCC', chainId: 84532, requestId: '0x03' },
            { taskId: '101', evaluatorVerdict: 'FAIL', evaluator: '0xAAA', chainId: 84532, requestId: '0x04' },
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

    expect(tallies.get('100')).toEqual({
      pass: 2,
      fail: 1,
      evaluators: ['0xaaa', '0xbbb', '0xccc'],
    });
    expect(tallies.get('101')).toEqual({
      pass: 0,
      fail: 1,
      evaluators: ['0xaaa'],
    });
    expect(tallies.size).toBe(2);
  });

  it('excludes non-pole verdicts (INVALID/INDETERMINATE/UNKNOWN)', async () => {
    const page = {
      data: {
        verdictEnvelopeMetas: {
          items: [
            { taskId: '200', evaluatorVerdict: 'PASS', evaluator: '0xAAA', chainId: 84532, requestId: '0x11' },
            { taskId: '200', evaluatorVerdict: 'INDETERMINATE', evaluator: '0xBBB', chainId: 84532, requestId: '0x12' },
            { taskId: '200', evaluatorVerdict: 'UNKNOWN', evaluator: '0xCCC', chainId: 84532, requestId: '0x13' },
            { taskId: '200', evaluatorVerdict: 'INVALID', evaluator: '0xDDD', chainId: 84532, requestId: '0x14' },
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
    expect(tallies.get('200')).toEqual({ pass: 1, fail: 0, evaluators: ['0xaaa'] });
  });

  it('dedupes rows on requestId|chainId across pages', async () => {
    const dup = { taskId: '300', evaluatorVerdict: 'PASS', evaluator: '0xAAA', chainId: 84532, requestId: '0x21' };
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
    expect(tallies.get('300')).toEqual({ pass: 1, fail: 0, evaluators: ['0xaaa'] });
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
});

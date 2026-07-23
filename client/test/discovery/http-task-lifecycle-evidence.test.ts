import { describe, expect, it, vi } from 'vitest';
import { createHttpDiscoveryAPI } from '../../src/discovery/http.js';

/** True for the host-root `/ready` readiness probe HttpDiscoveryAPI issues. */
function isReadyProbe(url: string): boolean {
  return url.endsWith('/ready');
}

describe('HttpDiscoveryAPI.getTaskLifecycleEvidence (#2044)', () => {
  it('short-circuits an empty task list with no network I/O', async () => {
    const fetchImpl = vi.fn();
    const api = createHttpDiscoveryAPI({
      url: 'http://stub/graphql',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(api.getTaskLifecycleEvidence({ taskIds: [] }))
      .resolves.toEqual(new Map());
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns ordered multi-attempt multi-verdict spine and attaches all candidates (AC1/AC2)', async () => {
    const pages: Record<string, unknown>[] = [
      // tasks
      { data: { tasks: { items: [{
        id: '7', chainId: 84532, manifestDigest: `0x${'11'.repeat(32)}`,
        taskCidDigest: `0x${'22'.repeat(32)}`, creator: `0x${'aa'.repeat(20)}`,
        maxClaims: 2, requiredVerdicts: 1, createdAtBlock: '10', createdAtTx: `0x${'77'.repeat(32)}`,
        finalized: false, refunded: false,
      }], pageInfo: { hasNextPage: false, endCursor: null } } } },
      // attempts (deliberately reverse order in payload)
      { data: { attempts: { items: [
        { taskId: '7', chainId: 84532, attemptIndex: 1, requestId: `0x${'b1'.repeat(32)}`,
          operator: `0x${'b1'.repeat(20)}`, priorityMech: `0x${'c1'.repeat(20)}`,
          deliveryRate: '2', createdAtBlock: '21' },
        { taskId: '7', chainId: 84532, attemptIndex: 0, requestId: `0x${'b0'.repeat(32)}`,
          operator: `0x${'b0'.repeat(20)}`, priorityMech: `0x${'c0'.repeat(20)}`,
          deliveryRate: '1', createdAtBlock: '20' },
      ], pageInfo: { hasNextPage: false, endCursor: null } } } },
      // verdicts
      { data: { verdicts: { items: [
        { taskId: '7', chainId: 84532, attemptIndex: 0, verdictIndex: 1,
          requestId: `0x${'d1'.repeat(32)}`, evaluator: `0x${'e1'.repeat(20)}`,
          verdictCode: 2, createdAtBlock: '31' },
        { taskId: '7', chainId: 84532, attemptIndex: 0, verdictIndex: 0,
          requestId: `0x${'d0'.repeat(32)}`, evaluator: `0x${'e0'.repeat(20)}`,
          verdictCode: 1, createdAtBlock: '30' },
      ], pageInfo: { hasNextPage: false, endCursor: null } } } },
      // attemptEnvelopeMetas — two publishers for same SOLVE request
      { data: { attemptEnvelopeMetas: { items: [
        { requestId: `0x${'b0'.repeat(32)}`, chainId: 84532, manifestCid: 'bafy1',
          publisherAgentId: '1', manifestHash: `0x${'01'.repeat(32)}`, enrichedAtBlock: '25',
          solverType: 'prediction.v0' },
        { requestId: `0x${'b0'.repeat(32)}`, chainId: 84532, manifestCid: 'bafy2',
          publisherAgentId: '2', manifestHash: `0x${'02'.repeat(32)}`, enrichedAtBlock: '26' },
      ], pageInfo: { hasNextPage: false, endCursor: null } } } },
      // verdictEnvelopeMetas
      { data: { verdictEnvelopeMetas: { items: [{
        requestId: `0x${'d0'.repeat(32)}`, chainId: 84532, manifestCid: 'bafyV',
        publisherAgentId: '9', manifestHash: `0x${'09'.repeat(32)}`, enrichedAtBlock: '35',
        actualPassed: true, taskId: '999', attemptIndex: 99, verdictIndex: 99,
        evaluator: `0x${'ff'.repeat(20)}`, solutionRequestId: 'hint',
      }], pageInfo: { hasNextPage: false, endCursor: null } } } },
    ];
    let i = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (isReadyProbe(url)) return new Response('ok', { status: 200 });
      return new Response(JSON.stringify(pages[i++] ?? { data: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const api = createHttpDiscoveryAPI({
      url: 'http://stub/graphql',
      fetchImpl,
    });
    const map = await api.getTaskLifecycleEvidence({ taskIds: ['7', 'missing'] });
    expect(map.has('missing')).toBe(false);
    const ev = map.get('7')!;
    expect(ev.authoritative.attempts.map((a) => a.attemptIndex)).toEqual([0, 1]);
    expect(ev.authoritative.attempts[0]!.verdicts.map((v) => v.verdictIndex)).toEqual([0, 1]);
    expect(ev.authoritative.attempts[0]!.attemptEnvelopeCandidates).toHaveLength(2);
    expect(ev.authoritative.attempts[0]!.verdicts[0]!.evaluator)
      .toBe(`0x${'e0'.repeat(20)}`);
    expect(ev.authoritative.attempts[0]!.verdicts[0]!.verdictEnvelopeCandidates[0]!.projectedTaskId)
      .toBe('999');
  });

  it('never lets a candidate-only projection invent a spine row (AC3)', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (isReadyProbe(url)) return new Response('ok', { status: 200 });
      return new Response(JSON.stringify({
        data: {
          tasks: { items: [], pageInfo: { hasNextPage: false, endCursor: null } },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const api = createHttpDiscoveryAPI({
      url: 'http://stub/graphql',
      fetchImpl,
    });
    const map = await api.getTaskLifecycleEvidence({ taskIds: ['7'] });
    expect(map.size).toBe(0);
  });

  it('returns empty Map when an HTTP leg hits the page cap (absence > partial lie)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = vi.fn(async (url: string) => {
      if (isReadyProbe(url)) return new Response('ok', { status: 200 });
      // Always claim another page so the 50-page hard cap binds on the tasks leg.
      return new Response(JSON.stringify({
        data: {
          tasks: {
            items: [{
              id: '7', chainId: 84532, manifestDigest: `0x${'11'.repeat(32)}`,
              taskCidDigest: `0x${'22'.repeat(32)}`, creator: `0x${'aa'.repeat(20)}`,
              maxClaims: 1, requiredVerdicts: 1, createdAtBlock: '10',
              finalized: false, refunded: false,
            }],
            pageInfo: { hasNextPage: true, endCursor: 'next' },
          },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const api = createHttpDiscoveryAPI({
      url: 'http://stub/graphql',
      fetchImpl,
    });
    const map = await api.getTaskLifecycleEvidence({ taskIds: ['7'] });
    expect(map.size).toBe(0);
    const gqlCalls = fetchImpl.mock.calls.filter(([u]) => !isReadyProbe(String(u)));
    expect(gqlCalls).toHaveLength(50);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('HTTP page cap hit on tasks'),
    );
    warn.mockRestore();
  });
});

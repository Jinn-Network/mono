import { describe, it, expect, vi } from 'vitest';
import { createHttpDiscoveryAPI } from '../../src/discovery/http.js';
import { DiscoveryUnavailableError } from '../../src/discovery/types.js';

const BASE_URL = 'http://localhost:42069';
const isReadyProbe = (url: string) => url.endsWith('/ready');

/** Route by GraphQL operation found in the query body. */
function routedFetch(routes: {
  attemptMeta?: unknown;
  verdictMeta?: unknown;
  attempts?: unknown;
  throwOn?: 'attemptMeta' | 'verdictMeta';
}) {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    if (isReadyProbe(url)) return new Response(null, { status: 200 });
    const body = JSON.parse(init!.body as string) as { query: string; variables: Record<string, unknown> };
    calls.push(body);
    if (body.query.includes('attemptEnvelopeMetas')) {
      if (routes.throwOn === 'attemptMeta') {
        return new Response(JSON.stringify({ errors: [{ message: 'boom' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify(routes.attemptMeta), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (body.query.includes('verdictEnvelopeMetas')) {
      if (routes.throwOn === 'verdictMeta') {
        return new Response(JSON.stringify({ errors: [{ message: 'boom' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify(routes.verdictMeta), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    // attempts query (operator scoping)
    return new Response(JSON.stringify(routes.attempts), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return { impl, calls };
}

describe('getCodeDigestRewards', () => {
  it('aggregates passRate and avgScore per codeDigest from joined meta rows', async () => {
    const { impl } = routedFetch({
      attemptMeta: { data: { attemptEnvelopeMetas: { items: [
        { requestId: '0x1', chainId: 8453, codeDigest: 'sha256:A' },
        { requestId: '0x2', chainId: 8453, codeDigest: 'sha256:A' },
        { requestId: '0x3', chainId: 8453, codeDigest: 'sha256:A' },
      ], pageInfo: { hasNextPage: false, endCursor: null } } } },
      verdictMeta: { data: { verdictEnvelopeMetas: { items: [
        { requestId: '0x1', chainId: 8453, actualPassed: true, actualScore: '1.0' },
        { requestId: '0x2', chainId: 8453, actualPassed: false, actualScore: '0.0' },
        { requestId: '0x3', chainId: 8453, actualPassed: true, actualScore: '0.5' },
      ], pageInfo: { hasNextPage: false, endCursor: null } } } },
    });
    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    const rows = await client.getCodeDigestRewards({ codeDigests: ['sha256:A'] });
    expect(rows).toHaveLength(1);
    const a = rows[0]!;
    expect(a.codeDigest).toBe('sha256:A');
    expect(a.attempts).toBe(3);
    expect(a.passes).toBe(2);
    expect(a.passRate).toBeCloseTo(2 / 3);
    expect(a.avgScore).toBeCloseTo((1.0 + 0.0 + 0.5) / 3);
  });

  it('omits a requested codeDigest that has no indexed attempts', async () => {
    const { impl } = routedFetch({
      attemptMeta: { data: { attemptEnvelopeMetas: { items: [], pageInfo: { hasNextPage: false, endCursor: null } } } },
      verdictMeta: { data: { verdictEnvelopeMetas: { items: [], pageInfo: { hasNextPage: false, endCursor: null } } } },
    });
    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    const rows = await client.getCodeDigestRewards({ codeDigests: ['sha256:missing'] });
    expect(rows).toEqual([]);
  });

  it('scopes mode=train in the attempt-meta query', async () => {
    const { impl, calls } = routedFetch({
      attemptMeta: { data: { attemptEnvelopeMetas: { items: [], pageInfo: { hasNextPage: false, endCursor: null } } } },
      verdictMeta: { data: { verdictEnvelopeMetas: { items: [], pageInfo: { hasNextPage: false, endCursor: null } } } },
    });
    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    await client.getCodeDigestRewards({ codeDigests: ['sha256:A'] });
    const attemptCall = calls.find((c) => c.query.includes('attemptEnvelopeMetas'));
    expect(JSON.stringify(attemptCall)).toContain('train');
  });

  it('propagates DiscoveryUnavailableError when the indexer errors (no swallow)', async () => {
    const { impl } = routedFetch({ throwOn: 'attemptMeta' });
    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    await expect(client.getCodeDigestRewards({ codeDigests: ['sha256:A'] }))
      .rejects.toBeInstanceOf(DiscoveryUnavailableError);
  });

  it('returns [] for empty codeDigests without hitting the network', async () => {
    const { impl } = routedFetch({});
    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    const rows = await client.getCodeDigestRewards({ codeDigests: [] });
    expect(rows).toEqual([]);
    expect(impl).not.toHaveBeenCalled();
  });

  it('scopes the verdict query by solverNetManifestCid and excludes other SolverNets', async () => {
    // verdictEnvelopeMeta carries solverNetManifestCid (ponder.schema.ts:657);
    // attemptEnvelopeMeta does not, so the scope is applied on the verdict leg.
    // Only request 0x1 belongs to SolverNet "snA"; 0x2/0x3 belong to "snB".
    const { impl, calls } = routedFetch({
      attemptMeta: { data: { attemptEnvelopeMetas: { items: [
        { requestId: '0x1', chainId: 8453, codeDigest: 'sha256:A' },
        { requestId: '0x2', chainId: 8453, codeDigest: 'sha256:A' },
        { requestId: '0x3', chainId: 8453, codeDigest: 'sha256:A' },
      ], pageInfo: { hasNextPage: false, endCursor: null } } } },
      // The mock honours the solverNetManifestCid filter: it returns only the
      // verdict whose SolverNet matches the variable.
      verdictMeta: { data: { verdictEnvelopeMetas: { items: [
        { requestId: '0x1', chainId: 8453, actualPassed: true, actualScore: '1.0', solverNetManifestCid: 'snA' },
      ], pageInfo: { hasNextPage: false, endCursor: null } } } },
    });
    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    const rows = await client.getCodeDigestRewards({ codeDigests: ['sha256:A'], solverNetManifestCid: 'snA' });

    // The verdict GraphQL request must carry the SolverNet filter.
    const verdictCall = calls.find((c) => c.query.includes('verdictEnvelopeMetas'));
    expect(verdictCall).toBeDefined();
    expect(verdictCall!.query).toContain('solverNetManifestCid');
    expect(verdictCall!.variables.solverNetManifestCid).toBe('snA');

    // Only the in-scope request (0x1) is aggregated; 0x2/0x3 are excluded.
    expect(rows).toHaveLength(1);
    const a = rows[0]!;
    expect(a.codeDigest).toBe('sha256:A');
    expect(a.attempts).toBe(1);
    expect(a.passes).toBe(1);
    expect(a.passRate).toBeCloseTo(1);
    expect(a.avgScore).toBeCloseTo(1.0);
  });

  it('omits solverNetManifestCid from the verdict query when not provided', async () => {
    const { impl, calls } = routedFetch({
      attemptMeta: { data: { attemptEnvelopeMetas: { items: [
        { requestId: '0x1', chainId: 8453, codeDigest: 'sha256:A' },
      ], pageInfo: { hasNextPage: false, endCursor: null } } } },
      verdictMeta: { data: { verdictEnvelopeMetas: { items: [
        { requestId: '0x1', chainId: 8453, actualPassed: true, actualScore: '1.0' },
      ], pageInfo: { hasNextPage: false, endCursor: null } } } },
    });
    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    await client.getCodeDigestRewards({ codeDigests: ['sha256:A'] });
    const verdictCall = calls.find((c) => c.query.includes('verdictEnvelopeMetas'));
    expect(verdictCall).toBeDefined();
    expect(verdictCall!.variables.solverNetManifestCid).toBeUndefined();
  });
});

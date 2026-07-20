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

  it('fails closed when competing attempt candidates disagree on codeDigest', async () => {
    const { impl } = routedFetch({
      attemptMeta: { data: { attemptEnvelopeMetas: { items: [
        { requestId: '0x1', chainId: 8453, codeDigest: 'sha256:A' },
        { requestId: '0x1', chainId: 8453, codeDigest: 'sha256:B' },
      ], pageInfo: { hasNextPage: false, endCursor: null } } } },
      verdictMeta: { data: { verdictEnvelopeMetas: { items: [
        { requestId: '0x1', chainId: 8453, actualPassed: true, actualScore: '1.0' },
      ], pageInfo: { hasNextPage: false, endCursor: null } } } },
    });
    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });

    expect(await client.getCodeDigestRewards({ codeDigests: ['sha256:A', 'sha256:B'] })).toEqual([]);
  });

  it('fails closed when competing verdict candidates disagree on outcome', async () => {
    const { impl } = routedFetch({
      attemptMeta: { data: { attemptEnvelopeMetas: { items: [
        { requestId: '0x1', chainId: 8453, codeDigest: 'sha256:A' },
      ], pageInfo: { hasNextPage: false, endCursor: null } } } },
      verdictMeta: { data: { verdictEnvelopeMetas: { items: [
        { requestId: '0x1', chainId: 8453, actualPassed: true, actualScore: '1.0' },
        { requestId: '0x1', chainId: 8453, actualPassed: false, actualScore: '0.0' },
      ], pageInfo: { hasNextPage: false, endCursor: null } } } },
    });
    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });

    expect(await client.getCodeDigestRewards({ codeDigests: ['sha256:A'] })).toEqual([]);
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

  it('caps aggregation to the most-recent `window` attempts per codeDigest', async () => {
    // Seed 5 attempts for one codeDigest in enrichedAtBlock-desc order (the
    // CODEDIGEST_ATTEMPTS_QUERY ordering). With window=2, only the two
    // most-recent (0x1, 0x2) must be aggregated. Their verdicts are both
    // passes; the older three (0x3-0x5) are fails — if the window were
    // ignored the passRate would be 2/5, not 1.0.
    const { impl } = routedFetch({
      attemptMeta: { data: { attemptEnvelopeMetas: { items: [
        { requestId: '0x1', chainId: 8453, codeDigest: 'sha256:A' }, // newest
        { requestId: '0x2', chainId: 8453, codeDigest: 'sha256:A' },
        { requestId: '0x3', chainId: 8453, codeDigest: 'sha256:A' },
        { requestId: '0x4', chainId: 8453, codeDigest: 'sha256:A' },
        { requestId: '0x5', chainId: 8453, codeDigest: 'sha256:A' }, // oldest
      ], pageInfo: { hasNextPage: false, endCursor: null } } } },
      verdictMeta: { data: { verdictEnvelopeMetas: { items: [
        { requestId: '0x1', chainId: 8453, actualPassed: true, actualScore: '1.0' },
        { requestId: '0x2', chainId: 8453, actualPassed: true, actualScore: '1.0' },
        { requestId: '0x3', chainId: 8453, actualPassed: false, actualScore: '0.0' },
        { requestId: '0x4', chainId: 8453, actualPassed: false, actualScore: '0.0' },
        { requestId: '0x5', chainId: 8453, actualPassed: false, actualScore: '0.0' },
      ], pageInfo: { hasNextPage: false, endCursor: null } } } },
    });
    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    const rows = await client.getCodeDigestRewards({ codeDigests: ['sha256:A'], window: 2 });
    expect(rows).toHaveLength(1);
    const a = rows[0]!;
    expect(a.attempts).toBe(2);
    expect(a.passes).toBe(2);
    expect(a.passRate).toBeCloseTo(1);
    expect(a.avgScore).toBeCloseTo(1.0);
  });

  it('applies the window cap independently per codeDigest', async () => {
    // Two codeDigests interleaved in desc order. window=1 keeps only the most
    // recent attempt of EACH digest (a global limit would wrongly keep just
    // one row total).
    const { impl } = routedFetch({
      attemptMeta: { data: { attemptEnvelopeMetas: { items: [
        { requestId: '0xa1', chainId: 8453, codeDigest: 'sha256:A' }, // A newest
        { requestId: '0xb1', chainId: 8453, codeDigest: 'sha256:B' }, // B newest
        { requestId: '0xa2', chainId: 8453, codeDigest: 'sha256:A' },
        { requestId: '0xb2', chainId: 8453, codeDigest: 'sha256:B' },
      ], pageInfo: { hasNextPage: false, endCursor: null } } } },
      verdictMeta: { data: { verdictEnvelopeMetas: { items: [
        { requestId: '0xa1', chainId: 8453, actualPassed: true, actualScore: '1.0' },
        { requestId: '0xb1', chainId: 8453, actualPassed: false, actualScore: '0.0' },
        { requestId: '0xa2', chainId: 8453, actualPassed: false, actualScore: '0.0' },
        { requestId: '0xb2', chainId: 8453, actualPassed: true, actualScore: '1.0' },
      ], pageInfo: { hasNextPage: false, endCursor: null } } } },
    });
    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    const rows = await client.getCodeDigestRewards({ codeDigests: ['sha256:A', 'sha256:B'], window: 1 });
    const byDigest = new Map(rows.map((r) => [r.codeDigest, r]));
    expect(byDigest.get('sha256:A')!.attempts).toBe(1);
    expect(byDigest.get('sha256:A')!.passes).toBe(1); // newest A passed
    expect(byDigest.get('sha256:B')!.attempts).toBe(1);
    expect(byDigest.get('sha256:B')!.passes).toBe(0); // newest B failed
  });

  it('aggregates over ALL attempts when window is omitted (regression)', async () => {
    const { impl } = routedFetch({
      attemptMeta: { data: { attemptEnvelopeMetas: { items: [
        { requestId: '0x1', chainId: 8453, codeDigest: 'sha256:A' },
        { requestId: '0x2', chainId: 8453, codeDigest: 'sha256:A' },
        { requestId: '0x3', chainId: 8453, codeDigest: 'sha256:A' },
        { requestId: '0x4', chainId: 8453, codeDigest: 'sha256:A' },
        { requestId: '0x5', chainId: 8453, codeDigest: 'sha256:A' },
      ], pageInfo: { hasNextPage: false, endCursor: null } } } },
      verdictMeta: { data: { verdictEnvelopeMetas: { items: [
        { requestId: '0x1', chainId: 8453, actualPassed: true, actualScore: '1.0' },
        { requestId: '0x2', chainId: 8453, actualPassed: true, actualScore: '1.0' },
        { requestId: '0x3', chainId: 8453, actualPassed: false, actualScore: '0.0' },
        { requestId: '0x4', chainId: 8453, actualPassed: false, actualScore: '0.0' },
        { requestId: '0x5', chainId: 8453, actualPassed: false, actualScore: '0.0' },
      ], pageInfo: { hasNextPage: false, endCursor: null } } } },
    });
    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    const rows = await client.getCodeDigestRewards({ codeDigests: ['sha256:A'] });
    expect(rows).toHaveLength(1);
    const a = rows[0]!;
    expect(a.attempts).toBe(5);
    expect(a.passes).toBe(2);
    expect(a.passRate).toBeCloseTo(2 / 5);
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

  it('returns per-attempt gradedScores from v2 verdict counts', async () => {
    // 2 attempts on digest 'sha256:d1', verdicts 18/20 and 10/20
    const { impl } = routedFetch({
      attemptMeta: { data: { attemptEnvelopeMetas: { items: [
        { requestId: '0xd1a', chainId: 8453, codeDigest: 'sha256:d1' },
        { requestId: '0xd1b', chainId: 8453, codeDigest: 'sha256:d1' },
      ], pageInfo: { hasNextPage: false, endCursor: null } } } },
      verdictMeta: { data: { verdictEnvelopeMetas: { items: [
        { requestId: '0xd1a', chainId: 8453, actualPassed: true, actualScore: '0.9', passedCount: '18', totalCount: '20' },
        { requestId: '0xd1b', chainId: 8453, actualPassed: false, actualScore: '0.5', passedCount: '10', totalCount: '20' },
      ], pageInfo: { hasNextPage: false, endCursor: null } } } },
    });
    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    const [row] = await client.getCodeDigestRewards({ codeDigests: ['sha256:d1'] });
    expect([...row!.gradedScores].sort()).toEqual([0.5, 0.9]);
    expect(row!.avgScore).toBeCloseTo(0.7);
  });

  it('omits gradedScore for verdicts with totalCount 0 (v1 / non-gradeable)', async () => {
    // one v2 18/20, one v1 with totalCount absent
    const { impl } = routedFetch({
      attemptMeta: { data: { attemptEnvelopeMetas: { items: [
        { requestId: '0xd2a', chainId: 8453, codeDigest: 'sha256:d2' },
        { requestId: '0xd2b', chainId: 8453, codeDigest: 'sha256:d2' },
      ], pageInfo: { hasNextPage: false, endCursor: null } } } },
      verdictMeta: { data: { verdictEnvelopeMetas: { items: [
        { requestId: '0xd2a', chainId: 8453, actualPassed: true, actualScore: '0.9', passedCount: '18', totalCount: '20' },
        { requestId: '0xd2b', chainId: 8453, actualPassed: false, actualScore: '0.0' },
      ], pageInfo: { hasNextPage: false, endCursor: null } } } },
    });
    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    const [row] = await client.getCodeDigestRewards({ codeDigests: ['sha256:d2'] });
    expect(row!.gradedScores).toEqual([0.9]);
    expect(row!.attempts).toBe(2);
  });
});

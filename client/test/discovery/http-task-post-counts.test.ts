/**
 * Tests for HttpDiscoveryAPI.getTaskPostCounts (#918).
 *
 * The HTTP backing pages task rows ordered by createdAtBlock desc, reads the
 * top row's block as the window head, then buckets the three windows (1h / 6h /
 * 24h) AND the per-cid totals client-side from createdAtBlock + manifestDigest.
 * Block-window approximation (Base ~2s blocktime → 1800 / 10800 / 43200 blocks).
 *
 * Mocks fetchImpl with canned GraphQL pages, mirroring http.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { createHttpDiscoveryAPI } from '../../src/discovery/http.js';
import { DiscoveryUnavailableError } from '../../src/discovery/types.js';
import { manifestDigestForCid } from '../../src/adapters/mech/digest.js';

const BASE_URL = 'http://localhost:42069';

const CID_A = 'bafyHttpPostsA';
const CID_B = 'bafyHttpPostsB';
const DIGEST_A = manifestDigestForCid(CID_A).toLowerCase();
const DIGEST_B = manifestDigestForCid(CID_B).toLowerCase();

function isReadyProbe(url: string): boolean {
  return url.endsWith('/ready');
}

/** Serve a single TaskPostCounts page (head = top row's createdAtBlock). */
function mockTaskPostsFetch(items: unknown[]) {
  const queries: string[] = [];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    if (isReadyProbe(url)) return new Response(null, { status: 200 });
    const body = JSON.parse(init?.body as string) as { query: string };
    queries.push(body.query);
    return new Response(
      JSON.stringify({
        data: { tasks: { items, pageInfo: { hasNextPage: false, endCursor: null } } },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  return { impl, queries };
}

describe('HttpDiscoveryAPI.getTaskPostCounts (#918)', () => {
  it('buckets chain + per-cid windows from createdAtBlock client-side', async () => {
    const head = 100_000;
    // head=100000 → h1 cut 98200, h6 cut 89200, h24 cut 56800.
    const { impl } = mockTaskPostsFetch([
      { id: '1', manifestDigest: DIGEST_A, createdAtBlock: String(head) },          // A: h1
      { id: '2', manifestDigest: DIGEST_A, createdAtBlock: String(head - 5_000) },  // A: h6
      { id: '3', manifestDigest: DIGEST_B, createdAtBlock: String(head - 20_000) }, // B: h24
      { id: '4', manifestDigest: DIGEST_B, createdAtBlock: String(head - 60_000) }, // older than 24h
    ]);
    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    const result = await client.getTaskPostCounts({ manifestCids: [CID_A, CID_B] });

    expect(result.windowEndBlock).toBe(head);
    expect(result.chain).toMatchObject({ h1: 1, h6: 2, h24: 3 });
    expect(result.byCid[CID_A]).toMatchObject({ h1: 1, h6: 2, h24: 2 });
    expect(result.byCid[CID_B]).toMatchObject({ h1: 0, h6: 0, h24: 1 });
  });

  it('returns zero counts and empty byCid when there are no tasks', async () => {
    const { impl } = mockTaskPostsFetch([]);
    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    const result = await client.getTaskPostCounts();
    expect(result.chain).toMatchObject({ h1: 0, h6: 0, h24: 0 });
    expect(result.byCid).toEqual({});
  });

  it('omits byCid entries when no manifestCids are supplied', async () => {
    const head = 100_000;
    const { impl } = mockTaskPostsFetch([
      { id: '1', manifestDigest: DIGEST_A, createdAtBlock: String(head) },
    ]);
    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    const result = await client.getTaskPostCounts();
    expect(result.chain.h24).toBe(1);
    expect(result.byCid).toEqual({});
  });

  it('throws DiscoveryUnavailableError on GraphQL errors', async () => {
    const impl = vi.fn(async (url: string) => {
      if (isReadyProbe(url)) return new Response(null, { status: 200 });
      return new Response(JSON.stringify({ errors: [{ message: 'boom' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    await expect(client.getTaskPostCounts()).rejects.toThrow(DiscoveryUnavailableError);
  });

  it('throws DiscoveryUnavailableError when the indexer is not ready (ensureReady gate)', async () => {
    const graphqlCalls: string[] = [];
    const impl = vi.fn(async (url: string) => {
      if (isReadyProbe(url)) return new Response(null, { status: 503 });
      graphqlCalls.push(url);
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    });
    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    await expect(client.getTaskPostCounts()).rejects.toThrow(DiscoveryUnavailableError);
    expect(graphqlCalls.length).toBe(0);
  });
});

/**
 * Tests for HttpDiscoveryAPI.getMostRecentTaskCidDigest (#957).
 *
 * The HTTP backing queries the `task` table filtered by
 * `manifestDigest == keccak256(manifestCid)`, ordered most-recent-first
 * (createdAtBlock desc), limit 1, and returns that row's taskCidDigest + id.
 *
 * Mocks fetchImpl with canned GraphQL pages, mirroring http-task-post-counts.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { createHttpDiscoveryAPI } from '../../src/discovery/http.js';
import { DiscoveryUnavailableError } from '../../src/discovery/types.js';
import { manifestDigestForCid } from '../../src/adapters/mech/digest.js';

const BASE_URL = 'http://localhost:42069';
const CID = 'bafyMostRecentTask';
const DIGEST = manifestDigestForCid(CID).toLowerCase();

function isReadyProbe(url: string): boolean {
  return url.endsWith('/ready');
}

/** Serve a single tasks page; capture the GraphQL variables of each call. */
function mockTasksFetch(items: unknown[]) {
  const variables: Array<Record<string, unknown>> = [];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    if (isReadyProbe(url)) return new Response(null, { status: 200 });
    const body = JSON.parse(init?.body as string) as { variables: Record<string, unknown> };
    variables.push(body.variables);
    return new Response(
      JSON.stringify({
        data: { tasks: { items, pageInfo: { hasNextPage: false, endCursor: null } } },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  return { impl, variables };
}

describe('HttpDiscoveryAPI.getMostRecentTaskCidDigest (#957)', () => {
  it('returns the most-recent task digest + id, filtering by manifestDigest', async () => {
    const taskCidDigest = `0x${'ab'.repeat(32)}`;
    const { impl, variables } = mockTasksFetch([
      { id: '42', taskCidDigest, manifestDigest: DIGEST, createdAtBlock: '100000' },
    ]);
    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    const result = await client.getMostRecentTaskCidDigest(CID);

    expect(result).toEqual({ taskCidDigest, taskId: '42' });
    // The query is scoped to the keccak256(cid) digest the indexer keys tasks by.
    expect(variables[0]?.manifestDigest).toBe(DIGEST);
  });

  it('returns undefined when no task exists for the manifest', async () => {
    const { impl } = mockTasksFetch([]);
    const client = createHttpDiscoveryAPI({ url: BASE_URL, fetchImpl: impl as unknown as typeof fetch });
    expect(await client.getMostRecentTaskCidDigest(CID)).toBeUndefined();
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
    await expect(client.getMostRecentTaskCidDigest(CID)).rejects.toThrow(DiscoveryUnavailableError);
  });
});

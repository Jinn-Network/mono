/**
 * Tests for `resolveAgentIdForManifest` (jinn-mono-yg4).
 *
 * Pins the subgraph-path resolution semantics:
 *   - Returns the operator's agentId on a clean match.
 *   - Returns null when the subgraph has no row for the manifestHash.
 *   - Returns null when subgraphUrl is undefined (no on-chain fallback wired).
 *   - Fails closed (null + warn) on transport / GraphQL errors.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveAgentIdForManifest } from '../../src/discovery/agent-resolver.js';

const MANIFEST_HASH =
  '0xfeedfacedeadbeef00000000000000000000000000000000000000000000beef' as `0x${string}`;
const SUBGRAPH_URL = 'http://example.test/subgraph';

function makeFetch(responseInit: {
  ok?: boolean;
  status?: number;
  body: unknown;
  throwOnFetch?: Error;
}): typeof fetch {
  return vi.fn(async () => {
    if (responseInit.throwOnFetch) throw responseInit.throwOnFetch;
    return {
      ok: responseInit.ok ?? true,
      status: responseInit.status ?? 200,
      json: async () => responseInit.body,
    } as Response;
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('resolveAgentIdForManifest', () => {
  it('returns the operator agentId from the first execution row', async () => {
    const fetchImpl = makeFetch({
      body: {
        data: {
          executions: [
            {
              manifestCid: 'bafyrestorerCid123',
              operator: { agentId: '42' },
            },
          ],
        },
      },
    });

    const resolved = await resolveAgentIdForManifest({
      manifestHash: MANIFEST_HASH,
      subgraphUrl: SUBGRAPH_URL,
      fetchImpl,
    });

    expect(resolved).not.toBeNull();
    expect(resolved!.agentId).toBe(42n);
    expect(resolved!.manifestCid).toBe('bafyrestorerCid123');
  });

  it('lower-cases manifestHash before sending it to the subgraph (Bytes filter)', async () => {
    let capturedBody: { variables?: { manifestHash?: string } } | null = null;
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse((init?.body as string) ?? '{}') as typeof capturedBody;
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { executions: [] } }),
      } as Response;
    });
    const mixedCase =
      '0xFEEDFACEdeadbeef00000000000000000000000000000000000000000000BEEF' as `0x${string}`;
    await resolveAgentIdForManifest({
      manifestHash: mixedCase,
      subgraphUrl: SUBGRAPH_URL,
      fetchImpl,
    });
    expect(capturedBody!.variables!.manifestHash).toBe(mixedCase.toLowerCase());
  });

  it('returns null when the subgraph reports no executions', async () => {
    const fetchImpl = makeFetch({
      body: { data: { executions: [] } },
    });

    const resolved = await resolveAgentIdForManifest({
      manifestHash: MANIFEST_HASH,
      subgraphUrl: SUBGRAPH_URL,
      fetchImpl,
    });

    expect(resolved).toBeNull();
  });

  it('returns null when subgraphUrl is undefined (no resolver query attempted)', async () => {
    const fetchImpl = vi.fn();
    const resolved = await resolveAgentIdForManifest({
      manifestHash: MANIFEST_HASH,
      fetchImpl,
    });
    expect(resolved).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns null when the subgraph returns operator: null (malformed row)', async () => {
    const fetchImpl = makeFetch({
      body: {
        data: {
          executions: [{ manifestCid: 'bafy...', operator: null }],
        },
      },
    });
    const resolved = await resolveAgentIdForManifest({
      manifestHash: MANIFEST_HASH,
      subgraphUrl: SUBGRAPH_URL,
      fetchImpl,
    });
    expect(resolved).toBeNull();
  });

  it('returns null when GraphQL returns errors', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = makeFetch({
      body: { errors: [{ message: 'bad query' }] },
    });
    const resolved = await resolveAgentIdForManifest({
      manifestHash: MANIFEST_HASH,
      subgraphUrl: SUBGRAPH_URL,
      fetchImpl,
    });
    expect(resolved).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('returns null on non-2xx HTTP response', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = makeFetch({
      ok: false,
      status: 503,
      body: '',
    });
    const resolved = await resolveAgentIdForManifest({
      manifestHash: MANIFEST_HASH,
      subgraphUrl: SUBGRAPH_URL,
      fetchImpl,
    });
    expect(resolved).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('returns null when fetch throws (network error)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = makeFetch({
      throwOnFetch: new Error('ECONNREFUSED'),
      body: null,
    });
    const resolved = await resolveAgentIdForManifest({
      manifestHash: MANIFEST_HASH,
      subgraphUrl: SUBGRAPH_URL,
      fetchImpl,
    });
    expect(resolved).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('returns null when agentId is non-numeric (defensive)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = makeFetch({
      body: {
        data: {
          executions: [
            { manifestCid: 'bafy', operator: { agentId: 'not-a-number' } },
          ],
        },
      },
    });
    const resolved = await resolveAgentIdForManifest({
      manifestHash: MANIFEST_HASH,
      subgraphUrl: SUBGRAPH_URL,
      fetchImpl,
    });
    expect(resolved).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('preserves manifestCid: null when subgraph row omits it', async () => {
    const fetchImpl = makeFetch({
      body: {
        data: {
          executions: [
            { manifestCid: null, operator: { agentId: '7' } },
          ],
        },
      },
    });
    const resolved = await resolveAgentIdForManifest({
      manifestHash: MANIFEST_HASH,
      subgraphUrl: SUBGRAPH_URL,
      fetchImpl,
    });
    expect(resolved).toEqual({ agentId: 7n, manifestCid: null });
  });
});

/**
 * Tests for `resolveAgentIdForManifest` (jinn-mono-280n.6 part A).
 *
 * The resolver now delegates to `discoveryApi.queryEnvelopes` instead of
 * querying the hosted subgraph directly. These tests mock the DiscoveryAPI
 * and assert the same semantic contract as before:
 *   - Returns the operator's agentId on a clean match.
 *   - Returns null when the indexer has no envelope for the manifestHash.
 *   - Returns null when discoveryApi is undefined (no resolver query attempted).
 *   - Fails closed (null + warn) on errors from the DiscoveryAPI.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveAgentIdForManifest } from '../../src/erc8004/identity.js';
import type { DiscoveryAPI } from '../../src/discovery/types.js';
import type { EnvelopeRef } from '../../src/corpus/types.js';

const MANIFEST_HASH =
  '0xfeedfacedeadbeef00000000000000000000000000000000000000000000beef' as `0x${string}`;

function makeEnvelopeRef(args: { agentId: string; manifestCid: string }): EnvelopeRef {
  return {
    manifestCid: args.manifestCid,
    manifestHash: MANIFEST_HASH,
    operator: { agentId: args.agentId, safeAddress: '' },
    evidenceTier: 'self-signed',
    publishedAt: 0,
  };
}

function makeDiscoveryApi(refs: EnvelopeRef[]): DiscoveryAPI {
  return {
    async queryEnvelopes() { return refs; },
    async listLaunchedSolverNets() { return []; },
    async getLifecycleStatus() { return undefined; },
    async findClaimableTasks() { return []; },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('resolveAgentIdForManifest', () => {
  it('returns the operator agentId from the first envelope ref', async () => {
    const discoveryApi = makeDiscoveryApi([
      makeEnvelopeRef({ agentId: '42', manifestCid: 'bafyharnessCid123' }),
    ]);

    const resolved = await resolveAgentIdForManifest({
      manifestHash: MANIFEST_HASH,
      discoveryApi,
    });

    expect(resolved).not.toBeNull();
    expect(resolved!.agentId).toBe(42n);
    expect(resolved!.manifestCid).toBe('bafyharnessCid123');
  });

  it('passes manifestHash to queryEnvelopes with limit: 1', async () => {
    let capturedQuery: Parameters<DiscoveryAPI['queryEnvelopes']>[0] | null = null;
    const discoveryApi: DiscoveryAPI = {
      async queryEnvelopes(q) { capturedQuery = q; return []; },
      async listLaunchedSolverNets() { return []; },
      async getLifecycleStatus() { return undefined; },
      async findClaimableTasks() { return []; },
    };

    await resolveAgentIdForManifest({
      manifestHash: MANIFEST_HASH,
      discoveryApi,
    });

    expect(capturedQuery).not.toBeNull();
    expect(capturedQuery!.manifestHash).toBe(MANIFEST_HASH);
    expect(capturedQuery!.limit).toBe(1);
  });

  it('returns null when the indexer has no envelope for the manifestHash', async () => {
    const discoveryApi = makeDiscoveryApi([]);

    const resolved = await resolveAgentIdForManifest({
      manifestHash: MANIFEST_HASH,
      discoveryApi,
    });

    expect(resolved).toBeNull();
  });

  it('returns null when discoveryApi is undefined (no resolver query attempted)', async () => {
    const resolved = await resolveAgentIdForManifest({
      manifestHash: MANIFEST_HASH,
      // discoveryApi intentionally absent
    });
    expect(resolved).toBeNull();
  });

  it('returns null when the envelope ref has no agentId (malformed row)', async () => {
    const ref: EnvelopeRef = {
      manifestCid: 'bafy...',
      manifestHash: MANIFEST_HASH,
      operator: { agentId: '', safeAddress: '' },
      evidenceTier: 'self-signed',
      publishedAt: 0,
    };
    const discoveryApi = makeDiscoveryApi([ref]);
    const resolved = await resolveAgentIdForManifest({ manifestHash: MANIFEST_HASH, discoveryApi });
    expect(resolved).toBeNull();
  });

  it('returns null and warns when queryEnvelopes throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const discoveryApi: DiscoveryAPI = {
      async queryEnvelopes() { throw new Error('indexer unavailable'); },
      async listLaunchedSolverNets() { return []; },
      async getLifecycleStatus() { return undefined; },
      async findClaimableTasks() { return []; },
    };

    const resolved = await resolveAgentIdForManifest({ manifestHash: MANIFEST_HASH, discoveryApi });
    expect(resolved).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('returns null when agentId is non-numeric (defensive)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ref: EnvelopeRef = {
      manifestCid: 'bafy',
      manifestHash: MANIFEST_HASH,
      operator: { agentId: 'not-a-number', safeAddress: '' },
      evidenceTier: 'self-signed',
      publishedAt: 0,
    };
    const discoveryApi = makeDiscoveryApi([ref]);
    const resolved = await resolveAgentIdForManifest({ manifestHash: MANIFEST_HASH, discoveryApi });
    expect(resolved).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('preserves manifestCid from the envelope ref', async () => {
    const discoveryApi = makeDiscoveryApi([
      makeEnvelopeRef({ agentId: '7', manifestCid: 'bafySpecificCid' }),
    ]);
    const resolved = await resolveAgentIdForManifest({ manifestHash: MANIFEST_HASH, discoveryApi });
    expect(resolved).toEqual({ agentId: 7n, manifestCid: 'bafySpecificCid' });
  });
});

/**
 * Tests for HttpSubgraphDiscoveryAPI — the transitional DiscoveryAPI backed by
 * the existing subgraph clients.
 *
 * Verifies:
 *  1. Each of the four methods delegates correctly to the underlying subgraph client.
 *  2. Errors from the underlying clients get wrapped in DiscoveryUnavailableError.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SubgraphClient } from '../../src/solvernets/registry-client-erc8004.js';
import type { SetMetadataEvent } from '../../src/solvernets/most-recent-wins.js';
import { createHttpSubgraphDiscoveryAPI } from '../../src/discovery/http-subgraph.js';
import { DiscoveryUnavailableError } from '../../src/discovery/types.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MANIFEST_CID = 'bafyManifestCid1';
const MANIFEST_CID_2 = 'bafyManifestCid2';
const AGENT_ID = '5474';

function makeSetMetadataEvent(cid: string, status: 'launched' | 'paused' | 'retired', blockNumber = 100): SetMetadataEvent {
  return {
    agentId: AGENT_ID,
    key: `solvernet-manifest:${cid}`,
    payload: {
      schemaVersion: 'solvernet.lifecycle.v1',
      status,
      at: '2026-05-11T00:00:00.000Z',
      hash: '0x' + 'a'.repeat(64) as `0x${string}`,
    },
    blockNumber,
    transactionIndex: 0,
  };
}

function makeSubgraphClient(overrides: Partial<SubgraphClient> = {}): SubgraphClient {
  return {
    fetchSetMetadataEvents: vi.fn().mockResolvedValue([]),
    fetchSetMetadataEventsForCid: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

// ── findClaimableTasks ─────────────────────────────────────────────────────────

describe('HttpSubgraphDiscoveryAPI.findClaimableTasks', () => {
  it('delegates to queryClaimableTaskCandidates and returns ClaimableTaskCandidate[]', async () => {
    const taskId = '42';
    const fakeFetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            tasks: [{
              taskId,
              taskCidDigest: '0x' + 'cc'.repeat(32),
              manifestDigest: '0x' + '99'.repeat(32),
              createdAtBlock: '100',
              createdAtTx: '0x' + '12'.repeat(32),
              maxClaims: 10,
              claimWindowEnd: '9999999999',
              attempts: [],
              operatorAttempts: [],
            }],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const api = createHttpSubgraphDiscoveryAPI({
      subgraphUrl: 'https://subgraph.test/graphql',
      subgraphClient: makeSubgraphClient(),
      fetchImpl: fakeFetch,
    });

    const results = await api.findClaimableTasks({
      solverNetManifestCids: [MANIFEST_CID],
      operatorAddress: '0x' + 'aa'.repeat(20) as `0x${string}`,
    });

    expect(fakeFetch).toHaveBeenCalledWith(
      'https://subgraph.test/graphql',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(results).toHaveLength(1);
    expect(results[0].taskId).toBe(taskId);
    expect(results[0].attemptCount).toBe(0);
    expect(results[0].operatorAttemptCount).toBe(0);
  });

  it('wraps subgraph HTTP errors in DiscoveryUnavailableError', async () => {
    const fakeFetch = vi.fn().mockResolvedValueOnce(
      new Response('rate limited', { status: 429 }),
    );

    const api = createHttpSubgraphDiscoveryAPI({
      subgraphUrl: 'https://subgraph.test/graphql',
      subgraphClient: makeSubgraphClient(),
      fetchImpl: fakeFetch,
    });

    await expect(
      api.findClaimableTasks({
        solverNetManifestCids: [MANIFEST_CID],
        operatorAddress: '0x' + 'aa'.repeat(20) as `0x${string}`,
      }),
    ).rejects.toBeInstanceOf(DiscoveryUnavailableError);
  });

  it('wraps network fetch errors in DiscoveryUnavailableError', async () => {
    const fakeFetch = vi.fn().mockRejectedValueOnce(new Error('fetch failed'));

    const api = createHttpSubgraphDiscoveryAPI({
      subgraphUrl: 'https://subgraph.test/graphql',
      subgraphClient: makeSubgraphClient(),
      fetchImpl: fakeFetch,
    });

    await expect(
      api.findClaimableTasks({
        solverNetManifestCids: [MANIFEST_CID],
        operatorAddress: '0x' + 'aa'.repeat(20) as `0x${string}`,
      }),
    ).rejects.toBeInstanceOf(DiscoveryUnavailableError);
  });

  it('returns empty when no manifest CIDs supplied', async () => {
    const fakeFetch = vi.fn();

    const api = createHttpSubgraphDiscoveryAPI({
      subgraphUrl: 'https://subgraph.test/graphql',
      subgraphClient: makeSubgraphClient(),
      fetchImpl: fakeFetch,
    });

    const results = await api.findClaimableTasks({
      solverNetManifestCids: [],
      operatorAddress: '0x' + 'aa'.repeat(20) as `0x${string}`,
    });

    expect(results).toHaveLength(0);
    expect(fakeFetch).not.toHaveBeenCalled();
  });
});

// ── listLaunchedSolverNets ─────────────────────────────────────────────────────

describe('HttpSubgraphDiscoveryAPI.listLaunchedSolverNets', () => {
  it('delegates to subgraphClient.fetchSetMetadataEvents and returns summaries', async () => {
    const events = [
      makeSetMetadataEvent(MANIFEST_CID, 'launched', 100),
      makeSetMetadataEvent(MANIFEST_CID_2, 'paused', 200),
    ];
    const subgraphClient = makeSubgraphClient({
      fetchSetMetadataEvents: vi.fn().mockResolvedValue(events),
    });

    const api = createHttpSubgraphDiscoveryAPI({
      subgraphUrl: 'https://subgraph.test/graphql',
      subgraphClient,
      fetchImpl: vi.fn(),
    });

    const summaries = await api.listLaunchedSolverNets();

    expect(subgraphClient.fetchSetMetadataEvents).toHaveBeenCalledWith(
      expect.objectContaining({ keyPrefix: 'solvernet-manifest:' }),
    );
    expect(summaries).toHaveLength(2);
    expect(summaries.map((s) => s.status)).toEqual(expect.arrayContaining(['launched', 'paused']));
  });

  it('filters by status when requested', async () => {
    const events = [
      makeSetMetadataEvent(MANIFEST_CID, 'launched', 100),
      makeSetMetadataEvent(MANIFEST_CID_2, 'paused', 200),
    ];
    const subgraphClient = makeSubgraphClient({
      fetchSetMetadataEvents: vi.fn().mockResolvedValue(events),
    });

    const api = createHttpSubgraphDiscoveryAPI({
      subgraphUrl: 'https://subgraph.test/graphql',
      subgraphClient,
      fetchImpl: vi.fn(),
    });

    const summaries = await api.listLaunchedSolverNets({ status: ['launched'] });

    expect(summaries).toHaveLength(1);
    expect(summaries[0].status).toBe('launched');
  });

  it('wraps subgraphClient errors in DiscoveryUnavailableError', async () => {
    const subgraphClient = makeSubgraphClient({
      fetchSetMetadataEvents: vi.fn().mockRejectedValue(new Error('subgraph 503')),
    });

    const api = createHttpSubgraphDiscoveryAPI({
      subgraphUrl: 'https://subgraph.test/graphql',
      subgraphClient,
      fetchImpl: vi.fn(),
    });

    await expect(api.listLaunchedSolverNets()).rejects.toBeInstanceOf(DiscoveryUnavailableError);
  });
});

// ── getLifecycleStatus ─────────────────────────────────────────────────────────

describe('HttpSubgraphDiscoveryAPI.getLifecycleStatus', () => {
  it('delegates to subgraphClient.fetchSetMetadataEventsForCid and returns status', async () => {
    const events = [makeSetMetadataEvent(MANIFEST_CID, 'launched', 150)];
    const subgraphClient = makeSubgraphClient({
      fetchSetMetadataEventsForCid: vi.fn().mockResolvedValue(events),
    });

    const api = createHttpSubgraphDiscoveryAPI({
      subgraphUrl: 'https://subgraph.test/graphql',
      subgraphClient,
      fetchImpl: vi.fn(),
    });

    const result = await api.getLifecycleStatus(MANIFEST_CID);

    expect(subgraphClient.fetchSetMetadataEventsForCid).toHaveBeenCalledWith({ manifestCid: MANIFEST_CID });
    expect(result).toMatchObject({
      status: 'launched',
      sourceBlock: 150,
    });
  });

  it('returns undefined when no events found for cid', async () => {
    const subgraphClient = makeSubgraphClient({
      fetchSetMetadataEventsForCid: vi.fn().mockResolvedValue([]),
    });

    const api = createHttpSubgraphDiscoveryAPI({
      subgraphUrl: 'https://subgraph.test/graphql',
      subgraphClient,
      fetchImpl: vi.fn(),
    });

    const result = await api.getLifecycleStatus(MANIFEST_CID);

    expect(result).toBeUndefined();
  });

  it('wraps subgraphClient errors in DiscoveryUnavailableError', async () => {
    const subgraphClient = makeSubgraphClient({
      fetchSetMetadataEventsForCid: vi.fn().mockRejectedValue(new Error('subgraph timeout')),
    });

    const api = createHttpSubgraphDiscoveryAPI({
      subgraphUrl: 'https://subgraph.test/graphql',
      subgraphClient,
      fetchImpl: vi.fn(),
    });

    await expect(api.getLifecycleStatus(MANIFEST_CID)).rejects.toBeInstanceOf(DiscoveryUnavailableError);
  });
});

// ── queryEnvelopes ─────────────────────────────────────────────────────────────

describe('HttpSubgraphDiscoveryAPI.queryEnvelopes', () => {
  it('delegates to runCorpusQuery (subgraph fetch) and returns EnvelopeRef[]', async () => {
    const fakeFetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            executions: [{
              id: '1-0xabc',
              manifestCid: MANIFEST_CID,
              manifestHash: '0x' + 'a'.repeat(64),
              tier: 'COMMITTED',
              publishedAt: '1745978400',
              operator: { id: '1', agentId: '1', owner: '0x' + '2'.repeat(40), agentWallet: '0x' + '3'.repeat(40) },
            }],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const api = createHttpSubgraphDiscoveryAPI({
      subgraphUrl: 'https://subgraph.test/graphql',
      subgraphClient: makeSubgraphClient(),
      fetchImpl: fakeFetch,
    });

    const refs = await api.queryEnvelopes({ limit: 5 });

    expect(fakeFetch).toHaveBeenCalledWith(
      'https://subgraph.test/graphql',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(refs).toHaveLength(1);
    expect(refs[0].manifestCid).toBe(MANIFEST_CID);
    expect(refs[0].evidenceTier).toBe('committed');
  });

  it('wraps subgraph HTTP errors in DiscoveryUnavailableError', async () => {
    const fakeFetch = vi.fn().mockResolvedValueOnce(
      new Response('bad gateway', { status: 502 }),
    );

    const api = createHttpSubgraphDiscoveryAPI({
      subgraphUrl: 'https://subgraph.test/graphql',
      subgraphClient: makeSubgraphClient(),
      fetchImpl: fakeFetch,
    });

    await expect(api.queryEnvelopes({ limit: 5 })).rejects.toBeInstanceOf(DiscoveryUnavailableError);
  });

  it('wraps network errors in DiscoveryUnavailableError', async () => {
    const fakeFetch = vi.fn().mockRejectedValueOnce(new TypeError('network error'));

    const api = createHttpSubgraphDiscoveryAPI({
      subgraphUrl: 'https://subgraph.test/graphql',
      subgraphClient: makeSubgraphClient(),
      fetchImpl: fakeFetch,
    });

    await expect(api.queryEnvelopes({ limit: 5 })).rejects.toBeInstanceOf(DiscoveryUnavailableError);
  });
});

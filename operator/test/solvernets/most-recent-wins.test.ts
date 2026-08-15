/**
 * Tests for `resolveMostRecentWins` (Task 4).
 *
 * The resolver folds a stream of `IdentityRegistry.setMetadata` events for the
 * `solvernet-manifest:<cid>` key prefix into the current lifecycle status of
 * each unique (launcherAgentId, manifestCid) tuple, picking the most recent
 * event per tuple. Spec §6.3.
 *
 * Tiebreak rule: if two events share `blockNumber`, the one with the higher
 * `transactionIndex` wins (later in the block).
 */

import { describe, it, expect } from 'vitest';

import {
  resolveMostRecentWins,
  type SetMetadataEvent,
} from '../../src/solvernets/most-recent-wins.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const HASH_A = ('0x' + 'aa'.repeat(32)) as `0x${string}`;
const HASH_B = ('0x' + 'bb'.repeat(32)) as `0x${string}`;

function ev(args: {
  agentId: string;
  cid: string;
  status: 'launched' | 'paused' | 'retired';
  at: string;
  hash?: `0x${string}`;
  blockNumber: number;
  transactionIndex?: number;
}): SetMetadataEvent {
  return {
    agentId: args.agentId,
    key: `solvernet-manifest:${args.cid}`,
    payload: {
      schemaVersion: 'solvernet.lifecycle.v1',
      status: args.status,
      at: args.at,
      hash: args.hash ?? HASH_A,
    },
    blockNumber: args.blockNumber,
    transactionIndex: args.transactionIndex ?? 0,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('resolveMostRecentWins', () => {
  it('returns an empty list for no events', () => {
    expect(resolveMostRecentWins([])).toEqual([]);
  });

  it('returns a single resolved record for a single event', () => {
    const events = [
      ev({
        agentId: '5474',
        cid: 'bafyA',
        status: 'launched',
        at: '2026-05-06T00:00:00Z',
        blockNumber: 100,
      }),
    ];

    const resolved = resolveMostRecentWins(events);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toEqual({
      manifestCid: 'bafyA',
      launcherAgentId: '5474',
      status: 'launched',
      statusUpdatedAt: '2026-05-06T00:00:00Z',
      manifestHash: HASH_A,
      anchorBlock: 100,
      anchorTransactionIndex: 0,
    });
  });

  it('populates anchorTransactionIndex from the winning event', () => {
    // Two events tied on blockNumber — higher transactionIndex wins, and
    // the resolved row's anchorTransactionIndex must reflect that winner
    // so cross-launcher tiebreaks remain deterministic downstream.
    const events = [
      ev({
        agentId: '5474',
        cid: 'bafyA',
        status: 'launched',
        at: '2026-05-06T00:00:00Z',
        blockNumber: 100,
        transactionIndex: 2,
      }),
      ev({
        agentId: '5474',
        cid: 'bafyA',
        status: 'paused',
        at: '2026-05-06T00:00:00Z',
        blockNumber: 100,
        transactionIndex: 7,
      }),
    ];

    const resolved = resolveMostRecentWins(events);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.status).toBe('paused');
    expect(resolved[0]?.anchorBlock).toBe(100);
    expect(resolved[0]?.anchorTransactionIndex).toBe(7);
  });

  it('picks the event with the highest blockNumber for the same (agentId, cid)', () => {
    const events = [
      ev({
        agentId: '5474',
        cid: 'bafyA',
        status: 'launched',
        at: '2026-05-06T00:00:00Z',
        blockNumber: 100,
      }),
      ev({
        agentId: '5474',
        cid: 'bafyA',
        status: 'paused',
        at: '2026-05-06T01:00:00Z',
        blockNumber: 200,
      }),
      ev({
        agentId: '5474',
        cid: 'bafyA',
        status: 'retired',
        at: '2026-05-06T02:00:00Z',
        blockNumber: 150,
      }),
    ];

    const resolved = resolveMostRecentWins(events);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.status).toBe('paused');
    expect(resolved[0]?.statusUpdatedAt).toBe('2026-05-06T01:00:00Z');
    expect(resolved[0]?.anchorBlock).toBe(200);
  });

  it('ties on blockNumber: higher transactionIndex wins', () => {
    const events = [
      ev({
        agentId: '5474',
        cid: 'bafyA',
        status: 'launched',
        at: '2026-05-06T00:00:00Z',
        blockNumber: 100,
        transactionIndex: 0,
      }),
      ev({
        agentId: '5474',
        cid: 'bafyA',
        status: 'paused',
        at: '2026-05-06T00:00:00Z',
        blockNumber: 100,
        transactionIndex: 5,
      }),
      ev({
        agentId: '5474',
        cid: 'bafyA',
        status: 'retired',
        at: '2026-05-06T00:00:00Z',
        blockNumber: 100,
        transactionIndex: 3,
      }),
    ];

    const resolved = resolveMostRecentWins(events);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.status).toBe('paused');
    expect(resolved[0]?.anchorBlock).toBe(100);
  });

  it('resolves multiple cids independently', () => {
    const events = [
      ev({
        agentId: '5474',
        cid: 'bafyA',
        status: 'launched',
        at: '2026-05-06T00:00:00Z',
        blockNumber: 100,
        hash: HASH_A,
      }),
      ev({
        agentId: '5474',
        cid: 'bafyA',
        status: 'paused',
        at: '2026-05-06T01:00:00Z',
        blockNumber: 200,
        hash: HASH_A,
      }),
      ev({
        agentId: '8888',
        cid: 'bafyB',
        status: 'launched',
        at: '2026-05-06T00:00:00Z',
        blockNumber: 300,
        hash: HASH_B,
      }),
    ];

    const resolved = resolveMostRecentWins(events);
    expect(resolved).toHaveLength(2);

    const byCid = new Map(resolved.map((r) => [r.manifestCid, r]));
    expect(byCid.get('bafyA')?.status).toBe('paused');
    expect(byCid.get('bafyA')?.anchorBlock).toBe(200);
    expect(byCid.get('bafyA')?.manifestHash).toBe(HASH_A);
    expect(byCid.get('bafyB')?.status).toBe('launched');
    expect(byCid.get('bafyB')?.anchorBlock).toBe(300);
    expect(byCid.get('bafyB')?.manifestHash).toBe(HASH_B);
  });

  it('treats the same cid under different agentIds as distinct tuples', () => {
    // Two launchers each anchoring (via setMetadata) the same manifest cid.
    // This shouldn't typically happen, but the resolver must keep them separate.
    const events = [
      ev({
        agentId: '5474',
        cid: 'bafyShared',
        status: 'launched',
        at: '2026-05-06T00:00:00Z',
        blockNumber: 100,
      }),
      ev({
        agentId: '8888',
        cid: 'bafyShared',
        status: 'paused',
        at: '2026-05-06T01:00:00Z',
        blockNumber: 200,
      }),
    ];

    const resolved = resolveMostRecentWins(events);
    expect(resolved).toHaveLength(2);
    const byAgent = new Map(resolved.map((r) => [r.launcherAgentId, r]));
    expect(byAgent.get('5474')?.status).toBe('launched');
    expect(byAgent.get('8888')?.status).toBe('paused');
  });

  it('skips events whose key does not match the solvernet-manifest prefix', () => {
    const events: SetMetadataEvent[] = [
      ev({
        agentId: '5474',
        cid: 'bafyA',
        status: 'launched',
        at: '2026-05-06T00:00:00Z',
        blockNumber: 100,
      }),
      // Synthesize an off-prefix event — defensive: fetcher should already
      // filter, but the resolver doesn't trust upstream blindly.
      {
        agentId: '5474',
        key: 'envelope:bafyOther',
        payload: {
          schemaVersion: 'solvernet.lifecycle.v1',
          status: 'paused',
          at: '2026-05-06T01:00:00Z',
          hash: HASH_A,
        },
        blockNumber: 200,
        transactionIndex: 0,
      },
    ];

    const resolved = resolveMostRecentWins(events);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.manifestCid).toBe('bafyA');
    expect(resolved[0]?.status).toBe('launched');
  });
});

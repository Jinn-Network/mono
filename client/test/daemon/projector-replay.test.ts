// Defect #47. The replay mechanism the gate close-out depends on: after a resolver defect drops a
// gate-relevant event, the drop is PERMANENT — `ChainLogSource.poll()` commits its advanced block
// cursor inside its own transaction before it returns the logs, so each log is offered to `enrich`
// exactly once, ever. These tests drive the REAL `createChainLogSource` against a real venue state
// file, seed a cursor swept past a known event, and prove the rewind makes that exact event
// re-offer. The negative control is the one that matters: the "just delete the cursor row"
// procedure provably skips the range instead of replaying it.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Address, Hex, PublicClient } from 'viem';
import { BASE_SEPOLIA_TODAY } from '@jinn-network/marketplace-binding';
import { openVenueState, type VenueStateDatabase } from '@jinn-network/marketplace-venue-base';
import { createProjectorLogSource } from '../../src/daemon/projector-log-source.js';
import {
  ProjectorReplayError,
  readChainLogCursor,
  rewindChainLogCursor,
} from '../../src/daemon/projector-replay.js';

const STREAM = `venue:${BASE_SEPOLIA_TODAY.chainId}:${BASE_SEPOLIA_TODAY.jinnRouter.toLowerCase()}`;
const MECH_ADDRESS = '0x7777777777777777777777777777777777777777' as Address;

/** The block the round-28 verdict settled in, scaled down but kept ordered the same way. */
const EVENT_BLOCK = 1_000n;
const SWEPT_LIVE = 1_500n;
const SWEPT_FINALIZED = 1_400n;
const LATEST = 1_600n;
const FINALIZED = 1_550n;

const hashAt = (n: bigint): Hex => `0x${n.toString(16).padStart(64, '0')}` as Hex;

function buildChain(): PublicClient {
  return {
    async getBlock(args: { readonly blockTag?: 'latest' | 'finalized'; readonly blockNumber?: bigint } = {}) {
      if (args.blockNumber !== undefined) return { number: args.blockNumber, hash: hashAt(args.blockNumber) };
      if (args.blockTag === 'finalized') return { number: FINALIZED, hash: hashAt(FINALIZED) };
      return { number: LATEST, hash: hashAt(LATEST) };
    },
    // One marker log, mined at EVENT_BLOCK — stands in for the VerdictDeliveryClaimed the
    // round-28 projector consumed and dropped.
    async getLogs(args: { readonly fromBlock: bigint; readonly toBlock: bigint }) {
      if (EVENT_BLOCK < args.fromBlock || EVENT_BLOCK > args.toBlock) return [];
      return [{
        address: BASE_SEPOLIA_TODAY.jinnRouter,
        topics: [`0x${'a'.repeat(64)}` as Hex],
        data: '0x' as Hex,
        blockHash: hashAt(EVENT_BLOCK),
        blockNumber: EVENT_BLOCK,
        transactionHash: `0x${'b'.repeat(64)}` as Hex,
        transactionIndex: 0,
        logIndex: 0,
        removed: false,
      }];
    },
  } as unknown as PublicClient;
}

function seedSweptCursor(state: VenueStateDatabase): void {
  state.db.prepare(
    'INSERT INTO log_cursors (stream, chain_id, live_block_number, live_block_hash,'
    + ' finalized_block_number, finalized_block_hash, updated_at_ms)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    STREAM,
    BASE_SEPOLIA_TODAY.chainId,
    Number(SWEPT_LIVE),
    hashAt(SWEPT_LIVE),
    Number(SWEPT_FINALIZED),
    hashAt(SWEPT_FINALIZED),
    Date.now(),
  );
}

let root: string;
let state: VenueStateDatabase;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'projector-replay-'));
  state = openVenueState(join(root, 'venue.db'));
});
afterEach(() => {
  state.close();
  rmSync(root, { recursive: true, force: true });
});

function logSource() {
  return createProjectorLogSource({
    chain: BASE_SEPOLIA_TODAY,
    publicClient: buildChain(),
    state,
    mechAddresses: [MECH_ADDRESS],
  });
}

describe('projector replay: the swept-cursor problem', () => {
  it('a cursor swept past the event does not re-offer it', async () => {
    seedSweptCursor(state);

    const batch = await logSource().poll();

    expect(batch.logs).toHaveLength(0);
  });

  it('DELETING the cursor row skips the range instead of replaying it (the documented re-sync is wrong)', async () => {
    seedSweptCursor(state);
    // The "projector re-sync" recipe: wipe the stream row and let it rebuild.
    state.db.prepare('DELETE FROM log_cursors WHERE stream = ?').run(STREAM);

    const batch = await logSource().poll();

    // `poll()`'s cold-start branch reads `options.startBlock ?? finalized.blockNumber`, and
    // nothing in this repository ever sets `startBlock`. So it resumes at the CURRENT finalized
    // head, far above EVENT_BLOCK, and the event is lost a second time.
    expect(batch.logs).toHaveLength(0);
    expect(batch.cursor.blockNumber).toBe(LATEST);
  });

  it('REWINDING the cursor re-offers the exact dropped event', async () => {
    seedSweptCursor(state);

    const result = await rewindChainLogCursor({
      state,
      stream: STREAM,
      toBlock: EVENT_BLOCK - 1n,
      apply: true,
      readCanonicalBlockHash: async (blockNumber) => hashAt(blockNumber),
    });
    expect(result.applied).toBe(true);
    expect(result.replayFromBlock).toBe(EVENT_BLOCK);
    expect(result.replayThroughBlock).toBe(SWEPT_LIVE);

    const batch = await logSource().poll();

    expect(batch.logs).toHaveLength(1);
    expect(batch.logs[0]?.blockNumber).toBe(EVENT_BLOCK);
    // No reorg: the rewind wrote the canonical hash, so `poll()` takes the ordinary catch-up path
    // and never records an orphaned block or a rebuild boundary.
    expect(batch.reorg).toBeUndefined();
  });

  it('restores the finalized mark on the very next poll', async () => {
    seedSweptCursor(state);
    await rewindChainLogCursor({
      state,
      stream: STREAM,
      toBlock: EVENT_BLOCK - 1n,
      apply: true,
      readCanonicalBlockHash: async (blockNumber) => hashAt(blockNumber),
    });
    // Both marks sit at the rewind point (the schema CHECK refuses finalized > live).
    expect(readChainLogCursor(state, STREAM)?.finalizedBlockNumber).toBe(EVENT_BLOCK - 1n);

    await logSource().poll();

    expect(readChainLogCursor(state, STREAM)?.finalizedBlockNumber).toBe(FINALIZED);
  });
});

describe('rewindChainLogCursor', () => {
  it('is a dry run unless apply is explicitly true', async () => {
    seedSweptCursor(state);

    const result = await rewindChainLogCursor({
      state,
      stream: STREAM,
      toBlock: EVENT_BLOCK - 1n,
      readCanonicalBlockHash: async (blockNumber) => hashAt(blockNumber),
    });

    expect(result.applied).toBe(false);
    expect(readChainLogCursor(state, STREAM)?.liveBlockNumber).toBe(SWEPT_LIVE);
  });

  it('touches only the one stream row, leaving scanned block provenance intact', async () => {
    seedSweptCursor(state);
    state.db.prepare(
      'INSERT INTO scanned_block_hashes (stream, chain_id, block_number, block_hash, orphaned_at_ms)'
      + ' VALUES (?, ?, ?, ?, NULL)',
    ).run(STREAM, BASE_SEPOLIA_TODAY.chainId, Number(SWEPT_LIVE), hashAt(SWEPT_LIVE));

    await rewindChainLogCursor({
      state,
      stream: STREAM,
      toBlock: EVENT_BLOCK - 1n,
      apply: true,
      readCanonicalBlockHash: async (blockNumber) => hashAt(blockNumber),
    });

    const scanned = state.db.prepare('SELECT COUNT(*) AS n FROM scanned_block_hashes').get() as { n: number };
    const orphaned = state.db.prepare('SELECT COUNT(*) AS n FROM orphaned_blocks').get() as { n: number };
    expect(scanned.n).toBe(1);
    expect(orphaned.n).toBe(0);
  });

  it('refuses when no cursor row exists rather than creating one that would cold-start at head', async () => {
    await expect(rewindChainLogCursor({
      state,
      stream: STREAM,
      toBlock: EVENT_BLOCK - 1n,
      apply: true,
      readCanonicalBlockHash: async (blockNumber) => hashAt(blockNumber),
    })).rejects.toBeInstanceOf(ProjectorReplayError);
  });

  it('refuses a target at or above the live cursor — a rewind must go backwards', async () => {
    seedSweptCursor(state);

    await expect(rewindChainLogCursor({
      state,
      stream: STREAM,
      toBlock: SWEPT_LIVE,
      apply: true,
      readCanonicalBlockHash: async (blockNumber) => hashAt(blockNumber),
    })).rejects.toBeInstanceOf(ProjectorReplayError);
    expect(readChainLogCursor(state, STREAM)?.liveBlockNumber).toBe(SWEPT_LIVE);
  });

  it('refuses a block hash the chain would not confirm rather than writing one the next poll reads as a reorg', async () => {
    seedSweptCursor(state);

    await expect(rewindChainLogCursor({
      state,
      stream: STREAM,
      toBlock: EVENT_BLOCK - 1n,
      apply: true,
      readCanonicalBlockHash: async () => undefined,
    })).rejects.toBeInstanceOf(ProjectorReplayError);
    expect(readChainLogCursor(state, STREAM)?.liveBlockNumber).toBe(SWEPT_LIVE);
  });
});

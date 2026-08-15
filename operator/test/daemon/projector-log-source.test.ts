// A scripted, in-memory `PublicClient` double — the same technique venue-base's own
// `chain-log-source.test.ts` uses to test `createChainLogSource` without a real chain. This file
// does not re-test `ChainLogSource`'s internals (chunking, reorg rollback, finality marks — all
// covered by venue-base's own suite); it proves this module's own job: that
// `createProjectorLogSource` assembles the *address* set `getLogs` filters on (router +
// coordinator + every host-supplied mech address, deduped/lowercased) and that
// `createFinalizedHeadReader` is a live, read-only query independent of the log source.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Address, Hex, PublicClient } from 'viem';
import { BASE_SEPOLIA_TODAY } from '@jinn-network/marketplace-binding';
import { openVenueState, type VenueStateDatabase } from '@jinn-network/marketplace-venue-base';
import { createFinalizedHeadReader, createProjectorLogSource } from '../../src/daemon/projector-log-source.js';

const MECH_ADDRESS = '0x7777777777777777777777777777777777777777' as Address;
const UNRELATED_ADDRESS = '0x9999999999999999999999999999999999999999' as Address;

interface ScriptedLog {
  readonly address: Address;
  readonly topics: readonly Hex[];
}

function buildScriptedChain(finalizedNumber: bigint, latestNumber: bigint, logs: ScriptedLog[]) {
  const requestedAddressSets: Address[][] = [];
  const hashAt = (n: bigint): Hex => `0x${n.toString(16).padStart(64, '0')}` as Hex;

  const publicClient = {
    async getBlock(args: { readonly blockTag?: 'latest' | 'finalized'; readonly blockNumber?: bigint } = {}) {
      if (args.blockNumber !== undefined) {
        return { number: args.blockNumber, hash: hashAt(args.blockNumber) };
      }
      if (args.blockTag === 'finalized') return { number: finalizedNumber, hash: hashAt(finalizedNumber) };
      return { number: latestNumber, hash: hashAt(latestNumber) };
    },
    async getLogs(args: { readonly address: readonly Address[]; readonly fromBlock: bigint; readonly toBlock: bigint }) {
      requestedAddressSets.push([...args.address]);
      return logs
        .filter((log) => args.address.some((a) => a.toLowerCase() === log.address.toLowerCase()))
        .map((log, index) => ({
          address: log.address,
          topics: log.topics,
          data: '0x' as Hex,
          blockHash: hashAt(finalizedNumber),
          blockNumber: finalizedNumber,
          transactionHash: `0x${index.toString(16).padStart(64, '0')}` as Hex,
          transactionIndex: 0,
          logIndex: index,
          removed: false,
        }));
    },
  } as unknown as PublicClient;

  return { publicClient, requestedAddressSets: () => requestedAddressSets };
}

let root: string;
let state: VenueStateDatabase;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'projector-log-source-'));
  state = openVenueState(join(root, 'venue.db'));
});
afterEach(() => {
  state.close();
  rmSync(root, { recursive: true, force: true });
});

describe('createProjectorLogSource', () => {
  it('scans the router, the coordinator, and every host-supplied mech address', async () => {
    const chain = buildScriptedChain(10n, 10n, [
      { address: BASE_SEPOLIA_TODAY.jinnRouter, topics: [`0x${'1'.repeat(64)}` as Hex] },
      { address: BASE_SEPOLIA_TODAY.taskCoordinator, topics: [`0x${'2'.repeat(64)}` as Hex] },
      { address: MECH_ADDRESS, topics: [`0x${'3'.repeat(64)}` as Hex] },
      { address: UNRELATED_ADDRESS, topics: [`0x${'4'.repeat(64)}` as Hex] },
    ]);
    const source = createProjectorLogSource({
      chain: BASE_SEPOLIA_TODAY,
      publicClient: chain.publicClient,
      state,
      mechAddresses: [MECH_ADDRESS],
      options: { startBlock: 0n },
    });
    const batch = await source.poll();
    const seen = batch.logs.map((log) => log.address.toLowerCase());
    expect(seen).toContain(BASE_SEPOLIA_TODAY.jinnRouter.toLowerCase());
    expect(seen).toContain(BASE_SEPOLIA_TODAY.taskCoordinator.toLowerCase());
    expect(seen).toContain(MECH_ADDRESS.toLowerCase());
    expect(seen).not.toContain(UNRELATED_ADDRESS.toLowerCase());
  });

  it('dedupes and lowercases the requested address set', async () => {
    const chain = buildScriptedChain(10n, 10n, []);
    const source = createProjectorLogSource({
      chain: BASE_SEPOLIA_TODAY,
      publicClient: chain.publicClient,
      state,
      // Same address as the router, differently cased — must not double the filter.
      mechAddresses: [BASE_SEPOLIA_TODAY.jinnRouter.toUpperCase() as Address, MECH_ADDRESS],
      options: { startBlock: 0n },
    });
    await source.poll();
    const requested = chain.requestedAddressSets()[0]!;
    expect(requested).toEqual([...new Set(requested)]);
    expect(requested).toHaveLength(3);
    expect(requested.every((address) => address === address.toLowerCase())).toBe(true);
  });
});

describe('createFinalizedHeadReader', () => {
  it('reads the chain finalized block number live, independent of any log source', async () => {
    const chain = buildScriptedChain(123n, 200n, []);
    const readFinalized = createFinalizedHeadReader(chain.publicClient);
    await expect(readFinalized()).resolves.toBe(123n);
  });
});

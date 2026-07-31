import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex, type PublicClient } from 'viem';
import { BASE_SEPOLIA_TODAY, JINN_ROUTER_V3_ABI } from '@jinn-network/marketplace-binding';
import { DISCOVERY_SIGNING_SCOPE } from '@jinn-network/record-discovery-protocol';
import type { ScopedDiscoverySigner } from '@jinn-network/marketplace-projector';
import { RECORD_KINDS } from '@jinn-network/record-discovery-protocol';
import { openVenueState, type VenueStateDatabase } from '@jinn-network/marketplace-venue-base';
import { Store } from '../../src/store/store.js';
import { ProjectorCursorStore } from '../../src/daemon/projector-cursor.js';
import { ProjectorLoop, type ProjectorLoopConfig } from '../../src/daemon/projector-loop.js';
import { createFinalizedHeadReader, createProjectorLogSource } from '../../src/daemon/projector-log-source.js';

// --- A scripted, in-memory `PublicClient` double -- the same technique venue-base's own
// `chain-log-source.test.ts` uses. This drives a REAL `ChainLogSource` (via
// `createProjectorLogSource`) and a REAL `VenueStateDatabase`, so these tests exercise the
// production adapter path end to end, not a `ProjectorLoop`-side fake of the log source. ---

interface ScriptedBlockLog {
  readonly address: Address;
  readonly topics: readonly Hex[];
  readonly data: Hex;
  readonly transactionHash: Hex;
  readonly logIndex: number;
}

function buildScriptedChain() {
  const blocks: Hex[] = [];
  let finalizedOverride: bigint | undefined;
  let hashSeed = 0;
  const logsByBlock = new Map<number, ScriptedBlockLog[]>();

  function freshHash(): Hex {
    hashSeed += 1;
    return `0x${hashSeed.toString(16).padStart(64, '0')}` as Hex;
  }
  function mine(count: number): void {
    for (let index = 0; index < count; index += 1) blocks.push(freshHash());
  }
  mine(1); // genesis (block 0)

  const publicClient = {
    async getBlock(args: { readonly blockTag?: 'latest' | 'finalized'; readonly blockNumber?: bigint } = {}) {
      if (args.blockNumber !== undefined) {
        const hash = blocks[Number(args.blockNumber)];
        if (hash === undefined) throw new Error(`scripted chain: no block ${args.blockNumber}`);
        return { number: args.blockNumber, hash };
      }
      if (args.blockTag === 'finalized') {
        const number = finalizedOverride ?? BigInt(blocks.length - 1);
        return { number, hash: blocks[Number(number)]! };
      }
      const number = BigInt(blocks.length - 1);
      return { number, hash: blocks[Number(number)]! };
    },
    async getLogs(
      args: { readonly address: readonly Address[]; readonly fromBlock: bigint; readonly toBlock: bigint },
    ) {
      const result: unknown[] = [];
      for (let n = args.fromBlock; n <= args.toBlock; n += 1n) {
        const entries = logsByBlock.get(Number(n)) ?? [];
        for (const entry of entries) {
          if (!args.address.some((a) => a.toLowerCase() === entry.address.toLowerCase())) continue;
          result.push({
            address: entry.address,
            topics: entry.topics,
            data: entry.data,
            blockHash: blocks[Number(n)],
            blockNumber: n,
            transactionHash: entry.transactionHash,
            transactionIndex: 0,
            logIndex: entry.logIndex,
            removed: false,
          });
        }
      }
      return result;
    },
  } as unknown as PublicClient;

  return {
    publicClient,
    mine,
    setFinalized(blockNumber: bigint): void {
      finalizedOverride = blockNumber;
    },
    reorgFrom(blockNumber: bigint): void {
      for (let index = Number(blockNumber); index < blocks.length; index += 1) blocks[index] = freshHash();
    },
    addLog(blockNumber: bigint, log: ScriptedBlockLog): void {
      const key = Number(blockNumber);
      const existing = logsByBlock.get(key) ?? [];
      existing.push(log);
      logsByBlock.set(key, existing);
    },
    latestBlockNumber: () => BigInt(blocks.length - 1),
  };
}

type ScriptedChain = ReturnType<typeof buildScriptedChain>;

// --- Fixtures (inlined: no shared `_projector-fixtures.ts` module is in this task's write
// scope, so both the plan's proposed `taskCreatedLog()` and `fakeDiscoverySigner()` helpers
// live directly in this file). ---

const CREATOR = '0x5555555555555555555555555555555555555555' satisfies Address;
const TASK_ID = 42n;
const MANIFEST_DIGEST = `0x${'9'.repeat(64)}` satisfies Hex;
const TASK_CID_DIGEST = `0x${'a'.repeat(64)}` satisfies Hex;
const TASK_DIGEST = `sha256:${'a'.repeat(64)}` as const;

function taskCreatedLog(): ScriptedBlockLog {
  const topics = encodeEventTopics({
    abi: JINN_ROUTER_V3_ABI,
    eventName: 'TaskCreated',
    args: { creator: CREATOR, taskId: TASK_ID, manifestDigest: MANIFEST_DIGEST },
  });
  const data = encodeAbiParameters(
    [
      { name: 'taskCidDigest', type: 'bytes32' },
      { name: 'maxClaims', type: 'uint32' },
      { name: 'solutionBudget', type: 'uint256' },
      { name: 'verdictBudget', type: 'uint256' },
    ],
    [TASK_CID_DIGEST, 2, 100n, 20n],
  );
  return {
    address: BASE_SEPOLIA_TODAY.jinnRouter,
    topics: topics as readonly Hex[],
    data,
    transactionHash: `0x${'2'.repeat(64)}`,
    logIndex: 0,
  };
}

function fakeDiscoverySigner(): ScopedDiscoverySigner {
  return {
    scope: DISCOVERY_SIGNING_SCOPE,
    async sign() {
      return [{ keyid: 'test-key', sig: new Uint8Array(64) }];
    },
  };
}

function loop(input: {
  chain: ScriptedChain;
  state: VenueStateDatabase;
  store?: Store;
  cursorStore?: ProjectorCursorStore;
  logger?: { info(m: string): void; warn(m: string): void };
  overrides?: Partial<ProjectorLoopConfig>;
}): { readonly projector: ProjectorLoop; readonly cursorStore: ProjectorCursorStore } {
  const store = input.store ?? new Store(':memory:');
  const cursorStore = input.cursorStore ?? new ProjectorCursorStore(store, 'marketplace');
  const pageCounts = new Map<string, number>();
  const logSource = createProjectorLogSource({
    chain: BASE_SEPOLIA_TODAY,
    publicClient: input.chain.publicClient,
    state: input.state,
    mechAddresses: [],
    options: { startBlock: 0n },
  });
  const config: ProjectorLoopConfig = {
    chain: BASE_SEPOLIA_TODAY,
    logSource,
    cursorStore,
    ports: {
      source: { agent: 'urn:jinn:operator:test', name: 'test-operator' },
      signer: fakeDiscoverySigner(),
      archiveRoot: mkdtempSync(join(tmpdir(), 'jinn-archive-')),
      resolveRecord: async () => ({
        kind: RECORD_KINDS.submission,
        bytes: new TextEncoder().encode('{}'),
      }),
      verifyVerdictObservation: async () => ({ gate: { decisionGrade: true, failures: [] } }),
      referencedBytes: { fetch: async () => undefined },
      readPageCount: () => pageCounts.get('test-operator') ?? 0,
      writePageCount: (count: number) => {
        pageCounts.set('test-operator', count);
      },
    },
    enrich: async (event) => ({
      ...event,
      projection: {
        taskCoordinator: BASE_SEPOLIA_TODAY.taskCoordinator,
        timestamp: '2026-07-30T12:00:00Z',
        submission: 'urn:uuid:11111111-1111-4111-8111-111111111111',
        taskDigest: TASK_DIGEST,
        effectiveDeadline: '2026-07-31T12:00:00Z',
        dispatchContext: {
          uri: 'urn:jinn:marketplace:dispatch-context:42:0',
          digest: { sha256: '8'.repeat(64) },
        },
      },
    } as never),
    pollIntervalMs: 5,
    store,
    isAuthorizedMechOrigin: () => false,
    readFinalizedBlockNumber: createFinalizedHeadReader(input.chain.publicClient),
    logger: input.logger,
    ...input.overrides,
  };
  return { projector: new ProjectorLoop(config), cursorStore };
}

let root: string;
let state: VenueStateDatabase;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'projector-loop-'));
  state = openVenueState(join(root, 'venue.db'));
});
afterEach(() => {
  state.close();
  rmSync(root, { recursive: true, force: true });
});

describe('projector loop', () => {
  it('advances the durable cursor after a successful tick', async () => {
    const chain = buildScriptedChain();
    chain.mine(120); // blocks 0..120
    chain.setFinalized(120n);
    chain.addLog(120n, taskCreatedLog());

    const { projector, cursorStore } = loop({ chain, state });
    const result = await projector.tick();

    expect(result.caughtUp).toBe(true);
    expect(result.announcements).toBe(1);
    expect(cursorStore.read()!.finalizedBlockNumber).toBe(120n);
  });

  it('reports not caught up while the live finalized head is ahead of the durable cursor', async () => {
    const chain = buildScriptedChain();
    chain.mine(200);
    chain.setFinalized(100n);

    const { projector, cursorStore } = loop({ chain, state });
    expect(await projector.hasCaughtUp()).toBe(false); // no cursor written yet

    cursorStore.write({
      liveBlockNumber: 100n,
      liveBlockHash: `0x${'1'.repeat(64)}`,
      finalizedBlockNumber: 50n,
      finalizedBlockHash: `0x${'1'.repeat(64)}`,
      sequence: '0000000000000000',
      entryDigest: null,
      headJson: null,
      stateJson: '{}',
    });
    expect(await projector.hasCaughtUp()).toBe(false); // cursor (50) behind live finalized (100)

    cursorStore.write({
      liveBlockNumber: 100n,
      liveBlockHash: `0x${'1'.repeat(64)}`,
      finalizedBlockNumber: 100n,
      finalizedBlockHash: `0x${'1'.repeat(64)}`,
      sequence: '0000000000000000',
      entryDigest: null,
      headJson: null,
      stateJson: '{}',
    });
    expect(await projector.hasCaughtUp()).toBe(true); // cursor caught up to live finalized
  });

  it('rolls back to the finalized checkpoint when the live block hash diverges (venue-base reorg detection)', async () => {
    const chain = buildScriptedChain();
    chain.mine(150); // blocks 0..150
    chain.setFinalized(100n);
    chain.addLog(140n, taskCreatedLog());

    const warn = vi.fn();
    const { projector, cursorStore } = loop({ chain, state, logger: { info: vi.fn(), warn } });

    const first = await projector.tick();
    expect(first.announcements).toBe(1);
    expect(cursorStore.read()!.liveBlockNumber).toBe(150n);
    expect(cursorStore.read()!.finalizedBlockNumber).toBe(100n);
    expect(warn).not.toHaveBeenCalled();

    // Mutate the canonical hash at (and above) the live cursor's height -- venue-base's
    // `ChainLogSource.poll()` owns detecting this, not the loop (see projector-loop.ts's design
    // decision comment).
    chain.reorgFrom(150n);

    const second = await projector.tick();
    expect(warn.mock.calls.flat().join('\n')).toContain('reorg');
    expect(cursorStore.read()!.finalizedBlockNumber).toBe(100n);
    expect(cursorStore.read()!.liveBlockNumber).toBe(150n);
    expect(second.caughtUp).toBe(true);
  });

  it('never emits an announcement for an event below the finality policy threshold', async () => {
    const chain = buildScriptedChain();
    chain.mine(120);
    chain.setFinalized(90n); // block 120 is above the finalized head -> tier "safe"
    chain.addLog(120n, taskCreatedLog());

    const { projector } = loop({ chain, state, overrides: { announceAt: 'finalized' } });
    const result = await projector.tick();
    expect(result.announcements).toBe(0);
  });
});

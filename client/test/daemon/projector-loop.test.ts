import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex, type PublicClient } from 'viem';
import { BASE_SEPOLIA_TODAY, JINN_ROUTER_V3_ABI } from '@jinn-network/marketplace-binding';
import { archivePagePath, DISCOVERY_SIGNING_SCOPE } from '@jinn-network/record-discovery-protocol';
import type { ScopedDiscoverySigner } from '@jinn-network/marketplace-projector';
import { RECORD_KINDS } from '@jinn-network/record-discovery-protocol';
import { openVenueState, type VenueStateDatabase } from '@jinn-network/marketplace-venue-base';
import { Store } from '../../src/store/store.js';
import { NativeAnnouncementRecordError } from '../../src/daemon/composition-root.js';
import { ProjectorCursorStore } from '../../src/daemon/projector-cursor.js';
import { ProjectorLoop, type ProjectorLoopConfig } from '../../src/daemon/projector-loop.js';
import {
  createCanonicalBlockHashReader,
  createFinalizedHeadReader,
  createProjectorLogSource,
} from '../../src/daemon/projector-log-source.js';

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
    clearLogsFrom(blockNumber: bigint): void {
      for (const key of logsByBlock.keys()) {
        if (key >= Number(blockNumber)) logsByBlock.delete(key);
      }
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

function taskCreatedLog(input: {
  readonly taskId?: bigint;
  readonly transactionHash?: Hex;
  readonly logIndex?: number;
} = {}): ScriptedBlockLog {
  const taskId = input.taskId ?? TASK_ID;
  const topics = encodeEventTopics({
    abi: JINN_ROUTER_V3_ABI,
    eventName: 'TaskCreated',
    args: { creator: CREATOR, taskId, manifestDigest: MANIFEST_DIGEST },
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
    transactionHash: input.transactionHash ?? `0x${'2'.repeat(64)}`,
    logIndex: input.logIndex ?? 0,
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
  archiveRoot?: string;
  logger?: { info(m: string): void; warn(m: string): void };
  resolveRecord?: ProjectorLoopConfig['ports']['resolveRecord'];
  signer?: ProjectorLoopConfig['ports']['signer'];
  overrides?: Partial<ProjectorLoopConfig>;
}): {
  readonly projector: ProjectorLoop;
  readonly cursorStore: ProjectorCursorStore;
  readonly archiveRoot: string;
} {
  const store = input.store ?? new Store(':memory:');
  const cursorStore = input.cursorStore ?? new ProjectorCursorStore(store, 'marketplace');
  const pageCounts = new Map<string, number>();
  const archiveRoot = input.archiveRoot ?? mkdtempSync(join(tmpdir(), 'jinn-archive-'));
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
      signer: input.signer ?? fakeDiscoverySigner(),
      archiveRoot,
      resolveRecord: input.resolveRecord ?? (async () => ({
        kind: RECORD_KINDS.submission,
        bytes: new TextEncoder().encode('{}'),
      })),
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
    readCanonicalBlockHash: createCanonicalBlockHashReader(input.chain.publicClient),
    logger: input.logger,
    ...input.overrides,
  };
  return { projector: new ProjectorLoop(config), cursorStore, archiveRoot };
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

  it('rebuilds from the finalized boundary and appends exactly one signed retraction for a single orphaned availability', async () => {
    const chain = buildScriptedChain();
    chain.mine(150);
    chain.setFinalized(100n);
    chain.addLog(140n, taskCreatedLog());
    const oldHash = (await chain.publicClient.getBlock({ blockNumber: 140n })).hash as Hex;
    const { projector, cursorStore, archiveRoot } = loop({ chain, state });

    expect((await projector.tick()).announcements).toBe(1);
    expect(cursorStore.readActiveAvailabilities()).toHaveLength(1);
    expect(cursorStore.read()!.sequence).toBe('0000000000000001');

    chain.reorgFrom(140n);
    const repaired = await projector.tick();

    // One withdrawal for the exact orphaned availability, then one replacement availability.
    expect(repaired.announcements).toBe(2);
    expect(cursorStore.read()!.sequence).toBe('0000000000000003');
    expect(cursorStore.activeAvailabilitiesForOrphanedBlocks([oldHash])).toEqual([]);
    const active = cursorStore.readActiveAvailabilities();
    expect(active).toHaveLength(1);
    expect(active[0]!.derivation.blockHash).not.toBe(oldHash);
    const correctionPage = JSON.parse(
      readFileSync(`${archiveRoot}${archivePagePath('test-operator', '0000000000000002')}`, 'utf8'),
    ) as { entries: Array<{ entry: { announcements: Array<{ action: string; retracts?: string; reason?: string }> } }> };
    const corrections = correctionPage.entries.flatMap((entry) => entry.entry.announcements);
    expect(corrections).toHaveLength(1);
    expect(corrections[0]).toMatchObject({ action: 'withdrawn', reason: 'reorged' });

    // The chain source no longer reports a fresh reorg on a repeat poll; neither the correction
    // nor the replacement may be emitted twice after a restart/retry.
    const restarted = loop({ chain, state, cursorStore });
    expect((await restarted.projector.tick()).announcements).toBe(0);
    expect(cursorStore.read()!.sequence).toBe('0000000000000003');
  });

  it('retracts every active availability in a multi-block displaced suffix, including an empty block', async () => {
    const chain = buildScriptedChain();
    chain.mine(150);
    chain.setFinalized(100n);
    chain.addLog(140n, taskCreatedLog({ taskId: 42n }));
    // Block 142 is deliberately empty. Its old hash is still retained in venue state while the
    // two live availabilities at 140/145 need individual append-only corrections.
    chain.addLog(145n, taskCreatedLog({
      taskId: 43n,
      transactionHash: `0x${'3'.repeat(64)}`,
    }));
    const old = await Promise.all([140n, 145n].map(async (blockNumber) =>
      (await chain.publicClient.getBlock({ blockNumber })).hash as Hex,
    ));
    const { projector, cursorStore } = loop({ chain, state });

    expect((await projector.tick()).announcements).toBe(2);
    chain.reorgFrom(140n);
    const repaired = await projector.tick();

    expect(repaired.announcements).toBe(4);
    expect(cursorStore.read()!.sequence).toBe('0000000000000006');
    expect(cursorStore.activeAvailabilitiesForOrphanedBlocks(old)).toEqual([]);
    const active = cursorStore.readActiveAvailabilities();
    expect(active).toHaveLength(2);
    expect(active.every((announcement) => !old.includes(announcement.derivation.blockHash))).toBe(true);
    const displaced = state.db.prepare(
      'SELECT block_number FROM orphaned_blocks WHERE chain_id = ? ORDER BY block_number ASC',
    ).all(BASE_SEPOLIA_TODAY.chainId) as Array<{ block_number: number }>;
    expect(displaced.map((row) => row.block_number)).toContain(142);
  });

  it('recovers a correction already appended to the archive when the cursor transaction crashes, without appending it twice', async () => {
    const chain = buildScriptedChain();
    chain.mine(150);
    chain.setFinalized(100n);
    chain.addLog(140n, taskCreatedLog());
    const { projector, cursorStore, archiveRoot } = loop({ chain, state });
    await projector.tick();

    // Replacement fork removes the task entirely: this reorg has exactly one required output,
    // the retraction. Crash after its archive/head publication but before `cursorStore.write()`.
    chain.clearLogsFrom(140n);
    chain.reorgFrom(140n);
    const originalWrite = cursorStore.write.bind(cursorStore);
    let failOnce = true;
    (cursorStore as unknown as { write: typeof cursorStore.write }).write = (...args) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('simulated cursor transaction crash');
      }
      originalWrite(...args);
    };
    await expect(projector.tick()).rejects.toThrow('simulated cursor transaction crash');
    (cursorStore as unknown as { write: typeof cursorStore.write }).write = originalWrite;

    const recovered = loop({ chain, state, cursorStore, archiveRoot });
    expect((await recovered.projector.tick()).announcements).toBe(0);
    expect(cursorStore.read()!.sequence).toBe('0000000000000002');
    expect(cursorStore.readActiveAvailabilities()).toEqual([]);
    const correctionPage = JSON.parse(
      readFileSync(`${archiveRoot}${archivePagePath('test-operator', '0000000000000002')}`, 'utf8'),
    ) as { entries: unknown[] };
    expect(correctionPage.entries).toHaveLength(1);
    expect(() => readFileSync(
      `${archiveRoot}${archivePagePath('test-operator', '0000000000000003')}`,
      'utf8',
    )).toThrow();
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

  // Finding E20: `ProjectorLoop.tick()` computed `transition.observations` and discarded it, so
  // `BaseVenueConfig.observations` (venue-base's read of "every observation ever projected") had
  // nothing durable to read from and was stubbed to `async () => []`. Close-out plan §C5.
  it('persists transition.observations durably alongside the cursor on each tick', async () => {
    const chain = buildScriptedChain();
    chain.mine(120);
    chain.setFinalized(120n);
    chain.addLog(120n, taskCreatedLog());

    const { projector, cursorStore } = loop({ chain, state });
    const result = await projector.tick();

    expect(result.announcements).toBe(1);
    const observations = cursorStore.readObservations();
    expect(observations).toHaveLength(1);
    expect(observations[0]!.type).toBe('network.jinn.task-execution.submission-accepted.v1');
    expect(observations[0]!.subject).toBe('urn:uuid:11111111-1111-4111-8111-111111111111');
  });

  it('accumulates observations across ticks in projection order, append-only', async () => {
    const chain = buildScriptedChain();
    chain.mine(120);
    chain.setFinalized(120n);
    chain.addLog(120n, taskCreatedLog());

    const { projector, cursorStore } = loop({ chain, state });
    await projector.tick();
    expect(cursorStore.readObservations()).toHaveLength(1);

    // A tick with no new logs must not touch (let alone clear) what is already durable.
    chain.mine(5);
    chain.setFinalized(125n);
    await projector.tick();
    expect(cursorStore.readObservations()).toHaveLength(1);
  });

  // A `resolveRecord` throw is now scoped per record, so it no longer reaches this catch. Signing
  // is not scoped and never should be — a signer that cannot sign fails the whole publication —
  // so it drives the whole-call path the catch still exists for.
  it('persists observations when announcement publication throws', async () => {
    const chain = buildScriptedChain();
    chain.mine(120);
    chain.setFinalized(120n);
    chain.addLog(120n, taskCreatedLog());

    const warn = vi.fn();
    const { projector, cursorStore } = loop({
      chain,
      state,
      logger: { info: vi.fn(), warn },
      signer: {
        scope: DISCOVERY_SIGNING_SCOPE,
        async sign() {
          throw new Error('discovery signing key is unavailable');
        },
      },
    });

    const result = await projector.tick();

    expect(result.announcements).toBe(0);
    expect(warn.mock.calls.flat().join('\n')).toContain('announcement publication failed');
    expect(cursorStore.readObservations()).toHaveLength(1);
    expect(cursorStore.read()!.liveBlockNumber).toBe(120n);
  });

  // The per-record scoping (`AnnouncementRecordUnresolvedRefusal`) must not cost the tick its other
  // announcements OR the operator its signal. Observations and cursor still advance; the refusal is
  // recorded rather than thrown; and the warn below keeps it loud.
  it('scopes an unresolvable record to itself instead of failing the whole publication', async () => {
    const chain = buildScriptedChain();
    chain.mine(120);
    chain.setFinalized(120n);
    chain.addLog(120n, taskCreatedLog());

    const warn = vi.fn();
    const { projector, cursorStore } = loop({
      chain,
      state,
      logger: { info: vi.fn(), warn },
      resolveRecord: async () => {
        throw new Error('resolveRecord has no production implementation for role "evaluation-delivery"');
      },
    });

    const result = await projector.tick();

    expect(result.announcements).toBe(0);
    expect(result.refusals).toBe(1);
    const logged = warn.mock.calls.flat().join('\n');
    // NOT the whole-tick message: this record failed alone.
    expect(logged).not.toContain('announcement publication failed');
    expect(logged).toContain('announcement record unresolved');
    expect(cursorStore.readObservations()).toHaveLength(1);
    expect(cursorStore.read()!.liveBlockNumber).toBe(120n);
  });

  // Defect #45: the swallow above is correct (observations and the cursor must survive) but it
  // was OPAQUE — an operator saw nothing naming what was refused or what was lost, and because
  // the cursor advances and `hasCanonicalEvent` filters these events out of every later tick, the
  // announcements are gone for good rather than retried.
  it('names the refusal and the announcements it permanently dropped', async () => {
    const chain = buildScriptedChain();
    chain.mine(120);
    chain.setFinalized(120n);
    chain.addLog(120n, taskCreatedLog());

    const warn = vi.fn();
    const digest = `sha256:${'e'.repeat(64)}` as const;
    const { projector } = loop({
      chain,
      state,
      logger: { info: vi.fn(), warn },
      resolveRecord: async () => {
        throw new NativeAnnouncementRecordError(
          'evaluation-delivery',
          "no digest-verified bytes on this operator's serving plane or its configured peers",
          digest,
        );
      },
    });

    await projector.tick();

    const logged = warn.mock.calls.flat().join('\n');
    expect(logged).toContain('NativeAnnouncementRecordError'); // the error NAME, not just its text
    expect(logged).toContain('evaluation-delivery'); // the role
    expect(logged).toContain(digest); // the on-chain anchor
    expect(logged).toContain('serving plane'); // the cause
    // The loss, now stated per record rather than per tick — and still stating that it is
    // permanent, which is the fact an operator has to act on.
    expect(logged).toContain('dropped the "submission" announcement for TaskCreated');
    expect(logged).toContain('120');
    expect(logged).toContain('another rewind');
  });
});

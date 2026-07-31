import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex } from 'viem';
import { BASE_SEPOLIA_TODAY, JINN_ROUTER_V3_ABI } from '@jinn-network/marketplace-binding';
import { DISCOVERY_SIGNING_SCOPE } from '@jinn-network/record-discovery-protocol';
import type { MarketplaceRawLog, ScopedDiscoverySigner } from '@jinn-network/marketplace-projector';
import { RECORD_KINDS } from '@jinn-network/record-discovery-protocol';
import { Store } from '../../src/store/store.js';
import { ProjectorCursorStore } from '../../src/daemon/projector-cursor.js';
import { ProjectorLoop, type ProjectorLoopConfig } from '../../src/daemon/projector-loop.js';

// --- Fixtures (inlined: no shared `_projector-fixtures.ts` module is in this task's write
// scope, so both the plan's proposed `taskCreatedLog()` and `fakeDiscoverySigner()` helpers
// live directly in this file). ---

const CREATOR = '0x5555555555555555555555555555555555555555' satisfies Address;
const TASK_ID = 42n;
const MANIFEST_DIGEST = `0x${'9'.repeat(64)}` satisfies Hex;
const TASK_CID_DIGEST = `0x${'a'.repeat(64)}` satisfies Hex;
const TASK_DIGEST = `sha256:${'a'.repeat(64)}` as const;

function taskCreatedLog(overrides: { finalityTier?: 'safe' | 'finalized' } = {}): MarketplaceRawLog {
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
    chainId: BASE_SEPOLIA_TODAY.chainId,
    address: BASE_SEPOLIA_TODAY.jinnRouter,
    topics: topics as readonly Hex[],
    data,
    blockNumber: 120n,
    blockHash: `0x${'1'.repeat(64)}`,
    transactionHash: `0x${'2'.repeat(64)}`,
    logIndex: 0,
    finalityTier: overrides.finalityTier ?? 'safe',
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

function loop(overrides: Partial<ProjectorLoopConfig> = {}): ProjectorLoop {
  const store = new Store(':memory:');
  const pageCounts = new Map<string, number>();
  const config: ProjectorLoopConfig = {
    chain: BASE_SEPOLIA_TODAY,
    logSource: {
      fetchLogs: async () => [taskCreatedLog()],
      heads: async () => ({
        latest: { number: 120n, hash: `0x${'1'.repeat(64)}` },
        finalized: { number: 120n, hash: `0x${'1'.repeat(64)}` },
      }),
    },
    cursorStore: new ProjectorCursorStore(store, 'marketplace'),
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
    ...overrides,
  };
  return new ProjectorLoop(config);
}

describe('projector loop', () => {
  it('advances the durable cursor after a successful tick', async () => {
    const store = new Store(':memory:');
    const cursorStore = new ProjectorCursorStore(store, 'marketplace');
    const projector = loop({ store, cursorStore });
    const result = await projector.tick();
    expect(result.caughtUp).toBe(true);
    expect(result.announcements).toBe(1);
    expect(cursorStore.read()!.finalizedBlockNumber).toBe(120n);
  });

  it('reports not-caught-up while the finalized head is ahead of the cursor', async () => {
    const projector = loop({
      logSource: {
        fetchLogs: async () => [],
        heads: async () => ({
          latest: { number: 5_000n, hash: `0x${'1'.repeat(64)}` },
          finalized: { number: 4_900n, hash: `0x${'2'.repeat(64)}` },
        }),
      },
    });
    expect(await projector.hasCaughtUp()).toBe(false);
  });

  it('rolls back to the finalized checkpoint when the live block hash diverges', async () => {
    const store = new Store(':memory:');
    const cursorStore = new ProjectorCursorStore(store, 'marketplace');
    cursorStore.write({
      liveBlockNumber: 120n,
      liveBlockHash: `0x${'9'.repeat(64)}`,
      finalizedBlockNumber: 100n,
      finalizedBlockHash: `0x${'2'.repeat(64)}`,
      sequence: '0000000000000001',
      entryDigest: `sha256:${'a'.repeat(64)}`,
      headJson: null,
      // A pre-existing cursor row's persisted state — a real empty projection state, not a bare
      // `{}` (the plan's literal fixture): the reducer's `cloneMarketplaceProjectionState` reads
      // fixed fields (`processedLogIds`, `tasks`, ...) unconditionally, so a bare `{}` here would
      // throw before the reorg-warning assertion below is ever reached.
      stateJson: JSON.stringify({
        processedLogIds: [],
        processedCorrectionIds: [],
        sequenceBySourceSubject: {},
        tasks: {},
        pendingMechDeliveries: {},
        requestIdBindings: {},
        evaluationIdentities: {},
        attemptEngagements: {},
        evaluationEngagements: {},
      }),
    });
    const warn = vi.fn();
    const projector = loop({ store, cursorStore, logger: { info: vi.fn(), warn } });
    await projector.tick();
    expect(warn.mock.calls.flat().join('\n')).toContain('reorg');
    expect(cursorStore.read()!.liveBlockNumber).toBeGreaterThanOrEqual(100n);
  });

  it('never emits an announcement for an event below the finality policy threshold', async () => {
    const projector = loop({
      logSource: {
        fetchLogs: async () => [taskCreatedLog({ finalityTier: 'safe' })],
        heads: async () => ({
          latest: { number: 120n, hash: `0x${'1'.repeat(64)}` },
          finalized: { number: 90n, hash: `0x${'2'.repeat(64)}` },
        }),
      },
      announceAt: 'finalized',
    });
    const result = await projector.tick();
    expect(result.announcements).toBe(0);
  });
});

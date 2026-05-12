/**
 * Tests for OnchainDiscoveryAPI — the always-live floor implementation of DiscoveryAPI.
 *
 * Uses viem mock PublicClient injection to avoid hitting real RPCs.
 *
 * Coverage:
 * - queryEnvelopes delegates to runOnchainCorpusQuery
 * - listLaunchedSolverNets with no args returns fold of mocked MetadataSet events
 * - listLaunchedSolverNets filters by status correctly
 * - getLifecycleStatus returns undefined for unknown manifestCid
 * - findClaimableTasks with one matching task: TaskCreated → canClaimTask ok → returns candidate
 * - findClaimableTasks with canClaimTask rejecting a candidate: filtered out
 * - findClaimableTasks with multiple TaskAttemptCreated events: attempt counts computed
 * - findClaimableTasks respects pageSize and maxPages bounds
 * - RPC failure → throws DiscoveryUnavailableError
 * - cursorCache.write called with current head after successful scan
 * - cursorCache.read used to advance start block
 */

import { describe, it, expect, vi } from 'vitest';
import {
  encodeAbiParameters,
  encodeEventTopics,
  type Hex,
  type Log,
} from 'viem';
import { createOnchainDiscoveryAPI, limitedConcurrency, type OnchainCursorCache } from '../../src/discovery/onchain.js';
import { DiscoveryUnavailableError } from '../../src/discovery/types.js';
import { manifestDigestForCid } from '../../src/adapters/mech/digest.js';

// ── Constants ────────────────────────────────────────────────────────────────

const CHAIN_ID = 8453;
const ROUTER = '0xfFa7118A3D820cd4E820010837D65FAfF463181B' as `0x${string}`;
const IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' as `0x${string}`;
const SAFE_ADDRESS = `0x${'aa'.repeat(20)}` as `0x${string}`;
const MECH_ADDRESS = `0x${'bb'.repeat(20)}` as `0x${string}`;
const OPERATOR_ADDRESS = SAFE_ADDRESS;
const CURRENT_BLOCK = 9_999n;

const MANIFEST_CID = 'bafyTestManifest';
const MANIFEST_DIGEST = manifestDigestForCid(MANIFEST_CID);

// ── ABIs for encoding test data ──────────────────────────────────────────────

const TASK_CREATED_ABI = [
  {
    type: 'event',
    name: 'TaskCreated',
    inputs: [
      { name: 'creator', type: 'address', indexed: true },
      { name: 'taskId', type: 'uint256', indexed: true },
      { name: 'manifestDigest', type: 'bytes32', indexed: true },
      { name: 'taskCidDigest', type: 'bytes32', indexed: false },
      { name: 'maxClaims', type: 'uint16', indexed: false },
      { name: 'requiredVerdicts', type: 'uint16', indexed: false },
      { name: 'solutionBudget', type: 'uint256', indexed: false },
      { name: 'verdictBudget', type: 'uint256', indexed: false },
    ],
  },
] as const;

const TASK_ATTEMPT_CREATED_ABI = [
  {
    type: 'event',
    name: 'TaskAttemptCreated',
    inputs: [
      { name: 'taskId', type: 'uint256', indexed: true },
      { name: 'attemptIndex', type: 'uint32', indexed: true },
      { name: 'requestId', type: 'bytes32', indexed: true },
      { name: 'operator', type: 'address', indexed: false },
      { name: 'priorityMech', type: 'address', indexed: false },
      { name: 'deliveryRate', type: 'uint256', indexed: false },
    ],
  },
] as const;

const METADATA_ABI = [
  {
    type: 'event',
    name: 'MetadataSet',
    inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'indexedMetadataKey', type: 'string', indexed: true },
      { name: 'metadataKey', type: 'string', indexed: false },
      { name: 'metadataValue', type: 'bytes', indexed: false },
    ],
  },
] as const;

// ── Log builders ──────────────────────────────────────────────────────────────

/** Build a minimal TaskCreated Log using encodeEventTopics + encodeAbiParameters. */
function buildTaskCreatedLog(
  taskId: bigint,
  manifestDigest: Hex,
  taskCidDigest: Hex,
  maxClaims: number,
  blockNumber: bigint,
  txHash?: Hex,
): Log {
  const creator = `0x${'cc'.repeat(20)}` as `0x${string}`;
  const topics = encodeEventTopics({
    abi: TASK_CREATED_ABI,
    eventName: 'TaskCreated',
    args: { creator, taskId, manifestDigest },
  });
  const data = encodeAbiParameters(
    [
      { name: 'taskCidDigest', type: 'bytes32' },
      { name: 'maxClaims', type: 'uint16' },
      { name: 'requiredVerdicts', type: 'uint16' },
      { name: 'solutionBudget', type: 'uint256' },
      { name: 'verdictBudget', type: 'uint256' },
    ],
    [taskCidDigest, maxClaims, 1, 1000n, 500n],
  );
  return {
    address: ROUTER,
    data,
    topics,
    blockNumber,
    blockHash: `0x${'00'.repeat(32)}` as Hex,
    transactionHash: txHash ?? `0x${'11'.repeat(32)}` as Hex,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  } as unknown as Log;
}

/** Build a minimal TaskAttemptCreated Log. */
function buildTaskAttemptCreatedLog(
  taskId: bigint,
  attemptIndex: number,
  requestId: Hex,
  operator: `0x${string}`,
  blockNumber: bigint,
): Log {
  const topics = encodeEventTopics({
    abi: TASK_ATTEMPT_CREATED_ABI,
    eventName: 'TaskAttemptCreated',
    args: { taskId, attemptIndex, requestId },
  });
  const data = encodeAbiParameters(
    [
      { name: 'operator', type: 'address' },
      { name: 'priorityMech', type: 'address' },
      { name: 'deliveryRate', type: 'uint256' },
    ],
    [operator, MECH_ADDRESS, 99n],
  );
  return {
    address: ROUTER,
    data,
    topics,
    blockNumber,
    blockHash: `0x${'00'.repeat(32)}` as Hex,
    transactionHash: `0x${'22'.repeat(32)}` as Hex,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  } as unknown as Log;
}

/** Build a MetadataSet log for a solvernet-manifest key with a lifecycle payload. */
function buildSolvernetMetadataLog(
  agentId: bigint,
  manifestCid: string,
  status: 'launched' | 'paused' | 'retired',
  blockNumber: bigint,
  transactionIndex = 0,
): Log {
  const metadataKey = `solvernet-manifest:${manifestCid}`;
  const payload = JSON.stringify({
    schemaVersion: 'solvernet.lifecycle.v1',
    status,
    at: '2026-05-11T00:00:00Z',
    hash: `0x${'ab'.repeat(32)}` as Hex,
  });
  const valueBytes = new TextEncoder().encode(payload);
  const valueHex = ('0x' + Buffer.from(valueBytes).toString('hex')) as Hex;

  const topics = encodeEventTopics({
    abi: METADATA_ABI,
    eventName: 'MetadataSet',
    args: { agentId, indexedMetadataKey: metadataKey },
  });
  const data = encodeAbiParameters(
    [
      { name: 'metadataKey', type: 'string' },
      { name: 'metadataValue', type: 'bytes' },
    ],
    [metadataKey, valueHex],
  );

  return {
    address: IDENTITY_REGISTRY,
    data,
    topics,
    blockNumber,
    blockHash: `0x${'00'.repeat(32)}` as Hex,
    transactionHash: `0x${'33'.repeat(32)}` as Hex,
    transactionIndex,
    logIndex: 0,
    removed: false,
  } as unknown as Log;
}

// ── Mock client builder ───────────────────────────────────────────────────────

/** Build a mock PublicClient with a queue of log batches per getLogs call. */
function buildMockClient(logsByCall: Log[][]): {
  getBlockNumber: ReturnType<typeof vi.fn>;
  getLogs: ReturnType<typeof vi.fn>;
  simulateContract: ReturnType<typeof vi.fn>;
} {
  let callIndex = 0;
  return {
    getBlockNumber: vi.fn(async () => CURRENT_BLOCK),
    getLogs: vi.fn(async () => {
      const batch = logsByCall[callIndex] ?? [];
      callIndex++;
      return batch;
    }),
    simulateContract: vi.fn(async () => {
      // Default: simulate success (canClaimTask passes)
      return { result: undefined };
    }),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('OnchainDiscoveryAPI — queryEnvelopes', () => {
  it('delegates to runOnchainCorpusQuery and returns envelope refs', async () => {
    // The simplest path: no logs found, returns empty array
    const mockClient = buildMockClient([[]]);
    const api = createOnchainDiscoveryAPI({
      chainId: CHAIN_ID,
      taskDiscoveryFromBlock: 0,
      publicClient: mockClient as never,
    });

    const result = await api.queryEnvelopes({ solverType: 'prediction.v0' });
    expect(Array.isArray(result)).toBe(true);
    // getLogs was called (delegated to runOnchainCorpusQuery)
    expect(mockClient.getLogs).toHaveBeenCalled();
  });
});

describe('OnchainDiscoveryAPI — listLaunchedSolverNets', () => {
  it('returns resolved lifecycle rows from MetadataSet events', async () => {
    const log = buildSolvernetMetadataLog(42n, MANIFEST_CID, 'launched', 5_000n);
    const mockClient = buildMockClient([[log]]);

    const api = createOnchainDiscoveryAPI({
      chainId: CHAIN_ID,
      identityRegistryAddress: IDENTITY_REGISTRY,
      taskDiscoveryFromBlock: 0,
      publicClient: mockClient as never,
    });

    const result = await api.listLaunchedSolverNets();
    expect(result).toHaveLength(1);
    expect(result[0].manifestCid).toBe(MANIFEST_CID);
    expect(result[0].status).toBe('launched');
    expect(result[0].launcherAgentId).toBe('42');
  });

  it('returns empty array when no MetadataSet events found', async () => {
    const mockClient = buildMockClient([[]]); // no logs
    const api = createOnchainDiscoveryAPI({
      chainId: CHAIN_ID,
      identityRegistryAddress: IDENTITY_REGISTRY,
      taskDiscoveryFromBlock: 0,
      publicClient: mockClient as never,
    });

    const result = await api.listLaunchedSolverNets();
    expect(result).toHaveLength(0);
  });

  it('filters by status=launched, excluding paused', async () => {
    const log1 = buildSolvernetMetadataLog(1n, 'cid-launched', 'launched', 5_000n);
    const log2 = buildSolvernetMetadataLog(2n, 'cid-paused', 'paused', 5_001n);
    const mockClient = buildMockClient([[log1, log2]]);

    const api = createOnchainDiscoveryAPI({
      chainId: CHAIN_ID,
      identityRegistryAddress: IDENTITY_REGISTRY,
      taskDiscoveryFromBlock: 0,
      publicClient: mockClient as never,
    });

    const result = await api.listLaunchedSolverNets({ status: ['launched'] });
    expect(result).toHaveLength(1);
    expect(result[0].manifestCid).toBe('cid-launched');
    expect(result[0].status).toBe('launched');
  });

  it('filters by launcherAgentId', async () => {
    const log1 = buildSolvernetMetadataLog(10n, 'cid-agent-10', 'launched', 5_000n);
    const log2 = buildSolvernetMetadataLog(20n, 'cid-agent-20', 'launched', 5_001n);
    const mockClient = buildMockClient([[log1, log2]]);

    const api = createOnchainDiscoveryAPI({
      chainId: CHAIN_ID,
      identityRegistryAddress: IDENTITY_REGISTRY,
      taskDiscoveryFromBlock: 0,
      publicClient: mockClient as never,
    });

    const result = await api.listLaunchedSolverNets({ launcherAgentId: '10' });
    expect(result).toHaveLength(1);
    expect(result[0].launcherAgentId).toBe('10');
  });

  it('picks the most recent event per (agentId, cid) tuple (most-recent-wins)', async () => {
    const log1 = buildSolvernetMetadataLog(1n, MANIFEST_CID, 'launched', 5_000n, 0);
    const log2 = buildSolvernetMetadataLog(1n, MANIFEST_CID, 'paused', 5_001n, 0);
    const mockClient = buildMockClient([[log1, log2]]);

    const api = createOnchainDiscoveryAPI({
      chainId: CHAIN_ID,
      identityRegistryAddress: IDENTITY_REGISTRY,
      taskDiscoveryFromBlock: 0,
      publicClient: mockClient as never,
    });

    const result = await api.listLaunchedSolverNets();
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('paused');
  });
});

describe('OnchainDiscoveryAPI — getLifecycleStatus', () => {
  it('returns undefined for an unknown manifestCid', async () => {
    const mockClient = buildMockClient([[]]); // no logs
    const api = createOnchainDiscoveryAPI({
      chainId: CHAIN_ID,
      identityRegistryAddress: IDENTITY_REGISTRY,
      taskDiscoveryFromBlock: 0,
      publicClient: mockClient as never,
    });

    const result = await api.getLifecycleStatus('unknown-cid-xyz');
    expect(result).toBeUndefined();
  });

  it('returns the lifecycle status for a known manifestCid', async () => {
    const log = buildSolvernetMetadataLog(42n, MANIFEST_CID, 'launched', 5_000n);
    const mockClient = buildMockClient([[log]]);

    const api = createOnchainDiscoveryAPI({
      chainId: CHAIN_ID,
      identityRegistryAddress: IDENTITY_REGISTRY,
      taskDiscoveryFromBlock: 0,
      publicClient: mockClient as never,
    });

    const result = await api.getLifecycleStatus(MANIFEST_CID);
    expect(result).toBeDefined();
    expect(result?.status).toBe('launched');
    expect(result?.sourceBlock).toBe(5_000);
    // The buildSolvernetMetadataLog helper embeds hash: `0x${'ab'.repeat(32)}`.
    expect(result?.manifestHash).toBe('0x' + 'ab'.repeat(32));
  });

  it('returns undefined for a different cid even if other events exist', async () => {
    const log = buildSolvernetMetadataLog(42n, 'some-other-cid', 'launched', 5_000n);
    const mockClient = buildMockClient([[log]]);

    const api = createOnchainDiscoveryAPI({
      chainId: CHAIN_ID,
      identityRegistryAddress: IDENTITY_REGISTRY,
      taskDiscoveryFromBlock: 0,
      publicClient: mockClient as never,
    });

    const result = await api.getLifecycleStatus(MANIFEST_CID);
    expect(result).toBeUndefined();
  });
});

describe('OnchainDiscoveryAPI — findClaimableTasks', () => {
  it('returns empty array when no manifest CIDs provided', async () => {
    const mockClient = buildMockClient([]);
    const api = createOnchainDiscoveryAPI({
      chainId: CHAIN_ID,
      routerAddress: ROUTER,
      safeAddress: SAFE_ADDRESS,
      mechAddress: MECH_ADDRESS,
      publicClient: mockClient as never,
    });

    const result = await api.findClaimableTasks({
      solverNetManifestCids: [],
      operatorAddress: OPERATOR_ADDRESS,
    });
    expect(result).toHaveLength(0);
    expect(mockClient.getLogs).not.toHaveBeenCalled();
  });

  it('returns one candidate when TaskCreated matches and canClaimTask passes', async () => {
    const taskId = 1n;
    const taskCidDigest = `0x${'cc'.repeat(32)}` as Hex;
    const txHash = `0x${'11'.repeat(32)}` as Hex;

    const taskLog = buildTaskCreatedLog(taskId, MANIFEST_DIGEST, taskCidDigest, 5, 5_000n, txHash);

    // First getLogs call: TaskCreated events. Second: TaskAttemptCreated events.
    const mockClient = buildMockClient([[taskLog], []]);
    mockClient.simulateContract.mockResolvedValue({ result: undefined }); // canClaimTask passes

    const api = createOnchainDiscoveryAPI({
      chainId: CHAIN_ID,
      routerAddress: ROUTER,
      safeAddress: SAFE_ADDRESS,
      mechAddress: MECH_ADDRESS,
      taskDiscoveryFromBlock: 0,
      publicClient: mockClient as never,
    });

    const result = await api.findClaimableTasks({
      solverNetManifestCids: [MANIFEST_CID],
      operatorAddress: OPERATOR_ADDRESS,
    });

    expect(result).toHaveLength(1);
    expect(result[0].taskId).toBe('1');
    expect(result[0].attemptCount).toBe(0);
    expect(result[0].operatorAttemptCount).toBe(0);
    expect(result[0].createdAtBlock).toBe(5_000);
    expect(result[0].createdAtTx).toBe(txHash);
    expect(result[0].maxClaims).toBe(5);
  });

  it('filters out a candidate when canClaimTask returns ok=false', async () => {
    const taskLog = buildTaskCreatedLog(1n, MANIFEST_DIGEST, `0x${'dd'.repeat(32)}` as Hex, 3, 5_000n);
    const mockClient = buildMockClient([[taskLog], []]);
    // canClaimTask rejects (simulate revert)
    mockClient.simulateContract.mockRejectedValue(new Error('ClaimWindowClosed'));

    const api = createOnchainDiscoveryAPI({
      chainId: CHAIN_ID,
      routerAddress: ROUTER,
      safeAddress: SAFE_ADDRESS,
      mechAddress: MECH_ADDRESS,
      taskDiscoveryFromBlock: 0,
      publicClient: mockClient as never,
    });

    const result = await api.findClaimableTasks({
      solverNetManifestCids: [MANIFEST_CID],
      operatorAddress: OPERATOR_ADDRESS,
    });

    expect(result).toHaveLength(0);
  });

  it('throws DiscoveryUnavailableError when safeAddress is missing', async () => {
    const mockClient = buildMockClient([]);
    const api = createOnchainDiscoveryAPI({
      chainId: CHAIN_ID,
      routerAddress: ROUTER,
      mechAddress: MECH_ADDRESS,
      // No safeAddress
      taskDiscoveryFromBlock: 0,
      publicClient: mockClient as never,
    });

    await expect(
      api.findClaimableTasks({
        solverNetManifestCids: [MANIFEST_CID],
        operatorAddress: OPERATOR_ADDRESS,
      }),
    ).rejects.toThrow(DiscoveryUnavailableError);
    expect(mockClient.getLogs).not.toHaveBeenCalled();
  });

  it('throws DiscoveryUnavailableError when mechAddress is missing', async () => {
    const mockClient = buildMockClient([]);
    const api = createOnchainDiscoveryAPI({
      chainId: CHAIN_ID,
      routerAddress: ROUTER,
      safeAddress: SAFE_ADDRESS,
      // No mechAddress
      taskDiscoveryFromBlock: 0,
      publicClient: mockClient as never,
    });

    await expect(
      api.findClaimableTasks({
        solverNetManifestCids: [MANIFEST_CID],
        operatorAddress: OPERATOR_ADDRESS,
      }),
    ).rejects.toThrow(DiscoveryUnavailableError);
    expect(mockClient.getLogs).not.toHaveBeenCalled();
  });

  it('computes attemptCount and operatorAttemptCount from TaskAttemptCreated events', async () => {
    const taskId = 5n;
    const taskLog = buildTaskCreatedLog(taskId, MANIFEST_DIGEST, `0x${'ff'.repeat(32)}` as Hex, 10, 5_000n);

    // Two attempts: one from operator, one from another address
    const attempt1 = buildTaskAttemptCreatedLog(
      taskId, 0, `0x${'a1'.repeat(32)}` as Hex, OPERATOR_ADDRESS, 5_001n,
    );
    const attempt2 = buildTaskAttemptCreatedLog(
      taskId, 1, `0x${'a2'.repeat(32)}` as Hex, `0x${'ff'.repeat(20)}` as `0x${string}`, 5_002n,
    );

    const mockClient = buildMockClient([[taskLog], [attempt1, attempt2]]);
    mockClient.simulateContract.mockResolvedValue({ result: undefined }); // canClaimTask passes

    const api = createOnchainDiscoveryAPI({
      chainId: CHAIN_ID,
      routerAddress: ROUTER,
      safeAddress: SAFE_ADDRESS,
      mechAddress: MECH_ADDRESS,
      taskDiscoveryFromBlock: 0,
      // Force a single getLogs chunk so the mock's call-indexed responses line up
      // regardless of DEFAULT_CHUNK_BLOCKS.
      chunkBlocks: 100_000,
      publicClient: mockClient as never,
    });

    const result = await api.findClaimableTasks({
      solverNetManifestCids: [MANIFEST_CID],
      operatorAddress: OPERATOR_ADDRESS,
    });

    expect(result).toHaveLength(1);
    expect(result[0].taskId).toBe('5');
    expect(result[0].attemptCount).toBe(2);
    expect(result[0].operatorAttemptCount).toBe(1);
  });

  it('respects pageSize and maxPages bounds', async () => {
    // Create 12 tasks
    const taskLogs = Array.from({ length: 12 }, (_, i) =>
      buildTaskCreatedLog(
        BigInt(i + 1),
        MANIFEST_DIGEST,
        `0x${String(i).padStart(64, '0')}` as Hex,
        5,
        BigInt(100 + i),
      ),
    );
    const mockClient = buildMockClient([taskLogs, []]);
    mockClient.simulateContract.mockResolvedValue({ result: undefined }); // canClaimTask passes

    const api = createOnchainDiscoveryAPI({
      chainId: CHAIN_ID,
      routerAddress: ROUTER,
      safeAddress: SAFE_ADDRESS,
      mechAddress: MECH_ADDRESS,
      taskDiscoveryFromBlock: 0,
      publicClient: mockClient as never,
    });

    const result = await api.findClaimableTasks({
      solverNetManifestCids: [MANIFEST_CID],
      operatorAddress: OPERATOR_ADDRESS,
      pageSize: 5,
      maxPages: 2,
    });

    // pageSize * maxPages = 10
    expect(result.length).toBeLessThanOrEqual(10);
  });

  it('caps the canClaimTask fan-out at maxResults even when getLogs returns far more TaskCreated events', async () => {
    // getLogs returns 50 TaskCreated rows in one chunk; maxResults = pageSize(2) * maxPages(2) = 4.
    // Without the pre-fan-out trim, canClaimTask (simulateContract) would run 50 times.
    const taskLogs = Array.from({ length: 50 }, (_, i) =>
      buildTaskCreatedLog(
        BigInt(i + 1),
        MANIFEST_DIGEST,
        `0x${String(i).padStart(64, '0')}` as Hex,
        5,
        BigInt(100 + i),
      ),
    );
    const mockClient = buildMockClient([taskLogs, []]);
    mockClient.simulateContract.mockResolvedValue({ result: undefined }); // canClaimTask passes

    const api = createOnchainDiscoveryAPI({
      chainId: CHAIN_ID,
      routerAddress: ROUTER,
      safeAddress: SAFE_ADDRESS,
      mechAddress: MECH_ADDRESS,
      taskDiscoveryFromBlock: 0,
      publicClient: mockClient as never,
    });

    const result = await api.findClaimableTasks({
      solverNetManifestCids: [MANIFEST_CID],
      operatorAddress: OPERATOR_ADDRESS,
      pageSize: 2,
      maxPages: 2,
    });

    // simulateContract (canClaimTask) invoked at most maxResults (4) times.
    expect(mockClient.simulateContract.mock.calls.length).toBeLessThanOrEqual(4);
    // Returned candidate list is also capped.
    expect(result.length).toBeLessThanOrEqual(4);
  });

  it('throws DiscoveryUnavailableError on getBlockNumber RPC failure', async () => {
    const mockClient = {
      getBlockNumber: vi.fn(async () => { throw new Error('RPC connection refused'); }),
      getLogs: vi.fn(async () => []),
      simulateContract: vi.fn(async () => ({ result: undefined })),
    };

    const api = createOnchainDiscoveryAPI({
      chainId: CHAIN_ID,
      routerAddress: ROUTER,
      safeAddress: SAFE_ADDRESS,
      mechAddress: MECH_ADDRESS,
      publicClient: mockClient as never,
    });

    await expect(
      api.findClaimableTasks({
        solverNetManifestCids: [MANIFEST_CID],
        operatorAddress: OPERATOR_ADDRESS,
      }),
    ).rejects.toThrow(DiscoveryUnavailableError);
  });

  it('throws DiscoveryUnavailableError when getLogs itself fails', async () => {
    const mockClient = {
      getBlockNumber: vi.fn(async () => CURRENT_BLOCK),
      getLogs: vi.fn(async () => { throw new Error('fetch failed: connection reset'); }),
      simulateContract: vi.fn(async () => ({ result: undefined })),
    };

    const api = createOnchainDiscoveryAPI({
      chainId: CHAIN_ID,
      routerAddress: ROUTER,
      safeAddress: SAFE_ADDRESS,
      mechAddress: MECH_ADDRESS,
      // taskDiscoveryFromBlock set so we don't hit DEFAULT that might skip this
      taskDiscoveryFromBlock: 0,
      publicClient: mockClient as never,
    });

    await expect(
      api.findClaimableTasks({
        solverNetManifestCids: [MANIFEST_CID],
        operatorAddress: OPERATOR_ADDRESS,
      }),
    ).rejects.toThrow(DiscoveryUnavailableError);
  });
});

describe('OnchainDiscoveryAPI — cursorCache', () => {
  it('cursorCache.write is called with the current head after a successful task scan', async () => {
    const mockClient = buildMockClient([[], []]);
    mockClient.simulateContract.mockResolvedValue({ result: undefined });
    const cache: OnchainCursorCache = {
      read: vi.fn(() => null),
      write: vi.fn(),
    };

    const api = createOnchainDiscoveryAPI({
      chainId: CHAIN_ID,
      routerAddress: ROUTER,
      safeAddress: SAFE_ADDRESS,
      mechAddress: MECH_ADDRESS,
      taskDiscoveryFromBlock: 0,
      publicClient: mockClient as never,
      cursorCache: cache,
    });

    await api.findClaimableTasks({
      solverNetManifestCids: [MANIFEST_CID],
      operatorAddress: OPERATOR_ADDRESS,
    });

    expect(cache.write).toHaveBeenCalledWith('tasks', CURRENT_BLOCK);
  });

  it('cursorCache.read is used as the start block when available', async () => {
    const CACHED_BLOCK = 5_000n;
    const cache: OnchainCursorCache = {
      read: vi.fn(() => CACHED_BLOCK),
      write: vi.fn(),
    };

    const mockClient = buildMockClient([[], []]);
    mockClient.simulateContract.mockResolvedValue({ result: undefined });

    const api = createOnchainDiscoveryAPI({
      chainId: CHAIN_ID,
      routerAddress: ROUTER,
      safeAddress: SAFE_ADDRESS,
      mechAddress: MECH_ADDRESS,
      // Single chunk so [CACHED_BLOCK, head] is one getLogs call → its fromBlock
      // is exactly CACHED_BLOCK, independent of DEFAULT_CHUNK_BLOCKS.
      chunkBlocks: 100_000,
      publicClient: mockClient as never,
      cursorCache: cache,
    });

    await api.findClaimableTasks({
      solverNetManifestCids: [MANIFEST_CID],
      operatorAddress: OPERATOR_ADDRESS,
    });

    expect(cache.read).toHaveBeenCalledWith('tasks');

    // The getLogs call should start from CACHED_BLOCK (5_000n), not from the default start block
    const getLogsCall = mockClient.getLogs.mock.calls[0][0];
    expect(getLogsCall.fromBlock).toBe(CACHED_BLOCK);
  });

  it('cursorCache.write is called with current head for solvernets scan', async () => {
    const mockClient = buildMockClient([[]]); // one getLogs call for MetadataSet
    const cache: OnchainCursorCache = {
      read: vi.fn(() => null),
      write: vi.fn(),
    };

    const api = createOnchainDiscoveryAPI({
      chainId: CHAIN_ID,
      identityRegistryAddress: IDENTITY_REGISTRY,
      taskDiscoveryFromBlock: 0,
      publicClient: mockClient as never,
      cursorCache: cache,
    });

    await api.listLaunchedSolverNets();
    expect(cache.write).toHaveBeenCalledWith('solvernets', CURRENT_BLOCK);
  });

  it('cursorCache.write is called with current head after getLifecycleStatus scan', async () => {
    const mockClient = buildMockClient([[]]); // one getLogs call for MetadataSet
    const cache: OnchainCursorCache = {
      read: vi.fn(() => null),
      write: vi.fn(),
    };

    const api = createOnchainDiscoveryAPI({
      chainId: CHAIN_ID,
      identityRegistryAddress: IDENTITY_REGISTRY,
      taskDiscoveryFromBlock: 0,
      publicClient: mockClient as never,
      cursorCache: cache,
    });

    await api.getLifecycleStatus('unknown-cid');
    expect(cache.write).toHaveBeenCalledWith('solvernets', CURRENT_BLOCK);
  });
});

describe('limitedConcurrency — partial-failure resilience', () => {
  it('continues processing and returns results from non-throwing tasks when one task throws', async () => {
    const tasks = [
      async () => 1,
      async () => 2,
      async (): Promise<number> => { throw new Error('task 3 failed'); },
      async () => 4,
      async () => 5,
    ];

    const results = await limitedConcurrency(tasks, 3);

    // The throwing task's slot is skipped; 4 results are returned
    expect(results).toHaveLength(4);
    expect(results).toContain(1);
    expect(results).toContain(2);
    expect(results).toContain(4);
    expect(results).toContain(5);
    expect(results).not.toContain(3);
  });
});

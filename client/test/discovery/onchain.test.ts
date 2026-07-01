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
      { name: 'maxClaims', type: 'uint32', indexed: false },
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
      { name: 'maxClaims', type: 'uint32' },
      { name: 'solutionBudget', type: 'uint256' },
      { name: 'verdictBudget', type: 'uint256' },
    ],
    [taskCidDigest, maxClaims, 1000n, 500n],
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

// ── Plug-in publication ABI tuples + log builders (gh#290) ────────────────────

const PLUGIN_PAYLOAD_TUPLE = [
  { name: 'version', type: 'uint8' },
  { name: 'pluginName', type: 'string' },
  { name: 'pluginVersion', type: 'string' },
  { name: 'pluginSha256', type: 'bytes32' },
  { name: 'supports', type: 'string[]' },
  { name: 'publishedAt', type: 'uint64' },
] as const;

const REVOCATION_PAYLOAD_TUPLE = [
  { name: 'version', type: 'uint8' },
  { name: 'revoked', type: 'bool' },
  { name: 'reason', type: 'string' },
] as const;

/** Build a MetadataSet log for a `plugin:<cid>` v1 publish payload. */
function buildPluginPublishLog(args: {
  agentId: bigint;
  pluginCid: string;
  pluginName: string;
  pluginVersion: string;
  pluginSha256: Hex;
  supports: string[];
  publishedAt: bigint;
  blockNumber: bigint;
  transactionIndex?: number;
  logIndex?: number;
}): Log {
  const metadataKey = `plugin:${args.pluginCid}`;
  const valueHex = encodeAbiParameters(PLUGIN_PAYLOAD_TUPLE, [
    1,
    args.pluginName,
    args.pluginVersion,
    args.pluginSha256,
    args.supports,
    args.publishedAt,
  ]);
  const topics = encodeEventTopics({
    abi: METADATA_ABI,
    eventName: 'MetadataSet',
    args: { agentId: args.agentId, indexedMetadataKey: metadataKey },
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
    blockNumber: args.blockNumber,
    blockHash: `0x${'00'.repeat(32)}` as Hex,
    transactionHash: `0x${'44'.repeat(32)}` as Hex,
    transactionIndex: args.transactionIndex ?? 0,
    logIndex: args.logIndex ?? 0,
    removed: false,
  } as unknown as Log;
}

/** Build a MetadataSet log for a `plugin:<cid>` v2 revocation payload. */
function buildPluginRevokeLog(args: {
  agentId: bigint;
  pluginCid: string;
  reason: string;
  blockNumber: bigint;
  transactionIndex?: number;
  logIndex?: number;
}): Log {
  const metadataKey = `plugin:${args.pluginCid}`;
  const valueHex = encodeAbiParameters(REVOCATION_PAYLOAD_TUPLE, [2, true, args.reason]);
  const topics = encodeEventTopics({
    abi: METADATA_ABI,
    eventName: 'MetadataSet',
    args: { agentId: args.agentId, indexedMetadataKey: metadataKey },
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
    blockNumber: args.blockNumber,
    blockHash: `0x${'00'.repeat(32)}` as Hex,
    transactionHash: `0x${'55'.repeat(32)}` as Hex,
    transactionIndex: args.transactionIndex ?? 0,
    logIndex: args.logIndex ?? 0,
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

describe('OnchainDiscoveryAPI — MetadataSet scan retry (#546)', () => {
  it('retries getBlockNumber on transient failure before succeeding', async () => {
    vi.useFakeTimers();
    const log = buildSolvernetMetadataLog(42n, MANIFEST_CID, 'launched', 5_000n);
    let blockCalls = 0;
    const mockClient = {
      getBlockNumber: vi.fn(async () => {
        blockCalls++;
        if (blockCalls === 1) throw new Error('429 Too Many Requests');
        return CURRENT_BLOCK;
      }),
      getLogs: vi.fn(async () => [log]),
      simulateContract: vi.fn(async () => ({ result: undefined })),
    };

    const api = createOnchainDiscoveryAPI({
      chainId: CHAIN_ID,
      identityRegistryAddress: IDENTITY_REGISTRY,
      taskDiscoveryFromBlock: 0,
      publicClient: mockClient as never,
    });

    const resultPromise = api.listLaunchedSolverNets();
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toHaveLength(1);
    expect(mockClient.getBlockNumber).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('retries MetadataSet getLogs on transient failure before succeeding', async () => {
    vi.useFakeTimers();
    const log = buildSolvernetMetadataLog(42n, MANIFEST_CID, 'launched', 5_000n);
    let logsCalls = 0;
    const mockClient = {
      getBlockNumber: vi.fn(async () => CURRENT_BLOCK),
      getLogs: vi.fn(async () => {
        logsCalls++;
        if (logsCalls === 1) throw new Error('fetch failed: connection reset');
        return [log];
      }),
      simulateContract: vi.fn(async () => ({ result: undefined })),
    };

    const api = createOnchainDiscoveryAPI({
      chainId: CHAIN_ID,
      identityRegistryAddress: IDENTITY_REGISTRY,
      // Single getLogs chunk so retry count is observable.
      taskDiscoveryFromBlock: CURRENT_BLOCK - 1n,
      publicClient: mockClient as never,
    });

    const resultPromise = api.listLaunchedSolverNets();
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toHaveLength(1);
    expect(mockClient.getLogs).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('does not retry findClaimableTasks getLogs on transient failure', async () => {
    const mockClient = {
      getBlockNumber: vi.fn(async () => CURRENT_BLOCK),
      getLogs: vi.fn(async () => {
        throw new Error('429 Too Many Requests');
      }),
      simulateContract: vi.fn(async () => ({ result: undefined })),
    };

    const api = createOnchainDiscoveryAPI({
      chainId: CHAIN_ID,
      routerAddress: ROUTER,
      safeAddress: SAFE_ADDRESS,
      mechAddress: MECH_ADDRESS,
      taskDiscoveryFromBlock: 0,
      publicClient: mockClient as never,
    });

    await expect(
      api.findClaimableTasks({
        solverNetManifestCids: [MANIFEST_CID],
        operatorAddress: OPERATOR_ADDRESS,
      }),
    ).rejects.toThrow(DiscoveryUnavailableError);
    expect(mockClient.getLogs).toHaveBeenCalledTimes(1);
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

  it('preserves an `rpc_rate_limited` code when the RPC returns a 429', async () => {
    // jinn-mono #325: a throttled shared RPC must be classifiable end-to-end so
    // the operator UI can render an actionable "add your own key" message
    // rather than a generic "catalog not found".
    const mockClient = {
      getBlockNumber: vi.fn(async () => { throw new Error('HTTP 429: Too Many Requests'); }),
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

    let caught: unknown;
    try {
      await api.findClaimableTasks({
        solverNetManifestCids: [MANIFEST_CID],
        operatorAddress: OPERATOR_ADDRESS,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DiscoveryUnavailableError);
    expect((caught as DiscoveryUnavailableError).code).toBe('rpc_rate_limited');
  });

  it('leaves `code` undefined for a non-rate-limit RPC failure', async () => {
    const mockClient = {
      getBlockNumber: vi.fn(async () => { throw new Error('fetch failed: connection reset'); }),
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

    let caught: unknown;
    try {
      await api.findClaimableTasks({
        solverNetManifestCids: [MANIFEST_CID],
        operatorAddress: OPERATOR_ADDRESS,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DiscoveryUnavailableError);
    expect((caught as DiscoveryUnavailableError).code).toBeUndefined();
  });

  it('preserves `rpc_rate_limited` through a getLogs failure on listLaunchedSolverNets', async () => {
    vi.useFakeTimers();
    const mockClient = {
      getBlockNumber: vi.fn(async () => CURRENT_BLOCK),
      getLogs: vi.fn(async () => { throw new Error('the RPC endpoint says: rate limit exceeded'); }),
      simulateContract: vi.fn(async () => ({ result: undefined })),
    };

    const api = createOnchainDiscoveryAPI({
      chainId: CHAIN_ID,
      identityRegistryAddress: IDENTITY_REGISTRY,
      taskDiscoveryFromBlock: CURRENT_BLOCK - 1n,
      publicClient: mockClient as never,
    });

    let caught: unknown;
    const resultPromise = api.listLaunchedSolverNets().catch((err) => {
      caught = err;
    });
    await vi.runAllTimersAsync();
    await resultPromise;
    expect(caught).toBeInstanceOf(DiscoveryUnavailableError);
    expect((caught as DiscoveryUnavailableError).code).toBe('rpc_rate_limited');
    expect(mockClient.getLogs).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
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

describe('OnchainDiscoveryAPI — listPluginPublications (gh#290)', () => {
  const SHA_1 = `0x${'aa'.repeat(32)}` as Hex;
  const SHA_2 = `0x${'bb'.repeat(32)}` as Hex;

  it('decodes a v1 publish MetadataSet log into a PluginPublication row', async () => {
    const log = buildPluginPublishLog({
      agentId: 42n,
      pluginCid: 'bafyPluginOne',
      pluginName: '@builder/swe-skill',
      pluginVersion: '0.1.0',
      pluginSha256: SHA_1,
      supports: ['swe-rebench-v2.v1'],
      publishedAt: 1_715_700_000n,
      blockNumber: 5_000n,
    });
    const mockClient = buildMockClient([[log]]);
    const api = createOnchainDiscoveryAPI({
      chainId: CHAIN_ID,
      identityRegistryAddress: IDENTITY_REGISTRY,
      taskDiscoveryFromBlock: 0,
      publicClient: mockClient as never,
    });

    const rows = await api.listPluginPublications();
    expect(rows).toEqual([
      {
        artifactType: 'plugin',
        builderAgentId: '42',
        cid: 'bafyPluginOne',
        name: '@builder/swe-skill',
        version: '0.1.0',
        supports: ['swe-rebench-v2.v1'],
        publishedAt: 1_715_700_000,
        pluginSha256: SHA_1,
        revoked: false,
      },
    ]);
  });

  it('returns an empty array when no plugin: MetadataSet events are found', async () => {
    const mockClient = buildMockClient([[]]);
    const api = createOnchainDiscoveryAPI({
      chainId: CHAIN_ID,
      identityRegistryAddress: IDENTITY_REGISTRY,
      taskDiscoveryFromBlock: 0,
      publicClient: mockClient as never,
    });
    expect(await api.listPluginPublications()).toEqual([]);
  });

  it('ignores non-plugin MetadataSet keys (solvernet-manifest:)', async () => {
    const solvernetLog = buildSolvernetMetadataLog(7n, 'bafyManifest', 'launched', 4_000n);
    const mockClient = buildMockClient([[solvernetLog]]);
    const api = createOnchainDiscoveryAPI({
      chainId: CHAIN_ID,
      identityRegistryAddress: IDENTITY_REGISTRY,
      taskDiscoveryFromBlock: 0,
      publicClient: mockClient as never,
    });
    expect(await api.listPluginPublications()).toEqual([]);
  });

  it('a v2 revocation flips revoked=true and carries the reason', async () => {
    const publish = buildPluginPublishLog({
      agentId: 42n,
      pluginCid: 'bafyPluginOne',
      pluginName: '@builder/swe-skill',
      pluginVersion: '0.1.0',
      pluginSha256: SHA_1,
      supports: ['swe-rebench-v2.v1'],
      publishedAt: 1_715_700_000n,
      blockNumber: 5_000n,
    });
    const revoke = buildPluginRevokeLog({
      agentId: 42n,
      pluginCid: 'bafyPluginOne',
      reason: 'cve-2026-xxxx',
      blockNumber: 6_000n,
    });
    const mockClient = buildMockClient([[publish, revoke]]);
    const api = createOnchainDiscoveryAPI({
      chainId: CHAIN_ID,
      identityRegistryAddress: IDENTITY_REGISTRY,
      taskDiscoveryFromBlock: 0,
      publicClient: mockClient as never,
    });

    const rows = await api.listPluginPublications();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ revoked: true, revokedReason: 'cve-2026-xxxx' });
  });

  it('excludes revoked rows when includeRevoked is false', async () => {
    const publish = buildPluginPublishLog({
      agentId: 42n,
      pluginCid: 'bafyPluginOne',
      pluginName: '@builder/swe-skill',
      pluginVersion: '0.1.0',
      pluginSha256: SHA_1,
      supports: ['swe-rebench-v2.v1'],
      publishedAt: 1_715_700_000n,
      blockNumber: 5_000n,
    });
    const revoke = buildPluginRevokeLog({
      agentId: 42n,
      pluginCid: 'bafyPluginOne',
      reason: 'mistake',
      blockNumber: 6_000n,
    });
    const mockClient = buildMockClient([[publish, revoke]]);
    const api = createOnchainDiscoveryAPI({
      chainId: CHAIN_ID,
      identityRegistryAddress: IDENTITY_REGISTRY,
      taskDiscoveryFromBlock: 0,
      publicClient: mockClient as never,
    });
    expect(await api.listPluginPublications({ includeRevoked: false })).toEqual([]);
  });

  it('a v1 republish after a revocation un-revokes the row', async () => {
    const publish = buildPluginPublishLog({
      agentId: 42n,
      pluginCid: 'bafyPluginOne',
      pluginName: '@builder/swe-skill',
      pluginVersion: '0.1.0',
      pluginSha256: SHA_1,
      supports: ['swe-rebench-v2.v1'],
      publishedAt: 1_715_700_000n,
      blockNumber: 5_000n,
    });
    const revoke = buildPluginRevokeLog({
      agentId: 42n,
      pluginCid: 'bafyPluginOne',
      reason: 'mistake',
      blockNumber: 6_000n,
    });
    const republish = buildPluginPublishLog({
      agentId: 42n,
      pluginCid: 'bafyPluginOne',
      pluginName: '@builder/swe-skill',
      pluginVersion: '0.2.0',
      pluginSha256: SHA_2,
      supports: ['swe-rebench-v2.v1'],
      publishedAt: 1_715_800_000n,
      blockNumber: 7_000n,
    });
    const mockClient = buildMockClient([[publish, revoke, republish]]);
    const api = createOnchainDiscoveryAPI({
      chainId: CHAIN_ID,
      identityRegistryAddress: IDENTITY_REGISTRY,
      taskDiscoveryFromBlock: 0,
      publicClient: mockClient as never,
    });
    const rows = await api.listPluginPublications();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ revoked: false, version: '0.2.0' });
    expect(rows[0]?.revokedReason).toBeUndefined();
  });

  it('filters by builderAgentId and solverType', async () => {
    const logs = (): Log[] => [
      buildPluginPublishLog({
        agentId: 1n,
        pluginCid: 'bafyA',
        pluginName: '@a/plugin',
        pluginVersion: '1.0.0',
        pluginSha256: SHA_1,
        supports: ['swe-rebench-v2.v1'],
        publishedAt: 100n,
        blockNumber: 1_000n,
      }),
      buildPluginPublishLog({
        agentId: 2n,
        pluginCid: 'bafyB',
        pluginName: '@b/plugin',
        pluginVersion: '1.0.0',
        pluginSha256: SHA_2,
        supports: ['other-type.v1'],
        publishedAt: 200n,
        blockNumber: 2_000n,
      }),
    ];
    const mkApi = () =>
      createOnchainDiscoveryAPI({
        chainId: CHAIN_ID,
        identityRegistryAddress: IDENTITY_REGISTRY,
        taskDiscoveryFromBlock: 0,
        // Fresh mock client per call — buildMockClient's batch queue is consumed.
        publicClient: buildMockClient([logs()]) as never,
      });

    const byBuilder = await mkApi().listPluginPublications({ builderAgentId: '2' });
    expect(byBuilder.map((r) => r.cid)).toEqual(['bafyB']);

    const bySolverType = await mkApi().listPluginPublications({
      solverType: 'swe-rebench-v2.v1',
    });
    expect(bySolverType.map((r) => r.cid)).toEqual(['bafyA']);
  });

  it('ignores garbage payloads on a plugin: key without throwing', async () => {
    // Hand-craft a MetadataSet log with a non-decodable value.
    const metadataKey = 'plugin:bafyGarbage';
    const topics = encodeEventTopics({
      abi: METADATA_ABI,
      eventName: 'MetadataSet',
      args: { agentId: 9n, indexedMetadataKey: metadataKey },
    });
    const data = encodeAbiParameters(
      [
        { name: 'metadataKey', type: 'string' },
        { name: 'metadataValue', type: 'bytes' },
      ],
      [metadataKey, '0xdeadbeef'],
    );
    const garbage = {
      address: IDENTITY_REGISTRY,
      data,
      topics,
      blockNumber: 3_000n,
      blockHash: `0x${'00'.repeat(32)}` as Hex,
      transactionHash: `0x${'66'.repeat(32)}` as Hex,
      transactionIndex: 0,
      logIndex: 0,
      removed: false,
    } as unknown as Log;
    const mockClient = buildMockClient([[garbage]]);
    const api = createOnchainDiscoveryAPI({
      chainId: CHAIN_ID,
      identityRegistryAddress: IDENTITY_REGISTRY,
      taskDiscoveryFromBlock: 0,
      publicClient: mockClient as never,
    });
    expect(await api.listPluginPublications()).toEqual([]);
  });

  it('listBuilderArtifacts delegates to listPluginPublications', async () => {
    const log = buildPluginPublishLog({
      agentId: 42n,
      pluginCid: 'bafyPluginOne',
      pluginName: '@builder/swe-skill',
      pluginVersion: '0.1.0',
      pluginSha256: SHA_1,
      supports: ['swe-rebench-v2.v1'],
      publishedAt: 1_715_700_000n,
      blockNumber: 5_000n,
    });
    const mockClient = buildMockClient([[log]]);
    const api = createOnchainDiscoveryAPI({
      chainId: CHAIN_ID,
      identityRegistryAddress: IDENTITY_REGISTRY,
      taskDiscoveryFromBlock: 0,
      publicClient: mockClient as never,
    });
    const artifacts = await api.listBuilderArtifacts({ builderAgentId: '42' });
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({ artifactType: 'plugin', cid: 'bafyPluginOne' });
  });

  it('throws DiscoveryUnavailableError when getLogs fails', async () => {
    const mockClient = {
      getBlockNumber: vi.fn(async () => CURRENT_BLOCK),
      getLogs: vi.fn(async () => {
        throw new Error('rpc down');
      }),
      simulateContract: vi.fn(),
    };
    const api = createOnchainDiscoveryAPI({
      chainId: CHAIN_ID,
      identityRegistryAddress: IDENTITY_REGISTRY,
      taskDiscoveryFromBlock: 0,
      publicClient: mockClient as never,
    });
    await expect(api.listPluginPublications()).rejects.toBeInstanceOf(DiscoveryUnavailableError);
  });

  it('returns the full catalog on every call even when a cursorCache is injected (no data-loss regression)', async () => {
    // An injected cursorCache must NOT cause the second call to scan only
    // [cachedBlock, head]. `foldPluginPublications` re-folds from scratch, so
    // if the scan window narrowed, every publication before the cursor would
    // vanish from the result. This guards that latent data-loss bug.
    const pluginA = buildPluginPublishLog({
      agentId: 1n,
      pluginCid: 'bafyOldPlugin',
      pluginName: '@a/old',
      pluginVersion: '1.0.0',
      pluginSha256: SHA_1,
      supports: ['swe-rebench-v2.v1'],
      publishedAt: 100n,
      blockNumber: 1_000n,
    });
    const pluginB = buildPluginPublishLog({
      agentId: 2n,
      pluginCid: 'bafyNewPlugin',
      pluginName: '@b/new',
      pluginVersion: '1.0.0',
      pluginSha256: SHA_2,
      supports: ['swe-rebench-v2.v1'],
      publishedAt: 200n,
      blockNumber: 8_000n,
    });

    // A cursorCache whose `read` advances to near-head after the first scan —
    // mimicking the behaviour that previously broke the floor.
    let cached: bigint | null = null;
    const cache: OnchainCursorCache = {
      read: vi.fn((label: string) => (label === 'plugins' ? cached : null)),
      write: vi.fn((label: string, block: bigint) => {
        if (label === 'plugins') cached = block;
      }),
    };

    // Each call gets a fresh single-batch mock returning BOTH plugins. If the
    // floor honoured the cursor, the second call's getLogs `fromBlock` would
    // jump past block 1_000 — but the floor must always scan from the default.
    const mkApi = () =>
      createOnchainDiscoveryAPI({
        chainId: CHAIN_ID,
        identityRegistryAddress: IDENTITY_REGISTRY,
        taskDiscoveryFromBlock: 0,
        chunkBlocks: 100_000,
        publicClient: buildMockClient([[pluginA, pluginB]]) as never,
        cursorCache: cache,
      });

    const first = await mkApi().listPluginPublications();
    expect(first.map((r) => r.cid).sort()).toEqual(['bafyNewPlugin', 'bafyOldPlugin']);

    // Second call: the catalog must still be complete — the old plugin must
    // not have vanished behind a cursor.
    const second = await mkApi().listPluginPublications();
    expect(second.map((r) => r.cid).sort()).toEqual(['bafyNewPlugin', 'bafyOldPlugin']);

    // The floor never consults nor advances a 'plugins' cursor.
    expect(cache.write).not.toHaveBeenCalledWith('plugins', expect.anything());
  });

  it('always scans plugin: events from the chain default, never from an injected cursor', async () => {
    const cache: OnchainCursorCache = {
      // Even if a stale 'plugins' cursor is present, the floor must ignore it.
      read: vi.fn(() => 7_777n),
      write: vi.fn(),
    };
    const mockClient = buildMockClient([[]]);
    const api = createOnchainDiscoveryAPI({
      chainId: CHAIN_ID,
      identityRegistryAddress: IDENTITY_REGISTRY,
      taskDiscoveryFromBlock: 0,
      chunkBlocks: 100_000,
      publicClient: mockClient as never,
      cursorCache: cache,
    });

    await api.listPluginPublications();

    // getLogs scanned from block 0 (taskDiscoveryFromBlock), not from 7_777.
    const getLogsCall = mockClient.getLogs.mock.calls[0][0];
    expect(getLogsCall.fromBlock).toBe(0n);
  });

  it('clamps limit to [1, 500], mirroring the HTTP layer', async () => {
    // Six plugins on six distinct blocks.
    const logs: Log[] = Array.from({ length: 6 }, (_, i) =>
      buildPluginPublishLog({
        agentId: BigInt(i + 1),
        pluginCid: `bafyPlugin${i}`,
        pluginName: `@p/plugin${i}`,
        pluginVersion: '1.0.0',
        pluginSha256: SHA_1,
        supports: ['swe-rebench-v2.v1'],
        publishedAt: BigInt(100 + i),
        blockNumber: BigInt(1_000 + i),
      }),
    );
    const mkApi = () =>
      createOnchainDiscoveryAPI({
        chainId: CHAIN_ID,
        identityRegistryAddress: IDENTITY_REGISTRY,
        taskDiscoveryFromBlock: 0,
        publicClient: buildMockClient([logs]) as never,
      });

    // limit=0 clamps up to 1.
    expect(await mkApi().listPluginPublications({ limit: 0 })).toHaveLength(1);
    // Negative limit clamps up to 1.
    expect(await mkApi().listPluginPublications({ limit: -5 })).toHaveLength(1);
    // limit above 500 clamps down to 500 (here capped by the 6 available rows).
    expect(await mkApi().listPluginPublications({ limit: 9_999 })).toHaveLength(6);
    // A valid in-range limit is honoured exactly.
    expect(await mkApi().listPluginPublications({ limit: 3 })).toHaveLength(3);
  });

  it('sorts newest-first by chain anchor (blockNumber desc), not by builder-supplied publishedAt', async () => {
    // publishedAt is deliberately inverted relative to blockNumber: the older
    // block carries the larger publishedAt. The floor must order by the
    // chain-attested blockNumber, matching the HTTP layer's orderBy.
    const earlyBlockLatePublishedAt = buildPluginPublishLog({
      agentId: 1n,
      pluginCid: 'bafyEarlyBlock',
      pluginName: '@a/early',
      pluginVersion: '1.0.0',
      pluginSha256: SHA_1,
      supports: ['swe-rebench-v2.v1'],
      publishedAt: 9_000n, // larger publishedAt
      blockNumber: 1_000n, // smaller blockNumber
    });
    const lateBlockEarlyPublishedAt = buildPluginPublishLog({
      agentId: 2n,
      pluginCid: 'bafyLateBlock',
      pluginName: '@b/late',
      pluginVersion: '1.0.0',
      pluginSha256: SHA_2,
      supports: ['swe-rebench-v2.v1'],
      publishedAt: 100n, // smaller publishedAt
      blockNumber: 8_000n, // larger blockNumber
    });
    const mockClient = buildMockClient([
      [earlyBlockLatePublishedAt, lateBlockEarlyPublishedAt],
    ]);
    const api = createOnchainDiscoveryAPI({
      chainId: CHAIN_ID,
      identityRegistryAddress: IDENTITY_REGISTRY,
      taskDiscoveryFromBlock: 0,
      publicClient: mockClient as never,
    });

    const rows = await api.listPluginPublications();
    // blockNumber desc → late-block row first, despite its smaller publishedAt.
    expect(rows.map((r) => r.cid)).toEqual(['bafyLateBlock', 'bafyEarlyBlock']);
  });

  it('breaks blockNumber ties by (transactionIndex, logIndex) desc', async () => {
    const sameBlock = 5_000n;
    const lowerLog = buildPluginPublishLog({
      agentId: 1n,
      pluginCid: 'bafyLowerLog',
      pluginName: '@a/lower',
      pluginVersion: '1.0.0',
      pluginSha256: SHA_1,
      supports: ['swe-rebench-v2.v1'],
      publishedAt: 100n,
      blockNumber: sameBlock,
      transactionIndex: 0,
      logIndex: 1,
    });
    const higherLog = buildPluginPublishLog({
      agentId: 2n,
      pluginCid: 'bafyHigherLog',
      pluginName: '@b/higher',
      pluginVersion: '1.0.0',
      pluginSha256: SHA_2,
      supports: ['swe-rebench-v2.v1'],
      publishedAt: 100n,
      blockNumber: sameBlock,
      transactionIndex: 0,
      logIndex: 9,
    });
    const mockClient = buildMockClient([[lowerLog, higherLog]]);
    const api = createOnchainDiscoveryAPI({
      chainId: CHAIN_ID,
      identityRegistryAddress: IDENTITY_REGISTRY,
      taskDiscoveryFromBlock: 0,
      publicClient: mockClient as never,
    });

    const rows = await api.listPluginPublications();
    // Same block, same txIndex → higher logIndex sorts first.
    expect(rows.map((r) => r.cid)).toEqual(['bafyHigherLog', 'bafyLowerLog']);
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

describe('OnchainDiscoveryAPI.getInstanceSuccessCounts (#669)', () => {
  it('returns an empty Map as the floor stub', async () => {
    // Construct cheaply — the stub never makes RPC calls. We pass an inert
    // rpcUrl and the chainId; the stub bypasses any client construction.
    const api = createOnchainDiscoveryAPI({
      rpcUrl: 'http://127.0.0.1:65535',
      chainId: 84532,
    });
    const counts = await api.getInstanceSuccessCounts({ manifestCid: 'bafyany' });
    expect(counts).toBeInstanceOf(Map);
    expect(counts.size).toBe(0);
  });
});

describe('OnchainDiscoveryAPI.getInstanceClaimCounts (#802)', () => {
  it('returns an empty Map as the floor stub (never the runtime path)', async () => {
    const api = createOnchainDiscoveryAPI({
      rpcUrl: 'http://127.0.0.1:65535',
      chainId: 84532,
    });
    const counts = await api.getInstanceClaimCounts({ manifestCid: 'bafyany' });
    expect(counts).toBeInstanceOf(Map);
    expect(counts.size).toBe(0);
  });
});

/**
 * Tests for OnchainDiscoveryAPI.getMostRecentTaskCidDigest (#957).
 *
 * Seeds TaskCreated logs at known blocks for a manifest digest and asserts the
 * floor returns the highest-block task's taskCidDigest + id. Uses viem mock
 * PublicClient injection (getBlockNumber + getLogs), mirroring
 * onchain-task-post-counts.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Hex, type Log } from 'viem';
import { createOnchainDiscoveryAPI } from '../../src/discovery/onchain.js';
import { manifestDigestForCid } from '../../src/adapters/mech/digest.js';

const CHAIN_ID = 8453;
const ROUTER = '0xfFa7118A3D820cd4E820010837D65FAfF463181B' as `0x${string}`;
const HEAD = 100_000n;

const CID = 'bafyMostRecentOnchain';
const DIGEST = manifestDigestForCid(CID);
const OTHER_DIGEST = manifestDigestForCid('bafyOther');

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

function buildTaskCreatedLog(
  taskId: bigint,
  manifestDigest: Hex,
  taskCidDigest: Hex,
  blockNumber: bigint,
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
    [taskCidDigest, 1, 1, 1000n, 500n],
  );
  return {
    address: ROUTER,
    data,
    topics,
    blockNumber,
    blockHash: `0x${'00'.repeat(32)}` as Hex,
    transactionHash: `0x${'11'.repeat(32)}` as Hex,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  } as unknown as Log;
}

function buildMockClient(logs: Log[]): {
  getBlockNumber: ReturnType<typeof vi.fn>;
  getLogs: ReturnType<typeof vi.fn>;
} {
  return {
    getBlockNumber: vi.fn(async () => HEAD),
    getLogs: vi.fn(async (args: { fromBlock: bigint; toBlock: bigint }) =>
      logs.filter(
        (l) =>
          (l as { blockNumber: bigint }).blockNumber >= args.fromBlock &&
          (l as { blockNumber: bigint }).blockNumber <= args.toBlock,
      ),
    ),
  };
}

describe('OnchainDiscoveryAPI.getMostRecentTaskCidDigest (#957)', () => {
  it('returns the highest-block task digest for the manifest, ignoring other manifests', async () => {
    const newest = `0x${'ee'.repeat(32)}` as Hex;
    const logs = [
      buildTaskCreatedLog(1n, DIGEST, `0x${'aa'.repeat(32)}` as Hex, HEAD - 5_000n),
      buildTaskCreatedLog(2n, DIGEST, newest, HEAD - 100n),               // newest for our manifest
      buildTaskCreatedLog(3n, OTHER_DIGEST, `0x${'ff'.repeat(32)}` as Hex, HEAD - 10n), // other manifest, newer block
    ];
    const api = createOnchainDiscoveryAPI({
      chainId: CHAIN_ID,
      taskDiscoveryFromBlock: 0,
      publicClient: buildMockClient(logs) as never,
    });
    const result = await api.getMostRecentTaskCidDigest(CID);
    expect(result).toEqual({ taskCidDigest: newest, taskId: '2' });
  });

  it('returns undefined when no TaskCreated event matches the manifest', async () => {
    const logs = [buildTaskCreatedLog(3n, OTHER_DIGEST, `0x${'ff'.repeat(32)}` as Hex, HEAD - 10n)];
    const api = createOnchainDiscoveryAPI({
      chainId: CHAIN_ID,
      taskDiscoveryFromBlock: 0,
      publicClient: buildMockClient(logs) as never,
    });
    expect(await api.getMostRecentTaskCidDigest(CID)).toBeUndefined();
  });
});

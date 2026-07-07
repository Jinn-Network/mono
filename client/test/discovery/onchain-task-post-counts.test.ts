/**
 * Tests for OnchainDiscoveryAPI.getTaskPostCounts (#918).
 *
 * Seeds TaskCreated logs at known blocks across the three windows (1h / 6h /
 * 24h) and two manifest digests, then asserts the chain-wide totals and the
 * per-cid buckets. Block-window approximation: with the default Base blocktime
 * the windows are 1800 / 10800 / 43200 blocks back from head.
 *
 * Uses viem mock PublicClient injection (getBlockNumber + getLogs), mirroring
 * onchain.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  encodeAbiParameters,
  encodeEventTopics,
  type Hex,
  type Log,
} from 'viem';
import { createOnchainDiscoveryAPI } from '../../src/discovery/onchain.js';
import {
  DiscoveryUnavailableError,
  TASK_POST_WINDOW_BLOCKS,
  bucketTaskPostCounts,
} from '../../src/discovery/types.js';
import { manifestDigestForCid } from '../../src/adapters/mech/digest.js';

const CHAIN_ID = 8453;
const ROUTER = '0xfFa7118A3D820cd4E820010837D65FAfF463181B' as `0x${string}`;
// Head well above 43200 so all three windows have a positive lower bound.
const HEAD = 100_000n;

const CID_A = 'bafyTaskPostsA';
const CID_B = 'bafyTaskPostsB';
const DIGEST_A = manifestDigestForCid(CID_A);
const DIGEST_B = manifestDigestForCid(CID_B);

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

function buildTaskCreatedLog(
  taskId: bigint,
  manifestDigest: Hex,
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
      { name: 'maxClaims', type: 'uint32' },
      { name: 'solutionBudget', type: 'uint256' },
      { name: 'verdictBudget', type: 'uint256' },
    ],
    [`0x${'dd'.repeat(32)}` as Hex, 1, 1000n, 500n],
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

/** Mock client serving all queued logs from a single getLogs call (one chunk). */
function buildMockClient(logs: Log[]): {
  getBlockNumber: ReturnType<typeof vi.fn>;
  getLogs: ReturnType<typeof vi.fn>;
} {
  return {
    getBlockNumber: vi.fn(async () => HEAD),
    // The implementation chunks [fromBlock, head]; return only logs within the
    // requested chunk so the bucketing reflects real block windows.
    getLogs: vi.fn(async (args: { fromBlock: bigint; toBlock: bigint }) =>
      logs.filter(
        (l) =>
          (l as { blockNumber: bigint }).blockNumber >= args.fromBlock &&
          (l as { blockNumber: bigint }).blockNumber <= args.toBlock,
      ),
    ),
  };
}

describe('OnchainDiscoveryAPI.getTaskPostCounts (#918)', () => {
  it('buckets chain-wide totals across the three windows', async () => {
    // h1 boundary: HEAD-1800; h6: HEAD-10800; h24: HEAD-43200.
    const logs = [
      buildTaskCreatedLog(1n, DIGEST_A, HEAD - 100n),    // in h1, h6, h24
      buildTaskCreatedLog(2n, DIGEST_A, HEAD - 5_000n),  // in h6, h24 (not h1)
      buildTaskCreatedLog(3n, DIGEST_B, HEAD - 20_000n), // in h24 only
      buildTaskCreatedLog(4n, DIGEST_B, HEAD - 60_000n), // older than 24h → excluded
    ];
    const mockClient = buildMockClient(logs);
    const api = createOnchainDiscoveryAPI({
      chainId: CHAIN_ID,
      taskDiscoveryFromBlock: 0,
      publicClient: mockClient as never,
    });

    const result = await api.getTaskPostCounts();
    expect(result.chain.h1).toBe(1);
    expect(result.chain.h6).toBe(2);
    expect(result.chain.h24).toBe(3);
    expect(result.windowEndBlock).toBe(Number(HEAD));
    expect(result.windowEndTs).toBeGreaterThan(0);
    // No manifestCids → byCid empty.
    expect(result.byCid).toEqual({});
  });

  it('buckets per-cid totals when manifestCids are provided', async () => {
    const logs = [
      buildTaskCreatedLog(1n, DIGEST_A, HEAD - 100n),    // A: h1
      buildTaskCreatedLog(2n, DIGEST_A, HEAD - 5_000n),  // A: h6
      buildTaskCreatedLog(3n, DIGEST_B, HEAD - 20_000n), // B: h24
    ];
    const mockClient = buildMockClient(logs);
    const api = createOnchainDiscoveryAPI({
      chainId: CHAIN_ID,
      taskDiscoveryFromBlock: 0,
      publicClient: mockClient as never,
    });

    const result = await api.getTaskPostCounts({ manifestCids: [CID_A, CID_B] });
    expect(result.chain.h24).toBe(3);
    expect(result.byCid[CID_A]).toMatchObject({ h1: 1, h6: 2, h24: 2 });
    expect(result.byCid[CID_B]).toMatchObject({ h1: 0, h6: 0, h24: 1 });
  });

  it('returns zero counts when no TaskCreated events fall in the window', async () => {
    const mockClient = buildMockClient([]);
    const api = createOnchainDiscoveryAPI({
      chainId: CHAIN_ID,
      taskDiscoveryFromBlock: 0,
      publicClient: mockClient as never,
    });
    const result = await api.getTaskPostCounts({ manifestCids: [CID_A] });
    expect(result.chain).toMatchObject({ h1: 0, h6: 0, h24: 0 });
    expect(result.byCid[CID_A]).toMatchObject({ h1: 0, h6: 0, h24: 0 });
  });

  it('throws DiscoveryUnavailableError when getBlockNumber fails', async () => {
    const mockClient = {
      getBlockNumber: vi.fn(async () => {
        throw new Error('rpc down');
      }),
      getLogs: vi.fn(async () => []),
    };
    const api = createOnchainDiscoveryAPI({
      chainId: CHAIN_ID,
      taskDiscoveryFromBlock: 0,
      publicClient: mockClient as never,
    });
    await expect(api.getTaskPostCounts()).rejects.toThrow(DiscoveryUnavailableError);
  });
});

describe('bucketTaskPostCounts — window boundaries (#918)', () => {
  // With HEAD as windowEndBlock the cuts are:
  //   h1Cut  = HEAD - 1800   (>= → in h1)
  //   h6Cut  = HEAD - 10800  (>= → in h6)
  //   h24Cut = HEAD - 43200  (block < h24Cut → excluded; == → included)
  const HEAD_NUM = Number(HEAD);
  const TS = 1_700_000_000;
  const bucketChain = (block: number) =>
    bucketTaskPostCounts(
      HEAD_NUM,
      TS,
      [{ block, digest: 'whatever' }],
      new Map(),
    ).chain;

  it('a block exactly at h1Cut (HEAD - 1800) lands in h1', () => {
    const c = bucketChain(HEAD_NUM - TASK_POST_WINDOW_BLOCKS.h1);
    expect(c).toMatchObject({ h1: 1, h6: 1, h24: 1 });
  });

  it('a block one past h1Cut (HEAD - 1801) drops out of h1 but stays in h6/h24', () => {
    const c = bucketChain(HEAD_NUM - TASK_POST_WINDOW_BLOCKS.h1 - 1);
    expect(c).toMatchObject({ h1: 0, h6: 1, h24: 1 });
  });

  it('a block exactly at h6Cut (HEAD - 10800) lands in h6', () => {
    const c = bucketChain(HEAD_NUM - TASK_POST_WINDOW_BLOCKS.h6);
    expect(c).toMatchObject({ h1: 0, h6: 1, h24: 1 });
  });

  it('a block one past h6Cut (HEAD - 10801) drops out of h6 but stays in h24', () => {
    const c = bucketChain(HEAD_NUM - TASK_POST_WINDOW_BLOCKS.h6 - 1);
    expect(c).toMatchObject({ h1: 0, h6: 0, h24: 1 });
  });

  it('a block exactly at h24Cut (HEAD - 43200) is still inside h24 (strict <)', () => {
    const c = bucketChain(HEAD_NUM - TASK_POST_WINDOW_BLOCKS.h24);
    expect(c).toMatchObject({ h1: 0, h6: 0, h24: 1 });
  });

  it('a block one past h24Cut (HEAD - 43201) is excluded entirely', () => {
    const c = bucketChain(HEAD_NUM - TASK_POST_WINDOW_BLOCKS.h24 - 1);
    expect(c).toMatchObject({ h1: 0, h6: 0, h24: 0 });
  });
});

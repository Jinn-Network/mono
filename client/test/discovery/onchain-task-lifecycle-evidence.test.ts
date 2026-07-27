/**
 * Tests for OnchainDiscoveryAPI.getTaskLifecycleEvidence (#2044).
 *
 * Reconstructs the authoritative task→attempt→verdict spine from router logs.
 * Candidates are always empty on the floor.
 */
import { describe, it, expect, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Hex, type Log } from 'viem';
import { createOnchainDiscoveryAPI } from '../../src/discovery/onchain.js';

const CHAIN_ID = 8453;
const ROUTER = '0xfFa7118A3D820cd4E820010837D65FAfF463181B' as `0x${string}`;
/** Keep HEAD well under the 50×1999-block scan cap so tests exercise decode, not truncation. */
const HEAD = 10_000n;

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

const VERDICT_DELIVERY_CLAIMED_ABI = [
  {
    type: 'event',
    name: 'VerdictDeliveryClaimed',
    inputs: [
      { name: 'evaluator', type: 'address', indexed: true },
      { name: 'requestId', type: 'bytes32', indexed: true },
      { name: 'taskId', type: 'uint256', indexed: true },
      { name: 'attemptIndex', type: 'uint32', indexed: false },
      { name: 'verdictIndex', type: 'uint32', indexed: false },
      { name: 'verdictCode', type: 'uint8', indexed: false },
    ],
  },
] as const;

const TASK_BUDGET_REFUNDED_ABI = [
  {
    type: 'event',
    name: 'TaskBudgetRefunded',
    inputs: [
      { name: 'taskId', type: 'uint256', indexed: true },
      { name: 'creator', type: 'address', indexed: true },
      { name: 'solutionAmount', type: 'uint256', indexed: false },
      { name: 'verdictAmount', type: 'uint256', indexed: false },
    ],
  },
] as const;

function buildTaskCreatedLog(
  taskId: bigint,
  blockNumber: bigint,
  opts?: { creator?: Hex; manifestDigest?: Hex; taskCidDigest?: Hex; maxClaims?: number; tx?: Hex },
): Log {
  const creator = (opts?.creator ?? `0x${'aa'.repeat(20)}`) as `0x${string}`;
  const manifestDigest = (opts?.manifestDigest ?? `0x${'11'.repeat(32)}`) as Hex;
  const taskCidDigest = (opts?.taskCidDigest ?? `0x${'22'.repeat(32)}`) as Hex;
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
    [taskCidDigest, opts?.maxClaims ?? 2, 1000n, 500n],
  );
  return {
    address: ROUTER,
    data,
    topics,
    blockNumber,
    blockHash: `0x${'00'.repeat(32)}` as Hex,
    transactionHash: opts?.tx ?? (`0x${'77'.repeat(32)}` as Hex),
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  } as unknown as Log;
}

function buildAttemptLog(
  taskId: bigint,
  attemptIndex: number,
  requestId: Hex,
  blockNumber: bigint,
  opts?: { operator?: Hex; priorityMech?: Hex; deliveryRate?: bigint },
): Log {
  const topics = encodeEventTopics({
    abi: TASK_ATTEMPT_CREATED_ABI,
    eventName: 'TaskAttemptCreated',
    args: { taskId, attemptIndex, requestId },
  });
  const operator = (opts?.operator ?? `0x${'b0'.repeat(20)}`) as `0x${string}`;
  const priorityMech = (opts?.priorityMech ?? `0x${'c0'.repeat(20)}`) as `0x${string}`;
  const data = encodeAbiParameters(
    [
      { name: 'operator', type: 'address' },
      { name: 'priorityMech', type: 'address' },
      { name: 'deliveryRate', type: 'uint256' },
    ],
    [operator, priorityMech, opts?.deliveryRate ?? 1n],
  );
  return {
    address: ROUTER,
    data,
    topics,
    blockNumber,
    blockHash: `0x${'00'.repeat(32)}` as Hex,
    transactionHash: `0x${'88'.repeat(32)}` as Hex,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  } as unknown as Log;
}

function buildVerdictLog(
  taskId: bigint,
  attemptIndex: number,
  verdictIndex: number,
  requestId: Hex,
  blockNumber: bigint,
  opts?: { evaluator?: Hex; verdictCode?: number },
): Log {
  const evaluator = (opts?.evaluator ?? `0x${'e0'.repeat(20)}`) as `0x${string}`;
  const topics = encodeEventTopics({
    abi: VERDICT_DELIVERY_CLAIMED_ABI,
    eventName: 'VerdictDeliveryClaimed',
    args: { evaluator, requestId, taskId },
  });
  const data = encodeAbiParameters(
    [
      { name: 'attemptIndex', type: 'uint32' },
      { name: 'verdictIndex', type: 'uint32' },
      { name: 'verdictCode', type: 'uint8' },
    ],
    [attemptIndex, verdictIndex, opts?.verdictCode ?? 1],
  );
  return {
    address: ROUTER,
    data,
    topics,
    blockNumber,
    blockHash: `0x${'00'.repeat(32)}` as Hex,
    transactionHash: `0x${'99'.repeat(32)}` as Hex,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  } as unknown as Log;
}

function buildTaskBudgetRefundedLog(
  taskId: bigint,
  blockNumber: bigint,
  opts?: { creator?: Hex; solutionAmount?: bigint; verdictAmount?: bigint },
): Log {
  const creator = (opts?.creator ?? `0x${'aa'.repeat(20)}`) as `0x${string}`;
  const topics = encodeEventTopics({
    abi: TASK_BUDGET_REFUNDED_ABI,
    eventName: 'TaskBudgetRefunded',
    args: { taskId, creator },
  });
  const data = encodeAbiParameters(
    [
      { name: 'solutionAmount', type: 'uint256' },
      { name: 'verdictAmount', type: 'uint256' },
    ],
    [opts?.solutionAmount ?? 1000n, opts?.verdictAmount ?? 500n],
  );
  return {
    address: ROUTER,
    data,
    topics,
    blockNumber,
    blockHash: `0x${'00'.repeat(32)}` as Hex,
    transactionHash: `0x${'aa'.repeat(32)}` as Hex,
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

describe('OnchainDiscoveryAPI.getTaskLifecycleEvidence (#2044)', () => {
  it('short-circuits an empty task list without calling getLogs', async () => {
    const client = buildMockClient([]);
    const api = createOnchainDiscoveryAPI({
      chainId: CHAIN_ID,
      taskDiscoveryFromBlock: 0,
      publicClient: client as never,
    });
    await expect(api.getTaskLifecycleEvidence({ taskIds: [] }))
      .resolves.toEqual(new Map());
    expect(client.getLogs).not.toHaveBeenCalled();
  });

  it('returns a sorted multi-attempt multi-verdict spine with empty candidates', async () => {
    const solve0 = `0x${'b0'.repeat(32)}` as Hex;
    const solve1 = `0x${'b1'.repeat(32)}` as Hex;
    const eval0 = `0x${'d0'.repeat(32)}` as Hex;
    const eval1 = `0x${'d1'.repeat(32)}` as Hex;
    const logs = [
      buildTaskCreatedLog(7n, HEAD - 100n),
      buildAttemptLog(7n, 1, solve1, HEAD - 80n, {
        operator: `0x${'b1'.repeat(20)}` as Hex,
        priorityMech: `0x${'c1'.repeat(20)}` as Hex,
        deliveryRate: 2n,
      }),
      buildAttemptLog(7n, 0, solve0, HEAD - 90n, {
        operator: `0x${'b0'.repeat(20)}` as Hex,
        priorityMech: `0x${'c0'.repeat(20)}` as Hex,
        deliveryRate: 1n,
      }),
      buildVerdictLog(7n, 0, 1, eval1, HEAD - 60n, {
        evaluator: `0x${'e1'.repeat(20)}` as Hex,
        verdictCode: 2,
      }),
      buildVerdictLog(7n, 0, 0, eval0, HEAD - 70n, {
        evaluator: `0x${'e0'.repeat(20)}` as Hex,
        verdictCode: 1,
      }),
      buildTaskBudgetRefundedLog(7n, HEAD - 55n),
      // Unrelated task — must be filtered out
      buildTaskCreatedLog(99n, HEAD - 50n, {
        creator: `0x${'ff'.repeat(20)}` as Hex,
        manifestDigest: `0x${'ff'.repeat(32)}` as Hex,
      }),
    ];
    const api = createOnchainDiscoveryAPI({
      chainId: CHAIN_ID,
      taskDiscoveryFromBlock: 0,
      publicClient: buildMockClient(logs) as never,
    });
    const map = await api.getTaskLifecycleEvidence({ taskIds: ['7', 'missing'] });
    expect(map.has('missing')).toBe(false);
    expect(map.has('99')).toBe(false);
    const ev = map.get('7')!;
    expect(ev.authoritative.task.taskId).toBe('7');
    expect(ev.authoritative.task.requiredVerdicts).toBe(1);
    expect(ev.authoritative.task.finalized).toBe(true);
    expect(ev.authoritative.task.refunded).toBe(true);
    expect(ev.authoritative.task.createdAtTx).toBe(`0x${'77'.repeat(32)}`);
    expect(ev.authoritative.attempts.map((a) => a.attemptIndex)).toEqual([0, 1]);
    expect(ev.authoritative.attempts[0]!.requestId).toBe(solve0);
    expect(ev.authoritative.attempts[0]!.verdicts.map((v) => v.verdictIndex)).toEqual([0, 1]);
    expect(ev.authoritative.attempts[0]!.attemptEnvelopeCandidates).toEqual([]);
    expect(ev.authoritative.attempts[0]!.verdicts[0]!.verdictEnvelopeCandidates).toEqual([]);
  });

  it('filters unrelated taskIds out of the spine', async () => {
    const logs = [
      buildTaskCreatedLog(7n, HEAD - 100n),
      buildTaskCreatedLog(8n, HEAD - 90n, {
        creator: `0x${'bb'.repeat(20)}` as Hex,
        manifestDigest: `0x${'33'.repeat(32)}` as Hex,
      }),
    ];
    const api = createOnchainDiscoveryAPI({
      chainId: CHAIN_ID,
      taskDiscoveryFromBlock: 0,
      publicClient: buildMockClient(logs) as never,
    });
    const map = await api.getTaskLifecycleEvidence({ taskIds: ['7'] });
    expect([...map.keys()]).toEqual(['7']);
  });
});

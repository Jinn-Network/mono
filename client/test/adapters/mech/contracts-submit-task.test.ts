import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex } from 'viem';
import { submitTask } from '../../../src/adapters/mech/contracts.js';
import { JINN_ROUTER_ABI } from '../../../src/adapters/mech/types.js';
import { executeSafeTransaction } from '../../../src/adapters/mech/safe.js';

vi.mock('../../../src/adapters/mech/safe.js', () => ({
  executeSafeTransaction: vi.fn(),
}));

const SAFE_ADDRESS = '0x1111111111111111111111111111111111111111' as Address;
const ROUTER_ADDRESS = '0x2222222222222222222222222222222222222222' as Address;
const TASK_CID_DIGEST = `0x${'33'.repeat(32)}` as Hex;
const MANIFEST_DIGEST = `0x${'44'.repeat(32)}` as Hex;
const FIRST_TX = `0x${'aa'.repeat(32)}` as Hex;
const SECOND_TX = `0x${'bb'.repeat(32)}` as Hex;

const POLICY = {
  claimWindowStart: 1n,
  claimWindowEnd: 2n,
  submissionDeadline: 3n,
  claimLeaseTtlSeconds: 300,
  maxClaims: 1,
  maxClaimsPerOperator: 1,
  policyHook: '0x0000000000000000000000000000000000000000' as Address,
  evaluationPolicy: {
    requiredVerdicts: 1,
    passThreshold: 1,
    evaluationDeadline: 4n,
    maxVerdictsPerEvaluator: 1,
    disallowSolverSelfEvaluation: true,
  },
};

function taskCreatedLog(taskId: bigint, txHash: Hex, blockNumber: bigint) {
  const topics = encodeEventTopics({
    abi: JINN_ROUTER_ABI,
    eventName: 'TaskCreated',
    args: {
      creator: SAFE_ADDRESS,
      taskId,
      manifestDigest: MANIFEST_DIGEST,
    },
  });
  const data = encodeAbiParameters(
    [
      { name: 'taskCidDigest', type: 'bytes32' },
      { name: 'maxClaims', type: 'uint16' },
      { name: 'requiredVerdicts', type: 'uint16' },
      { name: 'solutionBudget', type: 'uint256' },
      { name: 'verdictBudget', type: 'uint256' },
    ],
    [TASK_CID_DIGEST, POLICY.maxClaims, POLICY.evaluationPolicy.requiredVerdicts, 10n, 10n],
  );
  return {
    address: ROUTER_ADDRESS,
    topics,
    data,
    transactionHash: txHash,
    blockNumber,
  };
}

describe('submitTask TaskCreated recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('recovers TaskCreated from nearby router logs when the receipt logs are incomplete', async () => {
    vi.mocked(executeSafeTransaction).mockResolvedValueOnce(FIRST_TX);
    const publicClient = {
      waitForTransactionReceipt: vi.fn().mockResolvedValue({
        status: 'success',
        logs: [],
        blockNumber: 100n,
      }),
      getBlockNumber: vi.fn().mockResolvedValue(100n),
      getLogs: vi.fn().mockResolvedValue([taskCreatedLog(42n, FIRST_TX, 100n)]),
    };

    const result = await submitTask(
      publicClient as never,
      {} as never,
      SAFE_ADDRESS,
      ROUTER_ADDRESS,
      TASK_CID_DIGEST,
      MANIFEST_DIGEST,
      POLICY,
      10n,
      10n,
      300n,
    );

    expect(result).toMatchObject({
      taskId: '42',
      txHash: FIRST_TX,
      receiptLogCount: 0,
      blockNumber: 100,
    });
    expect(executeSafeTransaction).toHaveBeenCalledTimes(1);
    expect(publicClient.getLogs).toHaveBeenCalledWith({
      address: ROUTER_ADDRESS,
      fromBlock: 36n,
      toBlock: 100n,
    });
  });

  it('retries createTask when neither receipt nor nearby logs contain TaskCreated', async () => {
    vi.mocked(executeSafeTransaction)
      .mockResolvedValueOnce(FIRST_TX)
      .mockResolvedValueOnce(SECOND_TX);
    const publicClient = {
      waitForTransactionReceipt: vi.fn()
        .mockResolvedValueOnce({
          status: 'success',
          logs: [],
          blockNumber: 200n,
        })
        .mockResolvedValueOnce({
          status: 'success',
          logs: [taskCreatedLog(43n, SECOND_TX, 201n)],
          blockNumber: 201n,
        }),
      getBlockNumber: vi.fn().mockResolvedValue(200n),
      getLogs: vi.fn().mockResolvedValue([]),
    };

    const result = await submitTask(
      publicClient as never,
      {} as never,
      SAFE_ADDRESS,
      ROUTER_ADDRESS,
      TASK_CID_DIGEST,
      MANIFEST_DIGEST,
      POLICY,
      10n,
      10n,
      300n,
    );

    expect(result).toMatchObject({
      taskId: '43',
      txHash: SECOND_TX,
      receiptLogCount: 1,
      blockNumber: 201,
    });
    expect(executeSafeTransaction).toHaveBeenCalledTimes(2);
  });
});

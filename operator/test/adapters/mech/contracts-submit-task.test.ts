import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex } from 'viem';
import { submitTask } from '../../../src/adapters/mech/contracts.js';
import { JINN_ROUTER_ABI } from '../../../src/adapters/mech/types.js';
import { executeSafeTransaction } from '../../../src/adapters/mech/safe.js';

const waitForTransactionReceiptWithRetry = vi.hoisted(() => vi.fn());
vi.mock('../../../src/adapters/mech/safe.js', () => ({
  executeSafeTransaction: vi.fn(),
}));
vi.mock('../../../src/tx-retry.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/tx-retry.js')>(),
  waitForTransactionReceiptWithRetry,
  backoffDelay: vi.fn(async () => undefined),
}));

const SAFE_ADDRESS = '0x1111111111111111111111111111111111111111' as Address;
const ROUTER_ADDRESS = '0x2222222222222222222222222222222222222222' as Address;
const TASK_CID_DIGEST = `0x${'33'.repeat(32)}` as Hex;
const MANIFEST_DIGEST = `0x${'44'.repeat(32)}` as Hex;
const FIRST_TX = `0x${'aa'.repeat(32)}` as Hex;
const SECOND_TX = `0x${'bb'.repeat(32)}` as Hex;

// Tokenless-OLAS pivot: on-chain policy is `maxClaims` + `allowSolverSelfEvaluation`.
const POLICY = {
  maxClaims: 1,
  allowSolverSelfEvaluation: false,
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
      { name: 'maxClaims', type: 'uint32' },
      { name: 'solutionBudget', type: 'uint256' },
      { name: 'verdictBudget', type: 'uint256' },
    ],
    [TASK_CID_DIGEST, POLICY.maxClaims, 10n, 10n],
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
    const beforeBroadcast = vi.fn();
    const onTransactionHash = vi.fn();
    vi.mocked(executeSafeTransaction).mockImplementationOnce(
      async (_publicClient, _walletClient, _params, _broadcaster, options) => {
        await options?.beforeBroadcast?.();
        await options?.onBroadcast?.(FIRST_TX);
        return FIRST_TX;
      },
    );
    waitForTransactionReceiptWithRetry.mockResolvedValueOnce({
      status: 'success',
      logs: [],
      blockNumber: 100n,
    });
    const publicClient = {
      getBlockNumber: vi.fn().mockResolvedValue(100n),
      getLogs: vi.fn().mockResolvedValue([taskCreatedLog(42n, FIRST_TX, 100n)]),
    };

    const result = await submitTask(
      publicClient as never,
      {} as never,
      undefined,
      SAFE_ADDRESS,
      ROUTER_ADDRESS,
      TASK_CID_DIGEST,
      MANIFEST_DIGEST,
      POLICY,
      10n,
      10n,
      300n,
      undefined,
      onTransactionHash,
      beforeBroadcast,
    );

    expect(result).toMatchObject({
      taskId: '42',
      txHash: FIRST_TX,
      receiptLogCount: 0,
      blockNumber: 100,
    });
    expect(executeSafeTransaction).toHaveBeenCalledTimes(1);
    expect(beforeBroadcast).toHaveBeenCalledOnce();
    expect(onTransactionHash).toHaveBeenCalledWith(FIRST_TX);
    expect(publicClient.getLogs).toHaveBeenCalledWith({
      address: ROUTER_ADDRESS,
      fromBlock: 36n,
      toBlock: 100n,
    });
  });

  it('recovers the landed TaskCreated after receipt polling exhausts without executing the Safe twice', async () => {
    vi.mocked(executeSafeTransaction).mockResolvedValueOnce(FIRST_TX);
    waitForTransactionReceiptWithRetry.mockRejectedValueOnce(
      new Error('HTTP request failed: 503'),
    );
    const publicClient = {
      getBlockNumber: vi.fn().mockResolvedValue(200n),
      getLogs: vi.fn().mockResolvedValue([taskCreatedLog(43n, FIRST_TX, 199n)]),
    };

    const result = await submitTask(
      publicClient as never,
      {} as never,
      undefined,
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
      txHash: FIRST_TX,
      receiptLogCount: 0,
      blockNumber: 199,
    });
    expect(executeSafeTransaction).toHaveBeenCalledTimes(1);
  });

  it('keeps an event-less submitted hash recoverable without immediate rebroadcast', async () => {
    vi.mocked(executeSafeTransaction).mockResolvedValueOnce(FIRST_TX);
    waitForTransactionReceiptWithRetry.mockRejectedValue(
      new Error('HTTP request failed: 503'),
    );
    const publicClient = {
      getBlockNumber: vi.fn().mockResolvedValue(200n),
      getLogs: vi.fn().mockResolvedValue([]),
    };

    await expect(submitTask(
      publicClient as never,
      {} as never,
      undefined,
      SAFE_ADDRESS,
      ROUTER_ADDRESS,
      TASK_CID_DIGEST,
      MANIFEST_DIGEST,
      POLICY,
      10n,
      10n,
      300n,
    )).rejects.toMatchObject({ txHash: FIRST_TX });
    expect(executeSafeTransaction).toHaveBeenCalledTimes(1);
  });
});

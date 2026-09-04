import { describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeErrorResult, encodeEventTopics, parseAbi, parseAbiParameters } from 'viem';
import { JINN_ROUTER_V3_ABI } from '@jinn-network/marketplace-binding';
import { createVerdictPorts } from '@jinn-network/marketplace-venue-base';
import { createDirectSafeBroadcaster } from '../../../src/adapters/mech/direct-safe-broadcaster.js';
import {
  SafeExecutionRevertedError,
  SafeInnerRevertError,
} from '../../../src/adapters/mech/safe-revert.js';
import {
  isRecoverableTransactionError,
  SAFE_STALE_NONCE_ERROR_TOKEN,
  TX_RETRY_DEFAULTS,
} from '../../../src/tx-retry.js';

const SAFE = '0x1111111111111111111111111111111111111111' as const;
const ROUTER = '0x2222222222222222222222222222222222222222' as const;
const OWNER = '0x3333333333333333333333333333333333333333' as const;
const REQUEST_ID = `0x${'44'.repeat(32)}` as const;

describe('direct Safe broadcaster', () => {
  it('recovers and exposes the inner custom error hidden by Safe GS013', async () => {
    const innerData = encodeErrorResult({
      abi: parseAbi(['error RouterWrongRequestKind(bytes32 requestId, uint8 expected, uint8 actual)']),
      errorName: 'RouterWrongRequestKind',
      args: [REQUEST_ID, 1, 2],
    });
    const publicClient = {
      readContract: vi.fn()
        .mockResolvedValueOnce(0n)
        .mockResolvedValueOnce(`0x${'55'.repeat(32)}`),
      call: vi.fn().mockRejectedValue({ data: innerData }),
      waitForTransactionReceipt: vi.fn(),
    };
    const walletClient = {
      account: { address: OWNER },
      chain: { id: 8453 },
      signMessage: vi.fn().mockResolvedValue(`0x${'66'.repeat(64)}1b`),
      writeContract: vi.fn().mockRejectedValue(new Error('execution reverted: GS013')),
    };
    const broadcaster = createDirectSafeBroadcaster(
      publicClient as never,
      walletClient as never,
      SAFE,
    );

    await expect(broadcaster.execute({
      to: ROUTER,
      value: 0n,
      data: '0xdeadbeef',
      logicalTx: 'test:inner-revert',
    })).rejects.toMatchObject({
      name: 'SafeInnerRevertError',
      decodedName: 'RouterWrongRequestKind',
      innerSelector: '0x51cba8b3',
    } satisfies Partial<SafeInnerRevertError>);

    expect(publicClient.call).toHaveBeenCalledExactlyOnceWith({
      account: SAFE,
      to: ROUTER,
      data: '0xdeadbeef',
      value: 0n,
    });
    expect(publicClient.waitForTransactionReceipt).not.toHaveBeenCalled();
  });

  // D0a round-1 review (minor finding): the docstring's "a CLI verb submits exactly one Safe
  // transaction per invocation" premise is violated by `jinn solver-plugins`, which builds TWO
  // independent `createDirectSafeBroadcaster` instances for the SAME agent EOA (publish's
  // publisherFactory and the reputation write client) that can both be exercised in one process.
  // With no per-EOA lock, two `execute()` calls from those two instances could race each other's
  // nonce read. Opting into `withEoaBroadcastLock` (already exported for exactly this) closes it.
  function makeBroadcaster(
    label: string,
    order: string[],
    opts: { gate?: Promise<void> } = {},
  ) {
    const publicClient = {
      readContract: vi.fn()
        .mockResolvedValueOnce(0n) // nonce
        .mockResolvedValueOnce(`0x${'55'.repeat(32)}`), // safeTxHash
      // `execute` reads block identity and logs off the receipt (#2665), so the double must
      // return one rather than `undefined`.
      waitForTransactionReceipt: vi.fn().mockResolvedValue({
        transactionHash: `0x${'77'.repeat(32)}`,
        blockNumber: 1n,
        blockHash: `0x${'99'.repeat(32)}`,
        status: 'success',
        logs: [],
      }),
    };
    const walletClient = {
      account: { address: OWNER },
      chain: { id: 8453 },
      signMessage: vi.fn(async () => {
        order.push(`${label}-start`);
        if (opts.gate) await opts.gate;
        order.push(`${label}-signed`);
        return `0x${'66'.repeat(64)}1b`;
      }),
      writeContract: vi.fn().mockResolvedValue(`0x${'77'.repeat(32)}`),
    };
    return createDirectSafeBroadcaster(publicClient as never, walletClient as never, SAFE);
  }

  it('serializes concurrent executes for the SAME EOA across two independent broadcaster instances', async () => {
    const order: string[] = [];
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    const broadcasterA = makeBroadcaster('a', order, { gate: gateA });
    const broadcasterB = makeBroadcaster('b', order);

    const execA = broadcasterA.execute({ to: ROUTER, value: 0n, data: '0x', logicalTx: 'a' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(['a-start']);

    const execB = broadcasterB.execute({ to: ROUTER, value: 0n, data: '0x', logicalTx: 'b' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    // B must NOT have started yet -- it should be waiting on the shared per-EOA lock, not racing
    // A's in-flight nonce read.
    expect(order).toEqual(['a-start']);

    releaseA();
    await Promise.all([execA, execB]);
    expect(order).toEqual(['a-start', 'a-signed', 'b-start', 'b-signed']);
  });
});

// Issue #2665. `createDirectSafeBroadcaster` awaited `waitForTransactionReceipt` and threw the
// receipt away, resolving `{txHash}` alone. Handed to venue-base's verdict port -- which the e2e
// verdict legs do -- `openVerdictAttempt` reached
// `decodeEvaluationAttemptFromLogs(receipt.logs)` with `undefined` and died with "undefined is
// not iterable". The three e2e call sites hid the mismatch behind `as never`, and `yarn
// typecheck` excludes `test/`, so neither the compiler nor CI saw it.
describe('direct Safe broadcaster drives venue-base verdict ports (#2665)', () => {
  const TASK_ID = 42n;
  const ATTEMPT_INDEX = 3;
  const VERDICT_INDEX = 7;
  const EVAL_REQUEST_ID = `0x${'88'.repeat(32)}` as const;
  const MECH = '0x4444444444444444444444444444444444444444' as const;
  const EVALUATOR = '0x5555555555555555555555555555555555555555' as const;
  const BLOCK_HASH = `0x${'99'.repeat(32)}` as const;
  const TX_HASH = `0x${'77'.repeat(32)}` as const;

  function attemptCreatedLog() {
    const encoded = encodeEventTopics({
      abi: JINN_ROUTER_V3_ABI,
      eventName: 'EvaluationAttemptCreated',
      args: { taskId: TASK_ID, attemptIndex: ATTEMPT_INDEX, verdictIndex: VERDICT_INDEX },
    });
    return {
      address: ROUTER,
      topics: encoded,
      data: encodeAbiParameters(
        parseAbiParameters('bytes32 requestId, address evaluator, address priorityMech, uint256 deliveryRate'),
        [EVAL_REQUEST_ID, EVALUATOR, MECH, 0n],
      ),
      blockHash: BLOCK_HASH,
      blockNumber: 1234n,
      transactionHash: TX_HASH,
      logIndex: 0,
      transactionIndex: 0,
      removed: false,
    };
  }

  it('openVerdictAttempt decodes the canonical attempt from the broadcaster receipt', async () => {
    const publicClient = {
      readContract: vi.fn()
        .mockResolvedValueOnce(0n) // Safe nonce
        .mockResolvedValueOnce(`0x${'55'.repeat(32)}`), // safeTxHash
      waitForTransactionReceipt: vi.fn().mockResolvedValue({
        transactionHash: TX_HASH,
        blockNumber: 1234n,
        blockHash: BLOCK_HASH,
        status: 'success',
        logs: [attemptCreatedLog()],
      }),
    };
    const walletClient = {
      account: { address: OWNER },
      chain: { id: 8453 },
      signMessage: vi.fn().mockResolvedValue(`0x${'66'.repeat(64)}1b`),
      writeContract: vi.fn().mockResolvedValue(TX_HASH),
    };

    const ports = createVerdictPorts({
      publicClient: publicClient as never,
      // No `as never`: the direct broadcaster now satisfies the verdict port's declared
      // broadcaster contract on its own. A cast here would re-hide exactly this defect.
      broadcaster: createDirectSafeBroadcaster(publicClient as never, walletClient as never, SAFE),
      safeAddress: SAFE,
      routerAddress: ROUTER,
      mechAddress: MECH,
    });

    const claim = await ports.openVerdictAttempt({
      operationId: 'test:open-verdict',
      taskId: TASK_ID,
      attemptIndex: ATTEMPT_INDEX,
      evaluationTaskCidDigest: `0x${'aa'.repeat(32)}`,
    });

    expect(claim).toEqual({
      operationId: 'test:open-verdict',
      requestId: EVAL_REQUEST_ID,
      verdictIndex: VERDICT_INDEX,
      transaction: { hash: TX_HASH, blockNumber: 1234n, blockHash: BLOCK_HASH },
    });
  });

  it('surfaces the full receipt, with alreadySettled pinned false', async () => {
    const publicClient = {
      readContract: vi.fn()
        .mockResolvedValueOnce(0n)
        .mockResolvedValueOnce(`0x${'55'.repeat(32)}`),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({
        transactionHash: TX_HASH,
        blockNumber: 1234n,
        blockHash: BLOCK_HASH,
        status: 'success',
        logs: [attemptCreatedLog()],
      }),
    };
    const walletClient = {
      account: { address: OWNER },
      chain: { id: 8453 },
      signMessage: vi.fn().mockResolvedValue(`0x${'66'.repeat(64)}1b`),
      writeContract: vi.fn().mockResolvedValue(TX_HASH),
    };

    const receipt = await createDirectSafeBroadcaster(
      publicClient as never,
      walletClient as never,
      SAFE,
    ).execute({ to: ROUTER, value: 0n, data: '0xdeadbeef', logicalTx: 'test:receipt' });

    expect(receipt.txHash).toBe(TX_HASH);
    expect(receipt.blockNumber).toBe(1234n);
    expect(receipt.blockHash).toBe(BLOCK_HASH);
    expect(receipt.logs).toHaveLength(1);
    // This broadcaster has no already-settled reconciliation path: an inner revert throws
    // `SafeInnerRevertError` (see the GS013 case above) rather than resolving as a replay.
    expect(receipt.alreadySettled).toBe(false);
  });
});

// Issue #3733. `waitForTransactionReceipt` resolves for a mined-but-reverted transaction, so a
// broadcaster that never reads `receipt.status` reports success with `logs: []`. On the decoding
// legs that surfaced as venue-base's "no canonical EvaluationAttemptCreated" (a symptom, not the
// cause); on `deliverVerdictToMarketplace` / `claimVerdictDelivery`, which decode nothing, it was
// reported as `settled` against a transaction that did nothing.
//
// `safeTxGas` and `gasPrice` are both 0 on this path, so a failing inner call reverts
// execTransaction at the top level. The receipt therefore gets the same two-branch treatment
// venue-base's `createSafeBroadcaster` gives it: re-simulate to recover the reason, and treat a
// clean re-simulation as the stale-nonce / signature race it is.
describe('direct Safe broadcaster rejects a mined-but-reverted execTransaction (#3733)', () => {
  const TX_HASH = `0x${'77'.repeat(32)}` as const;

  function revertingClients(innerCall: { rejectWith?: unknown } = {}) {
    return {
      publicClient: {
        readContract: vi.fn()
          .mockResolvedValue(`0x${'55'.repeat(32)}`)
          .mockResolvedValueOnce(0n)
          .mockResolvedValueOnce(`0x${'55'.repeat(32)}`),
        call: innerCall.rejectWith === undefined
          ? vi.fn().mockResolvedValue({ data: '0x' })
          : vi.fn().mockRejectedValue(innerCall.rejectWith),
        waitForTransactionReceipt: vi.fn().mockResolvedValue({
          transactionHash: TX_HASH,
          blockNumber: 1234n,
          blockHash: `0x${'99'.repeat(32)}`,
          status: 'reverted',
          logs: [],
        }),
      },
      walletClient: {
        account: { address: OWNER },
        chain: { id: 8453 },
        signMessage: vi.fn().mockResolvedValue(`0x${'66'.repeat(64)}1b`),
        writeContract: vi.fn().mockResolvedValue(TX_HASH),
      },
    };
  }

  it('recovers the inner reason when re-simulation reverts, rather than reporting success', async () => {
    const innerData = encodeErrorResult({
      abi: parseAbi(['error RouterWrongRequestKind(bytes32 requestId, uint8 expected, uint8 actual)']),
      errorName: 'RouterWrongRequestKind',
      args: [REQUEST_ID, 1, 2],
    });
    const { publicClient, walletClient } = revertingClients({ rejectWith: { data: innerData } });

    await expect(createDirectSafeBroadcaster(
      publicClient as never,
      walletClient as never,
      SAFE,
    ).execute({ to: ROUTER, value: 0n, data: '0xdeadbeef', logicalTx: 'verdict:openVerdictAttempt' }))
      .rejects.toMatchObject({
        name: 'SafeInnerRevertError',
        decodedName: 'RouterWrongRequestKind',
        // The receipt path knows the tx hash the write path does not.
        txHash: TX_HASH,
      } satisfies Partial<SafeInnerRevertError>);

    // Terminal, so the write is not repeated: RouterWrongRequestKind is in the retry policy's
    // permanent set and cannot clear within the budget.
    expect(walletClient.writeContract).toHaveBeenCalledTimes(1);

    // A CLI log line on this branch must still say which logical operation failed; the decoded
    // cause replaces the status text, not the context around it.
    const second = revertingClients({ rejectWith: { data: innerData } });
    await expect(createDirectSafeBroadcaster(
      second.publicClient as never,
      second.walletClient as never,
      SAFE,
    ).execute({ to: ROUTER, value: 0n, data: '0xdeadbeef', logicalTx: 'verdict:openVerdictAttempt' }))
      .rejects.toThrow(/verdict:openVerdictAttempt/u);

  });

  it('retries the whole sign-and-send, then throws naming the tx hash, Safe and operation', async () => {
    const { publicClient, walletClient } = revertingClients();
    // Fake timers so the retry policy's exponential backoff (~13s of real sleeping across the
    // six attempts) does not become this file's runtime.
    vi.useFakeTimers();

    const pending = createDirectSafeBroadcaster(
      publicClient as never,
      walletClient as never,
      SAFE,
    ).execute({
      to: ROUTER,
      value: 0n,
      data: '0xdeadbeef',
      logicalTx: 'verdict:openVerdictAttempt',
    }).then(() => null, (e: unknown) => e as SafeExecutionRevertedError);
    await vi.runAllTimersAsync();
    const error = await pending;
    vi.useRealTimers();

    // The point of classifying this retryable: every attempt re-reads the Safe nonce and
    // re-signs, which is what heals a stale-nonce race. An exhausted budget still throws.
    expect(walletClient.writeContract).toHaveBeenCalledTimes(TX_RETRY_DEFAULTS.maxAttempts);
    expect(error).toMatchObject({
      name: 'SafeExecutionRevertedError',
      txHash: TX_HASH,
      safeAddress: SAFE,
      logicalTx: 'verdict:openVerdictAttempt',
    } satisfies Partial<SafeExecutionRevertedError>);
    expect(error?.message).toContain(TX_HASH);
    expect(error?.message).toContain(SAFE);
    expect(error?.message).toContain('verdict:openVerdictAttempt');
  });

  it('lets the retry closure re-read the nonce and re-sign, since that race self-heals', () => {
    // The message carries the retry policy's marker for this exact receipt path, so the
    // broadcaster does not have to reach into the classifier to say "retry me".
    const error = new SafeExecutionRevertedError(
      `Safe execTransaction mined with status "reverted" — ${SAFE_STALE_NONCE_ERROR_TOKEN}:`
      + ` tx ${TX_HASH} for Safe ${SAFE} (verdict:claimVerdictDelivery)`,
      TX_HASH,
      SAFE,
      'verdict:claimVerdictDelivery',
    );
    expect(isRecoverableTransactionError(error)).toBe(true);
  });
});

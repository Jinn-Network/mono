import { describe, expect, it, vi } from 'vitest';
import {
  createMemoryTxSubmissionLedger,
  flattenErrorMessage,
  isRecoverableTransactionError,
  recoverStuckNonceIfNeeded,
  viemSendTransactionWithRetry,
  withRecoverableRetry,
  viemFeeOverridesForAttempt,
  waitForContractCode,
} from '../src/tx-retry.js';
import { SafeInnerRevertError } from '../src/adapters/mech/safe-revert.js';

describe('tx-retry', () => {
  describe('flattenErrorMessage', () => {
    it('includes viem-style shortMessage and details', () => {
      const err = {
        shortMessage: 'RPC Error',
        details: '-32603: internal error',
      };
      expect(flattenErrorMessage(err)).toContain('RPC Error');
      expect(flattenErrorMessage(err)).toContain('-32603');
    });

    it('walks Error cause chain', () => {
      const inner = new Error('replacement fee too low');
      const outer = new Error('wrapped') as Error & { cause?: unknown };
      outer.cause = inner;
      expect(flattenErrorMessage(outer)).toContain('replacement fee too low');
    });
  });

  describe('isRecoverableTransactionError', () => {
    it('returns true for GS026', () => {
      expect(isRecoverableTransactionError(new Error('GS026 invalid owner'))).toBe(true);
    });

    it('returns true for GS013 (Safe 1.3.0 wraps GS026/nonce-race as GS013)', () => {
      const safeWrappedError = new Error(
        'The contract function "execTransaction" reverted with the following reason:\nGS013',
      );
      expect(isRecoverableTransactionError(safeWrappedError)).toBe(true);
    });

    it('returns true for replacement underpriced', () => {
      expect(
        isRecoverableTransactionError(new Error('replacement transaction underpriced')),
      ).toBe(true);
    });

    it('returns true for JSON-RPC internal error text', () => {
      expect(isRecoverableTransactionError(new Error('Internal JSON-RPC error (-32603).'))).toBe(
        true,
      );
    });

    it('returns false for insufficient funds', () => {
      expect(isRecoverableTransactionError(new Error('insufficient funds for gas'))).toBe(false);
    });

    it('returns false for terminal JinnRouterV3 Safe inner reverts', () => {
      const requestId = `0x${'11'.repeat(32)}` as `0x${string}`;
      const error = new SafeInnerRevertError(
        'Safe execTransaction inner revert (estimate): RouterWrongRequestKind',
        '0x51cba8b3',
        null,
        'RouterWrongRequestKind',
        [requestId, 1, 2],
        null,
      );

      expect(isRecoverableTransactionError(error)).toBe(false);
    });

    it('returns false for expired TaskCoordinator attempt claims', () => {
      const error = new SafeInnerRevertError(
        'Safe execTransaction inner revert (estimate): TCAttemptClaimExpired',
        '0x1c48587f',
        null,
        'TCAttemptClaimExpired',
        [37n, 0],
        null,
      );

      expect(isRecoverableTransactionError(error)).toBe(false);
    });

    it('returns false for finalized TaskCoordinator attempts', () => {
      const error = new SafeInnerRevertError(
        'Safe execTransaction inner revert (estimate): TCAttemptAlreadyFinalized',
        '0xbe465de7',
        null,
        'TCAttemptAlreadyFinalized',
        [92n, 0],
        null,
      );

      expect(isRecoverableTransactionError(error)).toBe(false);
    });

    it('returns true for RouterNotDelivered because delivery indexing can lag claim retry', () => {
      const requestId = `0x${'22'.repeat(32)}` as `0x${string}`;
      const error = new SafeInnerRevertError(
        'Safe execTransaction inner revert (estimate): RouterNotDelivered',
        '0xe5a88624',
        null,
        'RouterNotDelivered',
        [requestId],
        null,
      );

      expect(isRecoverableTransactionError(error)).toBe(true);
    });

    it('returns true for "returned no data" — multi-node RPC eventual consistency', () => {
      // When a Safe is deployed in tx N and the daemon immediately reads
      // Safe.nonce(), Tenderly's load-balanced RPC sometimes hits a sibling
      // node that has not yet propagated the new contract. viem surfaces this
      // as 'The contract function "nonce" returned no data ("0x").' — the
      // daemon must retry, not bail.
      expect(isRecoverableTransactionError(
        new Error('The contract function "nonce" returned no data ("0x").'),
      )).toBe(true);
      expect(isRecoverableTransactionError(
        new Error('Cannot decode zero data ("0x") with ABI parameters.'),
      )).toBe(true);
      expect(isRecoverableTransactionError(
        new Error('something happened\n  - The address is not a contract.'),
      )).toBe(true);
    });

    it('returns false for user rejection', () => {
      expect(isRecoverableTransactionError(new Error('user rejected the request'))).toBe(false);
    });
  });

  describe('withRecoverableRetry', () => {
    it('retries on recoverable errors then succeeds', async () => {
      let calls = 0;
      await expect(
        withRecoverableRetry(
          async () => {
            calls++;
            if (calls < 3) {
              throw new Error('GS026');
            }
            return 'ok';
          },
          { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 5 },
        ),
      ).resolves.toBe('ok');
      expect(calls).toBe(3);
    });

    it('does not retry non-recoverable errors', async () => {
      let calls = 0;
      await expect(
        withRecoverableRetry(
          async () => {
            calls++;
            throw new Error('insufficient funds');
          },
          { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 5 },
        ),
      ).rejects.toThrow('insufficient funds');
      expect(calls).toBe(1);
    });
  });

  describe('waitForContractCode', () => {
    const ADDR = '0x17397Dc17f2630EC603B1AC5F62F3A84B2fe3C8e' as const;

    it('returns bytecode immediately when code is present on first call', async () => {
      const getCode = vi.fn().mockResolvedValue('0xdeadbeef');
      const publicClient = { getCode };
      const code = await waitForContractCode(publicClient as never, ADDR, {
        maxAttempts: 5,
        baseDelayMs: 1,
        maxDelayMs: 2,
      });
      expect(code).toBe('0xdeadbeef');
      expect(getCode).toHaveBeenCalledTimes(1);
    });

    it('retries while getCode returns 0x and resolves once bytecode is present (RPC propagation race)', async () => {
      const getCode = vi
        .fn()
        .mockResolvedValueOnce('0x')
        .mockResolvedValueOnce('0x')
        .mockResolvedValueOnce('0xdeadbeef');
      const publicClient = { getCode };
      const code = await waitForContractCode(publicClient as never, ADDR, {
        maxAttempts: 5,
        baseDelayMs: 1,
        maxDelayMs: 2,
      });
      expect(code).toBe('0xdeadbeef');
      expect(getCode).toHaveBeenCalledTimes(3);
    });

    it('throws after maxAttempts when getCode keeps returning 0x', async () => {
      const getCode = vi.fn().mockResolvedValue('0x');
      const publicClient = { getCode };
      await expect(
        waitForContractCode(publicClient as never, ADDR, {
          maxAttempts: 3,
          baseDelayMs: 1,
          maxDelayMs: 2,
        }),
      ).rejects.toThrow(/no contract code/i);
      expect(getCode).toHaveBeenCalledTimes(3);
    });

    it('throws after maxAttempts when getCode returns undefined', async () => {
      const getCode = vi.fn().mockResolvedValue(undefined);
      const publicClient = { getCode };
      await expect(
        waitForContractCode(publicClient as never, ADDR, {
          maxAttempts: 2,
          baseDelayMs: 1,
          maxDelayMs: 2,
        }),
      ).rejects.toThrow(/no contract code/i);
      expect(getCode).toHaveBeenCalledTimes(2);
    });
  });

  describe('viemFeeOverridesForAttempt', () => {
    it('returns empty object on first attempt', async () => {
      const publicClient = {
        estimateFeesPerGas: vi.fn(),
        getGasPrice: vi.fn(),
      };
      const o = await viemFeeOverridesForAttempt(publicClient as never, 0);
      expect(o).toEqual({});
      expect(publicClient.estimateFeesPerGas).not.toHaveBeenCalled();
    });

    it('bumps fees on later attempts when estimateFeesPerGas succeeds', async () => {
      const publicClient = {
        estimateFeesPerGas: vi.fn().mockResolvedValue({
          maxFeePerGas: 100n,
          maxPriorityFeePerGas: 10n,
        }),
        getGasPrice: vi.fn(),
      };
      const o = await viemFeeOverridesForAttempt(publicClient as never, 2);
      expect('maxFeePerGas' in o && o.maxFeePerGas).toBe(130n);
      expect('maxPriorityFeePerGas' in o && o.maxPriorityFeePerGas).toBe(13n);
    });

    it('bumps EIP-1559 replacement fees from the previous submitted fee when the fresh estimate is lower', async () => {
      const publicClient = {
        estimateFeesPerGas: vi.fn().mockResolvedValue({
          maxFeePerGas: 90n,
          maxPriorityFeePerGas: 9n,
        }),
        getGasPrice: vi.fn(),
      };
      const o = await viemFeeOverridesForAttempt(publicClient as never, 1, {
        previousFees: {
          maxFeePerGas: 100n,
          maxPriorityFeePerGas: 10n,
        },
      });
      expect(o).toEqual({
        maxFeePerGas: 115n,
        maxPriorityFeePerGas: 12n,
      });
    });

    it('bumps legacy replacement gasPrice from the previous submitted fee when the fresh estimate is lower', async () => {
      const publicClient = {
        estimateFeesPerGas: vi.fn().mockRejectedValue(new Error('legacy chain')),
        getGasPrice: vi.fn().mockResolvedValue(90n),
      };
      const o = await viemFeeOverridesForAttempt(publicClient as never, 1, {
        previousFees: { gasPrice: 100n },
      });
      expect(o).toEqual({ gasPrice: 115n });
    });
  });

  describe('viemSendTransactionWithRetry', () => {
    const account = {
      address: '0x1111111111111111111111111111111111111111',
    } as const;

    it('pins an explicit EOA nonce across replacement retries', async () => {
      const publicClient = {
        getChainId: vi.fn().mockResolvedValue(84532),
        getTransactionCount: vi.fn().mockResolvedValue(7),
        estimateFeesPerGas: vi.fn().mockResolvedValue({
          maxFeePerGas: 100n,
          maxPriorityFeePerGas: 10n,
        }),
        getGasPrice: vi.fn(),
      };
      const sendTransaction = vi
        .fn()
        .mockRejectedValueOnce(new Error('replacement transaction underpriced'))
        .mockResolvedValueOnce(`0x${'aa'.repeat(32)}`);

      await expect(
        viemSendTransactionWithRetry(
          { sendTransaction },
          publicClient as never,
          {
            account,
            to: '0x2222222222222222222222222222222222222222',
            value: 1n,
          },
          { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
        ),
      ).resolves.toBe(`0x${'aa'.repeat(32)}`);

      expect(sendTransaction).toHaveBeenCalledTimes(2);
      expect(sendTransaction.mock.calls[0]![0].nonce).toBe(7);
      expect(sendTransaction.mock.calls[1]![0].nonce).toBe(7);
    });
  });

  describe('stuck nonce recovery', () => {
    it('detects an old unresolved nonce and clears it with a bumped self-transfer', async () => {
      const from = '0x1111111111111111111111111111111111111111' as const;
      const ledger = createMemoryTxSubmissionLedger();
      await ledger.recordTxSubmission({
        chainId: 84532,
        from,
        nonce: 7,
        hash: `0x${'11'.repeat(32)}`,
        logicalTx: 'safe.execTransaction',
        submittedAtMs: 1_000,
        fees: {
          maxFeePerGas: 100n,
          maxPriorityFeePerGas: 10n,
        },
      });
      const publicClient = {
        getChainId: vi.fn().mockResolvedValue(84532),
        getTransactionCount: vi
          .fn()
          .mockResolvedValueOnce(8)
          .mockResolvedValueOnce(7),
        estimateFeesPerGas: vi.fn().mockResolvedValue({
          maxFeePerGas: 80n,
          maxPriorityFeePerGas: 8n,
        }),
        getGasPrice: vi.fn(),
        waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }),
      };
      const sendTransaction = vi.fn().mockResolvedValue(`0x${'22'.repeat(32)}`);
      const walletClient = {
        account: { address: from },
        sendTransaction,
      };

      const result = await recoverStuckNonceIfNeeded({
        publicClient: publicClient as never,
        walletClient,
        ledger,
        from,
        staleAfterMs: 30_000,
        nowMs: 61_000,
      });

      expect(result?.recoveryHash).toBe(`0x${'22'.repeat(32)}`);
      expect(sendTransaction).toHaveBeenCalledWith({
        account: walletClient.account,
        to: from,
        value: 0n,
        nonce: 7,
        maxFeePerGas: 115n,
        maxPriorityFeePerGas: 12n,
      });
      const resolved = await ledger.getTxSubmission({ chainId: 84532, from, nonce: 7 });
      expect(resolved?.resolvedAtMs).toBe(61_000);
    });
  });
});

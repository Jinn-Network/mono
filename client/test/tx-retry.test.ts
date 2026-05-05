import { describe, expect, it, vi } from 'vitest';
import {
  flattenErrorMessage,
  isRecoverableTransactionError,
  withRecoverableRetry,
  viemFeeOverridesForAttempt,
} from '../src/tx-retry.js';

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
  });
});

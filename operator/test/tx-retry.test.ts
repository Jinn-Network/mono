import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMemoryTxSubmissionLedger,
  flattenErrorMessage,
  getDefaultEoaBroadcastLock,
  isRecoverableTransactionError,
  isReplacementUnderpricedError,
  recoverStuckNonceIfNeeded,
  resetDefaultEoaBroadcastLockForTesting,
  setDefaultEoaBroadcastLock,
  viemSendTransactionWithRetry,
  withEoaBroadcastLock,
  withRecoverableRetry,
  withNonceLedger,
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
    it('returns false for GS026 — invalid owner is deterministic (issue #1986)', () => {
      expect(isRecoverableTransactionError(new Error('GS026 invalid owner'))).toBe(false);
    });

    it('returns false for a bare GS013 — the Safe inner call reverted (deterministic)', () => {
      // GS013 = require(success || safeTxGas != 0 || gasPrice != 0): the Safe's
      // INNER call reverted, which is deterministic — it reverts identically on
      // every retry. (An estimate-path GS026 is classified after checking Safe
      // ownership; receipt-path races use a dedicated retryable message.)
      // Retrying it forever wedges the loop; observed on testnet wrapping
      // TACTaskAlreadyCredited (selector 0x33f626d3). It must be terminal.
      const safeWrappedError = new Error(
        'The contract function "execTransaction" reverted with the following reason:\nGS013',
      );
      expect(isRecoverableTransactionError(safeWrappedError)).toBe(false);
    });

    it('returns false for a SafeInnerRevertError carrying an undecoded custom-error selector', () => {
      // Receipt path: the Safe execution reverted on-chain and re-simulating the
      // inner call reverts with a selector we don't decode (e.g. the on-chain
      // dedup guard TACTaskAlreadyCredited, 0x33f626d3, not in KNOWN_INNER_ERRORS).
      // A deterministic inner revert never clears on retry — terminal — even
      // though the wrapping message still mentions GS013.
      const error = new SafeInnerRevertError(
        'Safe execTransaction inner revert (undecoded selector 0x33f626d3, txHash=0xabc)\nGS013',
        '0x33f626d3',
        '0x33f626d3',
        null,
        null,
        `0x${'ab'.repeat(32)}` as `0x${string}`,
      );
      expect(isRecoverableTransactionError(error)).toBe(false);
    });

    it('keeps the receipt-path stale-nonce race message retryable when no inner revert was found', () => {
      // safe.ts emits this ONLY when re-simulating the inner call SUCCEEDS — a
      // signature/nonce race that re-reading the nonce and re-signing self-heals.
      // The message must not embed GS026/GS013: bare GS026 is terminal (invalid
      // owner) and bare GS013 is terminal (inner revert). Issue #1986.
      const error = new Error(
        'Safe execTransaction reverted (possible stale Safe nonce or signature race, txHash=0xdead)',
      );
      expect(isRecoverableTransactionError(error)).toBe(true);
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

    it('returns true for the viem fallback "All RPC providers ... failed" transient', () => {
      // Daemon-observed: an execTransaction whose eth_estimateGas/eth_call
      // transiently failed on every provider in the fallback chain at once.
      // There is no decodable inner revert (those are caught by
      // SafeInnerRevertError / GS013 / GS026 first), so this is a transient
      // transport failure — the next attempt hits a healthy provider. It must
      // retry, not fail the task. Before this case, claim/deliver tasks failed
      // immediately on a transient all-providers blip.
      const error = new Error(
        'An unknown error occurred while executing the contract function "execTransaction".\n' +
          'Details: All RPC providers in the fallback chain failed ' +
          '(providers=base-sepolia.publicnode.com, base-sepolia.gateway.tenderly.co, sepolia.base.org)',
      );
      expect(isRecoverableTransactionError(error)).toBe(true);
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
              throw new Error(
                'Safe execTransaction reverted (possible stale Safe nonce or signature race, txHash=0xdead)',
              );
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

    it('refreshes pinned nonce after `nonce too low` revert', async () => {
      // Issue #562: when the daemon respawns and the local ledger pins a stale
      // nonce M but the RPC has already advanced to N, the retry must re-derive
      // the pending nonce via getTransactionCount and resubmit with N, not M.
      //
      // viemSendTransactionWithRetry enters withNonceLedger with
      // recoverStuckNonce: true, so getTransactionCount is called for
      // (1) recoverStuckNonceIfNeeded pending, (2) recoverStuckNonceIfNeeded
      // latest, (3) withNonceLedger initial pin, (4) refreshNonce after revert.
      const publicClient = {
        getChainId: vi.fn().mockResolvedValue(84532),
        getTransactionCount: vi
          .fn()
          .mockResolvedValueOnce(7) // recoverStuckNonce pending
          .mockResolvedValueOnce(7) // recoverStuckNonce latest (equal -> no recovery)
          .mockResolvedValueOnce(7) // initial pin via withNonceLedger
          .mockResolvedValueOnce(8), // refresh after nonce-too-low revert
        estimateFeesPerGas: vi.fn().mockResolvedValue({
          maxFeePerGas: 100n,
          maxPriorityFeePerGas: 10n,
        }),
        getGasPrice: vi.fn(),
      };
      const sendTransaction = vi
        .fn()
        .mockRejectedValueOnce(new Error('nonce too low: next nonce 8, tx nonce 7'))
        .mockResolvedValueOnce(`0x${'bb'.repeat(32)}`);

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
      ).resolves.toBe(`0x${'bb'.repeat(32)}`);

      expect(sendTransaction).toHaveBeenCalledTimes(2);
      expect(sendTransaction.mock.calls[0]![0].nonce).toBe(7);
      expect(sendTransaction.mock.calls[1]![0].nonce).toBe(8);
    });

    it('journals a successful broadcast before nonce-ledger bookkeeping and never retries it', async () => {
      const txHash = `0x${'cc'.repeat(32)}` as const;
      const onBroadcast = vi.fn();
      const publicClient = {
        getChainId: vi.fn().mockResolvedValue(84532),
        getTransactionCount: vi.fn().mockResolvedValue(7),
        estimateFeesPerGas: vi.fn().mockResolvedValue({
          maxFeePerGas: 100n,
          maxPriorityFeePerGas: 10n,
        }),
        getGasPrice: vi.fn(),
      };
      const sendTransaction = vi.fn().mockResolvedValue(txHash);
      const ledger = {
        getTxSubmission: vi.fn().mockResolvedValue(null),
        recordTxSubmission: vi.fn().mockImplementation(async () => {
          expect(onBroadcast).toHaveBeenCalledWith(txHash);
          throw new Error('network timeout writing nonce ledger');
        }),
        markTxSubmissionResolved: vi.fn(),
      };

      const error = await viemSendTransactionWithRetry(
        { sendTransaction },
        publicClient as never,
        {
          account,
          to: '0x2222222222222222222222222222222222222222',
          value: 1n,
        },
        {
          ledger,
          maxAttempts: 2,
          baseDelayMs: 1,
          maxDelayMs: 1,
          onBroadcast,
        },
      ).catch((caught: unknown) => caught);

      expect(error).toMatchObject({ txHash });
      expect(onBroadcast).toHaveBeenCalledTimes(1);
      expect(sendTransaction).toHaveBeenCalledTimes(1);
      expect(ledger.recordTxSubmission).toHaveBeenCalledTimes(1);
    });
  });

  describe('withNonceLedger', () => {
    it('resolves chain/from/nonce once and records submissions through the provided ledger', async () => {
      const from = '0x1111111111111111111111111111111111111111' as const;
      const ledger = createMemoryTxSubmissionLedger();
      await ledger.recordTxSubmission({
        chainId: 84532,
        from,
        nonce: 7,
        hash: `0x${'11'.repeat(32)}`,
        logicalTx: 'previous',
        submittedAtMs: 1_000,
        fees: {
          maxFeePerGas: 100n,
          maxPriorityFeePerGas: 10n,
        },
      });
      const publicClient = {
        getChainId: vi.fn().mockResolvedValue(84532),
        getTransactionCount: vi.fn().mockResolvedValue(7),
        estimateFeesPerGas: vi.fn().mockResolvedValue({
          maxFeePerGas: 80n,
          maxPriorityFeePerGas: 8n,
        }),
        getGasPrice: vi.fn(),
      };

      const result = await withNonceLedger(
        {
          publicClient: publicClient as never,
          ledger,
          from,
        },
        async (nonceLedger) => {
          expect(nonceLedger.chainId).toBe(84532);
          expect(nonceLedger.from).toBe(from);
          expect(nonceLedger.nonce).toBe(7);

          const feeResult = await nonceLedger.feeResultForAttempt(1, {
            forceEstimate: true,
          });
          expect(feeResult).toMatchObject({
            kind: 'eip1559',
            overrides: {
              maxFeePerGas: 115n,
              maxPriorityFeePerGas: 12n,
            },
          });

          await nonceLedger.recordSubmitted({
            hash: `0x${'22'.repeat(32)}`,
            logicalTx: 'helper.test',
            fees: feeResult.snapshot,
            to: '0x2222222222222222222222222222222222222222',
            value: 1n,
            data: '0x1234',
            submittedAtMs: 2_000,
          });
          await nonceLedger.markResolved(3_000);
          return 'ok';
        },
      );

      expect(result).toBe('ok');
      expect(publicClient.getChainId).toHaveBeenCalledTimes(1);
      expect(publicClient.getTransactionCount).toHaveBeenCalledWith({
        address: from,
        blockTag: 'pending',
      });
      const submitted = await ledger.getTxSubmission({ chainId: 84532, from, nonce: 7 });
      expect(submitted).toMatchObject({
        hash: `0x${'22'.repeat(32)}`,
        logicalTx: 'helper.test',
        resolvedAtMs: 3_000,
        fees: {
          maxFeePerGas: 115n,
          maxPriorityFeePerGas: 12n,
        },
      });
    });

    it('NonceLedgerContext.refreshNonce re-reads pending nonce and updates context.nonce', async () => {
      const from = '0x1111111111111111111111111111111111111111' as const;
      const ledger = createMemoryTxSubmissionLedger();
      const getTransactionCount = vi
        .fn()
        .mockResolvedValueOnce(5) // initial pin
        .mockResolvedValueOnce(9); // refreshNonce read
      const publicClient = {
        getChainId: vi.fn().mockResolvedValue(84532),
        getTransactionCount,
        estimateFeesPerGas: vi.fn(),
        getGasPrice: vi.fn(),
      };

      await withNonceLedger(
        {
          publicClient: publicClient as never,
          ledger,
          from,
        },
        async (nonceLedger) => {
          expect(nonceLedger.nonce).toBe(5);
          const refreshed = await nonceLedger.refreshNonce();
          expect(refreshed).toBe(9);
          expect(nonceLedger.nonce).toBe(9);
        },
      );

      expect(getTransactionCount).toHaveBeenCalledTimes(2);
      for (const call of getTransactionCount.mock.calls) {
        expect(call[0]).toMatchObject({ address: from, blockTag: 'pending' });
      }
    });

    it('records the submission/resolution and reads prior fees under the REFRESHED nonce after refreshNonce() (D0a round-2 minor)', async () => {
      // `executeSafeTxBatch` hits "nonce too low", calls `nonceLedger.refreshNonce()`, then
      // retries and broadcasts at the refreshed nonce. `recordSubmitted`/`markResolved`/
      // `feeResultForAttempt` must all key off that refreshed nonce -- otherwise the ledger gets a
      // permanently-unresolved phantom entry at the STALE nonce (that `recoverStuckNonceIfNeeded`
      // can later act on) and no entry at the nonce actually broadcast, plus a fee bump computed
      // against the wrong prior transaction.
      const from = '0x1111111111111111111111111111111111111111' as const;
      const ledger = createMemoryTxSubmissionLedger();
      const getTransactionCount = vi
        .fn()
        .mockResolvedValueOnce(5) // initial pin
        .mockResolvedValueOnce(9); // refreshNonce read after "nonce too low"
      const publicClient = {
        getChainId: vi.fn().mockResolvedValue(84532),
        getTransactionCount,
        estimateFeesPerGas: vi.fn().mockResolvedValue({
          maxFeePerGas: 80n,
          maxPriorityFeePerGas: 8n,
        }),
        getGasPrice: vi.fn(),
      };

      await withNonceLedger(
        {
          publicClient: publicClient as never,
          ledger,
          from,
        },
        async (nonceLedger) => {
          expect(nonceLedger.nonce).toBe(5);
          await nonceLedger.refreshNonce();
          expect(nonceLedger.nonce).toBe(9);

          // Reads fees under the REFRESHED key -- there is no prior submission at nonce 9, so no
          // previousFees, and no failure looking up a submission recorded under nonce 5.
          const feeResult = await nonceLedger.feeResultForAttempt(0, { forceEstimate: true });
          expect(feeResult.kind).toBe('eip1559');

          await nonceLedger.recordSubmitted({
            hash: `0x${'33'.repeat(32)}`,
            logicalTx: 'retry-after-refresh',
            fees: feeResult.snapshot,
            to: '0x2222222222222222222222222222222222222222',
            value: 1n,
            data: '0x',
            submittedAtMs: 4_000,
          });
          await nonceLedger.markResolved(5_000);
        },
      );

      const atRefreshedNonce = await ledger.getTxSubmission({ chainId: 84532, from, nonce: 9 });
      expect(atRefreshedNonce).toMatchObject({
        hash: `0x${'33'.repeat(32)}`,
        logicalTx: 'retry-after-refresh',
        resolvedAtMs: 5_000,
      });

      // No phantom entry ever got written or left unresolved under the stale, pre-refresh nonce.
      const atStaleNonce = await ledger.getTxSubmission({ chainId: 84532, from, nonce: 5 });
      expect(atStaleNonce).toBeNull();
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
        chainId: 84532,
        staleAfterMs: 30_000,
        nowMs: 61_000,
      });

      expect(publicClient.getChainId).not.toHaveBeenCalled();
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

  describe('per-EOA broadcast serialization (issue #525 nonce-collision)', () => {
    /**
     * Build a simulated chain whose `pending` transaction count only advances
     * when a previously-sent tx is "mined". `sendTransaction` is intentionally
     * async (a microtask hop) so that, WITHOUT serialization, two concurrent
     * broadcasters would both read the same pending nonce before either sends —
     * exactly the race that reverted the #525 launch `setMetadata` with
     * "nonce too low".
     */
    function makeSimulatedEoaChain(startNonce: number) {
      let pending = startNonce;
      const sentNonces: number[] = [];
      let nonceTooLowThrows = 0;
      const publicClient = {
        getChainId: vi.fn().mockResolvedValue(84532),
        // Same value for pending + latest so recoverStuckNonceIfNeeded is a no-op.
        getTransactionCount: vi.fn(async () => pending),
        estimateFeesPerGas: vi.fn().mockResolvedValue({
          maxFeePerGas: 100n,
          maxPriorityFeePerGas: 10n,
        }),
        getGasPrice: vi.fn(),
      };
      const sendTransaction = vi.fn(async (tx: { nonce?: number }) => {
        // Yield so concurrent callers interleave their nonce reads if unguarded.
        await Promise.resolve();
        const nonce = tx.nonce ?? pending;
        if (nonce < pending) {
          // The RPC's "nonce too low" signal for a reused/stale nonce.
          nonceTooLowThrows += 1;
          throw new Error(`nonce too low: next nonce ${pending}, tx nonce ${nonce}`);
        }
        sentNonces.push(nonce);
        pending = nonce + 1; // tx accepted into the pool; pending advances
        return `0x${nonce.toString(16).padStart(64, '0')}` as `0x${string}`;
      });
      return {
        publicClient,
        sendTransaction,
        sentNonces,
        nonceTooLow: () => nonceTooLowThrows,
      };
    }

    const account = { address: '0x9999999999999999999999999999999999999999' } as const;
    const to = '0x2222222222222222222222222222222222222222' as const;

    it('serializes concurrent same-EOA broadcasts so they get distinct nonces without colliding', async () => {
      const { publicClient, sendTransaction, sentNonces, nonceTooLow } =
        makeSimulatedEoaChain(42);
      const ledger = createMemoryTxSubmissionLedger();

      // Fire three broadcasts from the SAME EOA concurrently. With the per-EOA
      // lock they queue strictly (42, 43, 44) and NO "nonce too low" collision
      // is ever observed — so sendTransaction is called exactly 3 times. Without
      // the lock all three read pending=42 and two collide; the #562 retry would
      // eventually heal them, but the collision (the bug) would still occur. We
      // assert the collision count is zero, which isolates the lock as the fix
      // rather than masking it behind retry.
      const results = await Promise.all([
        viemSendTransactionWithRetry(
          { sendTransaction }, publicClient as never,
          { account, to, value: 1n }, { ledger, maxAttempts: 6, baseDelayMs: 1, maxDelayMs: 1 },
        ),
        viemSendTransactionWithRetry(
          { sendTransaction }, publicClient as never,
          { account, to, value: 1n }, { ledger, maxAttempts: 6, baseDelayMs: 1, maxDelayMs: 1 },
        ),
        viemSendTransactionWithRetry(
          { sendTransaction }, publicClient as never,
          { account, to, value: 1n }, { ledger, maxAttempts: 6, baseDelayMs: 1, maxDelayMs: 1 },
        ),
      ]);

      // Three distinct nonces, all succeeded.
      expect(results).toHaveLength(3);
      expect([...sentNonces].sort((a, b) => a - b)).toEqual([42, 43, 44]);
      expect(new Set(sentNonces).size).toBe(3);
      // The core invariant: the per-EOA lock prevented the collision entirely —
      // no "nonce too low" was ever thrown, and sendTransaction ran exactly once
      // per broadcaster (no collision-induced retries).
      expect(nonceTooLow()).toBe(0);
      expect(sendTransaction).toHaveBeenCalledTimes(3);
    });

    it('does not serialize broadcasts from different EOAs (no cross-EOA blocking)', async () => {
      const order: string[] = [];
      let releaseA!: () => void;
      const aInside = new Promise<void>((resolve) => { releaseA = resolve; });

      // Hold the lock for EOA A open; B (different EOA) must still proceed.
      const aPromise = withEoaBroadcastLock(
        '0xaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaA' as never,
        async () => {
          order.push('a-start');
          await aInside; // block until we explicitly release
          order.push('a-end');
        },
      );
      const bPromise = withEoaBroadcastLock(
        '0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb' as never,
        async () => {
          order.push('b-ran');
        },
      );

      await bPromise;            // B completes without waiting for A
      expect(order).toContain('b-ran');
      expect(order).not.toContain('a-end'); // A still held open
      releaseA();
      await aPromise;
      expect(order).toContain('a-end');
    });

    it('releases the per-EOA lock when the guarded fn rejects (no deadlock)', async () => {
      const key = '0xcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcC' as never;
      await expect(
        withEoaBroadcastLock(key, async () => { throw new Error('boom'); }),
      ).rejects.toThrow('boom');
      // A subsequent acquisition must not hang — the lock was released.
      await expect(
        withEoaBroadcastLock(key, async () => 'ok'),
      ).resolves.toBe('ok');
    });
  });

  // D0a round-1 review (important finding): `setDefaultEoaBroadcastLock` installs a
  // PROCESS-GLOBAL lock as module state, contradicting the "no process-global broadcaster"
  // invariant (`adapters/mech/safe.ts`) -- a process that composes two venues had the second
  // install silently clobber the first with no reset hook. It must now refuse a conflicting
  // install instead of silently rebinding.
  describe('setDefaultEoaBroadcastLock (D0a round 1: refuse a conflicting install)', () => {
    afterEach(() => {
      resetDefaultEoaBroadcastLockForTesting();
    });

    it('accepts a second install under the SAME key (idempotent re-install)', () => {
      const lockA: ReturnType<typeof getDefaultEoaBroadcastLock> = { withSender: (_s, fn) => fn() };
      const lockB: ReturnType<typeof getDefaultEoaBroadcastLock> = { withSender: (_s, fn) => fn() };
      setDefaultEoaBroadcastLock(lockA, 'chain-84532:/tmp/venue-a.db');
      expect(() => setDefaultEoaBroadcastLock(lockB, 'chain-84532:/tmp/venue-a.db')).not.toThrow();
      expect(getDefaultEoaBroadcastLock()).toBe(lockB);
    });

    it('refuses a second install under a DIFFERENT key instead of silently clobbering it', () => {
      const lockA: ReturnType<typeof getDefaultEoaBroadcastLock> = { withSender: (_s, fn) => fn() };
      const lockB: ReturnType<typeof getDefaultEoaBroadcastLock> = { withSender: (_s, fn) => fn() };
      setDefaultEoaBroadcastLock(lockA, 'chain-84532:/tmp/venue-a.db');
      expect(() => setDefaultEoaBroadcastLock(lockB, 'chain-84532:/tmp/venue-b.db')).toThrow(
        /venue-a\.db/,
      );
      // The original install must still be in effect -- the throw must not have clobbered it.
      expect(getDefaultEoaBroadcastLock()).toBe(lockA);
    });

    it('resetDefaultEoaBroadcastLockForTesting clears the installed key, allowing a fresh install', () => {
      const lockA: ReturnType<typeof getDefaultEoaBroadcastLock> = { withSender: (_s, fn) => fn() };
      const lockB: ReturnType<typeof getDefaultEoaBroadcastLock> = { withSender: (_s, fn) => fn() };
      setDefaultEoaBroadcastLock(lockA, 'chain-84532:/tmp/venue-a.db');
      resetDefaultEoaBroadcastLockForTesting();
      expect(() => setDefaultEoaBroadcastLock(lockB, 'chain-84532:/tmp/venue-b.db')).not.toThrow();
      expect(getDefaultEoaBroadcastLock()).toBe(lockB);
    });
  });

  describe('isReplacementUnderpricedError', () => {
    it('matches replacement-underpriced RPC messages', () => {
      expect(isReplacementUnderpricedError(new Error('replacement transaction underpriced'))).toBe(true);
      expect(isReplacementUnderpricedError(new Error('replacement fee too low'))).toBe(true);
      expect(isReplacementUnderpricedError(new Error('transaction underpriced'))).toBe(true);
    });

    it('does not match nonce-too-low or unrelated errors', () => {
      expect(isReplacementUnderpricedError(new Error('nonce too low'))).toBe(false);
      expect(isReplacementUnderpricedError(new Error('insufficient funds'))).toBe(false);
    });
  });
});

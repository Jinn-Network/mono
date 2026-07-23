import { describe, it, expect, vi } from 'vitest';
import type { Hex } from 'viem';
import { baseSepolia } from 'viem/chains';
import { buildSafeSignature, createClients, executeSafeTransaction } from '../../../src/adapters/mech/safe.js';
import { createMemoryTxSubmissionLedger, isRecoverableTransactionError } from '../../../src/tx-retry.js';

const TEST_PRIVATE_KEY = `0x${'22'.repeat(32)}` as const;
const TEST_SIGNER_ADDRESS = '0x000000000000000000000000000000000000bEEF' as const;
const TEST_SAFE_ADDRESS = '0x2222222222222222222222222222222222222222' as const;
const TEST_TARGET_ADDRESS = '0x3333333333333333333333333333333333333333' as const;
const TEST_CALL_DATA = '0xdeadbeef' as Hex;
const TEST_SAFE_TX_HASH = `0x${'77'.repeat(32)}` as Hex;
const TEST_SAFE_SIGNATURE = `0x${'ab'.repeat(32)}${'cd'.repeat(32)}1b` as Hex;
const TEST_SUCCESS_HASH = `0x${'cc'.repeat(32)}` as Hex;

describe('Safe utilities', () => {
  it('builds a pre-validated signature from an EOA address', () => {
    const address = '0x1234567890123456789012345678901234567890';
    const sig = buildSafeSignature(address);
    expect(sig).toMatch(/^0x/);
    expect(sig.length).toBe(2 + 130); // 0x + 65 bytes hex
  });
});

describe('createClients (AC1: string-or-array RPC input)', () => {
  it('builds a fallback transport for an array of URLs', () => {
    const { publicClient, walletClient } = createClients(
      ['https://a.example', 'https://b.example'],
      TEST_PRIVATE_KEY,
      baseSepolia,
    );
    expect(publicClient.transport.type).toBe('fallback');
    expect(walletClient.transport.type).toBe('fallback');
  });

  it('still works for a single-string URL (back-compat)', () => {
    const { publicClient } = createClients('https://a.example', TEST_PRIVATE_KEY, baseSepolia);
    // Single URL still routes through the helper → 1-slot fallback.
    expect(publicClient.transport.type).toBe('fallback');
  });
});

describe('executeSafeTransaction nonce refresh', () => {
  it('refreshes the pinned EOA nonce after a nonce-too-low retry', async () => {
    const writeContract = vi.fn()
      .mockRejectedValueOnce(new Error('nonce too low: next nonce 2302, tx nonce 2301'))
      .mockResolvedValueOnce(TEST_SUCCESS_HASH);
    const signMessage = vi.fn().mockResolvedValue(TEST_SAFE_SIGNATURE);
    const waitForTransactionReceipt = vi.fn().mockResolvedValue({ status: 'success' });
    const readContract = vi.fn(async (args: { functionName: string }) => {
      if (args.functionName === 'nonce') return 0n;
      if (args.functionName === 'getTransactionHash') return TEST_SAFE_TX_HASH;
      throw new Error(`unexpected readContract call: ${args.functionName}`);
    });
    const estimateFeesPerGas = vi.fn().mockResolvedValue({
      maxFeePerGas: 100n,
      maxPriorityFeePerGas: 10n,
    });
    const getGasPrice = vi.fn();
    const getChainId = vi.fn().mockResolvedValue(baseSepolia.id);
    const getTransactionCount = vi.fn(async (args: { blockTag?: string }) => {
      if (args.blockTag === 'latest') return 2301;
      const pendingCalls = getTransactionCount.mock.calls.filter(
        (c) => (c[0] as { blockTag?: string }).blockTag === 'pending',
      ).length;
      return pendingCalls >= 3 ? 2302 : 2301;
    });

    const hash = await executeSafeTransaction(
      {
        getChainId,
        getTransactionCount,
        readContract,
        estimateFeesPerGas,
        getGasPrice,
        waitForTransactionReceipt,
      } as never,
      {
        account: { address: TEST_SIGNER_ADDRESS },
        chain: baseSepolia,
        signMessage,
        writeContract,
      } as never,
      {
        safeAddress: TEST_SAFE_ADDRESS,
        to: TEST_TARGET_ADDRESS,
        value: 0n,
        data: TEST_CALL_DATA,
      },
      { ledger: createMemoryTxSubmissionLedger() },
    );

    expect(hash).toBe(TEST_SUCCESS_HASH);
    expect(writeContract).toHaveBeenCalledTimes(2);
    expect(writeContract.mock.calls[0]![0]).toMatchObject({ nonce: 2301 });
    expect(writeContract.mock.calls[1]![0]).toMatchObject({ nonce: 2302 });
  });
});

describe('executeSafeTransaction reconcile-first (issue #897)', () => {
  const ORIGINAL_HASH = `0x${'11'.repeat(32)}` as Hex;
  const CHAIN_ID = baseSepolia.id;
  const PINNED_NONCE = 2301;

  it('reconciles to the mined original tx on replacement-underpriced instead of re-signing (AC3)', async () => {
    // Seed the ledger so the entry for the pinned nonce already carries the
    // hash of the original delivery tx submitted on a prior attempt.
    const ledger = createMemoryTxSubmissionLedger();
    await ledger.recordTxSubmission({
      chainId: CHAIN_ID,
      from: TEST_SIGNER_ADDRESS,
      nonce: PINNED_NONCE,
      hash: ORIGINAL_HASH,
      logicalTx: 'safe.execTransaction',
      submittedAtMs: Date.now(),
      fees: { maxFeePerGas: 100n, maxPriorityFeePerGas: 10n },
      to: TEST_SAFE_ADDRESS,
      value: 0n,
      data: TEST_CALL_DATA,
    });

    // Attempt 0 (the bump) fails replacement-underpriced; the original tx
    // mined mid-bump. The loop must reconcile, NOT re-sign.
    const writeContract = vi
      .fn()
      .mockRejectedValue(new Error('replacement transaction underpriced'));
    const signMessage = vi.fn().mockResolvedValue(TEST_SAFE_SIGNATURE);
    // The original tx is now mined and successful.
    const getTransactionReceipt = vi.fn(async (args: { hash: Hex }) => {
      if (args.hash === ORIGINAL_HASH) return { status: 'success' };
      throw new Error(`unexpected getTransactionReceipt: ${args.hash}`);
    });
    const waitForTransactionReceipt = vi.fn().mockResolvedValue({ status: 'success' });
    const readContract = vi.fn(async (args: { functionName: string }) => {
      if (args.functionName === 'nonce') return 0n;
      if (args.functionName === 'getTransactionHash') return TEST_SAFE_TX_HASH;
      throw new Error(`unexpected readContract call: ${args.functionName}`);
    });
    const estimateFeesPerGas = vi.fn().mockResolvedValue({
      maxFeePerGas: 100n,
      maxPriorityFeePerGas: 10n,
    });
    const getGasPrice = vi.fn();
    const getChainId = vi.fn().mockResolvedValue(CHAIN_ID);
    const getTransactionCount = vi.fn(async (args: { blockTag?: string }) => {
      if (args.blockTag === 'latest') return PINNED_NONCE;
      return PINNED_NONCE;
    });

    const hash = await executeSafeTransaction(
      {
        getChainId,
        getTransactionCount,
        readContract,
        estimateFeesPerGas,
        getGasPrice,
        getTransactionReceipt,
        waitForTransactionReceipt,
      } as never,
      {
        account: { address: TEST_SIGNER_ADDRESS },
        chain: baseSepolia,
        signMessage,
        writeContract,
      } as never,
      {
        safeAddress: TEST_SAFE_ADDRESS,
        to: TEST_TARGET_ADDRESS,
        value: 0n,
        data: TEST_CALL_DATA,
      },
      { ledger },
    );

    // Reconciled to the original tx — returned its hash, did NOT loop 5×.
    expect(hash).toBe(ORIGINAL_HASH);
    expect(getTransactionReceipt).toHaveBeenCalledWith({ hash: ORIGINAL_HASH });
    // Exactly one write attempt happened (the one that failed underpriced);
    // the loop did not re-sign a fresh execTransaction at the advanced nonce.
    expect(writeContract).toHaveBeenCalledTimes(1);
  });

  it('reconciles to the mined original tx on nonce-too-low instead of re-signing (AC1)', async () => {
    // Seed the ledger so the entry for the pinned nonce already carries the
    // hash of the original delivery tx submitted on a prior attempt.
    const ledger = createMemoryTxSubmissionLedger();
    await ledger.recordTxSubmission({
      chainId: CHAIN_ID,
      from: TEST_SIGNER_ADDRESS,
      nonce: PINNED_NONCE,
      hash: ORIGINAL_HASH,
      logicalTx: 'safe.execTransaction',
      submittedAtMs: Date.now(),
      fees: { maxFeePerGas: 100n, maxPriorityFeePerGas: 10n },
      to: TEST_SAFE_ADDRESS,
      value: 0n,
      data: TEST_CALL_DATA,
    });

    // Attempt 0 fails nonce-too-low: the original tx already mined at the
    // pinned nonce. The loop must reconcile to the now-mined receipt, NOT
    // re-sign a fresh execTransaction at the advanced nonce.
    const writeContract = vi
      .fn()
      .mockRejectedValue(new Error('nonce too low: next nonce 2302, tx nonce 2301'));
    const signMessage = vi.fn().mockResolvedValue(TEST_SAFE_SIGNATURE);
    // The original tx is now mined and successful.
    const getTransactionReceipt = vi.fn(async (args: { hash: Hex }) => {
      if (args.hash === ORIGINAL_HASH) return { status: 'success' };
      throw new Error(`unexpected getTransactionReceipt: ${args.hash}`);
    });
    const waitForTransactionReceipt = vi.fn().mockResolvedValue({ status: 'success' });
    const readContract = vi.fn(async (args: { functionName: string }) => {
      if (args.functionName === 'nonce') return 0n;
      if (args.functionName === 'getTransactionHash') return TEST_SAFE_TX_HASH;
      throw new Error(`unexpected readContract call: ${args.functionName}`);
    });
    const estimateFeesPerGas = vi.fn().mockResolvedValue({
      maxFeePerGas: 100n,
      maxPriorityFeePerGas: 10n,
    });
    const getGasPrice = vi.fn();
    const getChainId = vi.fn().mockResolvedValue(CHAIN_ID);
    const getTransactionCount = vi.fn(async (args: { blockTag?: string }) => {
      if (args.blockTag === 'latest') return PINNED_NONCE;
      return PINNED_NONCE;
    });

    const hash = await executeSafeTransaction(
      {
        getChainId,
        getTransactionCount,
        readContract,
        estimateFeesPerGas,
        getGasPrice,
        getTransactionReceipt,
        waitForTransactionReceipt,
      } as never,
      {
        account: { address: TEST_SIGNER_ADDRESS },
        chain: baseSepolia,
        signMessage,
        writeContract,
      } as never,
      {
        safeAddress: TEST_SAFE_ADDRESS,
        to: TEST_TARGET_ADDRESS,
        value: 0n,
        data: TEST_CALL_DATA,
      },
      { ledger },
    );

    // Reconciled to the original tx — returned its hash, did NOT loop 5×.
    expect(hash).toBe(ORIGINAL_HASH);
    expect(getTransactionReceipt).toHaveBeenCalledWith({ hash: ORIGINAL_HASH });
    // Exactly one write attempt happened (the one that failed nonce-too-low);
    // the loop did not re-sign a fresh execTransaction at the advanced nonce.
    expect(writeContract).toHaveBeenCalledTimes(1);
  });

  it('does NOT reconcile to a FOREIGN tx mined at the same nonce — re-signs instead (security follow-up)', async () => {
    // The tx-submission ledger is shared across every logical Safe tx from this
    // EOA and keyed only on nonce. Seed the pinned nonce with an entry whose
    // to/data belong to a DIFFERENT logical tx (e.g. a setMetadata or reStake
    // broadcast that mined at the same nonce). Its receipt would report success,
    // but it is NOT this delivery — the guard must refuse to short-circuit on it.
    const FOREIGN_HASH = `0x${'99'.repeat(32)}` as Hex;
    const FOREIGN_TARGET = '0x4444444444444444444444444444444444444444' as Hex;
    const FOREIGN_DATA = '0xcafebabe' as Hex;
    const FRESH_HASH = `0x${'ee'.repeat(32)}` as Hex;

    const ledger = createMemoryTxSubmissionLedger();
    await ledger.recordTxSubmission({
      chainId: CHAIN_ID,
      from: TEST_SIGNER_ADDRESS,
      nonce: PINNED_NONCE,
      hash: FOREIGN_HASH,
      logicalTx: 'safe.execTransaction',
      submittedAtMs: Date.now(),
      fees: { maxFeePerGas: 100n, maxPriorityFeePerGas: 10n },
      // Foreign to/data — does NOT match params (TEST_SAFE_ADDRESS / TEST_CALL_DATA).
      to: FOREIGN_TARGET,
      value: 0n,
      data: FOREIGN_DATA,
    });

    // Attempt 0 fails replacement-underpriced; attempt 1 (after refresh + re-sign)
    // succeeds with a fresh hash.
    const writeContract = vi
      .fn()
      .mockRejectedValueOnce(new Error('replacement transaction underpriced'))
      .mockResolvedValueOnce(FRESH_HASH);
    const signMessage = vi.fn().mockResolvedValue(TEST_SAFE_SIGNATURE);
    // Even if the foreign receipt were consulted, it reports success — the guard
    // must prevent it from short-circuiting. The fresh hash also resolves success.
    const getTransactionReceipt = vi.fn(async (args: { hash: Hex }) => {
      if (args.hash === FOREIGN_HASH) return { status: 'success' };
      throw new Error(`unexpected getTransactionReceipt: ${args.hash}`);
    });
    const waitForTransactionReceipt = vi.fn().mockResolvedValue({ status: 'success' });
    const readContract = vi.fn(async (args: { functionName: string }) => {
      if (args.functionName === 'nonce') return 0n;
      if (args.functionName === 'getTransactionHash') return TEST_SAFE_TX_HASH;
      throw new Error(`unexpected readContract call: ${args.functionName}`);
    });
    const estimateFeesPerGas = vi.fn().mockResolvedValue({
      maxFeePerGas: 100n,
      maxPriorityFeePerGas: 10n,
    });
    const getGasPrice = vi.fn();
    const getChainId = vi.fn().mockResolvedValue(CHAIN_ID);
    const getTransactionCount = vi.fn(async (args: { blockTag?: string }) => {
      if (args.blockTag === 'latest') return PINNED_NONCE;
      // After refreshNonce(), the pending count advances so attempt 1 re-signs.
      const pendingCalls = getTransactionCount.mock.calls.filter(
        (c) => (c[0] as { blockTag?: string }).blockTag === 'pending',
      ).length;
      return pendingCalls >= 3 ? PINNED_NONCE + 1 : PINNED_NONCE;
    });

    const hash = await executeSafeTransaction(
      {
        getChainId,
        getTransactionCount,
        readContract,
        estimateFeesPerGas,
        getGasPrice,
        getTransactionReceipt,
        waitForTransactionReceipt,
      } as never,
      {
        account: { address: TEST_SIGNER_ADDRESS },
        chain: baseSepolia,
        signMessage,
        writeContract,
      } as never,
      {
        safeAddress: TEST_SAFE_ADDRESS,
        to: TEST_TARGET_ADDRESS,
        value: 0n,
        data: TEST_CALL_DATA,
      },
      { ledger },
    );

    // The guard refused the foreign hash and fell through to refresh + re-sign,
    // returning the freshly-submitted hash — NOT the foreign tx's hash.
    expect(hash).toBe(FRESH_HASH);
    expect(hash).not.toBe(FOREIGN_HASH);
    // The foreign receipt must NOT have short-circuited the reconcile.
    expect(getTransactionReceipt).not.toHaveBeenCalledWith({ hash: FOREIGN_HASH });
    // Two write attempts: the failed underpriced one, then the fresh re-sign.
    expect(writeContract).toHaveBeenCalledTimes(2);
  });
});

describe('executeSafeTransaction GS026 owner mismatch (issue #1986)', () => {
  const makeClients = (isOwner = false) => {
    const signMessage = vi.fn().mockResolvedValue(TEST_SAFE_SIGNATURE);
    const readContract = vi.fn(async (args: { functionName: string }) => {
      if (args.functionName === 'nonce') return 0n;
      if (args.functionName === 'getTransactionHash') return TEST_SAFE_TX_HASH;
      if (args.functionName === 'isOwner') return isOwner;
      throw new Error(`unexpected readContract call: ${args.functionName}`);
    });
    const estimateFeesPerGas = vi.fn().mockResolvedValue({
      maxFeePerGas: 100n,
      maxPriorityFeePerGas: 10n,
    });
    const getGasPrice = vi.fn();
    const getChainId = vi.fn().mockResolvedValue(baseSepolia.id);
    const getTransactionCount = vi.fn().mockResolvedValue(2301);
    return {
      publicClient: {
        getChainId,
        getTransactionCount,
        readContract,
        estimateFeesPerGas,
        getGasPrice,
      } as never,
      walletClient: {
        account: { address: TEST_SIGNER_ADDRESS },
        chain: baseSepolia,
        signMessage,
      } as never,
      signMessage,
      readContract,
    };
  };

  it('prioritizes a GS026 owner mismatch over an unrelated inner revert', async () => {
    const { publicClient, walletClient } = makeClients();
    const writeContract = vi
      .fn()
      .mockRejectedValue(new Error('The contract function "execTransaction" reverted: GS026'));
    const call = vi.fn().mockRejectedValue(
      Object.assign(new Error('target call reverted'), { data: '0x33f626d3' }),
    );

    await expect(
      executeSafeTransaction(
        { ...publicClient, call } as never,
        { ...walletClient, writeContract } as never,
        {
          safeAddress: TEST_SAFE_ADDRESS,
          to: TEST_TARGET_ADDRESS,
          value: 0n,
          data: TEST_CALL_DATA,
        },
        { ledger: createMemoryTxSubmissionLedger() },
      ),
    ).rejects.toThrow(/GS026.*owner/i);

    expect(call).not.toHaveBeenCalled();
    expect(publicClient.readContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: 'isOwner',
      args: [TEST_SIGNER_ADDRESS],
    }));
  });

  it('retries estimate-path GS026 when the signer is still a Safe owner', async () => {
    const { publicClient, walletClient } = makeClients(true);
    const writeContract = vi
      .fn()
      .mockRejectedValueOnce(new Error('The contract function "execTransaction" reverted: GS026'))
      .mockResolvedValueOnce(TEST_SUCCESS_HASH);
    const waitForTransactionReceipt = vi.fn().mockResolvedValue({ status: 'success' });
    const call = vi.fn().mockResolvedValue({ data: '0x' });

    const hash = await executeSafeTransaction(
      { ...publicClient, call, waitForTransactionReceipt } as never,
      { ...walletClient, writeContract } as never,
      {
        safeAddress: TEST_SAFE_ADDRESS,
        to: TEST_TARGET_ADDRESS,
        value: 0n,
        data: TEST_CALL_DATA,
      },
      { ledger: createMemoryTxSubmissionLedger() },
    );

    expect(hash).toBe(TEST_SUCCESS_HASH);
    expect(writeContract).toHaveBeenCalledTimes(2);
    expect(publicClient.readContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: 'isOwner',
      args: [TEST_SIGNER_ADDRESS],
    }));
  });

  it('keeps receipt-path stale-nonce races retryable without embedding GS026', async () => {
    const REVERT_HASH = `0x${'dd'.repeat(32)}` as Hex;
    const { publicClient, walletClient } = makeClients();
    const writeContract = vi.fn().mockResolvedValue(REVERT_HASH);
    const waitForTransactionReceipt = vi.fn().mockResolvedValue({ status: 'reverted' });
    const call = vi.fn().mockResolvedValue({ data: '0x' });

    await expect(
      executeSafeTransaction(
        { ...publicClient, call, waitForTransactionReceipt } as never,
        { ...walletClient, writeContract } as never,
        {
          safeAddress: TEST_SAFE_ADDRESS,
          to: TEST_TARGET_ADDRESS,
          value: 0n,
          data: TEST_CALL_DATA,
        },
        { ledger: createMemoryTxSubmissionLedger() },
      ),
    ).rejects.toThrow(/possible stale Safe nonce or signature race/);

    const err = new Error(
      'Safe execTransaction reverted (possible stale Safe nonce or signature race, txHash=0xdead)',
    );
    expect(isRecoverableTransactionError(err)).toBe(true);
    expect(err.message).not.toContain('GS026');
  });
});

/**
 * Issue #562 regression: executeSafeTxDirect must refresh the ledger-pinned
 * nonce after a `nonce too low` revert. Without the fix, a daemon respawn
 * that advances the RPC nonce past the locally-pinned value loops 5 retries
 * with the stale nonce and the tick errors out.
 *
 * This test stubs the viem `createPublicClient` / `createWalletClient` and
 * `viem/accounts` `privateKeyToAccount` factories so we can drive
 * `executeSafeTxDirect` end-to-end without standing up a real RPC. The
 * `walletClient.sendTransaction` mock rejects once with `nonce too low ...`
 * and then resolves; we assert that the second attempt's `nonce` argument is
 * the refreshed value re-read via `getTransactionCount({ blockTag: 'pending' })`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Hex } from 'viem';

const SIGNER_KEY = `0x${'11'.repeat(32)}` as Hex;
const SIGNER_ADDRESS = '0x000000000000000000000000000000000000bEEF' as const;
const SAFE_ADDRESS = '0x2222222222222222222222222222222222222222' as const;
const TARGET_ADDRESS = '0x3333333333333333333333333333333333333333' as const;
const CALL_DATA = '0xdeadbeef' as Hex;
const SUCCESS_HASH = `0x${'cc'.repeat(32)}` as Hex;
const SAFE_TX_HASH = `0x${'77'.repeat(32)}` as Hex;
// 64 bytes r||s + 1 byte v = 65 bytes, the shape executeSafeTxDirect expects
// from walletClient.signMessage before it normalises v to v+4 (Safe eth_sign).
const SIGNATURE_HEX = `0x${'ab'.repeat(32)}${'cd'.repeat(32)}1b` as Hex;

const sendTransaction = vi.fn();
const signMessage = vi.fn().mockResolvedValue(SIGNATURE_HEX);
const getChainId = vi.fn().mockResolvedValue(84532);
// readContract is called twice per attempt: Safe.nonce() then getTransactionHash().
const readContract = vi.fn(async (args: { functionName: string }) => {
  if (args.functionName === 'nonce') return 0n;
  if (args.functionName === 'getTransactionHash') return SAFE_TX_HASH;
  throw new Error(`unexpected readContract call: ${args.functionName}`);
});
const estimateGas = vi.fn().mockResolvedValue(1_000_000n);
const estimateFeesPerGas = vi.fn().mockResolvedValue({
  maxFeePerGas: 100n,
  maxPriorityFeePerGas: 10n,
});
const getGasPrice = vi.fn();
// recoverStuckNonceIfNeeded calls getTransactionCount(pending) and (latest);
// returning equal values short-circuits recovery. The initial pin then re-reads
// pending. The refreshNonce() call (post-nonce-too-low) re-reads pending again.
const getTransactionCount = vi.fn(async (args: { blockTag?: string }) => {
  // pending -> 2301 for recovery probe + initial pin, then 2302 after refresh.
  // latest -> 2301 (equal to pending -> no recovery).
  if (args.blockTag === 'latest') return 2301;
  // 'pending' path: first two reads return 2301 (recovery probe + initial pin),
  // third returns 2302 (refresh).
  const pendingCalls = getTransactionCount.mock.calls.filter(
    (c) => (c[0] as { blockTag?: string }).blockTag === 'pending',
  ).length;
  // The current call is already counted (we're inside the impl).
  return pendingCalls >= 3 ? 2302 : 2301;
});

const stubPublicClient = {
  getChainId,
  getTransactionCount,
  readContract,
  estimateGas,
  estimateFeesPerGas,
  getGasPrice,
};

const stubWalletClient = {
  account: { address: SIGNER_ADDRESS },
  sendTransaction,
  signMessage,
};

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => stubPublicClient),
    createWalletClient: vi.fn(() => stubWalletClient),
  };
});

vi.mock('viem/accounts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem/accounts')>();
  return {
    ...actual,
    privateKeyToAccount: vi.fn(() => ({ address: SIGNER_ADDRESS })),
  };
});

// Import AFTER the mocks are registered so safe-adapter binds to the stubs.
const { executeSafeTxDirect } = await import('../../src/earning/safe-adapter.js');
const { createMemoryTxSubmissionLedger } = await import('../../src/tx-retry.js');

describe('executeSafeTxDirect nonce refresh (issue #562)', () => {
  it('refreshes the pinned nonce on `nonce too low` and resubmits with the fresh value', async () => {
    sendTransaction.mockReset();
    sendTransaction
      .mockRejectedValueOnce(new Error('nonce too low: next nonce 2302, tx nonce 2301'))
      .mockResolvedValueOnce(SUCCESS_HASH);

    // Reset getTransactionCount call history so the pendingCalls counter starts
    // from this test only (the closure above is module-scoped).
    getTransactionCount.mockClear();

    const result = await executeSafeTxDirect({
      rpcUrl: 'http://127.0.0.1:8545',
      signerKey: SIGNER_KEY,
      safeAddress: SAFE_ADDRESS,
      to: TARGET_ADDRESS,
      data: CALL_DATA,
      ledger: createMemoryTxSubmissionLedger(),
    });

    expect(result.hash).toBe(SUCCESS_HASH);

    // Production path: 2 attempts, nonce-pinned to ledger value each time.
    expect(sendTransaction).toHaveBeenCalledTimes(2);
    const firstCall = sendTransaction.mock.calls[0]![0] as { nonce: number };
    const secondCall = sendTransaction.mock.calls[1]![0] as { nonce: number };
    expect(firstCall.nonce).toBe(2301);
    expect(secondCall.nonce).toBe(2302);

    // refreshNonce() re-reads the pending nonce after the revert. We expect at
    // least three `pending` reads: recovery probe, initial pin, refresh.
    const pendingReads = getTransactionCount.mock.calls.filter(
      (c) => (c[0] as { blockTag?: string }).blockTag === 'pending',
    ).length;
    expect(pendingReads).toBeGreaterThanOrEqual(3);
  });
});

import { describe, it, expect, vi } from 'vitest';
import type { Hex } from 'viem';
import { baseSepolia } from 'viem/chains';
import { buildSafeSignature, createClients, executeSafeTransaction } from '../../../src/adapters/mech/safe.js';
import { createMemoryTxSubmissionLedger } from '../../../src/tx-retry.js';

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

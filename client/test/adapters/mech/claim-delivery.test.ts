import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address, Hex, PublicClient, WalletClient } from 'viem';
import { claimDelivery } from '../../../src/adapters/mech/contracts.js';
import { executeSafeTransaction } from '../../../src/adapters/mech/safe.js';

// MOCK_JUSTIFICATION: src/adapters/mech/safe.js is the I/O leaf for Safe wallet RPC calls; mocking it is mocking the boundary.
vi.mock('../../../src/adapters/mech/safe.js', () => ({
  executeSafeTransaction: vi.fn(),
}));

// MOCK_JUSTIFICATION: src/tx-retry.js wraps chain-RPC retry logic at the I/O boundary; mocking it is mocking the boundary.
vi.mock('../../../src/tx-retry.js', () => ({
  flattenErrorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
  waitForTransactionReceiptWithRetry: vi.fn(),
  viemSendTransactionWithRetry: vi.fn(),
  isRecoverableTransactionError: vi.fn().mockReturnValue(true),
  backoffDelay: vi.fn().mockResolvedValue(undefined),
}));

const SAFE_ADDRESS = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address;
const ROUTER_ADDRESS = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Address;
const REQUEST_ID = `0x${'cc'.repeat(32)}` as Hex;

function makePublicClient(claimedResults: boolean[]): PublicClient {
  return {
    readContract: vi.fn()
      .mockResolvedValueOnce(claimedResults[0] ?? false)
      .mockResolvedValueOnce(claimedResults[1] ?? false),
  } as unknown as PublicClient;
}

function makeWalletClient(): WalletClient {
  return {} as WalletClient;
}

describe('claimDelivery', () => {
  beforeEach(() => {
    vi.mocked(executeSafeTransaction).mockReset();
    vi.mocked(executeSafeTransaction).mockResolvedValue('0xsafetx' as Hex);
  });

  it('skips the Safe transaction when the router delivery is already claimed', async () => {
    const publicClient = makePublicClient([true]);

    const txHash = await claimDelivery(
      publicClient,
      makeWalletClient(),
      undefined,
      SAFE_ADDRESS,
      ROUTER_ADDRESS,
      REQUEST_ID,
      { variant: 'v2' },
    );

    expect(txHash).toBe('0x');
    expect(executeSafeTransaction).not.toHaveBeenCalled();
  });

  it('treats Safe GS013 as idempotent when the router now reports claimed', async () => {
    const publicClient = makePublicClient([false, true]);
    vi.mocked(executeSafeTransaction).mockRejectedValueOnce(new Error('execution reverted: GS013'));
    const evidenceHash = `0x${'ef'.repeat(32)}` as Hex;

    const txHash = await claimDelivery(
      publicClient,
      makeWalletClient(),
      undefined,
      SAFE_ADDRESS,
      ROUTER_ADDRESS,
      REQUEST_ID,
      { variant: 'v2', evidenceHash },
    );

    expect(txHash).toBe('0x');
    expect(executeSafeTransaction).toHaveBeenCalledOnce();
    expect(publicClient.readContract).toHaveBeenCalledTimes(2);
  });

  it('throws when variant is v2 and evidenceHash is missing', async () => {
    const publicClient = makePublicClient([false]);

    await expect(
      claimDelivery(
        publicClient,
        makeWalletClient(),
        undefined,
        SAFE_ADDRESS,
        ROUTER_ADDRESS,
        REQUEST_ID,
        { variant: 'v2' },
      ),
    ).rejects.toThrow('claimDelivery(v2): evidenceHash is required');

    expect(executeSafeTransaction).not.toHaveBeenCalled();
  });
});

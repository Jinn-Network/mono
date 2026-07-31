import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address, Hex, PublicClient, WalletClient } from 'viem';
import { claimDelivery } from '../../../src/adapters/mech/contracts.js';
import { executeSafeTransaction } from '../../../src/adapters/mech/safe.js';

vi.mock('../../../src/adapters/mech/safe.js', () => ({
  executeSafeTransaction: vi.fn(),
}));

const SAFE_ADDRESS = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address;
const ROUTER_ADDRESS = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Address;
const DISTRIBUTOR_ADDRESS = '0xdddddddddddddddddddddddddddddddddddddddd' as Address;
const STAKING_PROXY = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as Address;
const REQUEST_ID = `0x${'cc'.repeat(32)}` as Hex;
const EVIDENCE_HASH = `0x${'ef'.repeat(32)}` as Hex;

function makePublicClient(stakingState: number): PublicClient {
  return {
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'claimed') return false;
      if (functionName === 'getStakingState') return stakingState;
      throw new Error(`unexpected readContract ${functionName}`);
    }),
    waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }),
  } as unknown as PublicClient;
}

function makeWalletClient(): WalletClient {
  return {} as WalletClient;
}

function makeMasterWalletClient(): WalletClient {
  return {
    account: { address: '0x1111111111111111111111111111111111111111' },
    sendTransaction: vi.fn().mockResolvedValue('0xrestake' as Hex),
  } as unknown as WalletClient;
}

describe('staking decoupled from the protocol loop (#773)', () => {
  beforeEach(() => {
    vi.mocked(executeSafeTransaction).mockReset();
  });

  it('does NOT inline-restake an evicted service — the claim proceeds, no distributor.reStake', async () => {
    // Service is EVICTED (state 2). JinnRouterV3 has no staking gate, so the
    // claim must still go through, and the protocol loop must NOT broadcast a
    // distributor.reStake — that inline reStake (when it reverts) was masking
    // the real action error and breaking solve/deliver ticks in T3.1.
    const publicClient = makePublicClient(2);
    const masterWalletClient = makeMasterWalletClient();
    vi.mocked(executeSafeTransaction).mockResolvedValueOnce('0xclaim' as Hex);

    const txHash = await claimDelivery(
      publicClient,
      makeWalletClient(),
      undefined,
      SAFE_ADDRESS,
      ROUTER_ADDRESS,
      REQUEST_ID,
      { variant: 'v2', evidenceHash: EVIDENCE_HASH },
      {
        serviceId: 36,
        stakingProxyAddress: STAKING_PROXY,
        distributorAddress: DISTRIBUTOR_ADDRESS,
        masterWalletClient,
      },
    );

    expect(txHash).toBe('0xclaim');
    expect(executeSafeTransaction).toHaveBeenCalledTimes(1);
    // The decisive regression assertion: no inline reStake, ever.
    expect(masterWalletClient.sendTransaction).not.toHaveBeenCalled();
  });

  it('propagates the original action error without restaking', async () => {
    const publicClient = makePublicClient(1);
    const masterWalletClient = makeMasterWalletClient();
    vi.mocked(executeSafeTransaction).mockRejectedValueOnce(new Error('RequestNotFound'));

    await expect(
      claimDelivery(
        publicClient,
        makeWalletClient(),
        undefined,
        SAFE_ADDRESS,
        ROUTER_ADDRESS,
        REQUEST_ID,
        { variant: 'v2', evidenceHash: EVIDENCE_HASH },
        {
          serviceId: 36,
          stakingProxyAddress: STAKING_PROXY,
          distributorAddress: DISTRIBUTOR_ADDRESS,
          masterWalletClient,
        },
      ),
    ).rejects.toThrow('RequestNotFound');

    expect(executeSafeTransaction).toHaveBeenCalledTimes(1);
    expect(masterWalletClient.sendTransaction).not.toHaveBeenCalled();
  });
});

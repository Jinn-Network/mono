import { describe, expect, it, vi } from 'vitest';
import { claimJinnRewards } from '../../src/earning/stolas-staking.js';

describe('claimJinnRewards', () => {
  it('returns early when no staking reward is available', async () => {
    const publicClient = {
      readContract: vi.fn().mockResolvedValue(0n),
      waitForTransactionReceipt: vi.fn(),
    };
    const walletClient = {
      getAddresses: vi.fn(),
      writeContract: vi.fn(),
      chain: null,
    };

    await expect(
      claimJinnRewards(
        publicClient as any,
        walletClient as any,
        '0x00000000000000000000000000000000000000a1',
        7,
      ),
    ).resolves.toEqual({ claimed: false, amount: 0n });

    expect(publicClient.readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: 'calculateStakingReward',
        args: [7n],
      }),
    );
    expect(walletClient.getAddresses).not.toHaveBeenCalled();
    expect(walletClient.writeContract).not.toHaveBeenCalled();
  });

  it('claims with claim() by default and returns the probed reward amount', async () => {
    const publicClient = {
      readContract: vi.fn().mockResolvedValue(123n),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }),
    };
    const walletClient = {
      getAddresses: vi.fn().mockResolvedValue(['0x00000000000000000000000000000000000000b1']),
      writeContract: vi.fn().mockResolvedValue('0xabc'),
      chain: null,
    };

    await expect(
      claimJinnRewards(
        publicClient as any,
        walletClient as any,
        '0x00000000000000000000000000000000000000a1',
        9,
      ),
    ).resolves.toEqual({ claimed: true, amount: 123n });

    expect(walletClient.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: 'claim',
        args: [9n],
        account: '0x00000000000000000000000000000000000000b1',
      }),
    );
    expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: '0xabc' });
  });

  it('uses checkpointAndClaim() when requested', async () => {
    const publicClient = {
      readContract: vi.fn().mockResolvedValue(55n),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }),
    };
    const walletClient = {
      getAddresses: vi.fn().mockResolvedValue(['0x00000000000000000000000000000000000000b1']),
      writeContract: vi.fn().mockResolvedValue('0xdef'),
      chain: null,
    };

    await claimJinnRewards(
      publicClient as any,
      walletClient as any,
      '0x00000000000000000000000000000000000000a1',
      12,
      { checkpoint: true },
    );

    expect(walletClient.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: 'checkpointAndClaim',
        args: [12n],
      }),
    );
  });
});

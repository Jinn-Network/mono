/**
 * OLAS staking-reward (stOLAS) helper for the curating-agent staking contract.
 *
 * The OLAS staking proxy exposes `calculateStakingReward()` plus
 * owner-authorized `claim()` / `checkpointAndClaim()` entrypoints.
 */

import type { PublicClient, WalletClient } from 'viem';
import { withEoaBroadcastLock } from '../tx-retry.js';

// ---------------------------------------------------------------------------
// ABI fragment — only the functions we call
// ---------------------------------------------------------------------------

export const JINN_STAKING_ABI = [
  {
    inputs: [
      { name: 'serviceId', type: 'uint256' },
    ],
    name: 'calculateStakingReward',
    outputs: [{ name: 'amount', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getNextRewardCheckpointTimestamp',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { name: 'serviceId', type: 'uint256' },
    ],
    name: 'getStakingState',
    outputs: [{ name: 'stakingState', type: 'uint8' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { name: 'serviceId', type: 'uint256' },
    ],
    name: 'getServiceInfo',
    outputs: [
      {
        name: 'sInfo',
        type: 'tuple',
        components: [
          { name: 'multisig', type: 'address' },
          { name: 'owner', type: 'address' },
          { name: 'nonces', type: 'uint256[]' },
          { name: 'tsStart', type: 'uint256' },
          { name: 'reward', type: 'uint256' },
          { name: 'inactivity', type: 'uint256' },
          { name: 'rewardDistributionInfo', type: 'uint256' },
        ],
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { name: 'serviceId', type: 'uint256' },
    ],
    name: 'claim',
    outputs: [{ name: 'amount', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { name: 'serviceId', type: 'uint256' },
    ],
    name: 'checkpointAndClaim',
    outputs: [{ name: 'amount', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

// ---------------------------------------------------------------------------
// Claim function
// ---------------------------------------------------------------------------

/**
 * Claim OLAS staking rewards from the stOLAS curating-agent staking contract.
 *
 * @param publicClient  — viem PublicClient for read calls
 * @param walletClient  — viem WalletClient for write calls
 * @param stakingContractAddress — OLAS staking contract address
 * @param serviceId     — OLAS service ID registered in the staking contract
 */
export async function claimJinnRewards(
  publicClient: PublicClient,
  walletClient: WalletClient,
  stakingContractAddress: `0x${string}`,
  serviceId: number,
  options: { checkpoint?: boolean } = {},
): Promise<{ claimed: boolean; amount: bigint }> {
  const pending = await publicClient.readContract({
    address: stakingContractAddress,
    abi: JINN_STAKING_ABI,
    functionName: 'calculateStakingReward',
    args: [BigInt(serviceId)],
  });

  if (pending === 0n) {
    return { claimed: false, amount: 0n };
  }

  // Submit claim transaction. Hold the per-EOA broadcast lock across submit +
  // receipt so the nonce stays reserved until the tx mines — concurrent
  // operator-EOA broadcasts (checkpoint, 8004 writes) cannot claim the same
  // nonce (#792 / #525).
  const [account] = await walletClient.getAddresses();
  return withEoaBroadcastLock(account, async () => {
    const hash = await walletClient.writeContract({
      address: stakingContractAddress,
      abi: JINN_STAKING_ABI,
      functionName: options.checkpoint ? 'checkpointAndClaim' : 'claim',
      args: [BigInt(serviceId)],
      account,
      chain: walletClient.chain ?? null,
    });

    // Wait for confirmation
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      throw new Error(`OLAS staking reward claim tx reverted: ${hash}`);
    }

    return { claimed: true, amount: pending };
  });
}

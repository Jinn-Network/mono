/**
 * JINN reward claiming scaffold for Phase 1a staking contract.
 *
 * Mirrors the OLAS staking claim pattern used in bootstrap.ts.
 * Placeholder implementation — wired up after Phase 1a deployment.
 */

import type { PublicClient, WalletClient } from 'viem';

// ---------------------------------------------------------------------------
// ABI fragment — only the functions we call
// ---------------------------------------------------------------------------

export const JINN_STAKING_ABI = [
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
    name: 'pendingRewards',
    outputs: [{ name: 'amount', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

// ---------------------------------------------------------------------------
// Claim function
// ---------------------------------------------------------------------------

/**
 * Claim JINN rewards from the Phase 1a staking contract.
 *
 * Returns { claimed: false, amount: 0n } until the Phase 1a contract is
 * deployed and the ABI is finalised. Wiring up is a matter of uncommenting
 * the contract call below.
 *
 * @param publicClient  — viem PublicClient for read calls
 * @param walletClient  — viem WalletClient for write calls
 * @param stakingContractAddress — Phase 1a JINN staking contract address
 * @param serviceId     — OLAS service ID registered in the staking contract
 */
export async function claimJinnRewards(
  publicClient: PublicClient,
  walletClient: WalletClient,
  stakingContractAddress: `0x${string}`,
  serviceId: number,
): Promise<{ claimed: boolean; amount: bigint }> {
  // Check pending rewards before attempting claim
  const pending = await publicClient.readContract({
    address: stakingContractAddress,
    abi: JINN_STAKING_ABI,
    functionName: 'pendingRewards',
    args: [BigInt(serviceId)],
  });

  if (pending === 0n) {
    return { claimed: false, amount: 0n };
  }

  // Submit claim transaction
  const [account] = await walletClient.getAddresses();
  const hash = await walletClient.writeContract({
    address: stakingContractAddress,
    abi: JINN_STAKING_ABI,
    functionName: 'claim',
    args: [BigInt(serviceId)],
    account,
    chain: walletClient.chain ?? null,
  });

  // Wait for confirmation
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    throw new Error(`JINN reward claim tx reverted: ${hash}`);
  }

  return { claimed: true, amount: pending };
}

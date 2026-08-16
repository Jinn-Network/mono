/**
 * Real 1-of-1 service Safe for the native e2e rig (spec/2026-08-07 §2.4, PR2).
 *
 * The rig used to pass the ceremony EOA itself as operator A's "Safe" — the conflation that was the
 * only reason `verifyOnchainAuthority`'s old address-equality check ever passed. A real operator's
 * settlement address is a CONTRACT, so the rig must be one too, or it proves nothing about the
 * shape production actually has.
 *
 * This deploys the production Safe 1.3.0 the earning stack deploys (`initPredictedSafe`, the same
 * pinned version `fleet-safe-deploy.ts` uses) against the Base Sepolia fork, owned by the ceremony
 * EOA. Nothing about `isOwner` is stubbed: `verifyOnchainAuthority` step 5 reads this contract
 * through the production `createViemBaseSepoliaReadClients(...).settlementOwnership`.
 */
import type { Account, Hex, PublicClient, WalletClient } from 'viem';
import { initPredictedSafe } from '../../../../src/earning/safe-adapter.js';

export interface ForkSafe {
  readonly address: `0x${string}`;
  readonly owner: `0x${string}`;
  readonly deployTxHash: `0x${string}`;
}

/** Deploys a 1-of-1 Safe owned by `account` on the fork and asserts it is genuinely a contract. */
export async function deployForkServiceSafe(input: {
  readonly rpcUrl: string;
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  /** A LOCAL viem account: it both owns the Safe and pays for the deployment. */
  readonly account: Account;
  readonly privateKey: Hex;
}): Promise<ForkSafe> {
  const owner = input.account.address;
  const { safe, address } = await initPredictedSafe({
    rpcUrl: input.rpcUrl,
    signerKey: input.privateKey,
    owners: [owner],
    threshold: 1,
  });
  if (address.toLowerCase() === owner.toLowerCase()) {
    throw new Error('predicted Safe address equals its owner EOA — impossible; refusing to proceed');
  }
  const deployTx = await safe.createSafeDeploymentTransaction();
  const deployTxHash = await input.walletClient.sendTransaction({
    account: input.account,
    to: deployTx.to as `0x${string}`,
    value: BigInt(deployTx.value),
    data: deployTx.data as Hex,
    chain: null,
  });
  const receipt = await input.publicClient.waitForTransactionReceipt({ hash: deployTxHash });
  if (receipt.status !== 'success') {
    throw new Error(`fork Safe deployment reverted (tx=${deployTxHash})`);
  }
  const code = await input.publicClient.getBytecode({ address: address as `0x${string}` });
  if (code === undefined || code === '0x') {
    throw new Error(`fork Safe deployment mined but no code at ${address}`);
  }
  return { address: address as `0x${string}`, owner, deployTxHash };
}

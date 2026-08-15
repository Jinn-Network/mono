/**
 * On-chain trust-anchor submitter for the native e2e rig (one-swap M7, umbrella #2461).
 *
 * The native trust catalog's finalized-anchor requirement (`native-trust-catalog.ts` →
 * `createBaseSepoliaFinalizedAnchorClient`) is what makes the boot leg chain-dependent: a binding
 * anchor is a FINALIZED calldata tx whose input, at a byte offset, is the anchor digest. On a Base
 * Sepolia Anvil fork this is reproducible — Anvil 1.6 advances the `finalized` block tag to
 * `latest - 64`, so a tx mined and then buried under >64 blocks reads back as finalized.
 *
 * Transaction construction is the production `submitAnchor` (spec §3.4): same calldata, same
 * offset, same block-time read. What stays fixture-only is the Anvil-specific finality BURIAL —
 * `anvil_mine` past the fork's `finalized` tag, standing in for the live
 * `waitForFinalizedAnchor` poll that a real ceremony waits ~10-20 minutes on.
 */
import { submitAnchor, type WalletClientLike } from '@jinn-network/trust-authoring';
import type { Account, PublicClient, WalletClient } from 'viem';
import { jsonRpc } from '../../../_support/chain/anvil.js';
import type { AnchorLocator, AnchorSubmitter } from './trust-catalog.js';

/** Anvil's `finalized` tag = latest - 64; bury the anchor tx deeper than that with a margin. */
const FINALITY_BURY_BLOCKS = 80;

/** A stable, code-less target address for anchor calldata (any address the anchor client can read). */
export const NATIVE_E2E_ANCHOR_TARGET = '0x00000000000000000000000000000000000a11c0' as const;

export function createForkAnchorSubmitter(input: {
  readonly rpcUrl: string;
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  /** A LOCAL viem account (not just an address) so the tx is signed locally, not via an RPC signer. */
  readonly account: Account;
  readonly target?: `0x${string}`;
  readonly buryBlocks?: number;
}): AnchorSubmitter {
  const target = input.target ?? NATIVE_E2E_ANCHOR_TARGET;
  const bury = input.buryBlocks ?? FINALITY_BURY_BLOCKS;
  // The authoring port is deliberately viem-free, so the rig supplies the account and the
  // chain-less signing posture the Anvil fork needs.
  const walletClient: WalletClientLike = {
    sendTransaction: ({ to, value, data }) => input.walletClient.sendTransaction({
      account: input.account,
      to,
      value,
      data,
      chain: null,
    }),
  };
  return async (digest): Promise<AnchorLocator> => {
    const locator = await submitAnchor({
      walletClient,
      publicClient: input.publicClient,
      target,
      digest,
    });
    // Bury it past the finalized tag so the anchor reads back finalized.
    await jsonRpc(input.rpcUrl, 'anvil_mine', [`0x${bury.toString(16)}`]);
    return {
      transactionHash: locator.transactionHash,
      contractAddress: locator.contractAddress,
      inputByteOffset: locator.inputByteOffset,
      anchorTime: locator.anchorTime,
    };
  };
}

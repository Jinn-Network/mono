/**
 * On-chain trust-anchor submitter for the native e2e rig (one-swap M7, umbrella #2461).
 *
 * The native trust catalog's finalized-anchor requirement (`native-trust-catalog.ts` →
 * `createBaseSepoliaFinalizedAnchorClient`) is what makes the boot leg chain-dependent: a binding
 * anchor is a FINALIZED calldata tx whose input, at a byte offset, is the anchor digest. On a Base
 * Sepolia Anvil fork this is reproducible — Anvil 1.6 advances the `finalized` block tag to
 * `latest - 64`, so a tx mined and then buried under >64 blocks reads back as finalized.
 *
 * This submitter sends `0x<digest>` to a fixed dummy target (the anchor client checks tx.to ===
 * locator.contractAddress and the calldata bytes; a plain data tx to an EOA succeeds on Anvil), then
 * mines past finality so `openNativeTrustCatalog` accepts it.
 */
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
  return async (digest): Promise<AnchorLocator> => {
    const digestHex = digest.slice('sha256:'.length);
    const data = `0x${digestHex}` as `0x${string}`;
    const hash = await input.walletClient.sendTransaction({
      account: input.account,
      to: target,
      value: 0n,
      data,
      chain: null,
    });
    const receipt = await input.publicClient.waitForTransactionReceipt({ hash });
    // The anchor's on-chain time IS the block timestamp — the catalog binds validFrom to it so
    // `effectiveStart = max(validFrom, anchorTime)` stays consistent on the fork (a validFrom earlier
    // than the fork's block time would push effectiveStart to anchorTime and break the §7.4a
    // incumbent-voucher window check).
    const block = await input.publicClient.getBlock({ blockNumber: receipt.blockNumber });
    const anchorTime = new Date(Number(block.timestamp) * 1000).toISOString();
    // Bury it past the finalized tag so the anchor reads back finalized.
    await jsonRpc(input.rpcUrl, 'anvil_mine', [`0x${bury.toString(16)}`]);
    return { transactionHash: hash, contractAddress: target, inputByteOffset: 0, anchorTime };
  };
}

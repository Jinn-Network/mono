/**
 * Restorer engine — mech delivery + JinnRouter.claimDelivery.
 *
 * §6.1 DELIVERING phase.
 *
 * Steps:
 *   1. Encode manifest CID as bytes32 digest (cidToDigestHex).
 *   2. Call mech.deliverToMarketplace(requestId, deliveryDigest) via the Safe.
 *   3. Call JinnRouter.claimDelivery(requestId, evidenceHash) where evidenceHash
 *      is the keccak256 hash of the signed manifest (from manifest assembly).
 */

import type { Hex, PublicClient, WalletClient, Address } from 'viem';
import {
  cidToDigestHex,
} from '../../adapters/mech/ipfs.js';
import {
  callDeliverToMarketplace,
  claimDelivery,
} from '../../adapters/mech/contracts.js';

// ── Deps ──────────────────────────────────────────────────────────────────────

export interface DeliveryDeps {
  publicClient: PublicClient;
  walletClient: WalletClient;
  safeAddress: Address;
  mechContractAddress: Address;
  routerAddress: Address;
  /** v1 or v2 claimDelivery encoding — matches chain config */
  claimDeliveryVariant: 'v1' | 'v2';
}

/**
 * Callback invoked after deliverToMarketplace lands on-chain but BEFORE
 * claimDelivery is called. Callers use this to durably persist the tx hash so
 * that a crash between the two steps can be recovered without re-submitting the
 * deliver transaction.
 */
export type OnDeliveryTxLanded = (deliveryTxHash: Hex) => void | Promise<void>;

// ── Delivery ──────────────────────────────────────────────────────────────────

export interface DeliveryResult {
  deliveryTxHash: Hex;
  claimTxHash: Hex;
}

/**
 * Deliver the manifest to the marketplace and claim the delivery on JinnRouter.
 *
 * Crash-recovery safe: if `preExistingDeliveryTxHash` is provided, the
 * deliverToMarketplace step is skipped entirely — the function resumes from
 * the claimDelivery step only. This handles the case where the process crashed
 * after deliver landed on-chain but before the COMPLETE transition was persisted.
 *
 * @param requestId                 The on-chain request ID (bytes32 hex).
 * @param manifestCid               IPFS CID of the signed manifest.
 * @param evidenceHash              keccak256 hash of the canonical manifest JSON
 *   (from manifest assembly) — used as evidenceHash in claimDelivery V2.
 * @param deps                      Viem clients + contract addresses.
 * @param preExistingDeliveryTxHash If set, skip deliverToMarketplace and use
 *   this as the deliveryTxHash in the result.
 * @param onDeliveryTxLanded        Optional callback invoked after
 *   deliverToMarketplace succeeds, before claimDelivery. Use this to persist the
 *   tx hash so recovery can skip the deliver step on restart.
 */
export async function deliverAndClaim(
  requestId: Hex,
  manifestCid: string,
  evidenceHash: Hex,
  deps: DeliveryDeps,
  preExistingDeliveryTxHash?: Hex,
  onDeliveryTxLanded?: OnDeliveryTxLanded,
): Promise<DeliveryResult> {
  let deliveryTxHash: Hex;

  if (preExistingDeliveryTxHash) {
    // Recovery path: deliverToMarketplace already landed on a previous run.
    console.log(`[restorer-engine] deliverToMarketplace already done (recovery), tx=${preExistingDeliveryTxHash}`);
    deliveryTxHash = preExistingDeliveryTxHash;
  } else {
    // 1. Convert manifest CID to 32-byte digest for on-chain delivery data
    const deliveryDigest = cidToDigestHex(manifestCid);

    // 2. deliverToMarketplace via Safe
    console.log(`[restorer-engine] deliverToMarketplace requestId=${requestId}`);
    deliveryTxHash = await callDeliverToMarketplace(
      deps.publicClient,
      deps.walletClient,
      deps.safeAddress,
      deps.mechContractAddress,
      [requestId],
      [deliveryDigest],
    );
    console.log(`[restorer-engine] deliverToMarketplace tx=${deliveryTxHash}`);

    // Persist the tx hash before proceeding to claimDelivery. If the process
    // crashes between here and the COMPLETE transition, recovery will read this
    // hash and skip the deliver step.
    if (onDeliveryTxLanded) {
      await onDeliveryTxLanded(deliveryTxHash);
    }
  }

  // 3. claimDelivery on JinnRouter
  console.log(`[restorer-engine] claimDelivery requestId=${requestId}`);
  const claimTxHash = await claimDelivery(
    deps.publicClient,
    deps.walletClient,
    deps.safeAddress,
    deps.routerAddress,
    requestId,
    {
      variant: deps.claimDeliveryVariant,
      evidenceHash: deps.claimDeliveryVariant === 'v2' ? evidenceHash : undefined,
    },
  );
  console.log(`[restorer-engine] claimDelivery tx=${claimTxHash}`);

  return { deliveryTxHash, claimTxHash };
}

/**
 * Harness engine — mech delivery + JinnRouter delivery settlement.
 *
 * §6.1 DELIVERING phase.
 *
 * Steps:
 *   1. Encode manifest CID as bytes32 digest (cidToDigestHex).
 *   2. Call mech.deliverToMarketplace(requestId, deliveryDigest) via the Safe.
 *   3. Call the configured router delivery settlement method. V3 settles
 *      Solution requests through `claimSolutionDelivery(requestId, evidenceHash)`.
 */

import type { Hex, PublicClient, WalletClient, Address } from 'viem';
import type { EvictionRecoveryConfig } from '../../adapters/mech/types.js';
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
  /** Router delivery settlement encoding — matches chain config. */
  claimDeliveryVariant: 'v1' | 'v2' | 'v3';
  evictionRecovery?: EvictionRecoveryConfig;
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

export interface DeliveryClaimOptions {
  kind?: 'solution' | 'verdict';
  verdictCode?: number;
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
  claimOptions: DeliveryClaimOptions = {},
): Promise<DeliveryResult> {
  let deliveryTxHash: Hex;

  if (preExistingDeliveryTxHash) {
    // Recovery path: deliverToMarketplace already landed on a previous run.
    console.log(`[harness-engine] deliverToMarketplace already done (recovery), tx=${preExistingDeliveryTxHash}`);
    deliveryTxHash = preExistingDeliveryTxHash;
  } else {
    // 1. Convert manifest CID to 32-byte digest for on-chain delivery data
    const deliveryDigest = cidToDigestHex(manifestCid);

    // 2. deliverToMarketplace via Safe
    console.log(`[harness-engine] deliverToMarketplace requestId=${requestId}`);
    deliveryTxHash = await callDeliverToMarketplace(
      deps.publicClient,
      deps.walletClient,
      deps.safeAddress,
      deps.mechContractAddress,
      [requestId],
      [deliveryDigest],
      deps.evictionRecovery,
    );
    console.log(`[harness-engine] deliverToMarketplace tx=${deliveryTxHash}`);

    // Persist the tx hash before proceeding to claimDelivery. If the process
    // crashes between here and the COMPLETE transition, recovery will read this
    // hash and skip the deliver step.
    if (onDeliveryTxLanded) {
      await onDeliveryTxLanded(deliveryTxHash);
    }
  }

  // 3. claim delivery on JinnRouter
  console.log(`[harness-engine] claimDelivery requestId=${requestId}`);
  const claimTxHash = await claimDelivery(
    deps.publicClient,
    deps.walletClient,
    deps.safeAddress,
    deps.routerAddress,
    requestId,
    {
      variant: deps.claimDeliveryVariant,
      kind: claimOptions.kind ?? 'solution',
      evidenceHash: deps.claimDeliveryVariant === 'v2' || deps.claimDeliveryVariant === 'v3'
        ? evidenceHash
        : undefined,
      verdictCode: claimOptions.verdictCode,
    },
    deps.evictionRecovery,
  );
  console.log(`[harness-engine] claimDelivery tx=${claimTxHash}`);

  return { deliveryTxHash, claimTxHash };
}

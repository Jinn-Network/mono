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
import type { VerdictCode } from '../../adapters/mech/verdict-code.js';
import type { VenueBroadcaster } from '../../adapters/mech/safe.js';
import {
  cidToDigestHex,
} from '../../adapters/mech/ipfs.js';
import {
  callDeliverToMarketplace,
  claimDelivery,
  findLatestDeliveryForRequest,
  isDeliveryAlreadyClaimed,
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
  /**
   * The Safe broadcaster this delivery path routes through (finding E16 / the C2 ruling:
   * per-daemon state, not a process-global). Production wiring (main.ts) sets this once the
   * composition root has built one — see main.ts's "Stage-1 cutover composition root" section.
   * Undefined when no composition exists (mainnet today) — Safe writes then fail loudly via
   * `executeSafeTransaction`'s "no venue broadcaster supplied" error.
   */
  broadcaster?: VenueBroadcaster;
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

export interface MarketplaceDeliveryResult {
  deliveryTxHash: Hex;
  deliveryDigest: Hex;
}

export interface DeliveryClaimOptions {
  kind?: 'solution' | 'verdict';
  verdictCode?: VerdictCode;
}

export interface MarketplaceDeliveryExpectation {
  requestId: Hex;
  manifestCid: string;
  deliveryDigest: Hex;
  evidenceHash: Hex;
  role: 'solution' | 'verdict';
  fromBlock: bigint;
}

export type MarketplaceDeliveryRecoveryResult =
  | { state: 'absent' }
  | { state: 'contradictory'; detail: string }
  | (
    { state: 'matching'; deliveryTxHash: Hex }
    & MarketplaceDeliveryExpectation
  );

export interface MarketplaceDeliveryRecovery {
  resolveExistingDelivery(
    expected: MarketplaceDeliveryExpectation,
  ): Promise<MarketplaceDeliveryRecoveryResult>;
}

interface EnvelopeProjectionLookup {
  queryEnvelopeProjections(query: {
    requestId: string;
    envelopeRefs: readonly string[];
    limit: number;
  }): Array<{
    requestId: string | null;
    envelopeCid: string | null;
    signatureHash: string;
    role: 'solution' | 'verdict' | 'capture';
  }>;
}

export function createMarketplaceDeliveryRecovery(deps: {
  publicClient: PublicClient;
  mechContractAddress: Address;
  safeAddress: Address;
  store: EnvelopeProjectionLookup;
}): MarketplaceDeliveryRecovery {
  return {
    async resolveExistingDelivery(
      expected: MarketplaceDeliveryExpectation,
    ): Promise<MarketplaceDeliveryRecoveryResult> {
      const expectedDigest = cidToDigestHex(expected.manifestCid);
      if (expectedDigest.toLowerCase() !== expected.deliveryDigest.toLowerCase()) {
        return {
          state: 'contradictory',
          detail: 'persisted delivery digest does not match the envelope CID',
        };
      }

      const projections = deps.store.queryEnvelopeProjections({
        requestId: expected.requestId,
        envelopeRefs: [expected.manifestCid],
        limit: 2,
      });
      if (projections.length !== 1) {
        return {
          state: 'contradictory',
          detail: `expected one persisted envelope projection, found ${projections.length}`,
        };
      }
      const projection = projections[0]!;
      if (
        projection.requestId !== expected.requestId
        || projection.envelopeCid !== expected.manifestCid
        || projection.signatureHash.toLowerCase() !== expected.evidenceHash.toLowerCase()
        || projection.role !== expected.role
      ) {
        return {
          state: 'contradictory',
          detail: 'persisted envelope request, evidence, or role differs',
        };
      }

      const latestBlock = await deps.publicClient.getBlockNumber();
      const delivery = await findLatestDeliveryForRequest(
        deps.publicClient,
        deps.mechContractAddress,
        expected.requestId,
        expected.fromBlock,
        latestBlock,
      );
      if (!delivery) return { state: 'absent' };
      if (
        delivery.requestId.toLowerCase() !== expected.requestId.toLowerCase()
        || delivery.deliveryDataHex.toLowerCase() !== expected.deliveryDigest.toLowerCase()
        || delivery.mechAddress.toLowerCase() !== deps.safeAddress.toLowerCase()
        || !delivery.transactionHash
      ) {
        return {
          state: 'contradictory',
          detail: 'on-chain Deliver event request, envelope digest, operator, or transaction differs',
        };
      }

      return {
        state: 'matching',
        ...expected,
        deliveryTxHash: delivery.transactionHash,
      };
    },
  };
}

/** Deliver an envelope through Mech without recording it on JinnRouter. */
export async function deliverToMarketplace(
  requestId: Hex,
  manifestCid: string,
  deps: DeliveryDeps,
  requireExactRecovery = false,
): Promise<MarketplaceDeliveryResult> {
  const deliveryDigest = cidToDigestHex(manifestCid);
  console.log(`[harness-engine] deliverToMarketplace requestId=${requestId}`);
  const deliveryTxHash = await callDeliverToMarketplace(
    deps.publicClient,
    deps.walletClient,
    deps.broadcaster,
    deps.safeAddress,
    deps.mechContractAddress,
    [requestId],
    [deliveryDigest],
    deps.evictionRecovery,
    requireExactRecovery,
  );
  console.log(`[harness-engine] deliverToMarketplace tx=${deliveryTxHash}`);
  return { deliveryTxHash, deliveryDigest };
}

/** Record an already Mech-delivered envelope on JinnRouter. */
export async function claimRouterDelivery(
  requestId: Hex,
  evidenceHash: Hex,
  deps: DeliveryDeps,
  claimOptions: DeliveryClaimOptions = {},
): Promise<Hex> {
  console.log(`[harness-engine] claimDelivery requestId=${requestId}`);
  const claimTxHash = await claimDelivery(
    deps.publicClient,
    deps.walletClient,
    deps.broadcaster,
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
  return claimTxHash;
}

export async function isRouterDeliveryClaimed(
  requestId: Hex,
  deps: DeliveryDeps,
): Promise<boolean> {
  return isDeliveryAlreadyClaimed(
    deps.publicClient,
    deps.routerAddress,
    requestId,
  );
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
    const delivery = await deliverToMarketplace(requestId, manifestCid, deps);
    deliveryTxHash = delivery.deliveryTxHash;

    // Persist the tx hash before proceeding to claimDelivery. If the process
    // crashes between here and the COMPLETE transition, recovery will read this
    // hash and skip the deliver step.
    if (onDeliveryTxLanded) {
      await onDeliveryTxLanded(deliveryTxHash);
    }
  }

  const claimTxHash = await claimRouterDelivery(
    requestId,
    evidenceHash,
    deps,
    claimOptions,
  );

  return { deliveryTxHash, claimTxHash };
}

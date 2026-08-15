// SPDX-License-Identifier: MIT

// The marketplace deliver leg (Finding F1; program plan Task 8, homed in venue-base per
// coordinator amendment 2 -- a product-agnostic venue chain-write Autopilot's own adoption pass
// needs too). `settleDelivery` (`packages/marketplace/binding/src/settlement.ts:465`) reads the
// Mech `Deliver` event BEFORE `claimSolutionDelivery` and rejects with `digest-divergence`
// unless that event already carries the Delivery's raw-CID sha256 digest -- nothing else in the
// merged stack sends this transaction, so the host emits it here, funneled through the single
// venue Safe broadcaster (contract 1).
import {
  MECH_ABI,
  MECH_DELIVER_TO_MARKETPLACE_ABI,
  computeRawCodecCid,
} from "@jinn-network/marketplace-binding";
import { decodeEventLog, encodeFunctionData, type Address, type Hex } from "viem";
import type { BaseVenueSafeBroadcaster } from "./broadcast/safe-broadcaster.js";

export interface MechDeliverInput {
  readonly mechAddress: Address;
  readonly requestId: Hex;
  /** The exact sealed Delivery bytes the backend produced. */
  readonly deliveryBytes: Uint8Array;
}

/** Encodes `deliverToMarketplace([requestId], [rawCidDigest])`. Pure; exported for tests. */
export function encodeMechDeliverCalldata(input: {
  readonly requestId: Hex;
  readonly deliveryBytes: Uint8Array;
}): Hex {
  const { sha256Digest } = computeRawCodecCid(input.deliveryBytes);
  const digestHex = `0x${sha256Digest.slice("sha256:".length)}` as Hex;
  return encodeFunctionData({
    abi: MECH_DELIVER_TO_MARKETPLACE_ABI,
    functionName: "deliverToMarketplace",
    args: [[input.requestId], [digestHex]],
  });
}

/**
 * Belt-and-braces string match for a revert `broadcaster.classify()` cannot decode into
 * `"already-settled"` -- see the module doc on `deliverToMarketplace` for why that gap exists.
 */
const ALREADY_DELIVERED_FALLBACK = /AlreadyDelivered|already\s+delivered|RequestIdNotFound/iu;

/**
 * Emits the Mech Deliver fact today-mode settlement requires. Idempotent by construction.
 *
 * `logicalTx` is `` `deliver:${requestId}` ``: one mech Deliver call is exactly one logical
 * operation per requestId, so a retry of the SAME requestId adopts the broadcaster's pending tx
 * (correct -- see `safe-broadcaster.ts`'s `reconcile`), while two DIFFERENT requestIds never
 * collide on the same ledger key.
 *
 * Already-delivered detection was investigated against the real contracts before writing this
 * (`contracts/src/vendor/mech/OlasMech.sol`, `contracts/src/vendor/mech/MechMarketplace.sol`)
 * rather than assumed from the plan's regex-only sketch, and it needs two layers because the two
 * on-chain "already delivered" shapes are not the same failure mode:
 *
 * 1. Thrown-error path (a genuine Safe `execTransaction` inner revert). `broadcaster.classify()`
 *    is consulted first -- `"already-settled"` is the venue's own signal that an inner revert's
 *    effect is already on chain (`broadcast/classify.ts`). A regex fallback catches reverts
 *    `classify()` cannot decode: its known-selector table
 *    (`@jinn-network/marketplace-binding`'s `KNOWN_INNER_ERRORS`) covers only JinnRouterV3 +
 *    TaskCoordinator selectors, so a mech-level custom error decodes to "captured selector, no
 *    decoded name" and `classifyInnerRevert` calls that `"permanent"` -- the fallback exists for
 *    exactly that gap.
 * 2. Success path (no revert at all). `OlasMech.deliverToMarketplace` /
 *    `MechMarketplace.deliverMarketplace` do NOT revert when a requestId was already delivered
 *    by someone else: the delivery loop `continue`s that entry and emits `RevokeRequest` instead
 *    of `Deliver` (`MechMarketplace.sol` around the `requestInfo.deliveryMech != address(0)`
 *    check), so the Safe transaction still succeeds. `receipt.alreadySettled` only ever reflects
 *    a decoded *inner revert* and can never observe this no-op-but-successful case, so the only
 *    faithful signal here is whether OUR requestId's `Deliver` event actually landed in the
 *    receipt's logs.
 */
export async function deliverToMarketplace(
  input: MechDeliverInput,
  broadcaster: BaseVenueSafeBroadcaster,
): Promise<{ readonly delivered: "sent" | "already"; readonly txHash?: Hex }> {
  const data = encodeMechDeliverCalldata({
    requestId: input.requestId,
    deliveryBytes: input.deliveryBytes,
  });
  try {
    const receipt = await broadcaster.execute({
      to: input.mechAddress,
      value: 0n,
      data,
      logicalTx: `deliver:${input.requestId}`,
    });
    if (receipt.alreadySettled) return { delivered: "already" };
    const delivered = receipt.logs.some((log) => {
      try {
        const decoded = decodeEventLog({
          abi: MECH_ABI,
          data: log.data,
          topics: log.topics as [Hex, ...Hex[]],
          strict: true,
        });
        return decoded.eventName === "Deliver" && decoded.args.requestId === input.requestId;
      } catch {
        return false;
      }
    });
    return delivered ? { delivered: "sent", txHash: receipt.txHash } : { delivered: "already" };
  } catch (error) {
    if (broadcaster.classify(error) === "already-settled") return { delivered: "already" };
    const message = error instanceof Error ? error.message : String(error);
    if (ALREADY_DELIVERED_FALLBACK.test(message)) return { delivered: "already" };
    throw error;
  }
}

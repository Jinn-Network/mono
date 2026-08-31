// SPDX-License-Identifier: Apache-2.0

import { isNormalizedAbsoluteUri } from "@jinn-network/evidence-offer";
import type { OfferRail } from "@jinn-network/evidence-offer";
import type { Sha256Digest } from "@jinn-network/trust-core";

import { GateConfigurationError } from "./errors.js";

/**
 * What kind of thing stands behind a payment on this rail, in the buyer's own terms. The
 * gate never acts on this — it is self-description a rail publishes so an index can badge
 * it and a buyer can decide what they are willing to pay into before they pay.
 *
 * `assured-by-code` is an escrow contract that refunds on timeout; `assured-by-institution`
 * a card processor's chargeback right; `assured-by-named-party` a specific counterparty who
 * has said they will make it good; `unassured` is a bare transfer, where the buyer's only
 * recourse is not paying next time. `unassured` is a legitimate answer and the honest one
 * for most chain rails.
 */
export const RAIL_TRUST_MODELS = [
  "assured-by-code",
  "assured-by-institution",
  "assured-by-named-party",
  "unassured",
] as const;

export type RailTrustModel = (typeof RAIL_TRUST_MODELS)[number];

/**
 * When the holder's money actually becomes theirs, which is what decides whether the gate
 * calls `claim` at all.
 *
 * - `already-settled` — observing the payment is observing a completed transfer. Nothing
 *   is left to take. Most chain rails.
 * - `on-delivery` — the delivery act *is* the taking: revealing the decryption key, or
 *   releasing the escrow against the delivered subject. `deliver` is required and `claim`
 *   is forbidden, because a second taking step would be a second charge.
 * - `explicit-claim` — taking payment is its own act after delivery is agreed: a
 *   processor's capture against an authorization, an escrow release. `claim` is required.
 */
export const RAIL_SETTLEMENTS = ["already-settled", "on-delivery", "explicit-claim"] as const;

export type RailSettlement = (typeof RAIL_SETTLEMENTS)[number];

/**
 * What a rail says about itself. Every field is load-bearing at construction time, so an
 * adapter cannot claim a shape it does not implement.
 */
export interface RailSelfDescription {
  /**
   * The rail identifier, in the same normalized spelling the offer's `rails[].rail` uses.
   * It has to be: the gate matches an adapter to a sealed rail entry by exact string, and
   * the offer schema already refuses every other spelling of the same URI.
   */
  readonly rail: string;
  readonly trustModel: RailTrustModel;
  /**
   * Who carries the assurance — the escrow contract's address, the processor, the named
   * counterparty. Required for every model but `unassured`, and forbidden for that one, so
   * "assured" is never a word with nothing behind it.
   */
  readonly assuredBy?: string;
  readonly settlement: RailSettlement;
  /**
   * True when anyone can see that a payment referencing an offer was made — every public
   * chain. It is what makes pickup stealable, so it is what turns on the payer-proof leg:
   * `verifyPayerControl` is then required, and the gate will not serve without a proof.
   */
  readonly paymentsArePubliclyVisible: boolean;
}

export interface RailOperationOptions {
  readonly signal?: AbortSignal;
}

export interface ObservePaymentInput {
  /** The offer the payment must reference. A payment for another offer is not this one. */
  readonly offerDigest: Sha256Digest;
  /** The sealed rail entry — destination and exact amount — the payment must match. */
  readonly entry: OfferRail;
  /** The rail-specific handle the buyer says identifies their payment. */
  readonly reference: string;
}

/**
 * A payment the rail says it can see. The gate re-checks every field of this against the
 * sealed offer before it serves anything, so an adapter that is lax, buggy, or hostile can
 * widen its own rail's terms but never the offer's.
 */
export interface ObservedPayment {
  /**
   * The reference the observation was asked about, echoed back **exactly**. The gate refuses
   * an observation that names a different payment, because the holder's signed sales history
   * must not be able to record one the buyer never presented.
   *
   * So a rail must not canonicalize here — not lowercase a mixed-case transaction hash, not
   * trim an invoice id. Match however the rail likes; report the string it was given. A rail
   * with a canonical form should say so in its own vocabulary, so a buyer presents that form
   * in the first place.
   */
  readonly reference: string;
  /** The offer digest the payment references, as the rail read it. */
  readonly offerDigest: Sha256Digest;
  /** Where the money went, in the rail's own spelling of a destination. */
  readonly to: string;
  /** How much, as an integer string in the rail's native units. */
  readonly amount: string;
  /**
   * Who paid, in whatever way the rail identifies a payer. Opaque to the gate; it is
   * handed straight back to `verifyPayerControl`. Absent on rails that have no such notion,
   * which are exactly the rails whose payments are not publicly visible.
   */
  readonly payer?: string;
  /** When the rail saw it, if it knows. Ordering a supersession dispute is the rail's job. */
  readonly observedAt?: string;
}

export type PaymentObservation =
  | { readonly status: "observed"; readonly payment: ObservedPayment }
  | { readonly status: "not-found"; readonly detail: string }
  | { readonly status: "mismatched"; readonly detail: string };

/** A one-shot question the gate asks a would-be collector, to be answered by the paying key. */
export interface GateChallenge {
  readonly id: string;
  readonly nonce: string;
  readonly offerDigest: Sha256Digest;
  readonly rail: string;
  readonly paymentReference: string;
  readonly expiresAt: string;
}

export interface PayerControlInput {
  readonly payment: ObservedPayment;
  readonly challenge: GateChallenge;
  /** The requester's answer, in whatever form the rail's key material produces. */
  readonly proof: string;
}

export type PayerControlOutcome =
  | { readonly status: "proven" }
  | { readonly status: "refused"; readonly detail: string };

export interface RailDeliveryInput {
  readonly offerDigest: Sha256Digest;
  readonly subject: Sha256Digest;
  readonly payment: ObservedPayment;
}

/**
 * `already-delivered` is a success, and it is required for the same reason
 * `already-claimed` is: redelivery is free, so the gate runs this act on every collection
 * and the rail is the one that knows it has already happened.
 */
export type RailDeliveryOutcome =
  | { readonly status: "ready" }
  | { readonly status: "already-delivered" }
  | { readonly status: "refused"; readonly detail: string };

export interface ClaimPaymentInput {
  readonly offerDigest: Sha256Digest;
  readonly payment: ObservedPayment;
}

/**
 * `already-claimed` is a success, and that is what makes redelivery free: the gate keeps no
 * record of who has collected what, so it claims on every delivery and the rail is the one
 * that knows the money has already moved.
 */
export type ClaimOutcome =
  | { readonly status: "claimed" }
  | { readonly status: "already-claimed" }
  | { readonly status: "failed"; readonly detail: string };

/**
 * One payment system, as the gate consumes it. The gate implements no payment system and
 * knows no rail's rules; it knows only this lifecycle.
 *
 * The lifecycle is three steps rather than one `verify` call so that rails which carry
 * assurance fit without reshaping anything: an escrow contract observes a funded escrow,
 * releases it on delivery, and refunds on timeout; a key-reveal rail observes a purchase
 * and reveals the key at delivery, which is simultaneously the taking; a card processor
 * observes an authorization and captures it as its own act. A single verify call would
 * force all three to pretend payment is instantaneous and final at observation time.
 */
export interface RailAdapter {
  readonly description: RailSelfDescription;

  /** Step 1. Is there a payment referencing this offer that matches this rail entry? */
  observe(
    input: ObservePaymentInput,
    options: RailOperationOptions,
  ): Promise<PaymentObservation>;

  /**
   * Step 1b, required exactly when `paymentsArePubliclyVisible`. Pickup belongs to the
   * payer: an onlooker who read the payment off a public ledger must not be able to redeem
   * it.
   */
  verifyPayerControl?(
    input: PayerControlInput,
    options: RailOperationOptions,
  ): Promise<PayerControlOutcome>;

  /**
   * Step 2, the rail's own act at the moment of delivery. Required for `on-delivery`.
   *
   * **Must be idempotent for one payment.** The gate keeps no record of who has collected
   * what — that is what makes redelivery free — so it runs this act on every collection of
   * the same purchase, and on an `on-delivery` rail this act is the taking of the money. A
   * rail that settles a second time here charges twice; one that refuses the repeat breaks
   * free redelivery. Answer `already-delivered` instead.
   */
  deliver?(
    input: RailDeliveryInput,
    options: RailOperationOptions,
  ): Promise<RailDeliveryOutcome>;

  /** Step 3, taking the payment where that is a separate act. Required for `explicit-claim`. */
  claim?(
    input: ClaimPaymentInput,
    options: RailOperationOptions,
  ): Promise<ClaimOutcome>;
}

function fail(message: string): never {
  throw new GateConfigurationError(message);
}

/**
 * Refuses an adapter whose self-description and methods disagree, and hands back the
 * description it validated, frozen.
 *
 * Every rule here is one where the mismatch is silent and expensive at run time. An adapter
 * that says its payments are public but ships no payer-proof check does not fail; it serves
 * the first onlooker to quote the transaction hash. One that declares `on-delivery` and also
 * implements `claim` charges twice. Loud at construction is the only place these are cheap.
 *
 * The description is read exactly once and returned as a frozen copy, and a gate must use
 * that copy rather than reading the adapter again. `description` is an ordinary property of
 * third-party code and may be a getter: one that answers `paymentsArePubliclyVisible: true`
 * here and `false` afterwards would pass every check below and then be served to onlookers
 * with no challenge and no proof.
 */
export function assertConformingRailAdapter(adapter: RailAdapter): RailSelfDescription {
  const declared = adapter.description;
  const description: RailSelfDescription = Object.freeze({
    rail: declared.rail,
    trustModel: declared.trustModel,
    ...(declared.assuredBy === undefined ? {} : { assuredBy: declared.assuredBy }),
    settlement: declared.settlement,
    paymentsArePubliclyVisible: declared.paymentsArePubliclyVisible,
  });
  const { rail } = description;

  if (!isNormalizedAbsoluteUri(rail)) {
    fail(
      `rail adapter identifier "${rail}" is not an absolute URI in its normalized spelling, `
        + "so it can never equal an offer's sealed rail identifier",
    );
  }
  if (!RAIL_TRUST_MODELS.includes(description.trustModel)) {
    fail(`rail adapter "${rail}" declares unknown trust model "${description.trustModel}"`);
  }
  if (!RAIL_SETTLEMENTS.includes(description.settlement)) {
    fail(`rail adapter "${rail}" declares unknown settlement "${description.settlement}"`);
  }

  const assuredBy = description.assuredBy?.trim() ?? "";
  if (description.trustModel === "unassured") {
    if (description.assuredBy !== undefined) {
      fail(`rail adapter "${rail}" is unassured and must not name an assuring party`);
    }
  } else if (assuredBy === "") {
    fail(
      `rail adapter "${rail}" claims trust model "${description.trustModel}" and must name `
        + "the party carrying that assurance",
    );
  }

  if (description.paymentsArePubliclyVisible && adapter.verifyPayerControl === undefined) {
    fail(
      `rail adapter "${rail}" says its payments are publicly visible but implements no `
        + "payer-control check, so any onlooker could redeem someone else's payment",
    );
  }
  if (!description.paymentsArePubliclyVisible && adapter.verifyPayerControl !== undefined) {
    fail(
      `rail adapter "${rail}" implements a payer-control check the gate would never call, `
        + "because it says its payments are not publicly visible",
    );
  }

  if (description.settlement === "on-delivery") {
    if (adapter.deliver === undefined) {
      fail(
        `rail adapter "${rail}" settles on delivery and must implement deliver(), which is `
          + "where that settlement happens",
      );
    }
    if (adapter.claim !== undefined) {
      fail(
        `rail adapter "${rail}" settles on delivery and must not implement claim(): `
          + "delivery is the claim, and a second taking step is a second charge",
      );
    }
  }
  if (description.settlement === "explicit-claim" && adapter.claim === undefined) {
    fail(`rail adapter "${rail}" settles by explicit claim and must implement claim()`);
  }
  if (description.settlement === "already-settled" && adapter.claim !== undefined) {
    fail(
      `rail adapter "${rail}" says an observed payment is already settled and must not `
        + "implement claim(): there is nothing left to take",
    );
  }

  return description;
}

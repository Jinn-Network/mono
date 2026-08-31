// SPDX-License-Identifier: Apache-2.0

import { isFreeOffer, parseOfferEnvelope } from "@jinn-network/evidence-offer";
import type { OfferRail, OfferRecord } from "@jinn-network/evidence-offer";
import { recordDigest } from "@jinn-network/trust-core";
import type { DsseSigner, Sha256Digest } from "@jinn-network/trust-core";

import { GateConfigurationError } from "./errors.js";
import type { GateRefusalCode, GateWarning } from "./errors.js";
import { DELIVERY_STATEMENT_RECORD_KIND } from "./identifiers.js";
import { systemClock } from "./ports.js";
import type {
  ChallengeStore,
  Clock,
  GateOperationOptions,
  OfferSource,
  SubjectSource,
} from "./ports.js";
import { assertConformingRailAdapter } from "./rail.js";
import type {
  GateChallenge,
  ObservedPayment,
  RailAdapter,
  RailSelfDescription,
} from "./rail.js";
import { sealDeliveryStatement } from "./statement.js";
import type { SealedDeliveryStatement } from "./statement.js";

export interface GateHardLimits {
  /**
   * The largest subject this gate will read into memory and hand over. A gate answers
   * strangers, so the bound is on by default rather than opt-in; a holder selling large
   * artifacts raises it deliberately.
   */
  readonly maxSubjectBytes: number;
}

export const DEFAULT_GATE_HARD_LIMITS: GateHardLimits = Object.freeze({
  maxSubjectBytes: 64 * 1024 * 1024,
});

export interface GateRequestPayment {
  /** Which of the offer's rails was paid, in the offer's own spelling. */
  readonly rail: string;
  /** The rail-specific handle for the payment. */
  readonly reference: string;
}

export interface GatePayerProof {
  readonly challengeId: string;
  readonly proof: string;
}

export interface GateRequest {
  /** The offer whose terms this request is being made under. */
  readonly offer: Sha256Digest;
  /** Omitted for a free offer, which is the only offer it may be omitted for. */
  readonly payment?: GateRequestPayment;
  /** The answer to a challenge this gate issued, on rails whose payments are public. */
  readonly payerProof?: GatePayerProof;
}

export interface GateDelivery {
  readonly status: "delivered";
  readonly offer: Sha256Digest;
  readonly subject: Sha256Digest;
  /**
   * The exact bytes whose sha-256 is `subject`. The gate has already checked that; the
   * buyer checks it again on receipt, and that second check is the whole warranty.
   */
  readonly bytes: Uint8Array;
  /** Present only when this gate was built with a signer. */
  readonly statement?: SealedDeliveryStatement;
  readonly warnings: readonly GateWarning[];
}

export interface GateChallengeIssued {
  readonly status: "challenge";
  readonly challenge: GateChallenge;
}

export interface GateRefusal {
  readonly status: "refused";
  readonly code: GateRefusalCode;
  readonly detail: string;
}

export type GateOutcome = GateDelivery | GateChallengeIssued | GateRefusal;

export interface DeliveryStatementOptions {
  /**
   * The holder's signing key. Supplying one is the flag: with it the gate seals a statement
   * on every delivery, without it the gate emits nothing, and emitting nothing is
   * conforming.
   */
  readonly signer: DsseSigner;
}

export interface CreateRetrievalGateOptions {
  readonly offers: OfferSource;
  readonly subjects: SubjectSource;
  /** One adapter per rail this gate accepts. A gate with none serves free offers only. */
  readonly rails?: readonly RailAdapter[];
  /** Required as soon as one installed rail's payments are publicly visible. */
  readonly challenges?: ChallengeStore;
  readonly clock?: Clock;
  readonly deliveryStatements?: DeliveryStatementOptions;
  readonly hardLimits?: Partial<GateHardLimits>;
}

export interface RetrievalGate {
  /** What this gate accepts, so a buyer can read the trust models before paying. */
  readonly rails: readonly RailSelfDescription[];
  readonly hardLimits: GateHardLimits;
  request(input: GateRequest, options?: GateOperationOptions): Promise<GateOutcome>;
}

function refuse(code: GateRefusalCode, detail: string): GateRefusal {
  return { status: "refused", code, detail };
}

/**
 * A non-negative integer written in decimal. Deliberately wider than the offer schema's
 * amount rule, which forbids leading zeros because equal terms must seal to equal bytes: an
 * *observation* is not sealed, so an adapter that reports `"007"` is untidy rather than
 * wrong, and comparing the integers is what "integer-exact" means.
 */
const NON_NEGATIVE_INTEGER = /^[0-9]+$/u;

function amountsAreEqual(observed: string, sealed: string): boolean {
  if (!NON_NEGATIVE_INTEGER.test(observed) || !NON_NEGATIVE_INTEGER.test(sealed)) return false;
  return BigInt(observed) === BigInt(sealed);
}

/**
 * The gate's own check of an observation against the sealed rail entry, run after every
 * `observe` and never skipped.
 *
 * An adapter is third-party code speaking for a payment system the gate knows nothing
 * about, so this is where the offer's terms are actually enforced. It is why a lax, buggy,
 * or hostile adapter can misjudge its own rail but can never widen the offer: the
 * destination must be the sealed one, and the amount must equal the sealed one exactly.
 *
 * Exactly, including overpayment. A gate cannot make change, and a payment for a different
 * amount is a payment on different terms — possibly meant for a different offer entirely.
 * Refusing it is the answer that leaves the buyer able to explain the discrepancy to the
 * holder, whose chain and rail timestamps are what settle it.
 */
function disagreementWithSealedTerms(
  payment: ObservedPayment,
  offerDigest: Sha256Digest,
  entry: OfferRail,
): string | undefined {
  if (payment.offerDigest !== offerDigest) {
    return `the observed payment references offer ${payment.offerDigest}, not ${offerDigest}`;
  }
  if (payment.to !== entry.to) {
    return "the observed payment went to a destination the offer does not name";
  }
  if (!amountsAreEqual(payment.amount, entry.amount)) {
    return `the observed payment is ${payment.amount}, and the offer's exact price on this `
      + `rail is ${entry.amount}`;
  }
  return undefined;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The reference paid-retrieval gate: one flow for free and paid, with a per-rail payment
 * check in front of bounded exact-byte serving.
 *
 * Every side effect is an injected port, so the package itself performs no I/O and a holder
 * binds it to whatever they actually run.
 *
 * Three things this gate deliberately does not do:
 *
 * - It does not verify the holder's signature on the offers it serves. A gate serves the
 *   offers its own holder put on it; resolving a signature through key-binding records is
 *   the *buyer's* step, before they pay, and doing it here would put an announcement-chain
 *   walk in front of every byte.
 * - It does not consult supersession. An offer on the gate is an offer the gate honors,
 *   superseded or not — a payment made while terms were live is honored, and the holder's
 *   announcement chain plus the rail's timestamps order any dispute. Repricing announces new
 *   terms; it says nothing about the old ones. A holder who wants to stop honoring terms
 *   takes them off the gate, and that is delisting, a different act.
 * - It records nothing about who has collected what. Redelivery to the same payer is free
 *   because there is no bookkeeping that could make it anything else.
 *
 * A port that throws is left to throw. A refusal is a statement about the *terms*; a
 * resolver outage is not one, and must never be reported as though the buyer got something
 * wrong.
 */
export function createRetrievalGate(options: CreateRetrievalGateOptions): RetrievalGate {
  const adapters = new Map<string, RailAdapter>();
  for (const adapter of options.rails ?? []) {
    assertConformingRailAdapter(adapter);
    if (adapters.has(adapter.description.rail)) {
      throw new GateConfigurationError(
        `two rail adapters claim "${adapter.description.rail}"; a gate cannot know which `
          + "one speaks for a payment",
      );
    }
    adapters.set(adapter.description.rail, adapter);
  }

  const publicRail = [...adapters.values()].find(
    (adapter) => adapter.description.paymentsArePubliclyVisible,
  );
  if (publicRail !== undefined && options.challenges === undefined) {
    throw new GateConfigurationError(
      `rail "${publicRail.description.rail}" has publicly visible payments, so this gate `
        + "needs a challenge store to prove pickup belongs to the payer",
    );
  }

  const hardLimits: GateHardLimits = {
    ...DEFAULT_GATE_HARD_LIMITS,
    ...options.hardLimits,
  };
  if (!Number.isInteger(hardLimits.maxSubjectBytes) || hardLimits.maxSubjectBytes < 1) {
    throw new GateConfigurationError("maxSubjectBytes must be a positive integer");
  }

  const clock = options.clock ?? systemClock;
  const railDescriptions = Object.freeze(
    [...adapters.values()].map((adapter) => adapter.description),
  );

  async function resolveOffer(
    offerDigest: Sha256Digest,
    callOptions: GateOperationOptions,
  ): Promise<{ readonly offer: OfferRecord } | { readonly refusal: GateRefusal }> {
    const envelopeBytes = await options.offers.read(offerDigest, callOptions);
    if (envelopeBytes === null) {
      return { refusal: refuse("unknown-offer", `this gate holds no offer ${offerDigest}`) };
    }
    let parsed;
    try {
      parsed = parseOfferEnvelope(envelopeBytes);
    } catch (cause) {
      return {
        refusal: refuse(
          "offer-invalid",
          `the bytes held for ${offerDigest} are not a sealed offer: ${describe(cause)}`,
        ),
      };
    }
    if (parsed.digest !== offerDigest) {
      return {
        refusal: refuse(
          "offer-digest-mismatch",
          `the bytes held for ${offerDigest} seal to ${parsed.digest}`,
        ),
      };
    }
    return { offer: parsed.offer };
  }

  async function readSubject(
    subject: Sha256Digest,
    callOptions: GateOperationOptions,
  ): Promise<Uint8Array | GateRefusal> {
    const bytes = await options.subjects.read(subject, callOptions);
    if (bytes === null) {
      return refuse("subject-unavailable", `this gate holds no bytes for ${subject}`);
    }
    if (bytes.byteLength > hardLimits.maxSubjectBytes) {
      return refuse(
        "subject-too-large",
        `${subject} is ${bytes.byteLength} bytes and this gate serves at most `
          + `${hardLimits.maxSubjectBytes}`,
      );
    }
    const actual = recordDigest(bytes);
    if (actual !== subject) {
      // The buyer's hash check would catch this too. Catching it here means a holder whose
      // store has quietly corrupted learns from their own gate rather than from a customer.
      return refuse(
        "subject-digest-mismatch",
        `the bytes held for ${subject} hash to ${actual}, so they are not the subject`,
      );
    }
    return bytes;
  }

  async function settle(
    offer: OfferRecord,
    offerDigest: Sha256Digest,
    request: GateRequest,
    callOptions: GateOperationOptions,
    now: string,
  ): Promise<{ readonly adapter: RailAdapter; readonly payment: ObservedPayment } | GateOutcome> {
    const requested = request.payment;
    if (requested === undefined) {
      return refuse(
        "payment-required",
        `offer ${offerDigest} is priced on ${offer.rails.length} rail(s) and the request `
          + "named no payment",
      );
    }
    const entry = offer.rails.find((rail) => rail.rail === requested.rail);
    if (entry === undefined) {
      return refuse(
        "rail-not-offered",
        `offer ${offerDigest} does not carry rail "${requested.rail}"`,
      );
    }
    const adapter = adapters.get(entry.rail);
    if (adapter === undefined) {
      return refuse(
        "rail-unsupported",
        `this gate has no adapter for rail "${entry.rail}"`,
      );
    }

    const observation = await adapter.observe(
      { offerDigest, entry, reference: requested.reference },
      callOptions,
    );
    if (observation.status === "not-found") {
      return refuse("payment-not-found", observation.detail);
    }
    if (observation.status === "mismatched") {
      return refuse("payment-mismatch", observation.detail);
    }
    const { payment } = observation;
    const disagreement = disagreementWithSealedTerms(payment, offerDigest, entry);
    if (disagreement !== undefined) {
      return refuse("payment-mismatch", disagreement);
    }

    if (adapter.description.paymentsArePubliclyVisible) {
      // Checked at construction, so this is a type narrowing rather than a runtime branch.
      const challenges = options.challenges as ChallengeStore;
      if (request.payerProof === undefined) {
        return {
          status: "challenge",
          challenge: await challenges.issue(
            {
              offerDigest,
              rail: entry.rail,
              paymentReference: payment.reference,
              now,
            },
            callOptions,
          ),
        };
      }
      const challenge = await challenges.consume(
        request.payerProof.challengeId,
        now,
        callOptions,
      );
      if (challenge === undefined) {
        return refuse(
          "challenge-unknown",
          "the proof answers no challenge this gate has outstanding; ask again",
        );
      }
      // A challenge is bound to the exact pickup it was issued for. Without this, an answer
      // won for a cheap offer could be presented against an expensive one.
      if (
        challenge.offerDigest !== offerDigest
        || challenge.rail !== entry.rail
        || challenge.paymentReference !== payment.reference
      ) {
        return refuse(
          "challenge-unknown",
          "the proof answers a challenge issued for a different pickup",
        );
      }
      const control = await adapter.verifyPayerControl!(
        { payment, challenge, proof: request.payerProof.proof },
        callOptions,
      );
      if (control.status !== "proven") {
        return refuse("payer-proof-invalid", control.detail);
      }
    }

    return { adapter, payment };
  }

  return {
    rails: railDescriptions,
    hardLimits,

    async request(input, callOptions = {}) {
      const now = clock.now();

      const resolved = await resolveOffer(input.offer, callOptions);
      if ("refusal" in resolved) return resolved.refusal;
      const { offer } = resolved;
      // The offer schema already refuses anything that is not `sha256:<64 lowercase hex>`;
      // zod widens the field to `string` on the way out, and this restores the digest type
      // at the one place a validated value re-enters the gate's own vocabulary.
      const subject = offer.subject as Sha256Digest;

      let adapter: RailAdapter | undefined;
      let payment: ObservedPayment | undefined;

      if (isFreeOffer(offer)) {
        if (input.payment !== undefined) {
          return refuse(
            "payment-not-expected",
            `offer ${input.offer} is free and is served on sight; the request named a `
              + "payment, which is not the terms it was sealed with",
          );
        }
      } else {
        const settled = await settle(offer, input.offer, input, callOptions, now);
        if ("status" in settled) return settled;
        adapter = settled.adapter;
        payment = settled.payment;
      }

      const bytes = await readSubject(subject, callOptions);
      if (!(bytes instanceof Uint8Array)) return bytes;

      if (adapter?.deliver !== undefined && payment !== undefined) {
        const delivery = await adapter.deliver(
          { offerDigest: input.offer, subject, payment },
          callOptions,
        );
        if (delivery.status === "refused") {
          return refuse("rail-refused-delivery", delivery.detail);
        }
      }

      if (adapter?.claim !== undefined && payment !== undefined) {
        // After the bytes are read and verified, before they are handed back: a capture that
        // fails must cost the buyer their delivery, not the holder their payment. And
        // `already-claimed` is a success, which is what makes redelivery free.
        const claim = await adapter.claim({ offerDigest: input.offer, payment }, callOptions);
        if (claim.status === "failed") {
          return refuse("claim-failed", claim.detail);
        }
      }

      const warnings: GateWarning[] = [];
      let statement: SealedDeliveryStatement | undefined;
      if (options.deliveryStatements !== undefined) {
        try {
          statement = await sealDeliveryStatement({
            statement: {
              kind: DELIVERY_STATEMENT_RECORD_KIND,
              offer: input.offer,
              subject,
              ...(payment === undefined
                ? {}
                : { payment: { rail: input.payment!.rail, reference: payment.reference } }),
              deliveredAt: now,
            },
            signer: options.deliveryStatements.signer,
            ...(callOptions.signal === undefined ? {} : { signal: callOptions.signal }),
          });
        } catch (cause) {
          // The statement is optional by design, so its failure must not cost a buyer the
          // bytes they have already paid for — but it must not vanish silently either.
          warnings.push({ code: "statement-not-emitted", detail: describe(cause) });
        }
      }

      return {
        status: "delivered",
        offer: input.offer,
        subject,
        bytes,
        ...(statement === undefined ? {} : { statement }),
        warnings,
      };
    },
  };
}

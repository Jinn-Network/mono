// SPDX-License-Identifier: Apache-2.0

import { isFreeOffer, parseOfferEnvelope } from "@jinn-network/evidence-offer";
import type { OfferRail, OfferRecord } from "@jinn-network/evidence-offer";
import {
  compareCalendarStrictRfc3339Instants,
  isCalendarStrictRfc3339,
  recordDigest,
  Sha256DigestSchema,
} from "@jinn-network/trust-core";
import type { DsseSigner, Sha256Digest } from "@jinn-network/trust-core";
import { z } from "zod";

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
  ClaimOutcome,
  ClaimPaymentInput,
  GateChallenge,
  ObservedPayment,
  ObservePaymentInput,
  PayerControlInput,
  PayerControlOutcome,
  PaymentObservation,
  RailAdapter,
  RailDeliveryInput,
  RailDeliveryOutcome,
  RailOperationOptions,
  RailSelfDescription,
} from "./rail.js";
import { sealDeliveryStatement } from "./statement.js";
import type { SealedDeliveryStatement } from "./statement.js";

export interface GateHardLimits {
  /**
   * The largest subject this gate will hand over. A gate answers strangers, so the bound is
   * on by default rather than opt-in; a holder selling large artifacts raises it
   * deliberately.
   *
   * It bounds what is *served*, not what is read: `SubjectSource` returns whole bytes, so by
   * the time this applies the source has already produced them. A source reading from
   * somewhere unbounded owes its own read bound — which is where it belongs anyway, since
   * only the source knows a subject's size before fetching it.
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

/**
 * One rail as the gate holds it: the description it validated and the methods it captured, in
 * the same construction-time read.
 *
 * Nothing here is looked up on the adapter again. An adapter is third-party code and every
 * one of these is an ordinary property that may be a getter: one that grows a `claim` after
 * passing conformance as `on-delivery` would get both money-moving acts run, which is the
 * exact double charge conformance refuses that combination to prevent; and one that answers
 * a function to the presence check and `undefined` to the call would raise a `TypeError`
 * where a typed refusal belongs. Capturing once is what makes the checks mean anything.
 */
interface InstalledRail {
  readonly description: RailSelfDescription;
  readonly observe: (
    input: ObservePaymentInput,
    options: RailOperationOptions,
  ) => Promise<PaymentObservation>;
  readonly verifyPayerControl?: (
    input: PayerControlInput,
    options: RailOperationOptions,
  ) => Promise<PayerControlOutcome>;
  readonly deliver?: (
    input: RailDeliveryInput,
    options: RailOperationOptions,
  ) => Promise<RailDeliveryOutcome>;
  readonly claim?: (
    input: ClaimPaymentInput,
    options: RailOperationOptions,
  ) => Promise<ClaimOutcome>;
}

/**
 * Capture first, then validate the capture — never the adapter.
 *
 * Validating the adapter and then reading its methods again is two reads of one property,
 * and two reads of a getter can differ: a `claim` that answers `undefined` while the
 * `on-delivery` rule is checked and a function immediately after would pass conformance and
 * then be called, running both money-moving acts. So every property is read exactly once,
 * into `captured`, and it is `captured` that is judged and `captured` that is used.
 *
 * The bind target is still the adapter, so `this` is what an ordinary `adapter.fn(...)` call
 * would have given it.
 */
function installRail(adapter: RailAdapter): InstalledRail {
  const { description, observe, verifyPayerControl, deliver, claim } = adapter;
  // Annotated, not asserted: an assertion would stay legal if `RailAdapter` grew a required
  // member, and the capture would silently drop it.
  const captured: RailAdapter = {
    description,
    observe,
    ...(verifyPayerControl === undefined ? {} : { verifyPayerControl }),
    ...(deliver === undefined ? {} : { deliver }),
    ...(claim === undefined ? {} : { claim }),
  };
  // Also proves each captured member is callable, so the binds below cannot raise a
  // TypeError where this package promises a GateConfigurationError.
  const validated = assertConformingRailAdapter(captured);
  return {
    description: validated,
    observe: observe.bind(adapter),
    ...(verifyPayerControl === undefined
      ? {}
      : { verifyPayerControl: verifyPayerControl.bind(adapter) }),
    ...(deliver === undefined ? {} : { deliver: deliver.bind(adapter) }),
    ...(claim === undefined ? {} : { claim: claim.bind(adapter) }),
  };
}

interface SettledPayment {
  readonly rail: InstalledRail;
  /** The sealed rail entry the payment matched, which is where the rail spelling comes from. */
  readonly entry: OfferRail;
  readonly payment: ObservedPayment;
}

function refuse(code: GateRefusalCode, detail: string): GateRefusal {
  return { status: "refused", code, detail };
}

/**
 * The shape of the two caller-supplied objects on a request, checked before anything is read
 * off them — and parsed rather than merely tested, so what the gate uses afterwards is a
 * fresh object it read once itself.
 *
 * For the same reason `input.offer` is checked: `GateRequest`'s fields are ordinary
 * TypeScript types rather than validated brands, `JSON.parse` returns `any`, and so
 * `const request: GateRequest = JSON.parse(body)` needs no cast anywhere. Without this,
 * `{"offer":"sha256:…","payment":null}` reached `requested.rail` and threw a `TypeError` —
 * and this package's contract is that a port that throws is left to throw, so a transport
 * written to it maps that to a resolver outage and answers 5xx. A five-byte payload from an
 * unauthenticated stranger must not be indistinguishable from the holder's store being down.
 */
const GateRequestPaymentSchema = z.object({
  rail: z.string(),
  reference: z.string(),
});

const GatePayerProofSchema = z.object({
  challengeId: z.string(),
  proof: z.string(),
});

/**
 * Whether the request is a thing whose properties can be read at all.
 *
 * The same reasoning as the two schemas above, one level up: `GateRequest`'s fields are
 * ordinary TypeScript types, so `const request: GateRequest = JSON.parse(body)` needs no
 * cast, and a transport reaches `request()` with whatever a stranger sent. `null` is the one
 * JSON value where reading a property throws instead of answering `undefined`, and a throw
 * from this package means "a port failed" to anything written against it.
 */
function isReadableGateRequest(input: unknown): input is GateRequest {
  return typeof input === "object" && input !== null;
}

/**
 * The gate's own copy of an observation, read exactly once per member.
 *
 * `PaymentObservation.payment` is the adapter's own object, and an adapter is third-party
 * code whose properties may be getters: `disagreementWithSealedTerms` would check one read
 * of `reference` and the sealed delivery statement would name a later one. That is exactly
 * the outcome that check exists to prevent — the holder's signed sales history naming a
 * payment the buyer never presented — so the checked value and the signed value have to be
 * the same value, not the same expression evaluated twice.
 *
 * The same discipline `installRail` applies to the adapter itself, applied to the one
 * third-party object that crosses the boundary per request.
 */
function captureObservedPayment(observed: ObservedPayment): ObservedPayment {
  const reference = observed.reference;
  const offerDigest = observed.offerDigest;
  const to = observed.to;
  const amount = observed.amount;
  const payer = observed.payer;
  const observedAt = observed.observedAt;
  return Object.freeze({
    reference,
    offerDigest,
    to,
    amount,
    ...(payer === undefined ? {} : { payer }),
    ...(observedAt === undefined ? {} : { observedAt }),
  });
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
  requestedReference: string,
): string | undefined {
  if (payment.reference !== requestedReference) {
    // Not exploitable on its own -- the challenge and the sealed statement both use the
    // adapter's reference, so the gate stays self-consistent. It is checked because the
    // holder's signed sales history must not be able to name a payment the buyer never
    // presented.
    return "the rail reported a different payment than the one the request named";
  }
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
  // The ports are read once here, and it is these locals every request uses. They are the
  // holder's own configuration rather than third-party code, which is why this is tidiness
  // rather than a defense — but it makes the doctrine uniform with `installRail`, and it
  // makes the `challenges` narrowing below a fact about the value the gate actually calls
  // rather than about one earlier read of a property.
  const { offers, subjects, challenges, deliveryStatements } = options;
  const adapters = new Map<string, InstalledRail>();
  for (const adapter of options.rails ?? []) {
    const installed = installRail(adapter);
    if (adapters.has(installed.description.rail)) {
      throw new GateConfigurationError(
        `two rail adapters claim "${installed.description.rail}"; a gate cannot know which `
          + "one speaks for a payment",
      );
    }
    adapters.set(installed.description.rail, installed);
  }

  const publicRail = [...adapters.values()].find(
    (installed) => installed.description.paymentsArePubliclyVisible,
  );
  if (publicRail !== undefined && challenges === undefined) {
    throw new GateConfigurationError(
      `rail "${publicRail.description.rail}" has publicly visible payments, so this gate `
        + "needs a challenge store to prove pickup belongs to the payer",
    );
  }

  // Frozen, like `DEFAULT_GATE_HARD_LIMITS` and every validated `RailSelfDescription`: this
  // is the object `gate.hardLimits` publishes *and* the object every request reads its bound
  // from, so an unfrozen one lets a later write change what the gate serves.
  const hardLimits: GateHardLimits = Object.freeze({
    ...DEFAULT_GATE_HARD_LIMITS,
    ...options.hardLimits,
  });
  if (!Number.isInteger(hardLimits.maxSubjectBytes) || hardLimits.maxSubjectBytes < 1) {
    throw new GateConfigurationError("maxSubjectBytes must be a positive integer");
  }

  const clock = options.clock ?? systemClock;
  const railDescriptions = Object.freeze(
    [...adapters.values()].map((installed) => installed.description),
  );

  async function resolveOffer(
    offerDigest: Sha256Digest,
    callOptions: GateOperationOptions,
  ): Promise<{ readonly offer: OfferRecord } | { readonly refusal: GateRefusal }> {
    const envelopeBytes = await offers.read(offerDigest, callOptions);
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
  ): Promise<{ readonly bytes: Uint8Array } | { readonly refusal: GateRefusal }> {
    const bytes = await subjects.read(subject, callOptions);
    if (bytes === null) {
      return {
        refusal: refuse("subject-unavailable", `this gate holds no bytes for ${subject}`),
      };
    }
    if (bytes.byteLength > hardLimits.maxSubjectBytes) {
      return {
        refusal: refuse(
          "subject-too-large",
          `${subject} is ${bytes.byteLength} bytes and this gate serves at most `
            + `${hardLimits.maxSubjectBytes}`,
        ),
      };
    }
    const actual = recordDigest(bytes);
    if (actual !== subject) {
      // The buyer's hash check would catch this too. Catching it here means a holder whose
      // store has quietly corrupted learns from their own gate rather than from a customer.
      return {
        refusal: refuse(
          "subject-digest-mismatch",
          `the bytes held for ${subject} hash to ${actual}, so they are not the subject`,
        ),
      };
    }
    return { bytes };
  }

  async function settle(
    offer: OfferRecord,
    offerDigest: Sha256Digest,
    request: GateRequest,
    callOptions: GateOperationOptions,
    now: string,
  ): Promise<SettledPayment | GateOutcome> {
    // Parsed, not tested: `requested` below is this function's own copy, so a caller whose
    // `rail` is a getter cannot answer one string to the lookup and another to the refusal.
    const parsedPayment = GateRequestPaymentSchema.safeParse(request.payment);
    if (!parsedPayment.success) {
      // `payment-required` covers a malformed payment as well as an absent one, and says the
      // same true thing to the buyer: this offer is priced, and the request named no payment
      // the gate can act on. Nothing about the shape of what they sent is worth telling a
      // stranger beyond that.
      return refuse(
        "payment-required",
        `offer ${offerDigest} is priced on ${offer.rails.length} rail(s) and the request `
          + "named no payment",
      );
    }
    const requested = parsedPayment.data;
    const entry = offer.rails.find((rail) => rail.rail === requested.rail);
    if (entry === undefined) {
      return refuse(
        "rail-not-offered",
        // Quoted by `JSON.stringify`, as the digest refusal is: a rail identifier is
        // caller-supplied and the offer schema's own `RailDestination` rule forbids bidi
        // controls precisely because a detail string is what a human reads back in a dispute.
        `offer ${offerDigest} does not carry rail ${JSON.stringify(requested.rail)}`,
      );
    }
    const rail = adapters.get(entry.rail);
    if (rail === undefined) {
      return refuse(
        "rail-unsupported",
        `this gate has no adapter for rail "${entry.rail}"`,
      );
    }
    const { description } = rail;

    const observation = await rail.observe(
      { offerDigest, entry, reference: requested.reference },
      callOptions,
    );
    // The discriminant, read once, for the reason `captureObservedPayment` reads the payment
    // once: an adapter whose `status` is a getter would otherwise answer `"observed"` to the
    // first branch and `"not-found"` to the second, and fall through to a `TypeError` on the
    // payment that is not there. No terms can widen either way — whatever `payment` turns out
    // to be is still checked against the sealed entry — but a documented invariant should
    // hold.
    const status = observation.status;
    if (status === "not-found") {
      return refuse("payment-not-found", observation.detail);
    }
    if (status === "mismatched") {
      return refuse("payment-mismatch", observation.detail);
    }
    const payment = captureObservedPayment(observation.payment);
    const disagreement = disagreementWithSealedTerms(
      payment,
      offerDigest,
      entry,
      requested.reference,
    );
    if (disagreement !== undefined) {
      return refuse("payment-mismatch", disagreement);
    }

    if (description.paymentsArePubliclyVisible) {
      // Checked at construction against this very local, so it is a type narrowing rather
      // than a runtime branch.
      const store = challenges as ChallengeStore;
      // A proof the gate cannot read is not an answer, so it gets the same reply as no
      // answer at all: a fresh question. That also keeps a caller-supplied `challengeId` of
      // any other type out of the holder's own store, which carries no promise about what it
      // is handed.
      const parsedProof = GatePayerProofSchema.safeParse(request.payerProof);
      if (!parsedProof.success) {
        return {
          status: "challenge",
          challenge: await store.issue(
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
      const payerProof = parsedProof.data;
      const challenge = await store.consume(
        payerProof.challengeId,
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
      // And its expiry, for the same reason: `expiresAt` is on the value the store returned,
      // so the store is not the only thing that gets to decide the answer is still live. The
      // shipped store checks it; a holder's does not have to be trusted to.
      // Compared as instants rather than strings: RFC 3339 permits an offset, so two
      // spellings of the same moment do not order lexically. Compared with the *same* parser
      // the gate validated `now` with, too. `Date.parse` is not that parser: it returns
      // `NaN` for a real leap second, which `isCalendarStrictRfc3339` accepts, and every
      // comparison against `NaN` is `false` — so a holder-pinned clock reading `:60` skipped
      // this branch entirely and a long-expired challenge was honored. A belt added to stop
      // the store being the only thing that decides an answer is still live must not fail in
      // the open direction on an instant this gate itself called valid one line earlier.
      // `undefined` means one of the two is unreadable, which is also expired.
      const stillLive = compareCalendarStrictRfc3339Instants(challenge.expiresAt, now);
      if (stillLive === undefined || stillLive <= 0) {
        return refuse(
          "challenge-unknown",
          "the proof answers a challenge that has expired; ask again",
        );
      }
      // Captured in the same construction-time read as the description that requires it, so
      // this cannot be an adapter that has since dropped the method.
      const control = await rail.verifyPayerControl!(
        { payment, challenge, proof: payerProof.proof },
        callOptions,
      );
      if (control.status !== "proven") {
        return refuse("payer-proof-invalid", control.detail);
      }
    }

    return { rail, entry, payment };
  }

  return {
    rails: railDescriptions,
    hardLimits,

    async request(input, callOptions = {}) {
      const now = clock.now();
      if (!isCalendarStrictRfc3339(now)) {
        // A deployment defect, not a request outcome: a challenge minted against an
        // unreadable instant has no expiry anyone can evaluate, and a delivery statement
        // sealed with one is not a record. Loud, and the same answer for every path.
        throw new GateConfigurationError(
          `the gate clock produced ${JSON.stringify(now)}, which is not an RFC 3339 instant`,
        );
      }

      // The request itself is caller-supplied, so it is checked before any property is read
      // off it — for the reason `GateRequestPaymentSchema` exists one level down.
      // `JSON.parse("null")` is a four-byte body and a valid JSON document, and `null` is the
      // one JSON value where a property access throws rather than answering `undefined`.
      // Every other shape (`[]`, `"x"`, `123`, `true`, `{}`) already refused correctly. A
      // `TypeError` here would be indistinguishable from the holder's store being down,
      // because this package's contract is that a port that throws is left to throw.
      if (!isReadableGateRequest(input)) {
        return refuse("unknown-offer", "this request named no offer");
      }

      // Read once, and it is this read that is checked and this read that is used.
      //
      // `input` is caller-supplied and an in-process caller can hand the gate getters, so
      // re-reading `input.offer` at each use is the `ObservedPayment` hazard at the request's
      // own most load-bearing field: reads 1–3 could answer a cheap offer honestly through
      // resolution and every amount and destination check, and reads 4–6 a pricey one — which
      // is what `claim()` would then be handed and what the holder would sign a sale of. The
      // shape check below likewise has to guard the value the `OfferSource` actually sees,
      // not a sibling read of it, or `ports.ts`'s promise that a source is always handed
      // `sha256:<64 lowercase hex>` — the promise that makes interpolating it into a path
      // safe — is not kept.
      const offerDigest = input.offer;

      // The offer digest is caller-supplied and goes to a holder-written `OfferSource` as
      // the first thing this does, so its shape is checked before any I/O. `Sha256Digest` is
      // a template-literal type rather than a validated brand, so a transport that builds the
      // string satisfies it with no cast: `sha256:../../../../etc/hosts` reaches the port,
      // where the natural `join(dir, `${digest}.dsse`)` reads outside the store. Content
      // never leaks — `resolveOffer` re-derives the digest — but the read itself, and the
      // refusal code that distinguishes "no such path" from "not an offer", are a
      // file-existence oracle for any stranger. `unknown-offer` is the right answer: it is
      // already indistinguishable from delisting, which is the posture this gate takes.
      if (!Sha256DigestSchema.safeParse(offerDigest).success) {
        return refuse(
          "unknown-offer",
          `this gate holds no offer ${JSON.stringify(offerDigest)}`,
        );
      }

      const resolved = await resolveOffer(offerDigest, callOptions);
      if ("refusal" in resolved) return resolved.refusal;
      const { offer } = resolved;
      // The offer schema already refuses anything that is not `sha256:<64 lowercase hex>`;
      // zod widens the field to `string` on the way out, and this restores the digest type
      // at the one place a validated value re-enters the gate's own vocabulary.
      const subject = offer.subject as Sha256Digest;

      let settled: SettledPayment | undefined;

      if (isFreeOffer(offer)) {
        if (input.payment !== undefined) {
          return refuse(
            "payment-not-expected",
            `offer ${offerDigest} is free and is served on sight; the request named a `
              + "payment, which is not the terms it was sealed with",
          );
        }
      } else {
        const outcome = await settle(offer, offerDigest, input, callOptions, now);
        if ("status" in outcome) return outcome;
        settled = outcome;
      }

      const read = await readSubject(subject, callOptions);
      if ("refusal" in read) return read.refusal;
      const { bytes } = read;

      if (settled?.rail.deliver !== undefined) {
        // `already-delivered` is a success, like `already-claimed`: the gate keeps no record
        // of who has collected what, so it runs this act on every collection of the same
        // purchase and the rail is the one that knows it has already happened.
        const delivery = await settled.rail.deliver(
          { offerDigest, subject, payment: settled.payment },
          callOptions,
        );
        if (delivery.status === "refused") {
          return refuse("rail-refused-delivery", delivery.detail);
        }
      }

      if (settled?.rail.claim !== undefined) {
        // After the bytes are read and verified, before they are handed back: a capture that
        // fails must cost the buyer their delivery, not the holder their payment. And
        // `already-claimed` is a success, which is what makes redelivery free.
        const claim = await settled.rail.claim(
          { offerDigest, payment: settled.payment },
          callOptions,
        );
        if (claim.status === "failed") {
          return refuse("claim-failed", claim.detail);
        }
      }

      const warnings: GateWarning[] = [];
      let statement: SealedDeliveryStatement | undefined;
      if (deliveryStatements !== undefined) {
        try {
          statement = await sealDeliveryStatement({
            statement: {
              kind: DELIVERY_STATEMENT_RECORD_KIND,
              offer: offerDigest,
              subject,
              ...(settled === undefined
                ? {}
                : {
                    payment: {
                      // The sealed spelling, not the requester's -- equal by construction,
                      // but this is the one that was checked against the offer.
                      rail: settled.entry.rail,
                      reference: settled.payment.reference,
                    },
                  }),
              deliveredAt: now,
            },
            signer: deliveryStatements.signer,
            ...(callOptions.signal === undefined ? {} : { signal: callOptions.signal }),
          });
        } catch {
          // The statement is optional by design, so its failure must not cost a buyer the
          // bytes they have already paid for — but it must not vanish silently either.
          //
          // The cause is deliberately not echoed. A signer is the holder's own key
          // material, and a KMS refusal carrying a key ARN and an internal hostname would
          // otherwise reach an unauthenticated buyer in `warnings[0].detail`. What the buyer
          // needs to know is that no statement came with their bytes; why is the holder's,
          // and the signer they supplied is the code that saw it.
          warnings.push({
            code: "statement-not-emitted",
            detail: "this gate could not seal a delivery statement for this delivery",
          });
        }
      }

      return {
        status: "delivered",
        offer: offerDigest,
        subject,
        bytes,
        ...(statement === undefined ? {} : { statement }),
        warnings,
      };
    },
  };
}

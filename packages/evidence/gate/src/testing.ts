// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { OFFER_RECORD_KIND, sealOffer, sortOfferRails } from "@jinn-network/evidence-offer";
import type { OfferRail, SealedOffer } from "@jinn-network/evidence-offer";
import type { DsseSigner, Sha256Digest } from "@jinn-network/trust-core";
import { describe, expect, test } from "vitest";

import { assertConformingRailAdapter } from "./rail.js";
import type {
  ClaimOutcome,
  GateChallenge,
  ObservedPayment,
  PaymentObservation,
  RailAdapter,
  RailSelfDescription,
  RailSettlement,
  RailTrustModel,
} from "./rail.js";

/**
 * A deterministic stand-in for a DSSE signature: it emits `sha256(preAuthEncoding)`.
 *
 * Sound in this tree for the same reason it is sound in the offer package's fixtures — DSSE
 * signature checking is an injected verifier port everywhere, never something a record
 * package does itself, so these signature bytes are opaque to every code path a gate test
 * exercises. Never use it outside fixtures and tests.
 */
export function createFixtureSigner(keyid = "did:key:zGateFixtureSigner") {
  return async (request: { readonly preAuthEncoding: Uint8Array }) =>
    [
      {
        signature: new Uint8Array(createHash("sha256").update(request.preAuthEncoding).digest()),
        keyid,
      },
    ] as const;
}

/**
 * What a payer knows and an onlooker does not: the answer to a challenge, computed from a
 * secret only the paying key holds.
 *
 * A real rail's proof is a signature by the paying key, and it must cover the **whole**
 * challenge rather than the nonce alone — which is why this covers the whole challenge, so
 * the recipe a rail author copies is the safe one. A proof over the nonce by itself is
 * relayable across gates: an attacker running gate M takes a nonce from honest gate H,
 * re-issues it as M's own challenge to someone transacting with M, and replays the answer at
 * H. Binding the offer, rail, and payment reference into the signed material is what makes
 * an answer worthless anywhere but the pickup it was asked about.
 *
 * The shared secret stands in for key material, which is enough to model the one property
 * the gate depends on: reading a payment off a public ledger tells you who paid, and still
 * does not let you answer for them.
 */
export function signTestPayerProof(secret: string, challenge: GateChallenge): string {
  const bound = [
    "jinn-gate-payer-proof/v1",
    challenge.offerDigest,
    challenge.rail,
    challenge.paymentReference,
    challenge.nonce,
  ].join("\u0000");
  return createHash("sha256").update(`${secret}\u0000${bound}`).digest("hex");
}

export interface SealTestOfferInput {
  readonly subject: Sha256Digest;
  /** Empty, or omitted, is the free offer. Entries are sorted for you. */
  readonly rails?: readonly OfferRail[];
  readonly gate?: string;
  readonly supersedes?: Sha256Digest;
  readonly signer?: DsseSigner;
}

/**
 * Seals an offer with the fixture signer, so a gate test can state terms in one line.
 *
 * It sorts the rail entries, which the offer schema requires and deliberately refuses to do
 * itself. Nothing else here is a shortcut: this produces a real sealed offer, and the gate
 * under test parses it the same way it parses one from a stranger.
 */
export async function sealTestOffer(input: SealTestOfferInput): Promise<SealedOffer> {
  return sealOffer({
    offer: {
      kind: OFFER_RECORD_KIND,
      subject: input.subject,
      rails: sortOfferRails(input.rails ?? []),
      gate: { uri: input.gate ?? "https://gate.test.example/v1" },
      ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
    },
    signer: input.signer ?? createFixtureSigner(),
  });
}

export interface TestRailPayment {
  readonly reference: string;
  readonly offerDigest: Sha256Digest;
  readonly to: string;
  readonly amount: string;
  readonly payer?: string;
  readonly observedAt?: string;
}

export interface CreateTestRailAdapterOptions {
  readonly rail?: string;
  readonly trustModel?: RailTrustModel;
  readonly assuredBy?: string;
  readonly settlement?: RailSettlement;
  readonly paymentsArePubliclyVisible?: boolean;
  /** Payments the rail can already see. */
  readonly payments?: readonly TestRailPayment[];
  /** Payer identifier to the secret that answers a challenge for it. */
  readonly payerSecrets?: Readonly<Record<string, string>>;
}

export interface TestRailAdapter extends RailAdapter {
  /** Makes a payment visible to the rail, as though it had just landed. */
  record(payment: TestRailPayment): void;
  /** Every claim the gate has made, in order. Empty on rails that need no claim. */
  readonly claims: readonly ClaimOutcome["status"][];
  /** The subject of every delivery act the gate ran that actually settled, in order. */
  readonly deliveries: readonly Sha256Digest[];
  /** Makes the next claim decline once, the way a capture against a dead card does. */
  failNextClaim(detail: string): void;
  /** Makes the next delivery act refuse once. */
  refuseNextDelivery(detail: string): void;
}

const DEFAULT_TEST_RAIL = "https://rails.test.example/v1";

/**
 * An in-memory rail, and the only rail binding this package ships.
 *
 * It is a test double, not a payment system: it holds a list of payments it can see and
 * answers the three-step lifecycle over them. Every axis a real rail varies on — trust
 * model, settlement, whether payments are publicly visible — is a construction option, so
 * one double covers the whole matrix the gate has to handle.
 */
export function createTestRailAdapter(
  options: CreateTestRailAdapterOptions = {},
): TestRailAdapter {
  const settlement = options.settlement ?? "already-settled";
  const paymentsArePubliclyVisible = options.paymentsArePubliclyVisible ?? false;
  const trustModel = options.trustModel ?? "unassured";
  const description: RailSelfDescription = {
    rail: options.rail ?? DEFAULT_TEST_RAIL,
    trustModel,
    ...(trustModel === "unassured"
      ? {}
      : { assuredBy: options.assuredBy ?? "the test rail's own escrow" }),
    settlement,
    paymentsArePubliclyVisible,
  };

  const ledger = new Map<string, TestRailPayment>();
  for (const payment of options.payments ?? []) ledger.set(payment.reference, payment);
  const payerSecrets = new Map(Object.entries(options.payerSecrets ?? {}));
  const claimed = new Set<string>();
  const handedOver = new Set<string>();
  const claims: ClaimOutcome["status"][] = [];
  const deliveries: Sha256Digest[] = [];
  let nextClaimFailure: string | undefined;
  let nextDeliveryRefusal: string | undefined;

  const observed = (payment: TestRailPayment): ObservedPayment => ({
    reference: payment.reference,
    offerDigest: payment.offerDigest,
    to: payment.to,
    amount: payment.amount,
    ...(payment.payer === undefined ? {} : { payer: payment.payer }),
    ...(payment.observedAt === undefined ? {} : { observedAt: payment.observedAt }),
  });

  const adapter: TestRailAdapter = {
    description,
    claims,
    deliveries,

    record(payment) {
      ledger.set(payment.reference, payment);
    },

    failNextClaim(detail) {
      nextClaimFailure = detail;
    },

    refuseNextDelivery(detail) {
      nextDeliveryRefusal = detail;
    },

    async observe(input): Promise<PaymentObservation> {
      const payment = ledger.get(input.reference);
      if (payment === undefined) {
        return {
          status: "not-found",
          detail: `this rail sees no payment ${input.reference}`,
        };
      }
      if (payment.offerDigest !== input.offerDigest) {
        return {
          status: "mismatched",
          detail: `payment ${input.reference} references a different offer`,
        };
      }
      return { status: "observed", payment: observed(payment) };
    },

    ...(paymentsArePubliclyVisible
      ? {
          async verifyPayerControl(input) {
            const secret =
              input.payment.payer === undefined
                ? undefined
                : payerSecrets.get(input.payment.payer);
            if (secret === undefined) {
              return {
                status: "refused" as const,
                detail: "this rail knows no key for the paying account",
              };
            }
            return signTestPayerProof(secret, input.challenge) === input.proof
              ? { status: "proven" as const }
              : {
                  status: "refused" as const,
                  detail: "the answer was not produced by the paying key",
                };
          },
        }
      : {}),

    ...(settlement === "on-delivery"
      ? {
          async deliver(input) {
            if (nextDeliveryRefusal !== undefined) {
              const detail = nextDeliveryRefusal;
              nextDeliveryRefusal = undefined;
              return { status: "refused" as const, detail };
            }
            // Idempotent per payment, because on this settlement the delivery act IS the
            // taking: the gate runs it on every collection, and settling twice is charging
            // twice.
            if (handedOver.has(input.payment.reference)) {
              return { status: "already-delivered" as const };
            }
            handedOver.add(input.payment.reference);
            deliveries.push(input.subject);
            return { status: "ready" as const };
          },
        }
      : {}),

    ...(settlement === "explicit-claim"
      ? {
          async claim(input) {
            if (nextClaimFailure !== undefined) {
              const detail = nextClaimFailure;
              nextClaimFailure = undefined;
              claims.push("failed");
              return { status: "failed" as const, detail };
            }
            const already = claimed.has(input.payment.reference);
            claimed.add(input.payment.reference);
            const status = already ? ("already-claimed" as const) : ("claimed" as const);
            claims.push(status);
            return { status };
          },
        }
      : {}),
  };

  return adapter;
}

export interface RailAdapterConformanceSubject {
  readonly adapter: RailAdapter;
  /** An offer digest the adapter will observe a payment against. */
  readonly offerDigest: Sha256Digest;
  /** The sealed rail entry that payment matches exactly. */
  readonly entry: OfferRail;
  /** The reference of a payment the adapter can already see. */
  readonly reference: string;
  /** A correct answer to a challenge. Required exactly when payments are publicly visible. */
  proofFor?(payment: ObservedPayment, challenge: GateChallenge): string | Promise<string>;
}

export interface RailAdapterConformanceCase {
  readonly name: string;
  /** A fresh subject per test; the driver mutates the adapter it is given. */
  create(): RailAdapterConformanceSubject | Promise<RailAdapterConformanceSubject>;
}

const NO_SIGNAL = Object.freeze({});

/**
 * A stand-in for the bytes being sold. Distinct from any offer digest on purpose: `subject`
 * and `offerDigest` are both `Sha256Digest`, so passing one for the other typechecks, and
 * this is the example a rail author copies into their own case.
 */
const CONFORMANCE_SUBJECT = `sha256:${"5".repeat(64)}` as Sha256Digest;

function conformanceChallenge(
  subject: RailAdapterConformanceSubject,
  reference: string,
): GateChallenge {
  return {
    id: "conformance-challenge",
    nonce: "b2f1c0d3e4a5968778695a4b3c2d1e0f",
    offerDigest: subject.offerDigest,
    rail: subject.entry.rail,
    paymentReference: reference,
    expiresAt: "2099-01-01T00:00:00Z",
  };
}

/**
 * The other challenges a proof might have been won against, each differing from the one the
 * gate asked in exactly one field.
 *
 * `nonce` is the freshness of the question and `paymentReference` is the pickup it is about.
 * A proof that survives either substitution is a proof an onlooker can lift off the wire and
 * present as their own, because the gate hands the adapter whatever challenge it just issued
 * and takes the adapter's word for whether the answer belongs to it.
 */
const DIFFERING_CHALLENGES: readonly {
  readonly name: string;
  readonly from: (asked: GateChallenge) => GateChallenge;
}[] = Object.freeze([
  {
    name: "a different challenge nonce",
    from: (asked) => ({
      ...asked,
      id: "conformance-challenge-other",
      nonce: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
    }),
  },
  {
    name: "a different payment reference",
    from: (asked) => ({
      ...asked,
      id: "conformance-challenge-other",
      paymentReference: `${asked.paymentReference}-someone-elses`,
    }),
  },
]);

/**
 * The contract every rail adapter owes the gate, as a runnable driver.
 *
 * A rail author runs this against their adapter to prove it honors the three-step lifecycle
 * rather than merely type-checking against it. It asserts only what the gate actually
 * depends on: that the self-description matches the methods, that an observation reports the
 * payment truthfully rather than approximately, that an unknown reference is `not-found`
 * rather than an invented payment, that both money-moving acts — `deliver` and `claim` — are
 * idempotent for one payment, and — where payments are public — that a wrong answer is
 * refused and that an answer won for one challenge does not verify against another.
 *
 * It deliberately does not assert what a *correct* proof looks like. That is the rail's own
 * cryptography, and a driver that pinned it would be pinning one rail's scheme onto all of
 * them. "A proof for one challenge must not verify against another" is a different kind of
 * claim: it names no scheme and pins no cryptography, and it is the one property the gate's
 * whole payer-proof leg rests on. The gate's own one-shot `consume` does not stand behind
 * it — an onlooker who sniffs a proof off the wire does not replay the challenge, they ask
 * for a fresh one and replay the answer — so the adapter is the only thing that can, and
 * this driver is the only thing standing behind the adapter.
 */
export function describeRailAdapterConformance(testCase: RailAdapterConformanceCase): void {
  describe(`rail adapter conformance: ${testCase.name}`, () => {
    test("the self-description matches the methods the adapter implements", async () => {
      const subject = await testCase.create();
      expect(() => assertConformingRailAdapter(subject.adapter)).not.toThrow();
    });

    test("an observed payment is reported exactly as the sealed entry names it", async () => {
      const subject = await testCase.create();
      const observation = await subject.adapter.observe(
        {
          offerDigest: subject.offerDigest,
          entry: subject.entry,
          reference: subject.reference,
        },
        NO_SIGNAL,
      );
      expect(observation.status).toBe("observed");
      if (observation.status !== "observed") return;
      expect(observation.payment.reference).toBe(subject.reference);
      expect(observation.payment.offerDigest).toBe(subject.offerDigest);
      expect(observation.payment.to).toBe(subject.entry.to);
      expect(BigInt(observation.payment.amount)).toBe(BigInt(subject.entry.amount));
    });

    test("a reference the rail has never seen is not-found, never invented", async () => {
      const subject = await testCase.create();
      const observation = await subject.adapter.observe(
        {
          offerDigest: subject.offerDigest,
          entry: subject.entry,
          reference: `${subject.reference}-never-paid`,
        },
        NO_SIGNAL,
      );
      expect(observation.status).toBe("not-found");
    });

    test("a payment against another offer is never reported as observed for this one", async () => {
      const subject = await testCase.create();
      const otherOffer = `sha256:${"9".repeat(64)}` as Sha256Digest;
      // Unconditional. The subject payment demonstrably references `subject.offerDigest`,
      // and `observe` answers "is there a payment referencing THIS offer", so any `observed`
      // here is the adapter answering a question it was not asked. Asserting only inside an
      // `if (observed)` would pass vacuously against every adapter that answers `mismatched`.
      const observation = await subject.adapter.observe(
        { offerDigest: otherOffer, entry: subject.entry, reference: subject.reference },
        NO_SIGNAL,
      );
      expect(observation.status).not.toBe("observed");
    });

    test("claiming is idempotent, so redelivery is free", async () => {
      const subject = await testCase.create();
      if (subject.adapter.claim === undefined) return;
      const observation = await subject.adapter.observe(
        {
          offerDigest: subject.offerDigest,
          entry: subject.entry,
          reference: subject.reference,
        },
        NO_SIGNAL,
      );
      if (observation.status !== "observed") throw new Error("the subject payment must observe");
      const first = await subject.adapter.claim(
        { offerDigest: subject.offerDigest, payment: observation.payment },
        NO_SIGNAL,
      );
      const second = await subject.adapter.claim(
        { offerDigest: subject.offerDigest, payment: observation.payment },
        NO_SIGNAL,
      );
      expect(first.status).toBe("claimed");
      expect(second.status).toBe("already-claimed");
    });

    test("the delivery act is idempotent, so redelivery is free", async () => {
      // On an `on-delivery` rail this act is the taking of the money, and the gate runs it
      // on every collection of the same purchase.
      const subject = await testCase.create();
      if (subject.adapter.deliver === undefined) return;
      const observation = await subject.adapter.observe(
        {
          offerDigest: subject.offerDigest,
          entry: subject.entry,
          reference: subject.reference,
        },
        NO_SIGNAL,
      );
      if (observation.status !== "observed") throw new Error("the subject payment must observe");
      const delivery = {
        offerDigest: subject.offerDigest,
        subject: CONFORMANCE_SUBJECT,
        payment: observation.payment,
      };
      const first = await subject.adapter.deliver(delivery, NO_SIGNAL);
      const second = await subject.adapter.deliver(delivery, NO_SIGNAL);
      expect(first.status).toBe("ready");
      expect(second.status).toBe("already-delivered");
    });

    test("a public rail refuses an answer the paying key did not produce", async () => {
      const subject = await testCase.create();
      if (!subject.adapter.description.paymentsArePubliclyVisible) return;
      if (subject.adapter.verifyPayerControl === undefined) {
        throw new Error("a publicly visible rail must implement verifyPayerControl");
      }
      const observation = await subject.adapter.observe(
        {
          offerDigest: subject.offerDigest,
          entry: subject.entry,
          reference: subject.reference,
        },
        NO_SIGNAL,
      );
      if (observation.status !== "observed") throw new Error("the subject payment must observe");
      const challenge = conformanceChallenge(subject, observation.payment.reference);
      const outcome = await subject.adapter.verifyPayerControl(
        { payment: observation.payment, challenge, proof: "not-the-payers-answer" },
        NO_SIGNAL,
      );
      expect(outcome.status).toBe("refused");
    });

    test("a public rail accepts the answer the paying key produced", async () => {
      const subject = await testCase.create();
      if (!subject.adapter.description.paymentsArePubliclyVisible) return;
      if (subject.proofFor === undefined) {
        throw new Error("a publicly visible rail's conformance case must supply proofFor");
      }
      const observation = await subject.adapter.observe(
        {
          offerDigest: subject.offerDigest,
          entry: subject.entry,
          reference: subject.reference,
        },
        NO_SIGNAL,
      );
      if (observation.status !== "observed") throw new Error("the subject payment must observe");
      const challenge = conformanceChallenge(subject, observation.payment.reference);
      const outcome = await subject.adapter.verifyPayerControl!(
        {
          payment: observation.payment,
          challenge,
          proof: await subject.proofFor(observation.payment, challenge),
        },
        NO_SIGNAL,
      );
      expect(outcome.status).toBe("proven");
    });

    for (const differing of DIFFERING_CHALLENGES) {
      test(`a public rail refuses a proof produced for ${differing.name}`, async () => {
        const subject = await testCase.create();
        if (!subject.adapter.description.paymentsArePubliclyVisible) return;
        if (subject.proofFor === undefined) {
          throw new Error("a publicly visible rail's conformance case must supply proofFor");
        }
        const observation = await subject.adapter.observe(
          {
            offerDigest: subject.offerDigest,
            entry: subject.entry,
            reference: subject.reference,
          },
          NO_SIGNAL,
        );
        if (observation.status !== "observed") {
          throw new Error("the subject payment must observe");
        }
        // The proof is won against one challenge and presented against another. An adapter
        // that verifies a static signature over the payer alone, or one that covers the
        // nonce but not the pickup, answers `proven` here — and that adapter serves every
        // onlooker who has seen one payer's answer go past.
        const asked = conformanceChallenge(subject, observation.payment.reference);
        const answered = differing.from(asked);
        const outcome = await subject.adapter.verifyPayerControl!(
          {
            payment: observation.payment,
            challenge: asked,
            proof: await subject.proofFor(observation.payment, answered),
          },
          NO_SIGNAL,
        );
        expect(outcome.status).toBe("refused");
      });
    }
  });
}

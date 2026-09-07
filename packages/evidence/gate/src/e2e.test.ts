// The four flows the issue names, each written the way a buyer and a holder actually meet:
// the holder seals terms and puts them on a gate, the buyer pays on a rail, collects, and
// checks that the bytes hash to the subject digest. That last check is the whole warranty,
// so every delivery here ends with it.

import { parseOfferEnvelope } from "@jinn-network/evidence-offer";
import { recordDigest } from "@jinn-network/trust-core";
import { describe, expect, test } from "vitest";

import { createRetrievalGate } from "./gate.js";
import type { GateOutcome } from "./gate.js";
import {
  createInMemoryChallengeStore,
  createInMemoryOfferSource,
  createInMemorySubjectSource,
} from "./ports.js";
import type { Clock } from "./ports.js";
import { parseDeliveryStatementEnvelope } from "./statement.js";
import {
  createFixtureSigner,
  createTestRailAdapter,
  sealTestOffer,
  signTestPayerProof,
} from "./testing.js";

const RAIL = "https://rails.test.example/v1";
const TO = "acct:holder@rails.test.example";
const GOODS = new TextEncoder().encode("a trace worth paying for");
const SUBJECT = recordDigest(GOODS);
const PAYER_SECRET = "the paying key's own material";

const clock: Clock = { now: () => "2026-08-31T12:00:00.000Z" };
let nonce = 0;

/** What a buyer does on receipt, and the only guarantee they were ever given. */
function collect(outcome: GateOutcome): Uint8Array {
  if (outcome.status !== "delivered") {
    throw new Error(`expected a delivery, got ${JSON.stringify(outcome)}`);
  }
  expect(recordDigest(outcome.bytes)).toBe(outcome.subject);
  return outcome.bytes;
}

describe("end to end: the free path", () => {
  test("a zero-price offer is served on sight, and the bytes are the subject", async () => {
    const sealed = await sealTestOffer({ subject: SUBJECT });
    // Zero is first-class: the empty rails list is the free offer, never an absent one.
    expect(parseOfferEnvelope(sealed.envelopeBytes).offer.rails).toEqual([]);

    const gate = createRetrievalGate({
      offers: createInMemoryOfferSource([sealed.envelopeBytes]),
      subjects: createInMemorySubjectSource([GOODS]),
      clock,
    });

    expect(collect(await gate.request({ offer: sealed.digest }))).toEqual(GOODS);
  });
});

describe("end to end: the paid path", () => {
  test("pay on a rail, present the reference, collect the exact bytes", async () => {
    const sealed = await sealTestOffer({
      subject: SUBJECT,
      rails: [{ rail: RAIL, to: TO, amount: "1200" }],
    });
    const rail = createTestRailAdapter({ rail: RAIL });
    const gate = createRetrievalGate({
      offers: createInMemoryOfferSource([sealed.envelopeBytes]),
      subjects: createInMemorySubjectSource([GOODS]),
      rails: [rail],
      clock,
    });

    // Before the payment lands, the gate has nothing to serve.
    expect(
      await gate.request({ offer: sealed.digest, payment: { rail: RAIL, reference: "tx-1" } }),
    ).toMatchObject({ status: "refused", code: "payment-not-found" });

    rail.record({ reference: "tx-1", offerDigest: sealed.digest, to: TO, amount: "1200" });

    expect(
      collect(
        await gate.request({ offer: sealed.digest, payment: { rail: RAIL, reference: "tx-1" } }),
      ),
    ).toEqual(GOODS);
  });

  test("redelivery to the same payer is free, and is never a second charge", async () => {
    const sealed = await sealTestOffer({
      subject: SUBJECT,
      rails: [{ rail: RAIL, to: TO, amount: "1200" }],
    });
    const rail = createTestRailAdapter({
      rail: RAIL,
      settlement: "explicit-claim",
      trustModel: "assured-by-institution",
      assuredBy: "the test processor",
      payments: [{ reference: "tx-1", offerDigest: sealed.digest, to: TO, amount: "1200" }],
    });
    const gate = createRetrievalGate({
      offers: createInMemoryOfferSource([sealed.envelopeBytes]),
      subjects: createInMemorySubjectSource([GOODS]),
      rails: [rail],
      clock,
    });

    const request = { offer: sealed.digest, payment: { rail: RAIL, reference: "tx-1" } };
    expect(collect(await gate.request(request))).toEqual(GOODS);
    expect(collect(await gate.request(request))).toEqual(GOODS);
    expect(collect(await gate.request(request))).toEqual(GOODS);

    // No download bookkeeping exists anywhere; the rail is the one that knows the money
    // already moved, and says so.
    expect(rail.claims).toEqual(["claimed", "already-claimed", "already-claimed"]);
  });
});

describe("end to end: pickup belongs to the payer", () => {
  async function publicRailMarket() {
    const sealed = await sealTestOffer({
      subject: SUBJECT,
      rails: [{ rail: RAIL, to: TO, amount: "1200" }],
    });
    const rail = createTestRailAdapter({
      rail: RAIL,
      paymentsArePubliclyVisible: true,
      payerSecrets: { "payer-a": PAYER_SECRET },
      payments: [
        {
          reference: "tx-1",
          offerDigest: sealed.digest,
          to: TO,
          amount: "1200",
          payer: "payer-a",
        },
      ],
    });
    const gate = createRetrievalGate({
      offers: createInMemoryOfferSource([sealed.envelopeBytes]),
      subjects: createInMemorySubjectSource([GOODS]),
      rails: [rail],
      challenges: createInMemoryChallengeStore({ nonce: () => `nonce-${(nonce += 1)}` }),
      clock,
    });
    return { gate, offerDigest: sealed.digest };
  }

  test("the payer answers the challenge and collects", async () => {
    const { gate, offerDigest } = await publicRailMarket();
    const payment = { rail: RAIL, reference: "tx-1" };

    const issued = await gate.request({ offer: offerDigest, payment });
    if (issued.status !== "challenge") throw new Error("expected a challenge");

    const outcome = await gate.request({
      offer: offerDigest,
      payment,
      payerProof: {
        challengeId: issued.challenge.id,
        proof: signTestPayerProof(PAYER_SECRET, issued.challenge),
      },
    });
    expect(collect(outcome)).toEqual(GOODS);
  });

  test("an onlooker who read the payment off the ledger cannot redeem it", async () => {
    const { gate, offerDigest } = await publicRailMarket();
    // The onlooker knows everything public: the offer, the rail, the reference, the payer.
    // What they do not have is the paying key.
    const issued = await gate.request({
      offer: offerDigest,
      payment: { rail: RAIL, reference: "tx-1" },
    });
    if (issued.status !== "challenge") throw new Error("expected a challenge");

    expect(
      await gate.request({
        offer: offerDigest,
        payment: { rail: RAIL, reference: "tx-1" },
        payerProof: {
          challengeId: issued.challenge.id,
          proof: signTestPayerProof("a guess at the key", issued.challenge),
        },
      }),
    ).toMatchObject({ status: "refused", code: "payer-proof-invalid" });
  });

  test("a proof the onlooker copied off the wire does not work twice", async () => {
    const { gate, offerDigest } = await publicRailMarket();
    const payment = { rail: RAIL, reference: "tx-1" };
    const issued = await gate.request({ offer: offerDigest, payment });
    if (issued.status !== "challenge") throw new Error("expected a challenge");
    const proof = signTestPayerProof(PAYER_SECRET, issued.challenge);

    expect(collect(await gate.request({
      offer: offerDigest,
      payment,
      payerProof: { challengeId: issued.challenge.id, proof },
    }))).toEqual(GOODS);

    expect(
      await gate.request({
        offer: offerDigest,
        payment,
        payerProof: { challengeId: issued.challenge.id, proof },
      }),
    ).toMatchObject({ status: "refused", code: "challenge-unknown" });

    // And the payer themselves simply asks again — redelivery is still free.
    const reissued = await gate.request({ offer: offerDigest, payment });
    if (reissued.status !== "challenge") throw new Error("expected a fresh challenge");
    expect(collect(await gate.request({
      offer: offerDigest,
      payment,
      payerProof: {
        challengeId: reissued.challenge.id,
        proof: signTestPayerProof(PAYER_SECRET, reissued.challenge),
      },
    }))).toEqual(GOODS);
  });
});

describe("end to end: supersession and delisting", () => {
  test("a payment made while terms were live is honored after they are superseded", async () => {
    const original = await sealTestOffer({
      subject: SUBJECT,
      rails: [{ rail: RAIL, to: TO, amount: "1200" }],
    });
    const reprice = await sealTestOffer({
      subject: SUBJECT,
      rails: [{ rail: RAIL, to: TO, amount: "9900" }],
      supersedes: original.digest,
    });

    const offers = createInMemoryOfferSource([original.envelopeBytes]);
    const rail = createTestRailAdapter({
      rail: RAIL,
      payments: [{ reference: "tx-1", offerDigest: original.digest, to: TO, amount: "1200" }],
    });
    const gate = createRetrievalGate({
      offers,
      subjects: createInMemorySubjectSource([GOODS]),
      rails: [rail],
      clock,
    });

    // The holder reprices. The old offer is still on the gate, and the gate does not consult
    // supersession at all: ordering a dispute is the announcement chain's job and the rail's,
    // not the gate's.
    offers.add(reprice.envelopeBytes);

    const request = { offer: original.digest, payment: { rail: RAIL, reference: "tx-1" } };
    expect(collect(await gate.request(request))).toEqual(GOODS);

    // The new terms are their own offer, and the old payment does not buy under them.
    expect(
      await gate.request({
        offer: reprice.digest,
        payment: { rail: RAIL, reference: "tx-1" },
      }),
    ).toMatchObject({ status: "refused", code: "payment-mismatch" });

    // Delisting is the different act: it takes the terms off the gate entirely.
    expect(offers.delist(original.digest)).toBe(true);
    expect(await gate.request(request)).toMatchObject({
      status: "refused",
      code: "unknown-offer",
    });
  });
});

describe("end to end: the optional delivery statement", () => {
  test("a holder who turns it on hands the buyer sealed provenance of the sale", async () => {
    const sealed = await sealTestOffer({
      subject: SUBJECT,
      rails: [{ rail: RAIL, to: TO, amount: "1200" }],
    });
    const gate = createRetrievalGate({
      offers: createInMemoryOfferSource([sealed.envelopeBytes]),
      subjects: createInMemorySubjectSource([GOODS]),
      rails: [
        createTestRailAdapter({
          rail: RAIL,
          payments: [{ reference: "tx-1", offerDigest: sealed.digest, to: TO, amount: "1200" }],
        }),
      ],
      deliveryStatements: { signer: createFixtureSigner("did:key:zHolder") },
      clock,
    });

    const outcome = await gate.request({
      offer: sealed.digest,
      payment: { rail: RAIL, reference: "tx-1" },
    });
    const bytes = collect(outcome);
    if (outcome.status !== "delivered" || outcome.statement === undefined) {
      throw new Error("expected a statement");
    }

    // The buyer verifies the statement the same way they verify any sealed record: parse
    // the envelope they were handed, and read it back.
    const parsed = parseDeliveryStatementEnvelope(outcome.statement.envelopeBytes);
    expect(parsed.digest).toBe(outcome.statement.digest);
    expect(parsed.statement.offer).toBe(sealed.digest);
    expect(parsed.statement.subject).toBe(recordDigest(bytes));
    expect(parsed.statement.payment).toEqual({ rail: RAIL, reference: "tx-1" });
    expect(parsed.signatures.map((signature) => signature.keyid)).toEqual(["did:key:zHolder"]);
  });
});

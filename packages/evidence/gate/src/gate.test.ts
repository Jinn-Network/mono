import { recordDigest } from "@jinn-network/trust-core";
import type { Sha256Digest } from "@jinn-network/trust-core";
import { beforeEach, describe, expect, test } from "vitest";

import { GateConfigurationError } from "./errors.js";
import { createRetrievalGate, DEFAULT_GATE_HARD_LIMITS } from "./gate.js";
import type { CreateRetrievalGateOptions, GateOutcome } from "./gate.js";
import {
  createInMemoryChallengeStore,
  createInMemoryOfferSource,
  createInMemorySubjectSource,
} from "./ports.js";
import type { Clock, OfferSource } from "./ports.js";
import type { PaymentObservation, RailAdapter } from "./rail.js";
import { createFixtureSigner, createTestRailAdapter, sealTestOffer } from "./testing.js";
import type { TestRailAdapter } from "./testing.js";

const RAIL = "https://rails.test.example/v1";
const TO = "acct:holder@rails.test.example";
const SUBJECT_BYTES = new TextEncoder().encode("the bytes being sold");
const SUBJECT = recordDigest(SUBJECT_BYTES);
const ABSENT = `sha256:${"0".repeat(64)}` as Sha256Digest;

const fixedClock: Clock = { now: () => "2026-08-31T12:00:00.000Z" };

let nonces = 0;
const countingNonce = () => `n${(nonces += 1)}`;

beforeEach(() => {
  nonces = 0;
});

function delivered(outcome: GateOutcome) {
  if (outcome.status !== "delivered") {
    throw new Error(`expected a delivery, got ${outcome.status}: ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

function refused(outcome: GateOutcome) {
  if (outcome.status !== "refused") {
    throw new Error(`expected a refusal, got ${outcome.status}`);
  }
  return outcome;
}

interface Harness {
  readonly offerDigest: Sha256Digest;
  readonly offers: ReturnType<typeof createInMemoryOfferSource>;
  readonly subjects: ReturnType<typeof createInMemorySubjectSource>;
  readonly rail: TestRailAdapter;
  readonly gate: ReturnType<typeof createRetrievalGate>;
}

async function priced(
  railOptions: Parameters<typeof createTestRailAdapter>[0] = {},
  gateOptions: Partial<CreateRetrievalGateOptions> = {},
): Promise<Harness> {
  const sealed = await sealTestOffer({
    subject: SUBJECT,
    rails: [{ rail: RAIL, to: TO, amount: "1200" }],
  });
  const offers = createInMemoryOfferSource([sealed.envelopeBytes]);
  const subjects = createInMemorySubjectSource([SUBJECT_BYTES]);
  const rail = createTestRailAdapter({
    rail: RAIL,
    payments: [
      { reference: "tx-1", offerDigest: sealed.digest, to: TO, amount: "1200", payer: "payer-a" },
    ],
    ...railOptions,
  });
  const gate = createRetrievalGate({
    offers,
    subjects,
    rails: [rail],
    clock: fixedClock,
    ...gateOptions,
  });
  return { offerDigest: sealed.digest, offers, subjects, rail, gate };
}

async function freeHarness(gateOptions: Partial<CreateRetrievalGateOptions> = {}) {
  const sealed = await sealTestOffer({ subject: SUBJECT });
  const offers = createInMemoryOfferSource([sealed.envelopeBytes]);
  const subjects = createInMemorySubjectSource([SUBJECT_BYTES]);
  const gate = createRetrievalGate({ offers, subjects, clock: fixedClock, ...gateOptions });
  return { offerDigest: sealed.digest, offers, subjects, gate };
}

describe("createRetrievalGate — construction", () => {
  const offers = createInMemoryOfferSource();
  const subjects = createInMemorySubjectSource();

  test("refuses two adapters claiming one rail", () => {
    expect(() =>
      createRetrievalGate({
        offers,
        subjects,
        rails: [createTestRailAdapter({ rail: RAIL }), createTestRailAdapter({ rail: RAIL })],
      })).toThrow(/two rail adapters claim/u);
  });

  test("refuses a non-conforming adapter before it can ever serve", () => {
    const broken: RailAdapter = {
      description: {
        rail: RAIL,
        trustModel: "unassured",
        settlement: "already-settled",
        paymentsArePubliclyVisible: true,
      },
      observe: async (): Promise<PaymentObservation> => ({ status: "not-found", detail: "" }),
    };
    expect(() => createRetrievalGate({ offers, subjects, rails: [broken] }))
      .toThrow(GateConfigurationError);
  });

  test("a publicly visible rail without a challenge store is a configuration error", () => {
    expect(() =>
      createRetrievalGate({
        offers,
        subjects,
        rails: [
          createTestRailAdapter({
            rail: RAIL,
            paymentsArePubliclyVisible: true,
            payerSecrets: { "payer-a": "s" },
          }),
        ],
      })).toThrow(/needs a challenge store/u);
  });

  test("refuses a nonsense byte bound", () => {
    expect(() => createRetrievalGate({ offers, subjects, hardLimits: { maxSubjectBytes: 0 } }))
      .toThrow(/maxSubjectBytes/u);
  });

  test("publishes the trust models it accepts, and its own bounds", async () => {
    const { gate } = await priced({ trustModel: "assured-by-code", assuredBy: "0xEscrow" });
    expect(gate.rails).toEqual([
      {
        rail: RAIL,
        trustModel: "assured-by-code",
        assuredBy: "0xEscrow",
        settlement: "already-settled",
        paymentsArePubliclyVisible: false,
      },
    ]);
    expect(gate.hardLimits).toEqual(DEFAULT_GATE_HARD_LIMITS);
  });
});

describe("createRetrievalGate — resolving the offer", () => {
  test("an offer this gate does not hold is unknown, which is also what delisting looks like", async () => {
    const { gate, offers, offerDigest } = await freeHarness();
    expect(refused(await gate.request({ offer: ABSENT })).code).toBe("unknown-offer");
    offers.delist(offerDigest);
    expect(refused(await gate.request({ offer: offerDigest })).code).toBe("unknown-offer");
  });

  test("a source that hands back the wrong bytes is caught, not trusted", async () => {
    const real = await sealTestOffer({ subject: SUBJECT });
    const other = await sealTestOffer({ subject: recordDigest(new Uint8Array([1])) });
    // A source that files one offer's bytes under another's digest: identity comes from the
    // bytes, and the gate re-derives it rather than taking the lookup key's word.
    const lying: OfferSource = { read: async () => other.envelopeBytes };
    const gate = createRetrievalGate({
      offers: lying,
      subjects: createInMemorySubjectSource([SUBJECT_BYTES]),
      clock: fixedClock,
    });
    expect(refused(await gate.request({ offer: real.digest })).code).toBe("offer-digest-mismatch");
  });

  test("bytes that are not a sealed offer are refused as such", async () => {
    const junk = new TextEncoder().encode("not an offer");
    const gate = createRetrievalGate({
      offers: { read: async () => junk },
      subjects: createInMemorySubjectSource([SUBJECT_BYTES]),
      clock: fixedClock,
    });
    expect(refused(await gate.request({ offer: recordDigest(junk) })).code).toBe("offer-invalid");
  });
});

describe("createRetrievalGate — the free path", () => {
  test("a free offer is served on sight, with no payment and no rail", async () => {
    const { gate, offerDigest } = await freeHarness();
    const outcome = delivered(await gate.request({ offer: offerDigest }));
    expect(outcome.subject).toBe(SUBJECT);
    expect(outcome.bytes).toEqual(SUBJECT_BYTES);
    expect(outcome.statement).toBeUndefined();
    expect(outcome.warnings).toEqual([]);
  });

  test("naming a payment on a free offer is not the terms it was sealed with", async () => {
    const { gate, offerDigest } = await freeHarness();
    const outcome = refused(
      await gate.request({ offer: offerDigest, payment: { rail: RAIL, reference: "tx-1" } }),
    );
    expect(outcome.code).toBe("payment-not-expected");
  });
});

describe("createRetrievalGate — the paid path", () => {
  test("an observed payment matching the sealed terms delivers the exact bytes", async () => {
    const { gate, offerDigest } = await priced();
    const outcome = delivered(
      await gate.request({ offer: offerDigest, payment: { rail: RAIL, reference: "tx-1" } }),
    );
    expect(outcome.bytes).toEqual(SUBJECT_BYTES);
    expect(recordDigest(outcome.bytes)).toBe(outcome.subject);
  });

  test("a priced offer with no payment named says exactly that", async () => {
    const { gate, offerDigest } = await priced();
    expect(refused(await gate.request({ offer: offerDigest })).code).toBe("payment-required");
  });

  test("a rail the offer does not carry, and a rail this gate cannot speak, differ", async () => {
    const { gate, offerDigest } = await priced();
    expect(
      refused(
        await gate.request({
          offer: offerDigest,
          payment: { rail: "https://rails.other.example/v1", reference: "tx-1" },
        }),
      ).code,
    ).toBe("rail-not-offered");

    const sealed = await sealTestOffer({
      subject: SUBJECT,
      rails: [{ rail: "https://rails.other.example/v1", to: TO, amount: "5" }],
    });
    const bare = createRetrievalGate({
      offers: createInMemoryOfferSource([sealed.envelopeBytes]),
      subjects: createInMemorySubjectSource([SUBJECT_BYTES]),
      clock: fixedClock,
    });
    expect(
      refused(
        await bare.request({
          offer: sealed.digest,
          payment: { rail: "https://rails.other.example/v1", reference: "tx-1" },
        }),
      ).code,
    ).toBe("rail-unsupported");
  });

  test("a payment the rail cannot see is not-found", async () => {
    const { gate, offerDigest } = await priced();
    expect(
      refused(
        await gate.request({ offer: offerDigest, payment: { rail: RAIL, reference: "tx-9" } }),
      ).code,
    ).toBe("payment-not-found");
  });

  test("the rail's own mismatch verdict is reported as a mismatch", async () => {
    const { gate, offerDigest, rail } = await priced();
    rail.record({
      reference: "tx-elsewhere",
      offerDigest: ABSENT,
      to: TO,
      amount: "1200",
    });
    expect(
      refused(
        await gate.request({
          offer: offerDigest,
          payment: { rail: RAIL, reference: "tx-elsewhere" },
        }),
      ).code,
    ).toBe("payment-mismatch");
  });

  test.each([
    ["a destination the offer does not name", { to: "acct:someone-else@rails.test.example" }],
    ["an amount below the sealed price", { amount: "1199" }],
    ["an amount above the sealed price", { amount: "1201" }],
    ["an amount that is not an integer at all", { amount: "12.00" }],
  ])("a lax adapter cannot widen the terms with %s", async (_name, override) => {
    // The adapter says "observed"; the gate checks it against the sealed entry anyway.
    const { gate, offerDigest, rail } = await priced();
    rail.record({
      reference: "tx-lax",
      offerDigest,
      to: TO,
      amount: "1200",
      ...override,
    });
    expect(
      refused(
        await gate.request({ offer: offerDigest, payment: { rail: RAIL, reference: "tx-lax" } }),
      ).code,
    ).toBe("payment-mismatch");
  });

  test("an untidy but integer-equal amount is honored", async () => {
    const { gate, offerDigest, rail } = await priced();
    rail.record({ reference: "tx-padded", offerDigest, to: TO, amount: "0001200" });
    expect(
      delivered(
        await gate.request({ offer: offerDigest, payment: { rail: RAIL, reference: "tx-padded" } }),
      ).bytes,
    ).toEqual(SUBJECT_BYTES);
  });
});

describe("createRetrievalGate — serving the subject", () => {
  test("a subject this gate does not hold is unavailable", async () => {
    const { gate, offerDigest, subjects } = await freeHarness();
    subjects.remove(SUBJECT);
    expect(refused(await gate.request({ offer: offerDigest })).code).toBe("subject-unavailable");
  });

  test("a subject beyond the gate's bound is refused rather than read out", async () => {
    const sealed = await sealTestOffer({ subject: SUBJECT });
    const gate = createRetrievalGate({
      offers: createInMemoryOfferSource([sealed.envelopeBytes]),
      subjects: createInMemorySubjectSource([SUBJECT_BYTES]),
      clock: fixedClock,
      hardLimits: { maxSubjectBytes: 4 },
    });
    expect(refused(await gate.request({ offer: sealed.digest })).code).toBe("subject-too-large");
  });

  test("bytes that do not hash to the subject are never served", async () => {
    // A holder whose store has quietly corrupted learns it from their own gate.
    const corrupt = new TextEncoder().encode("not what was sold");
    const sealed = await sealTestOffer({ subject: SUBJECT });
    const gate = createRetrievalGate({
      offers: createInMemoryOfferSource([sealed.envelopeBytes]),
      subjects: { read: async () => corrupt },
      clock: fixedClock,
    });
    const outcome = refused(await gate.request({ offer: sealed.digest }));
    expect(outcome.code).toBe("subject-digest-mismatch");
    expect(outcome.detail).toContain(recordDigest(corrupt));
  });
});

describe("createRetrievalGate — the rail's delivery and claim acts", () => {
  test("a refused delivery act costs the buyer the bytes", async () => {
    const { gate, offerDigest, rail } = await priced({ settlement: "on-delivery" });
    rail.refuseNextDelivery("the escrow would not release");
    const outcome = refused(
      await gate.request({ offer: offerDigest, payment: { rail: RAIL, reference: "tx-1" } }),
    );
    expect(outcome.code).toBe("rail-refused-delivery");
    expect(outcome.detail).toBe("the escrow would not release");
    expect(rail.deliveries).toEqual([]);
  });

  test("a key-reveal rail runs its delivery act and is never asked to claim", async () => {
    const { gate, offerDigest, rail } = await priced({ settlement: "on-delivery" });
    delivered(
      await gate.request({ offer: offerDigest, payment: { rail: RAIL, reference: "tx-1" } }),
    );
    expect(rail.deliveries).toEqual([SUBJECT]);
    expect(rail.claims).toEqual([]);
  });

  test("a capture that declines refuses the delivery rather than giving bytes away", async () => {
    const { gate, offerDigest, rail } = await priced({ settlement: "explicit-claim" });
    rail.failNextClaim("the authorization had expired");
    const outcome = refused(
      await gate.request({ offer: offerDigest, payment: { rail: RAIL, reference: "tx-1" } }),
    );
    expect(outcome.code).toBe("claim-failed");
    expect(outcome.detail).toBe("the authorization had expired");
  });

  test("the claim runs after the bytes are verified, never before", async () => {
    // A subject the gate cannot serve must not have cost the buyer their money.
    const { gate, offerDigest, rail, subjects } = await priced({ settlement: "explicit-claim" });
    subjects.remove(SUBJECT);
    expect(
      refused(
        await gate.request({ offer: offerDigest, payment: { rail: RAIL, reference: "tx-1" } }),
      ).code,
    ).toBe("subject-unavailable");
    expect(rail.claims).toEqual([]);
  });
});

describe("createRetrievalGate — payer-proof pickup", () => {
  async function publicRail() {
    return priced(
      {
        paymentsArePubliclyVisible: true,
        payerSecrets: { "payer-a": "only-the-payer-knows-this" },
      },
      { challenges: createInMemoryChallengeStore({ nonce: countingNonce }) },
    );
  }

  test("a first request on a public rail is answered with a challenge, not with bytes", async () => {
    const { gate, offerDigest } = await publicRail();
    const outcome = await gate.request({
      offer: offerDigest,
      payment: { rail: RAIL, reference: "tx-1" },
    });
    expect(outcome.status).toBe("challenge");
    if (outcome.status !== "challenge") return;
    expect(outcome.challenge.offerDigest).toBe(offerDigest);
    expect(outcome.challenge.rail).toBe(RAIL);
    expect(outcome.challenge.paymentReference).toBe("tx-1");
  });

  test("an answer to a challenge this gate never issued is refused", async () => {
    const { gate, offerDigest } = await publicRail();
    expect(
      refused(
        await gate.request({
          offer: offerDigest,
          payment: { rail: RAIL, reference: "tx-1" },
          payerProof: { challengeId: "invented", proof: "anything" },
        }),
      ).code,
    ).toBe("challenge-unknown");
  });

  test("a challenge won for one pickup does not answer for another", async () => {
    const { gate, offerDigest, rail } = await publicRail();
    rail.record({
      reference: "tx-2",
      offerDigest,
      to: TO,
      amount: "1200",
      payer: "payer-a",
    });
    const issued = await gate.request({
      offer: offerDigest,
      payment: { rail: RAIL, reference: "tx-1" },
    });
    if (issued.status !== "challenge") throw new Error("expected a challenge");
    const outcome = refused(
      await gate.request({
        offer: offerDigest,
        payment: { rail: RAIL, reference: "tx-2" },
        payerProof: { challengeId: issued.challenge.id, proof: "anything" },
      }),
    );
    expect(outcome.code).toBe("challenge-unknown");
    expect(outcome.detail).toContain("a different pickup");
  });
});

describe("createRetrievalGate — the delivery statement flag", () => {
  test("a gate built with no signer emits nothing, and that is conforming", async () => {
    const { gate, offerDigest } = await freeHarness();
    expect(delivered(await gate.request({ offer: offerDigest })).statement).toBeUndefined();
  });

  test("a signer turns the statement on for the free path, with no payment named", async () => {
    const { gate, offerDigest } = await freeHarness({
      deliveryStatements: { signer: createFixtureSigner() },
    });
    const outcome = delivered(await gate.request({ offer: offerDigest }));
    expect(outcome.statement?.statement).toEqual({
      kind: "https://spec.jinn.network/records/delivery-statement/v1",
      offer: offerDigest,
      subject: SUBJECT,
      deliveredAt: "2026-08-31T12:00:00.000Z",
    });
  });

  test("the paid path's statement names the offer, subject, and payment", async () => {
    const { gate, offerDigest } = await priced(
      {},
      { deliveryStatements: { signer: createFixtureSigner() } },
    );
    const outcome = delivered(
      await gate.request({ offer: offerDigest, payment: { rail: RAIL, reference: "tx-1" } }),
    );
    expect(outcome.statement?.statement).toEqual({
      kind: "https://spec.jinn.network/records/delivery-statement/v1",
      offer: offerDigest,
      subject: SUBJECT,
      payment: { rail: RAIL, reference: "tx-1" },
      deliveredAt: "2026-08-31T12:00:00.000Z",
    });
    expect(outcome.warnings).toEqual([]);
  });

  test("a signer that fails costs the statement, never the bytes", async () => {
    const { gate, offerDigest } = await freeHarness({
      deliveryStatements: {
        signer: async () => {
          throw new Error("the signing key is offline");
        },
      },
    });
    const outcome = delivered(await gate.request({ offer: offerDigest }));
    expect(outcome.bytes).toEqual(SUBJECT_BYTES);
    expect(outcome.statement).toBeUndefined();
    expect(outcome.warnings).toEqual([
      { code: "statement-not-emitted", detail: "the signing key is offline" },
    ]);
  });
});

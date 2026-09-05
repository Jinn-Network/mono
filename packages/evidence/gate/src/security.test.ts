import { recordDigest } from "@jinn-network/trust-core";
import { describe, expect, test } from "vitest";
import { createRetrievalGate } from "./gate.js";
import type { GateRequest } from "./gate.js";
import { createInMemoryChallengeStore, createInMemoryOfferSource, createInMemorySubjectSource } from "./ports.js";
import type { ChallengeStore } from "./ports.js";
import type { GateChallenge, RailAdapter } from "./rail.js";
import { createTestRailAdapter, sealTestOffer, signTestPayerProof } from "./testing.js";

const RAIL = "https://rails.test.example/v1";
const TO = "acct:holder@rails.test.example";
const NOW = "2026-08-31T12:00:00.000Z";
const SECRET = "the paying key's secret";
const BYTES = new TextEncoder().encode("the expensive corpus");
const SUBJECT = recordDigest(BYTES);

async function market(challenges = createInMemoryChallengeStore()) {
  const offer = await sealTestOffer({ subject: SUBJECT, rails: [{ rail: RAIL, to: TO, amount: "1200" }] });
  const rail = createTestRailAdapter({
    rail: RAIL, paymentsArePubliclyVisible: true,
    payments: [{ reference: "tx-1", offerDigest: offer.digest, to: TO, amount: "1200", payer: "payer" }],
    payerSecrets: { payer: SECRET },
  });
  const options = {
    offers: createInMemoryOfferSource([offer.envelopeBytes]),
    subjects: createInMemorySubjectSource([BYTES]), rails: [rail], challenges,
    clock: { now: () => NOW },
  };
  const request = { offer: offer.digest, payment: { rail: RAIL, reference: "tx-1" } };
  return { gate: createRetrievalGate(options), options, offer, rail, request };
}

describe("the paid pickup security boundary", () => {
  test("the adapter receives the frozen challenge the gate checked, with each member read once", async () => {
    const reads = { id: 0, nonce: 0, offerDigest: 0, rail: 0, paymentReference: 0, expiresAt: 0 };
    let stored: GateChallenge;
    const store: ChallengeStore = {
      issue: async () => { throw new Error("this test supplies the outstanding challenge"); },
      consume: async () => stored,
    };
    const { options, request, rail, offer } = await market(store);
    const cheap = await sealTestOffer({ subject: SUBJECT, rails: [{ rail: RAIL, to: TO, amount: "1" }] });
    const checked: GateChallenge = {
      id: "question", nonce: "expensive-nonce", offerDigest: offer.digest,
      rail: RAIL, paymentReference: "tx-1", expiresAt: "2026-08-31T12:05:00.000Z",
    };
    const sniffed: GateChallenge = { ...checked, offerDigest: cheap.digest, paymentReference: "tx-cheap" };
    stored = Object.defineProperties({}, Object.fromEntries(
      (Object.keys(reads) as (keyof GateChallenge)[]).map((key) => [key, {
        get: () => ++reads[key] === 1 ? checked[key] : sniffed[key],
      }]),
    )) as GateChallenge;
    let received: GateChallenge | undefined;
    const adapter: RailAdapter = {
      ...rail,
      async verifyPayerControl(input, callOptions) {
        received = input.challenge;
        return rail.verifyPayerControl!(input, callOptions);
      },
    };
    const gate = createRetrievalGate({ ...options, rails: [adapter] });
    const outcome = await gate.request({
      ...request, payerProof: { challengeId: checked.id, proof: signTestPayerProof(SECRET, sniffed) },
    });
    expect(outcome).toMatchObject({ status: "refused", code: "payer-proof-invalid" });
    expect(received).toEqual(checked);
    expect(received).not.toBe(stored);
    expect(Object.isFrozen(received)).toBe(true);
    expect(reads).toEqual({ id: 1, nonce: 1, offerDigest: 1, rail: 1, paymentReference: 1, expiresAt: 1 });
  });

  test("a deeply nested JSON offer refuses before consulting a port", async () => {
    let calls = 0;
    const gate = createRetrievalGate({
      offers: { read: async () => { calls += 1; return null; } },
      subjects: createInMemorySubjectSource(),
    });
    const body = `{"offer":${"[".repeat(10000)}1${"]".repeat(10000)}}`;
    const request: GateRequest = JSON.parse(body);
    await expect(gate.request(request)).resolves.toMatchObject({ status: "refused", code: "unknown-offer" });
    expect(calls).toBe(0);
  });

  test("an invalid in-process offer need not be JSON-serializable to be refused", async () => {
    const gate = createRetrievalGate({ offers: createInMemoryOfferSource(), subjects: createInMemorySubjectSource() });
    const circular: unknown[] = [];
    circular.push(circular);
    for (const offer of [1n, circular]) {
      await expect(gate.request({ offer } as unknown as GateRequest)).resolves.toMatchObject({
        status: "refused", code: "unknown-offer",
      });
    }
  });

  test("the gate refuses another offer's payment even when its rail reports observed", async () => {
    const { options, request, offer, rail } = await market();
    const another = await sealTestOffer({ subject: recordDigest(new TextEncoder().encode("other bytes")), rails: [{ rail: RAIL, to: TO, amount: "1200" }] });
    expect(another.digest).not.toBe(offer.digest);
    const adapter: RailAdapter = {
      description: { ...rail.description, paymentsArePubliclyVisible: false },
      observe: async () => ({
        status: "observed", payment: { reference: "tx-1", offerDigest: another.digest, to: TO, amount: "1200" },
      }),
    };
    const gate = createRetrievalGate({ ...options, rails: [adapter] });
    await expect(gate.request(request)).resolves.toMatchObject({ status: "refused", code: "payment-mismatch" });
  });

  test("successive challenges for the same pickup have different nonces", async () => {
    const { gate, request } = await market();
    const first = await gate.request(request);
    const second = await gate.request(request);
    if (first.status !== "challenge" || second.status !== "challenge") throw new Error("expected challenges");
    expect(first.challenge.nonce).not.toBe(second.challenge.nonce);
  });

  test("a sniffed proof cannot answer a fresh challenge for the same payment", async () => {
    const { gate, request } = await market();
    const first = await gate.request(request);
    if (first.status !== "challenge") throw new Error("expected a challenge");
    const proof = signTestPayerProof(SECRET, first.challenge);
    await expect(gate.request({ ...request, payerProof: { challengeId: first.challenge.id, proof } }))
      .resolves.toMatchObject({ status: "delivered", bytes: BYTES });
    const fresh = await gate.request(request);
    if (fresh.status !== "challenge") throw new Error("expected a fresh challenge");
    await expect(gate.request({ ...request, payerProof: { challengeId: fresh.challenge.id, proof } }))
      .resolves.toMatchObject({ status: "refused", code: "payer-proof-invalid" });
  });

  test("a caller cannot overwrite an issued nonce to replay a sniffed proof", async () => {
    const { gate, request } = await market();
    const first = await gate.request(request);
    if (first.status !== "challenge") throw new Error("expected a challenge");
    const proof = signTestPayerProof(SECRET, first.challenge);
    await expect(gate.request({ ...request, payerProof: { challengeId: first.challenge.id, proof } }))
      .resolves.toMatchObject({ status: "delivered" });
    const fresh = await gate.request(request);
    if (fresh.status !== "challenge") throw new Error("expected a fresh challenge");
    // Reflect.set models a JavaScript caller without letting a strict-mode TypeError
    // prevent the load-bearing replay assertion from running.
    Reflect.set(fresh.challenge, "nonce", first.challenge.nonce);
    await expect(gate.request({ ...request, payerProof: { challengeId: fresh.challenge.id, proof } }))
      .resolves.toMatchObject({ status: "refused", code: "payer-proof-invalid" });
    expect(Object.isFrozen(fresh.challenge)).toBe(true);
  });

  test("issuing a custom store row does not expose its retained object", async () => {
    const row: GateChallenge = {
      id: "custom", nonce: "retained", offerDigest: SUBJECT, rail: RAIL,
      paymentReference: "tx-1", expiresAt: "2026-08-31T12:05:00.000Z",
    };
    const { gate, request } = await market({ issue: async () => row, consume: async () => row });
    const issued = await gate.request(request);
    if (issued.status !== "challenge") throw new Error("expected a challenge");
    expect(issued.challenge).toEqual(row);
    expect(issued.challenge).not.toBe(row);
    expect(Object.isFrozen(issued.challenge)).toBe(true);
  });

  test("the shipped challenge store protects its retained row from its direct caller", async () => {
    const store = createInMemoryChallengeStore();
    const issued = await store.issue({ offerDigest: SUBJECT, rail: RAIL, paymentReference: "tx-1", now: NOW }, {});
    const originalNonce = issued.nonce;
    Reflect.set(issued, "nonce", "overwritten");
    const consumed = await store.consume(issued.id, NOW, {});
    expect(consumed?.nonce).toBe(originalNonce);
    expect(Object.isFrozen(issued)).toBe(true);
  });


  test("an adapter cannot rewrite the sealed rail terms it is asked to observe", async () => {
    const { options, request, offer, rail } = await market();
    let observedEntry;
    const adapter: RailAdapter = {
      description: { ...rail.description, paymentsArePubliclyVisible: false },
      observe: async ({ entry }) => {
        observedEntry = entry;
        Reflect.set(entry, "amount", "1");
        Reflect.set(entry, "to", "acct:attacker@rails.test.example");
        return {
          status: "observed",
          payment: { reference: "tx-1", offerDigest: offer.digest,
            amount: "1", to: "acct:attacker@rails.test.example" },
        };
      },
    };
    const gate = createRetrievalGate({ ...options, rails: [adapter] });
    await expect(gate.request(request)).resolves.toMatchObject({ status: "refused", code: "payment-mismatch" });
    expect(observedEntry).toMatchObject({ rail: RAIL, amount: "1200", to: TO });
    expect(Object.isFrozen(observedEntry)).toBe(true);
  });


  test("a source cannot change the checked bytes while the rail delivery is pending", async () => {
    const { options, request, rail } = await market();
    const retained = BYTES.slice();
    let releaseDelivery!: () => void;
    let startedDelivery!: () => void;
    const pending = new Promise<void>((resolve) => { releaseDelivery = resolve; });
    const started = new Promise<void>((resolve) => { startedDelivery = resolve; });
    const adapter: RailAdapter = {
      observe: rail.observe,
      description: { ...rail.description, paymentsArePubliclyVisible: false, settlement: "on-delivery" },
      deliver: async () => {
        startedDelivery();
        await pending;
        return { status: "ready" };
      },
    };
    const gate = createRetrievalGate({
      ...options, subjects: { read: async () => retained }, rails: [adapter],
    });
    const collecting = gate.request(request);
    await started;
    retained[0] = retained[0]! ^ 0xff;
    releaseDelivery();
    const outcome = await collecting;
    if (outcome.status !== "delivered") throw new Error("expected delivery");
    expect(outcome.bytes).toEqual(BYTES);
    expect(outcome.bytes).not.toBe(retained);
    expect(recordDigest(outcome.bytes)).toBe(outcome.subject);
  });

});

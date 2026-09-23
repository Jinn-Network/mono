import { recordDigest } from "@jinn-network/trust-core";
import type { Sha256Digest } from "@jinn-network/trust-core";
import { beforeEach, describe, expect, test } from "vitest";

import { GateConfigurationError } from "./errors.js";
import { createRetrievalGate, DEFAULT_GATE_HARD_LIMITS } from "./gate.js";
import type { CreateRetrievalGateOptions, GateOutcome, GateRequest } from "./gate.js";
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

  test("a clock that does not read an RFC 3339 instant is a deployment defect", async () => {
    const { offerDigest, offers: held } = await freeHarness();
    const broken = createRetrievalGate({
      offers: held,
      subjects: createInMemorySubjectSource([SUBJECT_BYTES]),
      clock: { now: () => "half past four" },
    });
    await expect(broken.request({ offer: offerDigest })).rejects.toThrow(GateConfigurationError);
  });

  test("a rail whose self-description changes after construction cannot drop the proof leg", async () => {
    // `description` is third-party code and may be a getter. The gate must decide from the
    // copy it validated, or an adapter could pass the payer-proof requirement at
    // construction and then be served to onlookers with no challenge at all.
    const backing = createTestRailAdapter({
      rail: RAIL,
      paymentsArePubliclyVisible: true,
      payerSecrets: { "payer-a": "s" },
    });
    let asked = 0;
    const shifty: RailAdapter = {
      observe: backing.observe.bind(backing),
      verifyPayerControl: backing.verifyPayerControl!.bind(backing),
      get description() {
        asked += 1;
        return { ...backing.description, paymentsArePubliclyVisible: asked === 1 };
      },
    };
    const sealed = await sealTestOffer({
      subject: SUBJECT,
      rails: [{ rail: RAIL, to: TO, amount: "1200" }],
    });
    backing.record({
      reference: "tx-1",
      offerDigest: sealed.digest,
      to: TO,
      amount: "1200",
      payer: "payer-a",
    });
    const built = createRetrievalGate({
      offers: createInMemoryOfferSource([sealed.envelopeBytes]),
      subjects: createInMemorySubjectSource([SUBJECT_BYTES]),
      rails: [shifty],
      challenges: createInMemoryChallengeStore({ nonce: countingNonce }),
      clock: fixedClock,
    });
    expect(built.rails[0]?.paymentsArePubliclyVisible).toBe(true);
    const outcome = await built.request({
      offer: sealed.digest,
      payment: { rail: RAIL, reference: "tx-1" },
    });
    expect(outcome.status).toBe("challenge");
  });

  test("a rail that grows a claim after construction is never asked to claim", async () => {
    // Conformance forbids `claim` on an `on-delivery` rail because delivery is already the
    // taking. The gate must decide from what it captured, or that refusal buys nothing: an
    // adapter could pass construction without one and grow it before the first request.
    const backing = createTestRailAdapter({ rail: RAIL, settlement: "on-delivery" });
    const grower = backing as TestRailAdapter & { claim?: unknown };
    const sealed = await sealTestOffer({
      subject: SUBJECT,
      rails: [{ rail: RAIL, to: TO, amount: "1200" }],
    });
    backing.record({ reference: "tx-1", offerDigest: sealed.digest, to: TO, amount: "1200" });
    const built = createRetrievalGate({
      offers: createInMemoryOfferSource([sealed.envelopeBytes]),
      subjects: createInMemorySubjectSource([SUBJECT_BYTES]),
      rails: [backing],
      clock: fixedClock,
    });

    let claimed = 0;
    grower.claim = async () => {
      claimed += 1;
      return { status: "claimed" as const };
    };

    expect(
      delivered(
        await built.request({ offer: sealed.digest, payment: { rail: RAIL, reference: "tx-1" } }),
      ).bytes,
    ).toEqual(SUBJECT_BYTES);
    expect(claimed).toBe(0);
    expect(backing.deliveries).toEqual([SUBJECT]);
  });

  test("a claim read twice cannot answer differently between the two reads", async () => {
    // The sharper form of the same vector: a getter that answers `undefined` while the
    // on-delivery rule is checked and a function immediately after. Reading each property
    // exactly once is what makes that rule mean anything, so the count is pinned, not just
    // the outcome.
    const backing = createTestRailAdapter({ rail: RAIL, settlement: "on-delivery" });
    let reads = 0;
    let claimed = 0;
    const shifty: RailAdapter = {
      description: backing.description,
      observe: backing.observe.bind(backing),
      deliver: backing.deliver!.bind(backing),
      get claim() {
        reads += 1;
        if (reads === 1) return undefined;
        return async () => {
          claimed += 1;
          return { status: "claimed" as const };
        };
      },
    };
    const sealed = await sealTestOffer({
      subject: SUBJECT,
      rails: [{ rail: RAIL, to: TO, amount: "1200" }],
    });
    backing.record({ reference: "tx-1", offerDigest: sealed.digest, to: TO, amount: "1200" });
    const built = createRetrievalGate({
      offers: createInMemoryOfferSource([sealed.envelopeBytes]),
      subjects: createInMemorySubjectSource([SUBJECT_BYTES]),
      rails: [shifty],
      clock: fixedClock,
    });

    expect(reads).toBe(1);
    expect(
      delivered(
        await built.request({ offer: sealed.digest, payment: { rail: RAIL, reference: "tx-1" } }),
      ).bytes,
    ).toEqual(SUBJECT_BYTES);
    expect(reads).toBe(1);
    expect(claimed).toBe(0);
  });

  test("every member of the adapter and of its description is read exactly once", async () => {
    // The durable form of the read-count guard, and the shape-agnostic one: a getter can
    // only be watched where someone thought to put one, and the double-read this replaces
    // was one level down, on `description.assuredBy`. Counting through a Proxy pins all of
    // them at once and needs no foresight about which member the next mistake will be on.
    const rail = createTestRailAdapter({
      rail: RAIL,
      settlement: "explicit-claim",
      trustModel: "assured-by-code",
      assuredBy: "0xEscrow",
      payments: [{ reference: "tx-1", offerDigest: ABSENT, to: TO, amount: "1200" }],
    });
    const reads: Record<string, number> = {};
    const count = <T extends object>(target: T, prefix: string): T =>
      new Proxy(target, {
        get(held, key, receiver) {
          if (typeof key === "string") reads[`${prefix}${key}`] = (reads[`${prefix}${key}`] ?? 0) + 1;
          return Reflect.get(held, key, receiver);
        },
      });
    const watched: RailAdapter = count(
      { ...rail, description: count({ ...rail.description }, "description.") },
      "",
    );

    createRetrievalGate({ offers, subjects, rails: [watched], clock: fixedClock });

    expect(reads).toEqual({
      description: 1,
      observe: 1,
      deliver: 1,
      claim: 1,
      verifyPayerControl: 1,
      "description.rail": 1,
      "description.trustModel": 1,
      "description.assuredBy": 1,
      "description.settlement": 1,
      "description.paymentsArePubliclyVisible": 1,
    });
  });

  test.each([
    ["an observe that is not a function", { observe: undefined }],
    ["a claim that is null rather than absent", { claim: null }],
  ])("refuses %s with a configuration error, not a TypeError", (_name, override) => {
    const base = createTestRailAdapter({ rail: RAIL, settlement: "explicit-claim" });
    const broken = { ...base, ...override } as unknown as RailAdapter;
    expect(() => createRetrievalGate({ offers, subjects, rails: [broken] }))
      .toThrow(GateConfigurationError);
  });

  test("refuses a nonsense byte bound", () => {
    expect(() => createRetrievalGate({ offers, subjects, hardLimits: { maxSubjectBytes: 0 } }))
      .toThrow(/maxSubjectBytes/u);
  });

  test("an upward byte-bound override is honored, not merged away", async () => {
    const raised = createRetrievalGate({
      offers,
      subjects,
      hardLimits: { maxSubjectBytes: DEFAULT_GATE_HARD_LIMITS.maxSubjectBytes * 4 },
    });
    expect(raised.hardLimits.maxSubjectBytes).toBe(
      DEFAULT_GATE_HARD_LIMITS.maxSubjectBytes * 4,
    );
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

  test("the published bounds are the bounds every request reads, and are frozen", async () => {
    // One object, published and consulted, so an unfrozen one lets a later write change what
    // the gate serves.
    const { gate, offerDigest } = await priced({}, { hardLimits: { maxSubjectBytes: 1 } });
    expect(Object.isFrozen(gate.hardLimits)).toBe(true);
    expect(() => {
      (gate.hardLimits as { maxSubjectBytes: number }).maxSubjectBytes = 1024 * 1024;
    }).toThrow(TypeError);
    expect(
      refused(
        await gate.request({ offer: offerDigest, payment: { rail: RAIL, reference: "tx-1" } }),
      ).code,
    ).toBe("subject-too-large");
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

  test("a digest that is not one is refused without the offer source being read at all", async () => {
    // `Sha256Digest` is a template-literal type, not a validated brand, so a transport that
    // builds the string reaches the port with no cast. A holder's five-line source doing
    // `join(dir, `${digest}.dsse`)` would read outside its store, and the refusal code would
    // tell a stranger whether the path exists. Asserting the port was never called is the
    // part that pins it: refusing after the read would still be a read.
    const asked: string[] = [];
    const offers: OfferSource = {
      read: async (offerDigest) => {
        asked.push(offerDigest);
        return null;
      },
    };
    const gate = createRetrievalGate({
      offers,
      subjects: createInMemorySubjectSource([SUBJECT_BYTES]),
      clock: fixedClock,
    });
    for (const shape of [
      "sha256:../../../../../../etc/hosts",
      "sha256:",
      `sha256:${"0".repeat(63)}`,
      `sha256:${"F".repeat(64)}`,
      `sha256:${"0".repeat(64)}/../secret`,
      "not-a-digest",
      "",
    ]) {
      expect(refused(await gate.request({ offer: shape as Sha256Digest })).code)
        .toBe("unknown-offer");
    }
    expect(asked).toEqual([]);

    // And a well-formed digest still reaches the source, so the check is a shape gate rather
    // than a blanket refusal.
    expect(refused(await gate.request({ offer: ABSENT })).code).toBe("unknown-offer");
    expect(asked).toEqual([ABSENT]);
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

  test("a rail that answers about a different payment than the request named is refused", async () => {
    // Self-consistent either way, but the holder's signed sales history must never be able
    // to name a payment the buyer did not present.
    const sealed = await sealTestOffer({
      subject: SUBJECT,
      rails: [{ rail: RAIL, to: TO, amount: "1200" }],
    });
    const answersAboutAnother: RailAdapter = {
      description: {
        rail: RAIL,
        trustModel: "unassured",
        settlement: "already-settled",
        paymentsArePubliclyVisible: false,
      },
      observe: async (): Promise<PaymentObservation> => ({
        status: "observed",
        payment: {
          reference: "tx-2",
          offerDigest: sealed.digest,
          to: TO,
          amount: "1200",
        },
      }),
    };
    const gate = createRetrievalGate({
      offers: createInMemoryOfferSource([sealed.envelopeBytes]),
      subjects: createInMemorySubjectSource([SUBJECT_BYTES]),
      rails: [answersAboutAnother],
      clock: fixedClock,
    });
    const outcome = refused(
      await gate.request({ offer: sealed.digest, payment: { rail: RAIL, reference: "tx-1" } }),
    );
    expect(outcome.code).toBe("payment-mismatch");
    expect(outcome.detail).toContain("a different payment than the one the request named");
  });

  test.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "sha256:x"],
    ["a number", 7],
    ["true", true],
  ])("a request that is %s is refused, never thrown on", async (_name, request) => {
    // The request itself, one level up from its payment, and for the same reason: a
    // transport reaches `request()` with whatever a stranger sent, because
    // `const request: GateRequest = JSON.parse(body)` needs no cast. `null` is the one JSON
    // value where reading a property throws instead of answering `undefined` -- and a throw
    // from this package means "a port failed", so a four-byte body would put the holder's
    // gate into 5xx beside their real outages.
    const { gate } = await freeHarness();
    const outcome = refused(await gate.request(request as unknown as GateRequest));
    expect(outcome.code).toBe("unknown-offer");
  });

  test.each([
    ["null", null],
    ["a string", "tx-1"],
    ["a number", 7],
    ["an array", []],
    ["an object with no rail", { reference: "tx-1" }],
    ["an object whose rail is not a string", { rail: 7, reference: "tx-1" }],
    ["an object whose reference is not a string", { rail: RAIL, reference: null }],
  ])("a payment field that is %s is refused, never thrown on", async (_name, payment) => {
    // `GateRequest` is a TypeScript type, not a validated brand, and `JSON.parse` returns
    // `any` -- so `const request: GateRequest = JSON.parse(body)` needs no cast and a
    // stranger reaches here with whatever they sent. A throw would be read by a transport as
    // a resolver outage, because that is what this package promises a throw means, so five
    // bytes from a stranger would flip the holder to 5xx and hide in their logs next to real
    // outages.
    const { gate, offerDigest } = await priced();
    const outcome = refused(
      await gate.request({ offer: offerDigest, payment } as unknown as GateRequest),
    );
    expect(outcome.code).toBe("payment-required");
  });

  test("a rail identifier the offer does not carry is quoted back, not interpolated raw", async () => {
    // A detail string is what a human reads back in a dispute, and this one is
    // caller-supplied. Quoted the same way the digest refusal quotes its own: the value is
    // delimited, and the control characters an offer's sealed rail identifier could never
    // contain are escaped rather than carried into whatever reads the detail.
    const { gate, offerDigest } = await priced();
    const hostile = 'https://evil.example/v1"\n  and this line is not the gate speaking';
    const outcome = refused(
      await gate.request({ offer: offerDigest, payment: { rail: hostile, reference: "tx-1" } }),
    );
    expect(outcome.code).toBe("rail-not-offered");
    expect(outcome.detail).toContain(JSON.stringify(hostile));
    expect(outcome.detail).not.toContain("\n  and this line");
  });

  test("a payment object read twice cannot answer differently between the two reads", async () => {
    // The request's own fields get the same distrust the adapter's do: an in-process caller
    // can hand the gate getters, and the rail the lookup matched must be the rail the
    // refusal names.
    const { gate, offerDigest } = await priced();
    let reads = 0;
    const shifty = {
      get rail() {
        reads += 1;
        return reads === 1 ? RAIL : "https://rails.other.example/v1";
      },
      reference: "tx-1",
    };
    expect(
      delivered(
        await gate.request({ offer: offerDigest, payment: shifty } as unknown as GateRequest),
      ).bytes,
    ).toEqual(SUBJECT_BYTES);
    expect(reads).toBe(1);
  });

  test("an offer digest read twice cannot answer differently between the two reads", async () => {
    // The request's most load-bearing field, given the same distrust as its payment. Every
    // money check -- rail matching, destination, integer-exact amount -- can pass honestly
    // against a cheap offer on the early reads, and a later read then chooses what `claim()`
    // is handed and what the holder signs a sale of.
    const { gate, offerDigest } = await priced(
      { settlement: "explicit-claim" },
      { deliveryStatements: { signer: createFixtureSigner() } },
    );
    const pricey = `sha256:${"1".repeat(64)}` as Sha256Digest;
    let reads = 0;
    const outcome = delivered(
      await gate.request({
        get offer() {
          reads += 1;
          return reads === 1 ? offerDigest : pricey;
        },
        payment: { rail: RAIL, reference: "tx-1" },
      }),
    );
    expect(reads).toBe(1);
    expect(outcome.offer).toBe(offerDigest);
    expect(outcome.statement?.statement.offer).toBe(offerDigest);
  });

  test("the digest the OfferSource is handed is the digest whose shape was checked", async () => {
    // `ports.ts` promises a source that `offerDigest` is always `sha256:<64 lowercase hex>`,
    // so it may interpolate the value into a path or a URL without escaping it. That promise
    // is about the value the source receives, not a sibling read of it: checking one read and
    // passing another leaves `sha256:../../../../etc/hosts` reaching the port, which is the
    // traversal the shape check was added to stop.
    const { offerDigest, offers, subjects } = await freeHarness();
    const traversal = "sha256:../../../../etc/hosts" as Sha256Digest;
    const handed: Sha256Digest[] = [];
    const watching: OfferSource = {
      read: async (digest, options) => {
        handed.push(digest);
        return offers.read(digest, options);
      },
    };
    const gate = createRetrievalGate({
      offers: watching,
      subjects,
      clock: fixedClock,
    });
    let reads = 0;
    delivered(
      await gate.request({
        get offer() {
          reads += 1;
          return reads === 1 ? offerDigest : traversal;
        },
      }),
    );
    expect(handed).toEqual([offerDigest]);
  });

  test("the payment the gate signs is the payment it checked, not a second read", async () => {
    // `PaymentObservation.payment` is the adapter's own object, and an adapter is third-party
    // code whose properties may be getters. The check that the observation names the payment
    // the request named exists so the holder's signed sales history can never name a payment
    // the buyer never presented -- which it cannot do if the checked read and the signed read
    // are two different reads of a hostile getter.
    const sealed = await sealTestOffer({
      subject: SUBJECT,
      rails: [{ rail: RAIL, to: TO, amount: "1200" }],
    });
    let referenceReads = 0;
    const honestOnce: RailAdapter = {
      description: {
        rail: RAIL,
        trustModel: "unassured",
        settlement: "already-settled",
        paymentsArePubliclyVisible: false,
      },
      observe: async (): Promise<PaymentObservation> => ({
        status: "observed",
        payment: {
          get reference() {
            referenceReads += 1;
            return referenceReads === 1 ? "tx-1" : "tx-SOMEONE-ELSES-PAYMENT";
          },
          offerDigest: sealed.digest,
          to: TO,
          amount: "1200",
        },
      }),
    };
    const gate = createRetrievalGate({
      offers: createInMemoryOfferSource([sealed.envelopeBytes]),
      subjects: createInMemorySubjectSource([SUBJECT_BYTES]),
      rails: [honestOnce],
      clock: fixedClock,
      deliveryStatements: { signer: createFixtureSigner() },
    });
    const outcome = delivered(
      await gate.request({ offer: sealed.digest, payment: { rail: RAIL, reference: "tx-1" } }),
    );
    expect(referenceReads).toBe(1);
    expect(outcome.statement?.statement.payment).toEqual({ rail: RAIL, reference: "tx-1" });
  });

  test("every member of an observation is read exactly once", async () => {
    // The shape-agnostic form of the guard above, for the same reason the adapter has one: a
    // getter can only be watched where someone thought to put one, and counting through a
    // Proxy needs no foresight about which member the next mistake will be on.
    const sealed = await sealTestOffer({
      subject: SUBJECT,
      rails: [{ rail: RAIL, to: TO, amount: "1200" }],
    });
    const reads: Record<string, number> = {};
    const watched: RailAdapter = {
      description: {
        rail: RAIL,
        trustModel: "unassured",
        settlement: "already-settled",
        paymentsArePubliclyVisible: false,
      },
      observe: async (): Promise<PaymentObservation> => ({
        status: "observed",
        payment: new Proxy(
          {
            reference: "tx-1",
            offerDigest: sealed.digest,
            to: TO,
            amount: "1200",
            payer: "payer-a",
            observedAt: "2026-08-31T11:59:00.000Z",
          },
          {
            get(held, key, receiver) {
              if (typeof key === "string") reads[key] = (reads[key] ?? 0) + 1;
              return Reflect.get(held, key, receiver);
            },
          },
        ),
      }),
    };
    const gate = createRetrievalGate({
      offers: createInMemoryOfferSource([sealed.envelopeBytes]),
      subjects: createInMemorySubjectSource([SUBJECT_BYTES]),
      rails: [watched],
      clock: fixedClock,
      deliveryStatements: { signer: createFixtureSigner() },
    });

    delivered(
      await gate.request({ offer: sealed.digest, payment: { rail: RAIL, reference: "tx-1" } }),
    );

    expect(reads).toEqual({
      reference: 1,
      offerDigest: 1,
      to: 1,
      amount: 1,
      payer: 1,
      observedAt: 1,
    });
  });

  test("an observation's status is read once, so it cannot answer two branches differently", async () => {
    // The discriminant above the payment gets the read-once discipline the payment already
    // has. A `status` getter answering "observed" to the first branch and "not-found" to the
    // second used to fall through to a `TypeError` on the payment that is not there. Nothing
    // widens either way -- whatever `payment` turns out to be is still checked against the
    // sealed entry -- but a documented invariant should hold.
    const sealed = await sealTestOffer({
      subject: SUBJECT,
      rails: [{ rail: RAIL, to: TO, amount: "1200" }],
    });
    let statusReads = 0;
    const shifty: RailAdapter = {
      description: {
        rail: RAIL,
        trustModel: "unassured",
        settlement: "already-settled",
        paymentsArePubliclyVisible: false,
      },
      observe: async () =>
        ({
          get status() {
            statusReads += 1;
            return statusReads === 1 ? "observed" : "not-found";
          },
          payment: {
            reference: "tx-1",
            offerDigest: sealed.digest,
            to: TO,
            amount: "1200",
          },
        }) as unknown as PaymentObservation,
    };
    const gate = createRetrievalGate({
      offers: createInMemoryOfferSource([sealed.envelopeBytes]),
      subjects: createInMemorySubjectSource([SUBJECT_BYTES]),
      rails: [shifty],
      clock: fixedClock,
    });
    expect(
      delivered(
        await gate.request({ offer: sealed.digest, payment: { rail: RAIL, reference: "tx-1" } }),
      ).bytes,
    ).toEqual(SUBJECT_BYTES);
    expect(statusReads).toBe(1);
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

  test("redelivery on a key-reveal rail settles once, and is still free", async () => {
    // On this settlement the delivery act IS the taking, so a second collection of the same
    // purchase must not settle again -- and must not be refused either.
    const { gate, offerDigest, rail } = await priced({ settlement: "on-delivery" });
    const request = { offer: offerDigest, payment: { rail: RAIL, reference: "tx-1" } };
    expect(delivered(await gate.request(request)).bytes).toEqual(SUBJECT_BYTES);
    expect(delivered(await gate.request(request)).bytes).toEqual(SUBJECT_BYTES);
    expect(delivered(await gate.request(request)).bytes).toEqual(SUBJECT_BYTES);
    expect(rail.deliveries).toEqual([SUBJECT]);
  });

  test("the delivery act runs after the bytes are verified, never before", async () => {
    const { gate, offerDigest, rail, subjects } = await priced({ settlement: "on-delivery" });
    subjects.remove(SUBJECT);
    expect(
      refused(
        await gate.request({ offer: offerDigest, payment: { rail: RAIL, reference: "tx-1" } }),
      ).code,
    ).toBe("subject-unavailable");
    expect(rail.deliveries).toEqual([]);
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

  test.each([
    ["null", null],
    ["a string", "the-proof"],
    ["an object with no proof", { challengeId: "c1" }],
    ["an object whose challengeId is not a string", { challengeId: 7, proof: "anything" }],
    ["an object whose proof is not a string", { challengeId: "c1", proof: null }],
  ])(
    "a payerProof field that is %s is answered with a fresh question, never thrown on",
    async (_name, payerProof) => {
      // Same reachability as a malformed payment: nothing casts on the way in. A proof the
      // gate cannot read is not an answer, so it gets the answer no answer gets -- and the
      // holder's own challenge store, which carries no promise about what it is handed,
      // never sees the value.
      const asked: unknown[] = [];
      const { gate, offerDigest } = await priced(
        {
          paymentsArePubliclyVisible: true,
          payerSecrets: { "payer-a": "only-the-payer-knows-this" },
        },
        {
          challenges: {
            issue: async (input) => ({
              id: "c1",
              nonce: "n1",
              offerDigest: input.offerDigest,
              rail: input.rail,
              paymentReference: input.paymentReference,
              expiresAt: "2026-08-31T13:00:00.000Z",
            }),
            consume: async (challengeId) => {
              asked.push(challengeId);
              return undefined;
            },
          },
        },
      );
      const outcome = await gate.request({
        offer: offerDigest,
        payment: { rail: RAIL, reference: "tx-1" },
        payerProof,
      } as unknown as GateRequest);
      expect(outcome.status).toBe("challenge");
      expect(asked).toEqual([]);
    },
  );

  test("a challenge that expired on a leap-second clock is still expired", async () => {
    // `isCalendarStrictRfc3339` accepts a real leap second and `Date.parse` answers `NaN`
    // for one, and every comparison against `NaN` is false -- so a host-parser expiry check
    // skipped its own branch entirely on the one instant the gate had just called valid, and
    // honored a long-dead challenge. A belt added so the store is not the only thing
    // deciding an answer is live must not fail in the open direction.
    const leapSecond: Clock = { now: () => "2016-12-31T23:59:60Z" };
    const stale = {
      id: "c1",
      nonce: "n1",
      rail: RAIL,
      paymentReference: "tx-1",
      // Sixteen years before the clock above.
      expiresAt: "2000-01-01T00:00:00.000Z",
    };
    const { gate, offerDigest } = await priced(
      {
        paymentsArePubliclyVisible: true,
        payerSecrets: { "payer-a": "only-the-payer-knows-this" },
      },
      {
        clock: leapSecond,
        challenges: {
          issue: async (input) => ({ ...stale, offerDigest: input.offerDigest }),
          consume: async () => ({ ...stale, offerDigest: offerDigest }),
        },
      },
    );
    const outcome = refused(
      await gate.request({
        offer: offerDigest,
        payment: { rail: RAIL, reference: "tx-1" },
        payerProof: { challengeId: "c1", proof: "anything" },
      }),
    );
    expect(outcome.code).toBe("challenge-unknown");
    expect(outcome.detail).toContain("expired");
  });

  test("an expiry neither side can parse is expired, not live", async () => {
    const { gate, offerDigest } = await priced(
      {
        paymentsArePubliclyVisible: true,
        payerSecrets: { "payer-a": "only-the-payer-knows-this" },
      },
      {
        challenges: {
          issue: async (input) => ({
            id: "c1",
            nonce: "n1",
            offerDigest: input.offerDigest,
            rail: input.rail,
            paymentReference: input.paymentReference,
            expiresAt: "whenever",
          }),
          consume: async () => ({
            id: "c1",
            nonce: "n1",
            offerDigest: offerDigest,
            rail: RAIL,
            paymentReference: "tx-1",
            expiresAt: "whenever",
          }),
        },
      },
    );
    const outcome = refused(
      await gate.request({
        offer: offerDigest,
        payment: { rail: RAIL, reference: "tx-1" },
        payerProof: { challengeId: "c1", proof: "anything" },
      }),
    );
    expect(outcome.code).toBe("challenge-unknown");
    expect(outcome.detail).toContain("expired");
  });

  test("an expired challenge is refused even by a store that hands it back", async () => {
    // The gate re-checks the store's binding, and its expiry belongs to the same distrust:
    // `expiresAt` is on the value the store returned, so a store that forgets to age its
    // own challenges out must not be the only thing deciding an answer is still live.
    const { gate, offerDigest } = await priced(
      {
        paymentsArePubliclyVisible: true,
        payerSecrets: { "payer-a": "only-the-payer-knows-this" },
      },
      {
        challenges: {
          issue: async (input) => ({
            id: "c1",
            nonce: "n1",
            offerDigest: input.offerDigest,
            rail: input.rail,
            paymentReference: input.paymentReference,
            // An hour before `fixedClock`.
            expiresAt: "2026-08-31T11:00:00.000Z",
          }),
          consume: async () => ({
            id: "c1",
            nonce: "n1",
            offerDigest,
            rail: RAIL,
            paymentReference: "tx-1",
            expiresAt: "2026-08-31T11:00:00.000Z",
          }),
        },
      },
    );
    const outcome = refused(
      await gate.request({
        offer: offerDigest,
        payment: { rail: RAIL, reference: "tx-1" },
        payerProof: { challengeId: "c1", proof: "anything" },
      }),
    );
    expect(outcome.code).toBe("challenge-unknown");
    expect(outcome.detail).toContain("expired");
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
    // The buyer is told a statement did not come with their bytes and nothing else. A
    // signer is the holder's own key material, and a KMS refusal naming a key ARN and an
    // internal hostname must not reach an unauthenticated stranger through this field.
    expect(outcome.warnings).toEqual([
      {
        code: "statement-not-emitted",
        detail: "this gate could not seal a delivery statement for this delivery",
      },
    ]);
    expect(JSON.stringify(outcome.warnings)).not.toContain("the signing key is offline");
  });
});

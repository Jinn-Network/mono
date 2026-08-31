import { describe, expect, test } from "vitest";

import { GateConfigurationError } from "./errors.js";
import { assertConformingRailAdapter } from "./rail.js";
import type { PaymentObservation, RailAdapter, RailSelfDescription } from "./rail.js";

const observeNothing = async (): Promise<PaymentObservation> => ({
  status: "not-found",
  detail: "nothing here",
});

function adapter(
  description: Partial<RailSelfDescription>,
  methods: Partial<Omit<RailAdapter, "description" | "observe">> = {},
): RailAdapter {
  return {
    description: {
      rail: "https://rails.test.example/v1",
      trustModel: "unassured",
      settlement: "already-settled",
      paymentsArePubliclyVisible: false,
      ...description,
    },
    observe: observeNothing,
    ...methods,
  };
}

const proveControl = async () => ({ status: "proven" }) as const;
const readyToDeliver = async () => ({ status: "ready" }) as const;
const claimIt = async () => ({ status: "claimed" }) as const;

describe("assertConformingRailAdapter", () => {
  test("accepts the plainest possible rail: unassured, already settled, not public", () => {
    expect(() => assertConformingRailAdapter(adapter({}))).not.toThrow();
  });

  test("refuses a rail identifier that is not in its one normalized spelling", () => {
    // The offer's sealed entry can only ever carry the normalized form, so an adapter
    // spelled any other way could never be matched to the terms it claims to serve.
    for (const rail of [
      "HTTPS://rails.test.example/v1",
      "https://rails.test.example:443/v1",
      "https://rails.test.example/v1?",
      "rails.test.example/v1",
    ]) {
      expect(() => assertConformingRailAdapter(adapter({ rail }))).toThrow(GateConfigurationError);
    }
  });

  test("refuses an unknown trust model or settlement", () => {
    expect(() =>
      assertConformingRailAdapter(
        adapter({ trustModel: "vibes" as RailSelfDescription["trustModel"] }),
      )).toThrow(/unknown trust model/u);
    expect(() =>
      assertConformingRailAdapter(
        adapter({ settlement: "eventually" as RailSelfDescription["settlement"] }),
      )).toThrow(/unknown settlement/u);
  });

  test('"assured" must name the party carrying the assurance', () => {
    for (const trustModel of [
      "assured-by-code",
      "assured-by-institution",
      "assured-by-named-party",
    ] as const) {
      expect(() => assertConformingRailAdapter(adapter({ trustModel })))
        .toThrow(/must name the party/u);
      expect(() => assertConformingRailAdapter(adapter({ trustModel, assuredBy: "   " })))
        .toThrow(/must name the party/u);
      expect(() =>
        assertConformingRailAdapter(adapter({ trustModel, assuredBy: "0xEscrow" }))).not.toThrow();
    }
  });

  test("an unassured rail must not name one", () => {
    expect(() =>
      assertConformingRailAdapter(adapter({ trustModel: "unassured", assuredBy: "0xEscrow" })))
      .toThrow(/must not name an assuring party/u);
  });

  test("a publicly visible rail without a payer-control check is refused", () => {
    // This is the one that matters: without the check, the gate would serve the first
    // onlooker who quoted a transaction hash off the ledger.
    expect(() => assertConformingRailAdapter(adapter({ paymentsArePubliclyVisible: true })))
      .toThrow(/could redeem someone else's payment/u);
    expect(() =>
      assertConformingRailAdapter(
        adapter({ paymentsArePubliclyVisible: true }, { verifyPayerControl: proveControl }),
      )).not.toThrow();
  });

  test("a payer-control check the gate would never call is refused", () => {
    expect(() =>
      assertConformingRailAdapter(
        adapter({ paymentsArePubliclyVisible: false }, { verifyPayerControl: proveControl }),
      )).toThrow(/would never call/u);
  });

  test("on-delivery settlement requires deliver() and forbids claim()", () => {
    expect(() => assertConformingRailAdapter(adapter({ settlement: "on-delivery" })))
      .toThrow(/must implement deliver\(\)/u);
    expect(() =>
      assertConformingRailAdapter(
        adapter({ settlement: "on-delivery" }, { deliver: readyToDeliver, claim: claimIt }),
      )).toThrow(/a second taking step is a second charge/u);
    expect(() =>
      assertConformingRailAdapter(
        adapter({ settlement: "on-delivery" }, { deliver: readyToDeliver }),
      )).not.toThrow();
  });

  test("explicit-claim settlement requires claim()", () => {
    expect(() => assertConformingRailAdapter(adapter({ settlement: "explicit-claim" })))
      .toThrow(/must implement claim\(\)/u);
    expect(() =>
      assertConformingRailAdapter(
        adapter({ settlement: "explicit-claim" }, { claim: claimIt }),
      )).not.toThrow();
  });

  test("already-settled settlement forbids claim(), because nothing is left to take", () => {
    expect(() =>
      assertConformingRailAdapter(
        adapter({ settlement: "already-settled" }, { claim: claimIt }),
      )).toThrow(/nothing left to take/u);
  });
});

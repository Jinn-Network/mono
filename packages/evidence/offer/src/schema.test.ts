import { describe, expect, test } from "vitest";

import { OFFER_RECORD_KIND } from "./identifiers.js";
import { isFreeOffer, OfferRecordSchema } from "./schema.js";

const SUBJECT = `sha256:${"a".repeat(64)}`;
const USDC = "https://spec.jinn.network/rails/eip155-8453-erc20-usdc/v1";
const OLAS = "https://spec.jinn.network/rails/eip155-8453-erc20-olas/v1";
const GATE = { uri: "https://gate.example/offers" };

const offer = (overrides: Record<string, unknown> = {}) => ({
  kind: OFFER_RECORD_KIND,
  subject: SUBJECT,
  rails: [{ rail: USDC, to: "0xdeadbeef", amount: "1500000" }],
  gate: GATE,
  ...overrides,
});

const parse = (document: unknown) => OfferRecordSchema.safeParse(document);

describe("the offer record schema", () => {
  test("accepts a priced offer", () => {
    expect(parse(offer()).success).toBe(true);
  });

  test("accepts an empty rails list as the explicit free offer", () => {
    const result = parse(offer({ rails: [] }));
    expect(result.success).toBe(true);
    expect(isFreeOffer(result.data!)).toBe(true);
  });

  test("refuses an absent rails list — absence and emptiness must not be confusable", () => {
    const { rails: _rails, ...withoutRails } = offer();
    expect(parse(withoutRails).success).toBe(false);
  });

  test("requires a gate even for a free offer — served on sight is still served somewhere", () => {
    const { gate: _gate, ...withoutGate } = offer({ rails: [] });
    expect(parse(withoutGate).success).toBe(false);
  });

  test("pins the kind literal", () => {
    expect(parse(offer({ kind: "https://spec.jinn.network/records/offer/v2" })).success).toBe(false);
  });

  describe("subject", () => {
    test("is one sha256:-prefixed digest, never bare in-toto DigestSet hex", () => {
      expect(parse(offer({ subject: "a".repeat(64) })).success).toBe(false);
      expect(parse(offer({ subject: `SHA256:${"a".repeat(64)}` })).success).toBe(false);
      expect(parse(offer({ subject: `sha256:${"A".repeat(64)}` })).success).toBe(false);
    });

    test("is a single digest, never a list", () => {
      expect(parse(offer({ subject: [SUBJECT] })).success).toBe(false);
    });
  });

  describe("rail amounts", () => {
    test("accept an exact positive integer beyond Number.MAX_SAFE_INTEGER", () => {
      expect(parse(offer({ rails: [{ rail: USDC, to: "x", amount: "2500000000000000000" }] }))
        .success).toBe(true);
    });

    test.each(["0", "00", "01", "+1", "-1", "1.5", "1e6", "", " 1", "1 ", "0x10"])(
      "refuse the spelling %j",
      (amount) => {
        expect(parse(offer({ rails: [{ rail: USDC, to: "x", amount }] })).success).toBe(false);
      },
    );

    test("refuse a numeric amount — units exceed the exact-integer range JSON numbers carry", () => {
      expect(parse(offer({ rails: [{ rail: USDC, to: "x", amount: 1500000 }] })).success).toBe(false);
    });
  });

  describe("rail identifiers", () => {
    test("are open: any absolute URI, not only jinn-owned ones", () => {
      expect(parse(offer({ rails: [{ rail: "https://rails.example/acme/v1", to: "x", amount: "1" }] }))
        .success).toBe(true);
      expect(parse(offer({ rails: [{ rail: "urn:example:rail:1", to: "x", amount: "1" }] }))
        .success).toBe(true);
    });

    test("refuse a bare token or a relative reference", () => {
      for (const rail of ["usdc", "/rails/usdc", "", "https://rails.example/a b"]) {
        expect(parse(offer({ rails: [{ rail, to: "x", amount: "1" }] })).success).toBe(false);
      }
    });
  });

  describe("rails ordering and uniqueness", () => {
    test("accepts entries sorted by rail identifier", () => {
      expect(parse(offer({
        rails: [
          { rail: OLAS, to: "x", amount: "1" },
          { rail: USDC, to: "y", amount: "2" },
        ],
      })).success).toBe(true);
    });

    test("refuses unsorted entries so equal terms seal to equal bytes", () => {
      expect(parse(offer({
        rails: [
          { rail: USDC, to: "y", amount: "2" },
          { rail: OLAS, to: "x", amount: "1" },
        ],
      })).success).toBe(false);
    });

    test("refuses two entries for one rail — a rail carries one price", () => {
      expect(parse(offer({
        rails: [
          { rail: USDC, to: "x", amount: "1" },
          { rail: USDC, to: "y", amount: "2" },
        ],
      })).success).toBe(false);
    });
  });

  describe("gate", () => {
    test("requires an absolute uri", () => {
      for (const uri of ["/offers", "offers", "", "https://gate.example/a b"]) {
        expect(parse(offer({ gate: { uri } })).success).toBe(false);
      }
    });
  });

  describe("supersedes", () => {
    test("is an optional sha256 digest", () => {
      expect(parse(offer({ supersedes: `sha256:${"b".repeat(64)}` })).success).toBe(true);
      expect(parse(offer({ supersedes: "b".repeat(64) })).success).toBe(false);
    });
  });

  describe("extension discipline", () => {
    test("namespaced top-level keys round-trip", () => {
      const result = parse(offer({ "com.example.note": { campaign: "x" } }));
      expect(result.success).toBe(true);
      expect(result.data!["com.example.note"]).toEqual({ campaign: "x" });
    });

    test("bare top-level keys are refused rather than silently accepted", () => {
      expect(parse(offer({ note: "x" })).success).toBe(false);
      expect(parse(offer({ price: "1" })).success).toBe(false);
    });

    test("bare keys inside a rail entry and inside the gate are refused too", () => {
      expect(parse(offer({ rails: [{ rail: USDC, to: "x", amount: "1", memo: "y" }] }))
        .success).toBe(false);
      expect(parse(offer({ gate: { ...GATE, protocol: "x" } })).success).toBe(false);
    });

    test("namespaced keys inside a rail entry and the gate round-trip", () => {
      expect(parse(offer({
        rails: [{ rail: USDC, to: "x", amount: "1", "com.example.memo": "y" }],
        gate: { ...GATE, "com.example.hint": "y" },
      })).success).toBe(true);
    });
  });
});

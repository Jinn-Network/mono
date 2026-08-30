import { describe, expect, test } from "vitest";

import { OFFER_RECORD_KIND } from "./identifiers.js";
import { isFreeOffer, OfferRecordSchema, sortOfferRails } from "./schema.js";

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

  describe("rail destinations", () => {
    test("stay syntactically opaque — no rail binding ships here to impose an address shape", () => {
      for (const to of ["0xdeadbeef", "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh", "acct:x@y.z"]) {
        expect(parse(offer({ rails: [{ rail: USDC, to, amount: "1" }] })).success).toBe(true);
      }
    });

    // A destination that renders as a different address in a buyer's UI, or that splices a
    // second line into a naive display, is the one place display spoofing is money.
    test.each([
      ["a line feed", "0xdead\nbeef"],
      ["a carriage return", "0xdead\rbeef"],
      ["a NUL", "\u0000"],
      ["a DEL", "0xdead\u007Fbeef"],
      ["a C1 control", "0xdead\u0085beef"],
      ["a right-to-left override", "0xdead\u202Ebeef"],
      ["a left-to-right mark", "0xdead\u200Ebeef"],
      ["an isolate", "0xdead\u2066beef"],
      ["nothing but a space", " "],
      ["nothing but unicode whitespace", "\u3000"],
      ["the empty string", ""],
    ])("refuse a destination that is %s", (_label, to) => {
      expect(parse(offer({ rails: [{ rail: USDC, to, amount: "1" }] })).success).toBe(false);
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

    // Without this, one rail spelled two ways passes both uniqueness and sortedness, and the
    // offer carries one rail at two prices.
    test("refuse an un-normalized spelling of an identifier that is already an identity key", () => {
      for (const rail of [
        "HTTPS://RAILS.EXAMPLE/v1",
        "https://rails.example:443/v1",
        "https://rails.example",
      ]) {
        expect(parse(offer({ rails: [{ rail, to: "x", amount: "1" }] })).success).toBe(false);
      }
    });

    // Every row here round-trips `new URL` unchanged, so the round-trip test alone let each
    // pair seal as two rails carrying different destinations and different amounts. RFC 3986
    // calls each pair one URI.
    test.each([
      ["trailing-dot host", "https://rails.example./v1"],
      ["percent-escape of an unreserved character", "https://rails.example/a%62c"],
      ["lowercase percent-escape", "https://rails.example/%2f"],
      ["percent-escape of a tilde", "https://rails.example/%7ex"],
      ["empty query", "https://rails.example/v1?"],
      ["empty fragment", "https://rails.example/v1#"],
      ["empty query and fragment", "https://rails.example/v1?#"],
      ["malformed percent-escape", "https://rails.example/%zz"],
      ["truncated percent-escape", "https://rails.example/v1%"],
    ])("refuse a spelling WHATWG round-trips but RFC 3986 calls equivalent: %s", (_label, rail) => {
      expect(parse(offer({ rails: [{ rail, to: "x", amount: "1" }] })).success).toBe(false);
    });

    // The refusals above must not swallow the spellings that are genuinely one rail's own.
    test.each([
      "https://rails.example/%2F",
      "https://rails.example/v1?a=1",
      "https://rails.example/v1#frag",
      "https://rails.example/v1?a=%2F#f",
      "https://rails.example:8443/v1",
    ])("still accept the normalized spelling %j", (rail) => {
      expect(parse(offer({ rails: [{ rail, to: "x", amount: "1" }] })).success).toBe(true);
    });

    // The honest limit, stated as a test so it cannot rot into an unnoticed claim: opaque
    // hosts and opaque paths round-trip verbatim, so these remain two rails, not one.
    test("do not reach a scheme whose equivalence law this package cannot know", () => {
      expect(parse(offer({
        rails: [
          { rail: "ipfs://BAFYBEIGD/x", to: "a", amount: "1" },
          { rail: "ipfs://bafybeigd/x", to: "b", amount: "999" },
        ],
      })).success).toBe(true);
    });

    test("two spellings of one rail can no longer masquerade as two rails", () => {
      expect(parse(offer({
        rails: [
          { rail: "HTTPS://RAILS.EXAMPLE/v1", to: "a", amount: "1" },
          { rail: "https://rails.example/v1", to: "b", amount: "999" },
        ],
      })).success).toBe(false);
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

  describe("sortOfferRails", () => {
    test("puts entries in the order the schema requires", () => {
      const unsorted = [
        { rail: USDC, to: "y", amount: "2" },
        { rail: OLAS, to: "x", amount: "1" },
      ];
      expect(parse(offer({ rails: unsorted })).success).toBe(false);
      expect(parse(offer({ rails: sortOfferRails(unsorted) })).success).toBe(true);
    });

    test("does not mutate its input", () => {
      const unsorted = [
        { rail: USDC, to: "y", amount: "2" },
        { rail: OLAS, to: "x", amount: "1" },
      ];
      sortOfferRails(unsorted);
      expect(unsorted[0]!.rail).toBe(USDC);
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

import { canonicalJsonBytes } from "@jinn-network/trust-core";
import type { Sha256Digest } from "@jinn-network/trust-core";
import { describe, expect, test } from "vitest";

import { DELIVERY_STATEMENT_RECORD_KIND } from "./identifiers.js";
import {
  DeliveryStatementSchema,
  InvalidDeliveryStatementError,
  parseDeliveryStatementEnvelope,
  parseExactDeliveryStatementPayload,
  sealDeliveryStatement,
  sealDeliveryStatementPayload,
} from "./statement.js";
import { createFixtureSigner } from "./testing.js";

const OFFER = `sha256:${"a".repeat(64)}` as Sha256Digest;
const SUBJECT = `sha256:${"b".repeat(64)}` as Sha256Digest;

const paid = {
  kind: DELIVERY_STATEMENT_RECORD_KIND,
  offer: OFFER,
  subject: SUBJECT,
  payment: { rail: "https://rails.test.example/v1", reference: "tx-0x9f" },
  deliveredAt: "2026-08-31T12:00:00Z",
};

const free = {
  kind: DELIVERY_STATEMENT_RECORD_KIND,
  offer: OFFER,
  subject: SUBJECT,
  deliveredAt: "2026-08-31T12:00:00Z",
};

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/**
 * The refusal's own message is the fixed boundary sentence; what a caller acts on is the
 * per-issue detail, so that is what these assertions read.
 */
function refusalDetail(act: () => unknown): string {
  try {
    act();
  } catch (error) {
    if (error instanceof InvalidDeliveryStatementError) {
      return error.errors.map((issue) => `${issue.path}: ${issue.message}`).join(" | ");
    }
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("the delivery statement record", () => {
  test("seals, and the envelope round-trips to the same document and digest", async () => {
    const sealed = await sealDeliveryStatement({ statement: paid, signer: createFixtureSigner() });
    const parsed = parseDeliveryStatementEnvelope(sealed.envelopeBytes);
    expect(parsed.statement).toEqual(paid);
    expect(parsed.digest).toBe(sealed.digest);
    expect(decode(parsed.payloadBytes)).toBe(decode(sealed.payloadBytes));
  });

  test("re-sealing the same document reproduces the same bytes", async () => {
    const once = await sealDeliveryStatement({ statement: paid, signer: createFixtureSigner() });
    const twice = await sealDeliveryStatement({ statement: paid, signer: createFixtureSigner() });
    expect(decode(twice.envelopeBytes)).toBe(decode(once.envelopeBytes));
    expect(twice.digest).toBe(once.digest);
  });

  test("the free path carries no payment at all", async () => {
    const sealed = await sealDeliveryStatement({ statement: free, signer: createFixtureSigner() });
    expect(Object.hasOwn(sealed.statement, "payment")).toBe(false);
  });

  test("an omitted payment and one spelled undefined are the same delivery", () => {
    expect(decode(sealDeliveryStatementPayload({ ...free, payment: undefined })))
      .toBe(decode(sealDeliveryStatementPayload(free)));
  });

  test("the statement carries no price, because the offer already does", async () => {
    const sealed = await sealDeliveryStatement({ statement: paid, signer: createFixtureSigner() });
    const document = sealed.statement as Record<string, unknown>;
    for (const absent of ["amount", "price", "fee", "cut", "total"]) {
      expect(Object.hasOwn(document, absent), `${absent} must not exist on a statement`).toBe(false);
    }
  });

  test("a namespaced extension survives sealing and re-parsing unchanged", async () => {
    const extended = { ...paid, "com.example.settlementBlock": 21_000_000 };
    const sealed = await sealDeliveryStatement({
      statement: extended,
      signer: createFixtureSigner(),
    });
    expect(parseDeliveryStatementEnvelope(sealed.envelopeBytes).statement).toEqual(extended);
  });

  test("a bare extension key is refused rather than quietly accepted", () => {
    expect(() => sealDeliveryStatementPayload({ ...paid, settlementBlock: 1 }))
      .toThrow(InvalidDeliveryStatementError);
  });

  test.each([
    ["another kind", { ...paid, kind: "https://spec.jinn.network/records/offer/v1" }],
    ["a bare hex offer digest", { ...paid, offer: "a".repeat(64) }],
    ["an uppercase subject digest", { ...paid, subject: `sha256:${"A".repeat(64)}` }],
    ["a missing subject", { kind: paid.kind, offer: OFFER, deliveredAt: paid.deliveredAt }],
    ["a non-RFC-3339 delivery time", { ...paid, deliveredAt: "2026-08-31 12:00:00" }],
    ["an impossible calendar date", { ...paid, deliveredAt: "2026-02-30T12:00:00Z" }],
    [
      "a rail identifier spelled other than normalized",
      { ...paid, payment: { ...paid.payment, rail: "HTTPS://rails.test.example/v1" } },
    ],
    [
      "a blank payment reference",
      { ...paid, payment: { ...paid.payment, reference: "  " } },
    ],
    [
      "a payment reference that can render as another",
      { ...paid, payment: { ...paid.payment, reference: "tx-1‮tx-2" } },
    ],
    ["a payment with no reference", { ...paid, payment: { rail: paid.payment.rail } }],
  ])("refuses %s", (_name, document) => {
    expect(DeliveryStatementSchema.safeParse(document).success).toBe(false);
    expect(() => sealDeliveryStatementPayload(document)).toThrow(InvalidDeliveryStatementError);
  });

  test("a __proto__ member is refused, never dropped", () => {
    const smuggled = JSON.parse(`{"__proto__":{"x":1},"kind":${JSON.stringify(paid.kind)}}`);
    expect(refusalDetail(() => sealDeliveryStatementPayload(smuggled))).toMatch(/__proto__/u);
  });

  test("payload bytes that are not the exact canonical encoding are refused", () => {
    const canonical = sealDeliveryStatementPayload(paid);
    expect(parseExactDeliveryStatementPayload(canonical)).toEqual(paid);
    const respaced = new TextEncoder().encode(`${decode(canonical).slice(0, -1)} }`);
    expect(refusalDetail(() => parseExactDeliveryStatementPayload(respaced)))
      .toMatch(/exact canonical JSON encoding/u);
  });

  test("bytes that are not UTF-8 JSON are an invalid document, not a crash", () => {
    expect(refusalDetail(() => parseExactDeliveryStatementPayload(new Uint8Array([0xff, 0xfe]))))
      .toMatch(/not valid UTF-8 JSON/u);
  });

  test("an envelope under another payloadType is refused", async () => {
    const sealed = await sealDeliveryStatement({ statement: paid, signer: createFixtureSigner() });
    const envelope = JSON.parse(decode(sealed.envelopeBytes)) as Record<string, unknown>;
    envelope["payloadType"] = "application/vnd.jinn.offer.v1+json";
    expect(refusalDetail(() => parseDeliveryStatementEnvelope(canonicalJsonBytes(envelope))))
      .toMatch(/payloadType/u);
  });

  test("bytes that are not a DSSE envelope at all are refused", () => {
    expect(() => parseDeliveryStatementEnvelope(new TextEncoder().encode("{}")))
      .toThrow(InvalidDeliveryStatementError);
  });

  test("the invalid-document contract is the category, not the class", () => {
    try {
      sealDeliveryStatementPayload({});
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as { category?: string }).category).toBe("invalid-document");
      expect((error as InvalidDeliveryStatementError).errors.length).toBeGreaterThan(0);
    }
  });
});

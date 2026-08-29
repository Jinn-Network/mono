import { parseDsseEnvelope, recordDigest } from "@jinn-network/trust-core";
import { describe, expect, test } from "vitest";

import { OFFER_RECORD_KIND, OFFER_RECORD_MEDIA_TYPE } from "./identifiers.js";
import {
  InvalidOfferError,
  parseExactOfferPayload,
  parseOfferEnvelope,
  sealOffer,
  sealOfferPayload,
} from "./seal.js";
import { createFixtureOfferSigner, FIXTURE_SIGNER_KEY_ID } from "./testing.js";

const SUBJECT = `sha256:${"a".repeat(64)}`;
const USDC = "https://spec.jinn.network/rails/eip155-8453-erc20-usdc/v1";

const offer = (overrides: Record<string, unknown> = {}) => ({
  kind: OFFER_RECORD_KIND,
  subject: SUBJECT,
  rails: [{ rail: USDC, to: "0xdeadbeef", amount: "1500000" }],
  gate: { uri: "https://gate.example/offers" },
  ...overrides,
});

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("sealOfferPayload", () => {
  test("emits RFC 8785 JCS: sorted keys, compact separators, no trailing newline", () => {
    const text = decode(sealOfferPayload(offer()));
    expect(text.startsWith('{"gate":')).toBe(true);
    expect(text).not.toMatch(/\s/u);
    expect(JSON.parse(text)).toEqual(offer());
  });

  test("key insertion order never reaches the bytes", () => {
    const reordered = {
      gate: { uri: "https://gate.example/offers" },
      rails: [{ to: "0xdeadbeef", amount: "1500000", rail: USDC }],
      subject: SUBJECT,
      kind: OFFER_RECORD_KIND,
    };
    expect(decode(sealOfferPayload(reordered))).toBe(decode(sealOfferPayload(offer())));
  });

  test("an omitted and an explicitly-undefined optional field seal identically", () => {
    expect(decode(sealOfferPayload(offer({ supersedes: undefined }))))
      .toBe(decode(sealOfferPayload(offer())));
  });

  test("refuses an invalid document with per-path issues", () => {
    try {
      sealOfferPayload(offer({ subject: "nope" }));
      expect.unreachable("sealing an invalid offer must throw");
    } catch (error) {
      expect((error as InvalidOfferError).category).toBe("invalid-document");
      expect((error as InvalidOfferError).errors[0]!.path).toBe("subject");
    }
  });

  test('refuses a "__proto__" member rather than silently dropping it', () => {
    const document = JSON.parse(
      `{"kind":${JSON.stringify(OFFER_RECORD_KIND)},"subject":"${SUBJECT}","rails":[],`
      + `"gate":{"uri":"https://gate.example/offers"},"__proto__":{"x":1}}`,
    );
    expect(() => sealOfferPayload(document)).toThrow(InvalidOfferError);
  });
});

describe("parseExactOfferPayload", () => {
  test("round-trips the canonical bytes", () => {
    const bytes = sealOfferPayload(offer());
    expect(parseExactOfferPayload(bytes)).toEqual(offer());
  });

  test("refuses a re-spelled encoding of the same offer", () => {
    const respelled = encode(JSON.stringify(offer()));
    expect(() => parseExactOfferPayload(respelled)).toThrow(InvalidOfferError);
  });

  test("refuses bytes that are not UTF-8 JSON", () => {
    expect(() => parseExactOfferPayload(Uint8Array.from([0xff, 0xfe]))).toThrow(InvalidOfferError);
  });
});

describe("sealOffer", () => {
  test("produces a DSSE envelope under the offer media type, digested over the envelope", async () => {
    const sealed = await sealOffer({ offer: offer(), signer: createFixtureOfferSigner() });
    const envelope = parseDsseEnvelope(sealed.envelopeBytes);
    expect(envelope.payloadType).toBe(OFFER_RECORD_MEDIA_TYPE);
    expect(decode(envelope.payloadBytes)).toBe(decode(sealOfferPayload(offer())));
    expect(sealed.digest).toBe(recordDigest(sealed.envelopeBytes));
    expect(envelope.signatures[0]!.keyid).toBe(FIXTURE_SIGNER_KEY_ID);
  });

  test("is deterministic for a deterministic signer", async () => {
    const first = await sealOffer({ offer: offer(), signer: createFixtureOfferSigner() });
    const second = await sealOffer({ offer: offer(), signer: createFixtureOfferSigner() });
    expect(second.digest).toBe(first.digest);
  });

  test("validates before it signs, so an invalid offer is never handed to a signer", async () => {
    let called = false;
    const signer = async () => {
      called = true;
      return [{ signature: Uint8Array.of(1) }] as const;
    };
    await expect(sealOffer({ offer: offer({ rails: undefined }), signer })).rejects.toThrow(
      InvalidOfferError,
    );
    expect(called).toBe(false);
  });

  test("repricing produces a new digest — terms are never mutated in place", async () => {
    const original = await sealOffer({ offer: offer(), signer: createFixtureOfferSigner() });
    const reprice = await sealOffer({
      offer: offer({
        rails: [{ rail: USDC, to: "0xdeadbeef", amount: "900000" }],
        supersedes: original.digest,
      }),
      signer: createFixtureOfferSigner(),
    });
    expect(reprice.digest).not.toBe(original.digest);
    expect(reprice.offer.supersedes).toBe(original.digest);
  });
});

describe("parseOfferEnvelope", () => {
  test("returns the offer, its digest, and the declared signatures", async () => {
    const sealed = await sealOffer({ offer: offer(), signer: createFixtureOfferSigner() });
    const parsed = parseOfferEnvelope(sealed.envelopeBytes);
    expect(parsed.offer).toEqual(offer());
    expect(parsed.digest).toBe(sealed.digest);
    expect(parsed.signatures).toHaveLength(1);
  });

  test("refuses an envelope whose payloadType is another record kind", async () => {
    const sealed = await sealOffer({ offer: offer(), signer: createFixtureOfferSigner() });
    const mutated = JSON.parse(decode(sealed.envelopeBytes));
    mutated.payloadType = "application/vnd.jinn.environment.v1+json";
    expect(() => parseOfferEnvelope(encode(JSON.stringify(mutated)))).toThrow(InvalidOfferError);
  });

  test("refuses a re-spelled envelope — an offer's identity is these exact bytes", async () => {
    const sealed = await sealOffer({ offer: offer(), signer: createFixtureOfferSigner() });
    const respelled = encode(`${decode(sealed.envelopeBytes)} `);
    expect(() => parseOfferEnvelope(respelled)).toThrow(InvalidOfferError);
  });

  test("refuses an envelope whose payload is not the canonical offer encoding", async () => {
    const sealed = await sealOffer({ offer: offer(), signer: createFixtureOfferSigner() });
    const envelope = JSON.parse(decode(sealed.envelopeBytes));
    envelope.payload = Buffer.from(JSON.stringify(offer()), "utf8").toString("base64");
    expect(() => parseOfferEnvelope(encode(JSON.stringify(envelope)))).toThrow(InvalidOfferError);
  });
});

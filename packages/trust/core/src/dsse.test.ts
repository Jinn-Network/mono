import { describe, expect, test } from "vitest";

import { DSSE_PAYLOAD_TYPE, TRUST_KEY_BINDING_MEDIA_TYPE } from "./identifiers.js";
import {
  dssePreAuthEncoding,
  parseDsseEnvelope,
  parseSignedRecordEnvelope,
  sealDsseEnvelope,
  sealSignedRecord,
} from "./dsse.js";

function ascii(bytes: Uint8Array, length?: number): string {
  return Array.from(length === undefined ? bytes : bytes.slice(0, length))
    .map((byte) => String.fromCharCode(byte))
    .join("");
}

describe("dssePreAuthEncoding", () => {
  test("begins with the DSSEv1 PAE prefix", () => {
    const payloadBytes = new TextEncoder().encode('{"hello":"world"}');
    const pae = dssePreAuthEncoding(DSSE_PAYLOAD_TYPE, payloadBytes);
    expect(ascii(pae, "DSSEv1 ".length)).toBe("DSSEv1 ");
  });
});

describe("sealDsseEnvelope / parseDsseEnvelope", () => {
  test("round-trips payload bytes and signatures", () => {
    const payloadBytes = new TextEncoder().encode('{"hello":"world"}');
    const envelopeBytes = sealDsseEnvelope({
      payloadBytes,
      signatures: [
        { signature: new Uint8Array([1, 2, 3]), keyid: "did:key:z6Mk-example" },
      ],
    });
    const parsed = parseDsseEnvelope(envelopeBytes);
    expect(parsed.payloadType).toBe(DSSE_PAYLOAD_TYPE);
    expect(parsed.payloadBytes).toEqual(payloadBytes);
    expect(parsed.signatures).toHaveLength(1);
    expect(parsed.signatures[0]?.keyid).toBe("did:key:z6Mk-example");
  });

  test("rejects an envelope with no signatures", () => {
    const payloadBytes = new TextEncoder().encode("{}");
    expect(() =>
      sealDsseEnvelope({
        payloadBytes,
        // @ts-expect-error -- exercising the runtime guard against the type-level tuple guarantee.
        signatures: [],
      }),
    ).toThrow();
  });

  test("defaults payloadType to DSSE_PAYLOAD_TYPE but accepts an override (TEP §21.2: a signed record's DSSE payloadType is the record's own media type)", () => {
    const payloadBytes = new TextEncoder().encode('{"hello":"world"}');
    const envelopeBytes = sealDsseEnvelope({
      payloadBytes,
      payloadType: TRUST_KEY_BINDING_MEDIA_TYPE,
      signatures: [{ signature: new Uint8Array([1, 2, 3]) }],
    });
    const parsed = parseDsseEnvelope(envelopeBytes);
    expect(parsed.payloadType).toBe(TRUST_KEY_BINDING_MEDIA_TYPE);
  });
});

describe("sealSignedRecord / parseSignedRecordEnvelope", () => {
  test("seals a record under an arbitrary payloadType and round-trips through parseSignedRecordEnvelope", async () => {
    const record = { b: 1, a: 2 };
    const sealed = await sealSignedRecord({
      record,
      payloadType: TRUST_KEY_BINDING_MEDIA_TYPE,
      signer: async ({ payloadType, preAuthEncoding }) => {
        expect(payloadType).toBe(TRUST_KEY_BINDING_MEDIA_TYPE);
        expect(ascii(preAuthEncoding, "DSSEv1 ".length)).toBe("DSSEv1 ");
        return [{ signature: new Uint8Array([9, 9, 9]), keyid: "did:key:z6Mk-example" }];
      },
    });
    expect(sealed.recordDigest).toMatch(/^sha256:[0-9a-f]{64}$/);

    const parsed = parseSignedRecordEnvelope(sealed.envelopeBytes, TRUST_KEY_BINDING_MEDIA_TYPE);
    expect(parsed.recordDigest).toBe(sealed.recordDigest);
    expect(JSON.parse(new TextDecoder().decode(parsed.payloadBytes))).toEqual({ a: 2, b: 1 });
  });

  test("parseSignedRecordEnvelope rejects a mismatched payloadType", async () => {
    const sealed = await sealSignedRecord({
      record: { a: 1 },
      payloadType: TRUST_KEY_BINDING_MEDIA_TYPE,
      signer: async () => [{ signature: new Uint8Array([1]) }],
    });
    expect(() => parseSignedRecordEnvelope(sealed.envelopeBytes, DSSE_PAYLOAD_TYPE)).toThrow();
  });
});

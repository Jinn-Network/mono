import { describe, expect, test } from "vitest";

import { DSSE_PAYLOAD_TYPE } from "./identifiers.js";
import {
  dssePreAuthEncoding,
  parseDsseEnvelope,
  sealDsseEnvelope,
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
});

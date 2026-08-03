import { describe, it, expect } from "vitest";
import { dssePreAuthEncoding, parseWireDsseEnvelope } from "./dsse.js";

describe("dssePreAuthEncoding", () => {
  it("encodes DSSE PAE deterministically", () => {
    expect(
      new TextDecoder().decode(
        dssePreAuthEncoding(
          "application/test",
          new TextEncoder().encode("payload"),
        ),
      ),
    ).toBe("DSSEv1 16 application/test 7 payload");
  });
});

describe("parseWireDsseEnvelope", () => {
  it("strict-decodes exact payload and signature bytes from the one published wire shape", () => {
    const payloadBytes = new TextEncoder().encode('{"a":1}');
    const signatureBytes = Uint8Array.from([0, 1, 127, 128, 255]);
    const envelope = {
      payloadType: "application/test+json",
      payload: Buffer.from(payloadBytes).toString("base64"),
      signatures: [{ keyid: "did:key:zSigner", sig: Buffer.from(signatureBytes).toString("base64") }],
    };

    expect(parseWireDsseEnvelope(envelope)).toEqual({
      envelope,
      payloadBytes,
      signatures: [{ keyid: "did:key:zSigner", signatureBytes }],
    });
  });

  it.each([
    [{ payloadType: "type", payload: "e30", signatures: [{ sig: "c2ln" }] }, "payload is not canonical standard base64"],
    [{ payloadType: "type", payload: "e30=", signatures: [{ sig: "c2ln-_==" }] }, "signature 0 is not canonical standard base64"],
    [{ payloadType: "type", payload: "e30=", signatures: [{ sig: "c2ln" }], extra: true }, "exactly payload, payloadType, and signatures"],
    [{ payloadType: "type", payload: "e30=", signatures: [{ sig: "c2ln", extra: true }] }, "signature 0 must contain exactly sig and optional keyid"],
  ] as const)("rejects malformed or noncanonical wire DSSE %#", (envelope, message) => {
    expect(() => parseWireDsseEnvelope(envelope)).toThrow(message);
  });
});

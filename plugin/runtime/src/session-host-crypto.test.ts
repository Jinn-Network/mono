// SPDX-License-Identifier: Apache-2.0

import { generateKeyPairSync, sign } from "node:crypto";

import { dssePreAuthEncoding, sealDsseEnvelope } from "@jinn-network/trust-core";
import { describe, expect, test } from "vitest";

import {
  createDidKeyDsseVerifier,
  decodeEd25519DidKey,
  didKeyFromEd25519PublicKey,
  verifyEd25519,
} from "./session-host-crypto.js";

const PAYLOAD_TYPE = "application/vnd.jinn.test+json";

function keypair() {
  const pair = generateKeyPairSync("ed25519");
  return { pair, didKey: didKeyFromEd25519PublicKey(pair.publicKey) };
}

describe("decodeEd25519DidKey", () => {
  test("round-trips an Ed25519 public key through its did:key spelling", () => {
    const { pair, didKey } = keypair();
    const decoded = decodeEd25519DidKey(didKey);
    expect(decoded).toBeDefined();
    expect(decoded!.export({ format: "der", type: "spki" })).toEqual(
      pair.publicKey.export({ format: "der", type: "spki" }),
    );
  });

  test("refuses an over-long spelling without decoding it", () => {
    // The decode is BigInt work quadratic in the input length and every caller
    // wants exactly 34 bytes, so a longer string is not a key that might still
    // decode — it is one that cannot. `createDidKeyDsseVerifier` takes its
    // keyid from the envelope, so the bound is what keeps a nonsense keyid
    // from costing more than the refusal is worth.
    const overLong = `did:key:z${"1".repeat(4096)}`;
    const started = process.hrtime.bigint();
    expect(decodeEd25519DidKey(overLong)).toBeUndefined();
    expect(Number(process.hrtime.bigint() - started)).toBeLessThan(50_000_000);
  });

  test("returns undefined rather than throwing on malformed input", () => {
    const { didKey } = keypair();
    for (const malformed of [
      "",
      "did:key:",
      "key-1",
      "did:key:zNotBase58Il0O",
      // A truncated multibase payload: valid base58, wrong byte length.
      `did:key:z${didKey.slice("did:key:z".length, -6)}`,
      // secp256k1's multicodec prefix (0xe7 0x01), not Ed25519's.
      "did:key:zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme",
    ]) {
      expect(decodeEd25519DidKey(malformed)).toBeUndefined();
    }
  });
});

describe("verifyEd25519", () => {
  test("accepts a genuine signature and refuses a tampered payload", () => {
    const { pair, didKey } = keypair();
    const message = new TextEncoder().encode("the signed bytes");
    const signature = new Uint8Array(sign(null, message, pair.privateKey));

    expect(verifyEd25519(message, signature, didKey)).toBe(true);
    expect(verifyEd25519(new TextEncoder().encode("other bytes"), signature, didKey)).toBe(false);
    expect(verifyEd25519(message, new Uint8Array(signature.length), didKey)).toBe(false);
    expect(verifyEd25519(message, signature, keypair().didKey)).toBe(false);
    expect(verifyEd25519(message, signature, "did:key:znonsense")).toBe(false);
  });
});

describe("createDidKeyDsseVerifier", () => {
  const verifier = createDidKeyDsseVerifier();

  function seal(payloadBytes: Uint8Array, key: ReturnType<typeof keypair>): Uint8Array {
    return sealDsseEnvelope({
      payloadBytes,
      payloadType: PAYLOAD_TYPE,
      signatures: [
        {
          signature: new Uint8Array(
            sign(null, dssePreAuthEncoding(PAYLOAD_TYPE, payloadBytes), key.pair.privateKey),
          ),
          keyid: key.didKey,
        },
      ],
    });
  }

  test("reports only the keyids whose own self-describing key verifies", () => {
    const key = keypair();
    const payload = new TextEncoder().encode('{"claim":"true"}');
    expect(verifier(seal(payload, key))).toEqual({ validSignerKeyids: [key.didKey] });
  });

  test("reports no keyid when the signature was made over other bytes", () => {
    const key = keypair();
    const envelope = sealDsseEnvelope({
      payloadBytes: new TextEncoder().encode('{"claim":"true"}'),
      payloadType: PAYLOAD_TYPE,
      signatures: [
        {
          signature: new Uint8Array(
            sign(null, dssePreAuthEncoding(PAYLOAD_TYPE, new TextEncoder().encode("{}")), key.pair.privateKey),
          ),
          keyid: key.didKey,
        },
      ],
    });
    expect(verifier(envelope)).toEqual({ validSignerKeyids: [] });
  });

  test("reports no keyid for a malformed envelope rather than throwing", () => {
    expect(verifier(new TextEncoder().encode("not an envelope"))).toEqual({ validSignerKeyids: [] });
    expect(verifier(new Uint8Array())).toEqual({ validSignerKeyids: [] });
  });

  test("reports no keyid for a signature with no keyid to resolve", () => {
    const key = keypair();
    const payload = new TextEncoder().encode("{}");
    const envelope = sealDsseEnvelope({
      payloadBytes: payload,
      payloadType: PAYLOAD_TYPE,
      signatures: [
        { signature: new Uint8Array(sign(null, dssePreAuthEncoding(PAYLOAD_TYPE, payload), key.pair.privateKey)) },
      ],
    });
    expect(verifier(envelope)).toEqual({ validSignerKeyids: [] });
  });
});

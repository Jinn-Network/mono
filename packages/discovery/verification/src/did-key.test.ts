// SPDX-License-Identifier: Apache-2.0

import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "vitest";

import {
  didKeyFromEd25519PublicKey,
  ed25519PublicKeyBytesFromDidKey,
  ed25519PublicKeyFromDidKey,
} from "./did-key.js";

/** The report key of the public bundle conformance kit, whose identifier another encoder wrote. */
const KIT_DID_KEY = "did:key:z6MkiTfZS4EM9K1fczmhpcmi1YxDdtURfuPWJrCSofeTwYFX";
const KIT_PUBLIC_KEY_HEX = "3b8955ece6e29ffa041af08ad488ec6cfcd1b16a043e1eb1869d8c7ec6009656";
const KIT_SPKI_BASE64 = "MCowBQYDK2VwAyEAO4lV7Obin/oEGvCK1IjsbPzRsWoEPh6xhp2MfsYAllY=";

const kitKey = () => createPublicKey({ key: Buffer.from(KIT_SPKI_BASE64, "base64"), format: "der", type: "spki" });

describe("didKeyFromEd25519PublicKey", () => {
  test("spells the conformance kit's key as the kit does", () => {
    expect(didKeyFromEd25519PublicKey(kitKey())).toBe(KIT_DID_KEY);
  });

  test.each([
    ["P-256", () => generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey, "ec"],
    ["P-384", () => generateKeyPairSync("ec", { namedCurve: "P-384" }).publicKey, "ec"],
    ["RSA", () => generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey, "rsa"],
    ["X25519", () => generateKeyPairSync("x25519").publicKey, "x25519"],
    ["Ed448", () => generateKeyPairSync("ed448").publicKey, "ed448"],
  ])("refuses a %s key", (_name, makeKey, keyType) => {
    expect(() => didKeyFromEd25519PublicKey(makeKey())).toThrow(`needs an Ed25519 public key, got ${keyType}`);
  });

  test("round-trips through decoding", () => {
    for (let round = 0; round < 25; round += 1) {
      const { publicKey } = generateKeyPairSync("ed25519");
      const decoded = ed25519PublicKeyFromDidKey(didKeyFromEd25519PublicKey(publicKey));
      expect(decoded?.equals(publicKey)).toBe(true);
    }
  });
});

describe("decoding a did:key", () => {
  test("reads the conformance kit's key out of its identifier", () => {
    expect(Buffer.from(ed25519PublicKeyBytesFromDidKey(KIT_DID_KEY)!).toString("hex")).toBe(KIT_PUBLIC_KEY_HEX);
    expect(ed25519PublicKeyFromDidKey(KIT_DID_KEY)?.equals(kitKey())).toBe(true);
  });

  test.each([
    ["not a did", "not-a-did"],
    ["another did method", "did:web:example.com"],
    ["an empty payload", "did:key:z"],
    ["a character outside the alphabet", "did:key:z0OIl"],
    // Full length, so only the alphabet test refuses it: read as digit 0, this is the kit's key.
    ["a full-length identifier with a character outside the alphabet", KIT_DID_KEY.replace("K1f", "K0f")],
    ["the same payload under another did method", KIT_DID_KEY.replace("did:key:", "did:web:")],
    ["a payload one digit too long", `did:key:z${"1".repeat(48)}`],
    ["too few bytes for a key", "did:key:z6Mk"],
    ["a secp256k1 key", "did:key:zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme"],
    // The same payload length as Ed25519, so only the multicodec prefix tells them apart.
    ["an x25519 key", "did:key:z6LSeu9HkTHSfLLeUs2nnzUSNedgDUevfNQgQjQC23ZCit6F"],
    // The Ed25519 prefix followed by 31 key bytes.
    ["one key byte too few", "did:key:z2DQUz8yxybcgY49o2TDENNPqPQBbVynuU6CcNCWtSMrwMx"],
    // Leading `1`s are leading zero bytes, so this is not another spelling of the kit's key.
    ["a leading zero byte", `did:key:z1${KIT_DID_KEY.slice("did:key:z".length)}`],
  ])("answers undefined for %s", (_name, keyId) => {
    expect(ed25519PublicKeyBytesFromDidKey(keyId)).toBeUndefined();
    expect(ed25519PublicKeyFromDidKey(keyId)).toBeUndefined();
  });
});

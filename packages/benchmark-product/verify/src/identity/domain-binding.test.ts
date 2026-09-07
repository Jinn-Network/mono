// SPDX-License-Identifier: Apache-2.0

import { generateKeyPairSync, sign as edSign, type KeyObject } from "node:crypto";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { describe, expect, test } from "vitest";
import { BenchmarkProductError } from "../profile/errors.js";
import {
  ed25519PublicKeyBytesFromDidKey,
  ed25519PublicKeyFromDidKey,
  keyFingerprintFromDidKey,
} from "./did-key.js";
import {
  DOMAIN_BINDING_FORMAT,
  domainBindingProof,
  domainBindingStatementBytes,
  verifyDomainBinding,
  type DomainBindingMechanism,
} from "./domain-binding.js";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58btcEncode(bytes: Uint8Array): string {
  let leadingZeros = 0;
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) leadingZeros += 1;
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let digits = "";
  while (value > 0n) {
    digits = BASE58_ALPHABET[Number(value % 58n)] + digits;
    value /= 58n;
  }
  return "1".repeat(leadingZeros) + digits;
}

function didKeyOf(publicKey: KeyObject): string {
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  const raw = new Uint8Array(Buffer.from(jwk.x, "base64url"));
  return `did:key:z${base58btcEncode(Uint8Array.from([0xed, 0x01, ...raw]))}`;
}

function mintBinding(options: {
  readonly domain?: string;
  readonly mechanism?: DomainBindingMechanism;
  readonly signWith?: KeyObject;
} = {}): { readonly keyId: string; readonly bytes: Uint8Array; readonly publicKey: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyId = didKeyOf(publicKey);
  const statement = {
    format: DOMAIN_BINDING_FORMAT,
    domain: options.domain ?? "example.com",
    keyId,
    mechanism: options.mechanism ?? ("dns-txt" as const),
    statedAt: "2026-09-02T00:00:00.000Z",
  };
  const signature = Buffer.from(
    edSign(null, Buffer.from(domainBindingStatementBytes(statement)), options.signWith ?? privateKey),
  ).toString("base64");
  return { keyId, publicKey, bytes: canonicalJsonBytes({ ...statement, signature }) };
}

describe("did:key decoding (issue #2983)", () => {
  test("recovers the exact public key the identifier encodes", () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const keyId = didKeyOf(publicKey);
    const jwk = publicKey.export({ format: "jwk" }) as { x: string };
    expect(Buffer.from(ed25519PublicKeyBytesFromDidKey(keyId)!).toString("base64url")).toBe(jwk.x);
    expect(ed25519PublicKeyFromDidKey(keyId)!.export({ format: "jwk" })).toEqual(
      publicKey.export({ format: "jwk" }),
    );
  });

  test("the fingerprint digests the key, so it is stable across identifiers of the same key", () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const fingerprint = keyFingerprintFromDidKey(didKeyOf(publicKey));
    expect(fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(keyFingerprintFromDidKey(didKeyOf(publicKey))).toBe(fingerprint);
  });

  test("a non-did:key identifier yields nothing rather than a fabricated fingerprint", () => {
    for (const identifier of ["urn:jinn:agent:alpha", "did:key:zNOT!base58", "did:web:example.com", ""]) {
      expect(ed25519PublicKeyBytesFromDidKey(identifier)).toBeUndefined();
      expect(keyFingerprintFromDidKey(identifier)).toBeUndefined();
    }
  });

  test("a did:key carrying a non-Ed25519 multicodec is refused", () => {
    const secp = `did:key:z${base58btcEncode(Uint8Array.from([0xe7, 0x01, ...new Array<number>(33).fill(1)]))}`;
    expect(ed25519PublicKeyBytesFromDidKey(secp)).toBeUndefined();
  });

  test("an over-long identifier is refused before it is decoded, not after", () => {
    // base58 decoding is quadratic in its input, and a binding document is something a PUBLISHER
    // hands a reader. Without a length bound a one-megabyte `did:key` spends minutes of the
    // reader's CPU before the decoded length check would have rejected it anyway. 34 bytes never
    // spell more than 47 base58 characters, so anything longer cannot be one of these keys.
    const started = Date.now();
    expect(ed25519PublicKeyBytesFromDidKey(`did:key:z${"z".repeat(200_000)}`)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("proof derivation (issue #2983)", () => {
  test("the record to look up is derived from the binding, never asserted by it", () => {
    const keyId = "did:key:zABC";
    expect(domainBindingProof("example.com", keyId, "dns-txt")).toEqual({
      mechanism: "dns-txt",
      location: "_colophon.example.com",
      expectedValue: `colophon-domain-binding=1; key=${keyId}`,
    });
    expect(domainBindingProof("example.com", keyId, "well-known-url")).toEqual({
      mechanism: "well-known-url",
      location: "https://example.com/.well-known/colophon-domain-binding.txt",
      expectedValue: `colophon-domain-binding=1; key=${keyId}`,
    });
  });

  test("both mechanisms publish the identical line, so moving between them republishes the same bytes", () => {
    const dns = domainBindingProof("example.com", "did:key:zABC", "dns-txt");
    const url = domainBindingProof("example.com", "did:key:zABC", "well-known-url");
    expect(dns.expectedValue).toBe(url.expectedValue);
  });
});

describe("verifyDomainBinding (issue #2983)", () => {
  test("accepts a well-formed binding for a key that signed the bundle", () => {
    const { keyId, bytes } = mintBinding();
    expect(verifyDomainBinding(bytes, [keyId])).toEqual({
      format: DOMAIN_BINDING_FORMAT,
      domain: "example.com",
      keyId,
      mechanism: "dns-txt",
      statedAt: "2026-09-02T00:00:00.000Z",
      proof: domainBindingProof("example.com", keyId, "dns-txt"),
      // Naming what was established, so no surface can render this while implying the domain was
      // reached. Confirming it needs a lookup this function does not and cannot make.
      confirmation: "key-signature-only",
    });
  });

  test("refuses a binding whose key did not sign this bundle", () => {
    const { bytes } = mintBinding();
    expect(() => verifyDomainBinding(bytes, ["did:key:zSomeoneElse"]))
      .toThrow(/did not sign this bundle/);
  });

  test("refuses a signature made by a different key than the one the binding names", () => {
    const other = generateKeyPairSync("ed25519").privateKey;
    const { keyId, bytes } = mintBinding({ signWith: other });
    const error = (() => {
      try {
        verifyDomainBinding(bytes, [keyId]);
        return undefined;
      } catch (cause) {
        return cause as BenchmarkProductError;
      }
    })();
    expect(error).toBeInstanceOf(BenchmarkProductError);
    expect(error!.code).toBe("record-integrity");
  });

  test("refuses a domain edited after signing", () => {
    const { keyId, bytes } = mintBinding();
    const document = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    const tampered = canonicalJsonBytes({ ...document, domain: "attacker.example" });
    expect(() => verifyDomainBinding(tampered, [keyId])).toThrow(/signature does not verify/);
  });

  test("refuses malformed input rather than falling back to the bare fingerprint", () => {
    expect(() => verifyDomainBinding(new TextEncoder().encode("{"), [])).toThrow(/valid UTF-8 JSON/);
    expect(() => verifyDomainBinding(canonicalJsonBytes({ format: "other/1" }), [])).toThrow(
      new RegExp(DOMAIN_BINDING_FORMAT),
    );
  });

  test("refuses a domain spelled in any way but the single accepted one", () => {
    // Minted validly, then respelled: the schema would refuse these at mint time, and this asserts
    // the reader refuses them too rather than rendering "published by Example.com".
    const { keyId, bytes } = mintBinding();
    const raw = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    for (const domain of ["Example.com", "example.com.", "https://example.com", "example", "*.example.com", "example.com:443"]) {
      expect(() => verifyDomainBinding(canonicalJsonBytes({ ...raw, domain }), [keyId]))
        .toThrow(new RegExp(DOMAIN_BINDING_FORMAT));
    }
  });
});

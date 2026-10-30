// SPDX-License-Identifier: Apache-2.0

import { createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  TRUST_KEY_BINDING_FORMAT,
  dssePreAuthEncoding,
  recordDigest,
  sealDsseEnvelope,
  sealKeyBinding,
  sealTrustPolicy,
  verifyEnvelopeBinding,
  verifyPolicyChain,
} from "@jinn-network/trust-core";
import type {
  BindingResolver,
  DsseProducedSignature,
  DsseSigner,
  KeyBinding,
  TrustPolicy,
  WitnessVerifier,
} from "@jinn-network/trust-core";

import { didKeyFromEd25519PublicKey } from "./did-key.js";
import { createDidKeyDsseVerifier, verifyDsseSignatures, verifyEd25519Signature } from "./dsse.js";

const PAYLOAD_TYPE = "application/vnd.in-toto+json";
const PAYLOAD = new TextEncoder().encode('{"statement":"checked"}');
const PRE_AUTH = dssePreAuthEncoding(PAYLOAD_TYPE, PAYLOAD);

interface Signer {
  readonly keyId: string;
  readonly publicKey: KeyObject;
  readonly privateKey: KeyObject;
}

function ed25519Signer(): Signer {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { keyId: didKeyFromEd25519PublicKey(publicKey), publicKey, privateKey };
}

function p256Signer(keyId: string): Signer {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { keyId, publicKey, privateKey };
}

const signer = ed25519Signer();
const stranger = ed25519Signer();

function signatureBy(by: Signer, keyid: string | null = by.keyId): DsseProducedSignature {
  return {
    signature: new Uint8Array(sign(null, PRE_AUTH, by.privateKey)),
    ...(keyid === null ? {} : { keyid }),
  };
}

function sealed(...signatures: [DsseProducedSignature, ...DsseProducedSignature[]]): Uint8Array {
  return sealDsseEnvelope({ payloadType: PAYLOAD_TYPE, payloadBytes: PAYLOAD, signatures });
}

function respelled(envelope: Uint8Array): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(JSON.parse(new TextDecoder().decode(envelope)), null, 2));
}

/** A signature whose base64 holds both `+` and `/`, so its URL-safe spelling differs. */
function signatureWithBothSpecialCharacters(): { readonly payload: Uint8Array; readonly sig: string } {
  for (let round = 0; ; round += 1) {
    const payload = new TextEncoder().encode(`{"round":${round}}`);
    const sig = sign(null, dssePreAuthEncoding(PAYLOAD_TYPE, payload), signer.privateKey).toString("base64");
    if (sig.includes("+") && sig.includes("/")) return { payload, sig };
  }
}

function spelled(payload: string, sig: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    payload,
    payloadType: PAYLOAD_TYPE,
    signatures: [{ keyid: signer.keyId, sig }],
  }));
}

function flipped({ signature, ...rest }: DsseProducedSignature): DsseProducedSignature {
  const copy = signature.slice();
  copy[0] = copy[0]! ^ 0x01;
  return { signature: copy, ...rest };
}

describe("verifyEd25519Signature", () => {
  // RFC 8032 section 7.1, TEST 1 to 3: public key, message, signature.
  const RFC_8032 = [
    [
      "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
      "",
      "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155"
        + "5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
    ],
    [
      "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
      "72",
      "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da"
        + "085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00",
    ],
    [
      "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025",
      "af82",
      "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac"
        + "18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a",
    ],
  ] as const;

  const spkiOf = (rawHex: string) => Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    Buffer.from(rawHex, "hex"),
  ]);

  test.each(RFC_8032)("verifies the RFC 8032 vector for %s", (rawKey, message, signature) => {
    const messageBytes = Buffer.from(message, "hex");
    const signatureBytes = Buffer.from(signature, "hex");
    const spki = spkiOf(rawKey);
    expect(verifyEd25519Signature(spki, messageBytes, signatureBytes)).toBe(true);
    expect(verifyEd25519Signature(createPublicKey({ key: spki, format: "der", type: "spki" }), messageBytes, signatureBytes)).toBe(true);
    expect(verifyEd25519Signature(spki, Buffer.from("01", "hex"), signatureBytes)).toBe(false);
  });

  test("refuses a key that is not Ed25519, even with a signature that key verifies", () => {
    const p256 = p256Signer("unused");
    const signature = sign(null, PRE_AUTH, p256.privateKey);
    expect(verifyEd25519Signature(p256.publicKey, PRE_AUTH, signature)).toBe(false);
    expect(verifyEd25519Signature(p256.publicKey.export({ format: "der", type: "spki" }), PRE_AUTH, signature)).toBe(false);
  });

  test("answers false for bytes that are not a key", () => {
    expect(verifyEd25519Signature(new Uint8Array(3), PRE_AUTH, new Uint8Array(64))).toBe(false);
  });
});

describe("verifyDsseSignatures", () => {
  test("reports the key that signed an exactly sealed envelope", () => {
    expect(verifyDsseSignatures(sealed(signatureBy(signer)), [signer]).validSignerKeyids).toEqual([signer.keyId]);
  });

  test.each([
    ["a flipped signature", () => sealed(flipped(signatureBy(signer)))],
    ["another key signing under this key id", () => sealed(signatureBy(stranger, signer.keyId))],
    ["this key signing under another key id", () => sealed(signatureBy(signer, stranger.keyId))],
    ["a signature with no key id", () => sealed(signatureBy(signer, null))],
    ["bytes that are not an envelope", () => new TextEncoder().encode("not an envelope")],
    ["no bytes", () => new Uint8Array(0)],
  ])("reports nobody for %s", (_name, envelope) => {
    expect(verifyDsseSignatures(envelope(), [signer])).toEqual({ validSignerKeyids: [] });
    expect(verifyDsseSignatures(envelope(), [signer], {
      allowNonEd25519Keys: true,
      allowRespelledEnvelope: true,
      keepRepeatedSigners: true,
    })).toEqual({ validSignerKeyids: [] });
  });

  test("a stranger's signature does not hide a valid one", () => {
    expect(verifyDsseSignatures(sealed(signatureBy(stranger), signatureBy(signer)), [signer]).validSignerKeyids)
      .toEqual([signer.keyId]);
  });

  test("reports every listed signer, in envelope order", () => {
    expect(verifyDsseSignatures(sealed(signatureBy(stranger), signatureBy(signer)), [signer, stranger]).validSignerKeyids)
      .toEqual([stranger.keyId, signer.keyId]);
  });

  test("tries each key listed under a key id", () => {
    const rotated = { keyId: signer.keyId, publicKey: stranger.publicKey };
    for (const keys of [[rotated, signer], [signer, rotated]]) {
      expect(verifyDsseSignatures(sealed(signatureBy(signer)), keys).validSignerKeyids).toEqual([signer.keyId]);
    }
  });

  describe("allowRespelledEnvelope", () => {
    const envelope = respelled(sealed(signatureBy(signer)));

    test("is off by default: a respelled envelope is refused", () => {
      expect(verifyDsseSignatures(envelope, [signer]).validSignerKeyids).toEqual([]);
    });

    test("accepts the respelling when asked by name", () => {
      expect(verifyDsseSignatures(envelope, [signer], { allowRespelledEnvelope: true }).validSignerKeyids)
        .toEqual([signer.keyId]);
    });

    test("does not excuse a bad signature", () => {
      const tampered = respelled(sealed(flipped(signatureBy(signer))));
      expect(verifyDsseSignatures(tampered, [signer], { allowRespelledEnvelope: true }).validSignerKeyids).toEqual([]);
    });

    function expectReadOnlyWhenAsked(bytes: Uint8Array): void {
      expect(verifyDsseSignatures(bytes, [signer], { allowRespelledEnvelope: true }).validSignerKeyids)
        .toEqual([signer.keyId]);
      expect(verifyDsseSignatures(bytes, [signer]).validSignerKeyids).toEqual([]);
    }

    // Every case the option's documentation lists. Both lenient checks in the benchmark checker
    // accept these today, so tightening the reader would break them without another test noticing.
    test.each([
      ["a URL-safe sig", (sig: string) => sig.replaceAll("+", "-").replaceAll("/", "_")],
      ["an unpadded sig", (sig: string) => sig.replace(/=+$/u, "")],
      ["a URL-safe unpadded sig", (sig: string) => sig.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")],
      // Sixty-four bytes leave four unused bits in the last digit, so the next digit is the same bytes.
      ["a non-canonical sig", (sig: string) => {
        const digits = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        return `${sig.slice(0, -3)}${digits[digits.indexOf(sig.at(-3)!) + 1]}==`;
      }],
    ])("reads %s only when asked by name", (_name, spell) => {
      const signature = signatureWithBothSpecialCharacters();
      expectReadOnlyWhenAsked(spelled(Buffer.from(signature.payload).toString("base64"), spell(signature.sig)));
    });

    // The bytes 0xfb 0xff, whose exact spelling is `+/8=`.
    test.each([
      ["a URL-safe payload", "-_8="],
      ["an unpadded payload", "+/8"],
      ["a non-canonical payload", "+/9="],
    ])("reads %s only when asked by name", (_name, payload) => {
      const preAuth = dssePreAuthEncoding(PAYLOAD_TYPE, Uint8Array.of(0xfb, 0xff));
      expectReadOnlyWhenAsked(spelled(payload, sign(null, preAuth, signer.privateKey).toString("base64")));
    });

    test.each([
      ["surrounding whitespace", (exact: string) => ` ${exact}\n`],
      ["another member order", (exact: string) => JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(exact)).reverse()))],
      ["a byte order mark", (exact: string) => `\ufeff${exact}`],
      ["an unknown envelope member", (exact: string) => exact.replace('{"payload"', '{"note":"added","payload"')],
      ["an unknown signature member", (exact: string) => exact.replace('"sig"', '"note":"added","sig"')],
      ["a repeated member", (exact: string) => exact.replace('{"payload"', '{"payload":"AAAA","payload"')],
    ])("reads %s only when asked by name", (_name, spell) => {
      const exact = new TextDecoder().decode(sealed(signatureBy(signer)));
      expectReadOnlyWhenAsked(new TextEncoder().encode(spell(exact)));
    });
  });

  describe("allowNonEd25519Keys", () => {
    const p256 = p256Signer(signer.keyId);
    const envelope = sealed(signatureBy(p256));

    test("is off by default: a key that is not Ed25519 verifies nothing", () => {
      expect(verifyDsseSignatures(envelope, [p256]).validSignerKeyids).toEqual([]);
    });

    test("verifies under the key's own algorithm when asked by name", () => {
      expect(verifyDsseSignatures(envelope, [p256], { allowNonEd25519Keys: true }).validSignerKeyids)
        .toEqual([signer.keyId]);
    });

    test("does not excuse a signature under another key type", () => {
      const ed25519Signed = sealed(signatureBy(signer));
      expect(verifyDsseSignatures(ed25519Signed, [p256], { allowNonEd25519Keys: true }).validSignerKeyids).toEqual([]);
    });

    test("answers nobody for a key type that cannot verify at all", () => {
      const { publicKey } = generateKeyPairSync("x25519");
      const x25519 = { keyId: signer.keyId, publicKey };
      expect(verifyDsseSignatures(envelope, [x25519], { allowNonEd25519Keys: true }).validSignerKeyids).toEqual([]);
    });
  });

  describe("keepRepeatedSigners", () => {
    const envelope = sealed(signatureBy(signer), signatureBy(signer));

    test("is off by default: a key that signs twice is one signer", () => {
      expect(verifyDsseSignatures(envelope, [signer]).validSignerKeyids).toEqual([signer.keyId]);
    });

    test("reports each signature when asked by name", () => {
      expect(verifyDsseSignatures(envelope, [signer], { keepRepeatedSigners: true }).validSignerKeyids)
        .toEqual([signer.keyId, signer.keyId]);
    });
  });

  describe("requireSingleSignature", () => {
    test("accepts one signature", () => {
      expect(verifyDsseSignatures(sealed(signatureBy(signer)), [signer], { requireSingleSignature: true }).validSignerKeyids)
        .toEqual([signer.keyId]);
    });

    test("refuses a second signature even when both verify", () => {
      const envelope = sealed(signatureBy(signer), signatureBy(stranger));
      expect(verifyDsseSignatures(envelope, [signer, stranger], { requireSingleSignature: true }).validSignerKeyids)
        .toEqual([]);
    });
  });
});

describe("createDidKeyDsseVerifier", () => {
  const verifier = createDidKeyDsseVerifier();

  test("reads each signer's key out of its did:key", () => {
    expect(verifier(sealed(signatureBy(signer), signatureBy(stranger))).validSignerKeyids)
      .toEqual([signer.keyId, stranger.keyId]);
  });

  test.each([
    ["a flipped signature", () => sealed(flipped(signatureBy(signer)))],
    ["another key signing under this did:key", () => sealed(signatureBy(stranger, signer.keyId))],
    ["a did:pkh key id", () => sealed(signatureBy(signer, "did:pkh:eip155:8453:0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"))],
    ["a secp256k1 did:key", () => sealed(signatureBy(signer, "did:key:zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme"))],
    ["a signature with no key id", () => sealed(signatureBy(signer, null))],
    ["a respelled envelope", () => respelled(sealed(signatureBy(signer)))],
    ["bytes that are not an envelope", () => new TextEncoder().encode("not an envelope")],
  ])("reports nobody for %s", (_name, envelope) => {
    expect(verifier(envelope())).toEqual({ validSignerKeyids: [] });
  });

  test("a key that signs twice is one signer", () => {
    expect(verifier(sealed(signatureBy(signer), signatureBy(signer))).validSignerKeyids).toEqual([signer.keyId]);
  });

  test("reports what node:crypto reports, so a small-order key verifies any message", () => {
    // The identity point as the key, signing with R the identity point and S zero.
    const keyid = "did:key:z6MkeXATEjyXENzBXBxgC5EHk2JE5aqd7qMGGtDpLUH1e2Sj";
    const signature = Uint8Array.from([1, ...new Array<number>(63).fill(0)]);
    expect(verifier(sealed({ signature, keyid })).validSignerKeyids).toEqual([keyid]);
  });

  describe("as trust-core's verifier port", () => {
    const AGENT = "urn:uuid:11111111-1111-4111-8111-111111111111";
    const VOUCHER = { kind: "account", did: "did:pkh:eip155:8453:0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", contractAccount: false } as const;

    function signerFor(...signers: readonly Signer[]): DsseSigner {
      return async ({ preAuthEncoding }) => signers.map((by) => ({
        signature: new Uint8Array(sign(null, preAuthEncoding, by.privateKey)),
        keyid: by.keyId,
      })) as [DsseProducedSignature, ...DsseProducedSignature[]];
    }

    const binding: KeyBinding = {
      protocol: TRUST_KEY_BINDING_FORMAT,
      agent: AGENT,
      key: { publicKey: "0x04", keyid: signer.keyId, algorithm: "ed25519", didKey: signer.keyId },
      voucher: VOUCHER,
      relationship: "controls",
      scope: ["deliveries"],
      validFrom: "2026-01-01T00:00:00Z",
      ceremony: { type: "oidc-machine", digest: `sha256:${"a".repeat(64)}` },
      strength: "strong",
      anchors: [],
    };

    const witnessVerifier: WitnessVerifier = { verify1271Witness: async () => ({ verified: true }) };

    async function bindingDeps() {
      const { envelopeBytes, recordDigest: bindingDigest } = await sealKeyBinding(binding, signerFor(signer));
      const bindingResolver: BindingResolver = {
        resolveBinding: async () => ({
          binding,
          envelopeBytes,
          bindingDigest,
          effectiveStart: binding.validFrom,
          isGenesis: true,
          revocations: [],
        }),
      };
      return { bindingResolver, witnessVerifier, dsseVerifier: verifier, applyPolicy: false };
    }

    const claim = (envelopeBytes: Uint8Array) => ({
      envelopeBytes,
      key: signer.keyId,
      agent: AGENT,
      family: "deliveries",
      atTime: "2026-06-01T00:00:00Z",
    });

    test("verifyEnvelopeBinding passes on a real signature", async () => {
      await expect(verifyEnvelopeBinding(claim(sealed(signatureBy(signer))), await bindingDeps()))
        .resolves.toMatchObject({ ok: true });
    });

    test("verifyEnvelopeBinding refuses a forged one at step 1", async () => {
      await expect(verifyEnvelopeBinding(claim(sealed(signatureBy(stranger, signer.keyId))), await bindingDeps()))
        .resolves.toMatchObject({ ok: false, reason: "envelope-signature-invalid" });
    });

    const policy = (keys: readonly string[], threshold: number): TrustPolicy => ({
      protocol: "https://spec.jinn.network/trust/policy/v1",
      version: 1,
      purposes: {
        "verifier-agent": { accepted: [AGENT], requiredStrength: "strong" },
      },
      signerSet: { keys: [...keys], threshold },
      refreshBy: "2026-08-28T00:00:00Z",
    });

    const twoOfTwo = policy([signer.keyId, stranger.keyId], 2);
    const chainOptions = (envelopeBytes: Uint8Array) => ({
      genesisAnchor: { digest: recordDigest(envelopeBytes) },
      now: "2026-07-28T00:00:00Z",
      dsseVerifier: verifier,
    });

    test("verifyPolicyChain meets a threshold with two real signers", async () => {
      const { envelopeBytes } = await sealTrustPolicy(twoOfTwo, signerFor(signer, stranger));
      expect(verifyPolicyChain([envelopeBytes], chainOptions(envelopeBytes))).toMatchObject({ ok: true });
    });

    test("verifyPolicyChain does not count one signer twice", async () => {
      const { envelopeBytes } = await sealTrustPolicy(twoOfTwo, signerFor(signer, signer));
      expect(verifyPolicyChain([envelopeBytes], chainOptions(envelopeBytes)))
        .toMatchObject({ ok: false, reason: "threshold-not-met" });
    });
  });
});

describe("the settings each inline signature check in the benchmark checker maps to", () => {
  const p256 = p256Signer(signer.keyId);

  // Exact envelope, one signature, Ed25519 keys already enforced by the caller: the defaults
  // plus requireSingleSignature.
  test("admission reviewer and authority", () => {
    const options = { requireSingleSignature: true };
    expect(verifyDsseSignatures(sealed(signatureBy(signer)), [signer], options).validSignerKeyids).toEqual([signer.keyId]);
    expect(verifyDsseSignatures(respelled(sealed(signatureBy(signer))), [signer], options).validSignerKeyids).toEqual([]);
    expect(verifyDsseSignatures(sealed(signatureBy(signer), signatureBy(stranger)), [signer], options).validSignerKeyids).toEqual([]);
  });

  test("report envelope", () => {
    const options = { allowRespelledEnvelope: true, allowNonEd25519Keys: true, keepRepeatedSigners: true };
    expect(verifyDsseSignatures(respelled(sealed(signatureBy(signer))), [signer], options).validSignerKeyids).toEqual([signer.keyId]);
    expect(verifyDsseSignatures(sealed(signatureBy(p256)), [p256], options).validSignerKeyids).toEqual([signer.keyId]);
    expect(verifyDsseSignatures(sealed(signatureBy(signer), signatureBy(signer)), [signer], options).validSignerKeyids)
      .toEqual([signer.keyId, signer.keyId]);
    expect(verifyDsseSignatures(sealed(signatureBy(stranger), signatureBy(signer)), [signer], options).validSignerKeyids)
      .toEqual([signer.keyId]);
  });

  test("evaluator claim", () => {
    const options = { allowRespelledEnvelope: true, allowNonEd25519Keys: true };
    expect(verifyDsseSignatures(respelled(sealed(signatureBy(signer))), [signer], options).validSignerKeyids).toEqual([signer.keyId]);
    expect(verifyDsseSignatures(sealed(signatureBy(p256)), [p256], options).validSignerKeyids).toEqual([signer.keyId]);
  });

  test("evidence-native signature, which has bytes and no envelope", () => {
    const signature = sign(null, PRE_AUTH, signer.privateKey);
    const spki = signer.publicKey.export({ format: "der", type: "spki" });
    expect(verifyEd25519Signature(spki, PRE_AUTH, signature)).toBe(true);
    expect(verifyEd25519Signature(p256.publicKey.export({ format: "der", type: "spki" }), PRE_AUTH, sign(null, PRE_AUTH, p256.privateKey))).toBe(false);
  });
});

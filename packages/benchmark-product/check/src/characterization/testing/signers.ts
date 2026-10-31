// SPDX-License-Identifier: Apache-2.0

/**
 * Keys and DSSE signatures for the characterization suite. Ed25519 signing is deterministic, so a
 * key derived from a label yields the same bytes on every run and host, and nothing the suite
 * builds needs normalizing away.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { dssePreAuthEncoding, sealDsseEnvelope } from "@jinn-network/trust-core";

/** The fixed PKCS#8 wrapper around a raw 32-byte Ed25519 seed. */
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** Fixed public keys of other algorithms, for the checks that must refuse them. */
export const FOREIGN_SPKI_BASE64 = {
  p256: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEe8BoBgDJlwJACqlxIOfokiOJWQhj9if5JA9GaXkSdlwk96hoARf8moTZdDrNE2t3ZBF+2fnqowKJGF1HVoJ6ig==",
  p384: "MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAEvFDhsERYMNQU9SPZRKPTXDIumj8ZogV8Cs5N3RNwrOwDtKm5xsWoQKwpDPMT4AD/5NhySKsTdKP8Vd2ZQh98/4O0rreSOWWWWiRvnBcfThikYVDnPtQq0q4Vp6civmeD",
  rsa: "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDw6oRbK2ALVCl0jwFFPUSpCj2/ahLBCe44Sx71QUhI7w8/wA+zl3CGoo6W6CObjZDis8n2ozVw5c7a9Mkd/eEiyjGZT3fRcI+p5UDLu5mhtLXwVY7qni1tjdIOevizF9kqMhhGOZ2yBzhFBIdy4y/tEN4ETfndcD6C7GakbY5zxwIDAQAB",
} as const;

export interface PinnedSigner {
  readonly keyId: string;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly spkiDerBase64: string;
}

export interface DsseSignature {
  readonly keyid: string;
  readonly signature: Uint8Array;
}

/** Decides the signatures an envelope carries over its pre-authentication encoding. */
export type DsseSignatures = (preAuthEncoding: Uint8Array) => readonly DsseSignature[];

function pinnedSigner(keyId: string, privateKey: KeyObject): PinnedSigner {
  const publicKey = createPublicKey(privateKey);
  return {
    keyId,
    privateKey,
    publicKey,
    spkiDerBase64: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

export function signerFromLabel(label: string, keyId: string = `urn:key:${label}`): PinnedSigner {
  const seed = createHash("sha256").update(`checker-characterization:${label}`).digest();
  return pinnedSigner(keyId, createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  }));
}

/** The conformance kit's own test-only report key, the one the golden Report is signed with. */
export function kitReportSigner(): PinnedSigner {
  const keyPath = new URL(
    "../../../fixtures/public-bundle-conformance-v1/keys/report-signing-key.pem",
    import.meta.url,
  );
  const { keyId } = JSON.parse(readFileSync(new URL("report-signing-key.json", keyPath), "utf8")) as {
    readonly keyId: string;
  };
  return pinnedSigner(keyId, createPrivateKey(readFileSync(keyPath)));
}

export function signedBy(signer: PinnedSigner, keyid: string = signer.keyId): DsseSignatures {
  return (preAuthEncoding) => [{
    keyid,
    signature: new Uint8Array(sign(null, preAuthEncoding, signer.privateKey)),
  }];
}

/**
 * A P-256 key with a signature that really verifies under it, for the sites that must tell a wrong
 * algorithm from a bad signature. ECDSA is randomized and the key is fresh, so no pinned value may
 * depend on either; every case that uses one pins a refusal or a key id.
 */
export function p256SignerUnderKeyId(keyId: string): {
  readonly spkiDer: Uint8Array;
  readonly publicKey: KeyObject;
  readonly signatures: DsseSignatures;
} {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    spkiDer: new Uint8Array(publicKey.export({ format: "der", type: "spki" })),
    publicKey,
    signatures: (preAuthEncoding) => [{
      keyid: keyId,
      signature: new Uint8Array(sign(null, preAuthEncoding, privateKey)),
    }],
  };
}

/** The right bytes and key, with one signature bit changed. */
export function flipped(signatures: DsseSignatures): DsseSignatures {
  return (preAuthEncoding) => signatures(preAuthEncoding).map(({ keyid, signature }) => ({
    keyid,
    signature: signature.map((byte, index) => (index === 0 ? byte ^ 0x01 : byte)),
  }));
}

export function sealSigned(
  payloadType: string,
  payloadBytes: Uint8Array,
  signatures: DsseSignatures,
): Uint8Array {
  const [first, ...rest] = signatures(dssePreAuthEncoding(payloadType, payloadBytes));
  if (first === undefined) throw new Error("a DSSE envelope needs at least one signature");
  return sealDsseEnvelope({ payloadType, payloadBytes, signatures: [first, ...rest] });
}

/** Several signature decisions over one envelope, in order. */
export function allOf(...decisions: readonly DsseSignatures[]): DsseSignatures {
  return (preAuthEncoding) => decisions.flatMap((decide) => decide(preAuthEncoding));
}

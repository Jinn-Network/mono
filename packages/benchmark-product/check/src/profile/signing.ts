import { createPublicKey, type KeyObject } from "node:crypto";
import { didKeyFromEd25519PublicKey as didKeyOfEd25519Key, verifyDsseSignatures } from "@jinn-network/verify";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Derives the public did:key identifier from an Ed25519 SPKI.
 *
 * `@jinn-network/verify` encodes it and refuses every other key type. This one has always read the
 * JWK `x` member and checked its length instead, so a P-256 key, whose `x` is also 32 bytes, comes
 * back spelled as a did:key, and any other key throws one of these two messages. Its one caller has
 * already held the key to Ed25519, so no bundle reaches that. The characterization suite pins it,
 * so the output stays and the 32 bytes reach the package as an Ed25519 key.
 */
export function didKeyFromEd25519PublicKey(publicKey: KeyObject): string {
  const jwk = publicKey.export({ format: "jwk" }) as { x?: string };
  if (typeof jwk.x !== "string") throw new Error("Ed25519 public key JWK export is missing its x-coordinate");
  const raw = Buffer.from(jwk.x, "base64url");
  if (raw.length !== 32) throw new Error(`Ed25519 public key raw bytes must be 32 bytes, got ${raw.length}`);
  return didKeyOfEd25519Key(createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  }));
}

/** Fail-closed verification of the Report envelope against the bundle-carried author key. */
export function verifyReportEnvelopeSignatures(envelopeBytes: Uint8Array, key: { readonly keyId: string; readonly publicKey: KeyObject }): { validSignerKeyids: readonly string[] } {
  return verifyDsseSignatures(envelopeBytes, [key], {
    allowRespelledEnvelope: true,
    allowNonEd25519Keys: true,
    keepRepeatedSigners: true,
  });
}

import { verify, type KeyObject } from "node:crypto";
import { dssePreAuthEncoding, parseDsseEnvelope } from "@jinn-network/trust-core";

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes: Uint8Array): string {
  let zeros = 0; while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  let value = 0n; for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let out = ""; while (value > 0n) { const remainder = value % 58n; value /= 58n; out = BASE58[Number(remainder)] + out; }
  return "1".repeat(zeros) + out;
}

/** Derives the public did:key identifier from an Ed25519 SPKI. */
export function didKeyFromEd25519PublicKey(publicKey: KeyObject): string {
  const jwk = publicKey.export({ format: "jwk" }) as { x?: string };
  if (typeof jwk.x !== "string") throw new Error("Ed25519 public key JWK export is missing its x-coordinate");
  const raw = Buffer.from(jwk.x, "base64url");
  if (raw.length !== 32) throw new Error(`Ed25519 public key raw bytes must be 32 bytes, got ${raw.length}`);
  return `did:key:z${base58(new Uint8Array([0xed, 0x01, ...raw]))}`;
}

/** Fail-closed verification of the Report envelope against the bundle-carried author key. */
export function verifyReportEnvelopeSignatures(envelopeBytes: Uint8Array, key: { readonly keyId: string; readonly publicKey: KeyObject }): { validSignerKeyids: readonly string[] } {
  try {
    const envelope = parseDsseEnvelope(envelopeBytes);
    const preAuth = Buffer.from(dssePreAuthEncoding(envelope.payloadType, envelope.payloadBytes));
    return { validSignerKeyids: envelope.signatures.flatMap((signature) => {
      try { return signature.keyid === key.keyId && verify(null, preAuth, key.publicKey, Buffer.from(signature.sig, "base64")) ? [key.keyId] : []; } catch { return []; }
    }) };
  } catch { return { validSignerKeyids: [] }; }
}

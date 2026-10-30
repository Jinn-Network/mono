// SPDX-License-Identifier: Apache-2.0

import { KeyObject, createPublicKey, verify } from "node:crypto";
import { dssePreAuthEncoding, parseDsseEnvelope, parseExactDsseEnvelope } from "@jinn-network/trust-core";
import type {
  DsseChainVerificationResult,
  DsseChainVerifier,
  ParsedDsseEnvelope,
} from "@jinn-network/trust-core";

import { ed25519PublicKeyFromDidKey } from "./did-key.js";

export interface DsseVerificationKey {
  /** Compared exactly against each signature's `keyid`. */
  readonly keyId: string;
  readonly publicKey: KeyObject;
}

/** Every option defaults to the strict behavior. */
export interface VerifyDsseSignaturesOptions {
  /**
   * Accept any JSON spelling of the envelope that `parseDsseEnvelope` can read, not only the exact
   * bytes `sealDsseEnvelope` writes. Two spellings of one envelope are two record digests, so this
   * is for callers holding envelopes that were never sealed by that encoder.
   */
  readonly allowRespelledEnvelope?: boolean;
  /**
   * Verify under whatever key type is supplied. `node:crypto` then chooses the digest from the key,
   * so a signature can pass under an algorithm the caller never named.
   */
  readonly allowNonEd25519Keys?: boolean;
  /**
   * Report a key once per signature it made. Off by default because a caller counting signers
   * against a threshold must not count one key twice.
   */
  readonly keepRepeatedSigners?: boolean;
  /**
   * Refuse an envelope carrying more than one signature. Off by default because a record may have
   * several legitimate signers: a trust policy's threshold depends on it.
   */
  readonly requireSingleSignature?: boolean;
}

function verifiesUnder(
  publicKey: KeyObject,
  message: Uint8Array,
  signature: Uint8Array,
  allowNonEd25519Keys: boolean,
): boolean {
  try {
    return (allowNonEd25519Keys || publicKey.asymmetricKeyType === "ed25519")
      && verify(null, message, publicKey, signature);
  } catch {
    return false;
  }
}

/** One Ed25519 signature over bytes the caller already holds. `publicKey` may be SPKI DER. */
export function verifyEd25519Signature(
  publicKey: KeyObject | Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  try {
    const key = publicKey instanceof KeyObject
      ? publicKey
      : createPublicKey({ key: Buffer.from(publicKey), format: "der", type: "spki" });
    return verifiesUnder(key, message, signature, false);
  } catch {
    return false;
  }
}

function readEnvelope(envelopeBytes: Uint8Array, allowRespelled: boolean): ParsedDsseEnvelope | undefined {
  try {
    return allowRespelled ? parseDsseEnvelope(envelopeBytes) : parseExactDsseEnvelope(envelopeBytes);
  } catch {
    return undefined;
  }
}

function validSigners(
  envelope: ParsedDsseEnvelope,
  keys: readonly DsseVerificationKey[],
  options: VerifyDsseSignaturesOptions,
): readonly string[] {
  if (options.requireSingleSignature === true && envelope.signatures.length !== 1) return [];
  const preAuthEncoding = dssePreAuthEncoding(envelope.payloadType, envelope.payloadBytes);
  const signers = envelope.signatures.flatMap(({ keyid, sig }) => {
    const signature = Buffer.from(sig, "base64");
    const verified = keys.some(({ keyId, publicKey }) =>
      keyId === keyid && verifiesUnder(publicKey, preAuthEncoding, signature, options.allowNonEd25519Keys === true));
    return verified ? [keyid!] : [];
  });
  return options.keepRepeatedSigners === true ? signers : [...new Set(signers)];
}

/**
 * Which of `keys` signed a sealed DSSE envelope. A signature counts when its `keyid` names one of
 * `keys` and it verifies over the pre-authentication encoding of the exact payload bytes. Bytes
 * that are not an acceptable envelope report nobody; this never throws on what a record contains.
 */
export function verifyDsseSignatures(
  envelopeBytes: Uint8Array,
  keys: readonly DsseVerificationKey[],
  options: VerifyDsseSignaturesOptions = {},
): DsseChainVerificationResult {
  const envelope = readEnvelope(envelopeBytes, options.allowRespelledEnvelope === true);
  return { validSignerKeyids: envelope === undefined ? [] : validSigners(envelope, keys, options) };
}

/**
 * The verifier port `trust-core` leaves open (`policy.ts`, `verify.ts`), for signers named by an
 * Ed25519 `did:key`: each signature's key comes out of its own `keyid`, so a valid result says only
 * that the key signed. Whether that key may speak for anyone is the trust record's question.
 * Signatures under any other kind of `keyid` are not reported, whatever their bytes.
 */
export function createDidKeyDsseVerifier(): DsseChainVerifier {
  return (envelopeBytes) => {
    const envelope = readEnvelope(envelopeBytes, false);
    if (envelope === undefined) return { validSignerKeyids: [] };
    const keys = envelope.signatures.flatMap(({ keyid }) => {
      const publicKey = keyid === undefined ? undefined : ed25519PublicKeyFromDidKey(keyid);
      return publicKey === undefined ? [] : [{ keyId: keyid!, publicKey }];
    });
    return { validSignerKeyids: validSigners(envelope, keys, {}) };
  };
}

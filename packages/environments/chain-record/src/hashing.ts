import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import { InvalidDocumentError } from "./sealing.js";

const PREFIXED_SHA256 = /^sha256:[0-9a-f]{64}$/;
const BARE_SHA256 = /^[0-9a-f]{64}$/;

export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

/**
 * The identity of any sealed record in this package: sha256 over the exact sealed bytes,
 * written with the `sha256:` prefix every digest in a record *body* carries (§4.1).
 */
export function sealedRecordDigest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${sha256Hex(bytes)}`;
}

/** The chain-environment record's identity (program §3 pinned name). */
export function chainEnvironmentRecordDigest(bytes: Uint8Array): `sha256:${string}` {
  return sealedRecordDigest(bytes);
}

/** The composite crypto-environment record's identity (program §3 pinned name). */
export function cryptoEnvironmentRecordDigest(bytes: Uint8Array): `sha256:${string}` {
  return sealedRecordDigest(bytes);
}

/**
 * The same digest as an in-toto DigestSet value: **bare lowercase hex, no prefix** (§5.3).
 * A prefixed value inside a DigestSet is non-conformant, and this is the one conversion
 * point — attestation subject builders call this rather than slicing strings by hand.
 */
export function bareHexDigest(digest: `sha256:${string}`): string {
  if (!PREFIXED_SHA256.test(digest)) {
    throw new InvalidDocumentError([{
      path: "",
      message: "expected a sha256:-prefixed lowercase-hex digest",
    }]);
  }
  return digest.slice("sha256:".length);
}

/**
 * The inverse conversion: a bare DigestSet value lifted into the record-body spelling. Needed
 * because in-toto ResourceDescriptors carry bare hex while every scalar digest field in a
 * record body carries the prefix; the facts leaf and the composite both cross that seam. It
 * refuses an already-prefixed input rather than double-prefixing, which is the failure this
 * pair exists to make impossible in both directions.
 */
export function prefixedDigest(bare: string): `sha256:${string}` {
  if (!BARE_SHA256.test(bare)) {
    throw new InvalidDocumentError([{
      path: "",
      message: "expected 64 lowercase hexadecimal digits with no algorithm prefix",
    }]);
  }
  return `sha256:${bare}`;
}

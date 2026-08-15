import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import { InvalidDocumentError } from "./sealing.js";

const PREFIXED_SHA256 = /^sha256:[0-9a-f]{64}$/;

export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

/**
 * The record's identity: sha256 over the exact sealed bytes, written with the `sha256:`
 * prefix every digest in a record *body* carries (design §4.1). An information world's
 * identity is its bytes and nothing else — the corpus it names, the policy it declares, and
 * the miss response it commits are all inside those bytes.
 */
export function informationWorldRecordDigest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${sha256Hex(bytes)}`;
}

/**
 * The same digest as an in-toto DigestSet value: **bare lowercase hex, no prefix** (§5.1).
 * A prefixed value inside a DigestSet is non-conformant, and this is the one conversion
 * point — attestation subject builders call this rather than slicing strings by hand. The
 * conformance kit carries the confusion fixture for both directions.
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

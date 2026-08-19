/**
 * Per-profile producer facts (anchor-evidence design §6.1, §6.2) and the one encoder the record
 * needs.
 *
 * `trust-core` owns the anchor-profile URIs, the record schema, and the two proof verifiers. It
 * deliberately does not own two producer-side facts:
 *
 * - **The foreign proof's media type.** The record carries `proof.mediaType`, and its value is a
 *   fact about the standard, not about the record family. §6.1 pins
 *   `application/vnd.etsi.timestamp-token` (the registered standalone-token type;
 *   `application/timestamp-reply` denotes the full `TimeStampResp` and would mislabel a bare token
 *   to exactly the off-the-shelf tooling §5 rule 2 promises interop with), §6.2 pins
 *   `application/vnd.opentimestamps.ots`. Both spellings currently exist in the tree only inside
 *   the conformance kit, which this package may not import from shipped source, so they are
 *   restated here against the spec literals and pinned by test.
 * - **The base64 encoder.** `trust-core` exports `decodeAnchorProofContent` and no inverse. The
 *   encoder below is that decoder's exact inverse — standard alphabet, always padded — because
 *   two spellings of one proof would be two records claiming one anchor.
 */

import { OPENTIMESTAMPS_ANCHOR_PROFILE, RFC3161_TSA_ANCHOR_PROFILE } from "@jinn-network/trust-core";

/** §6.1: the registered standalone-token media type for one DER `TimeStampToken`. */
export const RFC3161_TOKEN_MEDIA_TYPE = "application/vnd.etsi.timestamp-token";
/** §6.2: one detached `.ots` proof. */
export const OPENTIMESTAMPS_PROOF_MEDIA_TYPE = "application/vnd.opentimestamps.ots";

/** The provider profiles this product can *produce* for. A profile absent here is not a profile
 * this product refuses to verify — it is one it cannot acquire. */
export const PRODUCIBLE_ANCHOR_PROFILES = [
  RFC3161_TSA_ANCHOR_PROFILE,
  OPENTIMESTAMPS_ANCHOR_PROFILE,
] as const;

export type ProducibleAnchorProfile = (typeof PRODUCIBLE_ANCHOR_PROFILES)[number];

export function isProducibleAnchorProfile(profile: string): profile is ProducibleAnchorProfile {
  return (PRODUCIBLE_ANCHOR_PROFILES as readonly string[]).includes(profile);
}

/**
 * Profiles whose acquisition has a second step, and therefore the only profiles for which an
 * upgraded form of an earlier record can exist (§6.2). An RFC 3161 token is complete when it is
 * issued — there is no later state for it to reach — so a second `rfc3161-tsa/v1` anchor over one
 * subject is always a re-anchor and never an upgrade.
 *
 * This is what keeps the §7.1 rule 1 write-once exception narrow rather than a general escape
 * hatch, so it is stated once here and read by both the operation and the durable RunState
 * invariant.
 */
export const UPGRADEABLE_ANCHOR_PROFILES = [OPENTIMESTAMPS_ANCHOR_PROFILE] as const;

export function isUpgradeableAnchorProfile(profile: string): boolean {
  return (UPGRADEABLE_ANCHOR_PROFILES as readonly string[]).includes(profile);
}

/** The media type the record labels this profile's carried proof bytes with. */
export function anchorProofMediaType(profile: ProducibleAnchorProfile): string {
  return profile === RFC3161_TSA_ANCHOR_PROFILE
    ? RFC3161_TOKEN_MEDIA_TYPE
    : OPENTIMESTAMPS_PROOF_MEDIA_TYPE;
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Canonical padded standard base64 — the only spelling `decodeAnchorProofContent` admits.
 * Hand-rolled rather than taken from `Buffer`, whose `base64` decoder is lenient enough that a
 * round-trip through it proves nothing about which spellings the record family accepts.
 */
export function encodeAnchorProofContent(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    out += BASE64_ALPHABET[first >> 2]!;
    out += BASE64_ALPHABET[((first & 0x03) << 4) | ((second ?? 0) >> 4)]!;
    out += second === undefined ? "=" : BASE64_ALPHABET[((second & 0x0f) << 2) | ((third ?? 0) >> 6)]!;
    out += third === undefined ? "=" : BASE64_ALPHABET[third & 0x3f]!;
  }
  return out;
}

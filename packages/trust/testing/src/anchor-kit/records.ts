// SPDX-License-Identifier: Apache-2.0

/**
 * AnchorEvidence record builders over kit-built proofs (design §5).
 *
 * Downstream packets need sealed records, not bare proof bytes: the
 * `integrity-anchors` check parses records, recomputes subjects from a bundle
 * snapshot, and only then reaches a proof. These helpers wrap any kit proof in
 * the tier-2 record so those packets never hand-roll one.
 *
 * Two seam rules are pinned program law and are obeyed here without exception:
 *
 * - **`parseExactAnchorEvidence`, never `validateAnchorEvidence`, on any read
 *   path.** Conformance is shape-level and admits pretty-printed or reordered
 *   spellings of the same record; identity is byte-exactness. A helper that
 *   selected an anchor through the laxer door would hand consumers a record
 *   whose digest is not the digest they think it is.
 * - **`decodeAnchorProofContent`, never `dsse.ts`'s envelope decoder.** The DSSE
 *   decoder admits the URL-safe alphabet and unpadded input, so two spellings
 *   would decode to one proof -- two records claiming one anchor.
 *
 * The base64 encoder below is the exact inverse of `decodeAnchorProofContent`:
 * standard alphabet, always padded, so one byte string has one spelling.
 */

import {
  ANCHOR_EVIDENCE_KIND,
  OPENTIMESTAMPS_ANCHOR_PROFILE,
  RFC3161_TSA_ANCHOR_PROFILE,
  decodeAnchorProofContent,
  parseExactAnchorEvidence,
  sealAnchorEvidence,
} from "@jinn-network/trust-core";
import type { AnchorEvidence, SealedAnchorEvidence } from "@jinn-network/trust-core";

/** §6.1: the registered standalone-token media type. `application/timestamp-reply`
 * denotes a full `TimeStampResp` and would mislabel a bare token. */
export const RFC3161_TOKEN_MEDIA_TYPE = "application/vnd.etsi.timestamp-token";
/** §6.2: one detached `.ots` proof. */
export const OPENTIMESTAMPS_PROOF_MEDIA_TYPE = "application/vnd.opentimestamps.ots";

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Canonical padded standard base64 -- the only spelling
 * `decodeAnchorProofContent` admits. */
export function encodeProofContent(bytes: Uint8Array): string {
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

export interface AnchorEvidenceRecordOptions {
  /** The resolved record's actual kind; §8 step 2 requires equality, so a kit
   * caller building a kind-mismatch fixture sets this deliberately. */
  readonly subjectKind: string;
  /** 64 lowercase hex, the §5 DigestSet form. */
  readonly subjectSha256: string;
  readonly provider: string;
  readonly proofMediaType: string;
  readonly proofBytes: Uint8Array;
}

export interface BuiltAnchorEvidenceRecord extends SealedAnchorEvidence {
  readonly record: AnchorEvidence;
}

export function buildAnchorEvidenceRecord(
  options: AnchorEvidenceRecordOptions,
): BuiltAnchorEvidenceRecord {
  const record: AnchorEvidence = {
    kind: ANCHOR_EVIDENCE_KIND,
    subject: { kind: options.subjectKind, digest: { sha256: options.subjectSha256 } },
    provider: options.provider,
    proof: {
      mediaType: options.proofMediaType,
      content: encodeProofContent(options.proofBytes),
    },
  };
  return { ...sealAnchorEvidence(record), record };
}

export interface ProfileAnchorEvidenceRecordOptions {
  readonly subjectKind: string;
  readonly subjectSha256: string;
  readonly proofBytes: Uint8Array;
}

export function buildRfc3161AnchorEvidenceRecord(
  options: ProfileAnchorEvidenceRecordOptions,
): BuiltAnchorEvidenceRecord {
  return buildAnchorEvidenceRecord({
    ...options,
    provider: RFC3161_TSA_ANCHOR_PROFILE,
    proofMediaType: RFC3161_TOKEN_MEDIA_TYPE,
  });
}

export function buildOpenTimestampsAnchorEvidenceRecord(
  options: ProfileAnchorEvidenceRecordOptions,
): BuiltAnchorEvidenceRecord {
  return buildAnchorEvidenceRecord({
    ...options,
    provider: OPENTIMESTAMPS_ANCHOR_PROFILE,
    proofMediaType: OPENTIMESTAMPS_PROOF_MEDIA_TYPE,
  });
}

export interface ReadAnchorEvidenceResult {
  readonly record: AnchorEvidence;
  readonly proofBytes: Uint8Array;
}

/**
 * The kit's only read path: exact-bytes parse, then the sanctioned proof
 * decoder. Throws `TrustCoreError` on anything that is not the exact sealed
 * encoding of a conforming record.
 */
export function readAnchorEvidenceProof(sealedBytes: Uint8Array): ReadAnchorEvidenceResult {
  const record = parseExactAnchorEvidence(sealedBytes);
  return { record, proofBytes: decodeAnchorProofContent(record.proof.content) };
}

// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

import { canonicalJsonBytes } from "./canonical-json.js";
import { TrustCoreError, invalidInput } from "./errors.js";
import { recordDigest } from "./hashing.js";
import { ANCHOR_EVIDENCE_KIND } from "./identifiers.js";
import type { Sha256Digest, ValidationDiagnostic } from "./types.js";

// ---------------------------------------------------------------------------
// AnchorEvidence (pluggable-integrity-providers design §5) -- the tier-2
// record that carries a foreign anchor proof about one sealed-record digest.
//
// Two properties separate this family from every other record in this
// package, and both are load-bearing:
//
//  - **Sealed, not signed** (§5 rule 4). There is no DSSE envelope and no
//    producer signature: the proof inside is the authority's signature, and a
//    producer counter-signature would conflate the record's producer with the
//    anchoring authority. Sealing is `canonicalJsonBytes` once; the record's
//    identity is the SHA-256 of those exact bytes, forever.
//  - **Strict schema** (§8 step 1). Unknown keys fail closed -- the
//    public-bundle closure discipline, deliberately stricter than the protocol
//    layer's unknown-field tolerance. Nothing derivable is stored (§5 rule 3):
//    there is no field for the anchored time, the authority identity, or any
//    status, so the wrapper and the proof cannot disagree (§5 rule 5).
//
// This module owns the record's shape and its structural rules only. Proof
// verification (per provider profile), subject re-computation against a bundle
// snapshot, and the `integrity-anchors` check (§8) live elsewhere; a
// well-formed record never implies a verified anchor.
//
// `ANCHOR_EVIDENCE_MEDIA_TYPE` is the media type this record travels under in
// carriage; because the record is unsigned there is no DSSE `payloadType` to
// bind it to, so nothing in this module consumes it.
// ---------------------------------------------------------------------------

/**
 * §5 rule 2: v1 admits inline proof content only, capped at 64 KiB decoded.
 * A descriptor-referenced overflow form is deliberately not part of v1 -- if
 * a future provider class needs one it arrives with that class's profile
 * version, never as a tolerated extra key here.
 */
export const ANCHOR_PROOF_MAX_DECODED_BYTES = 65_536;

// ---------------------------------------------------------------------------
// Base64: pure, canonical, standard-alphabet only.
//
// trust-core is I/O-free and imports nothing beyond @noble/hashes,
// @noble/curves, and zod, so this is hand-rolled rather than delegated. It is
// stricter than `atob`: only the standard alphabet, only correct padding, and
// only canonical trailing bits, so exactly one base64 spelling exists per byte
// string. That matters for a record whose identity is its exact bytes -- two
// spellings of one proof would otherwise be two different anchors.
// ---------------------------------------------------------------------------

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_STANDARD_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

type ProofContentDecode =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: "not-base64" | "too-large" };

function decodeProofContent(content: string): ProofContentDecode {
  if (content.length === 0 || content.length % 4 !== 0) return { ok: false, reason: "not-base64" };
  if (!BASE64_STANDARD_PATTERN.test(content)) return { ok: false, reason: "not-base64" };

  const padding = content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0;
  const decodedLength = (content.length / 4) * 3 - padding;
  // Size is decided from the encoded length, before any allocation: an
  // over-cap record is refused, never materialized.
  if (decodedLength > ANCHOR_PROOF_MAX_DECODED_BYTES) return { ok: false, reason: "too-large" };

  const bytes = new Uint8Array(decodedLength);
  let offset = 0;
  let accumulator = 0;
  let bits = 0;
  for (let index = 0; index < content.length - padding; index += 1) {
    const sextet = BASE64_ALPHABET.indexOf(content[index]!);
    if (sextet < 0) return { ok: false, reason: "not-base64" };
    accumulator = (accumulator << 6) | sextet;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[offset] = (accumulator >> bits) & 0xff;
      offset += 1;
    }
  }
  // Canonical form: the final symbol's leftover bits must be zero.
  if ((accumulator & ((1 << bits) - 1)) !== 0) return { ok: false, reason: "not-base64" };
  return { ok: true, bytes };
}

// ---------------------------------------------------------------------------
// Schema (§5). Strict at every level.
// ---------------------------------------------------------------------------

/** Same absolute-IRI test `AgentIriSchema` applies (spellings.ts), stated
 * locally so the anchor record's URI fields carry no agent-identity meaning. */
function isAbsoluteUri(value: string): boolean {
  try {
    return new URL(value).protocol.length > 1;
  } catch {
    return false;
  }
}

const AbsoluteUriSchema = z.string().refine(isAbsoluteUri, {
  message: "must be an absolute URI.",
});

/**
 * §5 rule 1: digests travel as `(algorithm, value)` pairs in the in-toto
 * DigestSet shape -- `{ "sha256": "<64 lowercase hex>" }`, not the
 * `sha256:<hex>`-prefixed string used for trust-core's own record digests.
 * `sha256` is the v1 floor and the only admitted algorithm: the strict object
 * is what makes a second algorithm a conformance failure rather than an
 * ignored extra.
 */
export const Sha256DigestSetSchema = z.strictObject({
  sha256: z.string().regex(/^[0-9a-f]{64}$/, "must be 64 lowercase hex digits"),
});
export type Sha256DigestSet = z.infer<typeof Sha256DigestSetSchema>;

/**
 * §5 rule 1: exactly one subject, and it is a sealed-record digest. The
 * cardinality is structural -- a single object, never a list -- so composite,
 * truncated, or derived subjects have nowhere to live. `kind` is normative,
 * not advisory: verification requires it to equal the resolved record's actual
 * kind (§8 step 2).
 */
export const AnchorSubjectSchema = z.strictObject({
  kind: AbsoluteUriSchema,
  digest: Sha256DigestSetSchema,
});
export type AnchorSubject = z.infer<typeof AnchorSubjectSchema>;

/** §5 rule 2: the foreign artifact's exact bytes, base64-encoded and labeled
 * with that standard's own media type -- never parsed and re-emitted. */
export const AnchorProofSchema = z.strictObject({
  mediaType: z.string().min(1),
  content: z.string(),
});
export type AnchorProof = z.infer<typeof AnchorProofSchema>;

export const AnchorEvidenceSchema = z.strictObject({
  kind: z.literal(ANCHOR_EVIDENCE_KIND),
  subject: AnchorSubjectSchema,
  provider: AbsoluteUriSchema,
  proof: AnchorProofSchema,
});
export type AnchorEvidence = z.infer<typeof AnchorEvidenceSchema>;

export interface AnchorEvidenceValidationReport {
  readonly conforms: boolean;
  readonly diagnostics: readonly ValidationDiagnostic[];
  readonly value?: AnchorEvidence;
}

export interface SealedAnchorEvidence {
  /** The exact sealed bytes -- the record, forever. */
  readonly bytes: Uint8Array;
  /** The record's identity: SHA-256 of `bytes`. */
  readonly recordDigest: Sha256Digest;
}

/**
 * The §5 rule-2 content rules that the shape schema cannot express: the proof
 * content is canonical standard base64, and its decoded length is within the
 * v1 inline cap.
 */
function proofContentDiagnostic(content: string): ValidationDiagnostic | undefined {
  const decoded = decodeProofContent(content);
  if (decoded.ok) return undefined;
  return decoded.reason === "too-large"
    ? {
      code: "PROOF_CONTENT_TOO_LARGE",
      path: "proof.content",
      message: `proof content decodes to more than the ${ANCHOR_PROOF_MAX_DECODED_BYTES}-byte v1 inline cap (§5 rule 2).`,
    }
    : {
      code: "PROOF_CONTENT_NOT_BASE64",
      path: "proof.content",
      message: "proof content must be non-empty canonical standard base64 (§5 rule 2).",
    };
}

/**
 * Structurally validates the exact sealed bytes of an anchor-evidence record
 * against the strict §5 schema and the §5 rule-2 proof-content rules. Never
 * throws.
 *
 * Conformance here is shape only. It says nothing about whether the proof
 * verifies, whether the subject digest names a record that exists, or whether
 * `subject.kind` describes it -- those are the `integrity-anchors` check's
 * steps 2 and 3 (§8), and a conforming record whose proof is forged is still
 * conforming.
 */
export function validateAnchorEvidence(bytes: Uint8Array): AnchorEvidenceValidationReport {
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    return {
      conforms: false,
      diagnostics: [{ code: "PAYLOAD_NOT_JSON", path: "", message: describeError(cause) }],
    };
  }

  const result = AnchorEvidenceSchema.safeParse(payload);
  if (!result.success) {
    return {
      conforms: false,
      diagnostics: result.error.issues.map((issue) => ({
        code: "SCHEMA_VIOLATION",
        path: issue.path.join("."),
        message: issue.message,
      })),
    };
  }

  const value = result.data;
  const diagnostic = proofContentDiagnostic(value.proof.content);
  if (diagnostic !== undefined) {
    return { conforms: false, diagnostics: [diagnostic], value };
  }

  return { conforms: true, diagnostics: [], value };
}

/**
 * Seals an anchor-evidence record: RFC 8785 JCS canonicalization once, and
 * nothing else. No DSSE envelope, no signer, no producer attribution (§5 rule
 * 4). The record is refused rather than sealed if it does not conform, so a
 * nonconforming anchor never acquires an identity.
 */
export function sealAnchorEvidence(record: AnchorEvidence): SealedAnchorEvidence {
  const parsed = parseConforming(record, "Anchor-evidence record does not conform to AnchorEvidenceSchema.");
  const bytes = canonicalJsonBytes(parsed);
  return { bytes, recordDigest: recordDigest(bytes) };
}

/**
 * Parses received bytes as an anchor-evidence record, requiring them to be the
 * exact sealed encoding. Alternate JSON spellings of the same record -- padded,
 * reordered, re-escaped -- are refused, never normalized: the bytes are the
 * record, and silently accepting a variant would let two byte strings claim one
 * identity. Throws `TrustCoreError` (`INVALID_INPUT`) on any nonconformance.
 */
export function parseExactAnchorEvidence(bytes: Uint8Array): AnchorEvidence {
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    invalidInput("Anchor-evidence bytes are not valid UTF-8 JSON.", cause);
  }
  const parsed = parseConforming(payload, "Anchor-evidence bytes do not conform to AnchorEvidenceSchema.");
  if (!bytesEqual(bytes, canonicalJsonBytes(parsed))) {
    invalidInput("Anchor-evidence bytes are not the exact sealed encoding.");
  }
  return parsed;
}

function parseConforming(candidate: unknown, message: string): AnchorEvidence {
  const result = AnchorEvidenceSchema.safeParse(candidate);
  if (!result.success) invalidInput(message, result.error);
  const diagnostic = proofContentDiagnostic(result.data.proof.content);
  if (diagnostic !== undefined) invalidInput(`${message} ${diagnostic.message}`);
  return result.data;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function describeError(cause: unknown): string {
  return cause instanceof TrustCoreError || cause instanceof Error ? cause.message : String(cause);
}

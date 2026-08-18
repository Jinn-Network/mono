// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  ANCHOR_EVIDENCE_KIND,
  ANCHOR_PROOF_MAX_DECODED_BYTES,
  OPENTIMESTAMPS_ANCHOR_PROFILE,
  RFC3161_TSA_ANCHOR_PROFILE,
  canonicalJsonBytes,
  decodeAnchorProofContent,
  recordDigest,
} from "@jinn-network/trust-core";

import { bytesToHex } from "./der-encoder.js";
import { createFixtureAuthority } from "./fixture-authority.js";
import { createOpenTimestampsKitFixtures } from "./ots-builder.js";
import {
  OPENTIMESTAMPS_PROOF_MEDIA_TYPE,
  RFC3161_TOKEN_MEDIA_TYPE,
  buildAnchorEvidenceRecord,
  buildOpenTimestampsAnchorEvidenceRecord,
  buildRfc3161AnchorEvidenceRecord,
  encodeProofContent,
  readAnchorEvidenceProof,
} from "./records.js";

const SUBJECT_KIND = "https://spec.jinn.network/records/benchmark-run/v1";
const SUBJECT = sha256(new TextEncoder().encode("anchor kit record subject"));
const SUBJECT_HEX = bytesToHex(SUBJECT);

const authority = createFixtureAuthority("anchor-kit-records");
const token = authority.mintTimeStampToken({ subjectSha256: SUBJECT });
const ots = createOpenTimestampsKitFixtures(SUBJECT);

describe("record builders", () => {
  test("an RFC 3161 record carries the exact token bytes under its own media type", () => {
    const built = buildRfc3161AnchorEvidenceRecord({
      subjectKind: SUBJECT_KIND,
      subjectSha256: SUBJECT_HEX,
      proofBytes: token.tokenDer,
    });
    expect(built.record.kind).toBe(ANCHOR_EVIDENCE_KIND);
    expect(built.record.provider).toBe(RFC3161_TSA_ANCHOR_PROFILE);
    expect(built.record.proof.mediaType).toBe(RFC3161_TOKEN_MEDIA_TYPE);
    expect(built.record.subject).toEqual({
      kind: SUBJECT_KIND,
      digest: { sha256: SUBJECT_HEX },
    });
    expect(bytesToHex(decodeAnchorProofContent(built.record.proof.content)))
      .toBe(bytesToHex(token.tokenDer));
  });

  test("an OpenTimestamps record carries the .ots media type", () => {
    const built = buildOpenTimestampsAnchorEvidenceRecord({
      subjectKind: SUBJECT_KIND,
      subjectSha256: SUBJECT_HEX,
      proofBytes: ots.completeProof,
    });
    expect(built.record.provider).toBe(OPENTIMESTAMPS_ANCHOR_PROFILE);
    expect(built.record.proof.mediaType).toBe(OPENTIMESTAMPS_PROOF_MEDIA_TYPE);
  });

  test("the sealed bytes are the canonical encoding and the digest is over them", () => {
    const built = buildRfc3161AnchorEvidenceRecord({
      subjectKind: SUBJECT_KIND,
      subjectSha256: SUBJECT_HEX,
      proofBytes: token.tokenDer,
    });
    expect(bytesToHex(built.bytes)).toBe(bytesToHex(canonicalJsonBytes(built.record)));
    expect(built.recordDigest).toBe(recordDigest(built.bytes));
  });

  test("the upgraded pair is two records over one subject", () => {
    const pending = buildOpenTimestampsAnchorEvidenceRecord({
      subjectKind: SUBJECT_KIND,
      subjectSha256: SUBJECT_HEX,
      proofBytes: ots.pendingProof,
    });
    const complete = buildOpenTimestampsAnchorEvidenceRecord({
      subjectKind: SUBJECT_KIND,
      subjectSha256: SUBJECT_HEX,
      proofBytes: ots.completeProof,
    });
    // Append-only: upgrading never rewrites the pending record, so the two
    // carry the same subject and different identities (§5 rule 6, §6.2).
    expect(pending.record.subject).toEqual(complete.record.subject);
    expect(pending.recordDigest).not.toBe(complete.recordDigest);
  });

  test("a nonconforming record is refused rather than sealed", () => {
    expect(() => buildAnchorEvidenceRecord({
      subjectKind: "not-a-uri",
      subjectSha256: SUBJECT_HEX,
      provider: RFC3161_TSA_ANCHOR_PROFILE,
      proofMediaType: RFC3161_TOKEN_MEDIA_TYPE,
      proofBytes: token.tokenDer,
    })).toThrow();
    expect(() => buildAnchorEvidenceRecord({
      subjectKind: SUBJECT_KIND,
      subjectSha256: SUBJECT_HEX.toUpperCase(),
      provider: RFC3161_TSA_ANCHOR_PROFILE,
      proofMediaType: RFC3161_TOKEN_MEDIA_TYPE,
      proofBytes: token.tokenDer,
    })).toThrow();
    // §5 rule 2's inline cap is enforced by the record kind, not by the kit.
    expect(() => buildAnchorEvidenceRecord({
      subjectKind: SUBJECT_KIND,
      subjectSha256: SUBJECT_HEX,
      provider: RFC3161_TSA_ANCHOR_PROFILE,
      proofMediaType: RFC3161_TOKEN_MEDIA_TYPE,
      proofBytes: new Uint8Array(ANCHOR_PROOF_MAX_DECODED_BYTES + 1),
    })).toThrow(/inline cap/);
  });
});

describe("the base64 encoder is the exact inverse of the sanctioned decoder", () => {
  test("every length residue round-trips", () => {
    for (let length = 0; length <= 8; length += 1) {
      const bytes = Uint8Array.from({ length }, (_unused, index) => (index * 37) & 0xff);
      const encoded = encodeProofContent(bytes);
      expect(encoded.length % 4).toBe(0);
      if (length === 0) continue; // the decoder refuses empty content by design
      expect(bytesToHex(decodeAnchorProofContent(encoded))).toBe(bytesToHex(bytes));
    }
  });

  test("the encoding is canonical padded standard base64", () => {
    expect(encodeProofContent(Uint8Array.of(0xff))).toBe("/w==");
    expect(encodeProofContent(Uint8Array.of(0xfb, 0xff))).toBe("+/8=");
    // The URL-safe alphabet never appears, which is what keeps one proof to one
    // spelling: dsse.ts's laxer decoder would accept "_w==" for the same bytes.
    expect(encodeProofContent(Uint8Array.of(0xff))).not.toContain("_");
    expect(() => decodeAnchorProofContent("_w==")).toThrow();
  });
});

describe("the read path", () => {
  test("it goes through parseExactAnchorEvidence and the sanctioned decoder", () => {
    const built = buildRfc3161AnchorEvidenceRecord({
      subjectKind: SUBJECT_KIND,
      subjectSha256: SUBJECT_HEX,
      proofBytes: token.tokenDer,
    });
    const read = readAnchorEvidenceProof(built.bytes);
    expect(read.record).toEqual(built.record);
    expect(bytesToHex(read.proofBytes)).toBe(bytesToHex(token.tokenDer));
  });

  test("an alternate JSON spelling of the same record is refused, not normalized", () => {
    const built = buildRfc3161AnchorEvidenceRecord({
      subjectKind: SUBJECT_KIND,
      subjectSha256: SUBJECT_HEX,
      proofBytes: token.tokenDer,
    });
    const prettyPrinted = new TextEncoder().encode(JSON.stringify(built.record, null, 2));
    // `validateAnchorEvidence` would call this conforming. The read path must
    // not: the bytes are the record, and two spellings would be two identities
    // claiming one anchor.
    expect(() => readAnchorEvidenceProof(prettyPrinted)).toThrow(/exact sealed encoding/);
  });

  test("bytes that are not a conforming record are refused", () => {
    expect(() => readAnchorEvidenceProof(new TextEncoder().encode("{}"))).toThrow();
    expect(() => readAnchorEvidenceProof(new TextEncoder().encode("not json"))).toThrow();
  });
});

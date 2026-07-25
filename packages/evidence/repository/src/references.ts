import { recordDigest } from "@jinn-network/evidence-protocol";

import { EvidenceRepositoryError } from "./errors.js";
import {
  EVIDENCE_RECORD_FAMILIES,
  type EvidenceArtifactReference,
  type EvidenceRecordFamily,
  type EvidenceRecordReference,
  type Sha256Digest,
} from "./types.js";

const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export function parseSha256Digest(value: unknown): Sha256Digest {
  if (typeof value !== "string" || !SHA256_DIGEST_PATTERN.test(value)) {
    throw new EvidenceRepositoryError(
      "INVALID_REFERENCE",
      "Expected a canonical lowercase sha256:<64 hex characters> digest.",
    );
  }

  return value as Sha256Digest;
}

export function parseEvidenceRecordFamily(
  value: unknown,
): EvidenceRecordFamily {
  if (
    typeof value !== "string" ||
    !EVIDENCE_RECORD_FAMILIES.includes(value as EvidenceRecordFamily)
  ) {
    throw new EvidenceRepositoryError(
      "INVALID_REFERENCE",
      "Expected a supported evidence record family.",
    );
  }

  return value as EvidenceRecordFamily;
}

export function createRecordReference(
  family: EvidenceRecordFamily,
  bytes: Uint8Array,
): EvidenceRecordReference {
  return {
    family: parseEvidenceRecordFamily(family),
    digest: parseSha256Digest(recordDigest(bytes)),
  };
}

export function createArtifactReference(
  bytes: Uint8Array,
): EvidenceArtifactReference {
  return {
    digest: parseSha256Digest(recordDigest(bytes)),
  };
}

export function parseEvidenceRecordReference(
  value: unknown,
): EvidenceRecordReference {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new EvidenceRepositoryError(
      "INVALID_REFERENCE",
      "Expected an evidence record reference object.",
    );
  }

  const candidate = value as Partial<EvidenceRecordReference>;
  return {
    family: parseEvidenceRecordFamily(candidate.family),
    digest: parseSha256Digest(candidate.digest),
  };
}

export function parseEvidenceArtifactReference(
  value: unknown,
): EvidenceArtifactReference {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new EvidenceRepositoryError(
      "INVALID_REFERENCE",
      "Expected an evidence artifact reference object.",
    );
  }

  return {
    digest: parseSha256Digest(
      (value as Partial<EvidenceArtifactReference>).digest,
    ),
  };
}

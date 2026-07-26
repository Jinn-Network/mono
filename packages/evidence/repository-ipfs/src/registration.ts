// SPDX-License-Identifier: Apache-2.0

import {
  EvidenceRepositoryError,
  createArtifactReference,
  parseEvidenceArtifactReference,
  parseEvidenceRecordReference,
  type EvidenceArtifactReference,
  type EvidenceRecordReference,
} from "@jinn-network/evidence-repository";

import { digestToRawCid } from "./cid.js";

export const IPFS_REGISTRATION_PROFILE =
  "jinn.evidence-repository.ipfs-registration";
export const IPFS_REGISTRATION_VERSION = 1;

const encoder = new TextEncoder();
const fatalDecoder = new TextDecoder("utf-8", { fatal: true });
const RECORD_REGISTRATION_PATTERN =
  /^\{"digest":"(sha256:[0-9a-f]{64})","family":"(execution-evidence|result-evaluation|execution-verification)","kind":"record","profile":"jinn\.evidence-repository\.ipfs-registration","version":1\}\n$/u;
const ARTIFACT_REGISTRATION_PATTERN =
  /^\{"digest":"(sha256:[0-9a-f]{64})","kind":"artifact","profile":"jinn\.evidence-repository\.ipfs-registration","version":1\}\n$/u;

export type IpfsRepositoryRegistration =
  | {
      readonly kind: "record";
      readonly reference: EvidenceRecordReference;
    }
  | {
      readonly kind: "artifact";
      readonly reference: EvidenceArtifactReference;
    };

export function buildRecordRegistrationBytes(
  untrustedReference: EvidenceRecordReference,
): Uint8Array {
  const reference = parseEvidenceRecordReference(untrustedReference);
  return encoder.encode(
    `{"digest":"${reference.digest}","family":"${reference.family}",` +
      `"kind":"record","profile":"${IPFS_REGISTRATION_PROFILE}",` +
      `"version":${IPFS_REGISTRATION_VERSION}}\n`,
  );
}

export function buildArtifactRegistrationBytes(
  untrustedReference: EvidenceArtifactReference,
): Uint8Array {
  const reference = parseEvidenceArtifactReference(untrustedReference);
  return encoder.encode(
    `{"digest":"${reference.digest}","kind":"artifact",` +
      `"profile":"${IPFS_REGISTRATION_PROFILE}",` +
      `"version":${IPFS_REGISTRATION_VERSION}}\n`,
  );
}

export function buildRegistrationBytes(
  reference: EvidenceRecordReference | EvidenceArtifactReference,
): Uint8Array {
  return isRecordReference(reference)
    ? buildRecordRegistrationBytes(reference)
    : buildArtifactRegistrationBytes(reference);
}

export function registrationCidForReference(
  reference: EvidenceRecordReference | EvidenceArtifactReference,
): string {
  return digestToRawCid(
    createArtifactReference(buildRegistrationBytes(reference)).digest,
  );
}

export function parseRegistrationBytes(
  bytes: Uint8Array,
): IpfsRepositoryRegistration {
  let text: string;
  try {
    text = fatalDecoder.decode(bytes);
  } catch (error) {
    throw corruptRegistration("Registration bytes are not valid UTF-8.", error);
  }

  const recordMatch = RECORD_REGISTRATION_PATTERN.exec(text);
  if (recordMatch !== null) {
    return {
      kind: "record",
      reference: {
        digest: recordMatch[1] as EvidenceRecordReference["digest"],
        family: recordMatch[2] as EvidenceRecordReference["family"],
      },
    };
  }

  const artifactMatch = ARTIFACT_REGISTRATION_PATTERN.exec(text);
  if (artifactMatch !== null) {
    return {
      kind: "artifact",
      reference: {
        digest: artifactMatch[1] as EvidenceArtifactReference["digest"],
      },
    };
  }

  throw corruptRegistration(
    "Registration bytes do not match the canonical v1 profile.",
  );
}

function isRecordReference(
  reference: EvidenceRecordReference | EvidenceArtifactReference,
): reference is EvidenceRecordReference {
  return (
    typeof reference === "object" &&
    reference !== null &&
    "family" in reference
  );
}

function corruptRegistration(
  message: string,
  cause?: unknown,
): EvidenceRepositoryError {
  return new EvidenceRepositoryError(
    "CONTENT_CORRUPT",
    message,
    cause === undefined ? undefined : { cause },
  );
}

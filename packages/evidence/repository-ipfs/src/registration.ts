// SPDX-License-Identifier: Apache-2.0

import { isProxy } from "node:util/types";

import {
  EvidenceRepositoryError,
  createArtifactReference,
  parseEvidenceArtifactReference,
  parseEvidenceRecordReference,
  type EvidenceArtifactReference,
  type EvidenceRecordReference,
} from "@jinn-network/evidence-repository";

import { digestToRawCid } from "./cid.js";
import { ipfsRepositoryError } from "./errors.js";

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
  const reference = parseRecordRegistrationReference(
    untrustedReference,
  );
  return encodeRecordRegistration(reference);
}

function encodeRecordRegistration(
  reference: EvidenceRecordReference,
): Uint8Array {
  return encoder.encode(
    `{"digest":"${reference.digest}","family":"${reference.family}",` +
      `"kind":"record","profile":"${IPFS_REGISTRATION_PROFILE}",` +
      `"version":${IPFS_REGISTRATION_VERSION}}\n`,
  );
}

export function buildArtifactRegistrationBytes(
  untrustedReference: EvidenceArtifactReference,
): Uint8Array {
  const reference = parseArtifactRegistrationReference(
    untrustedReference,
  );
  return encodeArtifactRegistration(reference);
}

function encodeArtifactRegistration(
  reference: EvidenceArtifactReference,
): Uint8Array {
  return encoder.encode(
    `{"digest":"${reference.digest}","kind":"artifact",` +
      `"profile":"${IPFS_REGISTRATION_PROFILE}",` +
      `"version":${IPFS_REGISTRATION_VERSION}}\n`,
  );
}

export function buildRegistrationBytes(
  reference: EvidenceRecordReference | EvidenceArtifactReference,
): Uint8Array {
  const snapshot = snapshotRegistrationReference(reference, "either");
  return snapshot.kind === "record"
    ? encodeRecordRegistration(parseRecordSnapshot(snapshot))
    : encodeArtifactRegistration(parseArtifactSnapshot(snapshot));
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
  } catch {
    throw corruptRegistration("Registration bytes are not valid UTF-8.");
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

interface ReferenceSnapshot {
  readonly digest: unknown;
  readonly family?: unknown;
  readonly kind: "artifact" | "record";
}

function parseRecordRegistrationReference(
  reference: unknown,
): EvidenceRecordReference {
  return parseRecordSnapshot(
    snapshotRegistrationReference(reference, "record"),
  );
}

function parseArtifactRegistrationReference(
  reference: unknown,
): EvidenceArtifactReference {
  return parseArtifactSnapshot(
    snapshotRegistrationReference(reference, "artifact"),
  );
}

function snapshotRegistrationReference(
  reference: unknown,
  expectedKind: "artifact" | "either" | "record",
): ReferenceSnapshot {
  try {
    if (
      reference === null ||
      typeof reference !== "object" ||
      isProxy(reference) ||
      Array.isArray(reference)
    ) {
      throw invalidRegistrationReference();
    }
    const prototype = Object.getPrototypeOf(reference);
    if (prototype !== Object.prototype && prototype !== null) {
      throw invalidRegistrationReference();
    }
    const digest = ownDataProperty(reference, "digest");
    if (expectedKind === "artifact") {
      return { digest, kind: "artifact" };
    }
    const familyDescriptor =
      Object.getOwnPropertyDescriptor(reference, "family");
    if (expectedKind === "record") {
      if (
        familyDescriptor === undefined ||
        !("value" in familyDescriptor)
      ) {
        throw invalidRegistrationReference();
      }
      return {
        digest,
        family: familyDescriptor.value,
        kind: "record",
      };
    }
    if (familyDescriptor === undefined) {
      return { digest, kind: "artifact" };
    }
    if (!("value" in familyDescriptor)) {
      throw invalidRegistrationReference();
    }
    return {
      digest,
      family: familyDescriptor.value,
      kind: "record",
    };
  } catch {
    throw invalidRegistrationReference();
  }
}

function ownDataProperty(
  reference: object,
  key: string,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(reference, key);
  if (descriptor === undefined || !("value" in descriptor)) {
    throw invalidRegistrationReference();
  }
  return descriptor.value;
}

function parseRecordSnapshot(
  snapshot: ReferenceSnapshot,
): EvidenceRecordReference {
  try {
    return parseEvidenceRecordReference({
      digest: snapshot.digest,
      family: snapshot.family,
    });
  } catch {
    throw invalidRegistrationReference();
  }
}

function parseArtifactSnapshot(
  snapshot: ReferenceSnapshot,
): EvidenceArtifactReference {
  try {
    return parseEvidenceArtifactReference({
      digest: snapshot.digest,
    });
  } catch {
    throw invalidRegistrationReference();
  }
}

function invalidRegistrationReference(): EvidenceRepositoryError {
  return ipfsRepositoryError(
    "INVALID_REFERENCE",
    "Expected an inert evidence repository reference.",
  );
}

function corruptRegistration(
  message: string,
): EvidenceRepositoryError {
  return new EvidenceRepositoryError(
    "CONTENT_CORRUPT",
    message,
  );
}

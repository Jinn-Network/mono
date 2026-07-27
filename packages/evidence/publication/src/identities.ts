// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";

import {
  parseEvidenceArtifactReference,
  parseEvidenceRecordReference,
  type EvidenceArtifactReference,
  type EvidenceRecordReference,
  type Sha256Digest,
} from "@jinn-network/evidence-repository";

import { EvidencePublicationError } from "./errors.js";
import type {
  AnnouncementMember,
  NormalizedPublishInput,
  PreparedAnnouncement,
  PublishArtifact,
  PublishInput,
  PublishRecord,
} from "./types.js";
import {
  assertAbsoluteIri,
  parsePublicationDigest,
  snapshotExactBytes,
} from "./validation.js";

const encoder = new TextEncoder();

export function hashExactBytes(bytes: Uint8Array): Sha256Digest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}

function parseRecordReference(value: unknown): EvidenceRecordReference {
  try {
    return parseEvidenceRecordReference(value);
  } catch (cause) {
    throw new EvidencePublicationError(
      "INVALID_INPUT",
      "A record reference is invalid.",
      { cause },
    );
  }
}

function parseArtifactReference(value: unknown): EvidenceArtifactReference {
  try {
    return parseEvidenceArtifactReference(value);
  } catch (cause) {
    throw new EvidencePublicationError(
      "INVALID_INPUT",
      "An artifact reference is invalid.",
      { cause },
    );
  }
}

function requireBytes(value: unknown, role: string): Uint8Array {
  const snapshot = snapshotExactBytes(value);
  if (snapshot === undefined) {
    throw new EvidencePublicationError(
      "INVALID_INPUT",
      `${role} must contain exact non-proxy Uint8Array bytes.`,
    );
  }
  return snapshot;
}

function recordKey(reference: EvidenceRecordReference): string {
  return `${reference.family}:${reference.digest}`;
}

function snapshotRecords(values: unknown): readonly PublishRecord[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new EvidencePublicationError(
      "INVALID_INPUT",
      "Publication requires at least one evidence record.",
    );
  }
  const byReference = new Map<string, PublishRecord>();
  for (const value of values) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new EvidencePublicationError(
        "INVALID_INPUT",
        "Each publication record must be an object.",
      );
    }
    const candidate = value as Partial<PublishRecord>;
    const reference = parseRecordReference(candidate.reference);
    const bytes = requireBytes(candidate.bytes, "A publication record");
    const key = recordKey(reference);
    const existing = byReference.get(key);
    if (existing !== undefined && !bytesEqual(existing.bytes, bytes)) {
      throw new EvidencePublicationError(
        "BUNDLE_CONFLICT",
        "The same record reference was declared with different bytes.",
      );
    }
    if (existing === undefined) {
      byReference.set(key, {
        reference: { ...reference },
        bytes,
      });
    }
  }
  const records = [...byReference.values()].sort((left, right) =>
    compareText(recordKey(left.reference), recordKey(right.reference))
  );
  for (const record of records) {
    if (hashExactBytes(record.bytes) !== record.reference.digest) {
      throw new EvidencePublicationError(
        "CONTENT_DIGEST_MISMATCH",
        `Record bytes do not match ${record.reference.digest}.`,
      );
    }
  }
  return records;
}

function snapshotArtifacts(values: unknown): readonly PublishArtifact[] {
  if (values === undefined) return [];
  if (!Array.isArray(values)) {
    throw new EvidencePublicationError(
      "INVALID_INPUT",
      "Publication artifacts must be an array when supplied.",
    );
  }
  const byReference = new Map<string, PublishArtifact>();
  for (const value of values) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new EvidencePublicationError(
        "INVALID_INPUT",
        "Each publication artifact must be an object.",
      );
    }
    const candidate = value as Partial<PublishArtifact>;
    const reference = parseArtifactReference(candidate.reference);
    const bytes = requireBytes(candidate.bytes, "A publication artifact");
    const existing = byReference.get(reference.digest);
    if (existing !== undefined && !bytesEqual(existing.bytes, bytes)) {
      throw new EvidencePublicationError(
        "BUNDLE_CONFLICT",
        "The same artifact reference was declared with different bytes.",
      );
    }
    if (existing === undefined) {
      byReference.set(reference.digest, {
        reference: { ...reference },
        bytes,
      });
    }
  }
  const artifacts = [...byReference.values()].sort((left, right) =>
    compareText(left.reference.digest, right.reference.digest)
  );
  for (const artifact of artifacts) {
    if (hashExactBytes(artifact.bytes) !== artifact.reference.digest) {
      throw new EvidencePublicationError(
        "CONTENT_DIGEST_MISMATCH",
        `Artifact bytes do not match ${artifact.reference.digest}.`,
      );
    }
  }
  return artifacts;
}

function identityBytes(
  domain: "bundle" | "payload",
  records: readonly EvidenceRecordReference[],
  artifacts: readonly EvidenceArtifactReference[],
  destination: string,
): Uint8Array {
  return encoder.encode(JSON.stringify({
    format: `jinn-evidence-publication-${domain}`,
    version: 1,
    destination,
    records: records.map((reference) => ({
      family: reference.family,
      digest: reference.digest,
    })),
    artifacts: artifacts.map((reference) => ({
      digest: reference.digest,
    })),
  }));
}

export function derivePublicationIdentities(
  records: readonly EvidenceRecordReference[],
  artifacts: readonly EvidenceArtifactReference[],
  destination: string,
): {
  readonly bundleKey: Sha256Digest;
  readonly payloadFingerprint: Sha256Digest;
} {
  return {
    bundleKey: hashExactBytes(
      identityBytes("bundle", records, artifacts, destination),
    ),
    payloadFingerprint: hashExactBytes(
      identityBytes("payload", records, artifacts, destination),
    ),
  };
}

export function normalizePublishInput(input: PublishInput): NormalizedPublishInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new EvidencePublicationError(
      "INVALID_INPUT",
      "Publication input must be an object.",
    );
  }
  const records = snapshotRecords(input.records);
  const artifacts = snapshotArtifacts(input.artifacts);
  const destination = assertAbsoluteIri(
    input.destination,
    "Publication destination",
  );
  const identities = derivePublicationIdentities(
    records.map(({ reference }) => reference),
    artifacts.map(({ reference }) => reference),
    destination,
  );
  return {
    records,
    artifacts,
    destination,
    ...identities,
  };
}

export function snapshotPreparedAnnouncement(
  value: PreparedAnnouncement,
  expectedMembers: readonly AnnouncementMember[],
  expectedMedium: string,
  expectedProfile: string,
): PreparedAnnouncement {
  try {
    return snapshotPreparedAnnouncementUnchecked(
      value,
      expectedMembers,
      expectedMedium,
      expectedProfile,
    );
  } catch (cause) {
    if (
      cause instanceof EvidencePublicationError &&
      cause.code === "SINK_PROTOCOL_VIOLATION"
    ) {
      throw cause;
    }
    throw new EvidencePublicationError(
      "SINK_PROTOCOL_VIOLATION",
      "The sink returned a malformed prepared announcement.",
      { cause },
    );
  }
}

function snapshotPreparedAnnouncementUnchecked(
  value: PreparedAnnouncement,
  expectedMembers: readonly AnnouncementMember[],
  expectedMedium: string,
  expectedProfile: string,
): PreparedAnnouncement {
  const fail = (message: string): never => {
    throw new EvidencePublicationError("SINK_PROTOCOL_VIOLATION", message);
  };
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    isProxy(value)
  ) {
    return fail("The sink returned an invalid prepared announcement.");
  }
  const ownData = (
    object: object,
    key: PropertyKey,
    role: string,
  ): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      return fail(`${role} must be an own data property.`);
    }
    return descriptor.value;
  };
  const medium = assertAbsoluteIri(
    ownData(value, "medium", "The prepared announcement medium"),
    "Prepared announcement medium",
  );
  if (medium !== expectedMedium) {
    return fail("The sink changed its configured announcement medium.");
  }
  const profile = assertAbsoluteIri(
    ownData(value, "profile", "The prepared announcement profile"),
    "Prepared announcement profile",
  );
  if (profile !== expectedProfile) {
    return fail("The sink changed its configured announcement profile.");
  }
  const memberValues = ownData(
    value,
    "members",
    "The prepared announcement members",
  );
  if (
    !Array.isArray(memberValues) ||
    isProxy(memberValues) ||
    memberValues.length !== expectedMembers.length
  ) {
    return fail("The sink changed the prepared member count.");
  }
  const members: AnnouncementMember[] = [];
  for (let index = 0; index < memberValues.length; index += 1) {
    const member = ownData(
      memberValues,
      String(index),
      `Prepared announcement member ${index}`,
    );
    if (
      typeof member !== "object" ||
      member === null ||
      Array.isArray(member) ||
      isProxy(member)
    ) {
      return fail("The sink returned an invalid prepared member.");
    }
    const reference = ownData(
      member,
      "reference",
      "A prepared member reference",
    );
    if (
      typeof reference !== "object" ||
      reference === null ||
      Array.isArray(reference) ||
      isProxy(reference)
    ) {
      return fail("The sink returned an invalid prepared member reference.");
    }
    const actual = parseRecordReference({
      family: ownData(
        reference,
        "family",
        "A prepared member reference family",
      ),
      digest: ownData(
        reference,
        "digest",
        "A prepared member reference digest",
      ),
    });
    const expected = parseRecordReference(expectedMembers[index]?.reference);
    if (
      actual.family !== expected.family ||
      actual.digest !== expected.digest
    ) {
      return fail("The sink changed the prepared member sequence.");
    }
    members.push({ reference: { ...actual } });
  }
  const frameBytes = requireBytes(
    ownData(value, "frameBytes", "The prepared announcement frame bytes"),
    "A prepared announcement frame",
  );
  const frameSize = ownData(
    value,
    "frameSize",
    "The prepared announcement frame size",
  );
  if (
    typeof frameSize !== "number" ||
    !Number.isSafeInteger(frameSize) ||
    frameSize < 0 ||
    frameSize !== frameBytes.byteLength
  ) {
    return fail("The sink reported an invalid prepared frame size.");
  }
  const frameDigest = parsePublicationDigest(
    ownData(value, "frameDigest", "The prepared announcement frame digest"),
    "Prepared frame digest",
  );
  if (hashExactBytes(frameBytes) !== frameDigest) {
    return fail("The prepared frame digest does not match its exact bytes.");
  }
  return {
    medium: expectedMedium,
    profile: expectedProfile,
    members,
    frameBytes,
    frameDigest,
    frameSize: frameBytes.byteLength,
  };
}

export function assertPreparedAnnouncement(
  value: PreparedAnnouncement,
  expectedMembers: readonly AnnouncementMember[],
  expectedMedium: string,
  expectedProfile: string,
): void {
  snapshotPreparedAnnouncement(
    value,
    expectedMembers,
    expectedMedium,
    expectedProfile,
  );
}

export interface PlacementIdempotencyInput {
  readonly bundleKey: Sha256Digest;
  readonly destination: string;
  readonly partitionOrdinal: number;
  readonly frameDigest: Sha256Digest;
  readonly medium: string;
  readonly profile: string;
}

export function derivePlacementIdempotencyKey(
  input: PlacementIdempotencyInput,
): Sha256Digest {
  const bundleKey = parsePublicationDigest(input.bundleKey, "Bundle key");
  const frameDigest = parsePublicationDigest(
    input.frameDigest,
    "Prepared frame digest",
  );
  const destination = assertAbsoluteIri(input.destination, "Destination");
  const medium = assertAbsoluteIri(input.medium, "Sink medium");
  const profile = assertAbsoluteIri(input.profile, "Sink profile");
  if (
    !Number.isSafeInteger(input.partitionOrdinal) ||
    input.partitionOrdinal < 0
  ) {
    throw new EvidencePublicationError(
      "INVALID_INPUT",
      "Partition ordinal must be a non-negative safe integer.",
    );
  }
  return hashExactBytes(encoder.encode(JSON.stringify({
    format: "jinn-evidence-publication-placement-key",
    version: 1,
    bundleKey,
    destination,
    partitionOrdinal: input.partitionOrdinal,
    frameDigest,
    medium,
    profile,
  })));
}

// SPDX-License-Identifier: Apache-2.0
import {
  parseEvidenceArtifactReference,
  parseEvidenceRecordReference,
  type EvidenceArtifactReference,
  type EvidenceRecordReference,
  type Sha256Digest,
} from "@jinn-network/evidence-repository";

import { EvidencePublicationError } from "./errors.js";
import {
  derivePublicationIdentities,
  hashExactBytes,
  snapshotPreparedAnnouncement,
} from "./identities.js";
import type {
  JournalRepositoryCapabilities,
  OpaqueSinkState,
  Placement,
  PreparedAnnouncement,
  PreparedPublicationPartition,
  PublicationJournalEntry,
  PublicationPartitionPlacement,
  StoredArtifactCheckpoint,
  StoredRecordCheckpoint,
  VersionedPublicationJournalEntry,
} from "./types.js";
import {
  assertAbsoluteIri,
  exactBytesLength,
  parsePublicationDigest,
  snapshotExactBytes,
} from "./validation.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

function corrupt(message: string, cause?: unknown): never {
  throw new EvidencePublicationError(
    "JOURNAL_CORRUPT",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function plainObject(value: unknown, role: string): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return corrupt(`${role} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
  role: string,
): void {
  const keys = Object.keys(value).sort();
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    corrupt(`${role} contains missing or unknown fields.`);
  }
}

function safeInteger(value: unknown, role: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return corrupt(`${role} must be a non-negative safe integer.`);
  }
  return value;
}

function positiveSafeInteger(value: unknown, role: string): number {
  const integer = safeInteger(value, role);
  if (integer === 0) {
    return corrupt(`${role} must be a positive safe integer.`);
  }
  return integer;
}

function booleanValue(value: unknown, role: string): boolean {
  if (typeof value !== "boolean") {
    return corrupt(`${role} must be a boolean.`);
  }
  return value;
}

function stringValue(value: unknown, role: string): string {
  if (typeof value !== "string" || value.length === 0) {
    return corrupt(`${role} must be a non-empty string.`);
  }
  return value;
}

function journalDigest(value: unknown, role: string): Sha256Digest {
  try {
    return parsePublicationDigest(value, role);
  } catch (cause) {
    return corrupt(`${role} is invalid.`, cause);
  }
}

function journalIri(value: unknown, role: string): string {
  try {
    return assertAbsoluteIri(value, role);
  } catch (cause) {
    return corrupt(`${role} is invalid.`, cause);
  }
}

function artifactReference(
  value: unknown,
  role: string,
): EvidenceArtifactReference {
  try {
    return parseEvidenceArtifactReference(value);
  } catch (cause) {
    return corrupt(`${role} is invalid.`, cause);
  }
}

function recordReference(
  value: unknown,
  role: string,
): EvidenceRecordReference {
  try {
    return parseEvidenceRecordReference(value);
  } catch (cause) {
    return corrupt(`${role} is invalid.`, cause);
  }
}

function recordKey(reference: EvidenceRecordReference): string {
  return `${reference.family}:${reference.digest}`;
}

function assertCanonicalReferences(
  artifacts: readonly EvidenceArtifactReference[],
  records: readonly EvidenceRecordReference[],
): void {
  if (records.length === 0) corrupt("A journal entry must contain records.");
  const artifactKeys = artifacts.map(({ digest }) => digest);
  const recordKeys = records.map(recordKey);
  if (
    artifactKeys.some((key, index) =>
      index > 0 && artifactKeys[index - 1]! >= key
    ) ||
    recordKeys.some((key, index) => index > 0 && recordKeys[index - 1]! >= key)
  ) {
    corrupt("Journal references must be unique and canonically sorted.");
  }
}

function base64(bytes: Uint8Array, role: string): string {
  const snapshot = snapshotExactBytes(bytes);
  if (snapshot === undefined) {
    return corrupt(`${role} must be exact non-proxy Uint8Array bytes.`);
  }
  return Buffer.from(snapshot).toString("base64");
}

class JournalSizeExceeded extends Error {}

class JournalByteSizer {
  #size = 0;

  constructor(readonly maximum: number) {}

  get size(): number {
    return this.#size;
  }

  add(count: number): void {
    if (
      !Number.isSafeInteger(count) ||
      count < 0 ||
      count > this.maximum - this.#size
    ) {
      throw new JournalSizeExceeded();
    }
    this.#size += count;
  }

  beginObject(): void {
    this.add(1);
  }

  endObject(): void {
    this.add(1);
  }

  beginArray(): void {
    this.add(1);
  }

  endArray(): void {
    this.add(1);
  }

  element(index: number): void {
    if (index > 0) this.add(1);
  }

  property(name: string, index: number): void {
    this.element(index);
    this.string(name);
    this.add(1);
  }

  string(value: string): void {
    this.add(2);
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code === 0x22 || code === 0x5c) {
        this.add(2);
      } else if (
        code === 0x08 ||
        code === 0x09 ||
        code === 0x0a ||
        code === 0x0c ||
        code === 0x0d
      ) {
        this.add(2);
      } else if (code < 0x20) {
        this.add(6);
      } else if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          this.add(4);
          index += 1;
        } else {
          this.add(6);
        }
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        this.add(6);
      } else if (code <= 0x7f) {
        this.add(1);
      } else if (code <= 0x7ff) {
        this.add(2);
      } else {
        this.add(3);
      }
    }
  }

  integer(value: number, role: string): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      corrupt(`${role} must be a non-negative safe integer.`);
    }
    this.add(String(value).length);
  }

  boolean(value: boolean, role: string): void {
    if (typeof value !== "boolean") {
      corrupt(`${role} must be a boolean.`);
    }
    this.add(value ? 4 : 5);
  }

  exactBytes(value: unknown, role: string): void {
    const length = exactBytesLength(value);
    if (length === undefined) {
      corrupt(`${role} must be exact non-proxy Uint8Array bytes.`);
    }
    const encodedLength = 4 * Math.ceil(length / 3);
    this.add(2);
    this.add(encodedLength);
  }
}

function measureArtifactReference(
  sizer: JournalByteSizer,
  reference: EvidenceArtifactReference,
): void {
  sizer.beginObject();
  sizer.property("digest", 0);
  sizer.string(reference.digest);
  sizer.endObject();
}

function measureRecordReference(
  sizer: JournalByteSizer,
  reference: EvidenceRecordReference,
): void {
  sizer.beginObject();
  sizer.property("family", 0);
  sizer.string(reference.family);
  sizer.property("digest", 1);
  sizer.string(reference.digest);
  sizer.endObject();
}

function measureOpaqueState(
  sizer: JournalByteSizer,
  state: OpaqueSinkState,
  role: string,
): void {
  sizer.beginObject();
  sizer.property("format", 0);
  sizer.string(state.format);
  sizer.property("bytes", 1);
  sizer.exactBytes(state.bytes, `${role}.bytes`);
  sizer.endObject();
}

function measurePlacement(
  sizer: JournalByteSizer,
  placement: PublicationPartitionPlacement,
): void {
  sizer.beginObject();
  sizer.property("status", 0);
  sizer.string(placement.status);
  if (placement.status === "pending") {
    sizer.property("pending", 1);
    sizer.beginObject();
    sizer.property("idempotencyKey", 0);
    sizer.string(placement.pending.idempotencyKey);
    sizer.property("frameDigest", 1);
    sizer.string(placement.pending.frameDigest);
    if (placement.pending.state !== undefined) {
      sizer.property("state", 2);
      measureOpaqueState(
        sizer,
        placement.pending.state,
        "pending.state",
      );
    }
    sizer.endObject();
  } else if (placement.status === "confirmed") {
    sizer.property("result", 1);
    sizer.string(placement.result);
    sizer.property("placement", 2);
    sizer.beginObject();
    sizer.property("externalId", 0);
    sizer.string(placement.placement.externalId);
    if (placement.placement.state !== undefined) {
      sizer.property("state", 1);
      measureOpaqueState(
        sizer,
        placement.placement.state,
        "placement.state",
      );
    }
    sizer.endObject();
  }
  sizer.endObject();
}

function measurePreparedPartition(
  sizer: JournalByteSizer,
  partition: PreparedPublicationPartition,
): void {
  sizer.beginObject();
  sizer.property("ordinal", 0);
  sizer.integer(partition.ordinal, "prepared partition ordinal");
  sizer.property("prepared", 1);
  sizer.beginObject();
  sizer.property("medium", 0);
  sizer.string(partition.prepared.medium);
  sizer.property("profile", 1);
  sizer.string(partition.prepared.profile);
  sizer.property("members", 2);
  sizer.beginArray();
  for (
    let index = 0;
    index < partition.prepared.members.length;
    index += 1
  ) {
    sizer.element(index);
    sizer.beginObject();
    sizer.property("reference", 0);
    measureRecordReference(
      sizer,
      partition.prepared.members[index]!.reference,
    );
    sizer.endObject();
  }
  sizer.endArray();
  sizer.property("frameBytes", 3);
  sizer.exactBytes(
    partition.prepared.frameBytes,
    "prepared frame bytes",
  );
  sizer.property("frameDigest", 4);
  sizer.string(partition.prepared.frameDigest);
  sizer.property("frameSize", 5);
  sizer.integer(partition.prepared.frameSize, "prepared frame size");
  sizer.endObject();
  sizer.property("placement", 2);
  measurePlacement(sizer, partition.placement);
  sizer.endObject();
}

export function measureVersionedPublicationJournalEntryBytes(
  entry: VersionedPublicationJournalEntry,
  maximum: number,
): number {
  const sizer = new JournalByteSizer(maximum);
  try {
    sizer.beginObject();
    sizer.property("schemaVersion", 0);
    sizer.integer(entry.schemaVersion, "schemaVersion");
    sizer.property("bundleKey", 1);
    sizer.string(entry.bundleKey);
    sizer.property("payloadFingerprint", 2);
    sizer.string(entry.payloadFingerprint);
    sizer.property("destination", 3);
    sizer.string(entry.destination);
    sizer.property("repositoryCapabilities", 4);
    sizer.beginObject();
    if (entry.repositoryCapabilities.maxObjectBytes !== undefined) {
      sizer.property("maxObjectBytes", 0);
      sizer.integer(
        entry.repositoryCapabilities.maxObjectBytes,
        "repositoryCapabilities.maxObjectBytes",
      );
    }
    sizer.endObject();
    sizer.property("artifacts", 5);
    sizer.beginArray();
    for (let index = 0; index < entry.artifacts.length; index += 1) {
      sizer.element(index);
      measureArtifactReference(sizer, entry.artifacts[index]!);
    }
    sizer.endArray();
    sizer.property("records", 6);
    sizer.beginArray();
    for (let index = 0; index < entry.records.length; index += 1) {
      sizer.element(index);
      measureRecordReference(sizer, entry.records[index]!);
    }
    sizer.endArray();
    sizer.property("storedArtifacts", 7);
    sizer.beginArray();
    for (let index = 0; index < entry.storedArtifacts.length; index += 1) {
      const checkpoint = entry.storedArtifacts[index]!;
      sizer.element(index);
      sizer.beginObject();
      sizer.property("reference", 0);
      measureArtifactReference(sizer, checkpoint.reference);
      sizer.property("size", 1);
      sizer.integer(checkpoint.size, `storedArtifacts[${index}].size`);
      sizer.endObject();
    }
    sizer.endArray();
    sizer.property("storedRecords", 8);
    sizer.beginArray();
    for (let index = 0; index < entry.storedRecords.length; index += 1) {
      const checkpoint = entry.storedRecords[index]!;
      sizer.element(index);
      sizer.beginObject();
      sizer.property("reference", 0);
      measureRecordReference(sizer, checkpoint.reference);
      sizer.property("size", 1);
      sizer.integer(checkpoint.size, `storedRecords[${index}].size`);
      sizer.endObject();
    }
    sizer.endArray();
    let completedPropertyIndex = 9;
    if (entry.preparedPartitions !== undefined) {
      sizer.property("preparedPartitions", 9);
      sizer.beginArray();
      for (
        let index = 0;
        index < entry.preparedPartitions.length;
        index += 1
      ) {
        sizer.element(index);
        measurePreparedPartition(sizer, entry.preparedPartitions[index]!);
      }
      sizer.endArray();
      completedPropertyIndex += 1;
    }
    sizer.property("completed", completedPropertyIndex);
    sizer.boolean(entry.completed, "completed");
    sizer.property("revision", completedPropertyIndex + 1);
    sizer.integer(entry.revision, "revision");
    sizer.endObject();
    sizer.add(1);
    return sizer.size;
  } catch (error) {
    if (error instanceof JournalSizeExceeded) return maximum + 1;
    throw error;
  }
}

function bytesFromBase64(value: unknown, role: string): Uint8Array {
  if (
    typeof value !== "string" ||
    !BASE64_PATTERN.test(value)
  ) {
    return corrupt(`${role} must be canonical base64.`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    return corrupt(`${role} must be canonical base64.`);
  }
  return Uint8Array.from(bytes);
}

function decodeOpaqueState(value: unknown, role: string): OpaqueSinkState {
  const object = plainObject(value, role);
  exactKeys(object, ["format", "bytes"], [], role);
  return {
    format: journalIri(object.format, `${role}.format`),
    bytes: bytesFromBase64(object.bytes, `${role}.bytes`),
  };
}

function encodeOpaqueState(state: OpaqueSinkState): Record<string, unknown> {
  return {
    format: state.format,
    bytes: base64(state.bytes, "Opaque sink state bytes"),
  };
}

function decodePlacement(value: unknown, role: string): Placement {
  const object = plainObject(value, role);
  exactKeys(object, ["externalId"], ["state"], role);
  return {
    externalId: stringValue(object.externalId, `${role}.externalId`),
    ...(object.state === undefined
      ? {}
      : { state: decodeOpaqueState(object.state, `${role}.state`) }),
  };
}

function encodePlacement(placement: Placement): Record<string, unknown> {
  return {
    externalId: placement.externalId,
    ...(placement.state === undefined
      ? {}
      : { state: encodeOpaqueState(placement.state) }),
  };
}

function decodePartitionPlacement(
  value: unknown,
  frameDigest: Sha256Digest,
  role: string,
): PublicationPartitionPlacement {
  const object = plainObject(value, role);
  const status = stringValue(object.status, `${role}.status`);
  if (status === "unplaced") {
    exactKeys(object, ["status"], [], role);
    return { status };
  }
  if (status === "pending") {
    exactKeys(object, ["status", "pending"], [], role);
    const pendingObject = plainObject(object.pending, `${role}.pending`);
    exactKeys(
      pendingObject,
      ["idempotencyKey", "frameDigest"],
      ["state"],
      `${role}.pending`,
    );
    const pendingFrameDigest = journalDigest(
      pendingObject.frameDigest,
      `${role}.pending.frameDigest`,
    );
    if (pendingFrameDigest !== frameDigest) {
      corrupt("Pending state is bound to a different prepared frame.");
    }
    return {
      status,
      pending: {
        idempotencyKey: journalDigest(
          pendingObject.idempotencyKey,
          `${role}.pending.idempotencyKey`,
        ),
        frameDigest: pendingFrameDigest,
        ...(pendingObject.state === undefined
          ? {}
          : {
              state: decodeOpaqueState(
                pendingObject.state,
                `${role}.pending.state`,
              ),
            }),
      },
    };
  }
  if (status === "confirmed") {
    exactKeys(object, ["status", "result", "placement"], [], role);
    if (object.result !== "placed" && object.result !== "existing") {
      corrupt(`${role}.result must be placed or existing.`);
    }
    return {
      status,
      result: object.result,
      placement: decodePlacement(object.placement, `${role}.placement`),
    };
  }
  return corrupt(`${role}.status is unsupported.`);
}

function encodePartitionPlacement(
  placement: PublicationPartitionPlacement,
): Record<string, unknown> {
  if (placement.status === "unplaced") return { status: "unplaced" };
  if (placement.status === "pending") {
    return {
      status: "pending",
      pending: {
        idempotencyKey: placement.pending.idempotencyKey,
        frameDigest: placement.pending.frameDigest,
        ...(placement.pending.state === undefined
          ? {}
          : { state: encodeOpaqueState(placement.pending.state) }),
      },
    };
  }
  return {
    status: "confirmed",
    result: placement.result,
    placement: encodePlacement(placement.placement),
  };
}

function decodePartition(
  value: unknown,
  expectedOrdinal: number,
): PreparedPublicationPartition {
  const role = `preparedPartitions[${expectedOrdinal}]`;
  const object = plainObject(value, role);
  exactKeys(object, ["ordinal", "prepared", "placement"], [], role);
  const ordinal = safeInteger(object.ordinal, `${role}.ordinal`);
  if (ordinal !== expectedOrdinal) {
    corrupt("Prepared partition ordinals must be contiguous.");
  }
  const preparedObject = plainObject(object.prepared, `${role}.prepared`);
  exactKeys(
    preparedObject,
    [
      "medium",
      "profile",
      "members",
      "frameBytes",
      "frameDigest",
      "frameSize",
    ],
    [],
    `${role}.prepared`,
  );
  if (!Array.isArray(preparedObject.members) || preparedObject.members.length === 0) {
    corrupt("A prepared partition must contain at least one member.");
  }
  const members = preparedObject.members.map((member, index) => {
    const memberObject = plainObject(member, `${role}.prepared.members[${index}]`);
    exactKeys(
      memberObject,
      ["reference"],
      [],
      `${role}.prepared.members[${index}]`,
    );
    return {
      reference: recordReference(
        memberObject.reference,
        `${role}.prepared.members[${index}].reference`,
      ),
    };
  });
  let prepared: PreparedAnnouncement;
  try {
    prepared = snapshotPreparedAnnouncement(
      {
        medium: journalIri(
          preparedObject.medium,
          `${role}.prepared.medium`,
        ),
        profile: journalIri(
          preparedObject.profile,
          `${role}.prepared.profile`,
        ),
        members,
        frameBytes: bytesFromBase64(
          preparedObject.frameBytes,
          `${role}.prepared.frameBytes`,
        ),
        frameDigest: journalDigest(
          preparedObject.frameDigest,
          `${role}.prepared.frameDigest`,
        ),
        frameSize: safeInteger(
          preparedObject.frameSize,
          `${role}.prepared.frameSize`,
        ),
      },
      members,
      String(preparedObject.medium),
      String(preparedObject.profile),
    );
  } catch (cause) {
    return corrupt("A prepared journal frame is inconsistent.", cause);
  }
  return {
    ordinal,
    prepared,
    placement: decodePartitionPlacement(
      object.placement,
      prepared.frameDigest,
      `${role}.placement`,
    ),
  };
}

function encodePartition(
  partition: PreparedPublicationPartition,
): Record<string, unknown> {
  return {
    ordinal: partition.ordinal,
    prepared: {
      medium: partition.prepared.medium,
      profile: partition.prepared.profile,
      members: partition.prepared.members.map(({ reference }) => ({
        reference,
      })),
      frameBytes: base64(
        partition.prepared.frameBytes,
        "Prepared announcement frame bytes",
      ),
      frameDigest: partition.prepared.frameDigest,
      frameSize: partition.prepared.frameSize,
    },
    placement: encodePartitionPlacement(partition.placement),
  };
}

function decodeCapabilities(value: unknown): JournalRepositoryCapabilities {
  const object = plainObject(value, "repositoryCapabilities");
  exactKeys(object, [], ["maxObjectBytes"], "repositoryCapabilities");
  return object.maxObjectBytes === undefined
    ? {}
    : {
        maxObjectBytes: positiveSafeInteger(
          object.maxObjectBytes,
          "repositoryCapabilities.maxObjectBytes",
        ),
      };
}

function decodeStoredArtifacts(
  value: unknown,
): readonly StoredArtifactCheckpoint[] {
  if (!Array.isArray(value)) {
    return corrupt("storedArtifacts must be an array.");
  }
  return value.map((checkpoint, index) => {
    const role = `storedArtifacts[${index}]`;
    const object = plainObject(checkpoint, role);
    exactKeys(object, ["reference", "size"], [], role);
    return {
      reference: artifactReference(object.reference, `${role}.reference`),
      size: safeInteger(object.size, `${role}.size`),
    };
  });
}

function decodeStoredRecords(
  value: unknown,
): readonly StoredRecordCheckpoint[] {
  if (!Array.isArray(value)) return corrupt("storedRecords must be an array.");
  return value.map((checkpoint, index) => {
    const role = `storedRecords[${index}]`;
    const object = plainObject(checkpoint, role);
    exactKeys(object, ["reference", "size"], [], role);
    return {
      reference: recordReference(object.reference, `${role}.reference`),
      size: safeInteger(object.size, `${role}.size`),
    };
  });
}

function assertEntryState(entry: PublicationJournalEntry): void {
  assertCanonicalReferences(entry.artifacts, entry.records);
  if (entry.storedArtifacts.length > entry.artifacts.length) {
    corrupt("Stored artifact checkpoints exceed declared artifacts.");
  }
  entry.storedArtifacts.forEach((checkpoint, index) => {
    if (
      checkpoint.reference.digest !== entry.artifacts[index]?.digest
    ) {
      corrupt("Stored artifacts must be a prefix of declared artifacts.");
    }
  });
  if (
    entry.storedRecords.length > 0 &&
    entry.storedArtifacts.length !== entry.artifacts.length
  ) {
    corrupt("Records cannot be checkpointed before all artifacts.");
  }
  if (entry.storedRecords.length > entry.records.length) {
    corrupt("Stored record checkpoints exceed declared records.");
  }
  entry.storedRecords.forEach((checkpoint, index) => {
    const expected = entry.records[index];
    if (
      checkpoint.reference.family !== expected?.family ||
      checkpoint.reference.digest !== expected.digest
    ) {
      corrupt("Stored records must be a prefix of declared records.");
    }
  });
  const partitions = entry.preparedPartitions;
  if (partitions === undefined) {
    if (entry.completed) corrupt("An unplanned publication cannot be complete.");
    return;
  }
  if (entry.storedRecords.length !== entry.records.length) {
    corrupt("A prepared plan requires every record checkpoint.");
  }
  if (partitions.length === 0) {
    corrupt("A prepared plan cannot be empty.");
  }
  const flattened = partitions.flatMap(({ prepared }) => prepared.members);
  if (
    flattened.length !== entry.records.length ||
    flattened.some((member, index) => {
      const expected = entry.records[index];
      return (
        member.reference.family !== expected?.family ||
        member.reference.digest !== expected.digest
      );
    })
  ) {
    corrupt("Prepared partitions must cover every record exactly once.");
  }
  let placementPhase: "confirmed" | "pending" | "unplaced" = "confirmed";
  for (const partition of partitions) {
    if (partition.placement.status === "confirmed") {
      if (placementPhase !== "confirmed") {
        corrupt("Confirmed placements must form a prefix.");
      }
      continue;
    }
    if (partition.placement.status === "pending") {
      if (placementPhase !== "confirmed") {
        corrupt(
          "Only the first unconfirmed partition may be pending.",
        );
      }
      placementPhase = "pending";
      continue;
    }
    placementPhase = "unplaced";
  }
  if (
    entry.completed &&
    partitions.some(({ placement }) => placement.status !== "confirmed")
  ) {
    corrupt("A publication is complete only after all placements confirm.");
  }
}

function assertEntryIdentity(entry: PublicationJournalEntry): void {
  const expected = derivePublicationIdentities(
    entry.records,
    entry.artifacts,
    entry.destination,
  );
  if (
    entry.bundleKey !== expected.bundleKey ||
    entry.payloadFingerprint !== expected.payloadFingerprint
  ) {
    corrupt(
      "Publication journal identities do not match the canonical references and destination.",
    );
  }
}

function decodeEntryObject(value: unknown): VersionedPublicationJournalEntry {
  const object = plainObject(value, "Publication journal entry");
  exactKeys(
    object,
    [
      "schemaVersion",
      "bundleKey",
      "payloadFingerprint",
      "destination",
      "repositoryCapabilities",
      "artifacts",
      "records",
      "storedArtifacts",
      "storedRecords",
      "completed",
      "revision",
    ],
    ["preparedPartitions"],
    "Publication journal entry",
  );
  if (object.schemaVersion !== 1) {
    corrupt("Unsupported publication journal schema version.");
  }
  if (!Array.isArray(object.artifacts) || !Array.isArray(object.records)) {
    corrupt("Journal references must be arrays.");
  }
  const entry: VersionedPublicationJournalEntry = {
    schemaVersion: 1,
    bundleKey: journalDigest(object.bundleKey, "bundleKey"),
    payloadFingerprint: journalDigest(
      object.payloadFingerprint,
      "payloadFingerprint",
    ),
    destination: journalIri(object.destination, "destination"),
    repositoryCapabilities: decodeCapabilities(
      object.repositoryCapabilities,
    ),
    artifacts: object.artifacts.map((reference, index) =>
      artifactReference(reference, `artifacts[${index}]`)
    ),
    records: object.records.map((reference, index) =>
      recordReference(reference, `records[${index}]`)
    ),
    storedArtifacts: decodeStoredArtifacts(object.storedArtifacts),
    storedRecords: decodeStoredRecords(object.storedRecords),
    ...(object.preparedPartitions === undefined
      ? {}
      : {
          preparedPartitions: Array.isArray(object.preparedPartitions)
            ? object.preparedPartitions.map(decodePartition)
            : corrupt("preparedPartitions must be an array."),
        }),
    completed: booleanValue(object.completed, "completed"),
    revision: safeInteger(object.revision, "revision"),
  };
  assertEntryState(entry);
  assertEntryIdentity(entry);
  return entry;
}

function encodeEntryObject(
  entry: VersionedPublicationJournalEntry,
): Record<string, unknown> {
  return {
    schemaVersion: entry.schemaVersion,
    bundleKey: entry.bundleKey,
    payloadFingerprint: entry.payloadFingerprint,
    destination: entry.destination,
    repositoryCapabilities: {
      ...(entry.repositoryCapabilities.maxObjectBytes === undefined
        ? {}
        : { maxObjectBytes: entry.repositoryCapabilities.maxObjectBytes }),
    },
    artifacts: entry.artifacts.map(({ digest }) => ({ digest })),
    records: entry.records.map(({ family, digest }) => ({ family, digest })),
    storedArtifacts: entry.storedArtifacts.map(({ reference, size }) => ({
      reference,
      size,
    })),
    storedRecords: entry.storedRecords.map(({ reference, size }) => ({
      reference,
      size,
    })),
    ...(entry.preparedPartitions === undefined
      ? {}
      : {
          preparedPartitions: entry.preparedPartitions.map(encodePartition),
        }),
    completed: entry.completed,
    revision: entry.revision,
  };
}

export function decodeVersionedPublicationJournalEntry(
  bytes: Uint8Array,
): VersionedPublicationJournalEntry {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch (cause) {
    return corrupt("Publication journal bytes are not valid UTF-8 JSON.", cause);
  }
  return decodeEntryObject(value);
}

export function encodeVersionedPublicationJournalEntry(
  entry: VersionedPublicationJournalEntry,
): Uint8Array {
  const snapshot = decodeEntryObject(encodeEntryObject(entry));
  return encoder.encode(`${JSON.stringify(encodeEntryObject(snapshot))}\n`);
}

export function snapshotPublicationJournalEntry(
  entry: PublicationJournalEntry,
): PublicationJournalEntry {
  const versioned = decodeEntryObject(
    encodeEntryObject({ ...entry, revision: 0 }),
  );
  const { revision: _revision, ...snapshot } = versioned;
  return snapshot;
}

export function snapshotInitialPublicationJournalEntry(
  entry: PublicationJournalEntry,
): PublicationJournalEntry {
  const snapshot = snapshotPublicationJournalEntry(entry);
  if (
    snapshot.storedArtifacts.length !== 0 ||
    snapshot.storedRecords.length !== 0 ||
    snapshot.preparedPartitions !== undefined ||
    snapshot.completed
  ) {
    corrupt(
      "A new publication journal entry cannot contain durable checkpoints, a prepared plan, or completion.",
    );
  }
  return snapshot;
}

export function cloneVersionedPublicationJournalEntry(
  entry: VersionedPublicationJournalEntry,
): VersionedPublicationJournalEntry {
  return decodeVersionedPublicationJournalEntry(
    encodeVersionedPublicationJournalEntry(entry),
  );
}

function immutableIdentity(entry: PublicationJournalEntry): string {
  return JSON.stringify({
    schemaVersion: entry.schemaVersion,
    bundleKey: entry.bundleKey,
    payloadFingerprint: entry.payloadFingerprint,
    destination: entry.destination,
    repositoryCapabilities: entry.repositoryCapabilities,
    artifacts: entry.artifacts,
    records: entry.records,
  });
}

function samePrepared(
  left: PreparedPublicationPartition,
  right: PreparedPublicationPartition,
): boolean {
  return JSON.stringify(encodePartition({
    ...left,
    placement: { status: "unplaced" },
  })) === JSON.stringify(encodePartition({
    ...right,
    placement: { status: "unplaced" },
  }));
}

function checkpointsEqual(
  left: readonly (StoredArtifactCheckpoint | StoredRecordCheckpoint)[],
  right: readonly (StoredArtifactCheckpoint | StoredRecordCheckpoint)[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function placementEqual(
  left: PublicationPartitionPlacement,
  right: PublicationPartitionPlacement,
): boolean {
  return JSON.stringify(encodePartitionPlacement(left)) ===
    JSON.stringify(encodePartitionPlacement(right));
}

function assertSinglePlacementStep(
  previous: PublicationPartitionPlacement,
  next: PublicationPartitionPlacement,
): void {
  if (
    previous.status === "unplaced" &&
    next.status === "pending" &&
    next.pending.state === undefined
  ) {
    return;
  }
  if (previous.status === "pending" && next.status === "pending") {
    if (
      previous.pending.idempotencyKey === next.pending.idempotencyKey &&
      previous.pending.frameDigest === next.pending.frameDigest &&
      !placementEqual(previous, next)
    ) {
      return;
    }
  }
  if (previous.status === "pending" && next.status === "confirmed") {
    return;
  }
  corrupt(
    "A journal transition skipped or rewrote a required placement step.",
  );
}

export function validateJournalTransition(
  expected: VersionedPublicationJournalEntry,
  nextInput: PublicationJournalEntry,
): PublicationJournalEntry {
  const previous = cloneVersionedPublicationJournalEntry(expected);
  const next = snapshotPublicationJournalEntry(nextInput);
  if (immutableIdentity(previous) !== immutableIdentity(next)) {
    corrupt("A journal transition changed immutable publication identity.");
  }
  let durableSteps = 0;
  const artifactDelta =
    next.storedArtifacts.length - previous.storedArtifacts.length;
  if (
    artifactDelta < 0 ||
    artifactDelta > 1 ||
    !checkpointsEqual(
      previous.storedArtifacts,
      next.storedArtifacts.slice(0, previous.storedArtifacts.length),
    )
  ) {
    corrupt("A journal transition changed or skipped artifact checkpoints.");
  }
  durableSteps += artifactDelta;

  const recordDelta =
    next.storedRecords.length - previous.storedRecords.length;
  if (
    recordDelta < 0 ||
    recordDelta > 1 ||
    !checkpointsEqual(
      previous.storedRecords,
      next.storedRecords.slice(0, previous.storedRecords.length),
    )
  ) {
    corrupt("A journal transition changed or skipped record checkpoints.");
  }
  durableSteps += recordDelta;

  if (
    previous.preparedPartitions !== undefined &&
    (
      next.preparedPartitions === undefined ||
      next.preparedPartitions.length !== previous.preparedPartitions.length
    )
  ) {
    corrupt("A frozen prepared plan cannot be removed or repartitioned.");
  }
  if (
    previous.preparedPartitions === undefined &&
    next.preparedPartitions !== undefined
  ) {
    if (
      next.preparedPartitions.some(
        ({ placement }) => placement.status !== "unplaced",
      )
    ) {
      corrupt("A newly frozen prepared plan must be entirely unplaced.");
    }
    durableSteps += 1;
  } else if (
    previous.preparedPartitions !== undefined &&
    next.preparedPartitions !== undefined
  ) {
    let changedPlacements = 0;
    previous.preparedPartitions.forEach((partition, index) => {
      const candidate = next.preparedPartitions![index]!;
      if (!samePrepared(partition, candidate)) {
        corrupt("A frozen prepared partition cannot change.");
      }
      if (!placementEqual(partition.placement, candidate.placement)) {
        assertSinglePlacementStep(
          partition.placement,
          candidate.placement,
        );
        changedPlacements += 1;
      }
    });
    if (changedPlacements > 1) {
      corrupt(
        "A journal revision cannot change more than one placement checkpoint.",
      );
    }
    durableSteps += changedPlacements;
  }

  if (previous.completed && !next.completed) {
    corrupt("A completed publication cannot become incomplete.");
  }
  if (!previous.completed && next.completed) durableSteps += 1;

  if (durableSteps !== 1) {
    corrupt("A journal revision must contain exactly one durable step.");
  }
  return next;
}

export function journalEntryDigest(
  entry: VersionedPublicationJournalEntry,
): Sha256Digest {
  return hashExactBytes(encodeVersionedPublicationJournalEntry(entry));
}

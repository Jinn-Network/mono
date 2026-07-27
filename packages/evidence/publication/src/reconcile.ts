// SPDX-License-Identifier: Apache-2.0
import { isProxy } from "node:util/types";

import type {
  RepositoryOperationOptions,
  Sha256Digest,
} from "@jinn-network/evidence-repository";

import {
  assertPublicationOperationActive,
  EvidencePublicationError,
} from "./errors.js";
import {
  derivePlacementIdempotencyKey,
  snapshotPreparedAnnouncement,
} from "./identities.js";
import { cloneVersionedPublicationJournalEntry } from "./journal.js";
import type {
  OpaqueSinkState,
  PendingAnnouncement,
  PlaceResult,
  Placement,
  PreparedPublicationPartition,
  PublicationDependencies,
  PublicationJournalEntry,
  PublicationPartitionPlacement,
  PublicationReceipt,
  ReconcileResult,
  VersionedPublicationJournalEntry,
} from "./types.js";
import {
  assertAbsoluteIri,
  parsePublicationDigest,
  snapshotExactBytes,
  snapshotPublicationOperationOptions,
} from "./validation.js";

function journalConflict(error: unknown): boolean {
  return (
    error instanceof EvidencePublicationError &&
    error.code === "JOURNAL_CONFLICT"
  );
}

function sinkViolation(message: string, cause?: unknown): never {
  throw new EvidencePublicationError(
    "SINK_PROTOCOL_VIOLATION",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function sinkResultObject(value: unknown, role: string): object {
  if (
    typeof value !== "object" ||
    value === null ||
    isProxy(value)
  ) {
    return sinkViolation(`${role} must be a non-proxy object.`);
  }
  return value;
}

function ownData(
  value: object,
  name: string,
  role: string,
): unknown {
  const descriptor = Reflect.getOwnPropertyDescriptor(value, name);
  if (
    descriptor === undefined ||
    !Object.hasOwn(descriptor, "value")
  ) {
    return sinkViolation(`${role}.${name} must be an own data property.`);
  }
  return descriptor.value;
}

function optionalOwnData(
  value: object,
  name: string,
  role: string,
): unknown {
  const descriptor = Reflect.getOwnPropertyDescriptor(value, name);
  if (descriptor === undefined) return undefined;
  if (!Object.hasOwn(descriptor, "value")) {
    return sinkViolation(`${role}.${name} must be an own data property.`);
  }
  return descriptor.value;
}

function resultStatus(value: unknown, role: string): {
  readonly object: object;
  readonly status: string;
} {
  const object = sinkResultObject(value, role);
  const status = ownData(object, "status", role);
  if (typeof status !== "string") {
    return sinkViolation(`${role}.status must be a string data property.`);
  }
  return { object, status };
}

function snapshotOpaqueState(
  value: unknown,
  role: string,
): OpaqueSinkState {
  const object = sinkResultObject(value, role);
  let format: string;
  try {
    format = assertAbsoluteIri(
      ownData(object, "format", role),
      `${role}.format`,
    );
  } catch (cause) {
    return sinkViolation(`${role}.format is invalid.`, cause);
  }
  const bytes = ownData(object, "bytes", role);
  const snapshot = snapshotExactBytes(bytes);
  if (snapshot === undefined) {
    return sinkViolation(
      `${role}.bytes must be a non-proxy Uint8Array.`,
    );
  }
  return { format, bytes: snapshot };
}

function snapshotPlacement(value: unknown, role: string): Placement {
  const object = sinkResultObject(value, role);
  const externalId = ownData(object, "externalId", role);
  if (
    typeof externalId !== "string" ||
    externalId.length === 0
  ) {
    return sinkViolation(`${role}.externalId must be a non-empty string.`);
  }
  const state = optionalOwnData(object, "state", role);
  return {
    externalId,
    ...(state === undefined
      ? {}
      : { state: snapshotOpaqueState(state, `${role}.state`) }),
  };
}

function snapshotPending(
  value: unknown,
  expectedIdempotencyKey: Sha256Digest,
  expectedFrameDigest: Sha256Digest,
  role: string,
): PendingAnnouncement {
  const object = sinkResultObject(value, role);
  const idempotencyKey = ownData(object, "idempotencyKey", role);
  const frameDigest = ownData(object, "frameDigest", role);
  if (
    idempotencyKey !== expectedIdempotencyKey ||
    frameDigest !== expectedFrameDigest
  ) {
    return sinkViolation(
      `${role} is bound to a different placement identity or frame.`,
    );
  }
  const state = optionalOwnData(object, "state", role);
  return {
    idempotencyKey: expectedIdempotencyKey,
    frameDigest: expectedFrameDigest,
    ...(state === undefined
      ? {}
      : { state: snapshotOpaqueState(state, `${role}.state`) }),
  };
}

function exactBytesEqual(
  left: Uint8Array,
  right: Uint8Array,
): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index])
  );
}

function samePendingAnnouncement(
  left: PendingAnnouncement,
  right: PendingAnnouncement,
): boolean {
  if (
    left.idempotencyKey !== right.idempotencyKey ||
    left.frameDigest !== right.frameDigest
  ) {
    return false;
  }
  if (left.state === undefined || right.state === undefined) {
    return left.state === right.state;
  }
  return (
    left.state.format === right.state.format &&
    exactBytesEqual(left.state.bytes, right.state.bytes)
  );
}

type CheckedPlaceResult =
  | {
      readonly status: "placed" | "existing";
      readonly placement: Placement;
    }
  | {
      readonly status: "pending";
      readonly pending: PendingAnnouncement;
    };

function snapshotPlaceResult(
  value: PlaceResult,
  idempotencyKey: Sha256Digest,
  frameDigest: Sha256Digest,
): CheckedPlaceResult {
  const { object, status } = resultStatus(value, "Place result");
  if (status === "pending") {
    return {
      status: "pending",
      pending: snapshotPending(
        ownData(object, "pending", "Place result"),
        idempotencyKey,
        frameDigest,
        "Place result pending state",
      ),
    };
  }
  if (status === "placed" || status === "existing") {
    return {
      status,
      placement: snapshotPlacement(
        ownData(object, "placement", "Place result"),
        "Place result placement",
      ),
    };
  }
  return sinkViolation("The sink returned an unsupported place result.");
}

type CheckedReconcileResult =
  | CheckedPlaceResult
  | { readonly status: "not-found" }
  | {
      readonly status: "reverted";
      readonly externalId?: string;
      readonly reason?: string;
    };

function snapshotReconcileResult(
  value: ReconcileResult,
  idempotencyKey: Sha256Digest,
  frameDigest: Sha256Digest,
): CheckedReconcileResult {
  const { object, status } = resultStatus(value, "Reconcile result");
  if (status === "not-found") {
    return { status: "not-found" };
  }
  if (status === "reverted") {
    const externalId = optionalOwnData(
      object,
      "externalId",
      "Reconcile result",
    );
    const reason = optionalOwnData(object, "reason", "Reconcile result");
    if (
      externalId !== undefined &&
      (typeof externalId !== "string" || externalId.length === 0)
    ) {
      return sinkViolation(
        "Reconcile reversion externalId must be a non-empty string.",
      );
    }
    if (
      reason !== undefined &&
      (typeof reason !== "string" || reason.length === 0)
    ) {
      return sinkViolation(
        "Reconcile reversion reason must be a non-empty string.",
      );
    }
    return {
      status: "reverted",
      ...(externalId === undefined
        ? {}
        : { externalId: externalId as string }),
      ...(reason === undefined
        ? {}
        : { reason: reason as string }),
    };
  }
  return snapshotPlaceResult(
    value as PlaceResult,
    idempotencyKey,
    frameDigest,
  );
}

async function loadEntry(
  bundleKey: Sha256Digest,
  dependencies: PublicationDependencies,
  options?: RepositoryOperationOptions,
): Promise<VersionedPublicationJournalEntry> {
  assertPublicationOperationActive(options);
  const entry = await dependencies.journal.load(bundleKey, options);
  assertPublicationOperationActive(options);
  if (entry === null) {
    throw new EvidencePublicationError(
      "JOURNAL_CORRUPT",
      "The publication journal entry disappeared during recovery.",
    );
  }
  return cloneVersionedPublicationJournalEntry(entry);
}

async function checkpoint(
  expected: VersionedPublicationJournalEntry,
  next: PublicationJournalEntry,
  dependencies: PublicationDependencies,
  options?: RepositoryOperationOptions,
): Promise<VersionedPublicationJournalEntry> {
  assertPublicationOperationActive(options);
  try {
    const versioned = await dependencies.journal.compareAndSwap(
      expected,
      next,
      options,
    );
    assertPublicationOperationActive(options);
    return versioned;
  } catch (error) {
    if (!journalConflict(error)) throw error;
    return loadEntry(expected.bundleKey, dependencies, options);
  }
}

async function checkpointNewIntent(
  expected: VersionedPublicationJournalEntry,
  next: PublicationJournalEntry,
  dependencies: PublicationDependencies,
  options?: RepositoryOperationOptions,
): Promise<{
  readonly entry: VersionedPublicationJournalEntry;
  readonly writtenByCaller: boolean;
}> {
  assertPublicationOperationActive(options);
  try {
    const entry = await dependencies.journal.compareAndSwap(
      expected,
      next,
      options,
    );
    assertPublicationOperationActive(options);
    return { entry, writtenByCaller: true };
  } catch (error) {
    if (!journalConflict(error)) throw error;
    return {
      entry: await loadEntry(expected.bundleKey, dependencies, options),
      writtenByCaller: false,
    };
  }
}

function expectedPlacementKey(
  entry: VersionedPublicationJournalEntry,
  partition: PreparedPublicationPartition,
  dependencies: PublicationDependencies,
): Sha256Digest {
  return derivePlacementIdempotencyKey({
    bundleKey: entry.bundleKey,
    destination: entry.destination,
    partitionOrdinal: partition.ordinal,
    frameDigest: partition.prepared.frameDigest,
    medium: partition.prepared.medium,
    profile: partition.prepared.profile,
  });
}

function validateFrozenPlan(
  entry: VersionedPublicationJournalEntry,
  dependencies: PublicationDependencies,
): void {
  if (entry.preparedPartitions === undefined) {
    throw new EvidencePublicationError(
      "JOURNAL_CORRUPT",
      "Publication placement requires a frozen prepared plan.",
    );
  }
  for (const partition of entry.preparedPartitions) {
    if (partition.prepared.medium !== dependencies.sink.medium) {
      throw new EvidencePublicationError(
        "SINK_PROTOCOL_VIOLATION",
        "The frozen announcement medium differs from the injected sink.",
      );
    }
    if (partition.prepared.profile !== dependencies.sink.profile) {
      throw new EvidencePublicationError(
        "SINK_PROTOCOL_VIOLATION",
        "The frozen announcement profile differs from the injected sink.",
      );
    }
    snapshotPreparedAnnouncement(
      partition.prepared,
      partition.prepared.members,
      dependencies.sink.medium,
      dependencies.sink.profile,
    );
    if (partition.placement.status === "pending") {
      const expected = expectedPlacementKey(
        entry,
        partition,
        dependencies,
      );
      if (
        partition.placement.pending.idempotencyKey !== expected ||
        partition.placement.pending.frameDigest !==
          partition.prepared.frameDigest
      ) {
        throw new EvidencePublicationError(
          "JOURNAL_CORRUPT",
          "A pending placement is bound to the wrong identity.",
        );
      }
    }
  }
}

function replacePlacement(
  entry: VersionedPublicationJournalEntry,
  ordinal: number,
  placement: PublicationPartitionPlacement,
): PublicationJournalEntry {
  return {
    ...entry,
    preparedPartitions: entry.preparedPartitions!.map((partition) =>
      partition.ordinal === ordinal
        ? { ...partition, placement }
        : partition
    ),
  };
}

function publicationReceipt(
  entry: VersionedPublicationJournalEntry,
): PublicationReceipt {
  if (
    !entry.completed ||
    entry.preparedPartitions === undefined ||
    entry.preparedPartitions.some(
      ({ placement }) => placement.status !== "confirmed",
    )
  ) {
    throw new EvidencePublicationError(
      "JOURNAL_CORRUPT",
      "A stable receipt requires a completed publication.",
    );
  }
  return {
    bundleKey: entry.bundleKey,
    payloadFingerprint: entry.payloadFingerprint,
    destination: entry.destination,
    artifacts: entry.artifacts.map((reference) => ({ ...reference })),
    records: entry.records.map((reference) => ({ ...reference })),
    placements: entry.preparedPartitions.map((partition) => {
      if (partition.placement.status !== "confirmed") {
        throw new EvidencePublicationError(
          "JOURNAL_CORRUPT",
          "A completed receipt contains an unconfirmed placement.",
        );
      }
      return {
        ordinal: partition.ordinal,
        frameDigest: partition.prepared.frameDigest,
        result: partition.placement.result,
        placement: structuredClone(partition.placement.placement),
      };
    }),
    completed: true,
  };
}

async function placeAfterIntent(
  entry: VersionedPublicationJournalEntry,
  partition: PreparedPublicationPartition,
  idempotencyKey: Sha256Digest,
  dependencies: PublicationDependencies,
  options?: RepositoryOperationOptions,
): Promise<VersionedPublicationJournalEntry> {
  assertPublicationOperationActive(options);
  const expectedPrepared = snapshotPreparedAnnouncement(
    partition.prepared,
    partition.prepared.members,
    dependencies.sink.medium,
    dependencies.sink.profile,
  );
  const suppliedPrepared = snapshotPreparedAnnouncement(
    expectedPrepared,
    expectedPrepared.members,
    dependencies.sink.medium,
    dependencies.sink.profile,
  );
  const result = await dependencies.sink.place(
    suppliedPrepared,
    idempotencyKey,
    options,
  );
  assertPublicationOperationActive(options);
  const checked = snapshotPlaceResult(
    result,
    idempotencyKey,
    expectedPrepared.frameDigest,
  );
  if (checked.status === "pending") {
    const checkpointed =
      partition.placement.status === "pending" &&
        samePendingAnnouncement(
          partition.placement.pending,
          checked.pending,
        )
        ? entry
        : await checkpoint(
          entry,
          replacePlacement(entry, partition.ordinal, {
            status: "pending",
            pending: checked.pending,
          }),
          dependencies,
          options,
        );
    if (
      checkpointed.preparedPartitions?.[partition.ordinal]?.placement
        .status === "confirmed"
    ) {
      return checkpointed;
    }
    throw new EvidencePublicationError(
      "PLACEMENT_UNCERTAIN",
      "Announcement placement remains pending.",
    );
  }
  return checkpoint(
    entry,
    replacePlacement(entry, partition.ordinal, {
      status: "confirmed",
      result: checked.status,
      placement: checked.placement,
    }),
    dependencies,
    options,
  );
}

export async function continuePublicationPlacements(
  initial: VersionedPublicationJournalEntry,
  dependencies: PublicationDependencies,
  options?: RepositoryOperationOptions,
): Promise<PublicationReceipt> {
  const operationOptions = snapshotPublicationOperationOptions(options);
  let entry = initial;

  while (!entry.completed) {
    validateFrozenPlan(entry, dependencies);
    const partition = entry.preparedPartitions!.find(
      ({ placement }) => placement.status !== "confirmed",
    );
    if (partition === undefined) {
      entry = await checkpoint(
        entry,
        { ...entry, completed: true },
        dependencies,
        operationOptions,
      );
      continue;
    }

    const idempotencyKey = expectedPlacementKey(
      entry,
      partition,
      dependencies,
    );
    if (partition.placement.status === "unplaced") {
      const intent = {
        idempotencyKey,
        frameDigest: partition.prepared.frameDigest,
      } as const;
      const checkpointed = await checkpointNewIntent(
        entry,
        replacePlacement(entry, partition.ordinal, {
          status: "pending",
          pending: intent,
        }),
        dependencies,
        operationOptions,
      );
      entry = checkpointed.entry;
      if (checkpointed.writtenByCaller) {
        entry = await placeAfterIntent(
          entry,
          entry.preparedPartitions![partition.ordinal]!,
          idempotencyKey,
          dependencies,
          operationOptions,
        );
      }
      continue;
    }

    if (partition.placement.status !== "pending") continue;
    if (
      partition.placement.pending.idempotencyKey !== idempotencyKey ||
      partition.placement.pending.frameDigest !==
        partition.prepared.frameDigest
    ) {
      throw new EvidencePublicationError(
        "JOURNAL_CORRUPT",
        "A pending placement has an invalid identity.",
      );
    }

    assertPublicationOperationActive(operationOptions);
    const expectedPrepared = snapshotPreparedAnnouncement(
      partition.prepared,
      partition.prepared.members,
      dependencies.sink.medium,
      dependencies.sink.profile,
    );
    const suppliedPrepared = snapshotPreparedAnnouncement(
      expectedPrepared,
      expectedPrepared.members,
      dependencies.sink.medium,
      dependencies.sink.profile,
    );
    const expectedPending = snapshotPending(
      partition.placement.pending,
      idempotencyKey,
      expectedPrepared.frameDigest,
      "Journaled pending placement",
    );
    const suppliedPending = snapshotPending(
      expectedPending,
      idempotencyKey,
      expectedPrepared.frameDigest,
      "Supplied pending placement",
    );
    const result = await dependencies.sink.reconcile(
      suppliedPrepared,
      suppliedPending,
      operationOptions,
    );
    assertPublicationOperationActive(operationOptions);
    const checked = snapshotReconcileResult(
      result,
      idempotencyKey,
      expectedPrepared.frameDigest,
    );

    if (checked.status === "not-found") {
      entry = await placeAfterIntent(
        entry,
        partition,
        idempotencyKey,
        dependencies,
        operationOptions,
      );
      continue;
    }
    if (checked.status === "reverted") {
      throw new EvidencePublicationError(
        "PLACEMENT_REVERTED",
        checked.reason === undefined
          ? "The announcement placement was confirmed reverted."
          : `The announcement placement was confirmed reverted: ${checked.reason}`,
      );
    }
    if (checked.status === "pending") {
      if (
        !samePendingAnnouncement(
          partition.placement.pending,
          checked.pending,
        )
      ) {
        entry = await checkpoint(
          entry,
          replacePlacement(entry, partition.ordinal, {
            status: "pending",
            pending: checked.pending,
          }),
          dependencies,
          operationOptions,
        );
        const checkpointedPlacement = entry.preparedPartitions?.find(
          ({ ordinal }) => ordinal === partition.ordinal,
        )?.placement;
        if (checkpointedPlacement?.status === "confirmed") {
          continue;
        }
      }
      throw new EvidencePublicationError(
        "PLACEMENT_UNCERTAIN",
        "Announcement placement remains pending.",
      );
    }
    entry = await checkpoint(
      entry,
      replacePlacement(entry, partition.ordinal, {
        status: "confirmed",
        result: checked.status,
        placement: checked.placement,
      }),
      dependencies,
      operationOptions,
    );
  }

  validateFrozenPlan(entry, dependencies);
  return publicationReceipt(entry);
}

export async function reconcile(
  untrustedBundleKey: Sha256Digest,
  dependencies: PublicationDependencies,
  options?: RepositoryOperationOptions,
): Promise<PublicationReceipt> {
  const operationOptions = snapshotPublicationOperationOptions(options);
  const bundleKey = parsePublicationDigest(
    untrustedBundleKey,
    "Publication bundle key",
  );
  const entry = await loadEntry(
    bundleKey,
    dependencies,
    operationOptions,
  );
  return continuePublicationPlacements(
    entry,
    dependencies,
    operationOptions,
  );
}

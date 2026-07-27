// SPDX-License-Identifier: Apache-2.0
import {
  EvidenceRepositoryError,
  type EvidenceArtifactReference,
  type EvidenceRecordReference,
  type RepositoryWriteReceipt,
} from "@jinn-network/evidence-repository";

import { EvidencePublicationError } from "./errors.js";
import { normalizePublishInput } from "./identities.js";
import {
  createPublicationOperation,
  isEvidencePublicationErrorCode,
  type PublicationOperation,
} from "./operation.js";
import {
  prepareAnnouncementPartitionsWithOperation,
} from "./partition-internal.js";
import { continuePublicationPlacements } from "./reconcile.js";
import type {
  NormalizedPublishInput,
  PublicationDependencies,
  PublicationJournalEntry,
  PublicationReceipt,
  PublishInput,
  VersionedPublicationJournalEntry,
} from "./types.js";
import {
  readRepositoryCapabilities,
} from "./validation.js";

function journalConflict(error: unknown): boolean {
  return isEvidencePublicationErrorCode(error, "JOURNAL_CONFLICT");
}

function sameRecord(
  left: EvidenceRecordReference,
  right: EvidenceRecordReference,
): boolean {
  return left.family === right.family && left.digest === right.digest;
}

function sameArtifact(
  left: EvidenceArtifactReference,
  right: EvidenceArtifactReference,
): boolean {
  return left.digest === right.digest;
}

function validateExistingEntry(
  entry: VersionedPublicationJournalEntry,
  normalized: NormalizedPublishInput,
): void {
  if (
    entry.payloadFingerprint !== normalized.payloadFingerprint ||
    entry.destination !== normalized.destination ||
    entry.records.length !== normalized.records.length ||
    entry.artifacts.length !== normalized.artifacts.length ||
    entry.records.some(
      (reference, index) =>
        !sameRecord(reference, normalized.records[index]!.reference),
    ) ||
    entry.artifacts.some(
      (reference, index) =>
        !sameArtifact(reference, normalized.artifacts[index]!.reference),
    )
  ) {
    throw new EvidencePublicationError(
      "BUNDLE_CONFLICT",
      "The bundle key is already journaled with different publication input.",
    );
  }
  entry.storedArtifacts.forEach((checkpoint, index) => {
    if (
      !sameArtifact(
        checkpoint.reference,
        normalized.artifacts[index]!.reference,
      ) ||
      checkpoint.size !== normalized.artifacts[index]!.bytes.byteLength
    ) {
      throw new EvidencePublicationError(
        "JOURNAL_CORRUPT",
        "A stored artifact checkpoint does not match the exact input.",
      );
    }
  });
  entry.storedRecords.forEach((checkpoint, index) => {
    if (
      !sameRecord(
        checkpoint.reference,
        normalized.records[index]!.reference,
      ) ||
      checkpoint.size !== normalized.records[index]!.bytes.byteLength
    ) {
      throw new EvidencePublicationError(
        "JOURNAL_CORRUPT",
        "A stored record checkpoint does not match the exact input.",
      );
    }
  });
}

function preflightRemainingBytes(
  normalized: NormalizedPublishInput,
  maxObjectBytes: number | undefined,
  storedArtifactCount = 0,
  storedRecordCount = 0,
): void {
  if (maxObjectBytes === undefined) return;
  const oversized = [
    ...normalized.artifacts.slice(storedArtifactCount),
    ...normalized.records.slice(storedRecordCount),
  ].find(({ bytes }) => bytes.byteLength > maxObjectBytes);
  if (oversized !== undefined) {
    throw new EvidencePublicationError(
      "REPOSITORY_CAPABILITY_EXCEEDED",
      `Publication object size ${oversized.bytes.byteLength} exceeds the repository limit ${maxObjectBytes}.`,
    );
  }
}

async function loadEntry(
  normalized: NormalizedPublishInput,
  dependencies: PublicationDependencies,
  operation: PublicationOperation,
): Promise<VersionedPublicationJournalEntry | null> {
  const { value: entry } = await operation.waitFor(
    () =>
      dependencies.journal.load(
        normalized.bundleKey,
        operation.dependencyOptions,
      ),
  );
  return entry;
}

async function createEntry(
  normalized: NormalizedPublishInput,
  maxObjectBytes: number | undefined,
  dependencies: PublicationDependencies,
  operation: PublicationOperation,
): Promise<VersionedPublicationJournalEntry> {
  const initial: PublicationJournalEntry = {
    schemaVersion: 1,
    bundleKey: normalized.bundleKey,
    payloadFingerprint: normalized.payloadFingerprint,
    destination: normalized.destination,
    repositoryCapabilities:
      maxObjectBytes === undefined ? {} : { maxObjectBytes },
    artifacts: normalized.artifacts.map(({ reference }) => reference),
    records: normalized.records.map(({ reference }) => reference),
    storedArtifacts: [],
    storedRecords: [],
    completed: false,
  };
  try {
    const { value: created } = await operation.waitFor(
      () =>
        dependencies.journal.create(
          initial,
          operation.dependencyOptions,
        ),
    );
    return created;
  } catch (error) {
    if (!journalConflict(error)) throw error;
    const concurrent = await loadEntry(
      normalized,
      dependencies,
      operation,
    );
    if (concurrent === null) throw error;
    validateExistingEntry(concurrent, normalized);
    return concurrent;
  }
}

async function checkpoint(
  expected: VersionedPublicationJournalEntry,
  next: PublicationJournalEntry,
  normalized: NormalizedPublishInput,
  dependencies: PublicationDependencies,
  operation: PublicationOperation,
): Promise<VersionedPublicationJournalEntry> {
  try {
    const { value: versioned } = await operation.waitFor(
      () =>
        dependencies.journal.compareAndSwap(
          expected,
          next,
          operation.dependencyOptions,
        ),
    );
    return versioned;
  } catch (error) {
    if (!journalConflict(error)) throw error;
    const concurrent = await loadEntry(
      normalized,
      dependencies,
      operation,
    );
    if (concurrent === null) {
      throw new EvidencePublicationError(
        "JOURNAL_CORRUPT",
        "The publication journal disappeared during a concurrent update.",
        { cause: error },
      );
    }
    validateExistingEntry(concurrent, normalized);
    return concurrent;
  }
}

function assertArtifactReceipt(
  receipt: RepositoryWriteReceipt<EvidenceArtifactReference>,
  expected: EvidenceArtifactReference,
  size: number,
): void {
  if (!sameArtifact(receipt.reference, expected) || receipt.size !== size) {
    throw new EvidenceRepositoryError(
      "REFERENCE_CONFLICT",
      "The repository returned an artifact receipt for different exact bytes.",
    );
  }
}

function assertRecordReceipt(
  receipt: RepositoryWriteReceipt<EvidenceRecordReference>,
  expected: EvidenceRecordReference,
  size: number,
): void {
  if (!sameRecord(receipt.reference, expected) || receipt.size !== size) {
    throw new EvidenceRepositoryError(
      "REFERENCE_CONFLICT",
      "The repository returned a record receipt for different exact bytes.",
    );
  }
}

async function storeObjects(
  initial: VersionedPublicationJournalEntry,
  normalized: NormalizedPublishInput,
  dependencies: PublicationDependencies,
  operation: PublicationOperation,
): Promise<VersionedPublicationJournalEntry> {
  let entry = initial;

  while (entry.storedArtifacts.length < normalized.artifacts.length) {
    const index = entry.storedArtifacts.length;
    const artifact = normalized.artifacts[index]!;
    const { value: receipt } = await operation.waitFor(
      () =>
        dependencies.repository.putArtifact(
          artifact.bytes,
          operation.dependencyOptions,
        ),
    );
    assertArtifactReceipt(
      receipt,
      artifact.reference,
      artifact.bytes.byteLength,
    );
    entry = await checkpoint(
      entry,
      {
        ...entry,
        storedArtifacts: [
          ...entry.storedArtifacts,
          {
            reference: artifact.reference,
            size: artifact.bytes.byteLength,
          },
        ],
      },
      normalized,
      dependencies,
      operation,
    );
  }

  while (entry.storedRecords.length < normalized.records.length) {
    const index = entry.storedRecords.length;
    const record = normalized.records[index]!;
    const { value: receipt } = await operation.waitFor(
      () =>
        dependencies.repository.putRecord(
          record.reference.family,
          record.bytes,
          operation.dependencyOptions,
        ),
    );
    assertRecordReceipt(
      receipt,
      record.reference,
      record.bytes.byteLength,
    );
    entry = await checkpoint(
      entry,
      {
        ...entry,
        storedRecords: [
          ...entry.storedRecords,
          {
            reference: record.reference,
            size: record.bytes.byteLength,
          },
        ],
      },
      normalized,
      dependencies,
      operation,
    );
  }

  return entry;
}

async function preparePlan(
  initial: VersionedPublicationJournalEntry,
  normalized: NormalizedPublishInput,
  dependencies: PublicationDependencies,
  operation: PublicationOperation,
): Promise<VersionedPublicationJournalEntry> {
  let entry = initial;
  while (entry.preparedPartitions === undefined) {
    const partitions = await prepareAnnouncementPartitionsWithOperation(
      entry.records.map((reference) => ({ reference })),
      entry.destination,
      dependencies.sink,
      operation,
    );
    entry = await checkpoint(
      entry,
      { ...entry, preparedPartitions: partitions },
      normalized,
      dependencies,
      operation,
    );
  }
  return entry;
}

export async function publish(
  input: PublishInput,
  dependencies: PublicationDependencies,
): Promise<PublicationReceipt> {
  const operation = createPublicationOperation(input);
  try {
    const normalized = normalizePublishInput(input);
    operation.assertActive();
    const capabilities = readRepositoryCapabilities(
      dependencies.repository,
    );
    let entry = await loadEntry(normalized, dependencies, operation);

    if (entry === null) {
      preflightRemainingBytes(
        normalized,
        capabilities.maxObjectBytes,
      );
      entry = await createEntry(
        normalized,
        capabilities.maxObjectBytes,
        dependencies,
        operation,
      );
    } else {
      validateExistingEntry(entry, normalized);
      preflightRemainingBytes(
        normalized,
        capabilities.maxObjectBytes,
        entry.storedArtifacts.length,
        entry.storedRecords.length,
      );
    }

    validateExistingEntry(entry, normalized);
    entry = await storeObjects(
      entry,
      normalized,
      dependencies,
      operation,
    );
    entry = await preparePlan(
      entry,
      normalized,
      dependencies,
      operation,
    );
    const receipt = await continuePublicationPlacements(
      entry,
      dependencies,
      operation,
    );
    operation.assertActive();
    return receipt;
  } finally {
    operation.close();
  }
}

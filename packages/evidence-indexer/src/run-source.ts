// SPDX-License-Identifier: MIT
import type {
  AnnouncementBatch,
  EvidenceIndexerCheckpointStore,
  EvidenceRecordAnnouncementSource,
} from "@jinn-network/evidence-catalog";

import {
  assertEvidenceIndexerOperationActive,
  EvidenceIndexerError,
} from "./errors.js";
import type {
  EvidenceIndexer,
  EvidenceIndexingResult,
} from "./index-announcement.js";
import { snapshotEvidenceRecordAnnouncement } from "./index-announcement.js";

export type EvidenceIndexingResultObserver = (
  result: EvidenceIndexingResult,
) => void | Promise<void>;

export interface RunEvidenceAnnouncementSourceOptions {
  readonly sourceId: string;
  readonly source: EvidenceRecordAnnouncementSource;
  readonly indexer: EvidenceIndexer;
  readonly checkpoints: EvidenceIndexerCheckpointStore;
  readonly onResult?: EvidenceIndexingResultObserver;
  readonly signal?: AbortSignal;
}

export interface EvidenceSourceRunReceipt {
  readonly batches: number;
  readonly announcements: number;
  readonly indexed: number;
  readonly rejected: number;
  readonly withdrawn: number;
  readonly finalCursor?: string;
}

function invalidBatch(message: string): never {
  throw new EvidenceIndexerError("ANNOUNCEMENT_INVALID", message);
}

function snapshotBatch(value: unknown): AnnouncementBatch {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    invalidBatch("Announcement batch must be a safe plain object.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string") ||
    Object.keys(descriptors).some((key) =>
      key !== "announcements" && key !== "cursor")
  ) {
    invalidBatch("Announcement batch contains unsupported fields.");
  }
  const announcementsDescriptor = descriptors.announcements;
  const cursorDescriptor = descriptors.cursor;
  if (
    announcementsDescriptor === undefined ||
    !announcementsDescriptor.enumerable ||
    !("value" in announcementsDescriptor) ||
    cursorDescriptor === undefined ||
    !cursorDescriptor.enumerable ||
    !("value" in cursorDescriptor)
  ) {
    invalidBatch("Announcement batch fields must be enumerable data properties.");
  }
  const announcements = announcementsDescriptor.value;
  const lengthDescriptor = Array.isArray(announcements)
    ? Object.getOwnPropertyDescriptor(announcements, "length")
    : undefined;
  const length =
    lengthDescriptor !== undefined && "value" in lengthDescriptor
      ? lengthDescriptor.value
      : undefined;
  if (
    !Array.isArray(announcements) ||
    Object.getPrototypeOf(announcements) !== Array.prototype ||
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    Reflect.ownKeys(announcements).some((key) =>
      typeof key !== "string" ||
      (
        key !== "length" &&
        (
          !/^(?:0|[1-9][0-9]*)$/u.test(key) ||
          Number(key) >= length ||
          Number(key) > 0xffff_fffe
        )
      ))
  ) {
    invalidBatch("Announcement batch announcements must be a dense array.");
  }
  const snapshot = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(
      announcements,
      String(index),
    );
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      invalidBatch("Announcement batch announcements must be dense data properties.");
    }
    snapshot.push(snapshotEvidenceRecordAnnouncement(descriptor.value));
  }
  if (
    typeof cursorDescriptor.value !== "string" ||
    cursorDescriptor.value.length === 0
  ) {
    invalidBatch("Announcement batch cursor must be a non-empty string.");
  }
  return {
    announcements: snapshot,
    cursor: cursorDescriptor.value,
  };
}

export async function runEvidenceAnnouncementSource(
  options: RunEvidenceAnnouncementSourceOptions,
): Promise<EvidenceSourceRunReceipt> {
  if (options.sourceId.trim().length === 0) {
    throw new EvidenceIndexerError(
      "ANNOUNCEMENT_INVALID",
      "Configured sourceId must be a non-empty string.",
    );
  }
  const operationOptions = { signal: options.signal };
  assertEvidenceIndexerOperationActive(operationOptions);
  let finalCursor = await options.checkpoints.get(options.sourceId);
  assertEvidenceIndexerOperationActive(operationOptions);
  let batches = 0;
  let announcements = 0;
  let indexed = 0;
  let rejected = 0;
  let withdrawn = 0;

  for await (const sourceBatch of options.source.read({
    ...(finalCursor === undefined ? {} : { after: finalCursor }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })) {
    assertEvidenceIndexerOperationActive(operationOptions);
    const batch = snapshotBatch(sourceBatch);
    for (const announcement of batch.announcements) {
      if (announcement.sourceId !== options.sourceId) {
        throw new EvidenceIndexerError(
          "ANNOUNCEMENT_INVALID",
          "Announcement sourceId does not match the configured source.",
        );
      }
      const result = await options.indexer.index(
        announcement,
        operationOptions,
      );
      assertEvidenceIndexerOperationActive(operationOptions);
      if (options.onResult !== undefined) {
        await options.onResult(result);
        assertEvidenceIndexerOperationActive(operationOptions);
      }
      announcements += 1;
      if (result.status === "indexed") indexed += 1;
      else if (result.status === "rejected") rejected += 1;
      else withdrawn += 1;
    }
    await options.checkpoints.put(options.sourceId, batch.cursor);
    finalCursor = batch.cursor;
    batches += 1;
  }

  return {
    batches,
    announcements,
    indexed,
    rejected,
    withdrawn,
    ...(finalCursor === undefined ? {} : { finalCursor }),
  };
}

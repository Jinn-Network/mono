// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import { constants, lstat, rename, rm } from "node:fs/promises";

import { EvidenceAnnouncementJournalError } from "./errors.js";
import {
  assertManagedRegularFile,
  mapIoError,
  openRegularNoFollow,
  syncDirectory,
  type JournalPaths,
} from "./paths.js";
import {
  decodeUtf8,
  deterministicBytes,
  exactBytesEqual,
} from "./serialization.js";
import type {
  AppendAvailableAnnouncementInput,
  AnnouncementJournalMarkerV1,
} from "./types.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/u;

function invalid(message: string, cause?: unknown): never {
  throw new EvidenceAnnouncementJournalError(
    "INVALID_ANNOUNCEMENT",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function exactDataObject(
  value: unknown,
  allowed: readonly string[],
  role: string,
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) ||
    Object.getOwnPropertySymbols(value).length > 0
  ) {
    invalid(`${role} must be a safe plain object.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  if (
    keys.some((key) => !allowed.includes(key)) ||
    keys.some((key) => {
      const descriptor = descriptors[key]!;
      return !descriptor.enumerable || !("value" in descriptor);
    })
  ) {
    invalid(`${role} contains unsupported or unsafe fields.`);
  }
  return Object.fromEntries(
    keys.map((key) => [key, (descriptors[key] as PropertyDescriptor).value]),
  );
}

function nonEmpty(value: unknown, role: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    invalid(`${role} must be a non-empty string.`);
  }
  return value;
}

function arbitraryDataObject(
  value: unknown,
  role: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${role} must be a safe plain object.`);
  }
  return exactDataObject(
    value,
    Object.keys(Object.getOwnPropertyDescriptors(value)),
    role,
  );
}

function snapshotJson<T>(value: T, role: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(deterministicBytes(value))) as T;
  } catch (error) {
    if (
      error instanceof EvidenceAnnouncementJournalError &&
      error.code === "JOURNAL_CORRUPT"
    ) {
      return invalid(`${role} must contain only finite JSON data.`, error);
    }
    throw error;
  }
}

export function createJournalMarker(sourceId: string): AnnouncementJournalMarkerV1 {
  return {
    format: "jinn-evidence-announcement-journal",
    version: 1,
    sourceId: nonEmpty(sourceId, "sourceId"),
  };
}

export function snapshotAppendInput(
  value: AppendAvailableAnnouncementInput,
): AppendAvailableAnnouncementInput {
  const input = exactDataObject(
    value,
    ["announcementId", "reference", "repositoryId", "publishedLocation"],
    "announcement",
  );
  const reference = exactDataObject(
    input.reference,
    ["family", "digest"],
    "reference",
  );
  const family = reference.family;
  const digest = reference.digest;
  if (
    typeof family !== "string" ||
    ![
      "execution-evidence",
      "result-evaluation",
      "execution-verification",
    ].includes(family) ||
    typeof digest !== "string" ||
    !DIGEST.test(digest)
  ) {
    invalid("reference must identify a supported family and canonical digest.");
  }
  const accepted: AppendAvailableAnnouncementInput = {
    announcementId: nonEmpty(input.announcementId, "announcementId"),
    reference: {
      family: family as AppendAvailableAnnouncementInput["reference"]["family"],
      digest: digest as AppendAvailableAnnouncementInput["reference"]["digest"],
    },
    repositoryId: nonEmpty(input.repositoryId, "repositoryId"),
  };
  if (input.publishedLocation !== undefined) {
    const published = exactDataObject(
      input.publishedLocation,
      ["bindingProfile", "locator"],
      "publishedLocation",
    );
    const bindingProfile = nonEmpty(
      published.bindingProfile,
      "bindingProfile",
    );
    try {
      new URL(bindingProfile);
    } catch (error) {
      invalid("bindingProfile must be an absolute identifier.", error);
    }
    const locator = arbitraryDataObject(published.locator, "locator");
    return snapshotJson({
      ...accepted,
      publishedLocation: {
        bindingProfile,
        locator: locator as NonNullable<
          AppendAvailableAnnouncementInput["publishedLocation"]
        >["locator"],
      },
    }, "publishedLocation");
  }
  return snapshotJson(accepted, "announcement");
}

function parseMarker(bytes: Uint8Array): AnnouncementJournalMarkerV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(bytes, "Journal marker"));
  } catch (error) {
    if (error instanceof EvidenceAnnouncementJournalError) throw error;
    throw new EvidenceAnnouncementJournalError(
      "JOURNAL_CORRUPT",
      "The journal marker is not valid JSON.",
      { cause: error },
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.getPrototypeOf(parsed) !== Object.prototype
  ) {
    throw new EvidenceAnnouncementJournalError(
      "JOURNAL_CORRUPT",
      "The journal marker has an invalid shape.",
    );
  }
  const keys = Object.keys(parsed).sort();
  if (
    keys.join("\0") !== ["format", "sourceId", "version"].join("\0") ||
    (parsed as Record<string, unknown>).format !==
      "jinn-evidence-announcement-journal" ||
    typeof (parsed as Record<string, unknown>).version !== "number"
  ) {
    throw new EvidenceAnnouncementJournalError(
      "JOURNAL_VERSION_UNSUPPORTED",
      "The announcement journal marker format is unsupported.",
    );
  }
  if ((parsed as Record<string, unknown>).version !== 1) {
    throw new EvidenceAnnouncementJournalError(
      "JOURNAL_VERSION_UNSUPPORTED",
      "The announcement journal marker version is unsupported.",
    );
  }
  const sourceId = (parsed as Record<string, unknown>).sourceId;
  if (typeof sourceId !== "string" || sourceId.trim().length === 0) {
    throw new EvidenceAnnouncementJournalError(
      "JOURNAL_CORRUPT",
      "The journal marker source identity is invalid.",
    );
  }
  const marker = parsed as unknown as AnnouncementJournalMarkerV1;
  if (!exactBytesEqual(bytes, deterministicBytes(marker))) {
    throw new EvidenceAnnouncementJournalError(
      "JOURNAL_CORRUPT",
      "The journal marker is not deterministically serialized.",
    );
  }
  return marker;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

export async function openJournalMarker(
  paths: JournalPaths,
  sourceId: string,
): Promise<AnnouncementJournalMarkerV1> {
  const expected = createJournalMarker(sourceId);
  try {
    await lstat(paths.markerPath);
  } catch (error) {
    if (!isMissing(error)) {
      return mapIoError(error, "Failed to inspect the journal marker.");
    }
    const temporaryPath = `${paths.markerPath}.tmp-${randomUUID()}`;
    let handle: Awaited<ReturnType<typeof openRegularNoFollow>> | undefined;
    try {
      handle = await openRegularNoFollow(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      await handle.writeFile(deterministicBytes(expected));
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, paths.markerPath);
      await syncDirectory(paths.rootDir);
    } catch (createError) {
      await handle?.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      if (createError instanceof EvidenceAnnouncementJournalError) {
        throw createError;
      }
      return mapIoError(createError, "Failed to create the journal marker.");
    }
  }

  try {
    await assertManagedRegularFile(paths.markerPath, "Journal marker");
    const handle = await openRegularNoFollow(
      paths.markerPath,
      constants.O_RDONLY,
    );
    let bytes: Uint8Array;
    try {
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
    const marker = parseMarker(bytes);
    if (marker.sourceId !== expected.sourceId) {
      throw new EvidenceAnnouncementJournalError(
        "JOURNAL_CORRUPT",
        "The journal marker source identity does not match the requested source.",
      );
    }
    return marker;
  } catch (error) {
    if (error instanceof EvidenceAnnouncementJournalError) throw error;
    return mapIoError(error, "Failed to open the journal marker.");
  }
}

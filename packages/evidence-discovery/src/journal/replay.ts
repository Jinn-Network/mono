// SPDX-License-Identifier: MIT
import {
  constants,
  lstat,
  readdir,
  rm,
} from "node:fs/promises";
import { join } from "node:path";

import { encodeJournalCursor } from "./cursor.js";
import { EvidenceAnnouncementJournalError } from "./errors.js";
import { snapshotAppendInput } from "./marker.js";
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
  digestBytes,
  exactBytesEqual,
  type Sha256Text,
} from "./serialization.js";
import type {
  AnnouncementJournalAppendReceipt,
  AnnouncementJournalEntryV1,
} from "./types.js";

const FINAL_NAME = /^([0-9]{20})\.json$/u;
const TEMPORARY_NAME = /^\.tmp-[A-Za-z0-9-]+\.json$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;

export interface ReplayedJournalEntry {
  readonly entry: AnnouncementJournalEntryV1;
  readonly digest: Sha256Text;
  readonly cursor: string;
  readonly receipt: AnnouncementJournalAppendReceipt;
}

export interface JournalReplayState {
  readonly entries: readonly ReplayedJournalEntry[];
  readonly byAnnouncementId: ReadonlyMap<string, ReplayedJournalEntry>;
  readonly byReference: ReadonlyMap<string, ReplayedJournalEntry>;
}

export function referenceKey(reference: {
  readonly family: string;
  readonly digest: string;
}): string {
  return JSON.stringify([reference.family, reference.digest]);
}

function corrupt(message: string, cause?: unknown): never {
  throw new EvidenceAnnouncementJournalError(
    "JOURNAL_CORRUPT",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function exactObject(
  value: unknown,
  allowed: readonly string[],
  role: string,
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length > 0 ||
    Object.keys(value).some((key) => !allowed.includes(key))
  ) {
    corrupt(`${role} has an invalid shape.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const descriptor of Object.values(descriptors)) {
    if (!descriptor.enumerable || !("value" in descriptor)) {
      corrupt(`${role} must contain enumerable data properties.`);
    }
  }
  return value as Record<string, unknown>;
}

function parseEntry(
  bytes: Uint8Array,
  expectedRevision: number,
  sourceId: string,
  predecessorDigest: Sha256Text | undefined,
): AnnouncementJournalEntryV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(bytes, `Journal event ${expectedRevision}`));
  } catch (error) {
    if (error instanceof EvidenceAnnouncementJournalError) throw error;
    return corrupt(`Journal event ${expectedRevision} is not valid JSON.`, error);
  }
  const entry = exactObject(
    parsed,
    ["version", "revision", "predecessorDigest", "announcement"],
    `Journal event ${expectedRevision}`,
  );
  if (
    entry.version !== 1 ||
    entry.revision !== expectedRevision ||
    (
      predecessorDigest === undefined
        ? entry.predecessorDigest !== undefined
        : entry.predecessorDigest !== predecessorDigest
    )
  ) {
    corrupt(`Journal event ${expectedRevision} breaks the revision chain.`);
  }
  if (
    entry.predecessorDigest !== undefined &&
    (typeof entry.predecessorDigest !== "string" ||
      !DIGEST.test(entry.predecessorDigest))
  ) {
    corrupt(`Journal event ${expectedRevision} has an invalid predecessor digest.`);
  }
  const announcement = exactObject(
    entry.announcement,
    [
      "kind",
      "sourceId",
      "announcementId",
      "reference",
      "repositoryId",
      "publishedLocation",
    ],
    `Journal event ${expectedRevision} announcement`,
  );
  if (
    announcement.kind !== "available" ||
    announcement.sourceId !== sourceId
  ) {
    corrupt(`Journal event ${expectedRevision} has an invalid source announcement.`);
  }
  let accepted;
  try {
    accepted = snapshotAppendInput({
      announcementId: announcement.announcementId as string,
      reference: announcement.reference as never,
      repositoryId: announcement.repositoryId as string,
      ...(announcement.publishedLocation === undefined
        ? {}
        : { publishedLocation: announcement.publishedLocation as never }),
    });
  } catch (error) {
    return corrupt(`Journal event ${expectedRevision} is invalid.`, error);
  }
  const normalized: AnnouncementJournalEntryV1 = {
    version: 1,
    revision: expectedRevision,
    ...(predecessorDigest === undefined ? {} : { predecessorDigest }),
    announcement: {
      kind: "available",
      sourceId,
      ...accepted,
    },
  };
  if (!exactBytesEqual(bytes, deterministicBytes(normalized))) {
    corrupt(`Journal event ${expectedRevision} bytes were changed or are non-canonical.`);
  }
  return normalized;
}

async function recoverHardLinkIfAllowed(
  paths: JournalPaths,
  finalPath: string,
  revision: number,
  highWater: number,
  temporaryNames: readonly string[],
): Promise<void> {
  let stats = await assertManagedRegularFile(finalPath, `Journal event ${revision}`);
  if (stats.nlink === 1) return;
  const matches: string[] = [];
  for (const name of temporaryNames) {
    const path = join(paths.eventsDir, name);
    let temporaryStats;
    try {
      temporaryStats = await lstat(path);
    } catch (error) {
      return mapIoError(error, "Failed to inspect a journal temporary file.");
    }
    if (
      !temporaryStats.isSymbolicLink() &&
      temporaryStats.isFile() &&
      temporaryStats.dev === stats.dev &&
      temporaryStats.ino === stats.ino
    ) {
      matches.push(path);
    }
  }
  if (
    revision !== highWater ||
    stats.nlink !== 2 ||
    matches.length !== 1
  ) {
    corrupt(`Journal event ${revision} has an unexpected hard link.`);
  }
  try {
    await rm(matches[0]!);
    await syncDirectory(paths.eventsDir);
    stats = await assertManagedRegularFile(finalPath, `Journal event ${revision}`);
    if (stats.nlink !== 1) {
      corrupt(`Journal event ${revision} hard-link recovery was incomplete.`);
    }
  } catch (error) {
    if (error instanceof EvidenceAnnouncementJournalError) throw error;
    return mapIoError(error, "Failed to recover a journal publication link.");
  }
}

async function readExactFile(path: string): Promise<Uint8Array> {
  const handle = await openRegularNoFollow(path, constants.O_RDONLY);
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function replayJournal(
  paths: JournalPaths,
  sourceId: string,
): Promise<JournalReplayState> {
  try {
    const names = await readdir(paths.eventsDir);
    const temporaryNames = names.filter((name) => TEMPORARY_NAME.test(name));
    const finals = names
      .filter((name) => FINAL_NAME.test(name))
      .sort();
    const unknown = names.filter(
      (name) => !TEMPORARY_NAME.test(name) && !FINAL_NAME.test(name),
    );
    if (unknown.length > 0) {
      corrupt("The journal events directory contains an unknown entry.");
    }
    for (let index = 0; index < finals.length; index += 1) {
      const expectedName = `${String(index + 1).padStart(20, "0")}.json`;
      if (finals[index] !== expectedName) {
        corrupt("The journal event sequence contains a revision gap.");
      }
    }

    const entries: ReplayedJournalEntry[] = [];
    const byAnnouncementId = new Map<string, ReplayedJournalEntry>();
    const byReference = new Map<string, ReplayedJournalEntry>();
    let predecessorDigest: Sha256Text | undefined;
    for (let index = 0; index < finals.length; index += 1) {
      const revision = index + 1;
      const path = join(paths.eventsDir, finals[index]!);
      await recoverHardLinkIfAllowed(
        paths,
        path,
        revision,
        finals.length,
        temporaryNames,
      );
      const bytes = await readExactFile(path);
      const entry = parseEntry(bytes, revision, sourceId, predecessorDigest);
      const digest = digestBytes(bytes);
      const cursor = encodeJournalCursor({
        version: 1,
        sourceId,
        revision,
        entryDigest: digest,
      });
      const receipt: AnnouncementJournalAppendReceipt = {
        announcement: structuredClone(entry.announcement),
        cursor,
        status: "created",
      };
      const replayed = { entry, digest, cursor, receipt };
      if (byAnnouncementId.has(entry.announcement.announcementId)) {
        corrupt("A journal announcement identity is reused by another event.");
      }
      entries.push(replayed);
      byAnnouncementId.set(entry.announcement.announcementId, replayed);
      const key = referenceKey(entry.announcement.reference);
      if (!byReference.has(key)) byReference.set(key, replayed);
      predecessorDigest = digest;
    }
    return { entries, byAnnouncementId, byReference };
  } catch (error) {
    if (error instanceof EvidenceAnnouncementJournalError) throw error;
    return mapIoError(error, "Failed to replay the announcement journal.");
  }
}

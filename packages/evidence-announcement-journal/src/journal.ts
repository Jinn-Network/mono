// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import {
  constants,
  link,
  lstat,
  readdir,
  rm,
} from "node:fs/promises";
import { join } from "node:path";

import type {
  AnnouncementBatch,
  CatalogOperationOptions,
} from "@jinn-network/evidence-catalog";

import {
  decodeJournalCursor,
  encodeJournalCursor,
} from "./cursor.js";
import {
  assertJournalOperationActive,
  EvidenceAnnouncementJournalError,
} from "./errors.js";
import {
  openJournalMarker,
  snapshotAppendInput,
} from "./marker.js";
import {
  assertManagedDirectory,
  assertManagedRegularFile,
  mapIoError,
  openRegularNoFollow,
  prepareJournalPaths,
  syncDirectory,
  type JournalPaths,
} from "./paths.js";
import {
  referenceKey,
  replayJournal,
  type ReplayedJournalEntry,
} from "./replay.js";
import {
  deterministicBytes,
  digestBytes,
  exactBytesEqual,
} from "./serialization.js";
import type {
  AnnouncementJournalAppendReceipt,
  AnnouncementJournalEntryV1,
  AppendAvailableAnnouncementInput,
  FilesystemEvidenceAnnouncementJournal,
  OpenFilesystemEvidenceAnnouncementJournalOptions,
} from "./types.js";

interface PathIdentity {
  readonly dev: number;
  readonly ino: number;
}

export type JournalAppendFaultPoint =
  | "before-file-sync"
  | "before-hard-link"
  | "before-temporary-removal"
  | "before-directory-sync";

type JournalAppendFaultHook = (
  point: JournalAppendFaultPoint,
) => void | Promise<void>;

function identity(stats: Awaited<ReturnType<typeof lstat>>): PathIdentity {
  return { dev: Number(stats.dev), ino: Number(stats.ino) };
}

function sameIdentity(
  stats: Awaited<ReturnType<typeof lstat>>,
  expected: PathIdentity,
): boolean {
  return Number(stats.dev) === expected.dev && Number(stats.ino) === expected.ino;
}

function isCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

class FilesystemEvidenceAnnouncementJournalHandle
  implements FilesystemEvidenceAnnouncementJournal
{
  readonly sourceId: string;
  readonly #paths: JournalPaths;
  readonly #rootIdentity: PathIdentity;
  readonly #eventsIdentity: PathIdentity;
  readonly #markerIdentity: PathIdentity;
  readonly #entries: ReplayedJournalEntry[];
  readonly #byAnnouncementId: Map<string, ReplayedJournalEntry>;
  readonly #byReference: Map<string, ReplayedJournalEntry>;
  readonly #faultHook?: JournalAppendFaultHook;
  #appendTail: Promise<void> = Promise.resolve();
  #closing = false;
  #closed = false;

  constructor(
    paths: JournalPaths,
    sourceId: string,
    identities: {
      readonly root: PathIdentity;
      readonly events: PathIdentity;
      readonly marker: PathIdentity;
    },
    replay: Awaited<ReturnType<typeof replayJournal>>,
    faultHook?: JournalAppendFaultHook,
  ) {
    this.#paths = paths;
    this.sourceId = sourceId;
    this.#rootIdentity = identities.root;
    this.#eventsIdentity = identities.events;
    this.#markerIdentity = identities.marker;
    this.#entries = [...replay.entries];
    this.#byAnnouncementId = new Map(replay.byAnnouncementId);
    this.#byReference = new Map(replay.byReference);
    this.#faultHook = faultHook;
  }

  #assertOpen(): void {
    if (this.#closing || this.#closed) {
      throw new EvidenceAnnouncementJournalError(
        "JOURNAL_CLOSED",
        "The announcement journal is closed.",
      );
    }
  }

  async #assertControlPaths(): Promise<void> {
    try {
      await assertManagedDirectory(this.#paths.rootDir, "Journal root");
      await assertManagedDirectory(
        this.#paths.eventsDir,
        "Journal events directory",
      );
      await assertManagedRegularFile(this.#paths.markerPath, "Journal marker");
      const [root, events, marker] = await Promise.all([
        lstat(this.#paths.rootDir),
        lstat(this.#paths.eventsDir),
        lstat(this.#paths.markerPath),
      ]);
      if (
        !sameIdentity(root, this.#rootIdentity) ||
        !sameIdentity(events, this.#eventsIdentity) ||
        !sameIdentity(marker, this.#markerIdentity)
      ) {
        throw new EvidenceAnnouncementJournalError(
          "JOURNAL_CORRUPT",
          "A journal-managed control path changed after opening.",
        );
      }
    } catch (error) {
      if (error instanceof EvidenceAnnouncementJournalError) throw error;
      return mapIoError(error, "Failed to validate journal control paths.");
    }
  }

  async #assertFreshWriter(options?: CatalogOperationOptions): Promise<void> {
    try {
      assertJournalOperationActive(options);
      await this.#assertControlPaths();
      assertJournalOperationActive(options);
      const names = await readdir(this.#paths.eventsDir);
      assertJournalOperationActive(options);
      const finals = names
        .filter((name) => /^[0-9]{20}\.json$/u.test(name))
        .sort();
      const unknown = names.some(
        (name) =>
          !/^[0-9]{20}\.json$/u.test(name) &&
          !/^\.tmp-[A-Za-z0-9-]+\.json$/u.test(name),
      );
      const sequenceChanged = finals.some(
        (name, index) =>
          name !== `${String(index + 1).padStart(20, "0")}.json`,
      );
      if (unknown || sequenceChanged || finals.length !== this.#entries.length) {
        throw new EvidenceAnnouncementJournalError(
          "STALE_WRITER",
          "The announcement journal advanced in another writer.",
        );
      }
      const last = this.#entries.at(-1);
      if (last === undefined) return;
      const lastPath = join(this.#paths.eventsDir, finals.at(-1)!);
      const lastStats = await assertManagedRegularFile(
        lastPath,
        "Final journal event",
      );
      if (lastStats.nlink !== 1) {
        throw new EvidenceAnnouncementJournalError(
          "STALE_WRITER",
          "The final journal event has an unfinished or foreign link.",
        );
      }
      const handle = await openRegularNoFollow(lastPath, constants.O_RDONLY);
      try {
        const bytes = await handle.readFile();
        if (digestBytes(bytes) !== last.digest) {
          throw new EvidenceAnnouncementJournalError(
            "STALE_WRITER",
            "The final journal event changed after this writer opened.",
          );
        }
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error instanceof EvidenceAnnouncementJournalError) throw error;
      return mapIoError(error, "Failed to refresh the journal writer state.");
    }
  }

  appendAvailable(
    input: AppendAvailableAnnouncementInput,
    options?: CatalogOperationOptions,
  ): Promise<AnnouncementJournalAppendReceipt> {
    let accepted: AppendAvailableAnnouncementInput;
    try {
      this.#assertOpen();
      assertJournalOperationActive(options);
      accepted = snapshotAppendInput(input);
    } catch (error) {
      return Promise.reject(error);
    }
    const operation = this.#appendTail.then(() =>
      this.#appendAccepted(accepted, options)
    );
    this.#appendTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #appendAccepted(
    accepted: AppendAvailableAnnouncementInput,
    options?: CatalogOperationOptions,
  ): Promise<AnnouncementJournalAppendReceipt> {
    assertJournalOperationActive(options);
    const announcement = {
      kind: "available",
      sourceId: this.sourceId,
      announcementId: accepted.announcementId,
      reference: accepted.reference,
      repositoryId: accepted.repositoryId,
      ...(accepted.publishedLocation === undefined
        ? {}
        : { publishedLocation: accepted.publishedLocation }),
    } as const;
    const existing = this.#byAnnouncementId.get(accepted.announcementId);
    if (existing !== undefined) {
      if (
        !exactBytesEqual(
          deterministicBytes(existing.entry.announcement),
          deterministicBytes(announcement),
        )
      ) {
        throw new EvidenceAnnouncementJournalError(
          "ANNOUNCEMENT_CONFLICT",
          "The announcement identity is already bound to different content.",
        );
      }
      return {
        announcement: structuredClone(existing.receipt.announcement),
        cursor: existing.cursor,
        status: "existing",
      };
    }

    await this.#assertFreshWriter(options);
    const revision = this.#entries.length + 1;
    const predecessorDigest = this.#entries.at(-1)?.digest;
    const entry: AnnouncementJournalEntryV1 = {
      version: 1,
      revision,
      ...(predecessorDigest === undefined ? {} : { predecessorDigest }),
      announcement,
    };
    const bytes = deterministicBytes(entry);
    const digest = digestBytes(bytes);
    const cursor = encodeJournalCursor({
      version: 1,
      sourceId: this.sourceId,
      revision,
      entryDigest: digest,
    });
    const temporaryPath = join(
      this.#paths.eventsDir,
      `.tmp-${randomUUID()}.json`,
    );
    const finalPath = join(
      this.#paths.eventsDir,
      `${String(revision).padStart(20, "0")}.json`,
    );
    let handle: Awaited<ReturnType<typeof openRegularNoFollow>> | undefined;
    let published = false;
    try {
      assertJournalOperationActive(options);
      handle = await openRegularNoFollow(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      assertJournalOperationActive(options);
      await handle.writeFile(bytes);
      assertJournalOperationActive(options);
      await this.#faultHook?.("before-file-sync");
      await handle.sync();
      await handle.close();
      handle = undefined;
      assertJournalOperationActive(options);
      await this.#faultHook?.("before-hard-link");
      await link(temporaryPath, finalPath);
      published = true;
      await this.#faultHook?.("before-temporary-removal");
      await rm(temporaryPath);
      await this.#faultHook?.("before-directory-sync");
      await syncDirectory(this.#paths.eventsDir);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (!published) await rm(temporaryPath, { force: true }).catch(() => undefined);
      if (isCode(error, "EEXIST")) {
        throw new EvidenceAnnouncementJournalError(
          "STALE_WRITER",
          "The next journal revision was published by another writer.",
          { cause: error },
        );
      }
      if (error instanceof EvidenceAnnouncementJournalError) throw error;
      return mapIoError(error, "Failed to append an announcement journal event.");
    }

    const receipt: AnnouncementJournalAppendReceipt = {
      announcement: structuredClone(announcement),
      cursor,
      status: "created",
    };
    const replayed: ReplayedJournalEntry = {
      entry: structuredClone(entry),
      digest,
      cursor,
      receipt,
    };
    this.#entries.push(replayed);
    this.#byAnnouncementId.set(accepted.announcementId, replayed);
    const key = referenceKey(accepted.reference);
    if (!this.#byReference.has(key)) this.#byReference.set(key, replayed);
    return structuredClone(receipt);
  }

  async getHighWaterCursor(
    options?: CatalogOperationOptions,
  ): Promise<string | undefined> {
    this.#assertOpen();
    assertJournalOperationActive(options);
    await this.#assertControlPaths();
    assertJournalOperationActive(options);
    return this.#entries.at(-1)?.cursor;
  }

  async getEntryCount(options?: CatalogOperationOptions): Promise<number> {
    this.#assertOpen();
    assertJournalOperationActive(options);
    await this.#assertControlPaths();
    assertJournalOperationActive(options);
    return this.#entries.length;
  }

  async findAvailable(
    reference: AppendAvailableAnnouncementInput["reference"],
    options?: CatalogOperationOptions,
  ): Promise<AnnouncementJournalAppendReceipt | null> {
    this.#assertOpen();
    assertJournalOperationActive(options);
    const accepted = snapshotAppendInput({
      announcementId: "lookup",
      reference,
      repositoryId: "lookup",
    }).reference;
    await this.#assertControlPaths();
    assertJournalOperationActive(options);
    const found = this.#byReference.get(referenceKey(accepted));
    return found === undefined ? null : structuredClone(found.receipt);
  }

  async *read(options?: {
    readonly after?: string;
    readonly signal?: AbortSignal;
  }): AsyncIterable<AnnouncementBatch> {
    this.#assertOpen();
    const operationOptions = { signal: options?.signal };
    assertJournalOperationActive(operationOptions);
    await this.#assertControlPaths();
    assertJournalOperationActive(operationOptions);
    const highWater = this.#entries.length;
    let start = 0;
    if (options?.after !== undefined) {
      const cursor = decodeJournalCursor(options.after);
      if (cursor.sourceId !== this.sourceId) {
        throw new EvidenceAnnouncementJournalError(
          "CURSOR_INVALID",
          "The cursor belongs to another announcement source.",
        );
      }
      const entry = this.#entries[cursor.revision - 1];
      if (entry === undefined || entry.digest !== cursor.entryDigest) {
        throw new EvidenceAnnouncementJournalError(
          "CURSOR_INVALID",
          "The cursor does not identify an exact event in this journal.",
        );
      }
      start = cursor.revision;
    }
    for (let index = start; index < highWater; index += 1) {
      this.#assertOpen();
      assertJournalOperationActive(operationOptions);
      const entry = this.#entries[index]!;
      yield {
        announcements: [structuredClone(entry.entry.announcement)],
        cursor: entry.cursor,
      };
      assertJournalOperationActive(operationOptions);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    if (this.#closing) {
      await this.#appendTail;
      return;
    }
    this.#closing = true;
    await this.#appendTail;
    this.#closed = true;
  }
}

export async function openFilesystemEvidenceAnnouncementJournal(
  options: OpenFilesystemEvidenceAnnouncementJournalOptions,
): Promise<FilesystemEvidenceAnnouncementJournal> {
  return openJournal(options);
}

export async function openFilesystemEvidenceAnnouncementJournalForTesting(
  options: OpenFilesystemEvidenceAnnouncementJournalOptions,
  faultHook: JournalAppendFaultHook,
): Promise<FilesystemEvidenceAnnouncementJournal> {
  return openJournal(options, faultHook);
}

async function openJournal(
  options: OpenFilesystemEvidenceAnnouncementJournalOptions,
  faultHook?: JournalAppendFaultHook,
): Promise<FilesystemEvidenceAnnouncementJournal> {
  const paths = await prepareJournalPaths(options.rootDir);
  const marker = await openJournalMarker(paths, options.sourceId);
  const replay = await replayJournal(paths, marker.sourceId);
  const [rootStats, eventsStats, markerStats] = await Promise.all([
    lstat(paths.rootDir),
    lstat(paths.eventsDir),
    lstat(paths.markerPath),
  ]);
  return new FilesystemEvidenceAnnouncementJournalHandle(
    paths,
    marker.sourceId,
    {
      root: identity(rootStats),
      events: identity(eventsStats),
      marker: identity(markerStats),
    },
    replay,
    faultHook,
  );
}

// SPDX-License-Identifier: MIT
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openFilesystemEvidenceAnnouncementJournal } from "@jinn-network/evidence-discovery/journal";
import type {
  CatalogRecordProjection,
  EvidenceCatalogReader,
} from "@jinn-network/evidence-discovery";
import { EvidenceCatalogError } from "@jinn-network/evidence-discovery";
import {
  EvidenceIndexerError,
  EvidenceIndexer,
  EvidenceIndexingResult,
} from "@jinn-network/evidence-discovery/indexer";
import { EvidenceRepositoryError } from "@jinn-network/evidence-repository";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLocalEvidenceIndexingWorker } from "./indexing-worker.js";
import { openLocalOperationsStore } from "./operations-store.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

const reference = {
  family: "execution-evidence" as const,
  digest: `sha256:${"a".repeat(64)}` as const,
};

async function fixture(
  result: "indexed" | "rejected",
  indexOverride?: EvidenceIndexer["index"],
) {
  const root = await mkdtemp(join(tmpdir(), "jinn-index-worker-"));
  roots.push(root);
  const journal = await openFilesystemEvidenceAnnouncementJournal({
    rootDir: join(root, "journal"),
    sourceId: "urn:uuid:11111111-1111-4111-8111-111111111111",
  });
  const operations = await openLocalOperationsStore(join(root, "operations.sqlite"));
  const projection = {
    family: "execution-evidence",
    reference,
    byteSize: 1,
    declaredEntities: [],
    declaredRelationships: [],
  } as unknown as CatalogRecordProjection;
  const catalog = {
    async getRecord() { return projection; },
  } as unknown as EvidenceCatalogReader;
  const indexer: EvidenceIndexer = {
    index: indexOverride ?? (async (): Promise<EvidenceIndexingResult> => {
      return result === "indexed"
        ? {
            status: "indexed",
            reference,
            projectionStatus: "created",
            locationStatus: "created",
          }
        : {
            status: "rejected",
            reference,
            diagnostics: [{
              code: "SCHEMA_INVALID",
              path: "",
              message: "required field is missing",
            }],
          };
    }),
  };
  const worker = createLocalEvidenceIndexingWorker({
    generationId: "urn:uuid:22222222-2222-4222-8222-222222222222",
    sourceId: journal.sourceId,
    journal,
    indexer,
    catalog,
    operations,
  });
  return { journal, operations, worker };
}

describe("local indexing worker", () => {
  it("processes an exact captured high-water cursor", async () => {
    const value = await fixture("indexed");
    const appended = await value.journal.appendAvailable({
      announcementId: "announcement",
      reference,
      repositoryId: "local:test",
    });
    const report = await value.worker.syncTo(appended.cursor);
    expect(report).toEqual({
      status: "synchronized",
      highWaterCursor: appended.cursor,
      indexed: 1,
      failed: 0,
    });
    expect(await value.worker.awaitReference(reference)).toMatchObject({
      status: "indexed",
      reference,
    });
    await value.worker.stop();
    await value.operations.close();
    await value.journal.close();
  });

  it("checkpoints protocol rejection as a terminal failure", async () => {
    const value = await fixture("rejected");
    const appended = await value.journal.appendAvailable({
      announcementId: "bad-announcement",
      reference,
      repositoryId: "local:test",
    });
    const report = await value.worker.syncTo(appended.cursor);
    expect(report.failed).toBe(1);
    expect(await value.worker.awaitReference(reference)).toMatchObject({
      status: "failed",
      failure: {
        category: "protocol-nonconformance",
        sourceCode: "PROTOCOL_NONCONFORMANCE",
      },
    });
    await value.worker.stop();
    await value.operations.close();
    await value.journal.close();
  });

  it("treats an invalid stored journal checkpoint as terminal runtime corruption", async () => {
    const value = await fixture("indexed");
    await value.operations.recordIndexedAndCheckpoint({
      generationId: "urn:uuid:22222222-2222-4222-8222-222222222222",
      sourceId: value.journal.sourceId,
      announcementId: "historical",
      reference,
      journalCursor: "not-a-journal-cursor",
      indexedTotal: 1,
      failedTotal: 0,
      observedAt: new Date().toISOString(),
    });
    const appended = await value.journal.appendAvailable({
      announcementId: "later",
      reference: {
        ...reference,
        digest: `sha256:${"b".repeat(64)}`,
      },
      repositoryId: "local:test",
    });

    await expect(value.worker.syncTo(appended.cursor)).rejects.toMatchObject({
      code: "RUNTIME_CORRUPT",
    });
    expect((await value.worker.getStatus()).transientFailure).toBeUndefined();
    await value.worker.stop();
    await value.operations.close();
    await value.journal.close();
  });

  it("retries Repository I/O and clears transient state after success", async () => {
    let attempts = 0;
    const index = vi.fn(async (): Promise<EvidenceIndexingResult> => {
      attempts += 1;
      if (attempts === 1) {
        throw new EvidenceRepositoryError("IO_FAILURE", "temporarily unavailable");
      }
      return {
        status: "indexed",
        reference,
        projectionStatus: "created",
        locationStatus: "created",
      };
    });
    const value = await fixture("indexed", index);
    const appended = await value.journal.appendAvailable({
      announcementId: "retry",
      reference,
      repositoryId: "local:test",
    });

    await expect(value.worker.syncTo(appended.cursor)).resolves.toMatchObject({
      indexed: 1,
      failed: 0,
    });
    expect(index).toHaveBeenCalledTimes(2);
    expect((await value.worker.getStatus()).transientFailure).toBeUndefined();
    await value.worker.stop();
    await value.operations.close();
    await value.journal.close();
  });

  it("retries Catalog I/O without checkpointing the failed attempt", async () => {
    let attempts = 0;
    const index = vi.fn(async (): Promise<EvidenceIndexingResult> => {
      attempts += 1;
      if (attempts === 1) {
        throw new EvidenceCatalogError("IO_FAILURE", "catalog temporarily unavailable");
      }
      return {
        status: "indexed",
        reference,
        projectionStatus: "created",
        locationStatus: "created",
      };
    });
    const value = await fixture("indexed", index);
    const appended = await value.journal.appendAvailable({
      announcementId: "catalog-retry",
      reference,
      repositoryId: "local:test",
    });

    await expect(value.worker.syncTo(appended.cursor)).resolves.toMatchObject({
      indexed: 1,
      failed: 0,
    });
    expect(index).toHaveBeenCalledTimes(2);
    expect(await value.operations.getProcessedCursor(
      "urn:uuid:22222222-2222-4222-8222-222222222222",
      value.journal.sourceId,
      appended.cursor,
    )).toEqual({ indexed: 1, failed: 0 });
    await value.worker.stop();
    await value.operations.close();
    await value.journal.close();
  });

  it("checkpoints terminal reference corruption and continues with a later event", async () => {
    const laterReference = {
      ...reference,
      digest: `sha256:${"b".repeat(64)}` as const,
    };
    const index = vi.fn(async (announcement): Promise<EvidenceIndexingResult> => {
      if (
        announcement.kind === "available" &&
        announcement.reference.digest === reference.digest
      ) {
        throw new EvidenceIndexerError(
          "REFERENCE_MISMATCH",
          "record digest does not match",
        );
      }
      return {
        status: "indexed",
        reference: laterReference,
        projectionStatus: "created",
        locationStatus: "created",
      };
    });
    const value = await fixture("indexed", index);
    await value.journal.appendAvailable({
      announcementId: "corrupt",
      reference,
      repositoryId: "local:test",
    });
    const later = await value.journal.appendAvailable({
      announcementId: "valid-later",
      reference: laterReference,
      repositoryId: "local:test",
    });

    await expect(value.worker.syncTo(later.cursor)).resolves.toMatchObject({
      indexed: 1,
      failed: 1,
    });
    await expect(value.worker.awaitReference(reference)).resolves.toMatchObject({
      status: "failed",
      failure: {
        category: "content-corrupt",
        sourceCode: "REFERENCE_MISMATCH",
      },
    });
    await value.worker.stop();
    await value.operations.close();
    await value.journal.close();
  });

  it("supports not-announced, abort, and shutdown await behavior", async () => {
    const value = await fixture("indexed");
    await expect(value.worker.awaitReference(reference)).resolves.toEqual({
      status: "not-announced",
      reference,
    });
    const announced = {
      ...reference,
      digest: `sha256:${"c".repeat(64)}` as const,
    };
    await value.journal.appendAvailable({
      announcementId: "waiting",
      reference: announced,
      repositoryId: "local:test",
    });
    const abort = new AbortController();
    const aborted = value.worker.awaitReference(announced, {
      signal: abort.signal,
    });
    abort.abort();
    await expect(aborted).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
    await value.worker.stop();
    await expect(value.worker.awaitReference(announced)).rejects.toMatchObject({
      code: "SYNCHRONIZATION_UNAVAILABLE",
    });
    await value.operations.close();
    await value.journal.close();
  });

  it("keeps syncTo bound to its captured high-water while later writes continue", async () => {
    let entered: (() => void) | undefined;
    let release: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const secondReference = {
      ...reference,
      digest: `sha256:${"d".repeat(64)}` as const,
    };
    const index = vi.fn(async (announcement): Promise<EvidenceIndexingResult> => {
      if (index.mock.calls.length === 1) {
        entered?.();
        await gate;
      }
      if (announcement.kind !== "available") throw new Error("unexpected withdrawal");
      return {
        status: "indexed",
        reference: announcement.reference,
        projectionStatus: "created",
        locationStatus: "created",
      };
    });
    const value = await fixture("indexed", index);
    const first = await value.journal.appendAvailable({
      announcementId: "fixed-first",
      reference,
      repositoryId: "local:test",
    });
    const firstSync = value.worker.syncTo(first.cursor);
    await started;
    const second = await value.journal.appendAvailable({
      announcementId: "fixed-second",
      reference: secondReference,
      repositoryId: "local:test",
    });
    release?.();

    await expect(firstSync).resolves.toEqual({
      status: "synchronized",
      highWaterCursor: first.cursor,
      indexed: 1,
      failed: 0,
    });
    await expect(value.worker.syncTo(second.cursor)).resolves.toMatchObject({
      indexed: 2,
      failed: 0,
    });
    await value.worker.stop();
    await value.operations.close();
    await value.journal.close();
  });
});

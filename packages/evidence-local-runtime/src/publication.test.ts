// SPDX-License-Identifier: MIT
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { openFilesystemEvidenceAnnouncementJournal } from "@jinn-network/evidence-announcement-journal";
import {
  EvidenceRepositoryError,
  createRecordReference,
  type EvidenceRepository,
} from "@jinn-network/evidence-repository";
import { createFilesystemEvidenceRepository } from "@jinn-network/evidence-repository-fs";
import { afterEach, describe, expect, it } from "vitest";

import {
  openFilesystemEvidenceAnnouncementJournalForTesting,
} from "../../evidence-announcement-journal/dist/journal.js";
import { openLocalOperationsStore } from "./operations-store.js";
import {
  createAnnouncementAwareRepository,
  publicationIdentity,
  recoverPendingPublications,
} from "./publication.js";

const roots: string[] = [];
async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "jinn-publication-"));
  roots.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

async function fixture() {
  const path = await root();
  const repository = await createFilesystemEvidenceRepository({
    rootDir: join(path, "repository"),
  });
  const journal = await openFilesystemEvidenceAnnouncementJournal({
    rootDir: join(path, "journal"),
    sourceId: "urn:uuid:11111111-1111-4111-8111-111111111111",
  });
  const operationsPath = join(path, "operations.sqlite");
  const operations = await openLocalOperationsStore(operationsPath);
  return { path, repository, journal, operations, operationsPath };
}

describe("announcement-aware repository", () => {
  it("publishes exactly one deterministic announcement for concurrent record writes", async () => {
    const value = await fixture();
    let published = 0;
    const repository = createAnnouncementAwareRepository({
      ...value,
      sourceId: value.journal.sourceId,
      repositoryId: "local:test",
      assertReadable() {},
      assertWritable() {},
      onPublished() { published += 1; },
    });
    const bytes = new TextEncoder().encode('{"record":"same"}');
    const receipts = await Promise.all(Array.from({ length: 20 }, () =>
      repository.putRecord("execution-evidence", bytes)));
    expect(new Set(receipts.map((receipt) => receipt.reference.digest)).size).toBe(1);
    expect(await value.journal.getEntryCount()).toBe(1);
    expect(published).toBe(1);
    expect(await value.operations.listPendingPublications()).toEqual([]);
    await value.operations.close();
    await value.journal.close();
  });

  it("never announces artifacts and separates record families", async () => {
    const value = await fixture();
    const repository = createAnnouncementAwareRepository({
      ...value,
      sourceId: value.journal.sourceId,
      repositoryId: "local:test",
      assertReadable() {},
      assertWritable() {},
      onPublished() {},
    });
    const bytes = new Uint8Array([1, 2, 3]);
    await repository.putArtifact(bytes);
    expect(await value.journal.getEntryCount()).toBe(0);
    await repository.putRecord("execution-evidence", bytes);
    await repository.putRecord("result-evaluation", bytes);
    expect(await value.journal.getEntryCount()).toBe(2);
    await value.operations.close();
    await value.journal.close();
  });

  it("completes the outbox after cancellation races with a published journal link", async () => {
    const path = await root();
    const repositoryBinding = await createFilesystemEvidenceRepository({
      rootDir: join(path, "repository"),
    });
    const controller = new AbortController();
    const journal = await openFilesystemEvidenceAnnouncementJournalForTesting(
      {
        rootDir: join(path, "journal"),
        sourceId: "urn:uuid:11111111-1111-4111-8111-111111111111",
      },
      (point) => {
        if (point === "before-directory-sync") controller.abort();
      },
    );
    const operations = await openLocalOperationsStore(
      join(path, "operations.sqlite"),
    );
    const repository = createAnnouncementAwareRepository({
      repository: repositoryBinding,
      journal,
      operations,
      sourceId: journal.sourceId,
      repositoryId: "local:test",
      assertReadable() {},
      assertWritable() {},
      onPublished() {},
    });
    const bytes = new TextEncoder().encode("published before cancellation");
    const receipt = await repository.putRecord(
      "execution-evidence",
      bytes,
      { signal: controller.signal },
    );
    expect(await journal.findAvailable(receipt.reference)).not.toBeNull();
    expect(await operations.listPendingPublications()).toEqual([]);
    await expect(repository.putRecord("execution-evidence", bytes))
      .resolves.toMatchObject({ reference: receipt.reference });
    expect(await journal.getEntryCount()).toBe(1);
    await operations.close();
    await journal.close();
  });

  it("recovers staged exact bytes without inventing a new identity", async () => {
    const value = await fixture();
    const bytes = new TextEncoder().encode("recover me");
    const reference = await value.repository.putRecord("execution-evidence", bytes)
      .then((receipt) => receipt.reference);
    const identity = publicationIdentity(
      value.journal.sourceId,
      "local:test",
      reference,
    );
    await value.operations.stagePublication({
      ...identity,
      reference,
      recordBytes: bytes,
      byteSize: bytes.byteLength,
      state: "staged",
    });
    await recoverPendingPublications({
      ...value,
      repositoryId: "local:test",
    });
    expect(await value.journal.findAvailable(reference)).toMatchObject({
      announcement: { announcementId: identity.announcementId },
    });
    expect(await value.operations.listPendingPublications()).toEqual([]);
    await value.operations.close();
    await value.journal.close();
  });

  it.each(["stored", "announced"] as const)(
    "does not announce or delete a %s row whose authoritative record is missing",
    async (state) => {
      const value = await fixture();
      const bytes = new TextEncoder().encode(`missing ${state}`);
      const reference = createRecordReference("execution-evidence", bytes);
      const identity = publicationIdentity(
        value.journal.sourceId,
        "local:test",
        reference,
      );
      await value.operations.stagePublication({
        ...identity,
        reference,
        recordBytes: bytes,
        byteSize: bytes.byteLength,
        state: "staged",
      });
      if (state === "stored") {
        await value.operations.markPublicationStored(identity.operationKey);
      } else {
        await value.operations.markPublicationAnnounced(identity.operationKey);
      }

      await expect(recoverPendingPublications({
        ...value,
        repositoryId: "local:test",
      })).rejects.toMatchObject({ code: "CONTENT_CORRUPT" });
      expect(await value.journal.getEntryCount()).toBe(0);
      expect(await value.operations.listPendingPublications()).toHaveLength(1);
      await value.operations.close();
      await value.journal.close();
    },
  );

  it("preserves an authoritative Repository error during recovery", async () => {
    const value = await fixture();
    const bytes = new TextEncoder().encode("access controlled");
    const reference = createRecordReference("execution-evidence", bytes);
    const identity = publicationIdentity(
      value.journal.sourceId,
      "local:test",
      reference,
    );
    await value.operations.stagePublication({
      ...identity,
      reference,
      recordBytes: bytes,
      byteSize: bytes.byteLength,
      state: "staged",
    });
    await value.operations.markPublicationStored(identity.operationKey);
    const expected = new EvidenceRepositoryError(
      "ACCESS_DENIED",
      "repository denied recovery",
    );
    const repository = {
      putRecord: value.repository.putRecord.bind(value.repository),
      async getRecord(): Promise<null> { throw expected; },
      putArtifact: value.repository.putArtifact.bind(value.repository),
      getArtifact: value.repository.getArtifact.bind(value.repository),
    } as EvidenceRepository;

    await expect(recoverPendingPublications({
      ...value,
      repository,
      repositoryId: "local:test",
    })).rejects.toBe(expected);
    expect(await value.journal.getEntryCount()).toBe(0);
    await value.operations.close();
    await value.journal.close();
  });

  it("validates every deterministic identity before publishing any pending row", async () => {
    const value = await fixture();
    for (const text of ["first", "second"]) {
      const bytes = new TextEncoder().encode(text);
      const receipt = await value.repository.putRecord("execution-evidence", bytes);
      const identity = publicationIdentity(
        value.journal.sourceId,
        "local:test",
        receipt.reference,
      );
      await value.operations.stagePublication({
        ...identity,
        reference: receipt.reference,
        recordBytes: bytes,
        byteSize: bytes.byteLength,
        state: "staged",
      });
    }
    await value.operations.close();
    const database = new Database(value.operationsPath);
    database.prepare(`
      UPDATE publication_outbox
      SET operation_key = ?
      WHERE operation_key = (SELECT operation_key FROM publication_outbox ORDER BY operation_key DESC LIMIT 1)
    `).run(`sha256:${"f".repeat(64)}`);
    database.close();
    const operations = await openLocalOperationsStore(value.operationsPath);

    await expect(recoverPendingPublications({
      ...value,
      operations,
      repositoryId: "local:test",
    })).rejects.toMatchObject({ code: "RUNTIME_CORRUPT" });
    expect(await value.journal.getEntryCount()).toBe(0);
    expect(await operations.listPendingPublications()).toHaveLength(2);
    await operations.close();
    await value.journal.close();
  });

  it.each([
    ["family", "unsupported"],
    ["digest", `sha256:${"0".repeat(64)}`],
    ["byte_size", 99],
    ["announcement_id", `urn:jinn:local-announcement:sha256:${"0".repeat(64)}`],
  ])("rejects corrupt persisted outbox %s", async (column, replacement) => {
    const value = await fixture();
    const bytes = new TextEncoder().encode("persisted");
    const reference = await value.repository.putRecord("execution-evidence", bytes)
      .then((receipt) => receipt.reference);
    const identity = publicationIdentity(
      value.journal.sourceId,
      "local:test",
      reference,
    );
    await value.operations.stagePublication({
      ...identity,
      reference,
      recordBytes: bytes,
      byteSize: bytes.byteLength,
      state: "staged",
    });
    await value.operations.close();
    const database = new Database(value.operationsPath);
    database.prepare(`UPDATE publication_outbox SET ${column} = ?`).run(replacement);
    database.close();
    const operations = await openLocalOperationsStore(value.operationsPath);

    await expect(recoverPendingPublications({
      ...value,
      operations,
      repositoryId: "local:test",
    })).rejects.toMatchObject({ code: "RUNTIME_CORRUPT" });
    expect(await value.journal.getEntryCount()).toBe(0);
    await operations.close();
    await value.journal.close();
  });
});

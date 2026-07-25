// SPDX-License-Identifier: MIT
import type { FilesystemEvidenceAnnouncementJournal } from "@jinn-network/evidence-announcement-journal";
import {
  EvidenceRepositoryError,
  createArtifactReference,
  createRecordReference,
  type EvidenceRecordReference,
  type EvidenceRepository,
} from "@jinn-network/evidence-repository";
import { describe, expect, it, vi } from "vitest";

import type { LocalOperationsStore } from "./operations-store.js";
import {
  createAnnouncementAwareRepository,
  publicationIdentity,
} from "./publication.js";

function harness() {
  const sourceId = "urn:uuid:11111111-1111-4111-8111-111111111111";
  const repositoryId = "local:test";
  const recordBytes = new Uint8Array([1, 2, 3]);
  const recordReference = createRecordReference(
    "execution-evidence",
    recordBytes,
  );
  const artifactReference = createArtifactReference(recordBytes);
  const underlying: EvidenceRepository = {
    putRecord: vi.fn(async (family, bytes) => ({
      reference: createRecordReference(family, bytes),
      size: bytes.byteLength,
      status: "created" as const,
    })),
    getRecord: vi.fn(async () => Uint8Array.from(recordBytes)),
    putArtifact: vi.fn(async (bytes) => ({
      reference: createArtifactReference(bytes),
      size: bytes.byteLength,
      status: "created" as const,
    })),
    getArtifact: vi.fn(async () => Uint8Array.from(recordBytes)),
  };
  const identity = publicationIdentity(sourceId, repositoryId, recordReference);
  const operations = {
    stagePublication: vi.fn(async () => "created" as const),
    markPublicationStored: vi.fn(async () => undefined),
    markPublicationAnnounced: vi.fn(async () => undefined),
    completePublication: vi.fn(async () => undefined),
  } as unknown as LocalOperationsStore;
  const journal = {
    sourceId,
    appendAvailable: vi.fn(async () => ({
      status: "created" as const,
      cursor: "cursor",
      announcement: {
        kind: "available" as const,
        sourceId,
        announcementId: identity.announcementId,
        reference: recordReference,
        repositoryId,
      },
    })),
  } as unknown as FilesystemEvidenceAnnouncementJournal;
  return {
    sourceId,
    repositoryId,
    recordBytes,
    recordReference,
    artifactReference,
    underlying,
    operations,
    journal,
  };
}

describe("announcement-aware Repository delegation", () => {
  it("delegates artifact methods exactly once without touching publication state", async () => {
    const value = harness();
    const readable = vi.fn();
    const writable = vi.fn();
    const repository = createAnnouncementAwareRepository({
      repository: value.underlying,
      journal: value.journal,
      operations: value.operations,
      sourceId: value.sourceId,
      repositoryId: value.repositoryId,
      assertReadable: readable,
      assertWritable: writable,
      onPublished() {},
    });
    const options = { signal: new AbortController().signal };
    const callerBytes = Uint8Array.from(value.recordBytes);

    await expect(repository.putArtifact(callerBytes, options)).resolves.toMatchObject({
      reference: value.artifactReference,
    });
    await expect(repository.getArtifact(value.artifactReference, options))
      .resolves.toEqual(value.recordBytes);

    expect(value.underlying.putArtifact).toHaveBeenCalledOnce();
    expect(value.underlying.putArtifact).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      options,
    );
    expect(value.underlying.getArtifact).toHaveBeenCalledOnce();
    expect(value.underlying.getArtifact).toHaveBeenCalledWith(
      value.artifactReference,
      options,
    );
    expect(readable).toHaveBeenCalledTimes(2);
    expect(writable).toHaveBeenCalledOnce();
    expect(value.operations.stagePublication).not.toHaveBeenCalled();
    expect(value.journal.appendAvailable).not.toHaveBeenCalled();
  });

  it("snapshots record bytes before awaiting and publishes the exact family", async () => {
    const value = harness();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const repository = createAnnouncementAwareRepository({
      repository: value.underlying,
      journal: value.journal,
      operations: value.operations,
      sourceId: value.sourceId,
      repositoryId: value.repositoryId,
      assertReadable() {},
      assertWritable() {},
      onPublished() {},
      beforePublication: async () => gate,
    });
    const callerBytes = Uint8Array.from(value.recordBytes);
    const pending = repository.putRecord("execution-evidence", callerBytes);
    callerBytes.fill(9);
    release?.();

    await expect(pending).resolves.toMatchObject({
      reference: value.recordReference,
    });
    expect(value.underlying.putRecord).toHaveBeenCalledWith(
      "execution-evidence",
      value.recordBytes,
      undefined,
    );
    expect(value.operations.stagePublication).toHaveBeenCalledWith(
      expect.objectContaining({
        reference: value.recordReference,
        recordBytes: value.recordBytes,
        byteSize: 3,
        state: "staged",
      }),
    );
    expect(value.journal.appendAvailable).toHaveBeenCalledWith({
      announcementId: publicationIdentity(
        value.sourceId,
        value.repositoryId,
        value.recordReference,
      ).announcementId,
      reference: value.recordReference,
      repositoryId: value.repositoryId,
    }, undefined);
  });

  it("allows a started read to finish but rejects every later call after closing", async () => {
    const value = harness();
    let closing = false;
    let release: ((bytes: Uint8Array) => void) | undefined;
    (value.underlying.getRecord as ReturnType<typeof vi.fn>).mockImplementation(
      async () => new Promise<Uint8Array>((resolve) => { release = resolve; }),
    );
    const assertReadable = () => {
      if (closing) {
        throw new EvidenceRepositoryError("IO_FAILURE", "runtime closing");
      }
    };
    const repository = createAnnouncementAwareRepository({
      repository: value.underlying,
      journal: value.journal,
      operations: value.operations,
      sourceId: value.sourceId,
      repositoryId: value.repositoryId,
      assertReadable,
      assertWritable: assertReadable,
      onPublished() {},
    });

    const started = repository.getRecord(value.recordReference);
    closing = true;
    release?.(value.recordBytes);
    await expect(started).resolves.toEqual(value.recordBytes);
    for (const call of [
      () => repository.getRecord(value.recordReference),
      () => repository.putRecord("execution-evidence", value.recordBytes),
      () => repository.getArtifact(value.artifactReference),
      () => repository.putArtifact(value.recordBytes),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: "IO_FAILURE" });
    }
  });

  it("preserves existing Repository errors from delegated reads", async () => {
    const value = harness();
    const expected = new EvidenceRepositoryError(
      "CONTENT_CORRUPT",
      "bad record",
    );
    (value.underlying.getRecord as ReturnType<typeof vi.fn>)
      .mockRejectedValue(expected);
    const repository = createAnnouncementAwareRepository({
      repository: value.underlying,
      journal: value.journal,
      operations: value.operations,
      sourceId: value.sourceId,
      repositoryId: value.repositoryId,
      assertReadable() {},
      assertWritable() {},
      onPublished() {},
    });

    await expect(repository.getRecord(
      value.recordReference as EvidenceRecordReference,
    )).rejects.toBe(expected);
  });
});

// SPDX-License-Identifier: MIT
import { createHash } from "node:crypto";

import type { FilesystemEvidenceAnnouncementJournal } from "@jinn-network/evidence-discovery/journal";
import {
  EvidenceRepositoryError,
  assertRepositoryOperationActive,
  createRecordReference,
  type EvidenceRecordReference,
  type EvidenceRepository,
  type RepositoryOperationOptions,
} from "@jinn-network/evidence-repository";

import {
  LocalEvidenceRuntimeError,
} from "./errors.js";
import type {
  LocalOperationsStore,
  PublicationIntent,
} from "./operations-store.js";

export interface CreateAnnouncementAwareRepositoryOptions {
  readonly repository: EvidenceRepository;
  readonly journal: FilesystemEvidenceAnnouncementJournal;
  readonly operations: LocalOperationsStore;
  readonly sourceId: string;
  readonly repositoryId: string;
  readonly assertReadable: () => void;
  readonly assertWritable: () => void;
  readonly onPublished: (
    reference: EvidenceRecordReference,
    cursor: string,
  ) => void | Promise<void>;
  readonly onPublicationStart?: () => void;
  readonly onPublicationEnd?: () => void;
  readonly beforePublication?: () => Promise<void>;
}

export interface RecoverPendingPublicationsOptions {
  readonly repository: EvidenceRepository;
  readonly journal: FilesystemEvidenceAnnouncementJournal;
  readonly operations: LocalOperationsStore;
  readonly repositoryId: string;
  readonly signal?: AbortSignal;
}

export interface PublicationIdentity {
  readonly operationKey: string;
  readonly announcementId: string;
}

export function publicationIdentity(
  sourceId: string,
  repositoryId: string,
  reference: EvidenceRecordReference,
): PublicationIdentity {
  const canonical = JSON.stringify({
    version: 1,
    sourceId,
    repositoryId,
    family: reference.family,
    digest: reference.digest,
  });
  const digest = createHash("sha256").update(canonical).digest("hex");
  return {
    operationKey: `sha256:${digest}`,
    announcementId: `urn:jinn:local-announcement:sha256:${digest}`,
  };
}

function nodeCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function repositoryBoundaryError(
  error: unknown,
  message: string,
): EvidenceRepositoryError {
  if (error instanceof EvidenceRepositoryError) return error;
  const code = nodeCode(error);
  if (code === "OPERATION_ABORTED") {
    return new EvidenceRepositoryError("OPERATION_ABORTED", message, { cause: error });
  }
  if (
    code === "EACCES" ||
    code === "EPERM" ||
    code === "ACCESS_DENIED"
  ) {
    return new EvidenceRepositoryError("ACCESS_DENIED", message, { cause: error });
  }
  return new EvidenceRepositoryError("IO_FAILURE", message, { cause: error });
}

function assertWithinDeclaredObjectLimit(
  maxObjectBytes: number | undefined,
  bytes: Uint8Array,
): void {
  if (
    maxObjectBytes !== undefined &&
    bytes.byteLength > maxObjectBytes
  ) {
    throw new EvidenceRepositoryError(
      "CONTENT_TOO_LARGE",
      `The ${bytes.byteLength}-byte object exceeds the repository's ${maxObjectBytes}-byte limit.`,
    );
  }
}

function assertReceipt(
  intent: PublicationIntent,
  receipt: Awaited<ReturnType<EvidenceRepository["putRecord"]>>,
): void {
  if (
    receipt.reference.family !== intent.reference.family ||
    receipt.reference.digest !== intent.reference.digest ||
    receipt.size !== intent.byteSize
  ) {
    throw new EvidenceRepositoryError(
      "REFERENCE_CONFLICT",
      "The repository returned a receipt inconsistent with the staged publication.",
    );
  }
}

async function storeIntent(
  repository: EvidenceRepository,
  operations: LocalOperationsStore,
  intent: PublicationIntent,
  options?: RepositoryOperationOptions,
): Promise<Awaited<ReturnType<EvidenceRepository["putRecord"]>>> {
  const receipt = await repository.putRecord(
    intent.reference.family,
    intent.recordBytes,
    options,
  );
  assertReceipt(intent, receipt);
  await operations.markPublicationStored(intent.operationKey);
  return receipt;
}

async function announceIntent(
  journal: FilesystemEvidenceAnnouncementJournal,
  operations: LocalOperationsStore,
  repositoryId: string,
  intent: PublicationIntent,
  options?: RepositoryOperationOptions,
): Promise<string> {
  const receipt = await journal.appendAvailable({
    announcementId: intent.announcementId,
    reference: intent.reference,
    repositoryId,
  }, options);
  if (
    receipt.announcement.announcementId !== intent.announcementId ||
    receipt.announcement.repositoryId !== repositoryId ||
    receipt.announcement.reference.family !== intent.reference.family ||
    receipt.announcement.reference.digest !== intent.reference.digest
  ) {
    throw new EvidenceRepositoryError(
      "REFERENCE_CONFLICT",
      "The journal receipt conflicts with the staged publication.",
    );
  }
  await operations.markPublicationAnnounced(intent.operationKey);
  return receipt.cursor;
}

function assertPublicationIdentity(
  sourceId: string,
  repositoryId: string,
  intent: PublicationIntent,
): void {
  const expected = publicationIdentity(sourceId, repositoryId, intent.reference);
  if (
    intent.operationKey !== expected.operationKey ||
    intent.announcementId !== expected.announcementId
  ) {
    throw new LocalEvidenceRuntimeError(
      "RUNTIME_CORRUPT",
      "A pending publication has an invalid deterministic identity.",
    );
  }
}

async function assertStoredIntent(
  repository: EvidenceRepository,
  intent: PublicationIntent,
  options?: RepositoryOperationOptions,
): Promise<void> {
  const stored = await repository.getRecord(intent.reference, options);
  if (
    stored === null ||
    stored.byteLength !== intent.byteSize ||
    createRecordReference(intent.reference.family, stored).digest !==
      intent.reference.digest
  ) {
    throw new EvidenceRepositoryError(
      "CONTENT_CORRUPT",
      "A pending publication is missing or corrupt in the repository.",
    );
  }
  if (
    stored.some((byte, index) => byte !== intent.recordBytes[index])
  ) {
    throw new EvidenceRepositoryError(
      "CONTENT_CORRUPT",
      "A pending publication does not match the exact staged repository bytes.",
    );
  }
}

export async function recoverPendingPublications(
  options: RecoverPendingPublicationsOptions,
): Promise<void> {
  assertRepositoryOperationActive({ signal: options.signal });
  const intents = await options.operations.listPendingPublications({
    validate: true,
  });
  for (const intent of intents) {
    assertPublicationIdentity(
      options.journal.sourceId,
      options.repositoryId,
      intent,
    );
  }
  for (const intent of intents) {
    assertRepositoryOperationActive({ signal: options.signal });
    let state = intent.state;
    if (state === "staged") {
      await storeIntent(options.repository, options.operations, intent, {
        signal: options.signal,
      });
      state = "stored";
    }
    await assertStoredIntent(options.repository, intent, {
      signal: options.signal,
    });
    if (state === "stored") {
      await announceIntent(
        options.journal,
        options.operations,
        options.repositoryId,
        intent,
        { signal: options.signal },
      );
    } else if (state === "announced") {
      await announceIntent(
        options.journal,
        options.operations,
        options.repositoryId,
        intent,
        { signal: options.signal },
      );
    }
    await options.operations.completePublication(intent.operationKey);
  }
}

class KeyedMutex {
  readonly #inFlight = new Map<string, Promise<unknown>>();

  async run<T>(key: string, action: () => Promise<T>): Promise<T> {
    const existing = this.#inFlight.get(key);
    if (existing !== undefined) return existing as Promise<T>;
    const current = action();
    this.#inFlight.set(key, current);
    try {
      return await current;
    } finally {
      if (this.#inFlight.get(key) === current) this.#inFlight.delete(key);
    }
  }
}

export function createAnnouncementAwareRepository(
  options: CreateAnnouncementAwareRepositoryOptions,
): EvidenceRepository {
  const mutex = new KeyedMutex();
  const capabilities = options.repository.capabilities;
  const maxObjectBytes = capabilities.maxObjectBytes;
  return {
    capabilities,
    async putRecord(family, callerBytes, operationOptions) {
      let publicationStarted = false;
      try {
        options.assertReadable();
        options.assertWritable();
        assertRepositoryOperationActive(operationOptions);
        assertWithinDeclaredObjectLimit(maxObjectBytes, callerBytes);
        const recordBytes = Uint8Array.from(callerBytes);
        const reference = createRecordReference(family, recordBytes);
        const identity = publicationIdentity(
          options.sourceId,
          options.repositoryId,
          reference,
        );
        return await mutex.run(identity.operationKey, async () => {
          await options.beforePublication?.();
          options.assertWritable();
          options.onPublicationStart?.();
          publicationStarted = true;
          assertRepositoryOperationActive(operationOptions);
          const intent: PublicationIntent = {
            ...identity,
            reference,
            recordBytes,
            byteSize: recordBytes.byteLength,
            state: "staged",
          };
          try {
            await options.operations.stagePublication(intent);
          } catch (error) {
            if (error instanceof LocalEvidenceRuntimeError) {
              throw new EvidenceRepositoryError(
                "REFERENCE_CONFLICT",
                "The publication intent conflicts with an existing operation.",
                { cause: error },
              );
            }
            throw error;
          }
          const receipt = await storeIntent(
            options.repository,
            options.operations,
            intent,
            operationOptions,
          );
          const cursor = await announceIntent(
            options.journal,
            options.operations,
            options.repositoryId,
            intent,
            operationOptions,
          );
          await options.operations.completePublication(intent.operationKey);
          await options.onPublished(reference, cursor);
          return receipt;
        });
      } catch (error) {
        throw repositoryBoundaryError(error, "Unable to publish the evidence record.");
      } finally {
        if (publicationStarted) options.onPublicationEnd?.();
      }
    },
    async getRecord(reference, operationOptions) {
      try {
        options.assertReadable();
        return await options.repository.getRecord(reference, operationOptions);
      } catch (error) {
        throw repositoryBoundaryError(error, "Unable to read the evidence record.");
      }
    },
    async putArtifact(bytes, operationOptions) {
      try {
        options.assertReadable();
        options.assertWritable();
        return await options.repository.putArtifact(
          Uint8Array.from(bytes),
          operationOptions,
        );
      } catch (error) {
        throw repositoryBoundaryError(error, "Unable to store the evidence artifact.");
      }
    },
    async getArtifact(reference, operationOptions) {
      try {
        options.assertReadable();
        return await options.repository.getArtifact(reference, operationOptions);
      } catch (error) {
        throw repositoryBoundaryError(error, "Unable to read the evidence artifact.");
      }
    },
  };
}

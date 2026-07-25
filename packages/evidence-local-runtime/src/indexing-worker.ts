// SPDX-License-Identifier: MIT
import { setTimeout as delay } from "node:timers/promises";

import type { FilesystemEvidenceAnnouncementJournal } from "@jinn-network/evidence-announcement-journal";
import {
  EvidenceCatalogError,
  type EvidenceCatalogReader,
  type EvidenceRepositoryResolver,
} from "@jinn-network/evidence-catalog";
import {
  EvidenceIndexerError,
  type EvidenceIndexer,
  type EvidenceIndexingResult,
} from "@jinn-network/evidence-indexer";
import {
  EvidenceRepositoryError,
  type EvidenceRecordReference,
  type EvidenceRepository,
} from "@jinn-network/evidence-repository";

import {
  LocalEvidenceRuntimeError,
  assertLocalRuntimeOperationActive,
} from "./errors.js";
import type { LocalOperationsStore } from "./operations-store.js";
import type {
  LocalEvidenceIndexingOutcome,
  LocalEvidenceSyncReport,
  LocalIndexingFailure,
  LocalRuntimeOperationOptions,
  LocalTransientIndexingFailure,
} from "./types.js";

export interface LocalIndexerStatus {
  readonly running: boolean;
  readonly stopped: boolean;
  readonly checkpointCursor?: string;
  readonly indexed: number;
  readonly failed: number;
  readonly transientFailure?: LocalTransientIndexingFailure;
  readonly fatal?: LocalEvidenceRuntimeError;
}

export interface LocalEvidenceIndexingWorker {
  wake(): void;
  validateCheckpoint(options?: LocalRuntimeOperationOptions): Promise<void>;
  syncTo(
    highWaterCursor: string | undefined,
    options?: LocalRuntimeOperationOptions,
  ): Promise<LocalEvidenceSyncReport>;
  awaitReference(
    reference: EvidenceRecordReference,
    options?: LocalRuntimeOperationOptions,
  ): Promise<LocalEvidenceIndexingOutcome>;
  getStatus(): Promise<LocalIndexerStatus>;
  stop(): Promise<void>;
}

export function createLocalRepositoryResolver(options: {
  readonly repositoryId: string;
  readonly repository: EvidenceRepository;
}): EvidenceRepositoryResolver {
  return {
    async resolve(repositoryId, operationOptions) {
      if (operationOptions?.signal?.aborted) {
        throw new EvidenceRepositoryError(
          "OPERATION_ABORTED",
          "Repository resolution was aborted.",
        );
      }
      return repositoryId === options.repositoryId ? options.repository : null;
    },
  };
}

export interface CreateLocalEvidenceIndexingWorkerOptions {
  readonly generationId: string;
  readonly sourceId: string;
  readonly journal: FilesystemEvidenceAnnouncementJournal;
  readonly indexer: EvidenceIndexer;
  readonly catalog: EvidenceCatalogReader;
  readonly operations: LocalOperationsStore;
}

const RETRY_DELAYS = [100, 250, 500, 1_000, 2_000, 5_000] as const;

function errorCode(error: unknown): string {
  return error !== null && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "UNEXPECTED_IO_FAILURE";
}

function checkpointIntegrityError(error: unknown): LocalEvidenceRuntimeError | null {
  if (errorCode(error) !== "CURSOR_INVALID") return null;
  return new LocalEvidenceRuntimeError(
    "RUNTIME_CORRUPT",
    "The stored indexer checkpoint does not identify an exact journal event.",
    { cause: error },
  );
}

function terminalFailure(
  error: unknown,
  reference: EvidenceRecordReference,
): LocalIndexingFailure | null {
  const code = errorCode(error);
  let category: LocalIndexingFailure["category"] | undefined;
  if (error instanceof EvidenceRepositoryError && code === "CONTENT_CORRUPT") {
    category = "content-corrupt";
  } else if (
    error instanceof EvidenceIndexerError &&
    code === "ANNOUNCEMENT_INVALID"
  ) {
    category = "announcement-invalid";
  } else if (
    error instanceof EvidenceIndexerError &&
    code === "REFERENCE_MISMATCH"
  ) {
    category = "content-corrupt";
  } else if (
    error instanceof EvidenceIndexerError &&
    code === "VALIDATED_RECORD_INCONSISTENT"
  ) {
    category = "validated-record-inconsistent";
  } else if (
    error instanceof EvidenceCatalogError &&
    ["PROJECTION_CONFLICT", "LOCATION_CONFLICT", "INVALID_PROJECTION", "INVALID_QUERY"]
      .includes(code)
  ) {
    category = "catalog-conflict";
  }
  if (category === undefined) return null;
  return {
    reference,
    category,
    sourceCode: code,
    message: error instanceof Error ? error.message : String(error),
    observedAt: new Date().toISOString(),
  };
}

function rejectedFailure(
  result: Extract<EvidenceIndexingResult, { status: "rejected" }>,
): LocalIndexingFailure {
  return {
    reference: result.reference,
    category: "protocol-nonconformance",
    sourceCode: "PROTOCOL_NONCONFORMANCE",
    message: "The evidence record does not conform to its protocol schema.",
    diagnostics: result.diagnostics,
    observedAt: new Date().toISOString(),
  };
}

class Worker implements LocalEvidenceIndexingWorker {
  #stopped = false;
  #run: Promise<void> | undefined;
  #attempt = 0;
  #listeners = new Set<() => void>();
  #abort = new AbortController();
  #fatal: LocalEvidenceRuntimeError | undefined;

  constructor(private readonly options: CreateLocalEvidenceIndexingWorkerOptions) {}

  #notify(): void {
    for (const listener of [...this.#listeners]) listener();
    this.#listeners.clear();
  }

  async #wait(options?: LocalRuntimeOperationOptions): Promise<void> {
    assertLocalRuntimeOperationActive(options);
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        options?.signal?.removeEventListener("abort", aborted);
        resolve();
      };
      const aborted = () => {
        this.#listeners.delete(done);
        reject(new LocalEvidenceRuntimeError(
          "OPERATION_ABORTED",
          "The local evidence indexing wait was aborted.",
        ));
      };
      this.#listeners.add(done);
      options?.signal?.addEventListener("abort", aborted, { once: true });
    });
  }

  #schedule(): void {
    if (this.#stopped || this.#run !== undefined) return;
    this.#run = this.#drain()
      .catch((error: unknown) => {
        this.#fatal = error instanceof LocalEvidenceRuntimeError
          ? error
          : new LocalEvidenceRuntimeError(
              "SYNCHRONIZATION_UNAVAILABLE",
              "The local evidence indexer stopped after a terminal failure.",
              { cause: error },
            );
      })
      .finally(() => {
        this.#run = undefined;
        this.#notify();
      });
  }

  wake(): void {
    this.#notify();
    this.#schedule();
  }

  async #transient(error: unknown, reference?: EvidenceRecordReference): Promise<void> {
    this.#attempt += 1;
    const failure: LocalTransientIndexingFailure = {
      ...(reference === undefined ? {} : { reference }),
      sourceCode: errorCode(error),
      message: error instanceof Error ? error.message : String(error),
      attempt: this.#attempt,
      observedAt: new Date().toISOString(),
    };
    await this.options.operations.setTransientFailure(
      this.options.generationId,
      failure,
    );
    this.#notify();
    const milliseconds = RETRY_DELAYS[
      Math.min(this.#attempt - 1, RETRY_DELAYS.length - 1)
    ]!;
    const retry = new AbortController();
    try {
      await Promise.race([
        delay(milliseconds, undefined, { signal: retry.signal }),
        this.#wait({ signal: retry.signal }),
      ]);
    } catch (retryError) {
      if (!retry.signal.aborted) throw retryError;
    } finally {
      retry.abort();
    }
  }

  async validateCheckpoint(
    operationOptions?: LocalRuntimeOperationOptions,
  ): Promise<void> {
    const checkpoint = await this.options.operations.validateGenerationState(
      this.options.generationId,
      this.options.sourceId,
    );
    if (checkpoint === undefined) return;
    try {
      const iterator = this.options.journal.read({
        after: checkpoint,
        signal: operationOptions?.signal,
      })[Symbol.asyncIterator]();
      await iterator.next();
      await iterator.return?.();
    } catch (error) {
      const checkpointError = checkpointIntegrityError(error);
      if (checkpointError !== null) throw checkpointError;
      throw error;
    }
  }

  async #processBatch(
    announcement: Parameters<EvidenceIndexer["index"]>[0],
    cursor: string,
    indexed: number,
    failed: number,
  ): Promise<{ indexed: number; failed: number }> {
    const reference = announcement.kind === "available"
      ? announcement.reference
      : undefined;
    if (reference === undefined) {
      throw new EvidenceIndexerError(
        "ANNOUNCEMENT_INVALID",
        "The local journal must contain only available announcements.",
      );
    }
    try {
      const result = await this.options.indexer.index(announcement, {
        signal: this.#abort.signal,
      });
      if (result.status === "withdrawn") {
        throw new EvidenceIndexerError(
          "ANNOUNCEMENT_INVALID",
          "The local journal cannot contain withdrawals.",
        );
      }
      const observedAt = new Date().toISOString();
      if (result.status === "rejected") {
        const failure = rejectedFailure(result);
        await this.options.operations.recordFailureAndCheckpoint({
          generationId: this.options.generationId,
          sourceId: this.options.sourceId,
          announcementId: announcement.announcementId,
          reference,
          journalCursor: cursor,
          indexedTotal: indexed,
          failedTotal: failed + 1,
          observedAt,
          failure,
        });
        return { indexed, failed: failed + 1 };
      }
      await this.options.operations.recordIndexedAndCheckpoint({
        generationId: this.options.generationId,
        sourceId: this.options.sourceId,
        announcementId: announcement.announcementId,
        reference,
        journalCursor: cursor,
        indexedTotal: indexed + 1,
        failedTotal: failed,
        observedAt,
      });
      return { indexed: indexed + 1, failed };
    } catch (error) {
      if (errorCode(error) === "OPERATION_ABORTED") throw error;
      const failure = terminalFailure(error, reference);
      if (failure === null) throw error;
      await this.options.operations.recordFailureAndCheckpoint({
        generationId: this.options.generationId,
        sourceId: this.options.sourceId,
        announcementId: announcement.announcementId,
        reference,
        journalCursor: cursor,
        indexedTotal: indexed,
        failedTotal: failed + 1,
        observedAt: failure.observedAt,
        failure,
      });
      return { indexed, failed: failed + 1 };
    }
  }

  async #drain(): Promise<void> {
    while (!this.#stopped) {
      const summary = await this.options.operations.getSummary(
        this.options.generationId,
      );
      const checkpoint = await this.options.operations.getCheckpoint(
        this.options.generationId,
        this.options.sourceId,
      );
      let totals = { indexed: summary.indexed, failed: summary.failed };
      let progressed = false;
      try {
        for await (const batch of this.options.journal.read({
          ...(checkpoint === undefined ? {} : { after: checkpoint }),
          signal: this.#abort.signal,
        })) {
          const announcement = batch.announcements[0];
          if (batch.announcements.length !== 1 || announcement === undefined) {
            throw new EvidenceIndexerError(
              "ANNOUNCEMENT_INVALID",
              "The local journal must yield one-event batches.",
            );
          }
          try {
            totals = await this.#processBatch(
              announcement,
              batch.cursor,
              totals.indexed,
              totals.failed,
            );
          } catch (error) {
            if (this.#stopped || errorCode(error) === "OPERATION_ABORTED") return;
            await this.#transient(
              error,
              announcement.kind === "available" ? announcement.reference : undefined,
            );
            progressed = true;
            break;
          }
          this.#attempt = 0;
          await this.options.operations.clearTransientFailure(
            this.options.generationId,
          );
          progressed = true;
          this.#notify();
        }
      } catch (error) {
        if (this.#stopped || errorCode(error) === "OPERATION_ABORTED") return;
        const checkpointError = checkpointIntegrityError(error);
        if (checkpointError !== null) throw checkpointError;
        await this.#transient(error);
        progressed = true;
      }
      if (!progressed) return;
    }
  }

  async syncTo(
    highWaterCursor: string | undefined,
    operationOptions?: LocalRuntimeOperationOptions,
  ): Promise<LocalEvidenceSyncReport> {
    assertLocalRuntimeOperationActive(operationOptions);
    if (highWaterCursor === undefined) {
      return { status: "synchronized", indexed: 0, failed: 0 };
    }
    while (true) {
      if (this.#fatal !== undefined) throw this.#fatal;
      if (this.#stopped) {
        throw new LocalEvidenceRuntimeError(
          "SYNCHRONIZATION_UNAVAILABLE",
          "The local evidence indexer is stopped.",
        );
      }
      const processed = await this.options.operations.getProcessedCursor(
        this.options.generationId,
        this.options.sourceId,
        highWaterCursor,
      );
      if (processed !== null) {
        return {
          status: "synchronized",
          highWaterCursor,
          ...processed,
        };
      }
      this.wake();
      await this.#wait(operationOptions);
    }
  }

  async awaitReference(
    reference: EvidenceRecordReference,
    operationOptions?: LocalRuntimeOperationOptions,
  ): Promise<LocalEvidenceIndexingOutcome> {
    assertLocalRuntimeOperationActive(operationOptions);
    const available = await this.options.journal.findAvailable(
      reference,
      operationOptions,
    );
    if (available === null) return { status: "not-announced", reference };
    while (true) {
      if (this.#fatal !== undefined) throw this.#fatal;
      if (this.#stopped) {
        throw new LocalEvidenceRuntimeError(
          "SYNCHRONIZATION_UNAVAILABLE",
          "The local evidence indexer is stopped.",
        );
      }
      const outcome = await this.options.operations.getOutcome(
        this.options.generationId,
        reference,
      );
      if (outcome?.status === "failed") {
        return { status: "failed", reference, failure: outcome.failure };
      }
      if (outcome?.status === "indexed") {
        const projection = await this.options.catalog.getRecord(
          reference,
          operationOptions,
        );
        if (projection === null) {
          throw new LocalEvidenceRuntimeError(
            "SYNCHRONIZATION_UNAVAILABLE",
            "The indexed projection is unavailable.",
          );
        }
        return { status: "indexed", reference, projection };
      }
      this.wake();
      await this.#wait(operationOptions);
    }
  }

  async getStatus(): Promise<LocalIndexerStatus> {
    const summary = await this.options.operations.getSummary(
      this.options.generationId,
    );
    return {
      running: this.#run !== undefined,
      stopped: this.#stopped,
      ...(summary.checkpointCursor === undefined
        ? {}
        : { checkpointCursor: summary.checkpointCursor }),
      indexed: summary.indexed,
      failed: summary.failed,
      ...(summary.transientFailure === undefined
        ? {}
        : { transientFailure: summary.transientFailure }),
      ...(this.#fatal === undefined ? {} : { fatal: this.#fatal }),
    };
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#abort.abort();
    this.#notify();
    await this.#run;
  }
}

export function createLocalEvidenceIndexingWorker(
  options: CreateLocalEvidenceIndexingWorkerOptions,
): LocalEvidenceIndexingWorker {
  return new Worker(options);
}

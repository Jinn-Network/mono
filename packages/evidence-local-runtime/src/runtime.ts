// SPDX-License-Identifier: MIT
import {
  EvidenceCatalogError,
  type EvidenceCatalogReader,
} from "@jinn-network/evidence-catalog";
import {
  openFilesystemEvidenceAnnouncementJournal,
  type FilesystemEvidenceAnnouncementJournal,
} from "@jinn-network/evidence-announcement-journal";
import {
  createEvidenceIndexer,
} from "@jinn-network/evidence-indexer";
import {
  parseEvidenceRecordReference,
  type EvidenceRepository,
} from "@jinn-network/evidence-repository";
import {
  createFilesystemEvidenceRepository,
} from "@jinn-network/evidence-repository-fs";

import {
  createSwitchableCatalogReader,
  type SwitchableCatalogReader,
} from "./catalog-reader.js";
import {
  LocalEvidenceRuntimeError,
  assertLocalRuntimeOperationActive,
} from "./errors.js";
import {
  createCatalogGeneration,
  openCurrentCatalogGeneration,
  publishCatalogPointer,
  type LocalCatalogGeneration,
} from "./generations.js";
import {
  createLocalEvidenceIndexingWorker,
  createLocalRepositoryResolver,
  type LocalEvidenceIndexingWorker,
} from "./indexing-worker.js";
import { acquireRuntimeLock, type LocalRuntimeLock } from "./lock.js";
import { openRuntimeMarker } from "./marker.js";
import {
  openLocalOperationsStore,
  type LocalOperationsStore,
} from "./operations-store.js";
import { prepareRuntimePaths } from "./paths.js";
import {
  createAnnouncementAwareRepository,
  recoverPendingPublications,
} from "./publication.js";
import type {
  LocalEvidenceRuntime,
  LocalEvidenceRuntimeStatus,
  LocalRuntimeLifecycleState,
  OpenLocalEvidenceRuntimeOptions,
} from "./types.js";

interface ActiveGeneration {
  readonly value: LocalCatalogGeneration;
  readonly worker: LocalEvidenceIndexingWorker;
}

interface PublicationGate {
  readonly wait: Promise<void>;
  readonly release: () => void;
}

function runtimeStateError(state: LocalRuntimeLifecycleState): never {
  throw new LocalEvidenceRuntimeError(
    state === "closing" ? "RUNTIME_CLOSING" : "RUNTIME_CLOSED",
    `The local evidence runtime is ${state}.`,
  );
}

function catalogStateError(state: LocalRuntimeLifecycleState): never {
  throw new EvidenceCatalogError(
    "IO_FAILURE",
    `The local evidence runtime is ${state}.`,
  );
}

async function closeQuietly(action: (() => Promise<void>) | undefined): Promise<void> {
  try { await action?.(); } catch { /* preserve the primary lifecycle result */ }
}

export async function openLocalEvidenceRuntime(
  options: OpenLocalEvidenceRuntimeOptions,
): Promise<LocalEvidenceRuntime> {
  assertLocalRuntimeOperationActive(options);
  const paths = await prepareRuntimePaths(options.rootDir);
  assertLocalRuntimeOperationActive(options);

  let lock: LocalRuntimeLock | undefined;
  let operations: LocalOperationsStore | undefined;
  let journal: FilesystemEvidenceAnnouncementJournal | undefined;
  let readerProxy: SwitchableCatalogReader | undefined;
  let active: ActiveGeneration | undefined;
  let unownedGeneration: LocalCatalogGeneration | undefined;
  const workers = new Set<LocalEvidenceIndexingWorker>();
  try {
    lock = await acquireRuntimeLock(paths.lockPath);
    assertLocalRuntimeOperationActive(options);
    const marker = await openRuntimeMarker(paths);
    operations = await openLocalOperationsStore(paths.operationsDatabasePath);
    const filesystemRepository = await createFilesystemEvidenceRepository({
      rootDir: paths.repositoryDir,
    });
    journal = await openFilesystemEvidenceAnnouncementJournal({
      rootDir: paths.announcementsDir,
      sourceId: marker.sourceId,
    });
    await recoverPendingPublications({
      repository: filesystemRepository,
      journal,
      operations,
      repositoryId: marker.repositoryId,
      signal: options.signal,
    });

    let state: LocalRuntimeLifecycleState = "rebuilding";
    let rebuildRunning = false;
    let rebuildFailed = false;
    let rebuildPromise: Promise<void> | undefined;
    let rebuildAbort: AbortController | undefined;
    let activePublications = 0;
    const publicationDrains = new Set<() => void>();
    let publicationGate: PublicationGate | undefined;
    const waitForPublications = async () => {
      if (activePublications === 0) return;
      await new Promise<void>((resolve) => { publicationDrains.add(resolve); });
    };
    const releasePublicationGate = () => {
      const gate = publicationGate;
      publicationGate = undefined;
      gate?.release();
    };
    const enterPublicationGate = async (): Promise<() => void> => {
      if (publicationGate !== undefined) {
        throw new LocalEvidenceRuntimeError(
          "RUNTIME_CORRUPT",
          "A Catalog generation switch barrier is already active.",
        );
      }
      let release!: () => void;
      const wait = new Promise<void>((resolve) => { release = resolve; });
      const gate = { wait, release };
      publicationGate = gate;
      await waitForPublications();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (publicationGate === gate) publicationGate = undefined;
        release();
      };
    };
    const assertReadable = () => {
      if (state === "closing" || state === "closed") runtimeStateError(state);
    };
    const assertCatalogReadable = () => {
      if (state === "closing" || state === "closed") catalogStateError(state);
    };
    const repository: EvidenceRepository = createAnnouncementAwareRepository({
      repository: filesystemRepository,
      journal,
      operations,
      sourceId: marker.sourceId,
      repositoryId: marker.repositoryId,
      assertReadable,
      assertWritable: assertReadable,
      async beforePublication() {
        const gate = publicationGate;
        if (gate !== undefined) await gate.wait;
      },
      onPublicationStart() { activePublications += 1; },
      onPublicationEnd() {
        activePublications -= 1;
        if (activePublications === 0) {
          for (const resolve of publicationDrains) resolve();
          publicationDrains.clear();
        }
      },
      onPublished() {
        for (const worker of workers) worker.wake();
      },
    });

    const buildWorker = (
      generation: LocalCatalogGeneration,
    ): LocalEvidenceIndexingWorker => {
      const resolver = createLocalRepositoryResolver({
        repositoryId: marker.repositoryId,
        repository,
      });
      const indexer = createEvidenceIndexer({
        repositories: resolver,
        catalog: generation.catalog,
      });
      return createLocalEvidenceIndexingWorker({
        generationId: generation.pointer.generationId,
        sourceId: marker.sourceId,
        journal: journal!,
        indexer,
        catalog: generation.catalog,
        operations: operations!,
      });
    };

    const current = await openCurrentCatalogGeneration(paths);
    let selected: LocalCatalogGeneration;
    let worker: LocalEvidenceIndexingWorker;
    if (current === null) {
      const created = await createCatalogGeneration(paths);
      unownedGeneration = created;
      const bootstrapWorker = buildWorker(created);
      workers.add(bootstrapWorker);
      const highWater = await journal.getHighWaterCursor({
        signal: options.signal,
      });
      if (highWater !== undefined) {
        await bootstrapWorker.syncTo(highWater, { signal: options.signal });
      }
      await publishCatalogPointer(paths, created.pointer);
      selected = created;
      worker = bootstrapWorker;
      unownedGeneration = undefined;
    } else {
      selected = current;
      worker = buildWorker(selected);
      workers.add(worker);
    }
    active = { value: selected, worker };
    readerProxy = createSwitchableCatalogReader(
      selected.catalog,
      () => selected.catalog.close(),
      assertCatalogReadable,
    );
    worker.wake();
    state = current !== null && !current.compatible ? "rebuilding" : "ready";

    let lastStatus: LocalEvidenceRuntimeStatus | undefined;
    let closePromise: Promise<void> | undefined;
    const computeStatus = async (): Promise<LocalEvidenceRuntimeStatus> => {
      const workerStatus = await active!.worker.getStatus();
      const entryCount = await journal!.getEntryCount();
      const journalHighWaterCursor = await journal!.getHighWaterCursor();
      const summary = await operations!.getSummary(
        active!.value.pointer.generationId,
      );
      const recent = await operations!.listFailures({ limit: 10 });
      const reportedState: LocalRuntimeLifecycleState =
        state === "closing" || state === "closed"
          ? state
          : rebuildRunning
            ? "rebuilding"
            : rebuildFailed || workerStatus.transientFailure !== undefined
              ? "degraded"
              : "ready";
      return {
        state: reportedState,
        sourceId: marker.sourceId,
        repositoryId: marker.repositoryId,
        activeGenerationId: active!.value.pointer.generationId,
        ...(journalHighWaterCursor === undefined
          ? {}
          : { journalHighWaterCursor }),
        ...(workerStatus.checkpointCursor === undefined
          ? {}
          : { indexerCheckpointCursor: workerStatus.checkpointCursor }),
        pendingPublications: summary.pendingPublications,
        pendingAnnouncements: Math.max(
          0,
          entryCount - workerStatus.indexed - workerStatus.failed,
        ),
        terminalFailureCount: workerStatus.failed,
        recentFailures: recent.items,
        ...(workerStatus.transientFailure === undefined
          ? {}
          : { transientFailure: workerStatus.transientFailure }),
      };
    };

    const startRebuild = (): void => {
      if (current === null || current.compatible) return;
      rebuildRunning = true;
      rebuildAbort = new AbortController();
      const signal = rebuildAbort.signal;
      rebuildPromise = Promise.resolve().then(async () => {
        let created: LocalCatalogGeneration | undefined;
        let replacementWorker: LocalEvidenceIndexingWorker | undefined;
        let releaseBarrier: (() => void) | undefined;
        let switched = false;
        try {
          created = await createCatalogGeneration(paths);
          replacementWorker = buildWorker(created);
          workers.add(replacementWorker);
          const initialHighWater = await journal!.getHighWaterCursor({ signal });
          await replacementWorker.syncTo(initialHighWater, { signal });

          releaseBarrier = await enterPublicationGate();
          const finalHighWater = await journal!.getHighWaterCursor({ signal });
          await Promise.all([
            active!.worker.syncTo(finalHighWater, { signal }),
            replacementWorker.syncTo(finalHighWater, { signal }),
          ]);
          if (signal.aborted || state === "closing" || state === "closed") {
            throw new LocalEvidenceRuntimeError(
              "OPERATION_ABORTED",
              "Catalog generation rebuild was aborted.",
            );
          }

          await publishCatalogPointer(paths, created.pointer);
          await readerProxy!.switchTo(
            created.catalog,
            () => created!.catalog.close(),
          );
          const previous = active!;
          active = { value: created, worker: replacementWorker };
          workers.delete(previous.worker);
          switched = true;
          rebuildFailed = false;
          rebuildRunning = false;
          releaseBarrier();
          releaseBarrier = undefined;
          await previous.worker.stop();
        } catch (error) {
          if (!switched) {
            if (replacementWorker !== undefined) {
              workers.delete(replacementWorker);
              await closeQuietly(() => replacementWorker!.stop());
            }
            await closeQuietly(() => created?.catalog.close() ?? Promise.resolve());
          }
          if (
            state !== "closing" &&
            state !== "closed" &&
            !(error instanceof LocalEvidenceRuntimeError &&
              error.code === "OPERATION_ABORTED")
          ) {
            rebuildFailed = true;
          }
          rebuildRunning = false;
        } finally {
          releaseBarrier?.();
        }
      });
    };

    const runtime: LocalEvidenceRuntime = {
      repository,
      catalog: readerProxy.reader,
      async sync(operationOptions) {
        assertReadable();
        assertLocalRuntimeOperationActive(operationOptions);
        const captured = await journal!.getHighWaterCursor(operationOptions);
        return active!.worker.syncTo(captured, operationOptions);
      },
      async awaitIndexed(untrustedReference, operationOptions) {
        assertReadable();
        assertLocalRuntimeOperationActive(operationOptions);
        const reference = parseEvidenceRecordReference(untrustedReference);
        return active!.worker.awaitReference(reference, operationOptions);
      },
      async getStatus() {
        if (state === "closed") return lastStatus!;
        lastStatus = await computeStatus();
        return lastStatus;
      },
      async listIndexingFailures(query, operationOptions) {
        assertReadable();
        assertLocalRuntimeOperationActive(operationOptions);
        return operations!.listFailures(query);
      },
      async close(operationOptions) {
        if (state === "closed") return;
        if (closePromise !== undefined) return closePromise;
        assertLocalRuntimeOperationActive(operationOptions);
        state = "closing";
        closePromise = (async () => {
          let primary: unknown;
          rebuildAbort?.abort();
          releasePublicationGate();
          await waitForPublications().catch((error: unknown) => { primary ??= error; });
          await rebuildPromise?.catch((error: unknown) => { primary ??= error; });
          await computeStatus()
            .then((status) => { lastStatus = status; })
            .catch((error: unknown) => { primary ??= error; });
          for (const worker of [...workers]) {
            await worker.stop().catch((error: unknown) => { primary ??= error; });
          }
          for (const close of [
            () => readerProxy!.close(),
            () => journal!.close(),
            () => operations!.close(),
            () => lock!.close(),
          ]) {
            await close().catch((error: unknown) => { primary ??= error; });
          }
          state = "closed";
          lastStatus = {
            ...(lastStatus ?? {
              state: "closed",
              sourceId: marker.sourceId,
              repositoryId: marker.repositoryId,
              activeGenerationId: active!.value.pointer.generationId,
              pendingPublications: 0,
              pendingAnnouncements: 0,
              terminalFailureCount: 0,
              recentFailures: [],
            }),
            state: "closed",
          };
          if (primary !== undefined) throw primary;
        })();
        return closePromise;
      },
    };
    startRebuild();
    return runtime;
  } catch (error) {
    for (const worker of workers) {
      await closeQuietly(() => worker.stop());
    }
    await closeQuietly(() => readerProxy?.close() ?? Promise.resolve());
    await closeQuietly(() => unownedGeneration?.catalog.close() ?? Promise.resolve());
    await closeQuietly(() => journal?.close() ?? Promise.resolve());
    await closeQuietly(() => operations?.close() ?? Promise.resolve());
    await closeQuietly(() => lock?.close() ?? Promise.resolve());
    throw error;
  }
}

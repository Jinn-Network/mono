// SPDX-License-Identifier: MIT
import {
  EvidenceCatalogError,
  type EvidenceCatalogReader,
} from "@jinn-network/evidence-discovery";
import {
  EvidenceAnnouncementJournalError,
  openFilesystemEvidenceAnnouncementJournal,
  type FilesystemEvidenceAnnouncementJournal,
} from "@jinn-network/evidence-discovery/journal";
import {
  createEvidenceIndexer,
} from "@jinn-network/evidence-discovery/indexer";
import {
  EvidenceRepositoryError,
  parseEvidenceRecordReference,
  type EvidenceRepository,
} from "@jinn-network/evidence-repository";
import {
  createFilesystemEvidenceRepository,
} from "@jinn-network/evidence-repository/fs";

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
import {
  openEvidenceJournalPublicDiscovery,
  publicDiscoveryRuntimeError,
} from "./public-discovery.js";
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

export type LocalEvidenceRuntimeFaultPoint =
  | "before-runtime-close"
  | "during-runtime-close"
  | "after-runtime-close";

export interface LocalEvidenceRuntimeTestDependencies {
  readonly acquireRuntimeLock?: typeof acquireRuntimeLock;
  readonly createCatalogGeneration?: typeof createCatalogGeneration;
  readonly createFilesystemEvidenceRepository?: (
    options: Parameters<typeof createFilesystemEvidenceRepository>[0],
  ) => Promise<EvidenceRepository>;
  readonly openCurrentCatalogGeneration?: typeof openCurrentCatalogGeneration;
  readonly openFilesystemEvidenceAnnouncementJournal?:
    typeof openFilesystemEvidenceAnnouncementJournal;
  readonly openLocalOperationsStore?: typeof openLocalOperationsStore;
  readonly openRuntimeMarker?: typeof openRuntimeMarker;
  readonly prepareRuntimePaths?: typeof prepareRuntimePaths;
  readonly publishCatalogPointer?: typeof publishCatalogPointer;
  readonly recoverPendingPublications?: typeof recoverPendingPublications;
  readonly faultHook?: (
    point: LocalEvidenceRuntimeFaultPoint,
  ) => void | Promise<void>;
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

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}

function runtimeOpenError(error: unknown): LocalEvidenceRuntimeError {
  if (error instanceof LocalEvidenceRuntimeError) return error;
  const code = errorCode(error);
  if (code === "OPERATION_ABORTED") {
    return new LocalEvidenceRuntimeError(
      "OPERATION_ABORTED",
      "Opening the local evidence runtime was aborted.",
      { cause: error },
    );
  }
  if (
    code === "ELOOP" ||
    code === "ENOTDIR" ||
    code === "UNSAFE_PATH"
  ) {
    return new LocalEvidenceRuntimeError(
      "UNSAFE_PATH",
      "A private local evidence runtime path is unsafe.",
      { cause: error },
    );
  }
  if (
    error instanceof EvidenceAnnouncementJournalError &&
    error.code === "JOURNAL_CORRUPT" &&
    /symbolic link|non-symlink|not owned|escapes its root/iu.test(error.message)
  ) {
    return new LocalEvidenceRuntimeError(
      "UNSAFE_PATH",
      "A private local announcement journal path is unsafe.",
      { cause: error },
    );
  }
  if (
    error instanceof EvidenceAnnouncementJournalError &&
    [
      "JOURNAL_CORRUPT",
      "JOURNAL_VERSION_UNSUPPORTED",
      "CURSOR_INVALID",
    ].includes(error.code)
  ) {
    return new LocalEvidenceRuntimeError(
      "RUNTIME_CORRUPT",
      "The local announcement journal is corrupt.",
      { cause: error },
    );
  }
  if (
    error instanceof EvidenceCatalogError &&
    [
      "PROJECTION_CONFLICT",
      "LOCATION_CONFLICT",
      "INVALID_PROJECTION",
    ].includes(error.code)
  ) {
    return new LocalEvidenceRuntimeError(
      "RUNTIME_CORRUPT",
      "The active local evidence Catalog is corrupt.",
      { cause: error },
    );
  }
  if (
    error instanceof EvidenceRepositoryError &&
    error.code === "CONTENT_CORRUPT"
  ) {
    return new LocalEvidenceRuntimeError(
      "RUNTIME_CORRUPT",
      "The local evidence repository is corrupt.",
      { cause: error },
    );
  }
  if (
    code === "SQLITE_CORRUPT" ||
    code === "SQLITE_NOTADB" ||
    code === "SQLITE_FORMAT"
  ) {
    return new LocalEvidenceRuntimeError(
      "RUNTIME_CORRUPT",
      "A private local evidence runtime database is corrupt.",
      { cause: error },
    );
  }
  return new LocalEvidenceRuntimeError(
    "IO_FAILURE",
    "Unable to open the local evidence runtime.",
    { cause: error },
  );
}

function runtimeOperationError(
  error: unknown,
  operation: string,
): LocalEvidenceRuntimeError {
  if (error instanceof LocalEvidenceRuntimeError) return error;
  const code = errorCode(error);
  if (code === "OPERATION_ABORTED") {
    return new LocalEvidenceRuntimeError(
      "OPERATION_ABORTED",
      `${operation} was aborted.`,
      { cause: error },
    );
  }
  if (code === "INVALID_REFERENCE" || code === "INVALID_QUERY") {
    return new LocalEvidenceRuntimeError(
      "INVALID_QUERY",
      `${operation} received invalid input.`,
      { cause: error },
    );
  }
  if (
    error instanceof EvidenceAnnouncementJournalError &&
    error.code === "JOURNAL_CORRUPT" &&
    /symbolic link|non-symlink|not owned|escapes its root/iu.test(error.message)
  ) {
    return new LocalEvidenceRuntimeError(
      "UNSAFE_PATH",
      `${operation} encountered an unsafe private journal path.`,
      { cause: error },
    );
  }
  if (
    error instanceof EvidenceAnnouncementJournalError &&
    [
      "JOURNAL_CORRUPT",
      "JOURNAL_VERSION_UNSUPPORTED",
      "CURSOR_INVALID",
    ].includes(error.code)
  ) {
    return new LocalEvidenceRuntimeError(
      "RUNTIME_CORRUPT",
      `${operation} detected corrupt journal state.`,
      { cause: error },
    );
  }
  if (
    error instanceof EvidenceCatalogError &&
    [
      "PROJECTION_CONFLICT",
      "LOCATION_CONFLICT",
      "INVALID_PROJECTION",
    ].includes(error.code)
  ) {
    return new LocalEvidenceRuntimeError(
      "RUNTIME_CORRUPT",
      `${operation} detected corrupt Catalog state.`,
      { cause: error },
    );
  }
  if (
    error instanceof EvidenceRepositoryError &&
    error.code === "CONTENT_CORRUPT"
  ) {
    return new LocalEvidenceRuntimeError(
      "RUNTIME_CORRUPT",
      `${operation} detected corrupt Repository state.`,
      { cause: error },
    );
  }
  if (
    ["SQLITE_CORRUPT", "SQLITE_NOTADB", "SQLITE_FORMAT"].includes(code ?? "") ||
    (code === "SQLITE_ERROR" &&
      /malformed|no such table|schema/iu.test(
        error instanceof Error ? error.message : String(error),
      ))
  ) {
    return new LocalEvidenceRuntimeError(
      "RUNTIME_CORRUPT",
      `${operation} detected corrupt private runtime state.`,
      { cause: error },
    );
  }
  return new LocalEvidenceRuntimeError(
    "IO_FAILURE",
    `${operation} could not access private runtime state.`,
    { cause: error },
  );
}

const PRODUCTION_DEPENDENCIES = {
  acquireRuntimeLock,
  createCatalogGeneration,
  createFilesystemEvidenceRepository,
  openCurrentCatalogGeneration,
  openFilesystemEvidenceAnnouncementJournal,
  openLocalOperationsStore,
  openRuntimeMarker,
  prepareRuntimePaths,
  publishCatalogPointer,
  recoverPendingPublications,
} as const;

type LocalEvidenceRuntimeDependencies =
  Omit<
    typeof PRODUCTION_DEPENDENCIES,
    "createFilesystemEvidenceRepository"
  > &
  Required<
    Pick<
      LocalEvidenceRuntimeTestDependencies,
      "createFilesystemEvidenceRepository"
    >
  > &
  Pick<LocalEvidenceRuntimeTestDependencies, "faultHook">;

export async function openLocalEvidenceRuntimeForTesting(
  options: OpenLocalEvidenceRuntimeOptions,
  overrides: LocalEvidenceRuntimeTestDependencies,
): Promise<LocalEvidenceRuntime> {
  return openLocalEvidenceRuntimeWithDependencies(options, {
    ...PRODUCTION_DEPENDENCIES,
    ...overrides,
  });
}

async function openLocalEvidenceRuntimeWithDependencies(
  options: OpenLocalEvidenceRuntimeOptions,
  dependencies: LocalEvidenceRuntimeDependencies,
): Promise<LocalEvidenceRuntime> {
  assertLocalRuntimeOperationActive(options);
  const paths = await dependencies.prepareRuntimePaths(options.rootDir);
  assertLocalRuntimeOperationActive(options);

  let lock: LocalRuntimeLock | undefined;
  let operations: LocalOperationsStore | undefined;
  let journal: FilesystemEvidenceAnnouncementJournal | undefined;
  let readerProxy: SwitchableCatalogReader | undefined;
  let active: ActiveGeneration | undefined;
  let unownedGeneration: LocalCatalogGeneration | undefined;
  const workers = new Set<LocalEvidenceIndexingWorker>();
  try {
    lock = await dependencies.acquireRuntimeLock(paths.lockPath);
    assertLocalRuntimeOperationActive(options);
    const marker = await dependencies.openRuntimeMarker(paths);
    operations = await dependencies.openLocalOperationsStore(
      paths.operationsDatabasePath,
    );
    const filesystemRepository =
      await dependencies.createFilesystemEvidenceRepository({
      rootDir: paths.repositoryDir,
    });
    journal = await dependencies.openFilesystemEvidenceAnnouncementJournal({
      rootDir: paths.announcementsDir,
      sourceId: marker.sourceId,
    });
    await dependencies.recoverPendingPublications({
      repository: filesystemRepository,
      journal,
      operations,
      repositoryId: marker.repositoryId,
      signal: options.signal,
    });
    const publicDiscovery = options.publicDiscovery === undefined
      ? undefined
      : openEvidenceJournalPublicDiscovery({
          stateDir: paths.publicDiscoveryDir,
          source: options.publicDiscovery.source,
          evidenceSourceId: marker.sourceId,
          journal,
          repository: filesystemRepository,
          signer: options.publicDiscovery.signer,
          blobs: options.publicDiscovery.blobs,
          bridgeFactory: options.publicDiscovery.bridgeFactory,
          ...(options.publicDiscovery.withdrawals === undefined
            ? {}
            : { withdrawals: options.publicDiscovery.withdrawals }),
          ...(options.publicDiscovery.now === undefined
            ? {}
            : { now: options.publicDiscovery.now }),
          ...(options.publicDiscovery.refreshWithinMs === undefined
            ? {}
            : { refreshWithinMs: options.publicDiscovery.refreshWithinMs }),
        });
    if (publicDiscovery !== undefined) {
      try {
        await publicDiscovery.sync();
      } catch (error) {
        throw publicDiscoveryRuntimeError(error);
      }
    }

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

    const current = await dependencies.openCurrentCatalogGeneration(paths);
    let selected: LocalCatalogGeneration;
    let worker: LocalEvidenceIndexingWorker;
    if (current === null) {
      const created = await dependencies.createCatalogGeneration(paths);
      unownedGeneration = created;
      const bootstrapWorker = buildWorker(created);
      workers.add(bootstrapWorker);
      const highWater = await journal.getHighWaterCursor({
        signal: options.signal,
      });
      if (highWater !== undefined) {
        await bootstrapWorker.syncTo(highWater, { signal: options.signal });
      }
      await dependencies.publishCatalogPointer(paths, created.pointer);
      selected = created;
      worker = bootstrapWorker;
      unownedGeneration = undefined;
    } else {
      selected = current;
      worker = buildWorker(selected);
      await worker.validateCheckpoint({ signal: options.signal });
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
      const recent = await operations!.listFailures(
        active!.value.pointer.generationId,
        { limit: 10 },
      );
      const reportedState: LocalRuntimeLifecycleState =
        state === "closing" || state === "closed"
          ? state
          : rebuildRunning
            ? "rebuilding"
            : rebuildFailed ||
                workerStatus.transientFailure !== undefined ||
                workerStatus.fatal !== undefined
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
          created = await dependencies.createCatalogGeneration(paths);
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

          await dependencies.publishCatalogPointer(paths, created.pointer);
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
      ...(publicDiscovery === undefined ? {} : { publicDiscovery }),
      async sync(operationOptions) {
        assertReadable();
        assertLocalRuntimeOperationActive(operationOptions);
        try {
          const captured = await journal!.getHighWaterCursor(operationOptions);
          const report = await active!.worker.syncTo(captured, operationOptions);
          await publicDiscovery?.sync();
          return report;
        } catch (error) {
          throw runtimeOperationError(error, "Local evidence synchronization");
        }
      },
      async awaitIndexed(untrustedReference, operationOptions) {
        assertReadable();
        assertLocalRuntimeOperationActive(operationOptions);
        try {
          const reference = parseEvidenceRecordReference(untrustedReference);
          return await active!.worker.awaitReference(reference, operationOptions);
        } catch (error) {
          throw runtimeOperationError(error, "Local evidence indexing");
        }
      },
      async getStatus() {
        if (state === "closed") return lastStatus!;
        try {
          lastStatus = await computeStatus();
          return lastStatus;
        } catch (error) {
          throw runtimeOperationError(error, "Local evidence status");
        }
      },
      async listIndexingFailures(query, operationOptions) {
        assertReadable();
        assertLocalRuntimeOperationActive(operationOptions);
        try {
          return await operations!.listFailures(
            active!.value.pointer.generationId,
            query,
          );
        } catch (error) {
          throw runtimeOperationError(error, "Local indexing failure listing");
        }
      },
      async close(operationOptions) {
        if (state === "closed") return;
        if (closePromise !== undefined) return closePromise;
        assertLocalRuntimeOperationActive(operationOptions);
        state = "closing";
        closePromise = (async () => {
          let primary: unknown;
          await dependencies.faultHook?.("before-runtime-close");
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
          await dependencies.faultHook?.("during-runtime-close");
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
          await dependencies.faultHook?.("after-runtime-close");
          if (primary !== undefined) {
            throw runtimeOperationError(primary, "Closing the local evidence runtime");
          }
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
    throw runtimeOpenError(error);
  }
}

export async function openLocalEvidenceRuntime(
  options: OpenLocalEvidenceRuntimeOptions,
): Promise<LocalEvidenceRuntime> {
  return openLocalEvidenceRuntimeWithDependencies(
    options,
    PRODUCTION_DEPENDENCIES,
  );
}

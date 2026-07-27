// SPDX-License-Identifier: MIT
import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import {
  EvidenceAnnouncementJournalError,
  openFilesystemEvidenceAnnouncementJournal,
  type FilesystemEvidenceAnnouncementJournal,
} from "@jinn-network/evidence-discovery/journal";
import {
  EvidenceCatalogError,
} from "@jinn-network/evidence-discovery";
import {
  createRecordReference,
  EvidenceRepositoryError,
  type EvidenceRecordReference,
  type EvidenceRepository,
} from "@jinn-network/evidence-repository";
import {
  createFilesystemEvidenceRepository,
} from "@jinn-network/evidence-repository/fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  openFilesystemEvidenceAnnouncementJournalForTesting,
  type JournalAppendFaultPoint,
} from "../../discovery/dist/journal/journal.js";
import {
  publishCatalogPointer,
  type LocalCatalogPointerV1,
} from "./generations.js";
import {
  openLocalOperationsStore,
  type IndexingCheckpointInput,
  type LocalOperationsStore,
  type PublicationIntent,
} from "./operations-store.js";
import type { LocalRuntimePaths } from "./paths.js";
import {
  openLocalEvidenceRuntime,
  openLocalEvidenceRuntimeForTesting,
  type LocalEvidenceRuntimeFaultPoint,
  type LocalEvidenceRuntimeTestDependencies,
} from "./runtime.js";
import type { LocalEvidenceRuntime } from "./types.js";

type FaultPoint =
  | "after-outbox-stage"
  | "after-repository-return"
  | "after-stored-mark"
  | "journal-before-file-sync"
  | "journal-before-hard-link"
  | "journal-before-temporary-removal"
  | "journal-before-directory-sync"
  | "after-journal-append"
  | "after-announced-mark"
  | "after-outbox-delete"
  | "before-outcome-checkpoint"
  | "after-outcome-checkpoint"
  | "before-generation-pointer"
  | "after-generation-pointer"
  | "before-runtime-close"
  | "during-runtime-close"
  | "after-runtime-close";

const CHILD_POINT = process.env.JINN_LOCAL_HARDENING_POINT as
  | FaultPoint
  | undefined;
const CHILD_ROOT = process.env.JINN_LOCAL_HARDENING_ROOT;
const CHILD_MARKER = process.env.JINN_LOCAL_HARDENING_MARKER;
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const protocolFixtureRoot = new URL(
  ".",
  import.meta.resolve(
    "@jinn-network/evidence-protocol/fixtures/golden-execution-evidence-v1/README.md",
  ),
);

const JOURNAL_FAULTS = new Map<FaultPoint, JournalAppendFaultPoint>([
  ["journal-before-file-sync", "before-file-sync"],
  ["journal-before-hard-link", "before-hard-link"],
  ["journal-before-temporary-removal", "before-temporary-removal"],
  ["journal-before-directory-sync", "before-directory-sync"],
]);
const POINTER_FAULTS = new Set<FaultPoint>([
  "before-generation-pointer",
  "after-generation-pointer",
]);
const CLOSE_FAULTS = new Set<FaultPoint>([
  "before-runtime-close",
  "during-runtime-close",
  "after-runtime-close",
]);
const OUTCOME_FAULTS = new Set<FaultPoint>([
  "before-outcome-checkpoint",
  "after-outcome-checkpoint",
]);

async function goldenExecutionBytes(): Promise<Uint8Array> {
  return readFile(new URL("execution/ro-crate-metadata.json", protocolFixtureRoot));
}

function never(): Promise<never> {
  return new Promise<never>(() => {});
}

function hookFor(
  target: FaultPoint,
  markerPath: string,
): (point: FaultPoint) => Promise<void> {
  let reached = false;
  return async (point) => {
    if (point !== target || reached) return;
    reached = true;
    await writeFile(markerPath, point, { mode: 0o600 });
    await never();
  };
}

function wrapRepository<T extends EvidenceRepository>(
  repository: T,
  hook: (point: FaultPoint) => Promise<void>,
): T {
  return new Proxy(repository, {
    get(target, property) {
      if (property === "putRecord") {
        return async (
          family: Parameters<EvidenceRepository["putRecord"]>[0],
          bytes: Parameters<EvidenceRepository["putRecord"]>[1],
          options: Parameters<EvidenceRepository["putRecord"]>[2],
        ) => {
          const receipt = await target.putRecord(family, bytes, options);
          await hook("after-repository-return");
          return receipt;
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function"
        ? (value as (...args: never[]) => unknown).bind(target)
        : value;
    },
  });
}

function wrapOperations(
  operations: LocalOperationsStore,
  hook: (point: FaultPoint) => Promise<void>,
): LocalOperationsStore {
  return new Proxy(operations, {
    get(target, property) {
      if (property === "stagePublication") {
        return async (intent: PublicationIntent) => {
          const result = await target.stagePublication(intent);
          await hook("after-outbox-stage");
          return result;
        };
      }
      if (property === "markPublicationStored") {
        return async (operationKey: string) => {
          await target.markPublicationStored(operationKey);
          await hook("after-stored-mark");
        };
      }
      if (property === "markPublicationAnnounced") {
        return async (operationKey: string) => {
          await target.markPublicationAnnounced(operationKey);
          await hook("after-announced-mark");
        };
      }
      if (property === "completePublication") {
        return async (operationKey: string) => {
          await target.completePublication(operationKey);
          await hook("after-outbox-delete");
        };
      }
      if (property === "recordIndexedAndCheckpoint") {
        return async (input: IndexingCheckpointInput) => {
          await hook("before-outcome-checkpoint");
          await target.recordIndexedAndCheckpoint(input);
          await hook("after-outcome-checkpoint");
        };
      }
      if (property === "recordFailureAndCheckpoint") {
        return async (
          input: Parameters<LocalOperationsStore["recordFailureAndCheckpoint"]>[0],
        ) => {
          await hook("before-outcome-checkpoint");
          await target.recordFailureAndCheckpoint(input);
          await hook("after-outcome-checkpoint");
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function"
        ? (value as (...args: never[]) => unknown).bind(target)
        : value;
    },
  });
}

function wrapJournal(
  journal: FilesystemEvidenceAnnouncementJournal,
  hook: (point: FaultPoint) => Promise<void>,
): FilesystemEvidenceAnnouncementJournal {
  return new Proxy(journal, {
    get(target, property) {
      if (property === "appendAvailable") {
        return async (
          input: Parameters<
            FilesystemEvidenceAnnouncementJournal["appendAvailable"]
          >[0],
          options: Parameters<
            FilesystemEvidenceAnnouncementJournal["appendAvailable"]
          >[1],
        ) => {
          const receipt = await target.appendAvailable(input, options);
          await hook("after-journal-append");
          return receipt;
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function"
        ? (value as (...args: never[]) => unknown).bind(target)
        : value;
    },
  });
}

function childDependencies(
  target: FaultPoint,
  markerPath: string,
): LocalEvidenceRuntimeTestDependencies {
  const hook = hookFor(target, markerPath);
  return {
    async createFilesystemEvidenceRepository(options) {
      return wrapRepository(
        await createFilesystemEvidenceRepository(options),
        hook,
      );
    },
    async openLocalOperationsStore(path) {
      return wrapOperations(await openLocalOperationsStore(path), hook);
    },
    async openFilesystemEvidenceAnnouncementJournal(options) {
      const journalPoint = JOURNAL_FAULTS.get(target);
      const journal = journalPoint === undefined
        ? await openFilesystemEvidenceAnnouncementJournal(options)
        : await openFilesystemEvidenceAnnouncementJournalForTesting(
            options,
            async (point) => {
              if (point === journalPoint) await hook(target);
            },
          );
      return wrapJournal(journal, hook);
    },
    async publishCatalogPointer(paths, pointer) {
      await hook("before-generation-pointer");
      await publishCatalogPointer(paths, pointer);
      await hook("after-generation-pointer");
    },
    async faultHook(point: LocalEvidenceRuntimeFaultPoint) {
      await hook(point);
    },
  };
}

async function runChild(): Promise<void> {
  if (
    CHILD_POINT === undefined ||
    CHILD_ROOT === undefined ||
    CHILD_MARKER === undefined
  ) {
    throw new Error("The hardening child configuration is incomplete.");
  }
  const runtime = await openLocalEvidenceRuntimeForTesting(
    { rootDir: CHILD_ROOT },
    childDependencies(CHILD_POINT, CHILD_MARKER),
  );
  if (POINTER_FAULTS.has(CHILD_POINT)) await never();
  const receipt = await runtime.repository.putRecord(
    "execution-evidence",
    await goldenExecutionBytes(),
  );
  if (CLOSE_FAULTS.has(CHILD_POINT)) {
    await runtime.awaitIndexed(receipt.reference, {
      signal: AbortSignal.timeout(10_000),
    });
    await runtime.close();
  }
  await never();
}

if (CHILD_POINT !== undefined) {
  describe("local evidence runtime hardening child", () => {
    it("stops at its injected durable boundary", async () => {
      await runChild();
    }, 60_000);
  });
} else {
  const temporaryRoots: string[] = [];
  const openRuntimes: LocalEvidenceRuntime[] = [];

  afterEach(async () => {
    await Promise.allSettled(
      openRuntimes.splice(0).map((runtime) => runtime.close()),
    );
    await Promise.all(
      temporaryRoots.splice(0).map((path) => rm(path, {
        recursive: true,
        force: true,
      })),
    );
  });

  async function openTrackedRuntime(rootDir: string): Promise<LocalEvidenceRuntime> {
    const runtime = await openLocalEvidenceRuntime({ rootDir });
    openRuntimes.push(runtime);
    return runtime;
  }

  async function closeTrackedRuntime(runtime: LocalEvidenceRuntime): Promise<void> {
    await runtime.close();
    const index = openRuntimes.indexOf(runtime);
    if (index >= 0) openRuntimes.splice(index, 1);
  }

  async function waitForBoundary(
    markerPath: string,
    child: ReturnType<typeof spawn>,
  ): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error("The hardening child exited before its boundary.");
      }
      try {
        if ((await readFile(markerPath, "utf8")).length > 0) return;
      } catch {
        await delay(25);
      }
    }
    throw new Error("The hardening child did not reach its boundary.");
  }

  function killChildProcessGroup(child: ReturnType<typeof spawn>): void {
    if (child.pid === undefined) {
      throw new Error("The hardening child has no process identifier.");
    }
    process.kill(-child.pid, "SIGKILL");
  }

  async function forceProjectorMismatch(rootDir: string): Promise<string> {
    const path = join(rootDir, "catalog", "current.json");
    const pointer = JSON.parse(await readFile(path, "utf8")) as
      LocalCatalogPointerV1;
    await writeFile(path, `${JSON.stringify({
      ...pointer,
      projectorVersion: "fault-harness-legacy",
    })}\n`, { mode: 0o600 });
    return pointer.generationId;
  }

  async function preparePointerRoot(
    rootDir: string,
    expectedBytes: Uint8Array,
  ): Promise<string> {
    const runtime = await openTrackedRuntime(rootDir);
    const receipt = await runtime.repository.putRecord(
      "execution-evidence",
      expectedBytes,
    );
    expect((await runtime.awaitIndexed(receipt.reference)).status)
      .toBe("indexed");
    await closeTrackedRuntime(runtime);
    return forceProjectorMismatch(rootDir);
  }

  function inspectAtomicRows(
    rootDir: string,
  ): { outcomes: number; cursors: number; checkpoints: number } {
    const database = new Database(
      join(rootDir, "operations", "runtime.sqlite"),
      { readonly: true, fileMustExist: true },
    );
    try {
      const count = (table: string) =>
        (database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as {
          count: number;
        }).count;
      return {
        outcomes: count("indexing_outcomes"),
        cursors: count("processed_cursors"),
        checkpoints: count("indexer_checkpoints"),
      };
    } finally {
      database.close();
    }
  }

  async function assertPrivateTree(path: string): Promise<void> {
    if (process.platform === "win32") return;
    const stat = await lstat(path);
    expect(stat.isSymbolicLink()).toBe(false);
    if (stat.isDirectory()) {
      expect(stat.mode & 0o777).toBe(0o700);
      for (const child of await readdir(path)) {
        await assertPrivateTree(join(path, child));
      }
    } else if (stat.isFile()) {
      expect(stat.mode & 0o777).toBe(0o600);
    }
  }

  async function verifyRecoveredRoot(
    rootDir: string,
    expectedBytes: Uint8Array,
    reference: EvidenceRecordReference,
  ): Promise<void> {
    const runtime = await openTrackedRuntime(rootDir);
    await vi.waitFor(async () => {
      expect((await runtime.getStatus()).state).toBe("ready");
    }, { timeout: 10_000 });
    expect(Array.from(
      (await runtime.repository.getRecord(reference)) ?? [],
    )).toEqual(Array.from(expectedBytes));
    const indexed = await runtime.awaitIndexed(reference, {
      signal: AbortSignal.timeout(10_000),
    });
    expect(indexed.status).toBe("indexed");
    if (indexed.status !== "indexed") {
      throw new Error("The recovered record was not indexed.");
    }
    expect(await runtime.catalog.getRecord(reference)).toEqual(indexed.projection);
    const firstSync = await runtime.sync({
      signal: AbortSignal.timeout(10_000),
    });
    const secondSync = await runtime.sync({
      signal: AbortSignal.timeout(10_000),
    });
    expect(secondSync).toEqual(firstSync);
    expect(await runtime.getStatus()).toMatchObject({
      pendingPublications: 0,
      pendingAnnouncements: 0,
      terminalFailureCount: 0,
    });
    const matches = await runtime.catalog.findExecutions({
      executionId: "urn:uuid:22222222-2222-4222-8222-222222222222",
    });
    expect(matches.items.map((item) => item.reference)).toEqual([reference]);
    await closeTrackedRuntime(runtime);

    const journal = await openFilesystemEvidenceAnnouncementJournal({
      rootDir: join(rootDir, "announcements"),
      sourceId: (JSON.parse(
        await readFile(join(rootDir, "runtime.json"), "utf8"),
      ) as { sourceId: string }).sourceId,
    });
    expect(await journal.getEntryCount()).toBe(1);
    expect(await journal.findAvailable(reference)).not.toBeNull();
    await journal.close();
    await assertPrivateTree(rootDir);

    const reopened = await openTrackedRuntime(rootDir);
    expect(Array.from(
      (await reopened.repository.getRecord(reference)) ?? [],
    )).toEqual(Array.from(expectedBytes));
    expect(await reopened.catalog.getRecord(reference))
      .toEqual(indexed.projection);
    expect(await reopened.sync({
      signal: AbortSignal.timeout(10_000),
    })).toEqual(firstSync);
    await closeTrackedRuntime(reopened);
  }

  describe("local evidence runtime process and power-transition hardening", () => {
    it.runIf(process.platform !== "win32")(
      "recovers every named durable transition without split state or duplicates",
      async () => {
        const points: readonly FaultPoint[] = [
          "after-outbox-stage",
          "after-repository-return",
          "after-stored-mark",
          "journal-before-file-sync",
          "journal-before-hard-link",
          "journal-before-temporary-removal",
          "journal-before-directory-sync",
          "after-journal-append",
          "after-announced-mark",
          "after-outbox-delete",
          "before-outcome-checkpoint",
          "after-outcome-checkpoint",
          "before-generation-pointer",
          "after-generation-pointer",
          "before-runtime-close",
          "during-runtime-close",
          "after-runtime-close",
        ];
        const expectedBytes = await goldenExecutionBytes();
        const reference = createRecordReference(
          "execution-evidence",
          expectedBytes,
        );
        const vitestEntry = fileURLToPath(
          new URL("vitest.mjs", import.meta.resolve("vitest/package.json")),
        );

        for (const point of points) {
          const parent = await mkdtemp(join(tmpdir(), "jinn-local-fault-"));
          temporaryRoots.push(parent);
          const rootDir = join(parent, "runtime");
          const markerPath = join(parent, "boundary");
          const oldGenerationId = POINTER_FAULTS.has(point)
            ? await preparePointerRoot(rootDir, expectedBytes)
            : undefined;
          let output = "";
          const child = spawn(
            process.execPath,
            [vitestEntry, "run", "src/hardening.test.ts"],
            {
              cwd: packageRoot,
              env: {
                ...process.env,
                JINN_LOCAL_HARDENING_POINT: point,
                JINN_LOCAL_HARDENING_ROOT: rootDir,
                JINN_LOCAL_HARDENING_MARKER: markerPath,
              },
              stdio: ["ignore", "pipe", "pipe"],
              detached: true,
            },
          );
          child.stdout?.on("data", (chunk: Buffer) => {
            output += chunk.toString();
          });
          child.stderr?.on("data", (chunk: Buffer) => {
            output += chunk.toString();
          });
          const exited = new Promise<void>((resolve, reject) => {
            child.once("error", reject);
            child.once("exit", () => resolve());
          });
          try {
            await waitForBoundary(markerPath, child);
          } catch (error) {
            killChildProcessGroup(child);
            await exited;
            throw new Error(`${point}: ${String(error)}\n${output}`);
          }
          killChildProcessGroup(child);
          await exited;

          if (OUTCOME_FAULTS.has(point)) {
            expect(inspectAtomicRows(rootDir)).toEqual(
              point === "before-outcome-checkpoint"
                ? { outcomes: 0, cursors: 0, checkpoints: 0 }
                : { outcomes: 1, cursors: 1, checkpoints: 1 },
            );
          }
          if (POINTER_FAULTS.has(point)) {
            const pointer = JSON.parse(
              await readFile(join(rootDir, "catalog", "current.json"), "utf8"),
            ) as LocalCatalogPointerV1;
            if (point === "before-generation-pointer") {
              expect(pointer.generationId).toBe(oldGenerationId);
            } else {
              expect(pointer.generationId).not.toBe(oldGenerationId);
            }
          }
          await verifyRecoveredRoot(rootDir, expectedBytes, reference);
        }
      },
      180_000,
    );
  });

  describe("local evidence runtime private opening errors", () => {
    it("maps a corrupt journal marker without leaking its private error type", async () => {
      const rootDir = await mkdtemp(join(tmpdir(), "jinn-local-corrupt-"));
      temporaryRoots.push(rootDir);
      const runtime = await openTrackedRuntime(rootDir);
      await closeTrackedRuntime(runtime);
      await writeFile(
        join(rootDir, "announcements", "journal.json"),
        new Uint8Array([0xff]),
      );
      const opening = openLocalEvidenceRuntime({ rootDir });
      await expect(opening).rejects.toMatchObject({
        name: "LocalEvidenceRuntimeError",
        code: "RUNTIME_CORRUPT",
        cause: {
          name: "EvidenceAnnouncementJournalError",
          code: "JOURNAL_CORRUPT",
        },
      });
    });

    it.runIf(process.platform !== "win32")(
      "maps an internal journal parent symlink to UNSAFE_PATH with its cause",
      async () => {
        const rootDir = await mkdtemp(join(tmpdir(), "jinn-local-unsafe-"));
        temporaryRoots.push(rootDir);
        const runtime = await openTrackedRuntime(rootDir);
        await closeTrackedRuntime(runtime);
        const events = join(rootDir, "announcements", "events");
        const target = join(rootDir, "journal-events-target");
        await rm(events, { recursive: true });
        await mkdir(target, { mode: 0o700 });
        await symlink(target, events, "dir");
        await expect(openLocalEvidenceRuntime({ rootDir })).rejects.toMatchObject({
          name: "LocalEvidenceRuntimeError",
          code: "UNSAFE_PATH",
          cause: {
            name: "EvidenceAnnouncementJournalError",
            code: "JOURNAL_CORRUPT",
          },
        });
      },
    );

    it("maps private Journal, Catalog, Repository, and SQLite failures with cause identity", async () => {
      const cases: ReadonlyArray<{
        readonly name: string;
        readonly error: Error;
        readonly code: "IO_FAILURE" | "RUNTIME_CORRUPT";
        readonly overrides: (
          error: Error,
        ) => LocalEvidenceRuntimeTestDependencies;
      }> = [
        {
          name: "journal",
          error: new EvidenceAnnouncementJournalError(
            "IO_FAILURE",
            "injected journal failure",
          ),
          code: "IO_FAILURE",
          overrides: (error) => ({
            async openFilesystemEvidenceAnnouncementJournal() {
              throw error;
            },
          }),
        },
        {
          name: "catalog",
          error: new EvidenceCatalogError("IO_FAILURE", "injected Catalog failure"),
          code: "IO_FAILURE",
          overrides: (error) => ({
            async openCurrentCatalogGeneration() {
              throw error;
            },
          }),
        },
        {
          name: "repository",
          error: new EvidenceRepositoryError(
            "ACCESS_DENIED",
            "injected repository failure",
          ),
          code: "IO_FAILURE",
          overrides: (error) => ({
            async createFilesystemEvidenceRepository() {
              throw error;
            },
          }),
        },
        {
          name: "sqlite",
          error: Object.assign(new Error("injected SQLite failure"), {
            code: "SQLITE_NOTADB",
          }),
          code: "RUNTIME_CORRUPT",
          overrides: (error) => ({
            async openLocalOperationsStore() {
              throw error;
            },
          }),
        },
      ];
      for (const thisCase of cases) {
        const rootDir = await mkdtemp(join(tmpdir(), "jinn-local-mapped-"));
        temporaryRoots.push(rootDir);
        await expect(openLocalEvidenceRuntimeForTesting(
          { rootDir },
          thisCase.overrides(thisCase.error),
        ), thisCase.name).rejects.toMatchObject({
          name: "LocalEvidenceRuntimeError",
          code: thisCase.code,
          cause: thisCase.error,
        });
      }
    });
  });
}

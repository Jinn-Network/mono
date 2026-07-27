// SPDX-License-Identifier: Apache-2.0
import {
  existsSync,
} from "node:fs";
import {
  chmod,
  link,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRecordReference } from "@jinn-network/evidence-repository";
import { afterEach, expect, test, vi } from "vitest";

const fault = vi.hoisted(() => ({
  failTemporaryCleanup: false,
  failDirectorySync: false,
  failDirectorySyncCode: "EIO",
  failDirectorySyncPath: undefined as string | undefined,
  failDirectorySyncPathOccurrence: undefined as number | undefined,
  syncCalls: 0,
  syncCallsByPath: new Map<string, number>(),
  abortOnDirectorySync: undefined as AbortController | undefined,
  abortOnTemporaryClose: undefined as AbortController | undefined,
  abortOnTemporaryCleanup: undefined as AbortController | undefined,
  failHandleSyncPath: undefined as string | undefined,
  failHandleClosePath: undefined as string | undefined,
  abortOnHandleOpen: undefined as
    | { readonly path: string; readonly controller: AbortController }
    | undefined,
  observeHandleClosePath: undefined as string | undefined,
  observedHandleCloseCount: 0,
  events: [] as string[],
  beforeLink: undefined as
    | ((source: string, destination: string) => Promise<void>)
    | undefined,
  afterLink: undefined as
    | ((source: string, destination: string) => Promise<void>)
    | undefined,
  afterMkdir: undefined as
    | ((path: string) => Promise<void>)
    | undefined,
  afterLstat: undefined as
    | ((path: string) => Promise<void>)
    | undefined,
  failLstatPath: undefined as string | undefined,
  failLstatCode: "EPERM",
  failOpenPath: undefined as string | undefined,
  failOpenCode: "EACCES",
  failChmodPath: undefined as string | undefined,
  failChmodCode: "EPERM",
  foreignOwnedLstatPath: undefined as string | undefined,
  foreignOwnedHandlePath: undefined as string | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    chmod: async (
      path: Parameters<typeof original.chmod>[0],
      mode: Parameters<typeof original.chmod>[1],
    ) => {
      if (fault.failChmodPath === String(path)) {
        throw Object.assign(new Error("synthetic chmod denial"), {
          code: fault.failChmodCode,
        });
      }
      return original.chmod(path, mode);
    },
    link: async (
      existingPath: Parameters<typeof original.link>[0],
      newPath: Parameters<typeof original.link>[1],
    ) => {
      await fault.beforeLink?.(String(existingPath), String(newPath));
      const result = await original.link(existingPath, newPath);
      fault.events.push(`link:${String(newPath)}`);
      await fault.afterLink?.(String(existingPath), String(newPath));
      return result;
    },
    mkdir: async (
      path: Parameters<typeof original.mkdir>[0],
      options?: Parameters<typeof original.mkdir>[1],
    ) => {
      const result = await original.mkdir(path, options as never);
      fault.events.push(`mkdir:${String(path)}`);
      await fault.afterMkdir?.(String(path));
      return result;
    },
    lstat: async (
      path: Parameters<typeof original.lstat>[0],
      options?: Parameters<typeof original.lstat>[1],
    ) => {
      if (fault.failLstatPath === String(path)) {
        throw Object.assign(new Error("synthetic lstat denial"), {
          code: fault.failLstatCode,
        });
      }
      const stats = await original.lstat(path, options);
      await fault.afterLstat?.(String(path));
      if (fault.foreignOwnedLstatPath !== String(path)) return stats;
      const foreign = Object.create(
        Object.getPrototypeOf(stats),
        Object.getOwnPropertyDescriptors(stats),
      ) as typeof stats;
      Object.defineProperty(foreign, "uid", {
        configurable: true,
        enumerable: true,
        value: typeof stats.uid === "bigint"
          ? stats.uid + 1n
          : stats.uid + 1,
      });
      return foreign;
    },
    open: async (
      path: Parameters<typeof original.open>[0],
      flags: Parameters<typeof original.open>[1],
      mode?: Parameters<typeof original.open>[2],
    ) => {
      if (fault.failOpenPath === String(path)) {
        throw Object.assign(new Error("synthetic open denial"), {
          code: fault.failOpenCode,
        });
      }
      const handle = await original.open(path, flags, mode);
      fault.events.push(`open:${String(path)}`);
      if (
        fault.abortOnTemporaryClose !== undefined &&
        (
          String(path).includes("/.tmp-") ||
          String(path).includes("/.writing-")
        )
      ) {
        const close = handle.close.bind(handle);
        Object.defineProperty(handle, "close", {
          configurable: true,
          value: async () => {
            await close();
            fault.abortOnTemporaryClose?.abort();
          },
        });
      }
      if (fault.failHandleSyncPath === String(path)) {
        Object.defineProperty(handle, "sync", {
          configurable: true,
          value: async () => {
            throw Object.assign(new Error("synthetic handle sync failure"), {
              code: "EIO",
            });
          },
        });
      }
      if (fault.foreignOwnedHandlePath === String(path)) {
        const stat = handle.stat.bind(handle);
        Object.defineProperty(handle, "stat", {
          configurable: true,
          value: async (...arguments_: Parameters<typeof stat>) => {
            const stats = await stat(...arguments_);
            const foreign = Object.create(
              Object.getPrototypeOf(stats),
              Object.getOwnPropertyDescriptors(stats),
            ) as typeof stats;
            Object.defineProperty(foreign, "uid", {
              configurable: true,
              enumerable: true,
              value: typeof stats.uid === "bigint"
                ? stats.uid + 1n
                : stats.uid + 1,
            });
            return foreign;
          },
        });
      }
      if (fault.failHandleClosePath === String(path)) {
        const close = handle.close.bind(handle);
        Object.defineProperty(handle, "close", {
          configurable: true,
          value: async () => {
            await close();
            throw Object.assign(new Error("synthetic handle close failure"), {
              code: "EIO",
            });
          },
        });
      }
      if (fault.observeHandleClosePath === String(path)) {
        const close = handle.close.bind(handle);
        Object.defineProperty(handle, "close", {
          configurable: true,
          value: async () => {
            fault.observedHandleCloseCount += 1;
            await close();
          },
        });
      }
      if (fault.abortOnHandleOpen?.path === String(path)) {
        fault.abortOnHandleOpen.controller.abort();
      }
      return handle;
    },
    rm: async (
      path: Parameters<typeof original.rm>[0],
      options?: Parameters<typeof original.rm>[1],
    ) => {
      if (
        fault.failTemporaryCleanup &&
        String(path).includes("/.tmp-")
      ) {
        throw Object.assign(new Error("synthetic temp cleanup failure"), {
          code: "EIO",
        });
      }
      const result = await original.rm(path, options);
      fault.events.push(`rm:${String(path)}`);
      if (String(path).includes("/.tmp-")) {
        fault.abortOnTemporaryCleanup?.abort();
      }
      return result;
    },
  };
});

vi.mock("./validation.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./validation.js")>();
  return {
    ...original,
    syncDirectory: async (path: string) => {
      fault.syncCalls += 1;
      const pathCalls = (fault.syncCallsByPath.get(path) ?? 0) + 1;
      fault.syncCallsByPath.set(path, pathCalls);
      if (
        fault.failDirectorySync &&
        (
          fault.failDirectorySyncPath === undefined ||
          fault.failDirectorySyncPath === path
        ) &&
        (
          fault.failDirectorySyncPathOccurrence === undefined ||
          fault.failDirectorySyncPathOccurrence === pathCalls
        )
      ) {
        throw Object.assign(new Error("synthetic directory sync failure"), {
          code: fault.failDirectorySyncCode,
        });
      }
      await original.syncDirectory(path);
      fault.events.push(`sync:${path}`);
      fault.abortOnDirectorySync?.abort();
    },
  };
});

import { derivePublicationIdentities } from "../identities.js";
import { EvidencePublicationError } from "../errors.js";
import type { PublicationJournalEntry } from "../types.js";
import { createFilesystemPublicationJournalStore } from "./index.js";

const roots: string[] = [];

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((resume) => {
    resolve = resume;
  });
  return { promise, resolve };
}

function entry(): PublicationJournalEntry {
  const destination = "urn:jinn:publication-destination:fs-fault-test";
  const records = [
    createRecordReference("execution-evidence", Uint8Array.of(1)),
  ];
  return {
    schemaVersion: 1,
    ...derivePublicationIdentities(records, [], destination),
    destination,
    repositoryCapabilities: {},
    artifacts: [],
    records,
    storedArtifacts: [],
    storedRecords: [],
    completed: false,
  };
}

afterEach(async () => {
  fault.failTemporaryCleanup = false;
  fault.failDirectorySync = false;
  fault.failDirectorySyncCode = "EIO";
  fault.failDirectorySyncPath = undefined;
  fault.failDirectorySyncPathOccurrence = undefined;
  fault.syncCalls = 0;
  fault.syncCallsByPath.clear();
  fault.abortOnDirectorySync = undefined;
  fault.abortOnTemporaryClose = undefined;
  fault.abortOnTemporaryCleanup = undefined;
  fault.failHandleSyncPath = undefined;
  fault.failHandleClosePath = undefined;
  fault.abortOnHandleOpen = undefined;
  fault.observeHandleClosePath = undefined;
  fault.observedHandleCloseCount = 0;
  fault.events.length = 0;
  fault.beforeLink = undefined;
  fault.afterLink = undefined;
  fault.afterMkdir = undefined;
  fault.afterLstat = undefined;
  fault.failLstatPath = undefined;
  fault.failLstatCode = "EPERM";
  fault.failOpenPath = undefined;
  fault.failOpenCode = "EACCES";
  fault.failChmodPath = undefined;
  fault.failChmodCode = "EPERM";
  fault.foreignOwnedLstatPath = undefined;
  fault.foreignOwnedHandlePath = undefined;
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ),
  );
});

test("attempts directory sync after linked temp cleanup fails and preserves cleanup cause", async () => {
  const root = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(join(tmpdir(), "jinn-publication-journal-fault-"))
  );
  roots.push(root);
  const store = await createFilesystemPublicationJournalStore({
    rootDir: root,
  });
  const syncCallsBeforePublication = fault.syncCalls;
  const journalEntry = entry();
  const hex = journalEntry.bundleKey.slice(7);
  await mkdir(
    join(
      root,
      "entries",
      "sha256",
      hex.slice(0, 2),
      hex.slice(2),
    ),
    { recursive: true, mode: 0o700 },
  );
  fault.failTemporaryCleanup = true;

  let caught: unknown;
  try {
    await store.create(journalEntry);
  } catch (error) {
    caught = error;
  }

  expect(caught).toMatchObject({
    code: "IO_FAILURE",
    cause: {
      message: "synthetic temp cleanup failure",
    },
  });
  expect(fault.syncCalls).toBe(syncCallsBeforePublication + 5);
  const revisionDir = join(
    root,
    "entries",
    "sha256",
    hex.slice(0, 2),
    hex.slice(2),
  );
  expect(await readdir(revisionDir)).toHaveLength(2);
  fault.failTemporaryCleanup = false;
  const reopened = await createFilesystemPublicationJournalStore({
    rootDir: root,
  });
  await expect(reopened.load(journalEntry.bundleKey)).resolves.toMatchObject({
    revision: 0,
  });
  expect(await readdir(revisionDir)).toEqual([
    "00000000000000000000.json",
  ]);
});

test("does not publish through a hierarchy directory whose parent sync fails", async () => {
  const root = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(join(tmpdir(), "jinn-publication-journal-fault-"))
  );
  roots.push(root);
  const store = await createFilesystemPublicationJournalStore({
    rootDir: root,
  });
  const journalEntry = entry();
  const hex = journalEntry.bundleKey.slice(7);
  const finalPath = join(
    root,
    "entries",
    "sha256",
    hex.slice(0, 2),
    hex.slice(2),
    "00000000000000000000.json",
  );
  const syncCallsBeforePublication = fault.syncCalls;
  fault.failDirectorySync = true;

  await expect(store.create(journalEntry)).rejects.toMatchObject({
    code: "IO_FAILURE",
  });
  expect(fault.syncCalls).toBe(syncCallsBeforePublication + 1);
  expect(existsSync(finalPath)).toBe(false);
});

test("observes cancellation after durable hierarchy links and before publication", async () => {
  const root = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(join(tmpdir(), "jinn-publication-journal-fault-"))
  );
  roots.push(root);
  const store = await createFilesystemPublicationJournalStore({
    rootDir: root,
  });
  const journalEntry = entry();
  const hex = journalEntry.bundleKey.slice(7);
  const finalPath = join(
    root,
    "entries",
    "sha256",
    hex.slice(0, 2),
    hex.slice(2),
    "00000000000000000000.json",
  );
  const controller = new AbortController();
  fault.abortOnDirectorySync = controller;

  await expect(
    store.create(journalEntry, { signal: controller.signal }),
  ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
  expect(existsSync(finalPath)).toBe(false);
});

test("observes cancellation immediately after the flushed temp handle closes and before linking", async () => {
  const root = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(join(tmpdir(), "jinn-publication-journal-fault-"))
  );
  roots.push(root);
  const store = await createFilesystemPublicationJournalStore({
    rootDir: root,
  });
  const journalEntry = entry();
  const hex = journalEntry.bundleKey.slice(7);
  const revisionDir = join(
    root,
    "entries",
    "sha256",
    hex.slice(0, 2),
    hex.slice(2),
  );
  const finalPath = join(revisionDir, "00000000000000000000.json");
  const controller = new AbortController();
  fault.abortOnTemporaryClose = controller;

  await expect(
    store.create(journalEntry, { signal: controller.signal }),
  ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
  expect(existsSync(finalPath)).toBe(false);
  expect(
    existsSync(revisionDir)
      ? (await readdir(revisionDir)).filter((name) =>
          name.startsWith(".tmp-") || name.startsWith(".writing-")
        )
      : [],
  ).toEqual([]);
});

test("reports cleanup uncertainty when an unpublished complete temp cannot be removed", async () => {
  const root = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(join(tmpdir(), "jinn-publication-journal-fault-"))
  );
  roots.push(root);
  const store = await createFilesystemPublicationJournalStore({
    rootDir: root,
  });
  const journalEntry = entry();
  const hex = journalEntry.bundleKey.slice(7);
  const revisionDir = join(
    root,
    "entries",
    "sha256",
    hex.slice(0, 2),
    hex.slice(2),
  );
  fault.failTemporaryCleanup = true;
  fault.beforeLink = async () => {
    throw new EvidencePublicationError(
      "OPERATION_ABORTED",
      "synthetic pre-link cancellation",
    );
  };

  await expect(store.create(journalEntry)).rejects.toMatchObject({
    code: "IO_FAILURE",
    cause: {
      errors: [
        { code: "OPERATION_ABORTED" },
        { message: "synthetic temp cleanup failure" },
      ],
    },
  });
  expect(
    (await readdir(revisionDir)).filter((name) => name.startsWith(".tmp-")),
  ).toHaveLength(1);

  fault.failTemporaryCleanup = false;
  fault.beforeLink = undefined;
  await expect(store.load(journalEntry.bundleKey)).resolves.toBeNull();
});

test("preserves and repairs the temp/final pair after the first post-link sync fails", async () => {
  const root = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(join(tmpdir(), "jinn-publication-journal-fault-"))
  );
  roots.push(root);
  const store = await createFilesystemPublicationJournalStore({
    rootDir: root,
  });
  const physicalRoot = await realpath(root);
  const journalEntry = entry();
  const hex = journalEntry.bundleKey.slice(7);
  const revisionDir = join(
    physicalRoot,
    "entries",
    "sha256",
    hex.slice(0, 2),
    hex.slice(2),
  );
  await mkdir(revisionDir, { recursive: true, mode: 0o700 });
  fault.failDirectorySync = true;
  fault.failDirectorySyncPath = revisionDir;
  fault.failDirectorySyncPathOccurrence =
    (fault.syncCallsByPath.get(revisionDir) ?? 0) + 1;

  await expect(store.create(journalEntry)).rejects.toMatchObject({
    code: "IO_FAILURE",
  });
  expect(await readdir(revisionDir)).toHaveLength(2);

  fault.failDirectorySync = false;
  const reopened = await createFilesystemPublicationJournalStore({
    rootDir: root,
  });
  await expect(reopened.load(journalEntry.bundleKey)).resolves.toMatchObject({
    revision: 0,
  });
  expect(await readdir(revisionDir)).toEqual([
    "00000000000000000000.json",
  ]);
});

test("replay durably syncs the final link before and after idempotent temp cleanup", async () => {
  const root = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(join(tmpdir(), "jinn-publication-journal-fault-"))
  );
  roots.push(root);
  const store = await createFilesystemPublicationJournalStore({
    rootDir: root,
  });
  const physicalRoot = await realpath(root);
  const created = await store.create(entry());
  const hex = created.bundleKey.slice(7);
  const revisionDir = join(
    physicalRoot,
    "entries",
    "sha256",
    hex.slice(0, 2),
    hex.slice(2),
  );
  await link(
    join(revisionDir, "00000000000000000000.json"),
    join(
      revisionDir,
      ".tmp-11111111-1111-4111-8111-111111111111.json",
    ),
  );
  fault.events.length = 0;

  await expect(store.load(created.bundleKey)).resolves.toEqual(created);

  expect(
    fault.events.filter((event) =>
      event.includes(revisionDir) &&
      (event.startsWith("sync:") || event.startsWith("rm:"))
    ),
  ).toEqual([
    `sync:${revisionDir}`,
    expect.stringMatching(/^rm:.*\/\.tmp-/u),
    `sync:${revisionDir}`,
  ]);
});

test("load ignores a complete pre-link temp while its legitimate writer remains live", async () => {
  const root = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(join(tmpdir(), "jinn-publication-journal-fault-"))
  );
  roots.push(root);
  const store = await createFilesystemPublicationJournalStore({
    rootDir: root,
  });
  const journalEntry = entry();
  const linkReached = deferred();
  const releaseLink = deferred();
  let held = false;
  fault.beforeLink = async (source) => {
    if (held || !source.includes("/.tmp-")) return;
    held = true;
    linkReached.resolve();
    await releaseLink.promise;
  };

  const creating = store.create(journalEntry);
  await linkReached.promise;
  const recovered = await store.load(journalEntry.bundleKey);
  releaseLink.resolve();
  const created = await creating;

  expect(recovered).toBeNull();
  await expect(store.load(created.bundleKey)).resolves.toEqual(created);
});

test("load cleanup is idempotent during a legitimate writer post-link window", async () => {
  const root = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(join(tmpdir(), "jinn-publication-journal-fault-"))
  );
  roots.push(root);
  const store = await createFilesystemPublicationJournalStore({
    rootDir: root,
  });
  const journalEntry = entry();
  const linkCompleted = deferred();
  const releaseWriter = deferred();
  let held = false;
  fault.afterLink = async (source) => {
    if (held || !source.includes("/.tmp-")) return;
    held = true;
    linkCompleted.resolve();
    await releaseWriter.promise;
  };

  const creating = store.create(journalEntry);
  await linkCompleted.promise;
  const recovered = await store.load(journalEntry.bundleKey);
  releaseWriter.resolve();
  const created = await creating;

  expect(recovered).toEqual(created);
  await expect(store.load(created.bundleKey)).resolves.toEqual(created);
});

test("finishes replay cleanup durability after cancellation during temporary unlink", async () => {
  const root = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(join(tmpdir(), "jinn-publication-journal-fault-"))
  );
  roots.push(root);
  const store = await createFilesystemPublicationJournalStore({
    rootDir: root,
  });
  const journalEntry = entry();
  const created = await store.create(journalEntry);
  const hex = created.bundleKey.slice(7);
  const revisionDir = join(
    root,
    "entries",
    "sha256",
    hex.slice(0, 2),
    hex.slice(2),
  );
  const finalPath = join(revisionDir, "00000000000000000000.json");
  await link(
    finalPath,
    join(
      revisionDir,
      ".tmp-11111111-1111-4111-8111-111111111111.json",
    ),
  );
  const syncCallsBeforeRepair = fault.syncCalls;
  const controller = new AbortController();
  fault.abortOnTemporaryCleanup = controller;

  await expect(
    store.load(created.bundleKey, { signal: controller.signal }),
  ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });

  expect(fault.syncCalls).toBe(syncCallsBeforeRepair + 2);
  await expect(store.load(created.bundleKey)).resolves.toEqual(created);
});

test("maps replay validation close failures without unlinking the repair pair", async () => {
  const root = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(join(tmpdir(), "jinn-publication-journal-fault-"))
  );
  roots.push(root);
  const store = await createFilesystemPublicationJournalStore({
    rootDir: root,
  });
  const created = await store.create(entry());
  const hex = created.bundleKey.slice(7);
  const revisionDir = join(
    root,
    "entries",
    "sha256",
    hex.slice(0, 2),
    hex.slice(2),
  );
  const finalPath = join(revisionDir, "00000000000000000000.json");
  const temporaryPath = join(
    revisionDir,
    ".tmp-11111111-1111-4111-8111-111111111111.json",
  );
  await link(finalPath, temporaryPath);
  fault.failHandleClosePath = await realpath(temporaryPath);

  await expect(store.load(created.bundleKey)).rejects.toMatchObject({
    code: "IO_FAILURE",
    cause: {
      message: "synthetic handle close failure",
    },
  });
  expect(await readdir(revisionDir)).toHaveLength(2);
});

test("preserves cancellation after a revision lstat", async () => {
  const root = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(join(tmpdir(), "jinn-publication-journal-fault-"))
  );
  roots.push(root);
  const store = await createFilesystemPublicationJournalStore({
    rootDir: root,
  });
  const created = await store.create(entry());
  const hex = created.bundleKey.slice(7);
  const finalPath = await realpath(join(
    root,
    "entries",
    "sha256",
    hex.slice(0, 2),
    hex.slice(2),
    "00000000000000000000.json",
  ));
  const controller = new AbortController();
  fault.afterLstat = async (path) => {
    if (path === finalPath) controller.abort();
  };

  await expect(
    store.load(created.bundleKey, { signal: controller.signal }),
  ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
});

test("closes a revision handle when cancellation arrives during open", async () => {
  const root = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(join(tmpdir(), "jinn-publication-journal-fault-"))
  );
  roots.push(root);
  const store = await createFilesystemPublicationJournalStore({
    rootDir: root,
  });
  const created = await store.create(entry());
  const hex = created.bundleKey.slice(7);
  const finalPath = await realpath(join(
    root,
    "entries",
    "sha256",
    hex.slice(0, 2),
    hex.slice(2),
    "00000000000000000000.json",
  ));
  const controller = new AbortController();
  fault.observeHandleClosePath = finalPath;
  fault.abortOnHandleOpen = { path: finalPath, controller };

  await expect(
    store.load(created.bundleKey, { signal: controller.signal }),
  ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
  expect(fault.observedHandleCloseCount).toBe(1);
});

test("aggregates cancellation with a close failure after opening a revision", async () => {
  const root = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(join(tmpdir(), "jinn-publication-journal-fault-"))
  );
  roots.push(root);
  const store = await createFilesystemPublicationJournalStore({
    rootDir: root,
  });
  const created = await store.create(entry());
  const hex = created.bundleKey.slice(7);
  const finalPath = await realpath(join(
    root,
    "entries",
    "sha256",
    hex.slice(0, 2),
    hex.slice(2),
    "00000000000000000000.json",
  ));
  const controller = new AbortController();
  fault.failHandleClosePath = finalPath;
  fault.abortOnHandleOpen = { path: finalPath, controller };

  await expect(
    store.load(created.bundleKey, { signal: controller.signal }),
  ).rejects.toMatchObject({
    code: "IO_FAILURE",
    cause: {
      errors: [
        { code: "OPERATION_ABORTED" },
        {
          code: "EIO",
          message: "synthetic handle close failure",
        },
      ],
    },
  });
});

test("stops infrastructure validation immediately after an awaited I/O observes cancellation", async () => {
  const root = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(join(tmpdir(), "jinn-publication-journal-fault-"))
  );
  roots.push(root);
  const store = await createFilesystemPublicationJournalStore({
    rootDir: root,
  });
  const physicalRoot = await realpath(root);
  const controller = new AbortController();
  fault.events.length = 0;
  fault.afterLstat = async (path) => {
    if (path === physicalRoot) controller.abort();
  };

  await expect(
    store.load(entry().bundleKey, { signal: controller.signal }),
  ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
  expect(
    fault.events.some((event) =>
      event.includes("/publication-journal.json")
    ),
  ).toBe(false);
});

test("stops bundle directory preparation after the awaited mkdir that observes cancellation", async () => {
  const root = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(join(tmpdir(), "jinn-publication-journal-fault-"))
  );
  roots.push(root);
  const store = await createFilesystemPublicationJournalStore({
    rootDir: root,
  });
  const physicalRoot = await realpath(root);
  const journalEntry = entry();
  const hex = journalEntry.bundleKey.slice(7);
  const algorithmDir = join(physicalRoot, "entries", "sha256");
  const prefixDir = join(algorithmDir, hex.slice(0, 2));
  const controller = new AbortController();
  fault.afterMkdir = async (path) => {
    if (path === algorithmDir) controller.abort();
  };

  await expect(
    store.create(journalEntry, { signal: controller.signal }),
  ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
  expect(existsSync(prefixDir)).toBe(false);
});

test("never acknowledges a revision when the second post-link sync fails", async () => {
  const root = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(join(tmpdir(), "jinn-publication-journal-fault-"))
  );
  roots.push(root);
  const store = await createFilesystemPublicationJournalStore({
    rootDir: root,
  });
  const physicalRoot = await realpath(root);
  const journalEntry = entry();
  const hex = journalEntry.bundleKey.slice(7);
  const revisionDir = join(
    physicalRoot,
    "entries",
    "sha256",
    hex.slice(0, 2),
    hex.slice(2),
  );
  await mkdir(revisionDir, { recursive: true, mode: 0o700 });
  fault.failDirectorySync = true;
  fault.failDirectorySyncPath = revisionDir;
  fault.failDirectorySyncPathOccurrence =
    (fault.syncCallsByPath.get(revisionDir) ?? 0) + 2;

  await expect(store.create(journalEntry)).rejects.toMatchObject({
    code: "IO_FAILURE",
  });
  expect(await readdir(revisionDir)).toEqual([
    "00000000000000000000.json",
  ]);

  fault.failDirectorySync = false;
  await expect(store.load(journalEntry.bundleKey)).resolves.toMatchObject({
    revision: 0,
  });
});

test("detects a managed-component replacement at the following validation", async () => {
  const root = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(join(tmpdir(), "jinn-publication-journal-fault-"))
  );
  roots.push(root);
  const outside = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(join(tmpdir(), "jinn-publication-journal-outside-"))
  );
  roots.push(outside);
  const store = await createFilesystemPublicationJournalStore({
    rootDir: root,
  });
  const physicalRoot = await realpath(root);
  const journalEntry = entry();
  await store.create(journalEntry);
  const entries = join(physicalRoot, "entries");
  const displaced = join(physicalRoot, "entries-original");
  let replaced = false;
  fault.afterLstat = async (path) => {
    if (replaced || path !== physicalRoot) return;
    replaced = true;
    await rename(entries, displaced);
    await symlink(outside, entries, "dir");
  };

  await expect(store.load(journalEntry.bundleKey)).rejects.toMatchObject({
    code: "JOURNAL_CORRUPT",
  });
  expect(replaced).toBe(true);
});

test.each(["directory", "file"] as const)(
  "rejects synthetic foreign ownership on a managed %s",
  async (kind) => {
    if (process.platform === "win32" || process.getuid === undefined) {
      return;
    }
    const root = await import("node:fs/promises").then(({ mkdtemp }) =>
      mkdtemp(join(tmpdir(), "jinn-publication-journal-fault-"))
    );
    roots.push(root);
    const store = await createFilesystemPublicationJournalStore({
      rootDir: root,
    });
    const physicalRoot = await realpath(root);
    const journalEntry = entry();
    const created = await store.create(journalEntry);
    const hex = created.bundleKey.slice(7);
    const revisionPath = join(
      physicalRoot,
      "entries",
      "sha256",
      hex.slice(0, 2),
      hex.slice(2),
      "00000000000000000000.json",
    );
    if (kind === "directory") {
      fault.foreignOwnedLstatPath = physicalRoot;
    } else {
      fault.foreignOwnedHandlePath = revisionPath;
    }

    await expect(store.load(journalEntry.bundleKey)).rejects.toMatchObject({
      code: "JOURNAL_CORRUPT",
    });
  },
);

test.each(["active", "multi-temp"] as const)(
  "rejects synthetic foreign ownership on a recognized %s managed file",
  async (kind) => {
    if (process.platform === "win32" || process.getuid === undefined) {
      return;
    }
    const root = await import("node:fs/promises").then(({ mkdtemp }) =>
      mkdtemp(join(tmpdir(), "jinn-publication-journal-fault-"))
    );
    roots.push(root);
    const store = await createFilesystemPublicationJournalStore({
      rootDir: root,
    });
    const physicalRoot = await realpath(root);
    const created = await store.create(entry());
    const hex = created.bundleKey.slice(7);
    const revisionDir = join(
      physicalRoot,
      "entries",
      "sha256",
      hex.slice(0, 2),
      hex.slice(2),
    );
    const managedName = kind === "active"
      ? ".writing-11111111-1111-4111-8111-111111111111.json"
      : ".tmp-22222222-2222-4222-8222-222222222222.json";
    const managedPath = join(revisionDir, managedName);
    await writeFile(managedPath, Uint8Array.of(1), { mode: 0o600 });
    if (kind === "multi-temp") {
      await writeFile(
        join(
          revisionDir,
          ".tmp-33333333-3333-4333-8333-333333333333.json",
        ),
        Uint8Array.of(2),
        { mode: 0o600 },
      );
    }
    fault.foreignOwnedLstatPath = managedPath;

    await expect(store.load(created.bundleKey)).rejects.toMatchObject({
      code: "JOURNAL_CORRUPT",
    });
  },
);

test("maps an injected lstat EPERM to IO_FAILURE with the original cause", async () => {
  const root = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(join(tmpdir(), "jinn-publication-journal-fault-"))
  );
  roots.push(root);
  const store = await createFilesystemPublicationJournalStore({
    rootDir: root,
  });
  const created = await store.create(entry());
  fault.failLstatPath = await realpath(root);
  fault.failLstatCode = "EPERM";

  await expect(store.load(created.bundleKey)).rejects.toMatchObject({
    code: "IO_FAILURE",
    cause: {
      code: "EPERM",
      message: "synthetic lstat denial",
    },
  });
});

test("maps an injected marker open EACCES to IO_FAILURE with the original cause", async () => {
  const root = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(join(tmpdir(), "jinn-publication-journal-fault-"))
  );
  roots.push(root);
  const store = await createFilesystemPublicationJournalStore({
    rootDir: root,
  });
  const created = await store.create(entry());
  fault.failOpenPath = join(
    await realpath(root),
    "publication-journal.json",
  );
  fault.failOpenCode = "EACCES";

  await expect(store.load(created.bundleKey)).rejects.toMatchObject({
    code: "IO_FAILURE",
    cause: {
      code: "EACCES",
      message: "synthetic open denial",
    },
  });
});

test("aggregates marker sync and close failures", async () => {
  const root = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(join(tmpdir(), "jinn-publication-journal-fault-"))
  );
  roots.push(root);
  const markerPath = join(
    await realpath(root),
    "publication-journal.json",
  );
  fault.failHandleSyncPath = markerPath;
  fault.failHandleClosePath = markerPath;

  await expect(
    createFilesystemPublicationJournalStore({ rootDir: root }),
  ).rejects.toMatchObject({
    code: "IO_FAILURE",
    cause: {
      errors: [
        {
          code: "EIO",
          message: "synthetic handle sync failure",
        },
        {
          code: "EIO",
          message: "synthetic handle close failure",
        },
      ],
    },
  });
});

test("maps an injected chmod EPERM to IO_FAILURE with the original cause", async () => {
  const root = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(join(tmpdir(), "jinn-publication-journal-fault-"))
  );
  roots.push(root);
  const store = await createFilesystemPublicationJournalStore({
    rootDir: root,
  });
  const created = await store.create(entry());
  const physicalRoot = await realpath(root);
  await chmod(physicalRoot, 0o755);
  fault.failChmodPath = physicalRoot;
  fault.failChmodCode = "EPERM";

  await expect(store.load(created.bundleKey)).rejects.toMatchObject({
    code: "IO_FAILURE",
    cause: {
      code: "EPERM",
      message: "synthetic chmod denial",
    },
  });
});

test("maps an injected directory-sync EACCES to IO_FAILURE with the original cause", async () => {
  const root = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(join(tmpdir(), "jinn-publication-journal-fault-"))
  );
  roots.push(root);
  const store = await createFilesystemPublicationJournalStore({
    rootDir: root,
  });
  const created = await store.create(entry());
  const hex = created.bundleKey.slice(7);
  const revisionDir = join(
    await realpath(root),
    "entries",
    "sha256",
    hex.slice(0, 2),
    hex.slice(2),
  );
  await link(
    join(revisionDir, "00000000000000000000.json"),
    join(
      revisionDir,
      ".tmp-11111111-1111-4111-8111-111111111111.json",
    ),
  );
  fault.failDirectorySync = true;
  fault.failDirectorySyncCode = "EACCES";
  fault.failDirectorySyncPath = revisionDir;
  fault.failDirectorySyncPathOccurrence =
    (fault.syncCallsByPath.get(revisionDir) ?? 0) + 1;

  await expect(store.load(created.bundleKey)).rejects.toMatchObject({
    code: "IO_FAILURE",
    cause: {
      code: "EACCES",
      message: "synthetic directory sync failure",
    },
  });
});

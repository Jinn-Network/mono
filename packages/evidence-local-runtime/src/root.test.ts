// SPDX-License-Identifier: MIT
import {
  access,
  chmod,
  link,
  lstat,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { acquireRuntimeLock } from "./lock.js";
import { openRuntimeMarker } from "./marker.js";
import { prepareRuntimePaths } from "./paths.js";
import { openLocalOperationsStore } from "./operations-store.js";

const roots: string[] = [];

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "jinn-local-runtime-"));
  roots.push(path);
  return path;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

describe("runtime root", () => {
  it("persists private stable identities", async () => {
    const paths = await prepareRuntimePaths(await root());
    expect(paths.lockPath).toBe(join(paths.rootDir, "runtime.lock"));
    expect(paths.catalogPointerPath).toBe(
      join(paths.rootDir, "catalog", "current.json"),
    );
    const first = await openRuntimeMarker(paths);
    const second = await openRuntimeMarker(paths);
    expect(second).toEqual(first);
    expect(first.repositoryId).toBe(`local:${first.runtimeId.slice(9)}`);
    if (process.platform !== "win32") {
      expect((await lstat(paths.rootDir)).mode & 0o777).toBe(0o700);
      expect((await lstat(paths.markerPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("rejects the filesystem root before changing it", async () => {
    const filesystemRoot = parse(tmpdir()).root;
    const before = await lstat(filesystemRoot);
    await expect(prepareRuntimePaths(filesystemRoot)).rejects.toMatchObject({
      code: "UNSAFE_PATH",
    });
    const after = await lstat(filesystemRoot);
    expect(after.mode).toBe(before.mode);
    expect(after.uid).toBe(before.uid);
  });

  it("rejects incompatible and symlinked control files", async () => {
    const paths = await prepareRuntimePaths(await root());
    await writeFile(paths.markerPath, '{"format":"jinn-local-evidence-runtime","version":2}\n');
    await expect(openRuntimeMarker(paths)).rejects.toMatchObject({
      code: "ROOT_VERSION_UNSUPPORTED",
    });

    const other = await root();
    const linked = join(await root(), "linked");
    await symlink(other, linked);
    await expect(prepareRuntimePaths(linked)).rejects.toMatchObject({
      code: "UNSAFE_PATH",
    });
  });

  it("rejects a symlink in an existing caller root parent", async () => {
    const container = await root();
    const target = await root();
    const linkedParent = join(container, "linked-parent");
    const requestedRoot = join(linkedParent, "runtime");
    await symlink(target, linkedParent);

    await expect(prepareRuntimePaths(requestedRoot)).rejects.toMatchObject({
      code: "UNSAFE_PATH",
    });
    await expect(access(join(target, "runtime"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("creates a valid nonexisting leaf root with private ownership and modes", async () => {
    const container = await root();
    const requestedRoot = join(container, "runtime");
    const paths = await prepareRuntimePaths(requestedRoot);
    const marker = await openRuntimeMarker(paths);
    const lock = await acquireRuntimeLock(paths.lockPath);
    const store = await openLocalOperationsStore(paths.operationsDatabasePath);

    expect(marker.repositoryId).toMatch(/^local:/u);
    if (process.platform !== "win32") {
      const expectedOwner = process.getuid?.();
      for (const path of [
        paths.rootDir,
        paths.repositoryDir,
        paths.announcementsDir,
        paths.catalogDir,
        paths.generationsDir,
        paths.operationsDir,
      ]) {
        const stat = await lstat(path);
        expect(stat.mode & 0o777).toBe(0o700);
        if (expectedOwner !== undefined) expect(stat.uid).toBe(expectedOwner);
      }
      for (const path of [
        paths.markerPath,
        paths.lockPath,
        paths.operationsDatabasePath,
      ]) {
        const stat = await lstat(path);
        expect(stat.mode & 0o777).toBe(0o600);
        if (expectedOwner !== undefined) expect(stat.uid).toBe(expectedOwner);
      }
    }

    await store.close();
    await lock.close();
  });

  it("rejects a symlinked runtime lock without creating its target", async () => {
    const paths = await prepareRuntimePaths(await root());
    const target = join(await root(), "lock-target");
    await symlink(target, paths.lockPath);

    await expect(acquireRuntimeLock(paths.lockPath)).rejects.toMatchObject({
      code: "UNSAFE_PATH",
    });
    await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a symlinked operations database without creating its target", async () => {
    const paths = await prepareRuntimePaths(await root());
    const target = join(await root(), "operations-target");
    await symlink(target, paths.operationsDatabasePath);

    await expect(openLocalOperationsStore(paths.operationsDatabasePath))
      .rejects.toMatchObject({ code: "UNSAFE_PATH" });
    await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects hardlinked runtime database control files", async () => {
    const paths = await prepareRuntimePaths(await root());
    const lockTarget = join(await root(), "lock-target");
    const operationsTarget = join(await root(), "operations-target");
    await writeFile(lockTarget, "");
    await writeFile(operationsTarget, "");
    await link(lockTarget, paths.lockPath);
    await link(operationsTarget, paths.operationsDatabasePath);

    await expect(acquireRuntimeLock(paths.lockPath)).rejects.toMatchObject({
      code: "UNSAFE_PATH",
    });
    await expect(openLocalOperationsStore(paths.operationsDatabasePath))
      .rejects.toMatchObject({ code: "UNSAFE_PATH" });
    expect(await readFile(lockTarget, "utf8")).toBe("");
    expect(await readFile(operationsTarget, "utf8")).toBe("");
  });

  it("rejects a hardlinked runtime marker", async () => {
    const paths = await prepareRuntimePaths(await root());
    await openRuntimeMarker(paths);
    const extraLink = join(await root(), "runtime-marker-link");
    await link(paths.markerPath, extraLink);

    await expect(openRuntimeMarker(paths)).rejects.toMatchObject({
      code: "UNSAFE_PATH",
    });
  });

  it("holds an exclusive SQLite root lock", async () => {
    const paths = await prepareRuntimePaths(await root());
    const first = await acquireRuntimeLock(paths.lockPath);
    await expect(acquireRuntimeLock(paths.lockPath)).rejects.toMatchObject({
      code: "ROOT_IN_USE",
    });
    await first.close();
    const reopened = await acquireRuntimeLock(paths.lockPath);
    await reopened.close();
    await reopened.close();
  });

  it("stores outbox intent idempotently and checkpoints atomically", async () => {
    const paths = await prepareRuntimePaths(await root());
    const store = await openLocalOperationsStore(paths.operationsDatabasePath);
    const reference = {
      family: "execution-evidence" as const,
      digest: `sha256:${"1".repeat(64)}` as const,
    };
    const intent = {
      operationKey: `sha256:${"2".repeat(64)}`,
      reference,
      recordBytes: new Uint8Array([1, 2, 3]),
      byteSize: 3,
      announcementId: "urn:jinn:local-announcement:test",
      state: "staged" as const,
    };
    expect(await store.stagePublication(intent)).toBe("created");
    expect(await store.stagePublication(intent)).toBe("existing");
    expect(await store.listPendingPublications()).toHaveLength(1);
    await store.recordIndexedAndCheckpoint({
      generationId: "generation",
      sourceId: "source",
      announcementId: "announcement",
      reference,
      journalCursor: "cursor",
      indexedTotal: 1,
      failedTotal: 0,
      observedAt: new Date().toISOString(),
    });
    expect(await store.getCheckpoint("generation", "source")).toBe("cursor");
    expect(await store.getOutcome("generation", reference)).toMatchObject({
      status: "indexed",
      journalCursor: "cursor",
    });
    await store.close();
    await store.close();
  });

  it("rejects malformed operational tables during open", async () => {
    const paths = await prepareRuntimePaths(await root());
    const database = new Database(paths.operationsDatabasePath);
    database.exec("CREATE TABLE publication_outbox (wrong_column TEXT)");
    database.close();
    await expect(openLocalOperationsStore(paths.operationsDatabasePath))
      .rejects.toMatchObject({ code: "RUNTIME_CORRUPT" });
  });
});

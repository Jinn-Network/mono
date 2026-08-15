import { lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runPublicationLockPath, runsDir } from "../workspace/layout.js";
import { readProcessStartTime } from "@jinn-network/task-execution-supervisor";
import { acquireRunPublicationGuard } from "./finalization-lock.js";
import { acquirePublicationLock } from "./publication-lock.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp40-publication-lock-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe("acquirePublicationLock", () => {
  test("a stale reader cannot delete or enter beside the live successor that reclaimed first", async () => {
    mkdirSync(runsDir(workspaceDir), { recursive: true });
    const lockPath = runPublicationLockPath(workspaceDir, "draft-1");
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startTime: 0, token: "dead-a" }));

    let successor: ReturnType<typeof acquireRunPublicationGuard> | undefined;
    let successorBytes = "";
    let successorInode = 0;
    let staleSettled = false;
    const stalePromise = acquirePublicationLock(workspaceDir, "draft-1", 1_000, {
      afterInitialDeadRead() {
        successor = acquireRunPublicationGuard(workspaceDir, "draft-1");
        if (!successor.acquired) throw new Error(`successor did not acquire: ${successor.detail}`);
        successorBytes = readFileSync(lockPath, "utf8");
        successorInode = lstatSync(lockPath).ino;
      },
    }).then((lock) => {
      staleSettled = true;
      return lock;
    });
    await Promise.resolve();

    expect.soft(staleSettled).toBe(false);
    expect.soft(readFileSync(lockPath, "utf8")).toBe(successorBytes);
    expect.soft(lstatSync(lockPath).ino).toBe(successorInode);

    if (successor?.acquired) successor.release();
    const stale = await stalePromise;
    stale.release();
  });

  test("treats PID reuse as dead but unknown process identity as live contention", () => {
    mkdirSync(runsDir(workspaceDir), { recursive: true });
    const lockPath = runPublicationLockPath(workspaceDir, "draft-1");
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startTime: 0, token: "reused-pid" }));
    const reclaimed = acquireRunPublicationGuard(workspaceDir, "draft-1");
    expect(reclaimed.acquired).toBe(true);
    if (reclaimed.acquired) reclaimed.release();

    const unknown = { pid: 999_999, startTime: 123, token: "unknown-owner" };
    writeFileSync(lockPath, JSON.stringify(unknown));
    expect(acquireRunPublicationGuard(workspaceDir, "draft-1", {
      readProcessStartTime: () => undefined,
      probeProcess: () => "unknown",
    })).toMatchObject({ acquired: false, reason: "contended" });
    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toEqual(unknown);
  });

  test("release preserves a replacement canonical even when it carries the old token", () => {
    const acquired = acquireRunPublicationGuard(workspaceDir, "draft-1");
    expect(acquired.acquired).toBe(true);
    if (!acquired.acquired) return;
    const lockPath = runPublicationLockPath(workspaceDir, "draft-1");
    const displaced = `${lockPath}.displaced`;
    const old = JSON.parse(readFileSync(lockPath, "utf8")) as { token: string };
    const startTime = readProcessStartTime(process.pid);
    if (startTime === undefined) throw new Error("current process start marker unavailable");
    renameSync(lockPath, displaced);
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startTime, token: old.token }));
    const successorInode = lstatSync(lockPath).ino;

    acquired.release();
    expect(lstatSync(lockPath).ino).toBe(successorInode);
    rmSync(lockPath, { force: true });
    rmSync(displaced, { force: true });
  });
});

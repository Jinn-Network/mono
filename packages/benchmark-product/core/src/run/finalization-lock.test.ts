import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runFinalizationLockPath, runsDir } from "../workspace/layout.js";
import { fsyncDirectorySync } from "../fs/atomic.js";
import { readProcessStartTime } from "@jinn-network/task-execution-supervisor";
import {
  acquireRunFinalizationLock,
  runFinalizationRecoveryPath,
} from "./finalization-lock.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp22-finalization-lock-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe("acquireRunFinalizationLock", () => {
  test("serializes same-process finalizers and releases only its own token", () => {
    const first = acquireRunFinalizationLock(workspaceDir, "draft-1");
    expect(first.acquired).toBe(true);
    const second = acquireRunFinalizationLock(workspaceDir, "draft-1");
    expect(second).toMatchObject({ acquired: false, reason: "contended" });
    if (!first.acquired) throw new Error("unreachable");
    first.release();
    first.release();

    const third = acquireRunFinalizationLock(workspaceDir, "draft-1");
    expect(third.acquired).toBe(true);
    if (third.acquired) third.release();
  });

  test("fails closed on a symbolic-link lock path", () => {
    mkdirSync(runsDir(workspaceDir), { recursive: true });
    const target = join(workspaceDir, "foreign-lock.json");
    writeFileSync(target, JSON.stringify({ pid: 1, startTime: 1, token: "foreign" }));
    symlinkSync(target, runFinalizationLockPath(workspaceDir, "draft-1"));
    expect(acquireRunFinalizationLock(workspaceDir, "draft-1")).toMatchObject({
      acquired: false,
      reason: "invalid",
    });
  });

  test("reclaims a dead owner's complete regular-file record", () => {
    mkdirSync(runsDir(workspaceDir), { recursive: true });
    writeFileSync(
      runFinalizationLockPath(workspaceDir, "draft-1"),
      JSON.stringify({ pid: process.pid, startTime: 0, token: "dead-owner" }),
    );
    const acquired = acquireRunFinalizationLock(workspaceDir, "draft-1");
    expect(acquired.acquired).toBe(true);
    if (acquired.acquired) acquired.release();
  });

  test("a contender paused after dead read cannot displace the live successor that reclaimed first", () => {
    mkdirSync(runsDir(workspaceDir), { recursive: true });
    const lockPath = runFinalizationLockPath(workspaceDir, "draft-1");
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startTime: 0, token: "dead-a" }));
    let successor: ReturnType<typeof acquireRunFinalizationLock> | undefined;
    let successorBytes = "";
    let successorInode = 0;

    const staleReader = acquireRunFinalizationLock(workspaceDir, "draft-1", {
      afterInitialDeadRead() {
        successor = acquireRunFinalizationLock(workspaceDir, "draft-1");
        expect(successor.acquired).toBe(true);
        successorBytes = readFileSync(lockPath, "utf8");
        successorInode = lstatSync(lockPath).ino;
      },
    });
    expect(staleReader).toMatchObject({ acquired: false, reason: "contended" });
    expect(readFileSync(lockPath, "utf8")).toBe(successorBytes);
    expect(lstatSync(lockPath).ino).toBe(successorInode);
    if (successor?.acquired) successor.release();
  });

  test("recovers a crashed named recovery-guard owner", () => {
    mkdirSync(runsDir(workspaceDir), { recursive: true });
    const recovery = runFinalizationRecoveryPath(workspaceDir, "draft-1");
    mkdirSync(recovery);
    writeFileSync(
      join(recovery, `claim.0.${process.pid}.0.00000000-0000-4000-8000-000000000000.json`),
      "",
    );
    const acquired = acquireRunFinalizationLock(workspaceDir, "draft-1");
    expect(acquired.acquired).toBe(true);
    if (acquired.acquired) acquired.release();
  });

  test("does not steal a fresh dead-looking named recovery owner", () => {
    mkdirSync(runsDir(workspaceDir), { recursive: true });
    const recovery = runFinalizationRecoveryPath(workspaceDir, "draft-1");
    mkdirSync(recovery);
    writeFileSync(
      join(recovery, `owner.10000.${process.pid}.0.00000000-0000-4000-8000-000000000000.json`),
      "",
    );
    expect(acquireRunFinalizationLock(workspaceDir, "draft-1", { nowMs: () => 10_001 })).toMatchObject({
      acquired: false,
      reason: "contended",
    });
  });

  test("recovers an old ownerless recovery directory but never a fresh one", () => {
    mkdirSync(runsDir(workspaceDir), { recursive: true });
    const recovery = runFinalizationRecoveryPath(workspaceDir, "draft-1");
    mkdirSync(recovery);
    expect(acquireRunFinalizationLock(workspaceDir, "draft-1")).toMatchObject({
      acquired: false,
      reason: "contended",
    });
    const old = new Date("2020-01-01T00:00:00.000Z");
    utimesSync(recovery, old, old);
    const acquired = acquireRunFinalizationLock(workspaceDir, "draft-1");
    expect(acquired.acquired).toBe(true);
    if (acquired.acquired) acquired.release();
  });

  test("recovers an old partial ownerless claim left by a crash", () => {
    mkdirSync(runsDir(workspaceDir), { recursive: true });
    const recovery = runFinalizationRecoveryPath(workspaceDir, "draft-1");
    mkdirSync(recovery);
    const partial = join(recovery, "ownerless.claim");
    writeFileSync(partial, "");
    const old = new Date("2020-01-01T00:00:00.000Z");
    utimesSync(partial, old, old);
    const acquired = acquireRunFinalizationLock(workspaceDir, "draft-1");
    expect(acquired.acquired).toBe(true);
    if (acquired.acquired) acquired.release();
  });

  test("fails closed when a named recovery owner is a symlink", () => {
    mkdirSync(runsDir(workspaceDir), { recursive: true });
    const recovery = runFinalizationRecoveryPath(workspaceDir, "draft-1");
    mkdirSync(recovery);
    const target = join(workspaceDir, "foreign-recovery-owner");
    writeFileSync(target, "");
    symlinkSync(
      target,
      join(recovery, `owner.0.${process.pid}.0.00000000-0000-4000-8000-000000000000.json`),
    );
    expect(acquireRunFinalizationLock(workspaceDir, "draft-1")).toMatchObject({
      acquired: false,
      reason: "invalid",
    });
  });

  test("fails closed when a valid-looking named recovery owner is a directory", () => {
    mkdirSync(runsDir(workspaceDir), { recursive: true });
    const recovery = runFinalizationRecoveryPath(workspaceDir, "draft-1");
    mkdirSync(recovery);
    mkdirSync(
      join(recovery, `owner.0.${process.pid}.0.00000000-0000-4000-8000-000000000000.json`),
    );
    expect(acquireRunFinalizationLock(workspaceDir, "draft-1")).toMatchObject({
      acquired: false,
      reason: "invalid",
    });
  });

  test("cleans an exact fresh recovery owner when directory sync fails after publication", () => {
    const recovery = runFinalizationRecoveryPath(workspaceDir, "draft-1");
    let injected = false;
    const failed = acquireRunFinalizationLock(workspaceDir, "draft-1", {
      fsyncDirectory(path) {
        if (!injected && path === recovery) {
          injected = true;
          throw new Error("injected recovery sync failure");
        }
        fsyncDirectorySync(path);
      },
    });
    expect(failed).toMatchObject({ acquired: false, reason: "unavailable" });
    expect(existsSync(recovery)).toBe(false);

    const retry = acquireRunFinalizationLock(workspaceDir, "draft-1");
    expect(retry.acquired).toBe(true);
    if (retry.acquired) retry.release();
  });

  test("removes its exact canonical owner when directory sync fails after link publication", () => {
    const lockPath = runFinalizationLockPath(workspaceDir, "draft-1");
    let injected = false;
    const failed = acquireRunFinalizationLock(workspaceDir, "draft-1", {
      fsyncDirectory(path) {
        if (!injected && path === runsDir(workspaceDir) && existsSync(lockPath)) {
          injected = true;
          throw new Error("injected canonical sync failure");
        }
        fsyncDirectorySync(path);
      },
    });
    expect(failed).toMatchObject({ acquired: false, reason: "unavailable" });
    expect(existsSync(lockPath)).toBe(false);

    const retry = acquireRunFinalizationLock(workspaceDir, "draft-1");
    expect(retry.acquired).toBe(true);
    if (retry.acquired) retry.release();
  });

  test("a creator paused after recovery mkdir cannot join an ownerless claimant in the same directory", () => {
    const recovery = runFinalizationRecoveryPath(workspaceDir, "draft-1");
    const startTime = readProcessStartTime(process.pid);
    if (startTime === undefined) throw new Error("current process start marker unavailable");
    const claimant = { pid: process.pid, startTime, token: "ownerless-successor" };

    const raced = acquireRunFinalizationLock(workspaceDir, "draft-1", {
      afterRecoveryDirectoryCreated() {
        writeFileSync(join(recovery, "ownerless.claim"), JSON.stringify(claimant));
      },
    });

    expect(raced).toMatchObject({ acquired: false, reason: "contended" });
    expect(readdirSync(recovery)).toEqual(["ownerless.claim"]);
    expect(JSON.parse(readFileSync(join(recovery, "ownerless.claim"), "utf8"))).toEqual(claimant);
  });

  test("an ownerless claimant whose open inode was moved cannot return acquired", () => {
    mkdirSync(runsDir(workspaceDir), { recursive: true });
    const recovery = runFinalizationRecoveryPath(workspaceDir, "draft-1");
    mkdirSync(recovery);
    const old = new Date("2020-01-01T00:00:00.000Z");
    utimesSync(recovery, old, old);
    const successorName = `claim.0.${process.pid}.0.00000000-0000-4000-8000-000000000099.json`;

    const raced = acquireRunFinalizationLock(workspaceDir, "draft-1", {
      afterOwnerlessClaimOpened(claimPath) {
        renameSync(claimPath, join(recovery, successorName));
      },
    });

    expect(raced).toMatchObject({ acquired: false, reason: "contended" });
    expect(readdirSync(recovery)).toEqual([successorName]);
    expect(lstatSync(join(recovery, successorName)).isFile()).toBe(true);
  });

  test("does not reclaim a main owner whose start-time probe is unavailable but PID liveness is unknown", () => {
    mkdirSync(runsDir(workspaceDir), { recursive: true });
    const lockPath = runFinalizationLockPath(workspaceDir, "draft-1");
    const record = { pid: 999_999, startTime: 123, token: "unknown-main-owner" };
    writeFileSync(lockPath, JSON.stringify(record));

    const result = acquireRunFinalizationLock(workspaceDir, "draft-1", {
      readProcessStartTime: (pid) => pid === record.pid ? undefined : readProcessStartTime(pid),
      probeProcess: (pid) => pid === record.pid ? "unknown" : "exists",
    });

    expect(result).toMatchObject({ acquired: false, reason: "contended" });
    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toEqual(record);
  });

  test("does not reclaim a recovery owner whose start-time probe is unavailable but PID liveness is unknown", () => {
    mkdirSync(runsDir(workspaceDir), { recursive: true });
    const recovery = runFinalizationRecoveryPath(workspaceDir, "draft-1");
    mkdirSync(recovery);
    const pid = 999_998;
    const ownerName = `owner.0.${pid}.123.00000000-0000-4000-8000-000000000098.json`;
    writeFileSync(join(recovery, ownerName), "");

    const result = acquireRunFinalizationLock(workspaceDir, "draft-1", {
      readProcessStartTime: (candidate) => candidate === pid ? undefined : readProcessStartTime(candidate),
      probeProcess: (candidate) => candidate === pid ? "unknown" : "exists",
    });

    expect(result).toMatchObject({ acquired: false, reason: "contended" });
    expect(readdirSync(recovery)).toEqual([ownerName]);
  });

  test("reclaims only when unavailable start-time identity is paired with a demonstrably absent PID", () => {
    mkdirSync(runsDir(workspaceDir), { recursive: true });
    const lockPath = runFinalizationLockPath(workspaceDir, "draft-1");
    const pid = 999_997;
    writeFileSync(lockPath, JSON.stringify({ pid, startTime: 123, token: "demonstrably-dead" }));

    const result = acquireRunFinalizationLock(workspaceDir, "draft-1", {
      readProcessStartTime: (candidate) => candidate === pid ? undefined : readProcessStartTime(candidate),
      probeProcess: (candidate) => candidate === pid ? "absent" : "exists",
    });

    expect(result.acquired).toBe(true);
    if (result.acquired) result.release();
  });

  test("fence-failure cleanup never unlinks an exact marker inode from a replacement guard directory", () => {
    const recovery = runFinalizationRecoveryPath(workspaceDir, "draft-1");
    const displaced = `${recovery}.displaced`;
    let successorMarker = "";
    let successorInode = 0;
    let replaced = false;

    const result = acquireRunFinalizationLock(workspaceDir, "draft-1", {
      fsyncDirectory(path) {
        if (!replaced && path === recovery) {
          const [ownerName] = readdirSync(recovery);
          if (ownerName === undefined) throw new Error("fresh recovery owner missing");
          renameSync(recovery, displaced);
          mkdirSync(recovery);
          successorMarker = join(recovery, ownerName);
          linkSync(join(displaced, ownerName), successorMarker);
          successorInode = lstatSync(successorMarker).ino;
          replaced = true;
        }
        fsyncDirectorySync(path);
      },
    });

    expect(result).toMatchObject({ acquired: false, reason: "contended" });
    expect(existsSync(successorMarker)).toBe(true);
    expect(lstatSync(successorMarker).ino).toBe(successorInode);
  });

  test("a reclaimer restores an ownerless inode that became a valid live owner before rename", () => {
    mkdirSync(runsDir(workspaceDir), { recursive: true });
    const recovery = runFinalizationRecoveryPath(workspaceDir, "draft-1");
    const lockPath = runFinalizationLockPath(workspaceDir, "draft-1");
    mkdirSync(recovery);
    const old = new Date("2020-01-01T00:00:00.000Z");
    utimesSync(recovery, old, old);
    const farFuture = Date.now() + 60_000;
    let contender: ReturnType<typeof acquireRunFinalizationLock> | undefined;
    let originalInode = 0;
    let restoredBeforeOriginalResumed = false;

    const original = acquireRunFinalizationLock(workspaceDir, "draft-1", {
      nowMs: () => farFuture,
      afterOwnerlessClaimOpened(claimPath, originalRecord) {
        originalInode = lstatSync(claimPath).ino;
        contender = acquireRunFinalizationLock(workspaceDir, "draft-1", {
          nowMs: () => farFuture,
          afterInvalidOwnerlessReadBeforeRename(stalePath) {
            writeFileSync(stalePath, JSON.stringify(originalRecord));
          },
        });
        expect(contender).toMatchObject({ acquired: false, reason: "contended" });
        expect(lstatSync(claimPath).ino).toBe(originalInode);
        expect(JSON.parse(readFileSync(claimPath, "utf8"))).toEqual(originalRecord);
        restoredBeforeOriginalResumed = true;
      },
    });

    expect(restoredBeforeOriginalResumed).toBe(true);
    expect(original.acquired).toBe(true);
    expect(existsSync(recovery)).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
    if (original.acquired) original.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  test("restores a valid-but-dead transition and reclaims it only on a subsequent fenced attempt", () => {
    mkdirSync(runsDir(workspaceDir), { recursive: true });
    const recovery = runFinalizationRecoveryPath(workspaceDir, "draft-1");
    mkdirSync(recovery);
    const ownerlessPath = join(recovery, "ownerless.claim");
    writeFileSync(ownerlessPath, "");
    const old = new Date("2020-01-01T00:00:00.000Z");
    utimesSync(ownerlessPath, old, old);
    const transitioned = { pid: process.pid, startTime: 0, token: "completed-but-dead" };
    const farFuture = Date.now() + 60_000;

    const first = acquireRunFinalizationLock(workspaceDir, "draft-1", {
      nowMs: () => farFuture,
      afterInvalidOwnerlessReadBeforeRename(stalePath) {
        writeFileSync(stalePath, JSON.stringify(transitioned));
      },
    });
    expect(first).toMatchObject({ acquired: false, reason: "contended" });
    expect(JSON.parse(readFileSync(ownerlessPath, "utf8"))).toEqual(transitioned);

    const retry = acquireRunFinalizationLock(workspaceDir, "draft-1", { nowMs: () => farFuture });
    expect(retry.acquired).toBe(true);
    if (retry.acquired) retry.release();
  });

  test("reports unavailable and preserves exact remnants when reverse-race restoration cannot be made durable", () => {
    mkdirSync(runsDir(workspaceDir), { recursive: true });
    const recovery = runFinalizationRecoveryPath(workspaceDir, "draft-1");
    mkdirSync(recovery);
    const ownerlessPath = join(recovery, "ownerless.claim");
    writeFileSync(ownerlessPath, "");
    const old = new Date("2020-01-01T00:00:00.000Z");
    utimesSync(ownerlessPath, old, old);
    const startTime = readProcessStartTime(process.pid);
    if (startTime === undefined) throw new Error("current process start marker unavailable");
    const transitioned = { pid: process.pid, startTime, token: "completed-live-owner" };
    const farFuture = Date.now() + 60_000;
    let injected = false;

    const result = acquireRunFinalizationLock(workspaceDir, "draft-1", {
      nowMs: () => farFuture,
      afterInvalidOwnerlessReadBeforeRename(stalePath) {
        writeFileSync(stalePath, JSON.stringify(transitioned));
      },
      fsyncDirectory(path) {
        if (!injected && path === recovery && readdirSync(recovery).length === 2) {
          injected = true;
          throw new Error("injected restoration sync failure");
        }
        fsyncDirectorySync(path);
      },
    });

    expect(result).toMatchObject({ acquired: false, reason: "unavailable" });
    const names = readdirSync(recovery).sort();
    expect(names).toHaveLength(2);
    expect(names).toContain("ownerless.claim");
    const claimName = names.find((name) => name.startsWith("claim."));
    expect(claimName).toBeDefined();
    if (claimName === undefined) return;
    expect(lstatSync(ownerlessPath).ino).toBe(lstatSync(join(recovery, claimName)).ino);
    expect(JSON.parse(readFileSync(ownerlessPath, "utf8"))).toEqual(transitioned);
  });
});

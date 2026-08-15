/** Cross-process, per-run single-writer boundary shared by collect and cancel. */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fsyncBestEffortSync, readProcessStartTime } from "@jinn-network/task-execution-supervisor";
import { fsyncDirectorySync } from "../fs/atomic.js";
import { runFinalizationLockPath, runPublicationLockPath, runsDir } from "../workspace/layout.js";

interface LockRecord {
  readonly pid: number;
  readonly startTime: number;
  readonly token: string;
}

type ReadRecord =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid"; readonly detail: string }
  | { readonly kind: "record"; readonly record: LockRecord; readonly identity: FileIdentity };

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

type ProcessProbe = "exists" | "absent" | "unknown";
type OwnerLiveness = "live" | "dead" | "unknown";

type RecoveryGuard =
  | { readonly acquired: true; readonly release: () => void }
  | { readonly acquired: false; readonly reason: "contended" | "invalid" | "unavailable"; readonly detail: string };

export type RunFinalizationLockResult =
  | { readonly acquired: true; readonly release: () => void }
  | { readonly acquired: false; readonly reason: "contended" | "invalid" | "unavailable"; readonly detail: string };

export interface RunFinalizationLockDeps {
  /** Deterministic race-test hook after an initially dead canonical is observed, before guarding. */
  readonly afterInitialDeadRead?: () => void;
  readonly nowMs?: () => number;
  /** Test seam for proving post-mutation directory-sync cleanup. */
  readonly fsyncDirectory?: (path: string) => void;
  /** Deterministic race-test hook after recovery-directory creation, before owner publication. */
  readonly afterRecoveryDirectoryCreated?: () => void;
  /** Deterministic race-test hook after O_EXCL ownerless open, before record write. */
  readonly afterOwnerlessClaimOpened?: (claimPath: string, record: LockRecord) => void;
  /** Deterministic reverse-race hook after an invalid ownerless snapshot, before rename. */
  readonly afterInvalidOwnerlessReadBeforeRename?: (claimPath: string) => void;
  /** Test seams for transient/unavailable process identity probing. */
  readonly readProcessStartTime?: (pid: number) => number | undefined;
  readonly probeProcess?: (pid: number) => ProcessProbe;
}

interface LockRuntime {
  readonly nowMs: () => number;
  readonly fsyncDirectory: (path: string) => void;
  readonly readStartTime: (pid: number) => number | undefined;
  readonly probeProcess: (pid: number) => ProcessProbe;
  readonly afterRecoveryDirectoryCreated?: () => void;
  readonly afterOwnerlessClaimOpened?: (claimPath: string, record: LockRecord) => void;
  readonly afterInvalidOwnerlessReadBeforeRename?: (claimPath: string) => void;
}

const liveLocks = new Map<string, string>();
const OWNERLESS_STALE_AFTER_MS = 1_000;
const NAMED_GUARD = /^(?:owner|claim)\.(\d+)\.(\d+)\.(\d+)\.([0-9a-f-]+)\.json$/u;

function nodeCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function fileIdentity(stat: { readonly dev: number; readonly ino: number }): FileIdentity {
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

interface FileSnapshot {
  readonly identity: FileIdentity;
  readonly text: string;
  readonly size: number;
  readonly mtimeMs: number;
}

function readFileSnapshot(path: string): FileSnapshot | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile()) return undefined;
    return {
      identity: fileIdentity(stat),
      text: readFileSync(fd, "utf8"),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parseLockRecordText(text: string): LockRecord | undefined {
  try {
    const parsed = JSON.parse(text) as Partial<LockRecord>;
    return typeof parsed.pid === "number"
      && Number.isSafeInteger(parsed.pid)
      && parsed.pid > 0
      && typeof parsed.startTime === "number"
      && Number.isFinite(parsed.startTime)
      && typeof parsed.token === "string"
      && parsed.token.length > 0
      ? { pid: parsed.pid, startTime: parsed.startTime, token: parsed.token }
      : undefined;
  } catch {
    return undefined;
  }
}

function readRecord(path: string, label: string): ReadRecord {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      return { kind: "invalid", detail: `${label} must be a regular file, never a symbolic link` };
    }
    const parsed = JSON.parse(readFileSync(fd, "utf8")) as Partial<LockRecord>;
    if (
      typeof parsed.pid !== "number"
      || !Number.isSafeInteger(parsed.pid)
      || parsed.pid < 1
      || typeof parsed.startTime !== "number"
      || !Number.isFinite(parsed.startTime)
      || typeof parsed.token !== "string"
      || parsed.token.length === 0
    ) return { kind: "invalid", detail: `${label} owner record is malformed` };
    return {
      kind: "record",
      record: { pid: parsed.pid, startTime: parsed.startTime, token: parsed.token },
      identity: fileIdentity(stat),
    };
  } catch (error) {
    if (nodeCode(error) === "ENOENT") return { kind: "absent" };
    if (nodeCode(error) === "ELOOP") {
      return { kind: "invalid", detail: `${label} must be a regular file, never a symbolic link` };
    }
    return { kind: "invalid", detail: `${label} owner record is unreadable: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function defaultProbeProcess(pid: number): ProcessProbe {
  try {
    process.kill(pid, 0);
    return "exists";
  } catch (error) {
    if (nodeCode(error) === "ESRCH") return "absent";
    if (nodeCode(error) === "EPERM") return "exists";
    return "unknown";
  }
}

function ownerLiveness(record: LockRecord, runtime: LockRuntime): OwnerLiveness {
  let actual: number | undefined;
  try {
    actual = runtime.readStartTime(record.pid);
  } catch {
    actual = undefined;
  }
  if (actual !== undefined) return actual === record.startTime ? "live" : "dead";
  try {
    return runtime.probeProcess(record.pid) === "absent" ? "dead" : "unknown";
  } catch {
    return "unknown";
  }
}

function currentRecord(runtime: LockRuntime): LockRecord | undefined {
  const startTime = runtime.readStartTime(process.pid);
  return startTime === undefined ? undefined : { pid: process.pid, startTime, token: randomUUID() };
}

function removePublishedRecord(
  path: string,
  token: string,
  identity: FileIdentity,
  directoryIdentity: FileIdentity,
  fsyncDirectory: (path: string) => void,
): void {
  try {
    const directory = lstatSync(dirname(path));
    if (!directory.isDirectory() || directory.isSymbolicLink() || !sameIdentity(fileIdentity(directory), directoryIdentity)) return;
  } catch {
    return;
  }
  const owned = readRecord(path, "finalization lock");
  if (owned.kind !== "record" || owned.record.token !== token || !sameIdentity(owned.identity, identity)) return;
  try {
    unlinkSync(path);
    fsyncDirectory(dirname(path));
  } catch {
    // The exact canonical link is already absent if only directory durability failed.
  }
}

function publishRecord(
  path: string,
  record: LockRecord,
  directoryIdentity: FileIdentity,
  fsyncDirectory: (path: string) => void,
): { readonly published: true; readonly identity: FileIdentity } | { readonly published: false; readonly reason: "contended" | "unavailable" } {
  const ownerPath = `${path}.owner-${record.token}`;
  let fd: number | undefined;
  let ownerCreated = false;
  let canonicalLinked = false;
  let canonicalIdentity: FileIdentity | undefined;
  let failure: unknown;
  try {
    fd = openSync(
      ownerPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    ownerCreated = true;
    writeFileSync(fd, JSON.stringify(record));
    fsyncBestEffortSync(fd);
    closeSync(fd);
    fd = undefined;
    linkSync(ownerPath, path);
    canonicalLinked = true;
    canonicalIdentity = fileIdentity(lstatSync(path));
    fsyncDirectory(dirname(path));
  } catch (error) {
    failure = error;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch (error) {
        failure ??= error;
      }
    }
    let ownerUnlinked = false;
    if (ownerCreated) {
      try {
        unlinkSync(ownerPath);
        ownerUnlinked = true;
      } catch (error) {
        failure ??= error;
      }
    }
    if (ownerUnlinked) {
      try {
        fsyncDirectory(dirname(path));
      } catch (error) {
        failure ??= error;
      }
    }
  }
  if (failure !== undefined && canonicalLinked && canonicalIdentity !== undefined) {
    removePublishedRecord(path, record.token, canonicalIdentity, directoryIdentity, fsyncDirectory);
  }
  if (failure !== undefined) {
    return { published: false, reason: !canonicalLinked && nodeCode(failure) === "EEXIST" ? "contended" : "unavailable" };
  }
  if (canonicalIdentity === undefined) return { published: false, reason: "unavailable" };
  return { published: true, identity: canonicalIdentity };
}

function guardName(kind: "owner" | "claim", record: LockRecord, createdAtMs: number): string {
  return `${kind}.${createdAtMs}.${record.pid}.${record.startTime}.${record.token}.json`;
}

function recordFromGuardName(name: string): { readonly record: LockRecord; readonly createdAtMs: number } | undefined {
  const match = NAMED_GUARD.exec(name);
  if (match === null) return undefined;
  const createdAtMs = Number(match[1]);
  const pid = Number(match[2]);
  const startTime = Number(match[3]);
  const token = match[4]!;
  return Number.isFinite(createdAtMs) && Number.isSafeInteger(pid) && pid > 0 && Number.isFinite(startTime)
    ? { record: { pid, startTime, token }, createdAtMs }
    : undefined;
}

function releaseGuard(
  path: string,
  ownerName: string,
  token: string,
  fsyncDirectory: (path: string) => void,
  directoryIdentity: FileIdentity,
  markerIdentity: FileIdentity,
): void {
  try {
    const directoryStat = lstatSync(path);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return;
    if (!sameIdentity(fileIdentity(directoryStat), directoryIdentity)) return;
    const marker = resolve(path, ownerName);
    const stat = lstatSync(marker);
    if (!stat.isFile() || stat.isSymbolicLink()) return;
    if (!sameIdentity(fileIdentity(stat), markerIdentity)) return;
    if (ownerName === "ownerless.claim") {
      const owned = readRecord(marker, "ownerless recovery claim");
      if (
        owned.kind !== "record"
        || owned.record.token !== token
        || !sameIdentity(owned.identity, markerIdentity)
      ) return;
    } else if (recordFromGuardName(ownerName)?.record.token !== token) {
      return;
    }
    unlinkSync(marker);
    fsyncDirectory(path);
    rmdirSync(path);
    fsyncDirectory(dirname(path));
  } catch {
    // Exact-marker proof was lost or cleanup raced; stale recovery handles the remnant.
  }
}

function validateGuardOwnership(
  path: string,
  ownerName: string,
  token: string,
  directoryIdentity: FileIdentity,
  markerIdentity: FileIdentity,
): boolean {
  try {
    const directoryStat = lstatSync(path);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return false;
    if (!sameIdentity(fileIdentity(directoryStat), directoryIdentity)) return false;
    const names = readdirSync(path);
    if (names.length !== 1 || names[0] !== ownerName) return false;
    const markerStat = lstatSync(resolve(path, ownerName));
    if (!markerStat.isFile() || markerStat.isSymbolicLink()) return false;
    if (!sameIdentity(fileIdentity(markerStat), markerIdentity)) return false;
    if (ownerName === "ownerless.claim") {
      const owned = readRecord(resolve(path, ownerName), "ownerless recovery claim");
      return owned.kind === "record"
        && owned.record.token === token
        && sameIdentity(owned.identity, markerIdentity);
    }
    return recordFromGuardName(ownerName)?.record.token === token;
  } catch {
    return false;
  }
}

function acquiredGuard(
  path: string,
  ownerName: string,
  token: string,
  directoryIdentity: FileIdentity,
  markerIdentity: FileIdentity,
  fsyncDirectory: (path: string) => void,
): RecoveryGuard {
  if (!validateGuardOwnership(path, ownerName, token, directoryIdentity, markerIdentity)) {
    releaseGuard(path, ownerName, token, fsyncDirectory, directoryIdentity, markerIdentity);
    return {
      acquired: false,
      reason: "contended",
      detail: "finalization recovery ownership changed before it could be fenced",
    };
  }
  return {
    acquired: true,
    release: () => releaseGuard(
      path,
      ownerName,
      token,
      fsyncDirectory,
      directoryIdentity,
      markerIdentity,
    ),
  };
}

/** Restores a moved exact inode to the fixed ownerless name without overwriting any successor. */
function restoreOwnerlessClaim(
  path: string,
  claimName: string,
  directoryIdentity: FileIdentity,
  claimIdentity: FileIdentity,
  fsyncDirectory: (path: string) => void,
): boolean {
  try {
    const directoryStat = lstatSync(path);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return false;
    if (!sameIdentity(fileIdentity(directoryStat), directoryIdentity)) return false;
    const claimPath = resolve(path, claimName);
    const claimStat = lstatSync(claimPath);
    if (!claimStat.isFile() || claimStat.isSymbolicLink()) return false;
    if (!sameIdentity(fileIdentity(claimStat), claimIdentity)) return false;

    const canonicalPath = resolve(path, "ownerless.claim");
    linkSync(claimPath, canonicalPath);
    fsyncDirectory(path);
    const canonicalStat = lstatSync(canonicalPath);
    if (!sameIdentity(fileIdentity(canonicalStat), claimIdentity)) return false;
    unlinkSync(claimPath);
    fsyncDirectory(path);
    const names = readdirSync(path);
    return names.length === 1
      && names[0] === "ownerless.claim"
      && sameIdentity(fileIdentity(lstatSync(canonicalPath)), claimIdentity);
  } catch {
    return false;
  }
}

function acquireRecoveryGuard(
  path: string,
  runtime: LockRuntime,
): RecoveryGuard {
  const { nowMs, fsyncDirectory } = runtime;
  const record = currentRecord(runtime);
  if (record === undefined) {
    return { acquired: false, reason: "unavailable", detail: "process start marker is unavailable" };
  }
  const ownerName = guardName("owner", record, nowMs());
  let directoryCreated = false;
  let markerCreated = false;
  let freshFd: number | undefined;
  let freshDirectoryIdentity: FileIdentity | undefined;
  let freshMarkerIdentity: FileIdentity | undefined;
  try {
    mkdirSync(path, { mode: 0o700 });
    directoryCreated = true;
    freshDirectoryIdentity = fileIdentity(lstatSync(path));
    runtime.afterRecoveryDirectoryCreated?.();
    const marker = resolve(path, ownerName);
    freshFd = openSync(
      marker,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    markerCreated = true;
    freshMarkerIdentity = fileIdentity(fstatSync(freshFd));
    fsyncBestEffortSync(freshFd);
    closeSync(freshFd);
    freshFd = undefined;
    fsyncDirectory(path);
    return acquiredGuard(
      path,
      ownerName,
      record.token,
      freshDirectoryIdentity,
      freshMarkerIdentity,
      fsyncDirectory,
    );
  } catch (error) {
    if (freshFd !== undefined) {
      try {
        closeSync(freshFd);
      } catch {
        // Exact cleanup below remains authoritative.
      }
    }
    if (
      directoryCreated
      && markerCreated
      && freshDirectoryIdentity !== undefined
      && freshMarkerIdentity !== undefined
    ) {
      releaseGuard(
        path,
        ownerName,
        record.token,
        fsyncDirectory,
        freshDirectoryIdentity,
        freshMarkerIdentity,
      );
    }
    if (directoryCreated && !markerCreated) {
      try {
        const currentDirectory = lstatSync(path);
        if (
          freshDirectoryIdentity !== undefined
          && sameIdentity(fileIdentity(currentDirectory), freshDirectoryIdentity)
        ) {
          rmdirSync(path);
          fsyncDirectory(dirname(path));
        }
      } catch {
        // A racing entry is never removed without exact ownership proof.
      }
    }
    if (nodeCode(error) !== "EEXIST") {
      return { acquired: false, reason: "unavailable", detail: `cannot create finalization recovery guard: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  let stat;
  let names: string[];
  try {
    stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return { acquired: false, reason: "invalid", detail: "finalization recovery guard must be a regular directory" };
    }
    names = readdirSync(path);
  } catch (error) {
    return { acquired: false, reason: "unavailable", detail: `cannot inspect finalization recovery guard: ${error instanceof Error ? error.message : String(error)}` };
  }

  const recoveryDirectoryIdentity = fileIdentity(stat);

  if (names.length === 0) {
    if (nowMs() - stat.mtimeMs <= OWNERLESS_STALE_AFTER_MS) {
      return { acquired: false, reason: "contended", detail: "finalization recovery guard is being initialized" };
    }
    const claimPath = resolve(path, "ownerless.claim");
    let fd: number | undefined;
    let claimIdentity: FileIdentity | undefined;
    try {
      fd = openSync(
        claimPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      claimIdentity = fileIdentity(fstatSync(fd));
      runtime.afterOwnerlessClaimOpened?.(claimPath, record);
      writeFileSync(fd, JSON.stringify(record));
      fsyncBestEffortSync(fd);
      closeSync(fd);
      fd = undefined;
      fsyncDirectory(path);
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      if (claimIdentity !== undefined) {
        releaseGuard(
          path,
          "ownerless.claim",
          record.token,
          fsyncDirectory,
          recoveryDirectoryIdentity,
          claimIdentity,
        );
      }
      return nodeCode(error) === "EEXIST"
        ? { acquired: false, reason: "contended", detail: "another process claimed ownerless recovery" }
        : { acquired: false, reason: "unavailable", detail: `cannot claim ownerless recovery: ${error instanceof Error ? error.message : String(error)}` };
    }
    return acquiredGuard(
      path,
      "ownerless.claim",
      record.token,
      recoveryDirectoryIdentity,
      claimIdentity,
      fsyncDirectory,
    );
  }

  if (names.length !== 1) {
    return { acquired: false, reason: "invalid", detail: "finalization recovery guard contains ambiguous owner markers" };
  }
  const existingName = names[0]!;
  const named = recordFromGuardName(existingName);
  let existing = named?.record;
  let createdAtMs = named?.createdAtMs;
  if (existing === undefined && existingName === "ownerless.claim") {
    const claimStat = lstatSync(resolve(path, existingName));
    if (!claimStat.isFile() || claimStat.isSymbolicLink()) {
      return { acquired: false, reason: "invalid", detail: "ownerless recovery claim must be a regular file" };
    }
    const read = readRecord(resolve(path, existingName), "finalization recovery claim");
    if (read.kind === "invalid") {
      const ownerlessPath = resolve(path, existingName);
      const invalidSnapshot = readFileSnapshot(ownerlessPath);
      if (
        invalidSnapshot === undefined
        || !sameIdentity(invalidSnapshot.identity, fileIdentity(claimStat))
        || parseLockRecordText(invalidSnapshot.text) !== undefined
      ) {
        return { acquired: false, reason: "contended", detail: "ownerless recovery claim changed while being inspected" };
      }
      if (nowMs() - invalidSnapshot.mtimeMs <= OWNERLESS_STALE_AFTER_MS) {
        return { acquired: false, reason: "contended", detail: "ownerless recovery claim is being initialized" };
      }
      // A process may crash between O_EXCL creation and completing the fixed claim record.
      // Snapshot exact bytes/inode before the final race window. Only byte-identical invalid
      // state may be adopted after rename; a writer that completed meanwhile remains owner.
      runtime.afterInvalidOwnerlessReadBeforeRename?.(ownerlessPath);
      const crashedClaimName = guardName("claim", record, nowMs());
      try {
        const crashedClaimPath = resolve(path, crashedClaimName);
        renameSync(ownerlessPath, crashedClaimPath);
        const movedSnapshot = readFileSnapshot(crashedClaimPath);
        if (movedSnapshot === undefined) {
          return { acquired: false, reason: "contended", detail: "ownerless recovery claim changed during rename" };
        }
        const movedRecord = parseLockRecordText(movedSnapshot.text);
        const unchangedInvalid = sameIdentity(movedSnapshot.identity, invalidSnapshot.identity)
          && movedRecord === undefined
          && movedSnapshot.text === invalidSnapshot.text
          && movedSnapshot.size === invalidSnapshot.size
          && movedSnapshot.mtimeMs === invalidSnapshot.mtimeMs;
        if (!unchangedInvalid) {
          const activeTransition = movedRecord !== undefined
            && (
              nowMs() - movedSnapshot.mtimeMs <= OWNERLESS_STALE_AFTER_MS
              || ownerLiveness(movedRecord, runtime) !== "dead"
            );
          const restored = restoreOwnerlessClaim(
            path,
            crashedClaimName,
            recoveryDirectoryIdentity,
            movedSnapshot.identity,
            fsyncDirectory,
          );
          if (!restored) {
            return {
              acquired: false,
              reason: "unavailable",
              detail: "ownerless recovery changed during reclamation and exact restoration could not be completed",
            };
          }
          return {
            acquired: false,
            reason: "contended",
            detail: activeTransition
              ? "ownerless recovery initialization completed before reclamation"
              : "ownerless recovery bytes changed before reclamation",
          };
        }
        const crashedClaimIdentity = movedSnapshot.identity;
        try {
          fsyncDirectory(path);
        } catch (error) {
          releaseGuard(
            path,
            crashedClaimName,
            record.token,
            fsyncDirectory,
            recoveryDirectoryIdentity,
            crashedClaimIdentity,
          );
          throw error;
        }
        return acquiredGuard(
          path,
          crashedClaimName,
          record.token,
          recoveryDirectoryIdentity,
          crashedClaimIdentity,
          fsyncDirectory,
        );
      } catch (error) {
        return nodeCode(error) === "ENOENT"
          ? { acquired: false, reason: "contended", detail: "ownerless recovery claim changed" }
          : { acquired: false, reason: "unavailable", detail: `cannot recover ownerless claim: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
    if (read.kind === "absent") return { acquired: false, reason: "contended", detail: "recovery claim changed" };
    existing = read.record;
    createdAtMs = claimStat.mtimeMs;
  }
  if (existing === undefined) {
    return { acquired: false, reason: "invalid", detail: "finalization recovery guard owner marker is malformed" };
  }
  const existingStat = lstatSync(resolve(path, existingName));
  if (!existingStat.isFile() || existingStat.isSymbolicLink()) {
    return { acquired: false, reason: "invalid", detail: "finalization recovery owner marker must be a regular file" };
  }
  if (
    nowMs() - (createdAtMs ?? 0) <= OWNERLESS_STALE_AFTER_MS
    || ownerLiveness(existing, runtime) !== "dead"
  ) {
    return { acquired: false, reason: "contended", detail: "finalization recovery is active in another process" };
  }

  const claimName = guardName("claim", record, nowMs());
  try {
    renameSync(resolve(path, existingName), resolve(path, claimName));
    const claimIdentity = fileIdentity(lstatSync(resolve(path, claimName)));
    try {
      fsyncDirectory(path);
    } catch (error) {
      releaseGuard(
        path,
        claimName,
        record.token,
        fsyncDirectory,
        recoveryDirectoryIdentity,
        claimIdentity,
      );
      throw error;
    }
    return acquiredGuard(
      path,
      claimName,
      record.token,
      recoveryDirectoryIdentity,
      claimIdentity,
      fsyncDirectory,
    );
  } catch (error) {
    return nodeCode(error) === "ENOENT"
      ? { acquired: false, reason: "contended", detail: "finalization recovery ownership changed" }
      : { acquired: false, reason: "unavailable", detail: `cannot claim stale finalization recovery: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function acquireRunNamedLock(
  workspaceDir: string,
  path: string,
  deps: RunFinalizationLockDeps = {},
): RunFinalizationLockResult {
  const recoveryPath = `${path}.recovery`;
  const fsyncDirectory = deps.fsyncDirectory ?? fsyncDirectorySync;
  const runtime: LockRuntime = {
    nowMs: deps.nowMs ?? Date.now,
    fsyncDirectory,
    readStartTime: deps.readProcessStartTime ?? readProcessStartTime,
    probeProcess: deps.probeProcess ?? defaultProbeProcess,
    ...(deps.afterRecoveryDirectoryCreated !== undefined
      ? { afterRecoveryDirectoryCreated: deps.afterRecoveryDirectoryCreated }
      : {}),
    ...(deps.afterOwnerlessClaimOpened !== undefined
      ? { afterOwnerlessClaimOpened: deps.afterOwnerlessClaimOpened }
      : {}),
    ...(deps.afterInvalidOwnerlessReadBeforeRename !== undefined
      ? { afterInvalidOwnerlessReadBeforeRename: deps.afterInvalidOwnerlessReadBeforeRename }
      : {}),
  };
  mkdirSync(runsDir(workspaceDir), { recursive: true, mode: 0o700 });
  const directoryStat = lstatSync(runsDir(workspaceDir));
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    return { acquired: false, reason: "invalid", detail: "run lock parent must be a regular directory" };
  }
  const directoryIdentity = fileIdentity(directoryStat);

  if (liveLocks.has(path)) {
    return { acquired: false, reason: "contended", detail: "run finalization is active in this process" };
  }
  const initial = readRecord(path, "finalization lock");
  if (initial.kind === "invalid") return { acquired: false, reason: "invalid", detail: initial.detail };
  if (initial.kind === "record") {
    if (ownerLiveness(initial.record, runtime) !== "dead") {
      return { acquired: false, reason: "contended", detail: "run finalization is active in another process" };
    }
    deps.afterInitialDeadRead?.();
  }

  const guard = acquireRecoveryGuard(recoveryPath, runtime);
  if (!guard.acquired) return guard;
  try {
    const current = readRecord(path, "finalization lock");
    if (current.kind === "invalid") return { acquired: false, reason: "invalid", detail: current.detail };
    if (current.kind === "record") {
      if (ownerLiveness(current.record, runtime) !== "dead") {
        return { acquired: false, reason: "contended", detail: "run finalization is active in another process" };
      }
      try {
        unlinkSync(path);
        fsyncDirectory(runsDir(workspaceDir));
      } catch (error) {
        return { acquired: false, reason: "unavailable", detail: `cannot reclaim dead finalization owner: ${error instanceof Error ? error.message : String(error)}` };
      }
    }

    const record = currentRecord(runtime);
    if (record === undefined) {
      return { acquired: false, reason: "unavailable", detail: "process start marker is unavailable" };
    }
    const publication = publishRecord(path, record, directoryIdentity, fsyncDirectory);
    if (!publication.published) {
      return publication.reason === "contended"
        ? { acquired: false, reason: "contended", detail: "finalization ownership changed during publication" }
        : { acquired: false, reason: "unavailable", detail: "finalization ownership could not be published durably" };
    }
    liveLocks.set(path, record.token);
    let released = false;
    return {
      acquired: true,
      release() {
        if (released) return;
        released = true;
        if (liveLocks.get(path) === record.token) liveLocks.delete(path);
        let sameDirectory = false;
        try {
          const directory = lstatSync(dirname(path));
          sameDirectory = directory.isDirectory()
            && !directory.isSymbolicLink()
            && sameIdentity(fileIdentity(directory), directoryIdentity);
        } catch {
          sameDirectory = false;
        }
        const owned = readRecord(path, "finalization lock");
        if (
          sameDirectory
          && owned.kind === "record"
          && owned.record.token === record.token
          && sameIdentity(owned.identity, publication.identity)
        ) {
          try {
            unlinkSync(path);
            fsyncDirectory(runsDir(workspaceDir));
          } catch {
            // Dead-owner recovery handles a leftover exact token.
          }
        }
      },
    };
  } finally {
    guard.release();
  }
}

export function acquireRunFinalizationLock(
  workspaceDir: string,
  draftId: string,
  deps: RunFinalizationLockDeps = {},
): RunFinalizationLockResult {
  return acquireRunNamedLock(workspaceDir, resolve(runFinalizationLockPath(workspaceDir, draftId)), deps);
}

/** The publication pair uses the same fenced ownership protocol as collect/cancel finalization. */
export function acquireRunPublicationGuard(
  workspaceDir: string,
  draftId: string,
  deps: RunFinalizationLockDeps = {},
): RunFinalizationLockResult {
  return acquireRunNamedLock(workspaceDir, resolve(runPublicationLockPath(workspaceDir, draftId)), deps);
}

/** Test/documentation-only path helper for recovery-guard integrity coverage. */
export function runFinalizationRecoveryPath(workspaceDir: string, draftId: string): string {
  return `${resolve(runFinalizationLockPath(workspaceDir, draftId))}.recovery`;
}

/** Test/documentation-only path helper for publication recovery-guard integrity coverage. */
export function runPublicationRecoveryPath(workspaceDir: string, draftId: string): string {
  return `${resolve(runPublicationLockPath(workspaceDir, draftId))}.recovery`;
}

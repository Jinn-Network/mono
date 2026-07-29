// SPDX-License-Identifier: Apache-2.0

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  linkSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { TaskExecutionError } from "@jinn-network/task-execution-backend";
import { readProcessStartTime } from "@jinn-network/task-execution-supervisor";

export type CapacityAcquireResult =
  | { readonly acquired: true }
  | { readonly acquired: false; readonly error: TaskExecutionError };

/**
 * A zero-queue capacity gate. A failed acquisition is an immediate `backend-unavailable`
 * operation result; callers never wait behind an in-process queue.
 */
export class CapacityGate {
  private readonly live = new Set<string>();

  constructor(readonly ceiling: number) {
    if (!Number.isSafeInteger(ceiling) || ceiling < 1) {
      throw new RangeError("capacity ceiling must be a positive safe integer");
    }
  }

  tryAcquire(attempt: string): CapacityAcquireResult {
    if (this.live.has(attempt)) return { acquired: true };
    if (this.live.size >= this.ceiling) {
      return {
        acquired: false,
        error: new TaskExecutionError("backend-unavailable", {
          detail: `local backend capacity exhausted (${this.live.size}/${this.ceiling} live Attempts); submissions are never queued`,
          annotations: { capacity: this.ceiling, liveAttempts: this.live.size },
        }),
      };
    }
    this.live.add(attempt);
    return { acquired: true };
  }

  release(attempt: string): void {
    this.live.delete(attempt);
  }

  restore(attempts: Iterable<string>): void {
    this.live.clear();
    for (const attempt of attempts) this.live.add(attempt);
  }

  get liveCount(): number {
    return this.live.size;
  }
}

export type StateRootWriter =
  | { readonly acquired: true; readonly lockPath: string; readonly release: () => void }
  | { readonly acquired: false; readonly error: TaskExecutionError };

interface LockRecord {
  readonly pid: number;
  readonly startTime: number;
  readonly token: string;
}

// `open("wx")` is process-safe, but a second backend in the same process shares a PID. This
// registry distinguishes that live-owner case from a stale lock file left by a dead process.
const liveRoots = new Map<string, string>();

function locked(detail: string): StateRootWriter {
  return {
    acquired: false,
    error: new TaskExecutionError("backend-unavailable", {
      detail,
      annotations: { reason: "state-root-locked" },
    }),
  };
}

function processIsLive(owner: LockRecord): boolean {
  if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) return false;
  const current = readProcessStartTime(owner.pid);
  return current !== undefined && current === owner.startTime;
}

function readLock(path: string): LockRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LockRecord>;
    if (
      typeof parsed.pid !== "number"
      || typeof parsed.startTime !== "number"
      || typeof parsed.token !== "string"
    ) return undefined;
    return { pid: parsed.pid, startTime: parsed.startTime, token: parsed.token };
  } catch {
    return undefined;
  }
}

function publishLock(lockPath: string, record: LockRecord): boolean {
  const ownerPath = `${lockPath}.owner-${record.token}`;
  let ownerFd: number | undefined;
  try {
    ownerFd = openSync(ownerPath, "wx", 0o600);
    writeFileSync(ownerFd, JSON.stringify(record));
    fsyncSync(ownerFd);
    closeSync(ownerFd);
    ownerFd = undefined;
    // The canonical lock appears only after its complete owner record is durable.
    linkSync(ownerPath, lockPath);
    return true;
  } catch {
    if (ownerFd !== undefined) closeSync(ownerFd);
    return false;
  } finally {
    try {
      unlinkSync(ownerPath);
    } catch {
      // The canonical hard link, when present, owns the published record.
    }
  }
}

function reclaimStaleLock(lockPath: string): boolean {
  const quarantinePath = `${lockPath}.stale-${crypto.randomUUID()}`;
  try {
    // Rename is atomic: only one contender gets ownership of this stale generation.
    renameSync(lockPath, quarantinePath);
  } catch {
    return false;
  }
  try {
    return true;
  } finally {
    try {
      unlinkSync(quarantinePath);
    } catch {
      // A leftover quarantine name is harmless and contains no live canonical owner.
    }
  }
}

/**
 * Acquires the one-writer state-root lifetime lock.
 *
 * Node exposes no `flock(2)` binding. The implementation therefore uses the same observable
 * one-live-writer semantics with an atomic `O_CREAT|O_EXCL` lock record, a live-PID check, and
 * an in-process ownership token. A crashed owner's stale record is reclaimed; a live owner is
 * never displaced.
 */
export function acquireStateRootWriter(stateRoot: string): StateRootWriter {
  const root = resolve(stateRoot);
  const meta = join(root, "meta");
  const lockPath = join(meta, "backend.lock");
  mkdirSync(meta, { recursive: true, mode: 0o700 });

  if (liveRoots.has(root)) {
    return locked("state root locked by a live instance");
  }

  if (existsSync(lockPath)) {
    const record = readLock(lockPath);
    if (record !== undefined && processIsLive(record)) {
      return locked("state root locked by a live instance");
    }
    if (!reclaimStaleLock(lockPath)) {
      return locked("state root lock could not be reclaimed");
    }
  }

  const startTime = readProcessStartTime(process.pid);
  if (startTime === undefined) {
    return locked("state root owner process start marker is unavailable");
  }
  const token = crypto.randomUUID();
  const record = { pid: process.pid, startTime, token } satisfies LockRecord;
  if (!publishLock(lockPath, record)) {
    return locked(
      "state root locked by a live instance",
    );
  }
  liveRoots.set(root, token);

  let released = false;
  return {
    acquired: true,
    lockPath,
    release() {
      if (released) return;
      released = true;
      if (liveRoots.get(root) === token) liveRoots.delete(root);
      const record = readLock(lockPath);
      if (record?.token === token) {
        try {
          unlinkSync(lockPath);
        } catch {
          // Process-lifetime release is best-effort at shutdown; stale-PID reclamation handles
          // a leftover record on the next acquisition.
        }
      }
    },
  };
}

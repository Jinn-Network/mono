/**
 * Per-Safe transaction mutex — cross-process safe.
 *
 * Serializes all Safe execTransaction calls for the same Safe address
 * to prevent nonce collisions. Supports two modes:
 *
 * 1. **File-based lock** (multi-worker on Railway): Uses exclusive-create
 *    lockfiles in a shared directory (e.g. /root/.safe-locks/) so that
 *    independent Node processes sharing the same Safe can't collide.
 *
 * 2. **In-process mutex** (fallback): Promise-chain pattern for local dev
 *    or single-worker deployments where no shared filesystem exists.
 *
 * The mode is auto-detected at startup: if the lock directory exists (or
 * can be created), file-based locking is used; otherwise falls back to
 * in-process only.
 *
 * Usage (unchanged from before):
 *   const release = await acquireSafeLock(safeAddress);
 *   try { ... sign & exec ... } finally { release(); }
 */

import { open, readFile, writeFile, rename } from 'node:fs/promises';
import { mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const LOCK_DIR = process.env.SAFE_LOCK_DIR || '/root/.safe-locks';
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const POLL_INITIAL_MS = 100;
const POLL_MAX_MS = 1_600;
const POLL_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// In-process mutex (fallback & local serialisation layer)
// ---------------------------------------------------------------------------

const inProcessLocks = new Map<string, Promise<void>>();

async function acquireInProcessLock(key: string): Promise<() => void> {
  const prev = inProcessLocks.get(key) ?? Promise.resolve();

  let release!: () => void;
  const next = new Promise<void>(resolve => {
    release = resolve;
  });

  inProcessLocks.set(key, next);
  await prev;
  return release;
}

// ---------------------------------------------------------------------------
// File-based lock (cross-process)
// ---------------------------------------------------------------------------

interface LockPayload {
  pid: number;
  ts: number;
  safe: string;
}

let fileLocksAvailable: boolean | null = null;

function initLockDir(): boolean {
  if (fileLocksAvailable !== null) return fileLocksAvailable;

  try {
    mkdirSync(LOCK_DIR, { recursive: true });
    fileLocksAvailable = true;
  } catch {
    // Can't create lock dir (e.g. read-only FS, no /root) — fall back
    fileLocksAvailable = false;
  }
  return fileLocksAvailable;
}

function lockPath(key: string): string {
  return join(LOCK_DIR, `${key}.lock`);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isLockStale(payload: LockPayload): boolean {
  if (!isPidAlive(payload.pid)) return true;
  if (Date.now() - payload.ts > STALE_THRESHOLD_MS) return true;
  return false;
}

async function readLockPayload(path: string): Promise<LockPayload | null> {
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as LockPayload;
  } catch {
    return null;
  }
}

/**
 * Atomically break a stale lock by writing to a temp file and renaming.
 * If two processes race to break the same stale lock, only one rename
 * will succeed; the other gets an error and retries normally.
 */
async function tryBreakStaleLock(lp: string, key: string): Promise<boolean> {
  const tempPath = join(LOCK_DIR, `${key}.${process.pid}.${Date.now()}.tmp`);
  const payload: LockPayload = { pid: process.pid, ts: Date.now(), safe: key };

  try {
    await writeFile(tempPath, JSON.stringify(payload), { mode: 0o644 });
    await rename(tempPath, lp);
    return true;
  } catch {
    // Clean up temp file if rename failed (another process won the race)
    try { unlinkSync(tempPath); } catch { /* ignore */ }
    return false;
  }
}

async function acquireFileLock(key: string): Promise<() => void> {
  const lp = lockPath(key);
  const payload: LockPayload = { pid: process.pid, ts: Date.now(), safe: key };
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let delay = POLL_INITIAL_MS;

  while (true) {
    // Attempt exclusive create
    try {
      const fd = await open(lp, 'wx', 0o644);
      await fd.writeFile(JSON.stringify(payload));
      await fd.close();

      // Lock acquired — return synchronous release function
      return () => {
        try { unlinkSync(lp); } catch { /* already removed */ }
      };
    } catch (err: any) {
      if (err.code !== 'EEXIST') throw err;
    }

    // Lock file exists — check staleness
    const existing = await readLockPayload(lp);
    if (existing && isLockStale(existing)) {
      if (await tryBreakStaleLock(lp, key)) {
        // We broke the stale lock and claimed it via rename
        return () => {
          try { unlinkSync(lp); } catch { /* already removed */ }
        };
      }
      // Another process won the break race — loop and retry
    }

    // Check timeout
    if (Date.now() >= deadline) {
      throw new Error(
        `[safeTxMutex] Timed out waiting for file lock on Safe ${key} after ${POLL_TIMEOUT_MS}ms`,
      );
    }

    // Back off and retry
    await new Promise(resolve => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, POLL_MAX_MS);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function acquireSafeLock(safeAddress: string): Promise<() => void> {
  const key = safeAddress.toLowerCase();

  // Always acquire the in-process lock first (serializes within this process)
  const releaseInProcess = await acquireInProcessLock(key);

  // If file locks are available, also acquire the cross-process lock
  if (initLockDir()) {
    try {
      const releaseFile = await acquireFileLock(key);
      return () => {
        try { releaseFile(); } catch { /* best effort */ }
        releaseInProcess();
      };
    } catch (err) {
      // If file lock fails, release in-process lock and propagate
      releaseInProcess();
      throw err;
    }
  }

  // Fallback: in-process only
  return releaseInProcess;
}

/**
 * Working-directory reaper.
 *
 * The TaskEngine provisions a per-task working directory under
 * `engine.workingDirRoot` (default `~/.jinn-client/engine/work/<requestId>/`).
 * Each one holds heavy scratch — a cloned repo, a per-task plugins copy, a
 * `system_snapshot.tar.gz`, session transcripts and an env directory.
 *
 * Historically nothing ever removed these. A long-lived operator accumulated
 * 412 work dirs / 49 GB with no cleanup (issue #320). The snapshot tarball is
 * uploaded to IPFS at delivery time, so once a task reaches a terminal state
 * (COMPLETE / FAILED) the on-disk working directory is pure dead weight.
 *
 * This module is the single place that decides what may be deleted. It is
 * deliberately conservative:
 *
 *   1. A directory whose requestId is currently in-flight is NEVER removed,
 *      regardless of age — the engine still needs it.
 *   2. A directory whose requestId is in a terminal state is removed
 *      immediately (its evidence already lives on-chain / on IPFS).
 *   3. A directory with no matching persistence row at all ("orphan" — left
 *      by a crash, an older daemon version, or a wiped DB) is removed only
 *      once it is older than `orphanMaxAgeMs`, so we never race a task the
 *      DB has not observed yet.
 *
 * It is pure I/O over the filesystem plus two caller-supplied id sets, which
 * makes it trivially testable.
 */

import { readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Default age before an orphaned (no DB row) work dir is reaped: 24 hours. */
export const DEFAULT_ORPHAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface ReapWorkDirsOptions {
  /** Root that holds per-task working directories (`engine.workingDirRoot`). */
  workingDirRoot: string;
  /** Request IDs whose task run is in a terminal state (COMPLETE / FAILED). */
  terminalRequestIds: ReadonlySet<string>;
  /** Request IDs whose task run is still in-flight — never reaped. */
  inFlightRequestIds: ReadonlySet<string>;
  /**
   * Age above which a directory with no DB row (orphan) is reaped.
   * Defaults to {@link DEFAULT_ORPHAN_MAX_AGE_MS}.
   */
  orphanMaxAgeMs?: number;
  /** Injectable clock for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface ReapWorkDirsReport {
  /** Request IDs whose working directory was removed this pass. */
  removed: string[];
  /** Request IDs skipped because the task is still in-flight. */
  protected: string[];
  /** Bytes-freed is not computed (would require a recursive walk); count only. */
  scanned: number;
  /** Non-fatal errors keyed by requestId (e.g. permission denied on rm). */
  errors: Array<{ requestId: string; error: string }>;
}

/**
 * Sweep `workingDirRoot` once and remove every working directory that is safe
 * to delete. Never throws for a missing root or an individual failed removal —
 * the daemon must keep running even if the disk is wedged.
 */
export function reapWorkDirs(opts: ReapWorkDirsOptions): ReapWorkDirsReport {
  const now = opts.now ?? Date.now;
  const orphanMaxAgeMs = opts.orphanMaxAgeMs ?? DEFAULT_ORPHAN_MAX_AGE_MS;
  const report: ReapWorkDirsReport = {
    removed: [],
    protected: [],
    scanned: 0,
    errors: [],
  };

  let entries: string[];
  try {
    entries = readdirSync(opts.workingDirRoot);
  } catch {
    // Root does not exist yet (no task ever ran) — nothing to do.
    return report;
  }

  for (const requestId of entries) {
    const dir = join(opts.workingDirRoot, requestId);
    let isDir = false;
    // Age orphans off mtime, not birthtime: a dir with a live writer keeps
    // bumping mtime, so it stays "fresh" and is never reaped — which is what
    // we want, since a continuously-written orphan has a running task whose
    // DB row was lost. birthtime would reap it out from under that task.
    let mtimeMs = 0;
    try {
      const st = statSync(dir);
      isDir = st.isDirectory();
      mtimeMs = st.mtimeMs;
    } catch {
      continue; // vanished between readdir and stat — fine.
    }
    if (!isDir) continue;
    report.scanned += 1;

    // (1) Never touch an in-flight task's directory.
    if (opts.inFlightRequestIds.has(requestId)) {
      report.protected.push(requestId);
      continue;
    }

    // (2) Terminal task — safe to remove immediately.
    // (3) Orphan (no DB row) — remove only once past the max age.
    const isTerminal = opts.terminalRequestIds.has(requestId);
    const isOrphan = !isTerminal; // not in-flight, not terminal → no row
    if (isOrphan && now() - mtimeMs < orphanMaxAgeMs) {
      continue; // young orphan — give the DB a chance to catch up.
    }

    try {
      rmSync(dir, { recursive: true, force: true });
      report.removed.push(requestId);
    } catch (err) {
      report.errors.push({
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return report;
}

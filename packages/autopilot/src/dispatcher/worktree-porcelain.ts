import { statSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Shared `git worktree list --porcelain` parsing + worktree helpers,
// consumed by state.ts (task worktrees) and review-state.ts (PR worktrees).
// ---------------------------------------------------------------------------

/**
 * Path component that identifies a task worktree's parent directory.
 *
 * Per CLAUDE.md AI rule #1, multi-agent worktrees live in
 * `../jinn-mono_worktrees/<name>` — sibling of the main repo checkout.
 * Task worktrees use the issue number as `<name>`, so the full shape is
 * `…/jinn-mono_worktrees/<N>`.
 */
const WORKTREE_PARENT_COMPONENT = 'jinn-mono_worktrees';

/**
 * One parsed worktree block from `git worktree list --porcelain`.
 *
 * Real output shape (observed 2026-05-21):
 *
 *   worktree /path/to/worktree
 *   HEAD <sha>
 *   branch refs/heads/<branch>   ← present for checked-out branch
 *   detached                     ← present instead of branch for detached HEAD
 *
 * Blocks are separated by blank lines.
 */
export interface ParsedWorktree {
  worktreePath: string;
  /** Full branch ref, e.g. "refs/heads/feat/418-something". Null if detached. */
  branchRef: string | null;
}

export function parseWorktreePorcelain(output: string): ParsedWorktree[] {
  const result: ParsedWorktree[] = [];
  // Split on blank lines to get blocks; trim trailing whitespace per line
  const blocks = output.split(/\n\n+/);

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length === 0 || lines[0] === '') continue;

    let worktreePath: string | null = null;
    let branchRef: string | null = null;

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        worktreePath = line.slice('worktree '.length);
      } else if (line.startsWith('branch ')) {
        branchRef = line.slice('branch '.length);
      }
      // 'detached' line → branchRef stays null
    }

    if (worktreePath != null) {
      result.push({ worktreePath, branchRef });
    }
  }

  return result;
}

/**
 * Extract the number from a `jinn-mono_worktrees/<prefix><N>` worktree path.
 * Returns null if the path is not a worktree of that shape (task worktrees
 * use prefix '', review worktrees use prefix 'pr-').
 *
 * Matches `jinn-mono_worktrees/<prefix><N>` as proper path components (split
 * on `/`) so that a repo mounted under a path whose directory name itself
 * contains the fragment
 * (e.g. `/home/user/jinn-mono_worktrees-backup/foo/jinn-mono_worktrees/418`)
 * is not misidentified — only the single component before the number is
 * examined.
 */
export function extractWorktreeNumber(worktreePath: string, prefix: string): number | null {
  // Split on '/' into proper path components (filter leading '' from absolute paths).
  const parts = worktreePath.split('/').filter((p, i) => i > 0 || p !== '');
  // Find the `jinn-mono_worktrees/<prefix><N>` sequence as proper components.
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === WORKTREE_PARENT_COMPONENT) {
      const candidate = parts[i + 1];
      if (candidate == null) return null;
      // Must be the final component (no trailing path segments after the number).
      if (i + 2 !== parts.length) return null;
      if (!candidate.startsWith(prefix)) return null;
      const digits = candidate.slice(prefix.length);
      const n = parseInt(digits, 10);
      if (isNaN(n) || String(n) !== digits) return null;
      return n;
    }
  }
  return null;
}

/**
 * Strip the "refs/heads/" prefix from a branch ref.
 * Returns the ref unchanged if it doesn't start with that prefix.
 */
export function shortBranch(branchRef: string): string {
  const prefix = 'refs/heads/';
  return branchRef.startsWith(prefix) ? branchRef.slice(prefix.length) : branchRef;
}

/**
 * Recover the best-available evidence of when a worktree session was
 * started, taking the MAX of two signals:
 *
 * - The dispatch-time marker file's mtime (`markerPath`, written — and
 *   truncated — at every dispatch by the production spawn lambda in
 *   run-eng-loop.ts). 0 if it cannot be stat-ed, or if no marker path is
 *   given (review sessions have no dispatch marker — worktree-only signal).
 * - The worktree directory's creation time (`birthtimeMs`), falling back to
 *   `mtimeMs` when `birthtimeMs` is 0 (common on Linux where birthtime is not
 *   tracked by the filesystem). 0 if it cannot be stat-ed.
 *
 * The marker is preferred evidence: when `dispatchIssue` reuses a
 * pre-existing worktree (the crash-recovery path around dispatch.ts:238-255),
 * the worktree directory's birthtime is wrong — it reflects when the
 * worktree was first created by an earlier, possibly abandoned session, not
 * when the current session started. This previously caused a false
 * wall-clock pause of a session that had started only minutes earlier
 * (observed live 2026-07-14 on issues #1296/#1393). Taking the max of both
 * signals means "most recent evidence of a session start" wins, without
 * regressing the plain worktree-birthtime case when no marker exists yet
 * (e.g. a worktree created outside the dispatcher).
 *
 * Returns 0 (unknown-age sentinel) if both signals are unavailable — the
 * WallClock guards against `startedAt <= 0` and will not force-pause an
 * unknown-age session.
 *
 * Exported for direct unit testing (test/dispatcher/recover-started-at.test.ts).
 */
export function recoverStartedAt(worktreePath: string, markerPath?: string): number {
  let markerMs = 0;
  if (markerPath != null) {
    try {
      markerMs = statSync(markerPath).mtimeMs;
    } catch {
      markerMs = 0;
    }
  }

  let worktreeMs = 0;
  try {
    const st = statSync(worktreePath);
    worktreeMs = st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
  } catch {
    worktreeMs = 0;
  }

  return Math.max(markerMs, worktreeMs);
}

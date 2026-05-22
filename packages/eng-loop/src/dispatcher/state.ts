import { statSync } from 'node:fs';
import type { CommandRunner } from './issue-source.js';
import type { InFlightSession } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_OWNER = 'Jinn-Network';
const PROJECT_NUMBER = '1';

/**
 * Path component that identifies a task worktree's parent directory.
 *
 * Per CLAUDE.md AI rule #1, multi-agent worktrees live in
 * `../jinn-mono_worktrees/<name>` — sibling of the main repo checkout.
 * Task worktrees use the issue number as `<name>`, so the full shape is
 * `…/jinn-mono_worktrees/<N>`.
 */
const WORKTREE_PARENT_COMPONENT = 'jinn-mono_worktrees';

// ---------------------------------------------------------------------------
// Internal types mirroring real gh output shapes
// ---------------------------------------------------------------------------

interface GhProjectItem {
  status?: string;
  title: string;
  id: string;
  repository: string;
  content?: {
    number: number;
    type: string;
    title: string;
    url: string;
    body?: string;
    repository: string;
  };
}

interface GhProjectItemsResponse {
  items: GhProjectItem[];
  totalCount: number;
}

// ---------------------------------------------------------------------------
// Parser: git worktree list --porcelain
// ---------------------------------------------------------------------------

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
interface ParsedWorktree {
  worktreePath: string;
  /** Full branch ref, e.g. "refs/heads/feat/418-something". Null if detached. */
  branchRef: string | null;
}

function parseWorktreePorcelain(output: string): ParsedWorktree[] {
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
 * Extract the issue number from a `jinn-mono_worktrees/<N>` worktree path.
 * Returns null if the path is not a task worktree.
 *
 * Matches `jinn-mono_worktrees/<N>` as proper path components (split on `/`)
 * so that a repo mounted under a path whose directory name itself contains
 * the fragment (e.g. `/home/user/jinn-mono_worktrees-backup/foo/jinn-mono_worktrees/418`)
 * is not misidentified — only the single component before the issue number
 * is examined.
 */
function extractTaskIssueNumber(worktreePath: string): number | null {
  // Split on '/' into proper path components (filter leading '' from absolute paths).
  const parts = worktreePath.split('/').filter((p, i) => i > 0 || p !== '');
  // Find the `jinn-mono_worktrees/<N>` sequence as proper components.
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === WORKTREE_PARENT_COMPONENT) {
      const candidate = parts[i + 1];
      if (candidate == null) return null;
      // Must be the final component (no trailing path segments after the issue number).
      if (i + 2 !== parts.length) return null;
      const n = parseInt(candidate, 10);
      if (isNaN(n) || String(n) !== candidate) return null;
      return n;
    }
  }
  return null;
}

/**
 * Strip the "refs/heads/" prefix from a branch ref.
 * Returns the ref unchanged if it doesn't start with that prefix.
 */
function shortBranch(branchRef: string): string {
  const prefix = 'refs/heads/';
  return branchRef.startsWith(prefix) ? branchRef.slice(prefix.length) : branchRef;
}

/**
 * Recover the best-available proxy for when a worktree session was started.
 *
 * Uses the worktree directory's creation time (`birthtimeMs`) as a proxy for
 * the session's `startedAt`. Falls back to `mtimeMs` when `birthtimeMs` is 0
 * (common on Linux where birthtime is not tracked by the filesystem). Returns 0
 * (unknown-age sentinel) if the path cannot be stat-ed — the WallClock guards
 * against `startedAt <= 0` and will not force-pause an unknown-age session.
 */
function recoverStartedAt(worktreePath: string): number {
  try {
    const st = statSync(worktreePath);
    const birth = st.birthtimeMs;
    return birth > 0 ? birth : st.mtimeMs;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Re-derive the dispatcher's in-flight set from authoritative external state:
 * - GitHub Project board (issues with `status === 'In Progress'`)
 * - git worktree list (worktrees under `jinn-mono_worktrees/<N>`)
 *
 * A crash or restart simply calls this again — state is never held only in
 * memory.
 *
 * Rules:
 *   matched pair (In Progress issue + jinn-mono_worktrees/<N> worktree) → InFlightSession
 *   In Progress issue with no worktree → drift warning string
 *   jinn-mono_worktrees/<N> worktree with no In Progress issue → drift warning string
 *
 * The dispatcher logs drift but does not act on it automatically. A human
 * resolves drift.
 */
export async function deriveInFlight(
  runner: CommandRunner,
): Promise<{ inFlight: InFlightSession[]; drift: string[] }> {
  // 1. Fetch Project board items
  const projectRaw = await runner('gh', [
    'project', 'item-list', PROJECT_NUMBER,
    '--owner', PROJECT_OWNER,
    '--format', 'json',
    '--limit', '500',
  ]);
  const projectData = JSON.parse(projectRaw) as GhProjectItemsResponse;

  // Build a set of issue numbers that are In Progress
  const inProgressIssues = new Map<number, true>();
  for (const item of projectData.items) {
    if (item.status === 'In Progress' && item.content?.type === 'Issue') {
      inProgressIssues.set(item.content.number, true);
    }
  }

  // 2. Fetch worktrees
  const worktreeRaw = await runner('git', ['worktree', 'list', '--porcelain']);
  const worktrees = parseWorktreePorcelain(worktreeRaw);

  // Build a map: issue number → worktree (for jinn-mono_worktrees/<N> paths only)
  const taskWorktrees = new Map<number, ParsedWorktree>();
  for (const wt of worktrees) {
    const n = extractTaskIssueNumber(wt.worktreePath);
    if (n != null) {
      taskWorktrees.set(n, wt);
    }
  }

  // 3. Match
  const inFlight: InFlightSession[] = [];
  const drift: string[] = [];

  // For each In Progress issue, check if there is a task worktree
  for (const issueNumber of inProgressIssues.keys()) {
    const wt = taskWorktrees.get(issueNumber);
    if (wt != null) {
      const branchRef = wt.branchRef;
      inFlight.push({
        issueNumber,
        branch: branchRef != null ? shortBranch(branchRef) : '',
        worktreePath: wt.worktreePath,
        pid: null,
        startedAt: recoverStartedAt(wt.worktreePath),
      });
    } else {
      drift.push(
        `drift: issue #${issueNumber} is In Progress on the board but has no jinn-mono_worktrees/${issueNumber} worktree`,
      );
    }
  }

  // For each task worktree, check if there is an In Progress issue
  for (const [issueNumber, wt] of taskWorktrees) {
    if (!inProgressIssues.has(issueNumber)) {
      drift.push(
        `drift: worktree ${wt.worktreePath} exists for issue #${issueNumber} but that issue is not In Progress on the board`,
      );
    }
  }

  return { inFlight, drift };
}

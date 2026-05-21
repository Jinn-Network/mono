import type { CommandRunner } from './issue-source.js';
import type { InFlightSession } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_OWNER = 'Jinn-Network';
const PROJECT_NUMBER = '1';

/** Worktrees under this path component are task worktrees. */
const TASKS_PATH_SEGMENT = 'cargo/.tasks/';

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
 * Extract the issue number from a cargo/.tasks/<N> worktree path.
 * Returns null if the path is not a task worktree.
 */
function extractTaskIssueNumber(worktreePath: string): number | null {
  const idx = worktreePath.indexOf(TASKS_PATH_SEGMENT);
  if (idx === -1) return null;
  const suffix = worktreePath.slice(idx + TASKS_PATH_SEGMENT.length);
  // suffix should be just the issue number (no trailing slash)
  const n = parseInt(suffix, 10);
  if (isNaN(n) || String(n) !== suffix) return null;
  return n;
}

/**
 * Strip the "refs/heads/" prefix from a branch ref.
 * Returns the ref unchanged if it doesn't start with that prefix.
 */
function shortBranch(branchRef: string): string {
  const prefix = 'refs/heads/';
  return branchRef.startsWith(prefix) ? branchRef.slice(prefix.length) : branchRef;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Re-derive the dispatcher's in-flight set from authoritative external state:
 * - GitHub Project board (issues with `status === 'In Progress'`)
 * - git worktree list (worktrees under `cargo/.tasks/<N>`)
 *
 * A crash or restart simply calls this again — state is never held only in
 * memory.
 *
 * Rules:
 *   matched pair (In Progress issue + cargo/.tasks/<N> worktree) → InFlightSession
 *   In Progress issue with no worktree → drift warning string
 *   cargo/.tasks/<N> worktree with no In Progress issue → drift warning string
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

  // Build a map: issue number → worktree (for cargo/.tasks/<N> paths only)
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
        startedAt: 0,
      });
    } else {
      drift.push(
        `drift: issue #${issueNumber} is In Progress on the board but has no cargo/.tasks/${issueNumber} worktree`,
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

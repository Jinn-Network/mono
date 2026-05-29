import { statSync } from 'node:fs';
import type { CommandRunner } from './issue-source.js';
import type { InFlightReview } from './types.js';

const WORKTREE_PARENT_COMPONENT = 'jinn-mono_worktrees';
const PR_PREFIX = 'pr-';

interface ParsedWorktree { worktreePath: string; branchRef: string | null; }

function parsePorcelain(output: string): ParsedWorktree[] {
  const result: ParsedWorktree[] = [];
  for (const block of output.split(/\n\n+/)) {
    const lines = block.trim().split('\n');
    if (lines.length === 0 || lines[0] === '') continue;
    let worktreePath: string | null = null;
    let branchRef: string | null = null;
    for (const line of lines) {
      if (line.startsWith('worktree ')) worktreePath = line.slice('worktree '.length);
      else if (line.startsWith('branch ')) branchRef = line.slice('branch '.length);
    }
    if (worktreePath != null) result.push({ worktreePath, branchRef });
  }
  return result;
}

/** Extract the PR number from a `jinn-mono_worktrees/pr-<N>` path; null otherwise. */
function extractPrNumber(worktreePath: string): number | null {
  const parts = worktreePath.split('/').filter((p, i) => i > 0 || p !== '');
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === WORKTREE_PARENT_COMPONENT) {
      const candidate = parts[i + 1];
      if (candidate == null || i + 2 !== parts.length) return null;
      if (!candidate.startsWith(PR_PREFIX)) return null;
      const digits = candidate.slice(PR_PREFIX.length);
      const n = parseInt(digits, 10);
      if (isNaN(n) || String(n) !== digits) return null;
      return n;
    }
  }
  return null;
}

function shortBranch(ref: string): string {
  const p = 'refs/heads/';
  return ref.startsWith(p) ? ref.slice(p.length) : ref;
}

function recoverStartedAt(worktreePath: string): number {
  try { const st = statSync(worktreePath); return st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs; }
  catch { return 0; }
}

/**
 * Re-derive in-flight review sessions from `git worktree list` — one
 * InFlightReview per `jinn-mono_worktrees/pr-<N>` worktree. Crash-safe.
 * No drift bucket: review sessions have no board status to cross-check.
 */
export async function deriveReviewInFlight(
  runner: CommandRunner,
): Promise<{ inFlight: InFlightReview[]; drift: string[] }> {
  const raw = await runner('git', ['worktree', 'list', '--porcelain']);
  const inFlight: InFlightReview[] = [];
  for (const wt of parsePorcelain(raw)) {
    const prNumber = extractPrNumber(wt.worktreePath);
    if (prNumber == null) continue;
    inFlight.push({
      prNumber,
      branch: wt.branchRef != null ? shortBranch(wt.branchRef) : '',
      worktreePath: wt.worktreePath,
      pid: null,
      startedAt: recoverStartedAt(wt.worktreePath),
    });
  }
  return { inFlight, drift: [] };
}

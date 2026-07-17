import { statSync } from 'node:fs';
import type { CommandRunner } from './issue-source.js';
import type { InFlightMergePrep } from './types.js';

/**
 * In-flight derivation for merge-prep sessions — the third worktree namespace.
 * Mirrors `review-state.ts` (worktree-only, crash-safe, no board cross-check)
 * with the `merge-<N>` prefix. The namespaces are mutually exclusive:
 * `state.ts` (`<N>`) and `review-state.ts` (`pr-<N>`) both reject `merge-<N>`,
 * and the drift sweep ignores it — so no double-counting across session types.
 */

const WORKTREE_PARENT_COMPONENT = 'jinn-mono_worktrees';
const MERGE_PREFIX = 'merge-';

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

/** Extract the PR number from a `jinn-mono_worktrees/merge-<N>` path; null
 *  otherwise. `merge-<N>` must be the final path component. */
export function extractMergePrepPrNumber(worktreePath: string): number | null {
  const parts = worktreePath.split('/').filter((p, i) => i > 0 || p !== '');
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === WORKTREE_PARENT_COMPONENT) {
      const candidate = parts[i + 1];
      if (candidate == null || i + 2 !== parts.length) return null;
      if (!candidate.startsWith(MERGE_PREFIX)) return null;
      const digits = candidate.slice(MERGE_PREFIX.length);
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
 * Re-derive in-flight merge-prep sessions from `git worktree list` — one
 * InFlightMergePrep per `jinn-mono_worktrees/merge-<N>` worktree. Detached
 * worktrees have no branch ref, so `branch` is typically ''.
 */
export async function deriveMergePrepInFlight(
  runner: CommandRunner,
): Promise<{ inFlight: InFlightMergePrep[] }> {
  const raw = await runner('git', ['worktree', 'list', '--porcelain']);
  const inFlight: InFlightMergePrep[] = [];
  for (const wt of parsePorcelain(raw)) {
    const prNumber = extractMergePrepPrNumber(wt.worktreePath);
    if (prNumber == null) continue;
    inFlight.push({
      prNumber,
      branch: wt.branchRef != null ? shortBranch(wt.branchRef) : '',
      worktreePath: wt.worktreePath,
      pid: null,
      startedAt: recoverStartedAt(wt.worktreePath),
    });
  }
  return { inFlight };
}

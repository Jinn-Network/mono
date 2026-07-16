import type { CommandRunner } from './issue-source.js';
import type { InFlightMergePrep } from './types.js';
import {
  parseWorktreePorcelain,
  extractWorktreeNumber,
  shortBranch,
  recoverStartedAt,
} from './worktree-porcelain.js';

/**
 * In-flight derivation for merge-prep sessions — the third worktree namespace.
 * Mirrors `review-state.ts` (worktree-only, crash-safe, no board cross-check)
 * with the `merge-<N>` prefix. The namespaces are mutually exclusive:
 * `state.ts` (`<N>`) and `review-state.ts` (`pr-<N>`) both reject `merge-<N>`,
 * and the drift sweep ignores it — so no double-counting across session types.
 */

/** Extract the PR number from a `jinn-mono_worktrees/merge-<N>` path; null
 *  otherwise. `merge-<N>` must be the final path component. */
export function extractMergePrepPrNumber(worktreePath: string): number | null {
  return extractWorktreeNumber(worktreePath, 'merge-');
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
  for (const wt of parseWorktreePorcelain(raw)) {
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

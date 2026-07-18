import type { CommandRunner } from './issue-source.js';
import type { InFlightReview } from './types.js';
import {
  makeFileReviewLeaseStore,
  type ReviewLeaseStore,
} from './review-lease.js';
import {
  parseWorktreePorcelain,
  extractWorktreeNumber,
  shortBranch,
} from './worktree-porcelain.js';

/** Extract the PR number from a `jinn-mono_worktrees/pr-<N>` path; null otherwise. */
function extractPrNumber(worktreePath: string): number | null {
  return extractWorktreeNumber(worktreePath, 'pr-');
}

/**
 * Re-derive in-flight review sessions from `git worktree list` — one
 * InFlightReview per `jinn-mono_worktrees/pr-<N>` worktree. Crash-safe.
 * No drift bucket: review sessions have no board status to cross-check.
 */
export async function deriveReviewInFlight(
  runner: CommandRunner,
  leaseStore: ReviewLeaseStore = makeFileReviewLeaseStore(),
): Promise<{ inFlight: InFlightReview[]; drift: string[] }> {
  const raw = await runner('git', ['worktree', 'list', '--porcelain']);
  const inFlight: InFlightReview[] = [];
  for (const wt of parseWorktreePorcelain(raw)) {
    const prNumber = extractPrNumber(wt.worktreePath);
    if (prNumber == null) continue;
    const lease = leaseStore.read(prNumber);
    const ownedLease =
      lease != null && lease.worktreePath === wt.worktreePath
        ? lease
        : null;
    inFlight.push({
      prNumber,
      branch: wt.branchRef != null ? shortBranch(wt.branchRef) : '',
      worktreePath: wt.worktreePath,
      pid: ownedLease?.pid ?? null,
      startedAt: ownedLease?.startedAt ?? 0,
      leaseId: ownedLease?.leaseId ?? null,
    });
  }
  return { inFlight, drift: [] };
}

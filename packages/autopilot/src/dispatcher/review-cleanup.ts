import type { CommandRunner } from './issue-source.js';
import {
  reviewWorktreePath,
  type ReviewLeaseStore,
} from './review-lease.js';

/**
 * Remove one dispatcher-owned review checkout and release its ownership lease.
 *
 * The PR number is the only path input: reconstructing the canonical path here
 * prevents a discovered worktree path from becoming a deletion target. Clean
 * ignored and untracked artifacts before asking Git to unregister the
 * worktree; `git worktree remove --force` can otherwise unregister first and
 * then fail with "Directory not empty", leaving a path collision behind.
 *
 * Each step is fail-safe. A failed clean stops before unregistering, and a
 * failed unregister leaves the lease in place for diagnosis/retry.
 */
export async function cleanupReviewWorktree(
  prNumber: number,
  runner: CommandRunner,
  leaseStore: ReviewLeaseStore,
): Promise<void> {
  const canonicalPath = reviewWorktreePath(prNumber);
  await runner('git', ['-C', canonicalPath, 'clean', '-ffdx']);
  await runner('git', ['worktree', 'remove', '--force', canonicalPath]);
  leaseStore.release(prNumber);
}

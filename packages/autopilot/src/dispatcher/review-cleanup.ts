import { lstatSync, realpathSync } from 'node:fs';
import type { CommandRunner } from './issue-source.js';
import {
  reviewWorktreePath,
  type ReviewLease,
  type ReviewLeaseStore,
} from './review-lease.js';

export interface ReviewCleanupFilesystem {
  lstat(path: string): {
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  };
  realpath(path: string): string;
}

export interface ReviewCleanupOptions {
  worktreesBase?: string;
  filesystem?: ReviewCleanupFilesystem;
}

const defaultFilesystem: ReviewCleanupFilesystem = {
  lstat: (path) => lstatSync(path),
  realpath: (path) => realpathSync(path),
};

const cleanupTails = new Map<number, Promise<void>>();

/**
 * Serialize every operation which can create, reuse, or destroy one pr-N
 * checkout. This is process-local by design: the dispatcher is supervised as
 * a singleton, while persisted lease generations protect restart recovery.
 */
export async function withReviewWorktreeLock<T>(
  prNumber: number,
  operation: () => Promise<T>,
): Promise<T> {
  reviewWorktreePath(prNumber);
  const previous = cleanupTails.get(prNumber) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolve) => { release = resolve; });
  const chain = previous.catch(() => {}).then(() => tail);
  cleanupTails.set(prNumber, chain);
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (cleanupTails.get(prNumber) === chain) cleanupTails.delete(prNumber);
  }
}

function sameLease(current: ReviewLease | null, expected: ReviewLease): boolean {
  return (
    current != null &&
    current.leaseId === expected.leaseId &&
    current.prNumber === expected.prNumber &&
    current.worktreePath === expected.worktreePath &&
    current.pid === expected.pid &&
    current.startedAt === expected.startedAt
  );
}

function assertLease(
  leaseStore: ReviewLeaseStore,
  expected: ReviewLease,
): void {
  if (!sameLease(leaseStore.read(expected.prNumber), expected)) {
    throw new Error(
      `Review cleanup lease no longer matches generation ${expected.leaseId}`,
    );
  }
}

async function assertCanonicalIdentity(
  canonicalPath: string,
  runner: CommandRunner,
  filesystem: ReviewCleanupFilesystem,
): Promise<void> {
  const stat = filesystem.lstat(canonicalPath);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing review cleanup through symlink: ${canonicalPath}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Review cleanup target is not a directory: ${canonicalPath}`);
  }
  const resolved = filesystem.realpath(canonicalPath);
  if (resolved !== canonicalPath) {
    throw new Error(
      `Review cleanup realpath mismatch: expected ${canonicalPath}, got ${resolved}`,
    );
  }

  const worktrees = await runner('git', ['worktree', 'list', '--porcelain']);
  const registered = worktrees
    .split('\n')
    .some((line) => line === `worktree ${canonicalPath}`);
  if (!registered) {
    throw new Error(`Review cleanup target is not a registered worktree: ${canonicalPath}`);
  }

  const topLevel = (
    await runner('git', ['-C', canonicalPath, 'rev-parse', '--show-toplevel'])
  ).trim();
  if (topLevel !== canonicalPath) {
    throw new Error(
      `Review cleanup git top-level mismatch: expected ${canonicalPath}, got ${topLevel}`,
    );
  }
}

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
 *
 * The terminal event belongs to the directly spawned reviewer. A reviewer may
 * leave descendant processes behind; this cleanup does not attempt to discover
 * or kill them. If a descendant still holds files or the checkout, either Git
 * command may fail and the lease deliberately remains for fallback retry or
 * operator diagnosis.
 */
export async function cleanupReviewWorktree(
  expectedLease: ReviewLease,
  runner: CommandRunner,
  leaseStore: ReviewLeaseStore,
  options: ReviewCleanupOptions = {},
): Promise<void> {
  const { worktreesBase, filesystem = defaultFilesystem } = options;
  const canonicalPath = reviewWorktreePath(expectedLease.prNumber, worktreesBase);
  if (expectedLease.worktreePath !== canonicalPath) {
    throw new Error(
      `Review cleanup lease has non-canonical path: ${expectedLease.worktreePath}`,
    );
  }

  return withReviewWorktreeLock(expectedLease.prNumber, async () => {
    assertLease(leaseStore, expectedLease);
    await assertCanonicalIdentity(canonicalPath, runner, filesystem);
    assertLease(leaseStore, expectedLease);
    await runner('git', ['-C', canonicalPath, 'clean', '-ffdx']);

    // Re-prove both generation ownership and filesystem/git identity at the
    // remove seam. A stale callback may have waited behind a newer dispatch.
    assertLease(leaseStore, expectedLease);
    await assertCanonicalIdentity(canonicalPath, runner, filesystem);
    assertLease(leaseStore, expectedLease);
    await runner('git', ['worktree', 'remove', '--force', canonicalPath]);
    if (!leaseStore.releaseIfMatches(expectedLease.prNumber, expectedLease.leaseId)) {
      throw new Error(
        `Review cleanup could not compare-release lease ${expectedLease.leaseId}`,
      );
    }
  });
}

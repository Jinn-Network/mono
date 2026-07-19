import {
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
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
  mkdirExclusive(path: string): void;
  rename(from: string, to: string): void;
  removeNoFollow(path: string): void;
}

export interface ReviewCleanupOptions {
  worktreesBase?: string;
  filesystem?: ReviewCleanupFilesystem;
  quarantineId?: () => string;
}

const defaultFilesystem: ReviewCleanupFilesystem = {
  lstat: (path) => lstatSync(path),
  realpath: (path) => realpathSync(path),
  mkdirExclusive: (path) => mkdirSync(path, { mode: 0o700 }),
  rename: (from, to) => renameSync(from, to),
  removeNoFollow: (path) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      unlinkSync(path);
      return;
    }
    rmSync(path, { recursive: true, force: false });
  },
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
    current.version === expected.version &&
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

async function isRegisteredWorktree(
  canonicalPath: string,
  runner: CommandRunner,
): Promise<boolean> {
  const worktrees = await runner('git', ['worktree', 'list', '--porcelain']);
  return worktrees
    .split('\n')
    .some((line) => line === `worktree ${canonicalPath}`);
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error != null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

/**
 * Remove one dispatcher-owned review checkout and release its ownership lease.
 *
 * The PR number is the only path input: reconstructing the canonical path here
 * prevents a discovered worktree path from becoming a deletion target. Git is
 * always asked to remove the registered worktree first. If Git unregisters it
 * but leaves residue, the top-level canonical entry is atomically renamed into
 * a private quarantine before recursive deletion. Renaming a swapped symlink
 * moves the link itself; the no-follow deletion then unlinks it without
 * traversing its target.
 *
 * Each step is fail-safe. A still-registered or pre-rename quarantine failure
 * leaves the lease in place for retry. A post-rename deletion failure leaves
 * the lease plus isolated quarantine for diagnosis/manual cleanup; the
 * canonical path and review slot are already free.
 *
 * The terminal event belongs to the directly spawned reviewer. A reviewer may
 * leave descendant processes behind; this cleanup does not attempt to discover
 * or kill them. If a descendant still holds files or the checkout, either Git
 * removal or quarantine cleanup may fail and the lease deliberately remains.
 * Failures before quarantine rename are retryable; failures after the rename
 * leave isolated residue for operator diagnosis/manual cleanup.
 */
export async function cleanupReviewWorktree(
  expectedLease: ReviewLease,
  runner: CommandRunner,
  leaseStore: ReviewLeaseStore,
  options: ReviewCleanupOptions = {},
): Promise<void> {
  const {
    worktreesBase,
    filesystem = defaultFilesystem,
    quarantineId = randomUUID,
  } = options;
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
    try {
      await runner('git', ['worktree', 'remove', '--force', canonicalPath]);
    } catch (removeError) {
      if (await isRegisteredWorktree(canonicalPath, runner)) {
        throw removeError;
      }

      // Git has already unregistered the worktree. Do not recurse through the
      // canonical pathname: it may have been swapped since validation. Move
      // the top-level entry itself to a generation-specific quarantine first.
      assertLease(leaseStore, expectedLease);
      try {
        filesystem.lstat(canonicalPath);
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
        if (!leaseStore.releaseIfMatches(
          expectedLease.prNumber,
          expectedLease.leaseId,
        )) {
          throw new Error(
            `Review cleanup could not compare-release lease ${expectedLease.leaseId}`,
          );
        }
        return;
      }

      const suffix = quarantineId();
      if (!/^[A-Za-z0-9-]+$/.test(suffix)) {
        throw new Error('Invalid review quarantine identifier');
      }
      const quarantineRoot = worktreesBase ?? dirname(canonicalPath);
      const quarantinePath = join(
        quarantineRoot,
        `.review-quarantine-pr-${expectedLease.prNumber}-${expectedLease.leaseId}-${suffix}`,
      );
      const quarantinedPath = join(quarantinePath, 'entry');
      filesystem.mkdirExclusive(quarantinePath);
      assertLease(leaseStore, expectedLease);
      filesystem.rename(canonicalPath, quarantinedPath);
      filesystem.removeNoFollow(quarantinedPath);
      filesystem.removeNoFollow(quarantinePath);
    }

    if (!leaseStore.releaseIfMatches(expectedLease.prNumber, expectedLease.leaseId)) {
      throw new Error(
        `Review cleanup could not compare-release lease ${expectedLease.leaseId}`,
      );
    }
  });
}

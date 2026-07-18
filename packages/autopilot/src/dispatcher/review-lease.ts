import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { WORKTREES_BASE } from './dispatch.js';

const LEASE_VERSION = 1;
const LEASE_DIR = '.review-leases';

export interface ReviewLease {
  version: 1;
  prNumber: number;
  worktreePath: string;
  pid: number;
  startedAt: number;
}

export interface ReviewLeaseStore {
  record(lease: ReviewLease): void;
  read(prNumber: number): ReviewLease | null;
  release(prNumber: number): void;
}

function validPrNumber(prNumber: number): boolean {
  return Number.isSafeInteger(prNumber) && prNumber > 0;
}

export function reviewWorktreePath(
  prNumber: number,
  worktreesBase = WORKTREES_BASE,
): string {
  if (!validPrNumber(prNumber)) {
    throw new TypeError('Review PR number must be a positive safe integer');
  }
  return join(worktreesBase, `pr-${prNumber}`);
}

export function reviewLeasePath(worktreesBase: string, prNumber: number): string {
  if (!validPrNumber(prNumber)) {
    throw new TypeError('Review PR number must be a positive safe integer');
  }
  return join(worktreesBase, LEASE_DIR, `pr-${prNumber}.json`);
}

function isValidLease(
  value: unknown,
  expectedPrNumber: number,
  worktreesBase: string,
): value is ReviewLease {
  if (typeof value !== 'object' || value == null) return false;
  const lease = value as Partial<ReviewLease>;
  return (
    lease.version === LEASE_VERSION &&
    lease.prNumber === expectedPrNumber &&
    lease.worktreePath === reviewWorktreePath(expectedPrNumber, worktreesBase) &&
    typeof lease.pid === 'number' &&
    Number.isSafeInteger(lease.pid) &&
    lease.pid > 0 &&
    typeof lease.startedAt === 'number' &&
    Number.isFinite(lease.startedAt) &&
    lease.startedAt > 0
  );
}

export function makeFileReviewLeaseStore(
  worktreesBase = WORKTREES_BASE,
): ReviewLeaseStore {
  return {
    record(lease) {
      if (!isValidLease(lease, lease.prNumber, worktreesBase)) {
        throw new TypeError('Invalid review ownership lease');
      }
      const path = reviewLeasePath(worktreesBase, lease.prNumber);
      mkdirSync(join(worktreesBase, LEASE_DIR), { recursive: true, mode: 0o700 });
      const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(temp, `${JSON.stringify(lease)}\n`, { mode: 0o600 });
      renameSync(temp, path);
    },

    read(prNumber) {
      if (!validPrNumber(prNumber)) return null;
      try {
        const parsed: unknown = JSON.parse(
          readFileSync(reviewLeasePath(worktreesBase, prNumber), 'utf8'),
        );
        return isValidLease(parsed, prNumber, worktreesBase) ? parsed : null;
      } catch {
        return null;
      }
    },

    release(prNumber) {
      if (!validPrNumber(prNumber)) return;
      rmSync(reviewLeasePath(worktreesBase, prNumber), { force: true });
    },
  };
}

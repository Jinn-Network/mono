import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  makeFileReviewLeaseStore,
  reviewLeasePath,
} from '../../src/dispatcher/review-lease.js';
import { cleanupReviewWorktree } from '../../src/dispatcher/review-cleanup.js';
import type { CommandRunner } from '../../src/dispatcher/issue-source.js';

const roots: string[] = [];

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jinn-review-lease-')));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('file review leases', () => {
  it('persists reviewer ownership for recovery after dispatcher restart', () => {
    const root = tempRoot();
    const store = makeFileReviewLeaseStore(root);
    const lease = {
      version: 2 as const,
      leaseId: 'lease-42',
      prNumber: 42,
      worktreePath: join(root, 'pr-42'),
      pid: 4242,
      startedAt: 123_456,
    };

    store.record(lease);

    expect(makeFileReviewLeaseStore(root).read(42)).toEqual(lease);
  });

  it('rejects a lease whose recorded worktree is not the exact canonical pr-N path', () => {
    const root = tempRoot();
    const path = reviewLeasePath(root, 42);
    const store = makeFileReviewLeaseStore(root);
    store.record({
      version: 2,
      leaseId: 'lease-42',
      prNumber: 42,
      worktreePath: join(root, 'pr-42'),
      pid: 4242,
      startedAt: 123_456,
    });
    writeFileSync(path, JSON.stringify({
      version: 2,
      leaseId: 'lease-42',
      prNumber: 42,
      worktreePath: join(root, 'nested', 'pr-42'),
      pid: 4242,
      startedAt: 123_456,
    }));

    expect(store.read(42)).toBeNull();
  });

  it('normalizes a deployed v1 lease into a deterministic, reapable v2 generation', async () => {
    const root = tempRoot();
    const store = makeFileReviewLeaseStore(root);
    mkdirSync(join(root, '.review-leases'));
    writeFileSync(reviewLeasePath(root, 42), JSON.stringify({
      version: 1,
      prNumber: 42,
      worktreePath: join(root, 'pr-42'),
      pid: 4242,
      startedAt: 123_456,
    }));

    const first = store.read(42);
    const second = makeFileReviewLeaseStore(root).read(42);

    expect(first).toMatchObject({
      version: 2,
      prNumber: 42,
      worktreePath: join(root, 'pr-42'),
      pid: 4242,
      startedAt: 123_456,
    });
    expect(first?.leaseId).toMatch(/^legacy-/);
    expect(second).toEqual(first);
    mkdirSync(join(root, 'pr-42'));
    const calls: string[][] = [];
    const runner: CommandRunner = async (_cmd, args) => {
      calls.push(args);
      if (args[0] === 'worktree' && args[1] === 'list') {
        return `worktree ${join(root, 'pr-42')}\nHEAD abc\ndetached\n`;
      }
      if (args[0] === '-C' && args[2] === 'rev-parse') {
        return `${join(root, 'pr-42')}\n`;
      }
      if (args[0] === 'worktree' && args[1] === 'remove') return '';
      throw new Error(`unexpected git ${args.join(' ')}`);
    };

    await cleanupReviewWorktree(first!, runner, store, { worktreesBase: root });

    expect(calls.at(-1)).toEqual([
      'worktree', 'remove', '--force', join(root, 'pr-42'),
    ]);
    expect(store.read(42)).toBeNull();
  });

  it('treats missing, malformed, and malformed legacy leases as unowned', () => {
    const root = tempRoot();
    const store = makeFileReviewLeaseStore(root);
    expect(store.read(42)).toBeNull();

    mkdirSync(join(root, '.review-leases'));
    writeFileSync(reviewLeasePath(root, 42), '{broken');
    expect(store.read(42)).toBeNull();

    writeFileSync(reviewLeasePath(root, 42), JSON.stringify({
      version: 1,
      prNumber: 42,
      worktreePath: join(root, 'pr-42'),
      pid: 0,
      startedAt: 123_456,
    }));
    expect(store.read(42)).toBeNull();

    writeFileSync(reviewLeasePath(root, 42), JSON.stringify({
      version: 1,
      prNumber: 42,
      worktreePath: join(root, 'nested', 'pr-42'),
      pid: 4242,
      startedAt: 123_456,
    }));
    expect(store.read(42)).toBeNull();

    writeFileSync(reviewLeasePath(root, 42), JSON.stringify({
      version: 1,
      leaseId: 'not-a-deployed-v1-shape',
      prNumber: 42,
      worktreePath: join(root, 'pr-42'),
      pid: 4242,
      startedAt: 123_456,
    }));
    expect(store.read(42)).toBeNull();
  });

  it('releases only the matching lease generation', () => {
    const root = tempRoot();
    const store = makeFileReviewLeaseStore(root);
    store.record({
      version: 2,
      leaseId: 'lease-current',
      prNumber: 42,
      worktreePath: join(root, 'pr-42'),
      pid: 4242,
      startedAt: 123_456,
    });

    expect(store.releaseIfMatches(42, 'lease-stale')).toBe(false);
    expect(store.read(42)?.leaseId).toBe('lease-current');
    expect(store.releaseIfMatches(42, 'lease-current')).toBe(true);
    expect(store.releaseIfMatches(42, 'lease-current')).toBe(false);
    expect(store.read(42)).toBeNull();
  });
});

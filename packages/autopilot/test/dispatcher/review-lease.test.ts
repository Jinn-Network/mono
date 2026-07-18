import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  makeFileReviewLeaseStore,
  reviewLeasePath,
} from '../../src/dispatcher/review-lease.js';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'jinn-review-lease-'));
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
      version: 1 as const,
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
      version: 1,
      prNumber: 42,
      worktreePath: join(root, 'pr-42'),
      pid: 4242,
      startedAt: 123_456,
    });
    writeFileSync(path, JSON.stringify({
      version: 1,
      prNumber: 42,
      worktreePath: join(root, 'nested', 'pr-42'),
      pid: 4242,
      startedAt: 123_456,
    }));

    expect(store.read(42)).toBeNull();
  });

  it('treats missing, malformed, and invalid-pid leases as unowned', () => {
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
  });

  it('removes its lease idempotently', () => {
    const root = tempRoot();
    const store = makeFileReviewLeaseStore(root);
    store.record({
      version: 1,
      prNumber: 42,
      worktreePath: join(root, 'pr-42'),
      pid: 4242,
      startedAt: 123_456,
    });

    store.release(42);
    expect(() => store.release(42)).not.toThrow();
    expect(store.read(42)).toBeNull();
  });
});

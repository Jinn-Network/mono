import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cleanupReviewWorktree,
  type ReviewCleanupFilesystem,
} from '../../src/dispatcher/review-cleanup.js';
import type { ReviewLease, ReviewLeaseStore } from '../../src/dispatcher/review-lease.js';
import type { CommandRunner } from '../../src/dispatcher/issue-source.js';

const BASE = '/safe/jinn-mono_worktrees';
const PATH = join(BASE, 'pr-42');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function lease(leaseId = 'lease-current', base = BASE): ReviewLease {
  return {
    version: 2,
    leaseId,
    prNumber: 42,
    worktreePath: join(base, 'pr-42'),
    pid: 4242,
    startedAt: 123_456,
  };
}

function leaseStore(initial: ReviewLease | null = lease()) {
  let current = initial;
  const released: string[] = [];
  const store: ReviewLeaseStore = {
    record: (value) => { current = value; },
    read: () => current,
    releaseIfMatches: (_prNumber, leaseId) => {
      if (current?.leaseId !== leaseId) return false;
      released.push(leaseId);
      current = null;
      return true;
    },
  };
  return { store, released };
}

function filesystem(overrides: Partial<ReviewCleanupFilesystem> = {}) {
  const renamed: Array<[string, string]> = [];
  const removed: string[] = [];
  const reserved: string[] = [];
  const value: ReviewCleanupFilesystem = {
    lstat: () => ({
      isDirectory: () => true,
      isSymbolicLink: () => false,
    }),
    realpath: () => PATH,
    mkdirExclusive: (path) => { reserved.push(path); },
    rename: (from, to) => { renamed.push([from, to]); },
    removeNoFollow: (path) => { removed.push(path); },
    ...overrides,
  };
  return { value, renamed, removed, reserved };
}

function runnerFor(remove: 'success' | 'fail-registered' | 'fail-unregistered') {
  const calls: string[][] = [];
  let removeAttempted = false;
  const runner: CommandRunner = async (cmd, args) => {
    if (cmd !== 'git') throw new Error(`unexpected ${cmd}`);
    calls.push(args);
    if (args[0] === 'worktree' && args[1] === 'list') {
      if (removeAttempted && remove === 'fail-unregistered') return '';
      return `worktree ${PATH}\nHEAD abc\ndetached\n`;
    }
    if (args[0] === '-C' && args[2] === 'rev-parse') return `${PATH}\n`;
    if (args[0] === 'worktree' && args[1] === 'remove') {
      removeAttempted = true;
      if (remove !== 'success') throw new Error('remove failed');
      return '';
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  return { runner, calls };
}

describe('cleanupReviewWorktree security boundary', () => {
  it('uses Git removal first and compare-releases after normal success', async () => {
    const { runner, calls } = runnerFor('success');
    const state = leaseStore();
    const fs = filesystem();

    await cleanupReviewWorktree(lease(), runner, state.store, {
      worktreesBase: BASE,
      filesystem: fs.value,
      quarantineId: () => 'q1',
    });

    expect(calls).toEqual([
      ['worktree', 'list', '--porcelain'],
      ['-C', PATH, 'rev-parse', '--show-toplevel'],
      ['worktree', 'remove', '--force', PATH],
    ]);
    expect(fs.renamed).toEqual([]);
    expect(fs.removed).toEqual([]);
    expect(state.released).toEqual(['lease-current']);
  });

  it('retains the lease and residue when Git fails while still registered', async () => {
    const { runner, calls } = runnerFor('fail-registered');
    const state = leaseStore();
    const fs = filesystem();

    await expect(cleanupReviewWorktree(lease(), runner, state.store, {
      worktreesBase: BASE,
      filesystem: fs.value,
    })).rejects.toThrow('remove failed');

    expect(calls.at(-1)).toEqual(['worktree', 'list', '--porcelain']);
    expect(fs.renamed).toEqual([]);
    expect(fs.removed).toEqual([]);
    expect(state.released).toEqual([]);
  });

  it('quarantines and deletes an unregistered canonical residue before release', async () => {
    const { runner } = runnerFor('fail-unregistered');
    const state = leaseStore();
    const fs = filesystem();

    await cleanupReviewWorktree(lease(), runner, state.store, {
      worktreesBase: BASE,
      filesystem: fs.value,
      quarantineId: () => 'q1',
    });

    const quarantine = join(BASE, '.review-quarantine-pr-42-lease-current-q1');
    const quarantined = join(quarantine, 'entry');
    expect(fs.reserved).toEqual([quarantine]);
    expect(fs.renamed).toEqual([[PATH, quarantined]]);
    expect(fs.removed).toEqual([quarantined, quarantine]);
    expect(state.released).toEqual(['lease-current']);
  });

  it('moves and removes a swapped top-level symlink without touching its target', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'jinn-review-cleanup-')));
    roots.push(base);
    const canonicalPath = join(base, 'pr-42');
    const target = join(base, 'outside-target');
    mkdirSync(canonicalPath);
    mkdirSync(target);
    writeFileSync(join(target, 'keep.txt'), 'safe');
    const state = leaseStore(lease('lease-current', base));
    let removeAttempted = false;
    const runner: CommandRunner = async (_cmd, args) => {
      if (args[0] === 'worktree' && args[1] === 'list') {
        return removeAttempted ? '' : `worktree ${canonicalPath}\nHEAD abc\ndetached\n`;
      }
      if (args[0] === '-C' && args[2] === 'rev-parse') return `${canonicalPath}\n`;
      if (args[0] === 'worktree' && args[1] === 'remove') {
        removeAttempted = true;
        rmSync(canonicalPath, { recursive: true });
        symlinkSync(target, canonicalPath, 'dir');
        throw new Error('Directory not empty');
      }
      throw new Error(`unexpected git ${args.join(' ')}`);
    };

    await cleanupReviewWorktree(
      lease('lease-current', base),
      runner,
      state.store,
      { worktreesBase: base, quarantineId: () => 'q1' },
    );

    expect(() => lstatSync(canonicalPath)).toThrow();
    expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('safe');
    expect(state.released).toEqual(['lease-current']);
  });

  it('retains the lease when quarantine rename fails', async () => {
    const { runner } = runnerFor('fail-unregistered');
    const state = leaseStore();
    const fs = filesystem({
      mkdirExclusive: () => { throw new Error('quarantine collision'); },
    });

    await expect(cleanupReviewWorktree(lease(), runner, state.store, {
      worktreesBase: BASE,
      filesystem: fs.value,
      quarantineId: () => 'collision',
    })).rejects.toThrow('quarantine collision');

    expect(fs.removed).toEqual([]);
    expect(state.released).toEqual([]);
  });

  it('retains the lease when quarantined deletion fails', async () => {
    const { runner } = runnerFor('fail-unregistered');
    const state = leaseStore();
    const fs = filesystem({ removeNoFollow: () => { throw new Error('delete failed'); } });

    await expect(cleanupReviewWorktree(lease(), runner, state.store, {
      worktreesBase: BASE,
      filesystem: fs.value,
      quarantineId: () => 'q1',
    })).rejects.toThrow('delete failed');

    expect(fs.renamed).toHaveLength(1);
    expect(state.released).toEqual([]);
  });

  it('does nothing when the expected lease generation is stale', async () => {
    const { runner, calls } = runnerFor('success');
    const state = leaseStore(lease('lease-new'));

    await expect(cleanupReviewWorktree(
      lease('lease-old'),
      runner,
      state.store,
      { worktreesBase: BASE, filesystem: filesystem().value },
    )).rejects.toThrow(/lease/i);

    expect(calls).toEqual([]);
    expect(state.released).toEqual([]);
  });

  it('serializes duplicate cleanup so only one removes and releases', async () => {
    let finishRemove!: () => void;
    const removeBlocked = new Promise<void>((resolve) => { finishRemove = resolve; });
    const calls: string[][] = [];
    const state = leaseStore();
    const runner: CommandRunner = async (_cmd, args) => {
      calls.push(args);
      if (args[0] === 'worktree' && args[1] === 'list') {
        return `worktree ${PATH}\nHEAD abc\ndetached\n`;
      }
      if (args[0] === '-C' && args[2] === 'rev-parse') return `${PATH}\n`;
      if (args[0] === 'worktree' && args[1] === 'remove') await removeBlocked;
      return '';
    };
    const options = { worktreesBase: BASE, filesystem: filesystem().value };

    const first = cleanupReviewWorktree(lease(), runner, state.store, options);
    await vi.waitFor(() => {
      expect(calls).toContainEqual(['worktree', 'remove', '--force', PATH]);
    });
    const second = cleanupReviewWorktree(lease(), runner, state.store, options);
    expect(calls.filter((args) => args[1] === 'remove')).toHaveLength(1);
    finishRemove();
    await first;
    await expect(second).rejects.toThrow(/lease/i);

    expect(calls.filter((args) => args[1] === 'remove')).toHaveLength(1);
    expect(state.released).toEqual(['lease-current']);
  });
});

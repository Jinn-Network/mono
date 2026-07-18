import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import {
  cleanupReviewWorktree,
  type ReviewCleanupFilesystem,
} from '../../src/dispatcher/review-cleanup.js';
import type {
  ReviewLease,
  ReviewLeaseStore,
} from '../../src/dispatcher/review-lease.js';
import type { CommandRunner } from '../../src/dispatcher/issue-source.js';

const BASE = '/safe/jinn-mono_worktrees';
const PATH = join(BASE, 'pr-42');

function lease(leaseId = 'lease-current'): ReviewLease {
  return {
    version: 1,
    leaseId,
    prNumber: 42,
    worktreePath: PATH,
    pid: 4242,
    startedAt: 123_456,
  };
}

function filesystem(overrides: Partial<ReviewCleanupFilesystem> = {}): ReviewCleanupFilesystem {
  return {
    lstat: () => ({
      isDirectory: () => true,
      isSymbolicLink: () => false,
    }),
    realpath: () => PATH,
    ...overrides,
  };
}

function leaseStore(initial: ReviewLease | null = lease()): {
  store: ReviewLeaseStore;
  released: string[];
  setCurrent(value: ReviewLease | null): void;
} {
  let current = initial;
  const released: string[] = [];
  return {
    store: {
      record: (value) => { current = value; },
      read: () => current,
      releaseIfMatches: (_prNumber, leaseId) => {
        if (current?.leaseId !== leaseId) return false;
        released.push(leaseId);
        current = null;
        return true;
      },
    },
    released,
    setCurrent: (value) => { current = value; },
  };
}

function validRunner(): {
  runner: CommandRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const runner: CommandRunner = async (cmd, args) => {
    if (cmd !== 'git') throw new Error(`unexpected ${cmd}`);
    calls.push(args);
    if (args[0] === 'worktree' && args[1] === 'list') {
      return `worktree ${PATH}\nHEAD abc\ndetached\n`;
    }
    if (args[0] === '-C' && args[2] === 'rev-parse') return `${PATH}\n`;
    return '';
  };
  return { runner, calls };
}

describe('cleanupReviewWorktree security boundary', () => {
  it('proves canonical filesystem and git identity before clean and again before remove', async () => {
    const { runner, calls } = validRunner();
    const state = leaseStore();
    const fs = filesystem();
    const lstat = vi.spyOn(fs, 'lstat');
    const realpath = vi.spyOn(fs, 'realpath');

    await cleanupReviewWorktree(lease(), runner, state.store, {
      worktreesBase: BASE,
      filesystem: fs,
    });

    expect(calls).toEqual([
      ['worktree', 'list', '--porcelain'],
      ['-C', PATH, 'rev-parse', '--show-toplevel'],
      ['-C', PATH, 'clean', '-ffdx'],
      ['worktree', 'list', '--porcelain'],
      ['-C', PATH, 'rev-parse', '--show-toplevel'],
      ['worktree', 'remove', '--force', PATH],
    ]);
    expect(lstat).toHaveBeenCalledTimes(2);
    expect(realpath).toHaveBeenCalledTimes(2);
    expect(state.released).toEqual(['lease-current']);
  });

  it('refuses a symlink before any git command or release', async () => {
    const { runner, calls } = validRunner();
    const state = leaseStore();

    await expect(cleanupReviewWorktree(lease(), runner, state.store, {
      worktreesBase: BASE,
      filesystem: filesystem({
        lstat: () => ({
          isDirectory: () => true,
          isSymbolicLink: () => true,
        }),
      }),
    })).rejects.toThrow(/symlink/i);

    expect(calls).toEqual([]);
    expect(state.released).toEqual([]);
  });

  it('refuses a path whose realpath differs from the canonical pr-N path', async () => {
    const { runner, calls } = validRunner();
    const state = leaseStore();

    await expect(cleanupReviewWorktree(lease(), runner, state.store, {
      worktreesBase: BASE,
      filesystem: filesystem({ realpath: () => '/attacker/repo' }),
    })).rejects.toThrow(/realpath/i);

    expect(calls).toEqual([]);
    expect(state.released).toEqual([]);
  });

  it('refuses an unregistered canonical directory before clean', async () => {
    const { calls } = validRunner();
    const state = leaseStore();
    const runner: CommandRunner = async (cmd, args) => {
      if (cmd !== 'git') throw new Error(`unexpected ${cmd}`);
      calls.push(args);
      if (args[0] === 'worktree' && args[1] === 'list') return '';
      throw new Error('must not continue');
    };

    await expect(cleanupReviewWorktree(lease(), runner, state.store, {
      worktreesBase: BASE,
      filesystem: filesystem(),
    })).rejects.toThrow(/registered/i);

    expect(calls).toEqual([['worktree', 'list', '--porcelain']]);
    expect(state.released).toEqual([]);
  });

  it('refuses a git top-level mismatch before clean', async () => {
    const { calls } = validRunner();
    const state = leaseStore();
    const runner: CommandRunner = async (cmd, args) => {
      if (cmd !== 'git') throw new Error(`unexpected ${cmd}`);
      calls.push(args);
      if (args[0] === 'worktree' && args[1] === 'list') {
        return `worktree ${PATH}\nHEAD abc\ndetached\n`;
      }
      if (args[0] === '-C' && args[2] === 'rev-parse') return '/attacker/repo\n';
      throw new Error('must not continue');
    };

    await expect(cleanupReviewWorktree(lease(), runner, state.store, {
      worktreesBase: BASE,
      filesystem: filesystem(),
    })).rejects.toThrow(/top-level/i);

    expect(calls.at(-1)).toEqual(['-C', PATH, 'rev-parse', '--show-toplevel']);
    expect(state.released).toEqual([]);
  });

  it('does nothing when the expected lease generation is stale', async () => {
    const { runner, calls } = validRunner();
    const state = leaseStore(lease('lease-new'));

    await expect(cleanupReviewWorktree(
      lease('lease-old'),
      runner,
      state.store,
      { worktreesBase: BASE, filesystem: filesystem() },
    )).rejects.toThrow(/lease/i);

    expect(calls).toEqual([]);
    expect(state.released).toEqual([]);
  });

  it('serializes duplicate cleanup and lets only one generation remove', async () => {
    let finishClean!: () => void;
    const cleanBlocked = new Promise<void>((resolve) => { finishClean = resolve; });
    const { calls } = validRunner();
    const state = leaseStore();
    const runner: CommandRunner = async (cmd, args) => {
      if (cmd !== 'git') throw new Error(`unexpected ${cmd}`);
      calls.push(args);
      if (args[0] === 'worktree' && args[1] === 'list') {
        return `worktree ${PATH}\nHEAD abc\ndetached\n`;
      }
      if (args[0] === '-C' && args[2] === 'rev-parse') return `${PATH}\n`;
      if (args[0] === '-C' && args[2] === 'clean') await cleanBlocked;
      return '';
    };

    const first = cleanupReviewWorktree(
      lease(),
      runner,
      state.store,
      { worktreesBase: BASE, filesystem: filesystem() },
    );
    await vi.waitFor(() => {
      expect(calls).toContainEqual(['-C', PATH, 'clean', '-ffdx']);
    });
    const second = cleanupReviewWorktree(
      lease(),
      runner,
      state.store,
      { worktreesBase: BASE, filesystem: filesystem() },
    );

    expect(calls.filter((args) => args[2] === 'clean')).toHaveLength(1);
    finishClean();
    await first;
    await expect(second).rejects.toThrow(/lease/i);
    expect(calls.filter((args) => args[0] === 'worktree' && args[1] === 'remove')).toHaveLength(1);
    expect(state.released).toEqual(['lease-current']);
  });

  it('stops if a newer generation appears before removal', async () => {
    const state = leaseStore();
    const calls: string[][] = [];
    const runner: CommandRunner = async (cmd, args) => {
      if (cmd !== 'git') throw new Error(`unexpected ${cmd}`);
      calls.push(args);
      if (args[0] === 'worktree' && args[1] === 'list') {
        return `worktree ${PATH}\nHEAD abc\ndetached\n`;
      }
      if (args[0] === '-C' && args[2] === 'rev-parse') return `${PATH}\n`;
      if (args[0] === '-C' && args[2] === 'clean') state.setCurrent(lease('lease-new'));
      return '';
    };

    await expect(cleanupReviewWorktree(
      lease(),
      runner,
      state.store,
      { worktreesBase: BASE, filesystem: filesystem() },
    )).rejects.toThrow(/lease/i);

    expect(calls.some((args) => args[0] === 'worktree' && args[1] === 'remove')).toBe(false);
    expect(state.released).toEqual([]);
  });

  it.each([
    { failing: 'clean', expectedRemove: false },
    { failing: 'remove', expectedRemove: true },
  ])('retains the matching lease when $failing fails', async ({ failing, expectedRemove }) => {
    const { calls } = validRunner();
    const state = leaseStore();
    const runner: CommandRunner = async (cmd, args) => {
      if (cmd !== 'git') throw new Error(`unexpected ${cmd}`);
      calls.push(args);
      if (args[0] === 'worktree' && args[1] === 'list') {
        return `worktree ${PATH}\nHEAD abc\ndetached\n`;
      }
      if (args[0] === '-C' && args[2] === 'rev-parse') return `${PATH}\n`;
      if (args[0] === '-C' && args[2] === failing) throw new Error(`${failing} failed`);
      if (args[0] === 'worktree' && args[1] === failing) throw new Error(`${failing} failed`);
      return '';
    };

    await expect(cleanupReviewWorktree(
      lease(),
      runner,
      state.store,
      { worktreesBase: BASE, filesystem: filesystem() },
    )).rejects.toThrow(`${failing} failed`);

    expect(
      calls.some((args) => args[0] === 'worktree' && args[1] === 'remove'),
    ).toBe(expectedRemove);
    expect(state.released).toEqual([]);
  });
});

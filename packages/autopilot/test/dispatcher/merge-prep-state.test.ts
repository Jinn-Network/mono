import { describe, it, expect } from 'vitest';
import {
  extractMergePrepPrNumber,
  deriveMergePrepInFlight,
} from '../../src/dispatcher/merge-prep-state.js';
import type { CommandRunner } from '../../src/dispatcher/issue-source.js';

describe('extractMergePrepPrNumber', () => {
  it('accepts jinn-mono_worktrees/merge-<N>', () => {
    expect(extractMergePrepPrNumber('/home/u/jinn-mono_worktrees/merge-12')).toBe(12);
  });
  it('rejects the pr-<N> (review) and bare <N> (impl) namespaces', () => {
    expect(extractMergePrepPrNumber('/home/u/jinn-mono_worktrees/pr-12')).toBeNull();
    expect(extractMergePrepPrNumber('/home/u/jinn-mono_worktrees/12')).toBeNull();
  });
  it('rejects a nested path and a non-numeric suffix', () => {
    expect(extractMergePrepPrNumber('/home/u/jinn-mono_worktrees/merge-12/sub')).toBeNull();
    expect(extractMergePrepPrNumber('/home/u/jinn-mono_worktrees/merge-abc')).toBeNull();
  });
  it('rejects a foreign path', () => {
    expect(extractMergePrepPrNumber('/home/u/other/merge-12')).toBeNull();
  });
});

describe('deriveMergePrepInFlight', () => {
  it('yields one InFlightMergePrep per merge-<N> worktree, ignoring other namespaces', async () => {
    const porcelain =
      `worktree /repo\nHEAD a\nbranch refs/heads/next\n\n` +
      `worktree /wt/jinn-mono_worktrees/merge-12\nHEAD b\ndetached\n\n` +
      `worktree /wt/jinn-mono_worktrees/pr-99\nHEAD c\nbranch refs/heads/feat/99-x\n\n` +
      `worktree /wt/jinn-mono_worktrees/34\nHEAD d\nbranch refs/heads/feat/34-y\n`;
    const runner: CommandRunner = async () => porcelain;
    const { inFlight } = await deriveMergePrepInFlight(runner);
    expect(inFlight.map((w) => w.prNumber)).toEqual([12]);
    // detached worktree → empty branch
    expect(inFlight[0].branch).toBe('');
    expect(inFlight[0].worktreePath).toBe('/wt/jinn-mono_worktrees/merge-12');
  });

  it('returns empty when no merge-<N> worktree exists', async () => {
    const runner: CommandRunner = async () => `worktree /repo\nHEAD a\nbranch refs/heads/next\n`;
    const { inFlight } = await deriveMergePrepInFlight(runner);
    expect(inFlight).toEqual([]);
  });
});

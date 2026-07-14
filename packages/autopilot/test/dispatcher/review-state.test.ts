import { describe, it, expect } from 'vitest';
import { deriveReviewInFlight } from '../../src/dispatcher/review-state.js';
import type { CommandRunner } from '../../src/dispatcher/issue-source.js';

const PORCELAIN = [
  'worktree /repo/jinn-mono',
  'HEAD aaaa',
  'branch refs/heads/next',
  '',
  'worktree /repo/jinn-mono_worktrees/pr-42',
  'HEAD bbbb',
  'branch refs/heads/feat/42-thing',
  '',
  'worktree /repo/jinn-mono_worktrees/55',
  'HEAD cccc',
  'branch refs/heads/fix/55-bug',
  '',
].join('\n');

describe('deriveReviewInFlight', () => {
  it('returns InFlightReview for each pr-<N> worktree, ignoring issue worktrees', async () => {
    const runner: CommandRunner = async (cmd, args) => {
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'list') return PORCELAIN;
      throw new Error('unexpected');
    };
    const { inFlight } = await deriveReviewInFlight(runner);
    expect(inFlight.map((s) => s.prNumber)).toEqual([42]);
    expect(inFlight[0].branch).toBe('feat/42-thing');
    expect(inFlight[0].worktreePath).toBe('/repo/jinn-mono_worktrees/pr-42');
  });
});

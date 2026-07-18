import { describe, it, expect } from 'vitest';
import { deriveReviewInFlight } from '../../src/dispatcher/review-state.js';
import { reviewWorktreePath } from '../../src/dispatcher/review-lease.js';
import type { ReviewLeaseStore } from '../../src/dispatcher/review-lease.js';
import type { CommandRunner } from '../../src/dispatcher/issue-source.js';

const PORCELAIN = [
  'worktree /repo/jinn-mono',
  'HEAD aaaa',
  'branch refs/heads/next',
  '',
  `worktree ${reviewWorktreePath(42)}`,
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
    expect(inFlight[0].worktreePath).toBe(reviewWorktreePath(42));
  });

  it('recovers reviewer pid and start time from the persisted dispatcher lease', async () => {
    const runner: CommandRunner = async () => PORCELAIN;
    const leaseStore: ReviewLeaseStore = {
      record: () => {},
      releaseIfMatches: () => false,
      read: (prNumber) => prNumber === 42
        ? {
            version: 2,
            leaseId: 'lease-42',
            prNumber,
            worktreePath: reviewWorktreePath(prNumber),
            pid: 4242,
            startedAt: 123_456,
          }
        : null,
    };

    const { inFlight } = await deriveReviewInFlight(runner, leaseStore);

    expect(inFlight[0]).toMatchObject({
      pid: 4242,
      startedAt: 123_456,
      leaseId: 'lease-42',
    });
  });

  it('does not infer ownership or age when no valid dispatcher lease exists', async () => {
    const runner: CommandRunner = async () => PORCELAIN;
    const leaseStore: ReviewLeaseStore = {
      record: () => {},
      releaseIfMatches: () => false,
      read: () => null,
    };

    const { inFlight } = await deriveReviewInFlight(runner, leaseStore);

    expect(inFlight[0]).toMatchObject({
      pid: null,
      startedAt: 0,
      leaseId: null,
    });
  });
});

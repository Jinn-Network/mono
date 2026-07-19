import { describe, expect, it } from 'vitest';
import { makeGitProtocolPort, type GitCommandRunner } from '../../src/lifecycle/git-protocol.js';
import { gitOid, gitRefName } from '../../src/lifecycle/types.js';

const EXPECTED = gitOid('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const PUBLISHED = gitOid('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
const OTHER = gitOid('cccccccccccccccccccccccccccccccccccccccc');

describe('Git protocol port', () => {
  it('claims an exact expected-head branch with a normal fast-forward push', async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const runner: GitCommandRunner = async (command, args) => {
      calls.push({ command, args });
      return '';
    };
    const port = makeGitProtocolPort(runner);

    await expect(port.claimBranch({
      branch: gitRefName('autopilot/42'),
      expectedHead: EXPECTED,
      claimOid: PUBLISHED,
    })).resolves.toEqual({
      status: 'won',
      expected: EXPECTED,
      published: PUBLISHED,
      observed: PUBLISHED,
    });
    expect(calls).toEqual([{
      command: 'git',
      args: ['push', 'origin', `${PUBLISHED}:refs/heads/autopilot/42`],
    }]);
  });

  it('publishes review claims append-only with a normal fast-forward push', async () => {
    const calls: readonly string[][] = [];
    const runner: GitCommandRunner = async (_command, args) => {
      (calls as string[][]).push([...args]);
      return '';
    };
    const port = makeGitProtocolPort(runner, { remote: 'upstream' });

    await expect(port.publishReviewClaim({
      prNumber: 101,
      expectedRecordOid: EXPECTED,
      recordOid: PUBLISHED,
    })).resolves.toMatchObject({ status: 'won', observed: PUBLISHED });
    expect(calls).toEqual([[
      'push',
      'upstream',
      `${PUBLISHED}:refs/jinn-autopilot/review-claims/v1/101`,
    ]]);
  });

  it('publishes merge-prep with an exact force-with-lease and never unconditional force', async () => {
    const calls: readonly string[][] = [];
    const runner: GitCommandRunner = async (_command, args) => {
      (calls as string[][]).push([...args]);
      return '';
    };
    const port = makeGitProtocolPort(runner);

    await port.publishMergePrep({
      branch: gitRefName('autopilot/42'),
      expectedHead: EXPECTED,
      newHead: PUBLISHED,
    });

    expect(calls).toEqual([[
      'push',
      'origin',
      `--force-with-lease=autopilot/42:${EXPECTED}`,
      `${PUBLISHED}:refs/heads/autopilot/42`,
    ]]);
    expect(calls.flat()).not.toContain('--force');
  });

  it('publishes review fixes in one atomic two-ref push', async () => {
    const calls: string[][] = [];
    const runner: GitCommandRunner = async (_command, args) => {
      calls.push([...args]);
      return '';
    };
    const port = makeGitProtocolPort(runner);

    await port.publishReviewFix({
      branch: gitRefName('autopilot/42'),
      expectedHead: EXPECTED,
      newHead: PUBLISHED,
      prNumber: 101,
      expectedRecordOid: EXPECTED,
      recordOid: OTHER,
    });

    expect(calls).toEqual([[
      'push',
      '--atomic',
      'origin',
      `${PUBLISHED}:refs/heads/autopilot/42`,
      `${OTHER}:refs/jinn-autopilot/review-claims/v1/101`,
    ]]);
  });

  it('resolves ambiguous command failure by exact ls-remote readback', async () => {
    const calls: readonly string[][] = [];
    const runner: GitCommandRunner = async (_command, args) => {
      (calls as string[][]).push([...args]);
      if (args[0] === 'push') throw new Error('connection closed after send');
      return `${PUBLISHED}\trefs/heads/autopilot/42\n`;
    };
    const port = makeGitProtocolPort(runner);

    await expect(port.claimBranch({
      branch: gitRefName('autopilot/42'),
      expectedHead: EXPECTED,
      claimOid: PUBLISHED,
    })).resolves.toEqual({
      status: 'already-applied',
      expected: EXPECTED,
      published: PUBLISHED,
      observed: PUBLISHED,
    });
    expect(calls.at(-1)).toEqual([
      'ls-remote',
      'origin',
      'refs/heads/autopilot/42',
    ]);
  });

  it('reports lost or ambiguous with the observed and expected OIDs', async () => {
    const lostPort = makeGitProtocolPort(async (_command, args) => {
      if (args[0] === 'push') throw new Error('rejected');
      return `${OTHER}\trefs/heads/autopilot/42\n`;
    });
    await expect(lostPort.claimBranch({
      branch: gitRefName('autopilot/42'),
      expectedHead: EXPECTED,
      claimOid: PUBLISHED,
    })).resolves.toEqual({
      status: 'lost',
      expected: EXPECTED,
      published: PUBLISHED,
      observed: OTHER,
    });

    const ambiguousPort = makeGitProtocolPort(async () => {
      throw new Error('network unavailable');
    });
    await expect(ambiguousPort.claimBranch({
      branch: gitRefName('autopilot/42'),
      expectedHead: EXPECTED,
      claimOid: PUBLISHED,
    })).resolves.toEqual({
      status: 'ambiguous',
      expected: EXPECTED,
      published: PUBLISHED,
      observed: null,
    });
  });
});

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
      if (args[0] === 'rev-list') return `${PUBLISHED} ${EXPECTED}\n`;
      if (args[0] === 'ls-remote') {
        return `${EXPECTED}\trefs/heads/autopilot/42\n`;
      }
      return '';
    };
    const port = makeGitProtocolPort(runner);

    await expect(port.claimBranch({
      branch: gitRefName('autopilot/42'),
      candidateParent: EXPECTED,
      expectedRemoteHead: EXPECTED,
      claimOid: PUBLISHED,
    })).resolves.toEqual({
      status: 'won',
      expected: EXPECTED,
      published: PUBLISHED,
      observed: PUBLISHED,
    });
    expect(calls).toEqual([
      {
        command: 'git',
        args: ['rev-list', '--parents', '-n', '1', PUBLISHED],
      },
      {
        command: 'git',
        args: ['ls-remote', 'origin', 'refs/heads/autopilot/42'],
      },
      {
        command: 'git',
        args: [
          'push',
          `--force-with-lease=refs/heads/autopilot/42:${EXPECTED}`,
          'origin',
          `${PUBLISHED}:refs/heads/autopilot/42`,
        ],
      },
    ]);
  });

  it('reports an idempotent scalar retry as already applied during preflight', async () => {
    const calls: string[][] = [];
    const runner: GitCommandRunner = async (_command, args) => {
      calls.push([...args]);
      if (args[0] === 'rev-list') return `${PUBLISHED} ${EXPECTED}\n`;
      return `${PUBLISHED}\trefs/heads/autopilot/42\n`;
    };
    const port = makeGitProtocolPort(runner);

    await expect(port.claimBranch({
      branch: gitRefName('autopilot/42'),
      candidateParent: EXPECTED,
      expectedRemoteHead: EXPECTED,
      claimOid: PUBLISHED,
    })).resolves.toEqual({
      status: 'already-applied',
      expected: EXPECTED,
      published: PUBLISHED,
      observed: PUBLISHED,
    });
    expect(calls).toEqual([
      ['rev-list', '--parents', '-n', '1', PUBLISHED],
      ['ls-remote', 'origin', 'refs/heads/autopilot/42'],
    ]);
  });

  it('publishes review claims append-only with a normal fast-forward push', async () => {
    const calls: readonly string[][] = [];
    const runner: GitCommandRunner = async (_command, args) => {
      (calls as string[][]).push([...args]);
      if (args[0] === 'rev-list') return `${PUBLISHED} ${EXPECTED}\n`;
      if (args[0] === 'ls-remote') {
        return `${EXPECTED}\trefs/jinn-autopilot/review-claims/v1/101\n`;
      }
      return '';
    };
    const port = makeGitProtocolPort(runner, { remote: 'upstream' });

    await expect(port.publishReviewClaim({
      prNumber: 101,
      recordParent: EXPECTED,
      expectedRemoteRecordOid: EXPECTED,
      recordOid: PUBLISHED,
    })).resolves.toMatchObject({ status: 'won', observed: PUBLISHED });
    expect(calls).toEqual([
      ['rev-list', '--parents', '-n', '1', PUBLISHED],
      ['ls-remote', 'upstream', 'refs/jinn-autopilot/review-claims/v1/101'],
      [
        'push',
        `--force-with-lease=refs/jinn-autopilot/review-claims/v1/101:${EXPECTED}`,
        'upstream',
        `${PUBLISHED}:refs/jinn-autopilot/review-claims/v1/101`,
      ],
    ]);
  });

  it('keeps the review record parent and remote lease explicit', async () => {
    const calls: string[][] = [];
    const runner: GitCommandRunner = async (_command, args) => {
      calls.push([...args]);
      if (args[0] === 'rev-list') return `${PUBLISHED} ${EXPECTED}\n`;
      if (args[0] === 'ls-remote') {
        return `${EXPECTED}\trefs/jinn-autopilot/review-claims/v1/101\n`;
      }
      return '';
    };
    const port = makeGitProtocolPort(runner);

    await expect(port.publishReviewClaim({
      prNumber: 101,
      recordParent: EXPECTED,
      expectedRemoteRecordOid: EXPECTED,
      recordOid: PUBLISHED,
    })).resolves.toMatchObject({ status: 'won', observed: PUBLISHED });
    expect(calls).toEqual([
      ['rev-list', '--parents', '-n', '1', PUBLISHED],
      ['ls-remote', 'origin', 'refs/jinn-autopilot/review-claims/v1/101'],
      [
        'push',
        `--force-with-lease=refs/jinn-autopilot/review-claims/v1/101:${EXPECTED}`,
        'origin',
        `${PUBLISHED}:refs/jinn-autopilot/review-claims/v1/101`,
      ],
    ]);
  });

  it('fences creation of an absent review ref with an empty exact lease', async () => {
    const calls: string[][] = [];
    const runner: GitCommandRunner = async (_command, args) => {
      calls.push([...args]);
      if (args[0] === 'rev-list') return `${PUBLISHED}\n`;
      return '';
    };
    const port = makeGitProtocolPort(runner);

    await expect(port.publishReviewClaim({
      prNumber: 101,
      recordParent: null,
      expectedRemoteRecordOid: null,
      recordOid: PUBLISHED,
    })).resolves.toMatchObject({ status: 'won', observed: PUBLISHED });
    expect(calls).toEqual([
      ['rev-list', '--parents', '-n', '1', PUBLISHED],
      ['ls-remote', 'origin', 'refs/jinn-autopilot/review-claims/v1/101'],
      [
        'push',
        '--force-with-lease=refs/jinn-autopilot/review-claims/v1/101:',
        'origin',
        `${PUBLISHED}:refs/jinn-autopilot/review-claims/v1/101`,
      ],
    ]);
  });

  it('rejects a candidate whose Git parent is not the supplied expected OID', async () => {
    const calls: string[][] = [];
    const port = makeGitProtocolPort(async (_command, args) => {
      calls.push([...args]);
      return `${PUBLISHED} ${OTHER}\n`;
    });

    await expect(port.claimBranch({
      branch: gitRefName('autopilot/42'),
      candidateParent: EXPECTED,
      expectedRemoteHead: EXPECTED,
      claimOid: PUBLISHED,
    })).rejects.toThrow(/expected parent/i);
    expect(calls).toEqual([
      ['rev-list', '--parents', '-n', '1', PUBLISHED],
    ]);
  });

  it('publishes merge-prep with an exact force-with-lease and never unconditional force', async () => {
    const calls: readonly string[][] = [];
    const runner: GitCommandRunner = async (_command, args) => {
      (calls as string[][]).push([...args]);
      if (args[0] === 'rev-list') return `${PUBLISHED} ${EXPECTED}\n`;
      if (args[0] === 'ls-remote') {
        return `${EXPECTED}\trefs/heads/autopilot/42\n`;
      }
      return '';
    };
    const port = makeGitProtocolPort(runner);

    await port.publishMergePrep({
      branch: gitRefName('autopilot/42'),
      expectedRemoteHead: EXPECTED,
      newHead: PUBLISHED,
    });

    expect(calls).toEqual([
      ['ls-remote', 'origin', 'refs/heads/autopilot/42'],
      [
        'push',
        `--force-with-lease=refs/heads/autopilot/42:${EXPECTED}`,
        'origin',
        `${PUBLISHED}:refs/heads/autopilot/42`,
      ],
    ]);
    expect(calls.flat()).not.toContain('--force');
  });

  it('publishes review fixes in one atomic two-ref push', async () => {
    const calls: string[][] = [];
    const runner: GitCommandRunner = async (_command, args) => {
      calls.push([...args]);
      if (args[0] === 'rev-list') {
        return args.at(-1) === PUBLISHED
          ? `${PUBLISHED} ${EXPECTED}\n`
          : `${OTHER} ${EXPECTED}\n`;
      }
      if (args[0] === 'ls-remote') {
        const ref = args.at(-1);
        return ref === 'refs/heads/autopilot/42'
          ? `${EXPECTED}\t${ref}\n`
          : `${EXPECTED}\t${ref}\n`;
      }
      return '';
    };
    const port = makeGitProtocolPort(runner);

    await port.publishReviewFix({
      branch: gitRefName('autopilot/42'),
      newHeadParent: EXPECTED,
      expectedRemoteHead: EXPECTED,
      newHead: PUBLISHED,
      prNumber: 101,
      recordParent: EXPECTED,
      expectedRemoteRecordOid: EXPECTED,
      recordOid: OTHER,
    });

    expect(calls).toEqual([
      ['rev-list', '--parents', '-n', '1', PUBLISHED],
      ['rev-list', '--parents', '-n', '1', OTHER],
      ['ls-remote', 'origin', 'refs/heads/autopilot/42'],
      ['ls-remote', 'origin', 'refs/jinn-autopilot/review-claims/v1/101'],
      [
        'push',
        '--atomic',
        `--force-with-lease=refs/heads/autopilot/42:${EXPECTED}`,
        `--force-with-lease=refs/jinn-autopilot/review-claims/v1/101:${EXPECTED}`,
        'origin',
        `${PUBLISHED}:refs/heads/autopilot/42`,
        `${OTHER}:refs/jinn-autopilot/review-claims/v1/101`,
      ],
    ]);
  });

  it('keeps both review-fix candidate parents and remote leases explicit', async () => {
    const calls: string[][] = [];
    const runner: GitCommandRunner = async (_command, args) => {
      calls.push([...args]);
      if (args[0] === 'rev-list') {
        return args.at(-1) === PUBLISHED
          ? `${PUBLISHED} ${EXPECTED}\n`
          : `${OTHER} ${EXPECTED}\n`;
      }
      if (args[0] === 'ls-remote') {
        const ref = args.at(-1);
        return `${EXPECTED}\t${ref}\n`;
      }
      return '';
    };
    const port = makeGitProtocolPort(runner);

    await expect(port.publishReviewFix({
      branch: gitRefName('autopilot/42'),
      newHeadParent: EXPECTED,
      expectedRemoteHead: EXPECTED,
      newHead: PUBLISHED,
      prNumber: 101,
      recordParent: EXPECTED,
      expectedRemoteRecordOid: EXPECTED,
      recordOid: OTHER,
    })).resolves.toMatchObject({ status: 'won' });
    expect(calls.at(-1)).toEqual([
      'push',
      '--atomic',
      `--force-with-lease=refs/heads/autopilot/42:${EXPECTED}`,
      `--force-with-lease=refs/jinn-autopilot/review-claims/v1/101:${EXPECTED}`,
      'origin',
      `${PUBLISHED}:refs/heads/autopilot/42`,
      `${OTHER}:refs/jinn-autopilot/review-claims/v1/101`,
    ]);
  });

  it('reports an idempotent atomic review-fix retry as already applied during preflight', async () => {
    const calls: string[][] = [];
    const runner: GitCommandRunner = async (_command, args) => {
      calls.push([...args]);
      if (args[0] === 'rev-list') {
        return args.at(-1) === PUBLISHED
          ? `${PUBLISHED} ${EXPECTED}\n`
          : `${OTHER} ${EXPECTED}\n`;
      }
      const ref = args.at(-1);
      const observed = ref === 'refs/heads/autopilot/42' ? PUBLISHED : OTHER;
      return `${observed}\t${ref}\n`;
    };
    const port = makeGitProtocolPort(runner);

    await expect(port.publishReviewFix({
      branch: gitRefName('autopilot/42'),
      newHeadParent: EXPECTED,
      expectedRemoteHead: EXPECTED,
      newHead: PUBLISHED,
      prNumber: 101,
      recordParent: EXPECTED,
      expectedRemoteRecordOid: EXPECTED,
      recordOid: OTHER,
    })).resolves.toEqual({
      status: 'already-applied',
      expected: { branch: EXPECTED, review: EXPECTED },
      published: { branch: PUBLISHED, review: OTHER },
      observed: { branch: PUBLISHED, review: OTHER },
    });
    expect(calls).toEqual([
      ['rev-list', '--parents', '-n', '1', PUBLISHED],
      ['rev-list', '--parents', '-n', '1', OTHER],
      ['ls-remote', 'origin', 'refs/heads/autopilot/42'],
      ['ls-remote', 'origin', 'refs/jinn-autopilot/review-claims/v1/101'],
    ]);
  });

  it('resolves ambiguous command failure by exact ls-remote readback', async () => {
    const calls: readonly string[][] = [];
    let pushed = false;
    const runner: GitCommandRunner = async (_command, args) => {
      (calls as string[][]).push([...args]);
      if (args[0] === 'rev-list') return `${PUBLISHED} ${EXPECTED}\n`;
      if (args[0] === 'push') {
        pushed = true;
        throw new Error('connection closed after send');
      }
      return `${pushed ? PUBLISHED : EXPECTED}\trefs/heads/autopilot/42\n`;
    };
    const port = makeGitProtocolPort(runner);

    await expect(port.claimBranch({
      branch: gitRefName('autopilot/42'),
      candidateParent: EXPECTED,
      expectedRemoteHead: EXPECTED,
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
    let lostPortPushStarted = false;
    const lostPort = makeGitProtocolPort(async (_command, args) => {
      if (args[0] === 'rev-list') return `${PUBLISHED} ${EXPECTED}\n`;
      if (args[0] === 'push') {
        lostPortPushStarted = true;
        throw new Error('rejected');
      }
      const oid = args[0] === 'ls-remote' && lostPortPushStarted ? OTHER : EXPECTED;
      return `${oid}\trefs/heads/autopilot/42\n`;
    });
    await expect(lostPort.claimBranch({
      branch: gitRefName('autopilot/42'),
      candidateParent: EXPECTED,
      expectedRemoteHead: EXPECTED,
      claimOid: PUBLISHED,
    })).resolves.toEqual({
      status: 'lost',
      expected: EXPECTED,
      published: PUBLISHED,
      observed: OTHER,
    });

    const ambiguousPort = makeGitProtocolPort(async (_command, args) => {
      if (args[0] === 'rev-list') return `${PUBLISHED} ${EXPECTED}\n`;
      throw new Error('network unavailable');
    });
    await expect(ambiguousPort.claimBranch({
      branch: gitRefName('autopilot/42'),
      candidateParent: EXPECTED,
      expectedRemoteHead: EXPECTED,
      claimOid: PUBLISHED,
    })).resolves.toEqual({
      status: 'ambiguous',
      expected: EXPECTED,
      published: PUBLISHED,
      observed: null,
    });
  });
});

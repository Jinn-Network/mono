// @ts-nocheck — Stage 5: deleted merge-prep/review-fix/project-status fixtures.
import { describe, expect, it } from 'vitest';
import { makeGitProtocolPort, type GitCommandRunner } from '../../src/lifecycle/git-protocol.js';
import { gitOid, gitRefName } from '../../src/lifecycle/types.js';

const EXPECTED = gitOid('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const PUBLISHED = gitOid('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
const OTHER = gitOid('cccccccccccccccccccccccccccccccccccccccc');
const FOREIGN = gitOid('dddddddddddddddddddddddddddddddddddddddd');

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

  it('rejects contradictory existing-branch claim parents before invoking Git', async () => {
    const calls: string[][] = [];
    const port = makeGitProtocolPort(async (_command, args) => {
      calls.push([...args]);
      return '';
    });

    await expect(port.claimBranch({
      branch: gitRefName('autopilot/42'),
      candidateParent: OTHER,
      expectedRemoteHead: EXPECTED,
      claimOid: PUBLISHED,
    })).rejects.toThrow(/candidate parent.*expected remote head/i);
    expect(calls).toEqual([]);
  });

  it('rejects contradictory review-record parents before invoking Git', async () => {
    const calls: string[][] = [];
    const port = makeGitProtocolPort(async (_command, args) => {
      calls.push([...args]);
      return '';
    });

    await expect(port.publishReviewClaim({
      prNumber: 101,
      recordParent: null,
      expectedRemoteRecordOid: EXPECTED,
      recordOid: PUBLISHED,
    })).rejects.toThrow(/record parent.*expected remote record/i);
    expect(calls).toEqual([]);
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

  it('reclassifies a failed push with an unchanged ref as ambiguous, not lost', async () => {
    // jinn-mono#1925: a failed push whose readback shows the ref exactly
    // where it started (nobody else won the exact-lease race) means our
    // own push simply failed -- that is retryable, not a loss.
    const calls: string[][] = [];
    const port = makeGitProtocolPort(async (_command, args) => {
      calls.push([...args]);
      if (args[0] === 'rev-list') return `${PUBLISHED} ${EXPECTED}\n`;
      if (args[0] === 'push') throw new Error('connection reset');
      return `${EXPECTED}\trefs/heads/autopilot/42\n`;
    });

    await expect(port.claimBranch({
      branch: gitRefName('autopilot/42'),
      candidateParent: EXPECTED,
      expectedRemoteHead: EXPECTED,
      claimOid: PUBLISHED,
    })).resolves.toEqual({
      status: 'ambiguous',
      expected: EXPECTED,
      published: PUBLISHED,
      observed: EXPECTED,
    });
    expect(calls.filter((call) => call[0] === 'push')).toHaveLength(1);
  });

  it('keeps a failed push with a foreign readback a genuine loss', async () => {
    let pushed = false;
    const port = makeGitProtocolPort(async (_command, args) => {
      if (args[0] === 'rev-list') return `${PUBLISHED} ${EXPECTED}\n`;
      if (args[0] === 'push') {
        pushed = true;
        throw new Error('rejected');
      }
      return `${pushed ? OTHER : EXPECTED}\trefs/heads/autopilot/42\n`;
    });

    await expect(port.claimBranch({
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
  });

});

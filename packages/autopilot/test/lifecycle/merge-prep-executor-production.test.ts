import { describe, expect, it } from 'vitest';
import { CredentialPool, selectCredential } from '../../src/lifecycle/credentials.js';
import {
  makeProductionMergePrepActionPort,
} from '../../src/lifecycle/merge-prep-executor-production.js';
import {
  gitOid,
  gitRefName,
  type BranchClaim,
} from '../../src/lifecycle/types.js';

const HEAD = gitOid('1'.repeat(40));
const TREE = gitOid('2'.repeat(40));
const CLAIM = gitOid('3'.repeat(40));
const ATTEMPT = '11111111-1111-4111-8111-111111111111';

describe('production merge-prep acquisition port', () => {
  it('creates and publishes the exact selected-identity claim through canonical HTTPS lease', async () => {
    const calls: Array<{ args: string[]; env?: Record<string, string> }> = [];
    let remote = HEAD;
    const port = makeProductionMergePrepActionPort({
      repositoryPath: '/repo',
      worktreeBase: '/attempts',
      runnerId: 'runner-a',
      readSnapshot: async () => {
        throw new Error('unused');
      },
      environment: { GITHUB_TOKEN: 'ambient-secret' },
      runner: async (command, args, options) => {
        expect(command).toBe('git');
        calls.push({ args, env: options?.env });
        if (args.includes('rev-parse')) return `${TREE}\n`;
        if (args.includes('commit-tree')) return `${CLAIM}\n`;
        if (args.includes('rev-list')) return `${CLAIM} ${HEAD}\n`;
        if (args.includes('ls-remote')) {
          return `${remote}\trefs/heads/autopilot/42\n`;
        }
        if (args.includes('push')) {
          remote = CLAIM;
          return '';
        }
        throw new Error(`unexpected ${args.join(' ')}`);
      },
    });
    const selection = selectCredential(new CredentialPool([{
      login: 'implementation-bot',
      normalizedLogin: 'implementation-bot',
      implementationToken: 'selected-secret',
    }]), { phase: 'merge-prep' });
    if (selection.status !== 'selected') throw new Error('selection failed');
    const claim: BranchClaim & {
      readonly phase: 'merge-prep';
      readonly targetBaseOid: typeof HEAD;
    } = {
      kind: 'branch-claim',
      protocolVersion: 2,
      phase: 'merge-prep',
      issueNumber: 42,
      prNumber: 84,
      attempt: ATTEMPT,
      runner: 'runner-a',
      login: selection.login,
      expectedHead: HEAD,
      targetBase: gitRefName('next'),
      targetBaseOid: HEAD,
      claimedAt: '2026-07-20T12:00:00.000Z',
    };

    await expect(port.createClaimCommit({
      claim,
      parent: HEAD,
      credential: selection.credential,
    })).resolves.toBe(CLAIM);
    await expect(port.claimBranch({
      branch: gitRefName('autopilot/42'),
      expectedRemoteHead: HEAD,
      claimOid: CLAIM,
      remoteUrl: 'https://github.com/Jinn-Network/mono.git',
      credential: selection.credential,
    })).resolves.toMatchObject({ status: 'won', observed: CLAIM });

    const push = calls.find((call) => call.args.includes('push'));
    expect(push?.args).toContain(
      `--force-with-lease=refs/heads/autopilot/42:${HEAD}`,
    );
    expect(push?.args).toContain('https://github.com/Jinn-Network/mono.git');
    expect(calls.every((call) => call.env?.GH_TOKEN === 'selected-secret')).toBe(true);
    expect(calls.every((call) => call.env?.GITHUB_TOKEN === '')).toBe(true);
  });
});

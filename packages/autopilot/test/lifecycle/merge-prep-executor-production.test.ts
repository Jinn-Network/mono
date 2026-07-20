import { describe, expect, it } from 'vitest';
import { CredentialPool, selectCredential } from '../../src/lifecycle/credentials.js';
import {
  makeProductionMergePrepActionPort,
} from '../../src/lifecycle/merge-prep-executor-production.js';
import type { GitHubLifecycleSnapshot } from '../../src/lifecycle/snapshot.js';
import {
  gitOid,
  gitRefName,
  type BranchClaim,
} from '../../src/lifecycle/types.js';

const HEAD = gitOid('1'.repeat(40));
const TREE = gitOid('2'.repeat(40));
const CLAIM = gitOid('3'.repeat(40));
const ATTEMPT = '11111111-1111-4111-8111-111111111111';
const BASE = gitOid('4'.repeat(40));

function candidateSnapshot(): GitHubLifecycleSnapshot {
  return {
    pullRequests: [{
      number: 84,
      title: 'Prep me',
      body: '<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->',
      author: 'implementation-bot',
      baseRefName: 'next',
      headRefName: 'autopilot/42',
      headOid: HEAD,
      headCommittedAt: '2026-07-20T08:00:00.000Z',
      isDraft: false,
      state: 'OPEN',
      labels: ['engine:review'],
      closingIssueNumbers: [42],
      mergeability: 'CONFLICTING',
      mergeStateStatus: 'DIRTY',
      checks: [],
      reviews: [],
    }],
    lifecycle: {
      items: [{
        kind: 'pull-request',
        issueNumber: 42,
        prNumber: 84,
        v2Marked: true,
        projectStatus: 'In Review',
        labels: ['engine:review'],
        head: HEAD,
        headChangedAt: '2026-07-20T08:00:00.000Z',
        isDraft: false,
        merged: false,
        needsReview: false,
        approved: true,
        mergeState: 'conflict',
        reviewClaim: {
          version: 1,
          prNumber: 84,
          issueNumber: 42,
          head: HEAD,
          generation: '22222222-2222-4222-8222-222222222222',
          reviewer: 'review-bot',
          runner: 'runner-b',
          startedAt: '2026-07-20T08:00:00.000Z',
          state: 'terminal-approved',
          verdict: {
            state: 'APPROVE',
            head: HEAD,
            marker: 'approved',
            submittedAt: '2026-07-20T09:00:00.000Z',
          },
        },
        terminalVerdict: {
          reviewer: 'review-bot',
          state: 'APPROVE',
          head: HEAD,
          marker: 'approved',
          submittedAt: '2026-07-20T09:00:00.000Z',
        },
      }],
    },
    diagnostics: [],
  } as unknown as GitHubLifecycleSnapshot;
}

describe('production merge-prep acquisition port', () => {
  it('binds the exact PR base OID and fails closed on incomplete changed files', async () => {
    const endpoints: string[] = [];
    const port = makeProductionMergePrepActionPort({
      repositoryPath: '/repo',
      worktreeBase: '/attempts',
      runnerId: 'runner-a',
      readSnapshot: async () => candidateSnapshot(),
      runner: async (command, args) => {
        expect(command).toBe('gh');
        const endpoint = args.find((arg) => arg.startsWith('repos/'));
        if (endpoint !== undefined) endpoints.push(endpoint);
        if (endpoint === 'repos/Jinn-Network/mono/pulls/84') {
          return JSON.stringify({
            changed_files: 2,
            head: { sha: HEAD },
            base: { ref: 'next', sha: BASE },
          });
        }
        if (endpoint?.startsWith('repos/Jinn-Network/mono/pulls/84/files?')) {
          return JSON.stringify([[{ filename: 'src/visible.ts' }]]);
        }
        if (endpoint === `repos/Jinn-Network/mono/contents/.github/CODEOWNERS?ref=${BASE}`) {
          return JSON.stringify({
            content: Buffer.from('# no owned paths\n').toString('base64'),
          });
        }
        throw new Error(`unexpected ${args.join(' ')}`);
      },
    });

    await expect(port.readCandidate(84)).resolves.toMatchObject({
      targetBaseOid: BASE,
      changedFilesComplete: false,
      codeownerSensitive: false,
    });
    expect(endpoints).not.toContain(
      'repos/Jinn-Network/mono/git/ref/heads/next',
    );
  });

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

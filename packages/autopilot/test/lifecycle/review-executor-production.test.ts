import { describe, expect, it } from 'vitest';
import { CredentialPool } from '../../src/lifecycle/credentials.js';
import {
  makeProductionReviewActionPort,
} from '../../src/lifecycle/review-executor-production.js';
import type { GitHubLifecycleSnapshot } from '../../src/lifecycle/snapshot.js';
import { gitOid, gitRefName } from '../../src/lifecycle/types.js';

const HEAD = gitOid('1'.repeat(40));
const REVIEW = gitOid('2'.repeat(40));
const RECORD = gitOid('3'.repeat(40));
const GENERATION = '11111111-1111-4111-8111-111111111111';
const ATTEMPT = '22222222-2222-4222-8222-222222222222';

function snapshot(): GitHubLifecycleSnapshot {
  const reviewRecord = {
    kind: 'review-claim' as const,
    protocolVersion: 2 as const,
    prNumber: 84,
    generation: GENERATION,
    attempt: ATTEMPT,
    reviewer: 'review-bot',
    head: HEAD,
    state: 'active' as const,
    recordedAt: '2026-07-20T08:00:00.000Z',
  };
  return {
    capturedAt: '2026-07-20T12:00:00.000Z',
    project: {
      rateLimit: { remaining: 5000, used: 1, resetAt: '2026-07-20T13:00:00.000Z' },
      currentSprintIterationId: null,
      items: [],
    },
    issues: [],
    branches: [],
    diagnostics: [],
    pullRequests: [{
      number: 84,
      title: 'Review me',
      body: 'Closes #42\n\n<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->',
      author: 'implementation-bot',
      baseRefName: 'next',
      headRefName: 'autopilot/42',
      headOid: HEAD,
      headCommittedAt: '2026-07-20T08:00:00.000Z',
      isDraft: false,
      state: 'OPEN',
      labels: ['engine:review'],
      closingIssueNumbers: [42],
      mergeability: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      checks: [],
      reviews: [],
      reviewClaim: { oid: REVIEW, record: reviewRecord },
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
        needsReview: true,
        approved: false,
        mergeState: 'clean',
        reviewClaim: reviewRecord,
      }],
    },
  };
}

function pool(): CredentialPool {
  return new CredentialPool([{
    login: 'review-bot',
    normalizedLogin: 'review-bot',
    reviewToken: 'selected-secret',
  }]);
}

function projectSnapshot(status: 'Todo' | 'In Review' | 'Human'): string {
  return JSON.stringify({
    data: {
      rateLimit: {
        remaining: 4999,
        used: 1,
        resetAt: '2026-07-20T13:00:00.000Z',
      },
      organization: {
        projectV2: {
          sprintField: null,
          items: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{
              id: 'PVTI_issue_42',
              content: {
                __typename: 'Issue',
                number: 42,
                issueType: { name: 'feat' },
                blockedBy: { nodes: [] },
              },
              status: { name: status },
              priority: { name: 'P1' },
              effort: { name: 'High' },
              blockedOn: { name: 'Nothing' },
              sprint: null,
            }],
          },
        },
      },
    },
  });
}

function projectFields(): string {
  return JSON.stringify({
    fields: [
      {
        id: 'status-field',
        name: 'Status',
        options: [
          { id: 'todo', name: 'Todo' },
          { id: 'in-progress', name: 'In Progress' },
          { id: 'human', name: 'Human' },
          { id: 'in-review', name: 'In Review' },
          { id: 'done', name: 'Done' },
        ],
      },
      {
        id: 'blocked-field',
        name: 'Blocked on',
        options: [
          { id: 'nothing', name: 'Nothing' },
          { id: 'human-blocked', name: 'Human' },
          { id: 'another-issue', name: 'Another issue' },
        ],
      },
    ],
  });
}

describe('production review acquisition port', () => {
  it('re-reads exact GitHub lifecycle evidence and derives CODEOWNER policy', async () => {
    const port = makeProductionReviewActionPort({
      repositoryPath: '/repo',
      worktreeBase: '/worktrees',
      runnerId: 'runner-a',
      readSnapshot: async () => snapshot(),
      changedFiles: async () => ['client/src/dashboard/spa/src/pages/Home.tsx'],
      codeownersText: () =>
        '/client/src/dashboard/spa/src/pages/ @Jinn-Network/codeowners\n',
      runner: async () => '',
    });

    await expect(port.readCandidate(84)).resolves.toMatchObject({
      issueNumber: 42,
      number: 84,
      head: HEAD,
      headRefName: 'autopilot/42',
      baseRefName: 'next',
      author: 'implementation-bot',
      approvalPolicy: 'human-codeowner',
      reviewRef: { oid: REVIEW },
    });
  });

  it('publishes review claims with the selected HTTPS credential and no ambient token', async () => {
    const calls: Array<{ args: string[]; env?: Record<string, string> }> = [];
    const port = makeProductionReviewActionPort({
      repositoryPath: '/repo',
      worktreeBase: '/worktrees',
      runnerId: 'runner-a',
      readSnapshot: async () => snapshot(),
      changedFiles: async () => [],
      codeownersText: () => '',
      environment: { GITHUB_TOKEN: 'ambient-secret' },
      runner: async (cmd, args, options) => {
        expect(cmd).toBe('git');
        calls.push({ args, env: options?.env });
        if (args.includes('rev-list')) return `${RECORD} ${REVIEW}\n`;
        if (args.includes('ls-remote')) {
          return `${REVIEW}\trefs/jinn-autopilot/review-claims/v1/84\n`;
        }
        if (args.includes('push')) return '';
        return '';
      },
    });
    const selection = pool().select({
      phase: 'review',
      prAuthor: 'implementation-bot',
    });
    if (selection.status !== 'selected') throw new Error('fixture selection failed');

    await expect(port.publishReviewClaim({
      prNumber: 84,
      recordParent: REVIEW,
      expectedRemoteRecordOid: REVIEW,
      recordOid: RECORD,
      credential: selection.credential,
    })).resolves.toMatchObject({ status: 'won', observed: RECORD });

    const push = calls.find((call) => call.args.includes('push'));
    expect(push?.args).toContain('https://github.com/Jinn-Network/mono.git');
    expect(push?.env).toMatchObject({ GH_TOKEN: 'selected-secret' });
    expect(push?.env?.GITHUB_TOKEN).toBe('');
    expect(push?.args.join(' ')).not.toContain('selected-secret');
  });

  it('creates review attempts bound to generation, ref OID, and approval policy', async () => {
    const creates: unknown[] = [];
    const port = makeProductionReviewActionPort({
      repositoryPath: '/repo',
      worktreeBase: '/worktrees',
      runnerId: 'runner-a',
      readSnapshot: async () => snapshot(),
      changedFiles: async () => [],
      codeownersText: () => '',
      runner: async () => '',
      createWorkspace: async (input) => {
        creates.push(input);
        return {
          attemptId: input.attemptId!,
          paths: {
            worktree: '/attempt/worktree',
            manifest: '/attempt/manifest',
            log: '/attempt/log',
            ghConfigDir: '/attempt/gh',
            askpass: '/attempt/askpass',
          },
        };
      },
    });

    await port.createAttempt({
      attemptId: ATTEMPT,
      issueNumber: 42,
      prNumber: 84,
      branch: gitRefName('autopilot/42'),
      targetBase: gitRefName('next'),
      expectedHead: HEAD,
      claimOid: RECORD,
      reviewGeneration: GENERATION,
      reviewRefOid: RECORD,
      approvalPolicy: 'approve-eligible',
      selectedLogin: 'review-bot',
    });

    expect(creates).toEqual([expect.objectContaining({
      phase: 'review',
      subject: 'pr-84',
      reviewGeneration: GENERATION,
      reviewRefOid: RECORD,
      reviewApprovalPolicy: 'approve-eligible',
    })]);
  });

  it.each(['label', 'Project'] as const)(
    'accepts a lost acquisition %s response only after exact projection readback',
    async (mutation) => {
      let labels = mutation === 'label' ? [] : ['engine:review'];
      let status: 'Todo' | 'In Review' | 'Human' =
        mutation === 'Project' ? 'Todo' : 'In Review';
      const port = makeProductionReviewActionPort({
        repositoryPath: '/repo',
        worktreeBase: '/worktrees',
        runnerId: 'runner-a',
        readSnapshot: async () => snapshot(),
        changedFiles: async () => [],
        codeownersText: () => '',
        runner: async (cmd, args) => {
          if (cmd === 'git' && args.includes('ls-remote')) {
            return `${REVIEW}\trefs/jinn-autopilot/review-claims/v1/84\n`;
          }
          if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') {
            return JSON.stringify({
              headRefOid: HEAD,
              labels: labels.map((name) => ({ name })),
              isDraft: false,
            });
          }
          if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'edit') {
            labels = [...labels, 'engine:review'];
            throw new Error('accepted acquisition label response lost');
          }
          if (cmd === 'gh' && args[0] === 'api' && args[1] === 'graphql') {
            return projectSnapshot(status);
          }
          if (cmd === 'gh' && args[0] === 'project' && args[1] === 'field-list') {
            return projectFields();
          }
          if (cmd === 'gh' && args[0] === 'project' && args[1] === 'item-edit') {
            status = 'In Review';
            throw new Error('accepted acquisition Project response lost');
          }
          throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
        },
      });
      const selection = pool().select({
        phase: 'review',
        prAuthor: 'implementation-bot',
      });
      if (selection.status !== 'selected') throw new Error('fixture selection failed');
      const candidate = await port.readCandidate(84);
      if (candidate === null) throw new Error('fixture candidate missing');

      await expect(port.repairProjection({
        candidate,
        expectedReviewRefOid: REVIEW,
        credential: selection.credential,
      })).resolves.toBeUndefined();
    },
  );
});

import { describe, expect, it } from 'vitest';
import { CredentialPool, selectCredential } from '../../src/lifecycle/credentials.js';
import {
  makeProductionImplementationActionPort,
} from '../../src/lifecycle/implementation-executor-production.js';
import type { GitHubLifecycleSnapshot } from '../../src/lifecycle/snapshot.js';
import { gitOid, gitRefName } from '../../src/lifecycle/types.js';

const HEAD = gitOid('1'.repeat(40));

function snapshot(): GitHubLifecycleSnapshot {
  return {
    project: {
      items: [{
        id: 'PVTI_issue',
        contentType: 'Issue',
        number: 42,
        issueType: 'feat',
        status: 'Todo',
        priority: 'P1',
        effort: 'High',
        blockedOn: 'Nothing',
        blockedByIssues: [],
        sprintIterationId: null,
      }],
      rateLimit: { remaining: 4_000, used: 1, resetAt: '2026-07-20T13:00:00.000Z' },
      currentSprintIterationId: null,
    },
    issues: [{
      number: 42,
      title: 'Implement active lifecycle',
      shape: 'feat',
      blockedOn: 'Nothing',
      blockedByIssues: [],
      effort: 'High',
      priority: 'P1',
      status: 'Todo',
      onBoard: true,
      author: 'trusted-author',
      projectItemId: 'PVTI_issue',
      inCurrentSprint: false,
    }],
    pullRequests: [],
    branches: [],
    diagnostics: [],
    lifecycle: {
      items: [{
        kind: 'issue',
        issueNumber: 42,
        v2Marked: false,
        projectStatus: 'Todo',
        labels: [],
        eligible: true,
        eligibilityReason: 'eligible',
      }],
    },
    capturedAt: '2026-07-20T12:00:00.000Z',
  };
}

describe('production implementation action port', () => {
  it('re-admits a reaped draft PR as ordinary implementation work on its existing branch', async () => {
    const base = snapshot();
    const current: GitHubLifecycleSnapshot = {
      ...base,
      pullRequests: [{
        number: 84,
        title: 'Implement active lifecycle',
        body: 'Closes #42\n\n<!-- jinn-autopilot:v2 issue=42 branch=existing/42 -->',
        author: 'implementation-bot',
        baseRefName: 'stack/base',
        headRefName: 'existing/42',
        headOid: HEAD,
        headCommittedAt: '2026-07-20T08:00:00.000Z',
        isDraft: true,
        state: 'OPEN',
        labels: ['engine:review'],
        closingIssueNumbers: [42],
        mergeability: 'UNKNOWN',
        mergeStateStatus: 'BLOCKED',
        checks: [],
        reviews: [],
      }],
      lifecycle: {
        items: [{
          kind: 'pull-request',
          issueNumber: 42,
          prNumber: 84,
          v2Marked: true,
          projectStatus: 'Todo',
          labels: ['engine:review'],
          head: HEAD,
          headChangedAt: '2026-07-20T08:00:00.000Z',
          isDraft: true,
          merged: false,
          needsReview: true,
          approved: false,
          mergeState: 'blocked',
          branchClaim: {
            kind: 'branch-claim',
            protocolVersion: 2,
            phase: 'implement',
            issueNumber: 42,
            prNumber: 84,
            attempt: '11111111-1111-4111-8111-111111111111',
            runner: 'old-runner',
            login: 'implementation-bot',
            expectedHead: HEAD,
            targetBase: gitRefName('stack/base'),
            claimedAt: '2026-07-20T08:00:00.000Z',
          },
        }],
      },
    };
    const credentials = new CredentialPool([]);
    const port = makeProductionImplementationActionPort({
      repositoryPath: '/repo',
      worktreeBase: '/attempts',
      runnerId: 'runner-a',
      credentials,
      authorAllowlist: new Set(['trusted-author']),
      readSnapshot: async () => current,
    });

    await expect(port.readIssue(42)).resolves.toMatchObject({
      eligible: true,
      targetBase: 'stack/base',
    });
    await expect(port.listOpenPullRequests(42)).resolves.toEqual([
      expect.objectContaining({
        number: 84,
        headRefName: 'existing/42',
        head: HEAD,
      }),
    ]);
  });

  it('uses the selected credential and accepts a lost PR-create response only after exact readback', async () => {
    const calls: Array<{ args: string[]; env?: Record<string, string> }> = [];
    const pool = new CredentialPool([{
      login: 'implementation-bot',
      normalizedLogin: 'implementation-bot',
      implementationToken: 'selected-secret',
    }]);
    const selection = selectCredential(pool, { phase: 'implement' });
    if (selection.status !== 'selected') throw new Error('selection failed');
    const port = makeProductionImplementationActionPort({
      repositoryPath: '/repo',
      worktreeBase: '/attempts',
      runnerId: 'runner-a',
      credentials: pool,
      authorAllowlist: new Set(['trusted-author']),
      readSnapshot: async () => snapshot(),
      environment: { GITHUB_TOKEN: 'ambient-secret' },
      runner: async (command, args, options) => {
        if (command !== 'gh') throw new Error(`unexpected ${command}`);
        calls.push({ args, env: options?.env });
        if (args.includes('create')) throw new Error('response lost');
        if (args.includes('list')) {
          return JSON.stringify([{
            number: 84,
            headRefName: 'autopilot/42',
            headRefOid: HEAD,
            baseRefName: 'next',
            isDraft: true,
            labels: [{ name: 'engine:review' }],
            body: 'Closes #42\n\n<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->',
          }]);
        }
        throw new Error(`unexpected ${args.join(' ')}`);
      },
    });

    await expect(port.ensureDraftPullRequest({
      issueNumber: 42,
      branch: gitRefName('autopilot/42'),
      claimOid: HEAD,
      targetBase: gitRefName('next'),
      title: 'Implement active lifecycle',
      body: 'Closes #42\n\n<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->',
      draft: true,
      label: 'engine:review',
      credential: selection.credential,
    })).resolves.toMatchObject({
      number: 84,
      head: HEAD,
      draft: true,
    });
    expect(calls.every((call) => call.env?.GH_TOKEN === 'selected-secret')).toBe(true);
    expect(calls.every((call) => call.env?.GITHUB_TOKEN === '')).toBe(true);
  });

  it('does not reclaim Project authority after a Human hold arrives', async () => {
    const baseline = snapshot();
    const current: GitHubLifecycleSnapshot = {
      ...baseline,
      project: {
        ...baseline.project,
        items: [{
          ...baseline.project.items[0]!,
          status: 'Human',
          blockedOn: 'Human',
        }],
      },
      branches: [{
        headRefName: 'autopilot/42',
        headOid: HEAD,
        headCommittedAt: '2026-07-20T12:00:00.000Z',
        issueNumber: 42,
        claim: {
          kind: 'branch-claim',
          protocolVersion: 2,
          phase: 'implement',
          issueNumber: 42,
          attempt: '11111111-1111-4111-8111-111111111111',
          runner: 'runner-a',
          login: 'implementation-bot',
          expectedHead: gitOid('0'.repeat(40)),
          targetBase: gitRefName('next'),
          claimedAt: '2026-07-20T12:00:00.000Z',
        },
      }],
    };
    const pool = new CredentialPool([{
      login: 'implementation-bot',
      normalizedLogin: 'implementation-bot',
      implementationToken: 'selected-secret',
    }]);
    const selection = selectCredential(pool, { phase: 'implement' });
    if (selection.status !== 'selected') throw new Error('selection failed');
    let mutations = 0;
    const port = makeProductionImplementationActionPort({
      repositoryPath: '/repo',
      worktreeBase: '/attempts',
      runnerId: 'runner-a',
      credentials: pool,
      authorAllowlist: new Set(['trusted-author']),
      readSnapshot: async () => current,
      runner: async () => {
        mutations++;
        return '';
      },
    });

    await expect(port.setProjectInProgress(
      42,
      HEAD,
      selection.credential,
    )).rejects.toThrow('Human is dominant');
    expect(mutations).toBe(0);
  });

  it('resolves machine children from issue bodies in incremental snapshots', async () => {
    const marker = '<!-- jinn-autopilot:child pr=2065 kind=review-finding -->';
    const current: GitHubLifecycleSnapshot = {
      ...snapshot(),
      issues: [{
        number: 2069,
        title: 'Address review findings for PR #2065',
        body: `${marker}\n\nFindings`,
        labels: ['review-finding'],
        shape: 'fix',
        blockedOn: 'Nothing',
        blockedByIssues: [],
        effort: 'Low',
        priority: 'P2',
        status: 'Todo',
        onBoard: true,
        author: 'ritsukai',
        projectItemId: 'PVTI_child',
        inCurrentSprint: false,
      }],
      pullRequests: [{
        number: 2065,
        title: 'Parent PR',
        body: 'Closes #2044',
        author: 'ritsukai',
        baseRefName: 'next',
        headRefName: 'autopilot/2044',
        headOid: HEAD,
        headCommittedAt: '2026-07-20T08:00:00.000Z',
        isDraft: false,
        state: 'OPEN',
        labels: ['engine:review'],
        closingIssueNumbers: [2044],
        mergeability: 'UNKNOWN',
        mergeStateStatus: 'BLOCKED',
        checks: [],
        reviews: [],
      }],
      lifecycle: {
        items: [{
          kind: 'issue',
          issueNumber: 2069,
          v2Marked: true,
          projectStatus: 'Todo',
          labels: ['review-finding'],
          eligible: true,
          eligibilityReason: 'eligible',
        }],
      },
    };
    const port = makeProductionImplementationActionPort({
      repositoryPath: '/repo',
      worktreeBase: '/attempts',
      runnerId: 'runner-a',
      credentials: new CredentialPool([{
        login: 'implementation-bot',
        normalizedLogin: 'implementation-bot',
        implementationToken: 'selected-secret',
      }]),
      authorAllowlist: new Set(['ritsukai']),
      readSnapshot: async () => current,
    });

    await expect(port.readIssue(2069)).resolves.toMatchObject({
      eligible: true,
      child: { parentPr: 2065, kind: 'review-finding' },
    });
    await expect(port.readParentPullRequest!(2065)).resolves.toMatchObject({
      number: 2065,
      headRefName: 'autopilot/2044',
      head: HEAD,
    });
  });

  it('fails closed when a child kind label is present without a body marker', async () => {
    const current: GitHubLifecycleSnapshot = {
      ...snapshot(),
      issues: [{
        number: 2069,
        title: 'Address review findings for PR #2065',
        labels: ['review-finding'],
        shape: 'fix',
        blockedOn: 'Nothing',
        blockedByIssues: [],
        effort: 'Low',
        priority: 'P2',
        status: 'Todo',
        onBoard: true,
        author: 'ritsukai',
        projectItemId: 'PVTI_child',
        inCurrentSprint: false,
      }],
      lifecycle: {
        items: [{
          kind: 'issue',
          issueNumber: 2069,
          v2Marked: true,
          projectStatus: 'Todo',
          labels: ['review-finding'],
          eligible: true,
          eligibilityReason: 'eligible',
        }],
      },
    };
    const port = makeProductionImplementationActionPort({
      repositoryPath: '/repo',
      worktreeBase: '/attempts',
      runnerId: 'runner-a',
      credentials: new CredentialPool([]),
      authorAllowlist: new Set(['ritsukai']),
      readSnapshot: async () => current,
    });

    await expect(port.readIssue(2069)).resolves.toMatchObject({
      eligible: false,
    });
  });
});

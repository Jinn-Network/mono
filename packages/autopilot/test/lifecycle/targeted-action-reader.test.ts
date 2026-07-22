import { describe, expect, it, vi } from 'vitest';
import {
  makeTargetedActionReader,
} from '../../src/lifecycle/targeted-action-reader.js';
import { GitHubRateLimitReserveError } from '../../src/lifecycle/github-usage.js';
import type {
  GitHubLifecycleSnapshot,
  RawPullRequest,
} from '../../src/lifecycle/snapshot.js';
import { decodePullRequestSnapshot } from '../../src/lifecycle/snapshot.js';

const HEAD = 'a'.repeat(40);

function cycleSnapshot(): GitHubLifecycleSnapshot {
  return {
    project: {
      items: [{
        id: 'item-42',
        contentType: 'Issue',
        number: 42,
        status: 'In Review',
        priority: 'P1',
        effort: 'Medium',
        blockedOn: 'Nothing',
        blockedByIssues: [],
        issueType: 'fix',
        sprintIterationId: 'sprint-1',
      }],
      rateLimit: { remaining: 4_000, used: 1_000, resetAt: '2026-07-22T12:00:00.000Z' },
      currentSprintIterationId: 'sprint-1',
    },
    issues: [{
      number: 42,
      title: 'Target issue',
      shape: 'fix',
      blockedOn: 'Nothing',
      blockedByIssues: [],
      effort: 'Medium',
      priority: 'P1',
      status: 'In Review',
      onBoard: true,
      author: 'oaksprout',
      projectItemId: 'item-42',
      inCurrentSprint: true,
      labels: [],
    }],
    pullRequests: [],
    branches: [],
    diagnostics: [],
    lifecycle: { items: [] },
    capturedAt: '2026-07-22T10:00:00.000Z',
    snapshotMode: 'incremental',
    snapshotComplete: true,
    lastFullReconciliationAt: '2026-07-22T09:30:00.000Z',
    githubUsage: {
      graphqlRequests: 1,
      graphqlCost: 2,
      graphqlRemaining: 4_000,
      graphqlResetAt: '2026-07-22T12:00:00.000Z',
      restRequests: 0,
      restNotModified: 0,
      cacheHits: 0,
    },
  };
}

function rawPullRequest(overrides: Partial<RawPullRequest> = {}): RawPullRequest {
  return {
    number: 101,
    title: 'Fix target',
    body: '<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->',
    author: 'oaksprout',
    baseRefName: 'next',
    headRefName: 'autopilot/42',
    headOid: HEAD,
    headCommittedAt: '2026-07-22T09:00:00.000Z',
    isDraft: false,
    state: 'OPEN',
    labels: ['engine:review'],
    closingIssueNumbers: [42],
    mergeability: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    checks: [],
    reviews: [],
    branchClaimTrailers: null,
    reviewClaim: null,
    humanReason: null,
    mergedAt: null,
    mergeCommitOid: null,
    ...overrides,
  };
}

describe('targeted action reader', () => {
  it('hydrates only the requested PR and its mapped Project item', async () => {
    const calls: string[] = [];
    const reader = makeTargetedActionReader({
      authorAllowlist: new Set(['oaksprout']),
      rateLimitFloor: 500,
      readGraphQlRemaining: async () => { calls.push('quota'); return 510; },
      readPullRequest: async (number) => {
        calls.push(`pr:${number}`);
        return rawPullRequest();
      },
      readProjectItem: async (number) => {
        calls.push(`project:${number}`);
        return { id: 'item-42', status: 'In Review', blockedOn: 'Nothing' };
      },
      readIssue: async (number) => {
        calls.push(`issue:${number}`);
        return { number, title: 'Target issue', open: true, author: 'oaksprout', labels: [] };
      },
      readBlockedByIssueNumbers: async (number) => {
        calls.push(`dependencies:${number}`);
        return [];
      },
    });

    const snapshot = await reader.readPullRequest(cycleSnapshot(), 101);

    expect(calls).toEqual([
      'quota',
      'pr:101',
      'issue:42',
      'project:42',
      'dependencies:42',
    ]);
    expect(snapshot?.pullRequests.map((pr) => pr.number)).toEqual([101]);
    expect(snapshot?.lifecycle.items).toEqual([
      expect.objectContaining({ kind: 'pull-request', issueNumber: 42, prNumber: 101 }),
    ]);
  });

  it('reads one live native issue, Project item, and dependency set for implementation', async () => {
    const calls: string[] = [];
    const reader = makeTargetedActionReader({
      authorAllowlist: new Set(['oaksprout']),
      rateLimitFloor: 500,
      readGraphQlRemaining: async () => { calls.push('quota'); return 510; },
      readPullRequest: vi.fn(),
      readProjectItem: async (number) => {
        calls.push(`project:${number}`);
        return { id: 'item-42', status: 'Todo', blockedOn: 'Another issue' };
      },
      readIssue: async (number) => {
        calls.push(`issue:${number}`);
        return { number, title: 'Target issue now', open: true, author: 'oaksprout', labels: [] };
      },
      readBlockedByIssueNumbers: async (number) => {
        calls.push(`dependencies:${number}`);
        return [7];
      },
    });

    const base = cycleSnapshot();
    const result = await reader.readIssue({
      ...base,
      issues: [{ ...base.issues[0]!, blockedByIssues: [7] }],
      project: {
        ...base.project,
        items: [{ ...base.project.items[0]!, blockedByIssues: [7] }],
      },
    }, 42);

    expect(calls).toEqual(['quota', 'issue:42', 'project:42', 'dependencies:42']);
    expect(result?.source).toEqual(expect.objectContaining({
      number: 42,
      title: 'Target issue now',
      blockedOn: 'Another issue',
      blockedByIssues: [7],
      status: 'Todo',
    }));
  });

  it('hydrates Project and closing relations from one combined issue context', async () => {
    const calls: string[] = [];
    const reader = makeTargetedActionReader({
      authorAllowlist: new Set(['oaksprout']),
      rateLimitFloor: 500,
      readGraphQlRemaining: async () => { calls.push('quota:10'); return 510; },
      readPullRequest: vi.fn(),
      readProjectItem: vi.fn(),
      readIssue: async (number) => ({
        number, title: 'Target issue', open: true, author: 'oaksprout', labels: [],
      }),
      readBlockedByIssueNumbers: async () => [],
      readIssueActionContext: async () => {
        calls.push('combined:2');
        return {
          projectItem: {
            id: 'item-42', status: 'Todo', priority: 'P1', effort: 'Medium',
            blockedOn: 'Nothing', issueType: 'fix',
          },
          openPullRequestNumbers: new Set([101]),
        };
      },
      readPullRequestDetails: async (number) => {
        calls.push(`rest-pr:${number}`);
        return {
          number,
          headRefName: 'autopilot/42',
          headOid: HEAD,
          baseRefName: 'next',
          draft: true,
          labels: ['engine:review'],
          body: 'Closes #42\n\n<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->',
        };
      },
    });

    const result = await reader.readIssue(cycleSnapshot(), 42);

    expect(result?.openPullRequests?.map((pr) => pr.number)).toEqual([101]);
    expect(calls).toEqual(['quota:10', 'combined:2', 'rest-pr:101']);
  });

  it('does not revive live-missing admission fields from the cycle cache', async () => {
    const reader = makeTargetedActionReader({
      authorAllowlist: new Set(['oaksprout']),
      rateLimitFloor: 500,
      readGraphQlRemaining: async () => 510,
      readPullRequest: vi.fn(),
      readProjectItem: async () => ({
        id: 'item-42',
        status: 'Todo',
        priority: null,
        effort: null,
        blockedOn: 'Nothing',
        issueType: null,
      }),
      readIssue: async (number) => ({
        number,
        title: 'Target issue',
        open: true,
        author: 'oaksprout',
        labels: [],
      }),
      readBlockedByIssueNumbers: async () => [],
    });

    const result = await reader.readIssue(cycleSnapshot(), 42);

    expect(result?.source).toMatchObject({ priority: null, effort: null, shape: null });
    expect(result?.snapshot.lifecycle.items).toEqual([
      expect.objectContaining({ kind: 'issue', eligible: false }),
    ]);
  });

  it('preserves single-open-blocker stack admission after exact blocker hydration', async () => {
    const base = cycleSnapshot();
    const blockerRaw = rawPullRequest({
      number: 201,
      body: '<!-- jinn-autopilot:v2 issue=7 branch=autopilot/7 -->',
      headRefName: 'autopilot/7',
      closingIssueNumbers: [7],
    });
    const cycle: GitHubLifecycleSnapshot = {
      ...base,
      project: {
        ...base.project,
        items: [{ ...base.project.items[0]!, blockedOn: 'Another issue', blockedByIssues: [7] }],
      },
      issues: [
        { ...base.issues[0]!, blockedOn: 'Another issue', blockedByIssues: [7] },
        {
          ...base.issues[0]!,
          number: 7,
          title: 'Blocker',
          status: 'In Progress',
          projectItemId: 'item-7',
        },
      ],
      pullRequests: [decodePullRequestSnapshot(blockerRaw)],
    };
    const reader = makeTargetedActionReader({
      authorAllowlist: new Set(['oaksprout']),
      rateLimitFloor: 500,
      readGraphQlRemaining: async () => 510,
      readPullRequest: async (number) => number === 201 ? blockerRaw : null,
      readProjectItem: async () => ({
        id: 'item-42',
        status: 'Todo',
        priority: 'P1',
        effort: 'Medium',
        blockedOn: 'Another issue',
        issueType: 'fix',
      }),
      readIssue: async (number) => ({
        number,
        title: 'Target issue',
        open: true,
        author: 'oaksprout',
        labels: [],
      }),
      readBlockedByIssueNumbers: async () => [7],
    });

    const result = await reader.readIssue(cycle, 42);

    expect(result?.snapshot.lifecycle.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'issue', issueNumber: 42, eligible: true }),
    ]));
  });

  it.each([
    ['branch', { headRefName: 'autopilot/other' }],
    ['closing relation', { closingIssueNumbers: [8] }],
    ['marker', {
      body: '<!-- jinn-autopilot:v2 issue=7 branch=autopilot/other -->',
    }],
  ])('rejects a stacked implementation when the blocker %s changes', async (_field, override) => {
    const base = cycleSnapshot();
    const blocker = rawPullRequest({
      number: 201,
      body: '<!-- jinn-autopilot:v2 issue=7 branch=autopilot/7 -->',
      headRefName: 'autopilot/7',
      closingIssueNumbers: [7],
    });
    const cycle: GitHubLifecycleSnapshot = {
      ...base,
      project: {
        ...base.project,
        items: [{ ...base.project.items[0]!, blockedOn: 'Another issue', blockedByIssues: [7] }],
      },
      issues: [{ ...base.issues[0]!, blockedOn: 'Another issue', blockedByIssues: [7] }],
      pullRequests: [decodePullRequestSnapshot(blocker)],
    };
    const reader = makeTargetedActionReader({
      authorAllowlist: new Set(['oaksprout']),
      rateLimitFloor: 500,
      readGraphQlRemaining: async () => 510,
      readPullRequest: async () => ({ ...blocker, ...override }),
      readProjectItem: async () => ({
        id: 'item-42', status: 'Todo', priority: 'P1', effort: 'Medium',
        blockedOn: 'Another issue', issueType: 'fix',
      }),
      readIssue: async (number) => ({
        number, title: 'Target issue', open: true, author: 'oaksprout', labels: [],
      }),
      readBlockedByIssueNumbers: async () => [7],
    });

    await expect(reader.readIssue(cycle, 42)).rejects.toThrow(/blocker PR authority changed/i);
  });

  it('checks the ten-point reserve before starting targeted GraphQL work', async () => {
    const readPullRequest = vi.fn(async () => rawPullRequest());
    const reader = makeTargetedActionReader({
      authorAllowlist: new Set(['oaksprout']),
      rateLimitFloor: 500,
      readGraphQlRemaining: async () => 509,
      readPullRequest,
      readProjectItem: vi.fn(),
      readIssue: async (number) => ({
        number,
        title: 'Target issue',
        open: true,
        author: 'oaksprout',
        labels: [],
      }),
      readBlockedByIssueNumbers: vi.fn(),
    });

    await expect(reader.readPullRequest(cycleSnapshot(), 101))
      .rejects.toBeInstanceOf(GitHubRateLimitReserveError);
    expect(readPullRequest).not.toHaveBeenCalled();
  });

  it('guards direct Project pre/post readbacks at the one-point floor boundary', async () => {
    let remaining = 500;
    const readProjectItem = vi.fn(async () => ({
      id: 'item-42', status: 'Todo' as const, blockedOn: 'Nothing' as const,
    }));
    const reader = makeTargetedActionReader({
      authorAllowlist: new Set(['oaksprout']),
      rateLimitFloor: 500,
      readGraphQlRemaining: async () => remaining,
      readPullRequest: vi.fn(),
      readProjectItem,
      readIssue: vi.fn(),
      readBlockedByIssueNumbers: vi.fn(),
    });

    await expect(reader.readProjectItem(42)).rejects.toBeInstanceOf(GitHubRateLimitReserveError);
    expect(readProjectItem).not.toHaveBeenCalled();

    remaining = 501;
    await expect(reader.readProjectItem(42)).resolves.toMatchObject({ id: 'item-42' });
    expect(readProjectItem).toHaveBeenCalledTimes(1);
  });

  it('guards issue-level closing-relation reads at the two-point floor boundary', async () => {
    let remaining = 501;
    const readRelations = vi.fn(async () => new Set<number>());
    const reader = makeTargetedActionReader({
      authorAllowlist: new Set(['oaksprout']),
      rateLimitFloor: 500,
      readGraphQlRemaining: async () => remaining,
      readPullRequest: vi.fn(),
      readProjectItem: vi.fn(),
      readIssue: vi.fn(),
      readBlockedByIssueNumbers: vi.fn(),
      readOpenPullRequestNumbersClosingIssue: readRelations,
      readPullRequestDetails: vi.fn(),
    });

    await expect(reader.readOpenPullRequests(42))
      .rejects.toBeInstanceOf(GitHubRateLimitReserveError);
    expect(readRelations).not.toHaveBeenCalled();

    remaining = 502;
    await expect(reader.readOpenPullRequests(42)).resolves.toEqual([]);
    expect(readRelations).toHaveBeenCalledTimes(1);
  });

  it('fails closed when a mapped issue has no live Project item', async () => {
    const reader = makeTargetedActionReader({
      authorAllowlist: new Set(['oaksprout']),
      rateLimitFloor: 500,
      readGraphQlRemaining: async () => 510,
      readPullRequest: async () => rawPullRequest(),
      readProjectItem: async () => null,
      readIssue: async (number) => ({
        number,
        title: 'Target issue',
        open: true,
        author: 'oaksprout',
        labels: [],
      }),
      readBlockedByIssueNumbers: vi.fn(),
    });

    await expect(reader.readPullRequest(cycleSnapshot(), 101))
      .rejects.toThrow(/Project item/i);
  });

  it('rejects an open PR when its exactly mapped native issue closed after the cycle', async () => {
    const reader = makeTargetedActionReader({
      authorAllowlist: new Set(['oaksprout']),
      rateLimitFloor: 500,
      readGraphQlRemaining: async () => 510,
      readPullRequest: async () => rawPullRequest(),
      readProjectItem: vi.fn(),
      readIssue: async (number) => ({
        number,
        title: 'Closed issue',
        open: false,
        author: 'oaksprout',
        labels: [],
      }),
      readBlockedByIssueNumbers: vi.fn(),
    });

    await expect(reader.readPullRequest(cycleSnapshot(), 101))
      .rejects.toThrow(/native issue.*closed/i);
  });
});

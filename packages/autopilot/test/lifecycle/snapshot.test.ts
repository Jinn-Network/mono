import { describe, expect, it } from 'vitest';
import type { PolledIssue } from '../../src/dispatcher/types.js';
import {
  buildGitHubLifecycleSnapshot,
  SnapshotDecodeError,
  type GitHubLifecycleReader,
  type PullRequestPage,
} from '../../src/lifecycle/snapshot.js';

const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const REVIEW_REF = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function issue(): PolledIssue {
  return {
    number: 42,
    title: 'Lifecycle work',
    shape: 'feat',
    blockedOn: 'Nothing',
    blockedByIssues: [],
    effort: 'Medium',
    priority: 'P1',
    status: 'In Review',
    onBoard: true,
    author: 'trusted',
    projectItemId: 'PVTI_42',
    inCurrentSprint: true,
  };
}

function page(after: string | null): PullRequestPage {
  if (after === null) {
    return {
      nodes: [],
      pageInfo: { hasNextPage: true, endCursor: 'page-2' },
    };
  }
  return {
    nodes: [{
      number: 101,
      title: 'feat: lifecycle work',
      body: 'Closes #42',
      author: 'trusted',
      baseRefName: 'next',
      headRefName: 'autopilot/42',
      headOid: HEAD,
      headCommittedAt: '2026-07-20T09:00:00.000Z',
      isDraft: false,
      state: 'OPEN',
      labels: ['engine:review'],
      closingIssueNumbers: [42],
      mergeability: 'MERGEABLE',
      mergeStateStatus: 'BLOCKED',
      checks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      reviews: [{
        reviewer: 'reviewer',
        state: 'APPROVED',
        commitId: HEAD,
        body: '<!-- jinn-autopilot-review:v2 generation=22222222-2222-4222-8222-222222222222 attempt=33333333-3333-4333-8333-333333333333 head=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa verdict=APPROVE -->',
        submittedAt: '2026-07-20T10:00:00.000Z',
      }],
      branchClaimTrailers: null,
      reviewClaim: {
        oid: REVIEW_REF,
        payload: JSON.stringify({
          protocolVersion: 2,
          prNumber: 101,
          generation: '22222222-2222-4222-8222-222222222222',
          attempt: '33333333-3333-4333-8333-333333333333',
          reviewer: 'reviewer',
          head: HEAD,
          state: 'verdict-intent',
          recordedAt: '2026-07-20T09:00:00.000Z',
          verdict: {
            marker: '44444444-4444-4444-8444-444444444444',
            state: 'APPROVE',
          },
        }),
      },
      humanReason: null,
      mergedAt: null,
      mergeCommitOid: null,
    }],
    pageInfo: { hasNextPage: false, endCursor: null },
  };
}

function reader(overrides: Partial<GitHubLifecycleReader> = {}): GitHubLifecycleReader {
  return {
    readProjectSnapshot: async () => ({
      items: [{
        id: 'PVTI_42',
        number: 42,
        contentType: 'Issue',
        status: 'In Review',
        priority: 'P1',
        effort: 'Medium',
        blockedOn: 'Nothing',
        issueType: 'feat',
        blockedByIssues: [],
        sprintIterationId: 'sprint',
      }],
      rateLimit: {
        remaining: 4_000,
        used: 1_000,
        resetAt: '2026-07-20T13:00:00.000Z',
      },
      currentSprintIterationId: 'sprint',
    }),
    readIssues: async () => [issue()],
    readPullRequests: async (cursor) => page(cursor),
    ...overrides,
  };
}

describe('buildGitHubLifecycleSnapshot', () => {
  it('paginates PRs and preserves native review commit IDs exactly', async () => {
    const cursors: Array<string | null> = [];
    const source = reader({
      readPullRequests: async (cursor) => {
        cursors.push(cursor);
        return page(cursor);
      },
    });

    const snapshot = await buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
    });

    expect(cursors).toEqual([null, 'page-2']);
    expect(snapshot.project.items).toHaveLength(1);
    expect(snapshot.pullRequests[0]?.reviews[0]?.commitId).toBe(HEAD);
    expect(snapshot.pullRequests[0]?.reviewClaim?.oid).toBe(REVIEW_REF);
    expect(snapshot.lifecycle.items[0]).toMatchObject({
      kind: 'pull-request',
      issueNumber: 42,
      prNumber: 101,
      head: HEAD,
      approved: true,
      terminalVerdict: {
        head: HEAD,
        state: 'APPROVE',
        recordedAt: '2026-07-20T10:00:00.000Z',
        marker: '44444444-4444-4444-8444-444444444444',
      },
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.pullRequests)).toBe(true);
  });

  it('fails closed when a review claim payload is malformed', async () => {
    const malformed = page('page-2');
    const node = malformed.nodes[0]!;
    const source = reader({
      readPullRequests: async () => ({
        ...malformed,
        nodes: [{
          ...node,
          reviewClaim: { oid: REVIEW_REF, payload: '{"protocolVersion":2}' },
        }],
      }),
    });

    await expect(buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
    })).rejects.toBeInstanceOf(SnapshotDecodeError);
  });

  it('fails closed when pagination says another page exists without a cursor', async () => {
    const source = reader({
      readPullRequests: async () => ({
        nodes: [],
        pageInfo: { hasNextPage: true, endCursor: null },
      }),
    });

    await expect(buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
    })).rejects.toThrow(/pagination/i);
  });
});

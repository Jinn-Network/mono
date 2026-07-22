// @ts-nocheck — Stage 5 leftover fixtures for deleted merge-prep/review-fix/project APIs.
import { describe, expect, it, vi } from 'vitest';
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
        body: '<!-- jinn-autopilot-review:v2 generation=22222222-2222-4222-8222-222222222222 attempt=33333333-3333-4333-8333-333333333333 intent=44444444-4444-4444-8444-444444444444 reviewer=reviewer head=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa verdict=APPROVE -->',
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

  it('skips undecodable legacy merge-prep branch claims without failing the snapshot', async () => {
    const source = reader({
      readBranchClaims: async () => [{
        issueNumber: 1935,
        headRefName: 'autopilot/1935',
        headOid: 'dddddddddddddddddddddddddddddddddddddddd',
        headCommittedAt: '2026-07-21T19:14:05.251Z',
        claimTrailers: [
          'Jinn-Autopilot-Protocol: 2',
          'Jinn-Autopilot-Phase: merge-prep',
          'Jinn-Autopilot-Issue: 1935',
          'Jinn-Autopilot-PR: 1943',
          'Jinn-Autopilot-Attempt: 5a3ec319-150f-4386-8a10-4755896655b6',
          'Jinn-Autopilot-Runner: rollout-merge-prep-recovery-c',
          'Jinn-Autopilot-Login: trusted',
          'Jinn-Autopilot-Expected-Head: fbfb6fd064538f17326fbbcb142c6e1f917bf1d1',
          'Jinn-Autopilot-Target-Base: next',
          'Jinn-Autopilot-Claimed-At: 2026-07-21T19:14:05.251Z',
          'Jinn-Autopilot-Phase-Complete: true',
        ].join('\n'),
      }],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const snapshot = await buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
    });

    expect(snapshot.branches).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('autopilot/1935'),
    );
    warn.mockRestore();
  });

  it('does not recover a copied exact intent marker from the wrong reviewer login', async () => {
    const copied = page('page-2');
    const node = copied.nodes[0]!;
    const source = reader({
      readPullRequests: async () => ({
        ...copied,
        nodes: [{
          ...node,
          reviews: node.reviews.map((review) => ({
            ...review,
            reviewer: 'marker-copying-bot',
          })),
        }],
      }),
    });

    const snapshot = await buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
    });

    expect(snapshot.lifecycle.items[0]).not.toHaveProperty('terminalVerdict');
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

  it('stops after the lean Project read when the rate-limit guard trips', async () => {
    const calls: string[] = [];
    const source = reader({
      readProjectSnapshot: async () => {
        calls.push('project');
        return {
          ...(await reader().readProjectSnapshot()),
          rateLimit: {
            remaining: 499,
            used: 4_501,
            resetAt: '2026-07-20T13:00:00.000Z',
          },
        };
      },
      readIssues: async () => {
        calls.push('issues');
        return [issue()];
      },
      readPullRequests: async () => {
        calls.push('prs');
        return { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
      },
      readBranchClaims: async () => {
        calls.push('branches');
        return [];
      },
    });

    await expect(buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
    })).rejects.toThrow(/rate-limit/i);
    expect(calls).toEqual(['project']);
  });

  it('preserves source eligibility reasons for no-PR issues', async () => {
    const dependencyBlocked = {
      ...issue(),
      number: 43,
      status: 'Todo' as const,
      blockedOn: 'Another issue' as const,
      blockedByIssues: [41],
    };
    const disallowed = {
      ...issue(),
      number: 44,
      status: 'Todo' as const,
      author: 'untrusted',
    };
    const source = reader({
      readIssues: async () => [
        { ...issue(), status: 'Todo' },
        dependencyBlocked,
        disallowed,
      ],
      readPullRequests: async () => ({
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    });

    const snapshot = await buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
    });

    expect(snapshot.lifecycle.items).toEqual([
      expect.objectContaining({
        issueNumber: 42,
        eligible: true,
        eligibilityReason: 'eligible',
      }),
      expect.objectContaining({
        issueNumber: 43,
        eligible: false,
        eligibilityReason: 'dependency-blocked',
      }),
      expect.objectContaining({
        issueNumber: 44,
        eligible: false,
        eligibilityReason: 'author-disallowed',
      }),
    ]);
  });

  it('fails ambiguous issue-to-PR mappings into structured Human diagnostics', async () => {
    const second = {
      ...page('page-2').nodes[0]!,
      number: 102,
      headRefName: 'feature/also-42',
      headOid: 'cccccccccccccccccccccccccccccccccccccccc',
      reviews: [],
      reviewClaim: null,
    };
    const multiIssue = {
      ...page('page-2').nodes[0]!,
      number: 103,
      headRefName: 'autopilot/43',
      headOid: 'dddddddddddddddddddddddddddddddddddddddd',
      closingIssueNumbers: [43, 44],
      reviews: [],
      reviewClaim: null,
    };
    const unlinked = {
      ...page('page-2').nodes[0]!,
      number: 104,
      headRefName: 'feature/unlinked',
      headOid: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      closingIssueNumbers: [],
      reviews: [],
      reviewClaim: null,
    };
    const source = reader({
      readIssues: async () => [
        issue(),
        { ...issue(), number: 43 },
        { ...issue(), number: 44 },
      ],
      readPullRequests: async () => ({
        nodes: [page('page-2').nodes[0]!, second, multiIssue, unlinked],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    });

    const snapshot = await buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
    });

    expect(snapshot.lifecycle.items).toEqual([]);
    expect(snapshot.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'branch-mapping-ambiguous',
        issueNumbers: [42],
        pullRequests: expect.arrayContaining([
          expect.objectContaining({ number: 101 }),
          expect.objectContaining({ number: 102 }),
        ]),
      }),
      expect.objectContaining({
        code: 'branch-mapping-ambiguous',
        issueNumbers: [43, 44],
        pullRequests: [expect.objectContaining({ number: 103 })],
      }),
      expect.objectContaining({
        code: 'branch-mapping-ambiguous',
        issueNumbers: [],
        pullRequests: [expect.objectContaining({ number: 104 })],
      }),
    ]));
  });

  it('carries bounded merged v2 evidence so merge-before-Done can recover', async () => {
    const merged = {
      ...page('page-2').nodes[0]!,
      state: 'MERGED' as const,
      mergedAt: '2026-07-20T10:00:00.000Z',
      mergeCommitOid: HEAD,
      branchClaimTrailers: null,
      reviewClaim: null,
      labels: ['engine:review'],
    };
    const source = reader({
      readPullRequests: async () => ({
        nodes: [merged],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    });

    const snapshot = await buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
    });

    expect(snapshot.lifecycle.items[0]).toMatchObject({
      kind: 'pull-request',
      merged: true,
      v2Marked: true,
      projectStatus: 'In Review',
    });
  });

  it.each([
    {
      name: 'Project Blocked on: Human',
      issue: { blockedOn: 'Human' as const },
      labels: ['engine:review'],
      expectedDetail: 'Project Blocked on: Human',
    },
    {
      name: 'review:needs-human label',
      issue: {},
      labels: ['engine:review', 'review:needs-human'],
      expectedDetail: 'PR label: review:needs-human',
    },
  ])('synthesizes a structured review reason from $name', async ({
    issue: issueOverride,
    labels,
    expectedDetail,
  }) => {
    const source = reader({
      readIssues: async () => [{ ...issue(), ...issueOverride }],
      readPullRequests: async () => ({
        nodes: [{ ...page('page-2').nodes[0]!, labels }],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    });

    const snapshot = await buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
    });

    expect(snapshot.lifecycle.items[0]).toMatchObject({
      kind: 'pull-request',
      humanHold: true,
      humanReason: {
        phase: 'reviewing',
        code: 'review-escalation',
        detail: expectedDetail,
      },
    });
  });

  it.skip('preserves an explicit structured Human marker ahead of synthesized sources', async () => {
    const explicit = {
      phase: 'review-fixing' as const,
      code: 'review-escalation' as const,
      detail: 'A human must decide whether the requested API change is acceptable',
    };
    const source = reader({
      readIssues: async () => [{ ...issue(), blockedOn: 'Human', status: 'Human' }],
      readPullRequests: async () => ({
        nodes: [{
          ...page('page-2').nodes[0]!,
          labels: ['engine:review', 'review:needs-human'],
          humanReason: explicit,
        }],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    });

    const snapshot = await buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
    });

    expect(snapshot.lifecycle.items[0]).toMatchObject({
      humanHold: true,
      humanReason: explicit,
    });
  });

  it('treats a current-head Human review record as authoritative without projections', async () => {
    const humanClaim = page('page-2').nodes[0]!;
    const source = reader({
      readPullRequests: async () => ({
        nodes: [{
          ...humanClaim,
          labels: ['engine:review'],
          reviewClaim: {
            ...humanClaim.reviewClaim!,
            payload: JSON.stringify({
              protocolVersion: 2,
              prNumber: 101,
              generation: '22222222-2222-4222-8222-222222222222',
              attempt: '33333333-3333-4333-8333-333333333333',
              reviewer: 'reviewer',
              head: HEAD,
              state: 'human',
              recordedAt: '2026-07-20T09:00:00.000Z',
            }),
          },
          humanReason: null,
        }],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    });

    const snapshot = await buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
    });

    expect(snapshot.lifecycle.items[0]).toMatchObject({
      kind: 'pull-request',
      humanHold: true,
      humanReason: {
        phase: 'reviewing',
        code: 'review-escalation',
        detail: 'Current-head Human review record',
      },
    });
  });

  it('diagnoses a stable claim that contradicts an adopted PR for the same issue', async () => {
    const adopted = {
      ...page('page-2').nodes[0]!,
      headRefName: 'feature/adopted-42',
    };
    const source = reader({
      readPullRequests: async () => ({
        nodes: [adopted],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
      readBranchClaims: async () => [{
        issueNumber: 42,
        headRefName: 'autopilot/42',
        headOid: 'cccccccccccccccccccccccccccccccccccccccc',
        headCommittedAt: '2026-07-20T08:00:00.000Z',
        claimTrailers: [
          'Jinn-Autopilot-Protocol: 2',
          'Jinn-Autopilot-Phase: implement',
          'Jinn-Autopilot-Issue: 42',
          'Jinn-Autopilot-Attempt: 11111111-1111-4111-8111-111111111111',
          'Jinn-Autopilot-Runner: runner-a',
          'Jinn-Autopilot-Login: trusted',
          `Jinn-Autopilot-Expected-Head: ${HEAD}`,
          'Jinn-Autopilot-Target-Base: next',
          'Jinn-Autopilot-Claimed-At: 2026-07-20T08:00:00.000Z',
        ].join('\n'),
      }],
    });

    const snapshot = await buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
    });

    expect(snapshot.lifecycle.items).toEqual([]);
    expect(snapshot.diagnostics).toEqual([
      expect.objectContaining({
        code: 'branch-mapping-ambiguous',
        issueNumbers: [42],
        detail: expect.stringContaining('stable branch'),
        pullRequests: [expect.objectContaining({ number: 101 })],
      }),
    ]);
  });

  it('diagnoses a Human marker whose issue contradicts the resolved PR mapping', async () => {
    const contradictory = {
      ...page('page-2').nodes[0]!,
      humanIssueNumber: 43,
      humanReason: {
        phase: 'implementing' as const,
        code: 'implementation-escalation' as const,
        detail: 'Needs product judgment',
      },
    };
    const actualIssue43Pr = {
      ...page('page-2').nodes[0]!,
      number: 102,
      headRefName: 'autopilot/43',
      headOid: 'cccccccccccccccccccccccccccccccccccccccc',
      closingIssueNumbers: [43],
      reviews: [],
      reviewClaim: null,
      humanReason: null,
    };
    const source = reader({
      readIssues: async () => [issue(), { ...issue(), number: 43 }],
      readPullRequests: async () => ({
        nodes: [contradictory, actualIssue43Pr],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    });

    const snapshot = await buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
    });

    expect(snapshot.lifecycle.items).toEqual([]);
    expect(snapshot.diagnostics).toEqual([
      expect.objectContaining({
        code: 'branch-mapping-ambiguous',
        issueNumbers: [42, 43],
        detail: expect.stringContaining('Human marker issue #43'),
        pullRequests: [
          expect.objectContaining({ number: 101 }),
          expect.objectContaining({ number: 102 }),
        ],
      }),
    ]);
  });
});

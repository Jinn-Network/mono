import { describe, expect, it } from 'vitest';
import { deriveLifecycle } from '../../src/lifecycle/lifecycle.js';
import {
  planProjection,
  type ProjectionContext,
} from '../../src/lifecycle/projection.js';
import { gitOid, gitRefName, type LifecycleItem } from '../../src/lifecycle/types.js';

const HEAD = gitOid('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const REVIEW_OID = gitOid('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
const NOW = new Date('2026-07-20T12:00:00.000Z');

function item(
  overrides: Partial<Extract<LifecycleItem, { kind: 'pull-request' }>> = {},
): Extract<LifecycleItem, { kind: 'pull-request' }> {
  return {
    kind: 'pull-request',
    issueNumber: 42,
    prNumber: 101,
    v2Marked: true,
    projectStatus: 'Todo',
    labels: [],
    head: HEAD,
    headChangedAt: '2026-07-20T11:00:00.000Z',
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
      prNumber: 101,
      attempt: '11111111-1111-4111-8111-111111111111',
      runner: 'runner-a',
      login: 'implementer',
      expectedHead: HEAD,
      targetBase: gitRefName('next'),
      claimedAt: '2026-07-20T11:00:00.000Z',
    },
    ...overrides,
  };
}

function context(
  lifecycleItem: Extract<LifecycleItem, { kind: 'pull-request' }>,
  reviewRefOid?: typeof REVIEW_OID,
): ProjectionContext {
  return {
    view: deriveLifecycle({ items: [lifecycleItem] }, NOW, 2 * 60 * 60 * 1000),
    pullRequests: [{
      number: lifecycleItem.prNumber,
      reviewRefOid,
    }],
    orphanBranchClaims: [],
  };
}

describe('planProjection', () => {
  it('keeps engine:review on a draft v2 implementation PR', () => {
    const plan = planProjection(context(item({
      projectStatus: 'In Progress',
      labels: ['engine:review'],
      isDraft: true,
    })));

    expect(plan.actions).not.toContainEqual({
      kind: 'set-pr-label',
      prNumber: 101,
      expectedHead: HEAD,
      label: 'engine:review',
      present: false,
    });
  });

  it('repairs an implementation PR to In Progress and draft', () => {
    const plan = planProjection(context(item({
      projectStatus: 'Todo',
      isDraft: false,
    })));

    expect(plan.actions).toEqual([
      {
        kind: 'set-project-status',
        issueNumber: 42,
        expectedHead: HEAD,
        status: 'In Progress',
      },
      {
        kind: 'set-pr-draft',
        prNumber: 101,
        expectedHead: HEAD,
        draft: true,
      },
      {
        kind: 'set-pr-label',
        prNumber: 101,
        expectedHead: HEAD,
        label: 'engine:review',
        present: true,
      },
    ]);
  });

  it('repairs a phase-complete draft last and enrolls it for review', () => {
    const complete = item({
      branchClaim: {
        ...item().branchClaim!,
        phaseComplete: true,
      },
    });

    const plan = planProjection(context(complete));

    expect(plan.actions).toEqual([
      {
        kind: 'set-project-status',
        issueNumber: 42,
        expectedHead: HEAD,
        status: 'In Review',
      },
      {
        kind: 'set-pr-draft',
        prNumber: 101,
        expectedHead: HEAD,
        draft: false,
      },
      {
        kind: 'set-pr-label',
        prNumber: 101,
        expectedHead: HEAD,
        label: 'engine:review',
        present: true,
      },
    ]);
  });

  it('projects Human without autonomous recovery and uses a structured comment marker', () => {
    const held = item({
      headChangedAt: '2026-07-20T08:00:00.000Z',
      projectStatus: 'In Progress',
      labels: ['review:needs-human'],
      humanReason: {
        phase: 'implementing',
        code: 'implementation-escalation',
        detail: 'Needs product judgment',
      },
    });

    const plan = planProjection(context(held));

    expect(plan.actions).toContainEqual({
      kind: 'set-project-status',
      issueNumber: 42,
      expectedHead: HEAD,
      status: 'Human',
    });
    expect(plan.actions).toContainEqual({
      kind: 'ensure-human-comment',
      issueNumber: 42,
      prNumber: 101,
      expectedHead: HEAD,
      marker: '<!-- jinn-autopilot-human:v2 issue=42 pr=101 phase=implementing code=implementation-escalation -->',
      body: expect.stringContaining('Needs product judgment'),
    });
    expect(plan.actions.some((action) => action.kind === 'requeue-implementation')).toBe(false);
  });

  it('requeues only stale v2 implementation and exposes stale merge-prep without a write', () => {
    const staleImplementation = item({ headChangedAt: '2026-07-20T08:00:00.000Z' });
    const stalePrep = item({
      headChangedAt: '2026-07-20T08:00:00.000Z',
      branchClaim: {
        ...item().branchClaim!,
        phase: 'merge-prep',
        prNumber: 101,
      },
    });

    expect(planProjection(context(staleImplementation)).actions).toContainEqual({
      kind: 'requeue-implementation',
      issueNumber: 42,
      expectedHead: HEAD,
    });
    expect(planProjection(context(stalePrep)).actions).toContainEqual({
      kind: 'expose-merge-prep',
      prNumber: 101,
      expectedHead: HEAD,
    });
  });

  it('marks a stale review ref and completes recoverable verdict intent', () => {
    const reviewBase = item({
      branchClaim: undefined,
      isDraft: false,
      headChangedAt: '2026-07-20T08:00:00.000Z',
      reviewClaim: {
        kind: 'review-claim',
        protocolVersion: 2,
        prNumber: 101,
        generation: '22222222-2222-4222-8222-222222222222',
        attempt: '33333333-3333-4333-8333-333333333333',
        reviewer: 'reviewer',
        head: HEAD,
        state: 'active',
        recordedAt: '2026-07-20T08:00:00.000Z',
      },
    });
    expect(planProjection(context(reviewBase, REVIEW_OID)).actions).toContainEqual({
      kind: 'mark-review-stale',
      prNumber: 101,
      expectedHead: HEAD,
      expectedReviewRefOid: REVIEW_OID,
    });

    const intent = item({
      branchClaim: undefined,
      isDraft: true,
      reviewClaim: {
        ...reviewBase.reviewClaim!,
        state: 'verdict-intent',
        verdict: {
          marker: '44444444-4444-4444-8444-444444444444',
          state: 'REQUEST_CHANGES',
        },
      },
      terminalVerdict: {
        head: HEAD,
        marker: '44444444-4444-4444-8444-444444444444',
        state: 'REQUEST_CHANGES',
        recordedAt: '2026-07-20T11:00:00.000Z',
      },
    });
    expect(planProjection(context(intent, REVIEW_OID)).actions).toContainEqual({
      kind: 'complete-verdict-intent',
      prNumber: 101,
      expectedHead: HEAD,
      expectedReviewRefOid: REVIEW_OID,
      state: 'fixing',
    });
  });

  it('repairs claim-without-PR and merge-before-Done partial transitions', () => {
    const merged = item({
      merged: true,
      projectStatus: 'In Review',
      branchClaim: undefined,
      isDraft: false,
    });
    const mergedPlan = planProjection(context(merged));
    expect(mergedPlan.actions).toContainEqual({
      kind: 'set-project-status',
      issueNumber: 42,
      expectedHead: HEAD,
      status: 'Done',
    });

    const orphanContext: ProjectionContext = {
      view: { items: [] },
      pullRequests: [],
      orphanBranchClaims: [{
        issueNumber: 43,
        head: HEAD,
        headRefName: 'autopilot/43',
        headChangedAt: '2026-07-20T11:00:00.000Z',
        baseRefName: 'next',
        claimAttempt: '11111111-1111-4111-8111-111111111111',
        claimRunner: 'runner-a',
        projectStatus: 'Todo',
      }],
    };
    expect(planProjection(orphanContext).actions).toEqual([
      {
        kind: 'set-project-status',
        issueNumber: 43,
        expectedHead: HEAD,
        status: 'In Progress',
      },
      {
        kind: 'ensure-draft-pr',
        issueNumber: 43,
        expectedHead: HEAD,
        headRefName: 'autopilot/43',
        baseRefName: 'next',
      },
    ]);
  });

  it('preserves a Human hold instead of creating a PR for an orphan implementation claim', () => {
    const humanReason = {
      phase: 'implementing' as const,
      code: 'implementation-escalation' as const,
      detail: 'Waiting for an operator decision',
    };
    const orphanContext: ProjectionContext = {
      view: { items: [] },
      pullRequests: [],
      mappingDiagnostics: [],
      orphanBranchClaims: [{
        issueNumber: 43,
        head: HEAD,
        headRefName: 'autopilot/43',
        headChangedAt: '2026-07-20T11:00:00.000Z',
        baseRefName: 'next',
        claimAttempt: '11111111-1111-4111-8111-111111111111',
        claimRunner: 'runner-a',
        projectStatus: 'In Progress',
        humanHold: true,
        humanReason,
      }],
    };

    expect(planProjection(orphanContext).actions).toEqual([{
      kind: 'set-project-status',
      issueNumber: 43,
      expectedHead: HEAD,
      status: 'Human',
    }]);
  });

  it('projects every resolvable side of an ambiguous issue-to-PR mapping to Human', () => {
    const ambiguous: ProjectionContext = {
      view: { items: [] },
      pullRequests: [],
      orphanBranchClaims: [],
      mappingDiagnostics: [{
        code: 'branch-mapping-ambiguous',
        detail: 'PR #101 resolves issues #42 and #43',
        issueNumbers: [42, 43],
        issues: [
          { number: 42, projectStatus: 'Todo' },
          { number: 43, projectStatus: 'Human' },
        ],
        pullRequests: [{
          number: 101,
          head: HEAD,
          draft: false,
          labels: [],
        }],
      }],
    };

    expect(planProjection(ambiguous).actions).toEqual(expect.arrayContaining([
      {
        kind: 'set-project-status',
        issueNumber: 42,
        status: 'Human',
      },
      {
        kind: 'set-pr-draft',
        prNumber: 101,
        expectedHead: HEAD,
        draft: true,
      },
      {
        kind: 'set-pr-label',
        prNumber: 101,
        expectedHead: HEAD,
        label: 'engine:review',
        present: true,
      },
      {
        kind: 'set-pr-label',
        prNumber: 101,
        expectedHead: HEAD,
        label: 'review:needs-human',
        present: true,
      },
      expect.objectContaining({
        kind: 'ensure-human-comment',
        prNumber: 101,
        expectedHead: HEAD,
        body: expect.stringContaining('PR #101 resolves issues #42 and #43'),
      }),
    ]));
    expect(planProjection(ambiguous).actions).not.toContainEqual(
      expect.objectContaining({ issueNumber: 43, kind: 'set-project-status' }),
    );
  });
});

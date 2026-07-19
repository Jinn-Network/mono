import { describe, expect, it } from 'vitest';
import { deriveLifecycle, deriveRecovery, planCycle } from '../../src/lifecycle/lifecycle.js';
import { gitOid, gitRefName, type LifecycleItem, type LifecycleSnapshot } from '../../src/lifecycle/types.js';

const HEAD_A = gitOid('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const HEAD_B = gitOid('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
const NOW = new Date('2026-07-20T12:00:00.000Z');
const STALE_AFTER = 2 * 60 * 60 * 1000;

function implementation(overrides: Partial<Extract<LifecycleItem, { kind: 'pull-request' }>> = {}):
Extract<LifecycleItem, { kind: 'pull-request' }> {
  return {
    kind: 'pull-request',
    issueNumber: 42,
    prNumber: 101,
    v2Marked: true,
    projectStatus: 'Todo',
    labels: [],
    head: HEAD_A,
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
      runner: 'runner',
      login: 'implementer',
      expectedHead: HEAD_A,
      targetBase: gitRefName('next'),
      claimedAt: '2026-07-20T11:00:00.000Z',
    },
    ...overrides,
  };
}

function snapshot(...items: LifecycleItem[]): LifecycleSnapshot {
  return { items };
}

describe('deriveLifecycle', () => {
  it('uses branch claims as implementation ownership rather than Project or draft projections', () => {
    const [view] = deriveLifecycle(snapshot(implementation({
      projectStatus: 'In Review',
      isDraft: false,
    })), NOW, STALE_AFTER).items;

    expect(view).toMatchObject({ phase: 'implementing', stale: false });
  });

  it('marks only v2 branch work stale from the authoritative unchanged head time', () => {
    const oldHead = '2026-07-20T09:59:59.999Z';
    const [v2, legacy] = deriveLifecycle(snapshot(
      implementation({ headChangedAt: oldHead }),
      implementation({ issueNumber: 43, prNumber: 102, v2Marked: false, headChangedAt: oldHead }),
    ), NOW, STALE_AFTER).items;

    expect(v2).toMatchObject({
      phase: 'implementing',
      stale: true,
      staleReason: 'branch-head-unchanged',
      staleSince: '2026-07-20T11:59:59.999Z',
    });
    expect(legacy?.stale).toBe(false);
  });

  it('supersedes review immediately when its claimed head differs from the PR head', () => {
    const item = implementation({
      head: HEAD_B,
      isDraft: false,
      branchClaim: undefined,
      reviewClaim: {
        kind: 'review-claim',
        protocolVersion: 2,
        prNumber: 101,
        generation: '22222222-2222-4222-8222-222222222222',
        attempt: '33333333-3333-4333-8333-333333333333',
        reviewer: 'reviewer',
        head: HEAD_A,
        state: 'active',
        recordedAt: '2026-07-20T11:55:00.000Z',
      },
    });

    const [view] = deriveLifecycle(snapshot(item), NOW, STALE_AFTER).items;

    expect(view).toMatchObject({
      phase: 'awaiting-review',
      supersededReview: true,
      stale: false,
    });
  });

  it('requires both unchanged head and no matching terminal verdict before review is stale', () => {
    const reviewClaim = {
      kind: 'review-claim' as const,
      protocolVersion: 2 as const,
      prNumber: 101,
      generation: '22222222-2222-4222-8222-222222222222',
      attempt: '33333333-3333-4333-8333-333333333333',
      reviewer: 'reviewer',
      head: HEAD_A,
      state: 'active' as const,
      recordedAt: '2026-07-20T08:00:00.000Z',
    };
    const base = implementation({
      branchClaim: undefined,
      isDraft: false,
      headChangedAt: '2026-07-20T08:30:00.000Z',
      reviewClaim,
    });
    const [stale, verdictProgress] = deriveLifecycle(snapshot(
      base,
      {
        ...base,
        issueNumber: 43,
        prNumber: 102,
        reviewClaim: {
          ...reviewClaim,
          prNumber: 102,
          state: 'verdict-intent',
          verdict: {
            marker: '44444444-4444-4444-8444-444444444444',
            state: 'REQUEST_CHANGES',
          },
        },
        terminalVerdict: {
          head: HEAD_A,
          state: 'REQUEST_CHANGES',
          marker: '44444444-4444-4444-8444-444444444444',
          recordedAt: '2026-07-20T11:30:00.000Z',
        },
      },
    ), NOW, STALE_AFTER).items;

    expect(stale).toMatchObject({
      phase: 'reviewing',
      stale: true,
      staleReason: 'review-progress-unchanged',
    });
    expect(verdictProgress).toMatchObject({ phase: 'reviewing', stale: false });
  });

  it('never reaps a review that already has a matching terminal verdict', () => {
    const item = implementation({
      branchClaim: undefined,
      isDraft: false,
      headChangedAt: '2026-07-20T06:00:00.000Z',
      reviewClaim: {
        kind: 'review-claim',
        protocolVersion: 2,
        prNumber: 101,
        generation: '22222222-2222-4222-8222-222222222222',
        attempt: '33333333-3333-4333-8333-333333333333',
        reviewer: 'reviewer',
        head: HEAD_A,
        state: 'verdict-intent',
        recordedAt: '2026-07-20T06:00:00.000Z',
        verdict: {
          marker: '44444444-4444-4444-8444-444444444444',
          state: 'APPROVE',
        },
      },
      terminalVerdict: {
        head: HEAD_A,
        state: 'APPROVE',
        marker: '44444444-4444-4444-8444-444444444444',
        recordedAt: '2026-07-20T07:00:00.000Z',
      },
    });

    const [view] = deriveLifecycle(snapshot(item), NOW, STALE_AFTER).items;

    expect(view).toMatchObject({ phase: 'reviewing', stale: false });
  });

  it('does not treat a contradictory verdict state as matching progress', () => {
    const item = implementation({
      branchClaim: undefined,
      isDraft: false,
      headChangedAt: '2026-07-20T06:00:00.000Z',
      reviewClaim: {
        kind: 'review-claim',
        protocolVersion: 2,
        prNumber: 101,
        generation: '22222222-2222-4222-8222-222222222222',
        attempt: '33333333-3333-4333-8333-333333333333',
        reviewer: 'reviewer',
        head: HEAD_A,
        state: 'verdict-intent',
        recordedAt: '2026-07-20T06:00:00.000Z',
        verdict: {
          marker: '44444444-4444-4444-8444-444444444444',
          state: 'APPROVE',
        },
      },
      terminalVerdict: {
        head: HEAD_A,
        state: 'REQUEST_CHANGES',
        marker: '44444444-4444-4444-8444-444444444444',
        recordedAt: '2026-07-20T07:00:00.000Z',
      },
    });

    const [view] = deriveLifecycle(snapshot(item), NOW, STALE_AFTER).items;

    expect(view).toMatchObject({ phase: 'reviewing', stale: true });
  });

  it('applies Human as an overlay and preserves the underlying phase', () => {
    const [view] = deriveLifecycle(snapshot(implementation({
      projectStatus: 'Human',
      labels: ['review:needs-human'],
    })), NOW, STALE_AFTER).items;

    expect(view).toMatchObject({
      phase: 'human',
      underlyingPhase: 'implementing',
      stale: false,
    });
    expect(deriveRecovery(view!.item, NOW, STALE_AFTER)).toEqual([]);
  });

  it('keeps authoritative merged state terminal even when Human projection lags', () => {
    const [view] = deriveLifecycle(snapshot(implementation({
      merged: true,
      projectStatus: 'Human',
      labels: ['review:needs-human'],
    })), NOW, STALE_AFTER).items;

    expect(view).toMatchObject({ phase: 'merged', stale: false });
  });
});

describe('planCycle', () => {
  const eligible: LifecycleItem = {
    kind: 'issue',
    issueNumber: 7,
    v2Marked: true,
    projectStatus: 'Todo',
    labels: [],
    eligible: true,
  };
  const reviewable = implementation({
    issueNumber: 8,
    prNumber: 108,
    branchClaim: undefined,
    isDraft: false,
  });
  const capacity = {
    implementationSlots: 1,
    reviewSlots: 1,
    mergePrepSlots: 1,
    usableCredentialLanes: 1,
  };

  it('emits no mutations in observe mode and only stale recovery in recover mode', () => {
    const stale = implementation({ headChangedAt: '2026-07-20T08:00:00.000Z' });
    const view = deriveLifecycle(snapshot(eligible, reviewable, stale), NOW, STALE_AFTER);

    expect(planCycle(view, capacity, 'observe')).toEqual([]);
    expect(planCycle(view, capacity, 'recover')).toEqual([{
      kind: 'requeue-implementation',
      issueNumber: 42,
      expectedHead: HEAD_A,
    }]);
  });

  it('prioritizes implementation before review on one usable credential lane', () => {
    const view = deriveLifecycle(snapshot(reviewable, eligible), NOW, STALE_AFTER);

    expect(planCycle(view, capacity, 'active')).toEqual([{
      kind: 'claim-implementation',
      issueNumber: 7,
    }]);
  });
});

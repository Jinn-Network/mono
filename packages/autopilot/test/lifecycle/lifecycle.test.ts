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

  it('fails closed on a non-canonical branch progress timestamp', () => {
    const [view] = deriveLifecycle(snapshot(implementation({
      headChangedAt: '2026-07-20 08:00:00',
    })), NOW, STALE_AFTER).items;

    expect(view).toMatchObject({
      phase: 'human',
      underlyingPhase: 'implementing',
      stale: false,
      humanReason: {
        phase: 'implementing',
        code: 'invalid-branch-progress-time',
      },
    });
  });

  it('fails closed on future review progress evidence', () => {
    const [view] = deriveLifecycle(snapshot(implementation({
      branchClaim: undefined,
      isDraft: false,
      headChangedAt: '2026-07-20T12:00:00.001Z',
      reviewClaim: {
        kind: 'review-claim',
        protocolVersion: 2,
        prNumber: 101,
        generation: '22222222-2222-4222-8222-222222222222',
        attempt: '33333333-3333-4333-8333-333333333333',
        reviewer: 'reviewer',
        head: HEAD_A,
        state: 'active',
        recordedAt: '2026-07-20T11:00:00.000Z',
      },
    })), NOW, STALE_AFTER).items;

    expect(view).toMatchObject({
      phase: 'human',
      underlyingPhase: 'reviewing',
      stale: false,
      humanReason: {
        phase: 'reviewing',
        code: 'invalid-review-progress-time',
      },
    });
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

  it('supersedes old-head terminal verdicts before validating their timestamps', () => {
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
        state: 'verdict-intent',
        recordedAt: '2026-07-20T11:00:00.000Z',
        verdict: {
          marker: '44444444-4444-4444-8444-444444444444',
          state: 'APPROVE',
        },
      },
      terminalVerdict: {
        head: HEAD_A,
        state: 'APPROVE',
        marker: '44444444-4444-4444-8444-444444444444',
        recordedAt: '2026-07-20T12:00:00.001Z',
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

  it('gives a freshly won active review claim generation its own full staleness window', () => {
    // Election is the one permitted review progress event, exactly like the
    // branch claim commit for implement/merge-prep: a reviewer that wins a
    // claim on a backlogged (already >2h-old) PR head must not be immediately
    // reap-eligible.
    const item = implementation({
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
        head: HEAD_A,
        state: 'active',
        recordedAt: '2026-07-20T11:59:00.000Z',
      },
    });

    const [view] = deriveLifecycle(snapshot(item), NOW, STALE_AFTER).items;

    expect(view).toMatchObject({
      phase: 'reviewing',
      stale: false,
    });
  });

  it('a replacement claim on a >2h-old head gets its own full staleness window (no livelock)', () => {
    // Regression for the reaper livelock: every backlogged-PR review claim
    // generation -- not just the first one on a given head -- must start its
    // own fresh window when it wins election, however old the head is.
    const veryOldHead = '2026-07-20T02:00:00.000Z';
    const item = implementation({
      branchClaim: undefined,
      isDraft: false,
      headChangedAt: veryOldHead,
      reviewClaim: {
        kind: 'review-claim',
        protocolVersion: 2,
        prNumber: 101,
        generation: '66666666-6666-4666-8666-666666666666',
        attempt: '77777777-7777-4777-8777-777777777777',
        reviewer: 'replacement-reviewer',
        head: HEAD_A,
        state: 'active',
        recordedAt: '2026-07-20T11:55:00.000Z',
      },
    });

    const [view] = deriveLifecycle(snapshot(item), NOW, STALE_AFTER).items;

    expect(view).toMatchObject({ phase: 'reviewing', stale: false });
  });

  it('does not extend review liveness from a metadata-only transition within the same generation', () => {
    // verdict-intent is an intent-only metadata transition, not a permitted
    // progress event: it must not reset the clock the way winning the claim
    // does, so this is stale from the original (old) head time, not from the
    // recent recordedAt on this later record.
    const item = implementation({
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
        head: HEAD_A,
        state: 'verdict-intent',
        recordedAt: '2026-07-20T11:59:00.000Z',
        verdict: {
          marker: '44444444-4444-4444-8444-444444444444',
          state: 'REQUEST_CHANGES',
        },
      },
    });

    const [view] = deriveLifecycle(snapshot(item), NOW, STALE_AFTER).items;

    expect(view).toMatchObject({
      phase: 'reviewing',
      stale: true,
      staleSince: '2026-07-20T10:00:00.000Z',
      staleReason: 'review-progress-unchanged',
    });
  });

  it('fails closed on an invalid (future) review claim acquisition timestamp', () => {
    const item = implementation({
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
        head: HEAD_A,
        state: 'active',
        recordedAt: '2026-07-20T12:00:00.001Z',
      },
    });

    const [view] = deriveLifecycle(snapshot(item), NOW, STALE_AFTER).items;

    expect(view).toMatchObject({
      phase: 'human',
      underlyingPhase: 'reviewing',
      stale: false,
      humanReason: {
        phase: 'reviewing',
        code: 'invalid-review-progress-time',
      },
    });
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

  it('fails closed when matching terminal verdict progress is from the future', () => {
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
        recordedAt: '2026-07-20T12:00:00.001Z',
      },
    });

    const [view] = deriveLifecycle(snapshot(item), NOW, STALE_AFTER).items;

    expect(view).toMatchObject({
      phase: 'human',
      underlyingPhase: 'reviewing',
      stale: false,
      humanReason: {
        phase: 'reviewing',
        code: 'invalid-review-progress-time',
      },
    });
  });

  it('validates matching terminal verdict time before merge-ready planning', () => {
    const reviewClaim = {
      kind: 'review-claim' as const,
      protocolVersion: 2 as const,
      prNumber: 101,
      generation: '22222222-2222-4222-8222-222222222222',
      attempt: '33333333-3333-4333-8333-333333333333',
      reviewer: 'reviewer',
      head: HEAD_A,
      state: 'terminal-approved' as const,
      recordedAt: '2026-07-20T11:00:00.000Z',
      verdict: {
        marker: '44444444-4444-4444-8444-444444444444',
        state: 'APPROVE' as const,
      },
    };
    const mergeReady = implementation({
      branchClaim: undefined,
      isDraft: false,
      needsReview: false,
      approved: true,
      mergeState: 'clean',
      reviewClaim,
    });
    const view = deriveLifecycle(snapshot(
      {
        ...mergeReady,
        terminalVerdict: {
          head: HEAD_A,
          state: 'APPROVE',
          marker: '44444444-4444-4444-8444-444444444444',
          recordedAt: '2026-07-20T12:00:00.001Z',
        },
      },
      {
        ...mergeReady,
        issueNumber: 43,
        prNumber: 102,
        reviewClaim: { ...reviewClaim, prNumber: 102 },
        terminalVerdict: {
          head: HEAD_A,
          state: 'APPROVE',
          marker: '44444444-4444-4444-8444-444444444444',
          recordedAt: '2026-07-20 11:30:00',
        },
      },
    ), NOW, STALE_AFTER);

    expect(view.items).toEqual([
      expect.objectContaining({
        phase: 'human',
        underlyingPhase: 'merge-ready',
        stale: false,
        humanReason: expect.objectContaining({
          phase: 'reviewing',
          code: 'invalid-review-progress-time',
        }),
      }),
      expect.objectContaining({
        phase: 'human',
        underlyingPhase: 'merge-ready',
        stale: false,
        humanReason: expect.objectContaining({
          phase: 'reviewing',
          code: 'invalid-review-progress-time',
        }),
      }),
    ]);
    expect(planCycle(view, {
      implementationSlots: 0,
      reviewSlots: 0,
      mergePrepSlots: 0,
      usableCredentialLanes: 0,
    }, 'active')).toEqual([]);
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

  it('preserves an ordinary structured Human reason in the derived view', () => {
    const humanReason = {
      phase: 'implementing' as const,
      code: 'first-push' as const,
      detail: 'Waiting for a human to authorize the first push.',
    };
    const [view] = deriveLifecycle(snapshot(implementation({
      humanReason,
    })), NOW, STALE_AFTER).items;

    expect(view).toMatchObject({
      phase: 'human',
      underlyingPhase: 'implementing',
      humanReason,
      stale: false,
    });
  });

  it('preserves explicit Human reasons ahead of generated invalid-time reasons', () => {
    const implementationReason = {
      phase: 'implementing' as const,
      code: 'first-push' as const,
      detail: 'Waiting for first-push authorization.',
    };
    const reviewReason = {
      phase: 'reviewing' as const,
      code: 'review-escalation' as const,
      detail: 'A human must resolve the review.',
    };
    const reviewClaim = {
      kind: 'review-claim' as const,
      protocolVersion: 2 as const,
      prNumber: 102,
      generation: '22222222-2222-4222-8222-222222222222',
      attempt: '33333333-3333-4333-8333-333333333333',
      reviewer: 'reviewer',
      head: HEAD_A,
      state: 'verdict-intent' as const,
      recordedAt: '2026-07-20T11:00:00.000Z',
      verdict: {
        marker: '44444444-4444-4444-8444-444444444444',
        state: 'APPROVE' as const,
      },
    };

    const [invalidHeadTime, invalidVerdictTime] = deriveLifecycle(snapshot(
      implementation({
        humanReason: implementationReason,
        headChangedAt: '2026-07-20T12:00:00.001Z',
      }),
      implementation({
        issueNumber: 43,
        prNumber: 102,
        branchClaim: undefined,
        isDraft: false,
        humanReason: reviewReason,
        reviewClaim,
        terminalVerdict: {
          head: HEAD_A,
          state: 'APPROVE',
          marker: '44444444-4444-4444-8444-444444444444',
          recordedAt: '2026-07-20T12:00:00.001Z',
        },
      }),
    ), NOW, STALE_AFTER).items;

    expect(invalidHeadTime).toMatchObject({
      phase: 'human',
      humanReason: implementationReason,
      stale: false,
    });
    expect(invalidVerdictTime).toMatchObject({
      phase: 'human',
      humanReason: reviewReason,
      stale: false,
    });
  });

  it('keeps authoritative merged state terminal even when Human projection lags', () => {
    const [view] = deriveLifecycle(snapshot(implementation({
      merged: true,
      projectStatus: 'Human',
      labels: ['review:needs-human'],
    })), NOW, STALE_AFTER).items;

    expect(view).toMatchObject({ phase: 'merged', stale: false });
  });

  it('fails closed when claim metadata does not match its lifecycle item', () => {
    const branchIssueMismatch = implementation({
      branchClaim: {
        ...implementation().branchClaim!,
        issueNumber: 43,
      },
    });
    const branchPrMismatch = implementation({
      issueNumber: 43,
      prNumber: 102,
      branchClaim: {
        ...implementation().branchClaim!,
        issueNumber: 43,
        prNumber: 999,
      },
    });
    const reviewPrMismatch = implementation({
      issueNumber: 44,
      prNumber: 103,
      branchClaim: undefined,
      isDraft: false,
      reviewClaim: {
        kind: 'review-claim',
        protocolVersion: 2,
        prNumber: 999,
        generation: '22222222-2222-4222-8222-222222222222',
        attempt: '33333333-3333-4333-8333-333333333333',
        reviewer: 'reviewer',
        head: HEAD_A,
        state: 'active',
        recordedAt: '2026-07-20T11:00:00.000Z',
      },
    });

    const view = deriveLifecycle(
      snapshot(branchIssueMismatch, branchPrMismatch, reviewPrMismatch),
      NOW,
      STALE_AFTER,
    );

    expect(view.items).toEqual([
      expect.objectContaining({ phase: 'human', underlyingPhase: 'awaiting-review', stale: false }),
      expect.objectContaining({ phase: 'human', underlyingPhase: 'awaiting-review', stale: false }),
      expect.objectContaining({ phase: 'human', underlyingPhase: 'awaiting-review', stale: false }),
    ]);
    expect(planCycle(view, {
      implementationSlots: 3,
      reviewSlots: 3,
      mergePrepSlots: 3,
      usableCredentialLanes: 3,
    }, 'active')).toEqual([]);
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

  it('claims only normally reviewable PRs or stale draft review-fix recoveries', () => {
    const approvedWaitingForCi = implementation({
      issueNumber: 9,
      prNumber: 109,
      branchClaim: undefined,
      isDraft: false,
      needsReview: false,
      approved: true,
      mergeState: 'blocked',
    });
    const unrelatedDraft = implementation({
      issueNumber: 10,
      prNumber: 110,
      branchClaim: undefined,
      isDraft: true,
    });
    const staleReviewFix = implementation({
      issueNumber: 11,
      prNumber: 111,
      branchClaim: undefined,
      isDraft: true,
      reviewClaim: {
        kind: 'review-claim',
        protocolVersion: 2,
        prNumber: 111,
        generation: '22222222-2222-4222-8222-222222222222',
        attempt: '33333333-3333-4333-8333-333333333333',
        reviewer: 'reviewer',
        head: HEAD_A,
        state: 'stale',
        recordedAt: '2026-07-20T08:00:00.000Z',
      },
    });
    const view = deriveLifecycle(
      snapshot(approvedWaitingForCi, unrelatedDraft, staleReviewFix),
      NOW,
      STALE_AFTER,
    );

    expect(planCycle(view, {
      ...capacity,
      reviewSlots: 3,
      usableCredentialLanes: 3,
    }, 'active')).toEqual([{
      kind: 'claim-review',
      issueNumber: 11,
      prNumber: 111,
      head: HEAD_A,
      recoverFixes: true,
    }]);
  });

  it('reclaims stale v2 merge-prep from the current branch head', () => {
    const staleMergePrep = implementation({
      branchClaim: {
        ...implementation().branchClaim!,
        phase: 'merge-prep',
        prNumber: 101,
      },
      headChangedAt: '2026-07-20T08:00:00.000Z',
      approved: true,
      needsReview: false,
      mergeState: 'conflict',
    });
    const view = deriveLifecycle(snapshot(staleMergePrep), NOW, STALE_AFTER);

    expect(planCycle(view, capacity, 'active')).toEqual([
      {
        kind: 'requeue-merge-prep',
        prNumber: 101,
        expectedHead: HEAD_A,
      },
      {
        kind: 'claim-merge-prep',
        issueNumber: 42,
        prNumber: 101,
        head: HEAD_A,
        recoverStale: true,
      },
    ]);
  });

  it('fails closed on invalid merge-prep progress evidence', () => {
    const invalidMergePrep = implementation({
      branchClaim: {
        ...implementation().branchClaim!,
        phase: 'merge-prep',
        prNumber: 101,
      },
      headChangedAt: '2026-07-20 08:00:00',
      approved: true,
      needsReview: false,
      mergeState: 'conflict',
    });
    const [view] = deriveLifecycle(snapshot(invalidMergePrep), NOW, STALE_AFTER).items;

    expect(view).toMatchObject({
      phase: 'human',
      underlyingPhase: 'merge-prep',
      stale: false,
      humanReason: {
        phase: 'merge-prep',
        code: 'invalid-merge-progress-time',
      },
    });
    expect(planCycle({ items: [view!] }, capacity, 'active')).toEqual([]);
  });
});

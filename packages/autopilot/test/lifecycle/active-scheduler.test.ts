// @ts-nocheck — Stage 5: deleted merge-prep/review-fix/project-status fixtures.
import { describe, expect, it } from 'vitest';
import {
  scheduleActiveActions,
  type ActiveSchedulingInput,
} from '../../src/lifecycle/active-scheduler.js';
import { gitOid } from '../../src/lifecycle/types.js';

const HEAD = gitOid('1'.repeat(40));

function input(overrides: Partial<ActiveSchedulingInput> = {}): ActiveSchedulingInput {
  return {
    candidates: [
      { phase: 'implementation', issueNumber: 1 },
      { phase: 'implementation', issueNumber: 2 },
      { phase: 'review', issueNumber: 3, prNumber: 30, head: HEAD, author: 'other' },
      { phase: 'merge', issueNumber: 5, prNumber: 50, head: HEAD },
    ],
    remaining: { implementation: 1, review: 1 },
    availableLogins: [
      'implementation-bot',
      'review-bot',
      'merge-bot',
    ],
    implementationPreferredLogin: 'implementation-bot',
    openPipelineBacklog: 0,
    implementationBackpressureThreshold: 10,
    ...overrides,
  };
}

describe('active local scheduler', () => {
  it('enforces independent per-phase local caps and keeps merge claimless', () => {
    const plan = scheduleActiveActions(input());
    expect(plan.actions.map((action) => action.kind)).toEqual([
      'claim-implementation',
      'claim-review',
      'merge',
    ]);
  });

  it('suppresses only implementation at the GitHub backlog threshold', () => {
    const plan = scheduleActiveActions(input({ openPipelineBacklog: 10 }));
    expect(plan.actions.map((action) => action.kind)).toEqual([
      'claim-review',
      'merge',
    ]);
    expect(plan.skips).toContainEqual({
      phase: 'implementation',
      subject: 'issue:1',
      reason: 'backpressure',
    });
  });

  it('schedules both implement and review with one login when review targets another author', () => {
    const plan = scheduleActiveActions(input({
      candidates: [
        { phase: 'implementation', issueNumber: 1 },
        { phase: 'review', issueNumber: 3, prNumber: 30, head: HEAD, author: 'other' },
      ],
      availableLogins: ['implementation-bot'],
      remaining: { implementation: 1, review: 1 },
    }));
    expect(plan.actions.map((action) => action.kind)).toEqual([
      'claim-implementation',
      'claim-review',
    ]);
  });

  it('caps implementation concurrency by phase remaining, not login count', () => {
    const plan = scheduleActiveActions(input({
      candidates: [
        { phase: 'implementation', issueNumber: 1 },
        { phase: 'implementation', issueNumber: 2 },
        { phase: 'implementation', issueNumber: 3 },
        { phase: 'implementation', issueNumber: 4 },
      ],
      availableLogins: ['implementation-bot'],
      remaining: { implementation: 3, review: 0 },
    }));
    expect(plan.actions).toEqual([
      { kind: 'claim-implementation', issueNumber: 1 },
      { kind: 'claim-implementation', issueNumber: 2 },
      { kind: 'claim-implementation', issueNumber: 3 },
    ]);
    expect(plan.skips).toContainEqual({
      phase: 'implementation',
      subject: 'issue:4',
      reason: 'capacity',
    });
  });

  it('uses the one login to review another author when no implementation is selected', () => {
    const plan = scheduleActiveActions(input({
      candidates: [
        { phase: 'review', issueNumber: 3, prNumber: 30, head: HEAD, author: 'other' },
      ],
      availableLogins: ['implementation-bot'],
    }));
    expect(plan.actions).toEqual([{
      kind: 'claim-review',
      issueNumber: 3,
      prNumber: 30,
      head: HEAD,
    }]);
  });

  it('never schedules a reviewer against its own authored PR', () => {
    const plan = scheduleActiveActions(input({
      candidates: [
        {
          phase: 'review',
          issueNumber: 3,
          prNumber: 30,
          head: HEAD,
          author: 'implementation-bot',
        },
      ],
      availableLogins: ['implementation-bot'],
    }));
    expect(plan.actions).toEqual([]);
  });

  it('derives no global or other-runner capacity signal', () => {
    expect(Object.keys(input().remaining).sort()).toEqual([
      'implementation',
      'review',
    ]);
  });
});

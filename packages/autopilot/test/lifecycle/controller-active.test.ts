import { describe, expect, it } from 'vitest';
import {
  runLifecycleCycle,
  type LifecycleControllerDeps,
} from '../../src/lifecycle/controller.js';
import type { ReconciliationWriter } from '../../src/lifecycle/reconciler.js';
import type { GitHubLifecycleSnapshot } from '../../src/lifecycle/snapshot.js';
import { gitOid, gitRefName } from '../../src/lifecycle/types.js';

const NOW = new Date('2026-07-20T12:00:00.000Z');

function snapshot(status: 'Todo' | 'In Progress' = 'Todo'): GitHubLifecycleSnapshot {
  return {
    project: {
      items: [],
      rateLimit: {
        remaining: 4_000,
        used: 1_000,
        resetAt: '2026-07-20T13:00:00.000Z',
      },
      currentSprintIterationId: null,
    },
    issues: [],
    pullRequests: [],
    branches: [],
    diagnostics: [],
    lifecycle: {
      items: [{
        kind: 'issue',
        issueNumber: 42,
        v2Marked: status !== 'Todo',
        projectStatus: status,
        labels: [],
        eligible: true,
        eligibilityReason: 'eligible',
      }],
    },
    capturedAt: NOW.toISOString(),
  };
}

function writer(): ReconciliationWriter {
  return new Proxy({} as ReconciliationWriter, {
    get() {
      return async () => null;
    },
  });
}

function deps(
  overrides: Partial<LifecycleControllerDeps> = {},
): LifecycleControllerDeps {
  return {
    readSnapshot: async () => snapshot(),
    writer: writer(),
    now: () => NOW,
    staleAfterMs: 2 * 60 * 60_000,
    runnerId: 'runner-a',
    cycleId: () => 'cycle-1',
    active: {
      preflight: async () => ({ ok: true }),
      readLocalState: () => ({
        remaining: { implementation: 1, review: 1, mergePrep: 1 },
        availableLogins: ['implementation-bot'],
        implementationPreferredLogin: 'implementation-bot',
      }),
      implementationBackpressureThreshold: 10,
      executeAction: async () => ({ outcome: 'spawned' }),
    },
    ...overrides,
  };
}

describe('active lifecycle controller', () => {
  it('fails closed on capability preflight before snapshot or mutation', async () => {
    let reads = 0;
    let actions = 0;
    const controller = deps({
      readSnapshot: async () => {
        reads += 1;
        return snapshot();
      },
      active: {
        preflight: async () => ({ ok: false, detail: 'atomic multi-ref unsupported' }),
        readLocalState: () => ({
          remaining: { implementation: 1, review: 1, mergePrep: 1 },
          availableLogins: ['implementation-bot'],
          implementationPreferredLogin: 'implementation-bot',
        }),
        implementationBackpressureThreshold: 10,
        executeAction: async () => {
          actions += 1;
          return { outcome: 'unexpected' };
        },
      },
    });
    const report = await runLifecycleCycle('active', controller);
    expect(report).toMatchObject({
      status: 'rejected',
      message: 'active capability preflight failed: atomic multi-ref unsupported',
    });
    expect({ reads, actions }).toEqual({ reads: 0, actions: 0 });
  });

  it('claims only in explicit active mode', async () => {
    const actions: string[] = [];
    const controller = deps();
    controller.active!.executeAction = async (action) => {
      actions.push(action.kind);
      return { outcome: 'spawned' };
    };
    const active = await runLifecycleCycle('active', controller);
    await runLifecycleCycle('observe', controller);
    expect(actions).toEqual(['claim-implementation']);
    expect(active.status).toBe('ok');
  });

  it('runs reconciliation first and defers claims after a correcting mutation attempt', async () => {
    let actions = 0;
    const controller = deps({
      readSnapshot: async () => snapshot('In Progress'),
    });
    controller.active!.executeAction = async () => {
      actions += 1;
      return { outcome: 'spawned' };
    };
    const report = await runLifecycleCycle('active', controller);
    expect(actions).toBe(0);
    expect(report.status).toBe('ok');
  });

  it('isolates action failures and emits safe structured reasons', async () => {
    const controller = deps();
    controller.active!.executeAction = async () => {
      throw new Error('claim lost without token material');
    };
    const report = await runLifecycleCycle('active', controller);
    expect(report.status).toBe('ok');
    if (report.status !== 'ok') throw new Error('expected active report');
    expect(report.events).toEqual([expect.objectContaining({
      mode: 'active',
      phase: 'eligible',
      action: 'claim-implementation',
      outcome: 'failed',
      reason: 'claim lost without token material',
    })]);
  });

  it('treats a reaped stale draft as an ordinary implementation claim on its existing branch', async () => {
    const head = gitOid('1'.repeat(40));
    const reaped: GitHubLifecycleSnapshot = {
      project: {
        items: [],
        rateLimit: {
          remaining: 4_000,
          used: 1_000,
          resetAt: '2026-07-20T13:00:00.000Z',
        },
        currentSprintIterationId: null,
      },
      issues: [],
      branches: [],
      diagnostics: [],
      pullRequests: [{
        number: 84,
        title: 'stale implementation',
        body: 'Closes #42\n\n<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->',
        author: 'implementation-bot',
        baseRefName: 'next',
        headRefName: 'autopilot/42',
        headOid: head,
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
          head,
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
            runner: 'runner-old',
            login: 'implementation-bot',
            expectedHead: head,
            targetBase: gitRefName('next'),
            claimedAt: '2026-07-20T08:00:00.000Z',
          },
        }],
      },
      capturedAt: NOW.toISOString(),
    };
    const actions: unknown[] = [];
    const controller = deps({ readSnapshot: async () => reaped });
    controller.active!.executeAction = async (action) => {
      actions.push(action);
      return { outcome: 'spawned' };
    };

    await runLifecycleCycle('active', controller);
    expect(actions).toEqual([{
      kind: 'claim-implementation',
      issueNumber: 42,
    }]);
  });

  it('exposes and reclaims stale merge-prep in the same cycle without replacing a live claim', async () => {
    const head = gitOid('2'.repeat(40));
    const base = gitOid('3'.repeat(40));
    const stalePrep: GitHubLifecycleSnapshot = {
      project: {
        items: [],
        rateLimit: {
          remaining: 4_000,
          used: 1_000,
          resetAt: '2026-07-20T13:00:00.000Z',
        },
        currentSprintIterationId: null,
      },
      issues: [],
      branches: [],
      diagnostics: [],
      pullRequests: [{
        number: 84,
        title: 'stale prep',
        body: 'Closes #42\n\n<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->',
        author: 'implementation-bot',
        baseRefName: 'next',
        headRefName: 'autopilot/42',
        headOid: head,
        headCommittedAt: '2026-07-20T08:00:00.000Z',
        isDraft: true,
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
          head,
          headChangedAt: '2026-07-20T08:00:00.000Z',
          isDraft: true,
          merged: false,
          needsReview: false,
          approved: true,
          mergeState: 'conflict',
          branchClaim: {
            kind: 'branch-claim',
            protocolVersion: 2,
            phase: 'merge-prep',
            issueNumber: 42,
            prNumber: 84,
            attempt: '22222222-2222-4222-8222-222222222222',
            runner: 'runner-old',
            login: 'implementation-bot',
            expectedHead: gitOid('1'.repeat(40)),
            targetBase: gitRefName('next'),
            targetBaseOid: base,
            claimedAt: '2026-07-20T08:00:00.000Z',
          },
        }],
      },
      capturedAt: NOW.toISOString(),
    };
    const actions: unknown[] = [];
    const controller = deps({ readSnapshot: async () => stalePrep });
    controller.active!.executeAction = async (action) => {
      actions.push(action);
      return { outcome: 'spawned' };
    };

    const report = await runLifecycleCycle('active', controller);
    expect(actions).toEqual([{
      kind: 'claim-merge-prep',
      issueNumber: 42,
      prNumber: 84,
      head,
      recoverStale: true,
    }]);
    if (report.status !== 'ok') throw new Error('expected active report');
    expect(report.reconciliation?.results).toEqual([
      expect.objectContaining({ outcome: 'eligible' }),
    ]);
  });

  it('keeps a stale review-fix PR draft and schedules the same fix-loop recovery', async () => {
    const head = gitOid('4'.repeat(40));
    const reviewRef = gitOid('5'.repeat(40));
    const staleFix: GitHubLifecycleSnapshot = {
      project: {
        items: [],
        rateLimit: {
          remaining: 4_000,
          used: 1_000,
          resetAt: '2026-07-20T13:00:00.000Z',
        },
        currentSprintIterationId: null,
      },
      issues: [],
      branches: [],
      diagnostics: [],
      pullRequests: [{
        number: 84,
        title: 'stale fixes',
        body: 'Closes #42\n\n<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->',
        author: 'implementation-bot',
        baseRefName: 'next',
        headRefName: 'autopilot/42',
        headOid: head,
        headCommittedAt: '2026-07-20T08:00:00.000Z',
        isDraft: true,
        state: 'OPEN',
        labels: ['engine:review'],
        closingIssueNumbers: [42],
        mergeability: 'UNKNOWN',
        mergeStateStatus: 'BLOCKED',
        checks: [],
        reviews: [],
        reviewClaim: {
          oid: reviewRef,
          record: {
            kind: 'review-claim',
            protocolVersion: 2,
            prNumber: 84,
            generation: '33333333-3333-4333-8333-333333333333',
            attempt: '44444444-4444-4444-8444-444444444444',
            reviewer: 'review-bot',
            head,
            state: 'stale',
            recordedAt: '2026-07-20T08:00:00.000Z',
          },
        },
      }],
      lifecycle: {
        items: [{
          kind: 'pull-request',
          issueNumber: 42,
          prNumber: 84,
          v2Marked: true,
          projectStatus: 'In Review',
          labels: ['engine:review'],
          head,
          headChangedAt: '2026-07-20T08:00:00.000Z',
          isDraft: true,
          merged: false,
          needsReview: true,
          approved: false,
          mergeState: 'blocked',
          reviewClaim: {
            kind: 'review-claim',
            protocolVersion: 2,
            prNumber: 84,
            generation: '33333333-3333-4333-8333-333333333333',
            attempt: '44444444-4444-4444-8444-444444444444',
            reviewer: 'review-bot',
            head,
            state: 'stale',
            recordedAt: '2026-07-20T08:00:00.000Z',
          },
        }],
      },
      capturedAt: NOW.toISOString(),
    };
    const actions: unknown[] = [];
    const controller = deps({ readSnapshot: async () => staleFix });
    controller.active!.readLocalState = () => ({
      remaining: { implementation: 1, review: 1, mergePrep: 1 },
      availableLogins: ['review-bot'],
      implementationPreferredLogin: 'review-bot',
    });
    controller.active!.executeAction = async (action) => {
      actions.push(action);
      return { outcome: 'spawned' };
    };

    const report = await runLifecycleCycle('active', controller);
    expect(actions).toEqual([{
      kind: 'claim-review',
      issueNumber: 42,
      prNumber: 84,
      head,
      recoverFixes: true,
    }]);
    if (report.status !== 'ok') throw new Error('expected active report');
    expect(report.reconciliation?.results).toEqual([]);
  });
});

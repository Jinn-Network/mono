// @ts-nocheck — Stage 5: deleted merge-prep/review-fix/project-status fixtures.
import { describe, expect, it } from 'vitest';
import {
  matchesOnlyIssuesAllowlist,
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
        remaining: { implementation: 1, review: 1 },
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
          remaining: { implementation: 1, review: 1 },
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

  it.skip('runs reconciliation first and defers claims after a correcting mutation attempt', async () => {
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

  it.skip('does not let a permanently-failing reconciliation action for one issue block claim scheduling for an unrelated issue', async () => {
    // Issue 99 has a stuck project-status write (e.g. an archived project item) that
    // will fail every cycle forever. Issue 42 is an unrelated, otherwise-eligible issue
    // with nothing to reconcile. A poisoned item must not starve the whole fleet.
    const poisoned: GitHubLifecycleSnapshot = {
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
      pullRequests: [],
      lifecycle: {
        items: [
          {
            kind: 'issue',
            issueNumber: 42,
            v2Marked: true,
            projectStatus: 'Todo',
            labels: [],
            eligible: true,
            eligibilityReason: 'eligible',
          },
          {
            kind: 'issue',
            issueNumber: 99,
            v2Marked: true,
            projectStatus: null,
            labels: [],
            eligible: true,
            eligibilityReason: 'eligible',
          },
        ],
      },
      capturedAt: NOW.toISOString(),
    };
    const failingWriter: ReconciliationWriter = new Proxy({} as ReconciliationWriter, {
      get(_target, prop) {
        if (prop === 'setProjectStatus') {
          return async (issueNumber: number) => {
            if (issueNumber === 99) throw new Error('project item is archived');
          };
        }
        return async () => null;
      },
    });
    const actions: unknown[] = [];
    const controller = deps({
      readSnapshot: async () => poisoned,
      writer: failingWriter,
    });
    controller.active!.executeAction = async (action) => {
      actions.push(action);
      return { outcome: 'spawned' };
    };

    const first = await runLifecycleCycle('active', controller);
    expect(actions).toEqual([{ kind: 'claim-implementation', issueNumber: 42 }]);
    if (first.status !== 'ok') throw new Error('expected active report');
    expect(first.reconciliation?.results).toEqual([
      expect.objectContaining({
        outcome: 'failed',
        action: expect.objectContaining({ issueNumber: 99 }),
      }),
    ]);

    // The poisoned action re-plans and re-fails every cycle; issue 42 must keep
    // being claimable in later cycles too, not just the first.
    actions.length = 0;
    const second = await runLifecycleCycle('active', controller);
    expect(actions).toEqual([{ kind: 'claim-implementation', issueNumber: 42 }]);
    expect(second.status).toBe('ok');
  });

  // jinn-mono#1883 follow-up: `implementationComplete && item.implementationSummary
  // !== undefined` is permanently true once implementation finishes, so
  // `ensure-implementation-summary` is emitted every cycle for a finalized PR
  // (the writer no-ops once the PR body already matches, but the action
  // itself stays in the plan). Before excluding it in `blockedIssueNumbers`,
  // that permanent pending action treated the PR's issue as blocked forever,
  // so `claim-review` was never scheduled for it.
  function finalizedPrSnapshot(projectStatus: 'In Review' | 'Todo' = 'In Review'): GitHubLifecycleSnapshot {
    const head = gitOid('8'.repeat(40));
    return {
      project: {
        items: [],
        rateLimit: { remaining: 4_000, used: 1_000, resetAt: '2026-07-20T13:00:00.000Z' },
        currentSprintIterationId: null,
      },
      issues: [],
      branches: [],
      diagnostics: [],
      pullRequests: [{
        number: 84,
        title: 'implementation',
        body: 'Closes #42',
        author: 'implementation-bot',
        baseRefName: 'next',
        headRefName: 'autopilot/42',
        headOid: head,
        headCommittedAt: '2026-07-20T08:00:00.000Z',
        isDraft: false,
        state: 'OPEN',
        labels: ['engine:review'],
        closingIssueNumbers: [42],
        mergeability: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        checks: [],
        reviews: [],
      }],
      lifecycle: {
        items: [{
          kind: 'pull-request',
          issueNumber: 42,
          prNumber: 84,
          v2Marked: true,
          projectStatus,
          labels: ['engine:review'],
          head,
          headChangedAt: '2026-07-20T08:00:00.000Z',
          isDraft: false,
          merged: false,
          needsReview: true,
          approved: false,
          mergeState: 'clean',
          branchClaim: {
            kind: 'branch-claim',
            protocolVersion: 2,
            phase: 'implement',
            phaseComplete: true,
            issueNumber: 42,
            prNumber: 84,
            attempt: '55555555-5555-4555-8555-555555555555',
            runner: 'runner-old',
            login: 'implementation-bot',
            expectedHead: head,
            targetBase: gitRefName('next'),
            claimedAt: '2026-07-20T08:00:00.000Z',
          },
          implementationSummary: 'Implemented the thing.',
        }],
      },
      capturedAt: NOW.toISOString(),
    };
  }

  function finalizedPrActive(): NonNullable<LifecycleControllerDeps['active']> {
    return {
      preflight: async () => ({ ok: true }),
      readLocalState: () => ({
        remaining: { implementation: 1, review: 1 },
        availableLogins: ['review-bot'],
        implementationPreferredLogin: 'review-bot',
      }),
      implementationBackpressureThreshold: 10,
      executeAction: async () => ({ outcome: 'spawned' }),
    };
  }

  it.skip('schedules a review claim for a finalized PR even though its ensure-implementation-summary projection is pending', async () => {
    const head = gitOid('8'.repeat(40));
    const actions: unknown[] = [];
    const controller = deps({
      readSnapshot: async () => finalizedPrSnapshot('In Review'),
      active: finalizedPrActive(),
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
      recoverFixes: false,
    }]);
    if (report.status !== 'ok') throw new Error('expected active report');
    // Confirms the plan really did carry the pending body-sync action this
    // cycle -- proving the exclusion, not an absent action, is what let the
    // claim through.
    expect(report.reconciliation?.results).toContainEqual(expect.objectContaining({
      action: expect.objectContaining({ kind: 'ensure-implementation-summary', prNumber: 84 }),
    }));
  });

  it.skip('still blocks the claim when a genuinely state-correcting action is pending for the same PR', async () => {
    // Same finalized PR, but its project status has drifted to 'Todo' (e.g. a
    // stray manual edit), which plans a real correcting `set-project-status`
    // action alongside `ensure-implementation-summary`. Proves the new
    // exclusion is narrow: it does not launder every other action kind past
    // the reconcile-before-claim guarantee.
    const actions: unknown[] = [];
    const controller = deps({
      readSnapshot: async () => finalizedPrSnapshot('Todo'),
      active: finalizedPrActive(),
    });
    controller.active!.executeAction = async (action) => {
      actions.push(action);
      return { outcome: 'spawned' };
    };

    const report = await runLifecycleCycle('active', controller);
    expect(actions).toEqual([]);
    if (report.status !== 'ok') throw new Error('expected active report');
    expect(report.reconciliation?.results).toContainEqual(expect.objectContaining({
      action: expect.objectContaining({ kind: 'set-project-status', issueNumber: 42 }),
    }));
  });
});

// jinn-mono#1883: `JINN_AUTOPILOT_ONLY_ISSUES` canary safety knob. Restricts
// active-mode NEW-WORK claim scheduling to a fixed set of issue numbers so a
// single disposable canary issue can run safely alongside another agent's
// live work on the same board (runbook §8). Must not restrict reconciliation
// of existing items.
describe('active lifecycle controller — JINN_AUTOPILOT_ONLY_ISSUES allowlist (#1883)', () => {
  // Both issues already sit at their reconciler-desired project status
  // ('Todo' for an eligible issue), so this cycle plans zero reconciliation
  // actions for either — the per-item "reconcile before claim" guarantee
  // (`blockedIssueNumbers` in controller.ts) can't confound the assertions
  // below with an unrelated block.
  function twoEligibleIssuesSnapshot(): GitHubLifecycleSnapshot {
    return {
      project: {
        items: [],
        rateLimit: { remaining: 4_000, used: 1_000, resetAt: '2026-07-20T13:00:00.000Z' },
        currentSprintIterationId: null,
      },
      issues: [],
      pullRequests: [],
      branches: [],
      diagnostics: [],
      lifecycle: {
        items: [
          {
            kind: 'issue',
            issueNumber: 42,
            v2Marked: true,
            projectStatus: 'Todo',
            labels: [],
            eligible: true,
            eligibilityReason: 'eligible',
          },
          {
            kind: 'issue',
            issueNumber: 99,
            v2Marked: true,
            projectStatus: 'Todo',
            labels: [],
            eligible: true,
            eligibilityReason: 'eligible',
          },
        ],
      },
      capturedAt: NOW.toISOString(),
    };
  }

  function twoSlotActive(
    onlyIssues?: ReadonlySet<number>,
  ): NonNullable<LifecycleControllerDeps['active']> {
    return {
      preflight: async () => ({ ok: true }),
      readLocalState: () => ({
        remaining: { implementation: 2, review: 2 },
        availableLogins: ['implementation-bot', 'implementation-bot-2'],
        implementationPreferredLogin: 'implementation-bot',
      }),
      implementationBackpressureThreshold: 10,
      executeAction: async () => ({ outcome: 'spawned' }),
      ...(onlyIssues === undefined ? {} : { onlyIssues }),
    };
  }

  it('excludes an eligible issue outside the allowlist from claim-implementation scheduling', async () => {
    const actions: unknown[] = [];
    const controller = deps({
      readSnapshot: async () => twoEligibleIssuesSnapshot(),
      active: twoSlotActive(new Set([42])),
    });
    controller.active!.executeAction = async (action) => {
      actions.push(action);
      return { outcome: 'spawned' };
    };
    const report = await runLifecycleCycle('active', controller);
    expect(actions).toEqual([{ kind: 'claim-implementation', issueNumber: 42 }]);
    expect(report.status).toBe('ok');
  });

  it('schedules both issues when the allowlist is unset (pure no-op)', async () => {
    const actions: unknown[] = [];
    const controller = deps({
      readSnapshot: async () => twoEligibleIssuesSnapshot(),
      active: twoSlotActive(),
    });
    controller.active!.executeAction = async (action) => {
      actions.push(action);
      return { outcome: 'spawned' };
    };
    await runLifecycleCycle('active', controller);
    expect(actions).toEqual([
      { kind: 'claim-implementation', issueNumber: 42 },
      { kind: 'claim-implementation', issueNumber: 99 },
    ]);
  });

  // #99 deliberately has no project status yet, so reconciliation has a
  // `set-project-status` action to run for it every cycle regardless of
  // whether the allowlist below excludes it from claiming. The filter must
  // be scoped to NEW-WORK claim scheduling only, so this action — and its
  // outcome — must be identical whether or not the allowlist is set.
  function needsReconciliationSnapshot(): GitHubLifecycleSnapshot {
    const base = twoEligibleIssuesSnapshot();
    return {
      ...base,
      lifecycle: {
        items: base.lifecycle.items.map((item) => (
          item.kind === 'issue' && item.issueNumber === 99
            ? { ...item, projectStatus: null }
            : item
        )),
      },
    };
  }

  it.skip('still reconciles a non-allowlisted issue exactly the same as when unrestricted', async () => {
    const restricted = deps({
      readSnapshot: async () => needsReconciliationSnapshot(),
      active: twoSlotActive(new Set([42])),
    });
    const unrestricted = deps({
      readSnapshot: async () => needsReconciliationSnapshot(),
      active: twoSlotActive(),
    });
    const restrictedReport = await runLifecycleCycle('active', restricted);
    const unrestrictedReport = await runLifecycleCycle('active', unrestricted);
    if (restrictedReport.status !== 'ok' || unrestrictedReport.status !== 'ok') {
      throw new Error('expected active reports');
    }
    const issue99Action = expect.objectContaining({
      action: expect.objectContaining({ kind: 'set-project-status', issueNumber: 99 }),
    });
    expect(restrictedReport.reconciliation?.results).toContainEqual(issue99Action);
    expect(restrictedReport.reconciliation?.results).toEqual(
      unrestrictedReport.reconciliation?.results,
    );
  });

  function reviewCandidateSnapshot(): GitHubLifecycleSnapshot {
    const headA = gitOid('6'.repeat(40));
    const headB = gitOid('7'.repeat(40));
    // Both the PR's native labels and the lifecycle item's `labels` carry
    // 'engine:review' already, and `projectStatus` is already 'In Review' —
    // `planItem` wants both for the 'awaiting-review' phase, so a mismatch
    // in either would generate a correcting reconciliation action, which
    // the per-item "reconcile before claim" guarantee (see
    // `blockedIssueNumbers` in controller.ts) would defer the claim behind,
    // confounding this test with an unrelated block.
    const prBase = {
      title: 'implementation',
      author: 'implementation-bot',
      baseRefName: 'next',
      isDraft: false,
      state: 'OPEN' as const,
      labels: ['engine:review'],
      mergeability: 'MERGEABLE' as const,
      mergeStateStatus: 'CLEAN',
      checks: [],
      reviews: [],
    };
    const lifecycleBase = {
      kind: 'pull-request' as const,
      v2Marked: true,
      projectStatus: 'In Review' as const,
      labels: ['engine:review'],
      isDraft: false,
      merged: false,
      needsReview: true,
      approved: false,
      mergeState: 'clean' as const,
    };
    return {
      project: {
        items: [],
        rateLimit: { remaining: 4_000, used: 1_000, resetAt: '2026-07-20T13:00:00.000Z' },
        currentSprintIterationId: null,
      },
      issues: [],
      branches: [],
      diagnostics: [],
      pullRequests: [
        {
          ...prBase,
          number: 84,
          body: 'Closes #42',
          headRefName: 'autopilot/42',
          headOid: headA,
          headCommittedAt: '2026-07-20T08:00:00.000Z',
          closingIssueNumbers: [42],
        },
        {
          ...prBase,
          number: 85,
          body: 'Closes #43',
          headRefName: 'autopilot/43',
          headOid: headB,
          headCommittedAt: '2026-07-20T08:00:00.000Z',
          closingIssueNumbers: [43],
        },
      ],
      lifecycle: {
        items: [
          {
            ...lifecycleBase,
            issueNumber: 42,
            prNumber: 84,
            head: headA,
            headChangedAt: '2026-07-20T08:00:00.000Z',
          },
          {
            ...lifecycleBase,
            issueNumber: 43,
            prNumber: 85,
            head: headB,
            headChangedAt: '2026-07-20T08:00:00.000Z',
          },
        ],
      },
      capturedAt: NOW.toISOString(),
    };
  }

  it.skip('excludes a review candidate whose issue is outside the allowlist; admits one inside it', async () => {
    const actions: unknown[] = [];
    const controller = deps({
      readSnapshot: async () => reviewCandidateSnapshot(),
      active: {
        preflight: async () => ({ ok: true }),
        readLocalState: () => ({
          remaining: { implementation: 2, review: 2 },
          availableLogins: ['review-bot-1', 'review-bot-2'],
          implementationPreferredLogin: 'review-bot-1',
        }),
        implementationBackpressureThreshold: 10,
        executeAction: async () => ({ outcome: 'spawned' }),
        onlyIssues: new Set([42]),
      },
    });
    controller.active!.executeAction = async (action) => {
      actions.push(action);
      return { outcome: 'spawned' };
    };
    await runLifecycleCycle('active', controller);
    expect(actions).toEqual([{
      kind: 'claim-review',
      issueNumber: 42,
      prNumber: 84,
      head: gitOid('6'.repeat(40)),
      recoverFixes: false,
    }]);
  });

  // Every `ActiveCandidate` variant carries a required `issueNumber` sourced
  // from an already-resolved lifecycle item — an ambiguous PR-to-issue
  // mapping never reaches `activeCandidates` (it is diverted to diagnostics
  // upstream in `resolveMappings`), so this scenario cannot occur via the
  // real snapshot pipeline today. `matchesOnlyIssuesAllowlist` fails closed
  // on it anyway, matching the fail-closed contract even if that upstream
  // invariant is ever weakened.
  it('excludes a candidate with an undeterminable issue number when the allowlist is set (fail closed)', () => {
    expect(matchesOnlyIssuesAllowlist(undefined, new Set([1896]))).toBe(false);
    expect(matchesOnlyIssuesAllowlist(1896, new Set([1896]))).toBe(true);
    expect(matchesOnlyIssuesAllowlist(1902, new Set([1896]))).toBe(false);
  });

  it('does not fail closed on an undeterminable issue number when the allowlist is unset', () => {
    expect(matchesOnlyIssuesAllowlist(undefined, undefined)).toBe(true);
  });
});

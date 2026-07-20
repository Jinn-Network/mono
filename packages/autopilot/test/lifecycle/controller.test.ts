import { describe, expect, it } from 'vitest';
import {
  explainIssue,
  explainPullRequest,
  parseLifecycleCli,
  renderLifecycleJson,
  runLifecycleCycle,
  type LifecycleControllerDeps,
} from '../../src/lifecycle/controller.js';
import type { GitHubLifecycleSnapshot } from '../../src/lifecycle/snapshot.js';
import {
  gitOid,
  gitRefName,
  type LifecycleItem,
} from '../../src/lifecycle/types.js';
import type { ReconciliationWriter } from '../../src/lifecycle/reconciler.js';

const HEAD = gitOid('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const NOW = new Date('2026-07-20T12:00:00.000Z');

function implementation(
  overrides: Partial<Extract<LifecycleItem, { kind: 'pull-request' }>> = {},
): Extract<LifecycleItem, { kind: 'pull-request' }> {
  return {
    kind: 'pull-request',
    issueNumber: 42,
    prNumber: 101,
    v2Marked: true,
    projectStatus: 'Todo',
    labels: ['engine:review'],
    head: HEAD,
    headChangedAt: '2026-07-20T11:00:00.000Z',
    isDraft: false,
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

function snapshot(item: LifecycleItem): GitHubLifecycleSnapshot {
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
    pullRequests: item.kind === 'pull-request'
      ? [{
          number: item.prNumber,
          title: 'feat: lifecycle',
          body: 'Closes #42',
          author: 'trusted',
          baseRefName: 'next',
          headRefName: 'autopilot/42',
          headOid: item.head,
          headCommittedAt: item.headChangedAt,
          isDraft: item.isDraft,
          state: item.merged ? 'MERGED' : 'OPEN',
          labels: item.labels,
          closingIssueNumbers: [item.issueNumber],
          mergeability: 'UNKNOWN',
          mergeStateStatus: 'BLOCKED',
          checks: [],
          reviews: [],
          ...(item.branchClaim === undefined ? {} : { branchClaim: item.branchClaim }),
        }]
      : [],
    branches: [],
    diagnostics: [],
    lifecycle: { items: [item] },
    capturedAt: NOW.toISOString(),
  };
}

function throwingWriter(calls: string[]): ReconciliationWriter {
  return new Proxy({} as ReconciliationWriter, {
    get(_target, property) {
      return async () => {
        calls.push(String(property));
        throw new Error('writer called');
      };
    },
  });
}

function deps(
  item: LifecycleItem,
  calls: string[],
  writer: ReconciliationWriter = throwingWriter(calls),
): LifecycleControllerDeps {
  return {
    readSnapshot: async () => snapshot(item),
    writer,
    now: () => NOW,
    staleAfterMs: 2 * 60 * 60 * 1000,
    runnerId: 'runner-a',
    cycleId: () => 'cycle-1',
  };
}

describe('lifecycle controller', () => {
  it('defaults to observe and maps dry-run to one observe cycle', () => {
    expect(parseLifecycleCli([])).toEqual({
      mode: 'observe',
      once: false,
      command: { kind: 'status' },
      json: false,
    });
    expect(parseLifecycleCli(['--dry-run', '--mode', 'recover'])).toEqual({
      mode: 'observe',
      once: true,
      command: { kind: 'status' },
      json: false,
    });
    expect(parseLifecycleCli(['--once', '--mode', 'recover'])).toMatchObject({
      mode: 'recover',
      once: true,
    });
  });

  it('observe reports desired actions without any writer call', async () => {
    const calls: string[] = [];
    const report = await runLifecycleCycle('observe', deps(implementation(), calls));

    expect(report.status).toBe('ok');
    expect(calls).toEqual([]);
    expect(report.items[0]).toMatchObject({
      phase: 'implementing',
      issueNumber: 42,
      prNumber: 101,
      head: HEAD,
      claimGeneration: '11111111-1111-4111-8111-111111111111',
      progressAgeMs: 60 * 60 * 1000,
      desiredActions: [
        { kind: 'set-project-status' },
        { kind: 'set-pr-draft' },
      ],
    });
  });

  it('recover applies projection only and emits structured safe events', async () => {
    const calls: string[] = [];
    let status: 'Todo' | 'In Progress' = 'Todo';
    let draft = false;
    const writer: ReconciliationWriter = {
      ...throwingWriter(calls),
      readIssueHead: async () => HEAD,
      readProjectStatus: async () => status,
      setProjectStatus: async (_issue, desired) => {
        calls.push('setProjectStatus');
        status = desired as typeof status;
      },
      readPullRequest: async () => ({ head: HEAD, draft, labels: [] }),
      setPullRequestDraft: async (_pr, desired) => {
        calls.push('setPullRequestDraft');
        draft = desired;
      },
    };

    const report = await runLifecycleCycle('recover', deps(implementation(), calls, writer));

    expect(calls).toEqual(['setProjectStatus', 'setPullRequestDraft']);
    expect(report.events).toEqual([
      expect.objectContaining({
        cycleId: 'cycle-1',
        runnerId: 'runner-a',
        mode: 'recover',
        phase: 'implementing',
        subject: 'issue:42/pr:101',
        head: HEAD,
        action: 'set-project-status',
        outcome: 'applied',
      }),
      expect.objectContaining({
        action: 'set-pr-draft',
        outcome: 'applied',
      }),
    ]);
    expect(JSON.stringify(report.events)).not.toMatch(/token/i);
  });

  it('makes two recover controllers planning the same correction converge', async () => {
    const calls: string[] = [];
    let status: 'Todo' | 'In Progress' = 'Todo';
    let draft = false;
    const writer: ReconciliationWriter = {
      ...throwingWriter(calls),
      readIssueHead: async () => HEAD,
      readProjectStatus: async () => status,
      setProjectStatus: async (_issue, desired) => {
        calls.push('setProjectStatus');
        status = desired as typeof status;
      },
      readPullRequest: async () => ({ head: HEAD, draft, labels: [] }),
      setPullRequestDraft: async (_pr, desired) => {
        calls.push('setPullRequestDraft');
        draft = desired;
      },
    };
    const controller = deps(implementation(), calls, writer);

    const first = await runLifecycleCycle('recover', controller);
    const second = await runLifecycleCycle('recover', controller);

    expect(first.events.map((event) => event.outcome)).toEqual(['applied', 'applied']);
    expect(second.events.map((event) => event.outcome)).toEqual([
      'already-applied',
      'already-applied',
    ]);
    expect(calls).toEqual(['setProjectStatus', 'setPullRequestDraft']);
  });

  it('rejects active mode before reading or writing', async () => {
    const calls: string[] = [];
    const controller = deps(implementation(), calls);
    controller.readSnapshot = async () => {
      calls.push('readSnapshot');
      return snapshot(implementation());
    };

    const report = await runLifecycleCycle('active', controller);

    expect(report).toMatchObject({
      status: 'rejected',
      message: 'active executor not configured',
    });
    expect(calls).toEqual([]);
  });

  it('reports legacy stale-looking items without reaping them', async () => {
    const calls: string[] = [];
    const legacy = implementation({
      v2Marked: false,
      branchClaim: undefined,
      headChangedAt: '2026-07-20T06:00:00.000Z',
      isDraft: false,
    });

    const report = await runLifecycleCycle('recover', deps(legacy, calls));

    expect(report.items[0]).toMatchObject({ stale: false, legacy: true });
    expect(report.items[0]?.desiredActions.some((action) => (
      action.kind === 'requeue-implementation'
      || action.kind === 'mark-review-stale'
    ))).toBe(false);
    expect(calls).toEqual([]);
  });

  it('renders JSON and explains issue and PR gate state', async () => {
    const calls: string[] = [];
    const report = await runLifecycleCycle('observe', deps(implementation(), calls));

    expect(JSON.parse(renderLifecycleJson(report))).toMatchObject({
      mode: 'observe',
      items: [{ issueNumber: 42, prNumber: 101, phase: 'implementing' }],
    });
    expect(explainIssue(report, 42)).toContain('implementing');
    expect(explainPullRequest(report, 101)).toContain('awaiting');
  });

  it('rejects trailing positional arguments for every operator command', () => {
    expect(() => parseLifecycleCli(['status', 'extra'])).toThrow(/Expected status/);
    expect(() => parseLifecycleCli(['sessions', 'extra'])).toThrow(/Expected status/);
    expect(() => parseLifecycleCli(['explain', 'issue', '42', 'extra'])).toThrow(
      /Expected status/,
    );
  });

  it('does not describe an ineligible no-PR issue as claim eligible', async () => {
    const calls: string[] = [];
    const blocked: LifecycleItem = {
      kind: 'issue',
      issueNumber: 42,
      v2Marked: false,
      projectStatus: 'Todo',
      labels: [],
      eligible: false,
      eligibilityReason: 'dependency-blocked',
      eligibilityDetail: 'Blocked by unresolved issue #41',
    };

    const report = await runLifecycleCycle('observe', deps(blocked, calls));

    expect(report.items[0]).toMatchObject({
      issueNumber: 42,
      eligible: false,
      eligibilityReason: 'dependency-blocked',
    });
    expect(explainIssue(report, 42)).toContain('not eligible');
    expect(explainIssue(report, 42)).toContain('Blocked by unresolved issue #41');
  });

  it('uses a later matching terminal verdict as the progress age', async () => {
    const calls: string[] = [];
    const reviewed = implementation({
      branchClaim: undefined,
      headChangedAt: '2026-07-20T08:00:00.000Z',
      reviewClaim: {
        kind: 'review-claim',
        protocolVersion: 2,
        prNumber: 101,
        generation: '22222222-2222-4222-8222-222222222222',
        attempt: '33333333-3333-4333-8333-333333333333',
        reviewer: 'reviewer',
        head: HEAD,
        state: 'verdict-intent',
        recordedAt: '2026-07-20T08:00:00.000Z',
        verdict: {
          marker: '44444444-4444-4444-8444-444444444444',
          state: 'REQUEST_CHANGES',
        },
      },
      terminalVerdict: {
        head: HEAD,
        marker: '44444444-4444-4444-8444-444444444444',
        state: 'REQUEST_CHANGES',
        recordedAt: '2026-07-20T11:30:00.000Z',
      },
    });

    const report = await runLifecycleCycle('observe', deps(reviewed, calls));

    expect(report.items[0]?.progressAgeMs).toBe(30 * 60 * 1000);
  });

  it('carries Project Human evidence through orphan-claim recovery planning', async () => {
    const calls: string[] = [];
    const heldIssue: LifecycleItem = {
      kind: 'issue',
      issueNumber: 42,
      v2Marked: false,
      projectStatus: 'In Progress',
      labels: ['review:needs-human'],
      humanHold: true,
      humanReason: {
        phase: 'eligible',
        code: 'implementation-escalation',
        detail: 'Project Blocked on is Human',
      },
      eligible: false,
      eligibilityReason: 'not-selected',
      eligibilityDetail: 'Project Blocked on is Human',
    };
    const heldSnapshot: GitHubLifecycleSnapshot = {
      ...snapshot(heldIssue),
      project: {
        ...snapshot(heldIssue).project,
        items: [{
          id: 'PVTI_42',
          number: 42,
          contentType: 'Issue',
          status: 'In Progress',
          priority: 'P1',
          effort: 'Medium',
          blockedOn: 'Human',
          issueType: 'feat',
          blockedByIssues: [],
          sprintIterationId: null,
        }],
      },
      branches: [{
        issueNumber: 42,
        headRefName: 'autopilot/42',
        headOid: HEAD,
        headCommittedAt: '2026-07-20T11:00:00.000Z',
        claim: implementation().branchClaim!,
      }],
    };

    const report = await runLifecycleCycle('observe', {
      ...deps(heldIssue, calls),
      readSnapshot: async () => heldSnapshot,
    });

    expect(report.items).toEqual([]);
    expect(report.orphanBranchClaims[0]).toMatchObject({
      kind: 'orphan-branch-claim',
      phase: 'human',
      issueNumber: 42,
      head: HEAD,
      headRefName: 'autopilot/42',
      claimAttempt: implementation().branchClaim!.attempt,
      claimRunner: 'runner-a',
      claimGeneration: implementation().branchClaim!.attempt,
      progressAgeMs: 60 * 60 * 1000,
      stale: false,
      v2Marked: true,
      humanHold: true,
      humanReason: {
        phase: 'implementing',
        detail: 'Project Blocked on is Human',
      },
    });
    expect(report.orphanBranchClaims[0]?.desiredActions).toEqual([{
      kind: 'set-project-status',
      issueNumber: 42,
      status: 'Human',
    }]);
    expect(JSON.stringify(report)).not.toContain('ensure-draft-pr');
    expect(calls).toEqual([]);
  });

  it('reports an orphan branch claim as active v2 implementation state with repair actions', async () => {
    const calls: string[] = [];
    const orphanIssue: LifecycleItem = {
      kind: 'issue',
      issueNumber: 42,
      v2Marked: false,
      projectStatus: 'Todo',
      labels: [],
      eligible: true,
      eligibilityReason: 'eligible',
      eligibilityDetail: 'All implementation admission gates pass',
    };
    const orphanSnapshot: GitHubLifecycleSnapshot = {
      ...snapshot(orphanIssue),
      branches: [{
        issueNumber: 42,
        headRefName: 'autopilot/42',
        headOid: HEAD,
        headCommittedAt: '2026-07-20T11:00:00.000Z',
        claim: implementation().branchClaim!,
      }],
    };

    const report = await runLifecycleCycle('observe', {
      ...deps(orphanIssue, calls),
      readSnapshot: async () => orphanSnapshot,
    });

    expect(report.items).toEqual([]);
    expect(report.orphanBranchClaims).toEqual([expect.objectContaining({
      kind: 'orphan-branch-claim',
      phase: 'implementing',
      issueNumber: 42,
      head: HEAD,
      headRefName: 'autopilot/42',
      claimAttempt: implementation().branchClaim!.attempt,
      claimRunner: 'runner-a',
      claimGeneration: implementation().branchClaim!.attempt,
      progressAgeMs: 60 * 60 * 1000,
      stale: false,
      v2Marked: true,
      humanHold: false,
      desiredActions: [
        {
          kind: 'set-project-status',
          issueNumber: 42,
          expectedHead: HEAD,
          status: 'In Progress',
        },
        {
          kind: 'ensure-draft-pr',
          issueNumber: 42,
          expectedHead: HEAD,
          headRefName: 'autopilot/42',
          baseRefName: 'next',
        },
      ],
    })]);
    expect(explainIssue(report, 42)).toContain('implementing');
    const json = JSON.parse(renderLifecycleJson(report));
    expect(json.items).toEqual([]);
    expect(json.orphanBranchClaims[0]).not.toHaveProperty('prNumber');
    expect(calls).toEqual([]);
  });

  it('never reopens Done or otherwise merged work because its stable ref was retained', async () => {
    const calls: string[] = [];
    const doneIssue: LifecycleItem = {
      kind: 'issue',
      issueNumber: 42,
      v2Marked: false,
      projectStatus: 'Done',
      labels: [],
      eligible: false,
      eligibilityReason: 'not-selected',
      eligibilityDetail: 'Project status is Done',
    };
    const doneSnapshot: GitHubLifecycleSnapshot = {
      ...snapshot(doneIssue),
      project: {
        ...snapshot(doneIssue).project,
        items: [{
          id: 'PVTI_42',
          number: 42,
          contentType: 'Issue',
          status: 'Done',
          priority: 'P1',
          effort: 'Medium',
          blockedOn: null,
          issueType: 'feat',
          blockedByIssues: [],
          sprintIterationId: null,
        }],
      },
      branches: [{
        issueNumber: 42,
        headRefName: 'autopilot/42',
        headOid: HEAD,
        headCommittedAt: '2026-07-20T08:00:00.000Z',
        claim: implementation().branchClaim!,
      }],
    };
    const doneReport = await runLifecycleCycle('observe', {
      ...deps(doneIssue, calls),
      readSnapshot: async () => doneSnapshot,
    });

    expect(doneReport.orphanBranchClaims).toEqual([]);
    expect(doneReport.items.flatMap((entry) => entry.desiredActions)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'set-project-status', status: 'In Progress' }),
        expect.objectContaining({ kind: 'ensure-draft-pr' }),
        expect.objectContaining({ kind: 'requeue-implementation' }),
      ]),
    );

    const merged = implementation({
      projectStatus: 'In Review',
      branchClaim: undefined,
      merged: true,
      isDraft: false,
    });
    const mergedSnapshot: GitHubLifecycleSnapshot = {
      ...snapshot(merged),
      pullRequests: [{
        ...snapshot(merged).pullRequests[0]!,
        headRefName: 'adopted/42',
      }],
      branches: [{
        issueNumber: 42,
        headRefName: 'autopilot/42',
        headOid: HEAD,
        headCommittedAt: '2026-07-20T08:00:00.000Z',
        claim: implementation().branchClaim!,
      }],
    };
    const mergedReport = await runLifecycleCycle('observe', {
      ...deps(merged, calls),
      readSnapshot: async () => mergedSnapshot,
    });

    expect(mergedReport.orphanBranchClaims).toEqual([]);
    expect(mergedReport.items).toEqual([
      expect.objectContaining({
        phase: 'merged',
        issueNumber: 42,
        desiredActions: [expect.objectContaining({
          kind: 'set-project-status',
          status: 'Done',
        })],
      }),
    ]);
  });

  it('fails orphan branch claims closed when canonical head progress time is invalid', async () => {
    const orphanIssue: LifecycleItem = {
      kind: 'issue',
      issueNumber: 42,
      v2Marked: false,
      projectStatus: 'In Progress',
      labels: [],
      eligible: false,
      eligibilityReason: 'not-selected',
      eligibilityDetail: 'Project status is In Progress',
    };

    for (const headCommittedAt of [
      '2026-07-20 11:00:00',
      '2026-07-20T12:00:00.001Z',
    ]) {
      const calls: string[] = [];
      const orphanSnapshot: GitHubLifecycleSnapshot = {
        ...snapshot(orphanIssue),
        branches: [{
          issueNumber: 42,
          headRefName: 'autopilot/42',
          headOid: HEAD,
          headCommittedAt,
          claim: implementation().branchClaim!,
        }],
      };

      const report = await runLifecycleCycle('observe', {
        ...deps(orphanIssue, calls),
        readSnapshot: async () => orphanSnapshot,
      });

      expect(report.orphanBranchClaims).toEqual([expect.objectContaining({
        phase: 'human',
        underlyingPhase: 'implementing',
        issueNumber: 42,
        stale: false,
        humanReason: {
          phase: 'implementing',
          code: 'invalid-branch-progress-time',
          detail: `Invalid branch head progress timestamp: ${headCommittedAt}`,
        },
      })]);
      expect(report.orphanBranchClaims[0]).not.toHaveProperty('progressAgeMs');
      expect(report.orphanBranchClaims[0]?.desiredActions).toEqual([{
        kind: 'set-project-status',
        issueNumber: 42,
        expectedHead: HEAD,
        status: 'Human',
      }]);
      expect(calls).toEqual([]);
    }
  });

  it('reports stale and phase-complete orphan claims with their distinct recovery actions', async () => {
    const orphanIssue: LifecycleItem = {
      kind: 'issue',
      issueNumber: 42,
      v2Marked: false,
      projectStatus: 'In Progress',
      labels: [],
      eligible: false,
      eligibilityReason: 'not-selected',
      eligibilityDetail: 'Project status is In Progress',
    };
    const staleSnapshot: GitHubLifecycleSnapshot = {
      ...snapshot(orphanIssue),
      branches: [{
        issueNumber: 42,
        headRefName: 'autopilot/42',
        headOid: HEAD,
        headCommittedAt: '2026-07-20T08:00:00.000Z',
        claim: implementation().branchClaim!,
      }],
    };
    const staleReport = await runLifecycleCycle('observe', {
      ...deps(orphanIssue, []),
      readSnapshot: async () => staleSnapshot,
    });

    expect(staleReport.orphanBranchClaims).toEqual([expect.objectContaining({
      phase: 'implementing',
      issueNumber: 42,
      progressAgeMs: 4 * 60 * 60 * 1000,
      stale: true,
      staleSince: '2026-07-20T10:00:00.000Z',
      staleReason: 'branch-head-unchanged',
      desiredActions: [
        {
          kind: 'ensure-draft-pr',
          issueNumber: 42,
          expectedHead: HEAD,
          headRefName: 'autopilot/42',
          baseRefName: 'next',
        },
        {
          kind: 'requeue-implementation',
          issueNumber: 42,
          expectedHead: HEAD,
        },
      ],
    })]);

    const completeSnapshot: GitHubLifecycleSnapshot = {
      ...staleSnapshot,
      branches: [{
        ...staleSnapshot.branches[0]!,
        claim: {
          ...staleSnapshot.branches[0]!.claim,
          phaseComplete: true,
        },
      }],
    };
    const completeReport = await runLifecycleCycle('observe', {
      ...deps(orphanIssue, []),
      readSnapshot: async () => completeSnapshot,
    });

    expect(completeReport.orphanBranchClaims).toEqual([expect.objectContaining({
      phase: 'awaiting-review',
      issueNumber: 42,
      progressAgeMs: 4 * 60 * 60 * 1000,
      stale: false,
      desiredActions: [
        {
          kind: 'ensure-draft-pr',
          issueNumber: 42,
          expectedHead: HEAD,
          headRefName: 'autopilot/42',
          baseRefName: 'next',
        },
        {
          kind: 'set-project-status',
          issueNumber: 42,
          expectedHead: HEAD,
          status: 'In Review',
        },
      ],
    })]);
  });

  it('emits Human phase for ambiguity reconciliation events', async () => {
    const calls: string[] = [];
    let status: 'Todo' | 'Human' = 'Todo';
    let draft = false;
    const labels = new Set<string>();
    const comments = new Set<string>();
    const writer: ReconciliationWriter = {
      ...throwingWriter(calls),
      readProjectStatus: async () => status,
      setProjectStatus: async (_issue, desired) => {
        status = desired as typeof status;
      },
      readPullRequest: async () => ({ head: HEAD, draft, labels: [...labels] }),
      setPullRequestDraft: async (_pr, desired) => {
        draft = desired;
      },
      setPullRequestLabel: async (_pr, label, present) => {
        if (present) labels.add(label);
        else labels.delete(label);
      },
      hasHumanComment: async (_pr, marker) => comments.has(marker),
      ensureHumanComment: async (_pr, marker) => {
        comments.add(marker);
      },
    };
    const ambiguousSnapshot: GitHubLifecycleSnapshot = {
      ...snapshot(implementation()),
      lifecycle: { items: [] },
      diagnostics: [{
        code: 'branch-mapping-ambiguous',
        detail: 'Stable branch claim contradicts adopted PR #101',
        issueNumbers: [42],
        issues: [{ number: 42, projectStatus: 'Todo' }],
        pullRequests: [{
          number: 101,
          head: HEAD,
          draft: false,
          labels: [],
        }],
      }],
    };

    const report = await runLifecycleCycle('recover', {
      ...deps(implementation(), calls, writer),
      readSnapshot: async () => ambiguousSnapshot,
    });

    expect(report.status).toBe('ok');
    expect(report.events).not.toHaveLength(0);
    expect(report.events.every((event) => event.phase === 'human')).toBe(true);
    expect([...labels].sort()).toEqual(['engine:review', 'review:needs-human']);
  });
});

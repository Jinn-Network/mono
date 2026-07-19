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
    labels: [],
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
      message: 'active writer not wired yet',
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
});

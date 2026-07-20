import { describe, expect, it } from 'vitest';
import {
  executeProjectionPlan,
  type ReconciliationWriter,
} from '../../src/lifecycle/reconciler.js';
import type { ProjectionAction } from '../../src/lifecycle/projection.js';
import { gitOid } from '../../src/lifecycle/types.js';

const HEAD = gitOid('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const CHANGED = gitOid('cccccccccccccccccccccccccccccccccccccccc');
const REVIEW = gitOid('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');

interface MutableState {
  head: typeof HEAD | typeof CHANGED;
  status: 'Todo' | 'In Progress' | 'Human' | 'In Review' | 'Done';
  draft: boolean;
  labels: Set<string>;
  comments: Set<string>;
  summary: string | null;
  prExists: boolean;
  review: {
    oid: typeof REVIEW;
    head: typeof HEAD | typeof CHANGED;
    state: 'active' | 'verdict-intent' | 'fixing' | 'terminal-approved' | 'stale';
  };
}

function writer(
  state: MutableState,
  calls: string[],
  failures: Set<string> = new Set(),
): ReconciliationWriter {
  const fail = (name: string): void => {
    if (failures.has(name)) throw new Error(`ambiguous ${name}`);
  };
  return {
    readIssueHead: async () => state.head,
    readBranchHead: async () => state.head,
    readProjectStatus: async () => state.status,
    setProjectStatus: async (_issue, status) => {
      calls.push('setProjectStatus');
      fail('setProjectStatus');
      state.status = status;
    },
    readPullRequest: async () => ({
      head: state.head,
      draft: state.draft,
      labels: [...state.labels],
    }),
    setPullRequestDraft: async (_pr, draft) => {
      calls.push('setPullRequestDraft');
      fail('setPullRequestDraft');
      state.draft = draft;
    },
    setPullRequestLabel: async (_pr, label, present) => {
      calls.push('setPullRequestLabel');
      fail('setPullRequestLabel');
      if (present) state.labels.add(label);
      else state.labels.delete(label);
    },
    hasHumanComment: async (_pr, marker) => state.comments.has(marker),
    ensureHumanComment: async (_pr, marker) => {
      calls.push('ensureHumanComment');
      fail('ensureHumanComment');
      state.comments.add(marker);
    },
    ensureImplementationSummary: async (_pr, expectedHead, summary) => {
      calls.push('ensureImplementationSummary');
      expect(expectedHead).toBe(state.head);
      fail('ensureImplementationSummary');
      state.summary = summary;
    },
    findOpenPullRequest: async () => state.prExists ? {
      number: 101,
      head: state.head,
      draft: state.draft,
      labels: [...state.labels],
    } : null,
    ensureDraftPullRequest: async () => {
      calls.push('ensureDraftPullRequest');
      fail('ensureDraftPullRequest');
      state.prExists = true;
      state.draft = true;
      state.labels.add('engine:review');
    },
    readReviewRef: async () => state.review,
    markReviewStale: async () => {
      calls.push('markReviewStale');
      fail('markReviewStale');
      state.review.state = 'stale';
    },
    completeVerdictIntent: async (_pr, _oid, desired) => {
      calls.push('completeVerdictIntent');
      fail('completeVerdictIntent');
      state.review.state = desired;
    },
  };
}

function initial(): MutableState {
  return {
    head: HEAD,
    status: 'Todo',
    draft: false,
    labels: new Set(),
    comments: new Set(),
    summary: null,
    prExists: false,
    review: { oid: REVIEW, head: HEAD, state: 'active' },
  };
}

describe('executeProjectionPlan', () => {
  it('recovers a durable implementation summary before making the PR ready', async () => {
    const state = initial();
    state.status = 'In Review';
    state.labels.add('engine:review');
    state.draft = true;
    const calls: string[] = [];
    const actions: ProjectionAction[] = [
      {
        kind: 'ensure-implementation-summary',
        prNumber: 101,
        expectedHead: HEAD,
        summary: 'Durable summary',
      },
      {
        kind: 'set-pr-draft',
        prNumber: 101,
        expectedHead: HEAD,
        draft: false,
      },
    ];

    const report = await executeProjectionPlan({ actions }, writer(state, calls));

    expect(report.results.map((result) => result.outcome)).toEqual(['applied', 'applied']);
    expect(state.summary).toBe('Durable summary');
    expect(state.draft).toBe(false);
    expect(calls).toEqual(['ensureImplementationSummary', 'setPullRequestDraft']);
  });

  it('stops a completion prerequisite chain after the first failed repair', async () => {
    const state = initial();
    state.status = 'Todo';
    state.draft = true;
    const calls: string[] = [];
    const actions: ProjectionAction[] = [
      {
        kind: 'ensure-implementation-summary',
        prNumber: 101,
        expectedHead: HEAD,
        summary: 'Durable summary',
      },
      {
        kind: 'set-pr-label',
        prNumber: 101,
        expectedHead: HEAD,
        label: 'engine:review',
        present: true,
        requiresPreviousSuccess: true,
      },
      {
        kind: 'set-project-status',
        issueNumber: 42,
        expectedHead: HEAD,
        status: 'In Review',
        requiresPreviousSuccess: true,
      },
      {
        kind: 'set-pr-draft',
        prNumber: 101,
        expectedHead: HEAD,
        draft: false,
        requiresPreviousSuccess: true,
      },
    ];

    const report = await executeProjectionPlan(
      { actions },
      writer(state, calls, new Set(['ensureImplementationSummary'])),
    );

    expect(report.results.map((result) => result.outcome)).toEqual([
      'failed',
      'awaiting-prerequisite',
      'awaiting-prerequisite',
      'awaiting-prerequisite',
    ]);
    expect(calls).toEqual(['ensureImplementationSummary']);
    expect(state.status).toBe('Todo');
    expect(state.draft).toBe(true);
  });

  it('keeps a failed completion summary scoped across an interleaved verdict-intent repair', async () => {
    const state = initial();
    state.status = 'Todo';
    state.draft = true;
    state.review.state = 'verdict-intent';
    const calls: string[] = [];
    const actions: ProjectionAction[] = [
      {
        kind: 'ensure-implementation-summary',
        prNumber: 101,
        expectedHead: HEAD,
        summary: 'Durable summary',
      },
      {
        kind: 'complete-verdict-intent',
        prNumber: 101,
        expectedHead: HEAD,
        expectedReviewRefOid: REVIEW,
        state: 'terminal-approved',
      },
      {
        kind: 'set-pr-label',
        prNumber: 101,
        expectedHead: HEAD,
        label: 'engine:review',
        present: true,
        requiresPreviousSuccess: true,
      },
      {
        kind: 'set-project-status',
        issueNumber: 42,
        expectedHead: HEAD,
        status: 'In Review',
        requiresPreviousSuccess: true,
      },
      {
        kind: 'set-pr-draft',
        prNumber: 101,
        expectedHead: HEAD,
        draft: false,
        requiresPreviousSuccess: true,
      },
    ];

    const report = await executeProjectionPlan(
      { actions },
      writer(state, calls, new Set(['ensureImplementationSummary'])),
    );

    expect(report.results.map((result) => result.outcome)).toEqual([
      'failed',
      'applied',
      'awaiting-prerequisite',
      'awaiting-prerequisite',
      'awaiting-prerequisite',
    ]);
    expect(calls).toEqual([
      'ensureImplementationSummary',
      'completeVerdictIntent',
    ]);
    expect(state.status).toBe('Todo');
    expect(state.draft).toBe(true);
  });

  it('re-reads and rejects every head-pinned correction after the head changes', async () => {
    const state = initial();
    state.head = CHANGED;
    state.review.head = CHANGED;
    const calls: string[] = [];
    const actions: ProjectionAction[] = [
      {
        kind: 'set-project-status',
        issueNumber: 42,
        expectedHead: HEAD,
        status: 'In Progress',
      },
      { kind: 'set-pr-draft', prNumber: 101, expectedHead: HEAD, draft: true },
      {
        kind: 'mark-review-stale',
        prNumber: 101,
        expectedHead: HEAD,
        expectedReviewRefOid: REVIEW,
      },
    ];

    const report = await executeProjectionPlan({ actions }, writer(state, calls));

    expect(calls).toEqual([]);
    expect(report.results.map((result) => result.outcome)).toEqual([
      'changed-head',
      'changed-head',
      'changed-head',
    ]);
  });

  it('isolates mutation failures and continues later actions', async () => {
    const state = initial();
    const calls: string[] = [];
    const actions: ProjectionAction[] = [
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
    ];

    const report = await executeProjectionPlan(
      { actions },
      writer(state, calls, new Set(['setPullRequestDraft'])),
    );

    expect(calls).toEqual(['setPullRequestDraft', 'setPullRequestLabel']);
    expect(report.results.map((result) => result.outcome)).toEqual(['failed', 'applied']);
    expect(state.labels.has('engine:review')).toBe(true);
  });

  it('resolves an ambiguous mutation by exact readback', async () => {
    const state = initial();
    const calls: string[] = [];
    const base = writer(state, calls);
    const ambiguousAfterApply: ReconciliationWriter = {
      ...base,
      setProjectStatus: async (_issue, status) => {
        calls.push('setProjectStatus');
        state.status = status;
        throw new Error('response lost');
      },
    };

    const report = await executeProjectionPlan({
      actions: [{
        kind: 'set-project-status',
        issueNumber: 42,
        expectedHead: HEAD,
        status: 'In Progress',
      }],
    }, ambiguousAfterApply);

    expect(report.results[0]?.outcome).toBe('already-applied');
  });

  it('leaves failed Project, draft, label, and comment projections retryable', async () => {
    const state = initial();
    const calls: string[] = [];
    const marker = '<!-- jinn-autopilot-human:v2 issue=42 pr=101 -->';
    const actions: ProjectionAction[] = [
      {
        kind: 'set-project-status',
        issueNumber: 42,
        expectedHead: HEAD,
        status: 'Human',
      },
      { kind: 'set-pr-draft', prNumber: 101, expectedHead: HEAD, draft: true },
      {
        kind: 'set-pr-label',
        prNumber: 101,
        expectedHead: HEAD,
        label: 'review:needs-human',
        present: true,
      },
      {
        kind: 'ensure-human-comment',
        issueNumber: 42,
        prNumber: 101,
        expectedHead: HEAD,
        marker,
        body: `${marker}\nHuman judgment needed.`,
      },
    ];
    const failures = new Set([
      'setProjectStatus',
      'setPullRequestDraft',
      'setPullRequestLabel',
      'ensureHumanComment',
    ]);

    const failed = await executeProjectionPlan({ actions }, writer(state, calls, failures));
    const retried = await executeProjectionPlan({ actions }, writer(state, calls));

    expect(failed.results.map((result) => result.outcome)).toEqual([
      'failed',
      'failed',
      'failed',
      'failed',
    ]);
    expect(retried.results.map((result) => result.outcome)).toEqual([
      'applied',
      'applied',
      'applied',
      'applied',
    ]);
    expect(state).toMatchObject({
      status: 'Human',
      draft: true,
    });
    expect(state.labels.has('review:needs-human')).toBe(true);
    expect(state.comments.has(marker)).toBe(true);
  });

  it('makes two reconcilers converge without a second writer call', async () => {
    const state = initial();
    const calls: string[] = [];
    const action: ProjectionAction = {
      kind: 'set-pr-label',
      prNumber: 101,
      expectedHead: HEAD,
      label: 'engine:review',
      present: true,
    };
    const port = writer(state, calls);

    const first = await executeProjectionPlan({ actions: [action] }, port);
    const second = await executeProjectionPlan({ actions: [action] }, port);

    expect(first.results[0]?.outcome).toBe('applied');
    expect(second.results[0]?.outcome).toBe('already-applied');
    expect(calls).toEqual(['setPullRequestLabel']);
  });

  it('repairs draft PR creation and review-ref transitions idempotently', async () => {
    const state = initial();
    const calls: string[] = [];
    const port = writer(state, calls);
    const actions: ProjectionAction[] = [
      {
        kind: 'ensure-draft-pr',
        issueNumber: 42,
        expectedHead: HEAD,
        headRefName: 'autopilot/42',
        baseRefName: 'next',
      },
      {
        kind: 'mark-review-stale',
        prNumber: 101,
        expectedHead: HEAD,
        expectedReviewRefOid: REVIEW,
      },
    ];

    await executeProjectionPlan({ actions }, port);
    const report = await executeProjectionPlan({ actions }, port);

    expect(state.prExists).toBe(true);
    expect(state.review.state).toBe('stale');
    expect(report.results.map((result) => result.outcome)).toEqual([
      'already-applied',
      'already-applied',
    ]);
    expect(calls).toEqual(['ensureDraftPullRequest', 'markReviewStale']);
  });

  it('repairs a concurrently discovered orphan PR instead of stopping at existence', async () => {
    const state = initial();
    state.prExists = true;
    state.status = 'Todo';
    state.draft = false;
    const calls: string[] = [];

    const report = await executeProjectionPlan({
      actions: [
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
    }, writer(state, calls));

    expect(report.results.map((result) => result.outcome)).toEqual(['applied', 'applied']);
    expect(calls).toEqual([
      'setProjectStatus',
      'setPullRequestDraft',
      'setPullRequestLabel',
    ]);
    expect(state.status).toBe('In Progress');
    expect(state.draft).toBe(true);
    expect(state.labels.has('engine:review')).toBe(true);
  });

  it('does not write synthetic progress for stale merge-prep exposure', async () => {
    const state = initial();
    const calls: string[] = [];
    const report = await executeProjectionPlan({
      actions: [{
        kind: 'expose-merge-prep',
        prNumber: 101,
        expectedHead: HEAD,
      }],
    }, writer(state, calls));

    expect(calls).toEqual([]);
    expect(report.results[0]?.outcome).toBe('eligible');
  });

  it('does not make a verdict-intent PR ready before the terminal ref transition', async () => {
    const state = initial();
    state.draft = true;
    state.review.state = 'verdict-intent';
    const calls: string[] = [];

    const report = await executeProjectionPlan({
      actions: [{
        kind: 'set-pr-draft',
        prNumber: 101,
        expectedHead: HEAD,
        draft: false,
        requiresReviewState: 'terminal-approved',
      }],
    }, writer(state, calls));

    expect(report.results[0]?.outcome).toBe('awaiting-prerequisite');
    expect(state.draft).toBe(true);
    expect(calls).toEqual([]);
  });
});

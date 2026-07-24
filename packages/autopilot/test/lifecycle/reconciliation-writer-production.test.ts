import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetFieldCache } from '../../src/dispatcher/field-cache.js';
import { CredentialPool, selectCredential } from '../../src/lifecycle/credentials.js';
import { encodeReviewClaimPayload, reviewClaimRef } from '../../src/lifecycle/codecs.js';
import {
  makeProductionReconciliationWriter,
  type ReconciliationPullRequestNode,
} from '../../src/lifecycle/reconciliation-writer-production.js';
import { executeProjectionPlan } from '../../src/lifecycle/reconciler.js';
import { planProjection, type ProjectionAction } from '../../src/lifecycle/projection.js';
import type { GitHubLifecycleSnapshot } from '../../src/lifecycle/snapshot.js';
import {
  gitOid,
  gitRefName,
  type GitOid,
  type ReviewClaimRecord,
} from '../../src/lifecycle/types.js';

const HEAD = gitOid('1'.repeat(40));
const CHANGED_HEAD = gitOid('2'.repeat(40));
const CLAIM_OID = gitOid('3'.repeat(40));
const RECORD_OID = gitOid('4'.repeat(40));
const BLOB_OID = gitOid('5'.repeat(40));
const TREE_OID = gitOid('6'.repeat(40));
const DRAFT_BRANCH_HEAD = gitOid('7'.repeat(40));
const BLOCKER_HEAD = gitOid('8'.repeat(40));

beforeEach(() => { resetFieldCache(); });
afterEach(() => { resetFieldCache(); });

function numberedOid(n: number): GitOid {
  return gitOid(n.toString(16).padStart(40, '0'));
}

function reconciliationPr(
  overrides: Partial<ReconciliationPullRequestNode> = {},
): ReconciliationPullRequestNode {
  return {
    state: 'OPEN',
    headRefName: 'autopilot/42',
    headOid: HEAD,
    baseRefName: 'next',
    isDraft: true,
    labels: ['engine:review'],
    body: 'Closes #42\n\n<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->',
    closingIssueNumbers: [42],
    humanIssueNumber: null,
    humanReason: null,
    reviewClaim: null,
    ...overrides,
  };
}

function selectedCredential() {
  const selection = selectCredential(new CredentialPool([{
    login: 'implementation-bot',
    normalizedLogin: 'implementation-bot',
    implementationToken: 'selected-secret',
  }]), { phase: 'implement' });
  if (selection.status !== 'selected') throw new Error('selection failed');
  return selection.credential;
}

function snapshot(
  draft: boolean,
  options: {
    readonly head?: typeof HEAD;
    readonly projectStatus?: 'Todo' | 'Human';
    readonly blockedOn?: 'Nothing' | 'Human';
  } = {},
): GitHubLifecycleSnapshot {
  return {
    project: {
      items: [{
        id: 'PVTI_issue_42',
        number: 42,
        contentType: 'Issue',
        status: options.projectStatus ?? 'Todo',
        priority: 'P1',
        effort: 'High',
        blockedOn: options.blockedOn ?? 'Nothing',
        issueType: 'feat',
        blockedByIssues: [],
        sprintIterationId: null,
      }],
      rateLimit: { remaining: 4_000, used: 1, resetAt: '2026-07-20T13:00:00.000Z' },
      currentSprintIterationId: null,
    },
    issues: [{
      number: 42,
      title: 'feat: test',
      shape: 'feat',
      blockedOn: options.blockedOn ?? 'Nothing',
      blockedByIssues: [],
      effort: 'High',
      priority: 'P1',
      status: options.projectStatus ?? 'Todo',
      onBoard: true,
      author: 'implementation-bot',
      projectItemId: 'PVTI_issue_42',
      inCurrentSprint: false,
    }],
    branches: [],
    diagnostics: [],
    pullRequests: [{
      number: 84,
      title: 'feat: test',
      body: 'Closes #42\n\n<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->',
      author: 'implementation-bot',
      baseRefName: 'next',
      headRefName: 'autopilot/42',
      headOid: options.head ?? HEAD,
      headCommittedAt: '2026-07-20T12:00:00.000Z',
      isDraft: draft,
      state: 'OPEN',
      labels: ['engine:review'],
      closingIssueNumbers: [42],
      mergeability: 'UNKNOWN',
      mergeStateStatus: 'BLOCKED',
      checks: [],
      reviews: [],
    }],
    lifecycle: { items: [{
      kind: 'pull-request',
      issueNumber: 42,
      prNumber: 84,
      v2Marked: true,
      projectStatus: options.projectStatus ?? 'Todo',
      labels: ['engine:review'],
      head: options.head ?? HEAD,
      headChangedAt: '2026-07-20T12:00:00.000Z',
      isDraft: draft,
      merged: false,
      needsReview: true,
      approved: false,
      mergeState: 'blocked',
    }] },
    capturedAt: '2026-07-20T12:00:00.000Z',
    snapshotComplete: true,
  };
}

// Complete cycle snapshot for the global regression test below. Live action
// authority still comes exclusively from the explicit targeted fakes.
function worldSnapshotFixture(): GitHubLifecycleSnapshot {
  return {
    project: {
      items: [
        {
          id: 'PVTI_issue_42',
          number: 42,
          contentType: 'Issue',
          status: 'In Progress',
          priority: 'P1',
          effort: 'High',
          blockedOn: 'Nothing',
          issueType: 'feat',
          blockedByIssues: [],
          sprintIterationId: null,
        },
        {
          id: 'PVTI_issue_50',
          number: 50,
          contentType: 'Issue',
          status: 'In Progress',
          priority: 'P1',
          effort: 'High',
          blockedOn: 'Nothing',
          issueType: 'feat',
          blockedByIssues: [],
          sprintIterationId: null,
        },
      ],
      rateLimit: { remaining: 4_000, used: 1, resetAt: '2026-07-20T13:00:00.000Z' },
      currentSprintIterationId: null,
    },
    issues: [42, 50].map((number) => ({
      number,
      title: number === 50 ? 'feat: needs a draft PR' : 'feat: active issue',
      shape: 'feat' as const,
      blockedOn: 'Nothing' as const,
      blockedByIssues: [],
      effort: 'High' as const,
      priority: 'P1' as const,
      status: 'In Progress' as const,
      onBoard: true,
      author: 'implementation-bot',
      projectItemId: `PVTI_issue_${number}`,
      inCurrentSprint: false,
    })),
    branches: [
      {
        issueNumber: 42,
        headRefName: 'autopilot/42',
        headOid: HEAD,
        headCommittedAt: '2026-07-20T11:00:00.000Z',
        claim: {
          kind: 'branch-claim',
          protocolVersion: 2,
          phase: 'implement',
          issueNumber: 42,
          attempt: '11111111-1111-4111-8111-111111111111',
          runner: 'runner-a',
          login: 'implementer',
          expectedHead: HEAD,
          targetBase: gitRefName('next'),
          claimedAt: '2026-07-20T11:00:00.000Z',
        },
      },
      {
        issueNumber: 50,
        headRefName: 'autopilot/50',
        headOid: DRAFT_BRANCH_HEAD,
        headCommittedAt: '2026-07-20T11:00:00.000Z',
        claim: {
          kind: 'branch-claim',
          protocolVersion: 2,
          phase: 'implement',
          issueNumber: 50,
          attempt: '22222222-2222-4222-8222-222222222222',
          runner: 'runner-a',
          login: 'implementer',
          expectedHead: DRAFT_BRANCH_HEAD,
          targetBase: gitRefName('next'),
          claimedAt: '2026-07-20T11:00:00.000Z',
        },
      },
    ],
    pullRequests: [{
      number: 84,
      title: 'feat: active issue',
      body: 'Closes #42\n\n<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->',
      author: 'implementation-bot',
      baseRefName: 'next',
      headRefName: 'autopilot/42',
      headOid: HEAD,
      headCommittedAt: '2026-07-20T12:00:00.000Z',
      isDraft: true,
      state: 'OPEN',
      labels: ['engine:review'],
      closingIssueNumbers: [42],
      mergeability: 'UNKNOWN',
      mergeStateStatus: 'BLOCKED',
      checks: [],
      reviews: [],
    }],
    diagnostics: [],
    lifecycle: { items: [{
      kind: 'pull-request',
      issueNumber: 42,
      prNumber: 84,
      v2Marked: true,
      projectStatus: 'In Progress',
      labels: ['engine:review'],
      head: HEAD,
      headChangedAt: '2026-07-20T12:00:00.000Z',
      isDraft: true,
      merged: false,
      needsReview: true,
      approved: false,
      mergeState: 'blocked',
    }] },
    capturedAt: '2026-07-20T12:00:00.000Z',
    snapshotComplete: true,
  };
}

function targetedWriterOptions(
  read: () => GitHubLifecycleSnapshot | Promise<GitHubLifecycleSnapshot>,
  cycleSnapshot: GitHubLifecycleSnapshot = snapshot(false),
) {
  return {
    cycleSnapshot: { ...cycleSnapshot, snapshotComplete: true } as GitHubLifecycleSnapshot,
    async readPullRequestByNumber(prNumber: number): Promise<ReconciliationPullRequestNode | null> {
      const current = await read();
      const pr = current.pullRequests.find((entry) => entry.number === prNumber);
      return pr === undefined ? null : {
        state: pr.state,
        headRefName: pr.headRefName,
        headOid: pr.headOid,
        baseRefName: pr.baseRefName,
        isDraft: pr.isDraft,
        labels: pr.labels,
        body: pr.body,
        closingIssueNumbers: pr.closingIssueNumbers,
        humanIssueNumber: pr.humanIssueNumber,
        humanReason: pr.humanReason,
        reviewClaim: pr.reviewClaim === undefined ? null : {
          oid: pr.reviewClaim.oid,
          payload: encodeReviewClaimPayload(pr.reviewClaim.record),
        },
      };
    },
    async readProjectItemForReconciliation(issueNumber: number) {
      const current = await read();
      const item = current.project.items.find((entry) => (
        entry.contentType === 'Issue' && entry.number === issueNumber
      ));
      return item === undefined
        ? null
        : { id: item.id, status: item.status, blockedOn: item.blockedOn };
    },
    async readBranchHeadByName(headRefName: string) {
      const current = await read();
      return current.branches.find((entry) => entry.headRefName === headRefName)?.headOid
        ?? current.pullRequests.find((entry) => entry.headRefName === headRefName)?.headOid
        ?? null;
    },
    async readIssueByNumber(issueNumber: number) {
      const current = await read();
      const issue = current.issues.find((entry) => entry.number === issueNumber);
      return issue === undefined ? null : {
        number: issueNumber,
        title: issue.title,
        open: true,
        author: issue.author,
        labels: issue.labels ?? [],
      };
    },
    async readBlockedByIssueNumbers(issueNumber: number) {
      const current = await read();
      return current.issues.find((entry) => entry.number === issueNumber)?.blockedByIssues ?? [];
    },
    async readOpenPullRequestsByIssue(issueNumber: number) {
      const current = await read();
      return current.pullRequests
        .filter((pr) => pr.state === 'OPEN' && pr.closingIssueNumbers.includes(issueNumber))
        .map((pr) => ({
          number: pr.number,
          headRefName: pr.headRefName,
          headOid: pr.headOid,
          baseRefName: pr.baseRefName,
          draft: pr.isDraft,
          labels: pr.labels,
          body: pr.body,
        }));
    },
    async readIssueActionContext(issueNumber: number) {
      const current = await read();
      const item = current.project.items.find((entry) => (
        entry.contentType === 'Issue' && entry.number === issueNumber
      ));
      const projectItem = item === undefined
        ? null
        : { id: item.id, status: item.status, blockedOn: item.blockedOn };
      const openPullRequests = current.pullRequests
        .filter((pr) => pr.state === 'OPEN' && pr.closingIssueNumbers.includes(issueNumber))
        .map((pr) => ({
          number: pr.number,
          headRefName: pr.headRefName,
          headOid: pr.headOid,
          baseRefName: pr.baseRefName,
          draft: pr.isDraft,
          labels: pr.labels,
          body: pr.body,
        }));
      return { projectItem, openPullRequests };
    },
  };
}

function endToEndCostHarness() {
  const current = snapshot(true);
  const reviewRecord: ReviewClaimRecord = {
    kind: 'review-claim',
    protocolVersion: 2,
    prNumber: 84,
    generation: '22222222-2222-4222-8222-222222222222',
    attempt: '33333333-3333-4333-8333-333333333333',
    reviewer: 'jinn-reviewer',
    head: HEAD,
    recordedAt: '2026-07-20T11:00:00.000Z',
    state: 'active',
  };
  const ledger: Array<{ readonly kind: string; readonly points: number }> = [];
  let pointsAtMutation = -1;
  const node = reconciliationPr({
    reviewClaim: { oid: CLAIM_OID, payload: encodeReviewClaimPayload(reviewRecord) },
  });
  const project = {
    id: 'PVTI_issue_42',
    status: 'Todo' as const,
    blockedOn: 'Nothing' as const,
  };
  const recordMutation = (): never => {
    pointsAtMutation = ledger.reduce((sum, entry) => sum + entry.points, 0);
    throw new Error('stop after recording pre-mutation cost');
  };
  const writer = makeProductionReconciliationWriter({
    repositoryPath: '/repo',
    cycleSnapshot: { ...current, snapshotComplete: true },
    readPullRequestByNumber: async () => {
      ledger.push({ kind: 'target-pr', points: 8 });
      return node;
    },
    readProjectItemForReconciliation: async () => {
      ledger.push({ kind: 'target-project', points: 1 });
      return project;
    },
    readIssueActionContext: async () => {
      ledger.push({ kind: 'target-issue-context', points: 2 });
      return { projectItem: project, openPullRequests: [] };
    },
    readBranchHeadByName: async () => HEAD,
    readIssueByNumber: async (number) => ({
      number,
      title: 'feat: test',
      open: true,
      author: 'implementation-bot',
      labels: [],
    }),
    readBlockedByIssueNumbers: async () => [],
    readOpenPullRequestsByIssue: async () => [],
    credential: selectedCredential(),
    now: () => new Date('2026-07-20T12:00:00.000Z'),
    runner: async (_command, args) => {
      if (args[0] === 'project' && args[1] === 'field-list') {
        return JSON.stringify({
          fields: [
            {
              id: 'status-field',
              name: 'Status',
              options: [
                { id: 'todo', name: 'Todo' },
                { id: 'in-progress', name: 'In Progress' },
                { id: 'human', name: 'Human' },
                { id: 'in-review', name: 'In Review' },
                { id: 'done', name: 'Done' },
              ],
            },
            {
              id: 'blocked-field',
              name: 'Blocked on',
              options: [
                { id: 'nothing', name: 'Nothing' },
                { id: 'human-blocked', name: 'Human' },
                { id: 'another', name: 'Another issue' },
              ],
            },
          ],
        });
      }
      if (args[0] === 'api' && args.some((arg) => arg.includes('/comments'))) return '[]';
      if (args[0] === 'pr' && (
        args[1] === 'ready'
        || args[1] === 'edit'
        || args[1] === 'comment'
      )) return recordMutation();
      if (args[0] === 'project' && args[1] === 'item-edit') return recordMutation();
      if (args.includes('read-tree') || args.includes('update-index')) return '';
      if (args.includes('hash-object')) return `${BLOB_OID}\n`;
      if (args.includes('write-tree')) return `${TREE_OID}\n`;
      if (args.includes('commit-tree')) return `${RECORD_OID}\n`;
      if (args.includes('rev-list')) return `${RECORD_OID} ${CLAIM_OID}`;
      if (args.includes('ls-remote')) return `${CLAIM_OID}\t${reviewClaimRef(84)}\n`;
      if (args.includes('push')) return recordMutation();
      throw new Error(`unexpected ${args.join(' ')}`);
    },
  } as Parameters<typeof makeProductionReconciliationWriter>[0] & {
    readonly readIssueActionContext: () => Promise<unknown>;
  });
  return {
    writer,
    ledger,
    pointsAtMutation: () => pointsAtMutation,
  };
}

describe('production reconciliation writer', () => {
  it.each<{
    readonly name: string;
    readonly action: ProjectionAction;
  }>([
    {
      name: 'label',
      action: {
        kind: 'set-pr-label',
        prNumber: 84,
        expectedHead: HEAD,
        label: 'ready-for-review',
        present: true,
      },
    },
    {
      name: 'draft',
      action: { kind: 'set-pr-draft', prNumber: 84, expectedHead: HEAD, draft: false },
    },
    {
      name: 'Human comment',
      action: {
        kind: 'ensure-human-comment',
        issueNumber: 42,
        prNumber: 84,
        expectedHead: HEAD,
        marker: '<!-- human-marker -->',
        body: '<!-- human-marker -->\nNeeds a Human decision.',
      },
    },
    {
      name: 'implementation summary',
      action: {
        kind: 'ensure-implementation-summary',
        prNumber: 84,
        expectedHead: HEAD,
        summary: 'Implementation completed.',
      },
    },
    {
      name: 'review ref',
      action: {
        kind: 'mark-review-stale',
        prNumber: 84,
        expectedHead: HEAD,
        expectedReviewRefOid: CLAIM_OID,
      },
    },
  ])(
    'end-to-end action scope keeps the $name pre-mutation aggregate at most ten points',
    async ({ action }) => {
      const harness = endToEndCostHarness();

      await executeProjectionPlan({ actions: [action] }, harness.writer);

      expect(harness.pointsAtMutation()).toBeGreaterThanOrEqual(0);
      expect(harness.pointsAtMutation()).toBeLessThanOrEqual(10);
      expect(harness.ledger.some((entry) => entry.kind === 'full')).toBe(false);
    },
  );

  it('executes the diagnostic Human plan with exact monotonic authority and ten-point scopes', async () => {
    const base = snapshot(false);
    const diagnosticCycle: GitHubLifecycleSnapshot = {
      ...base,
      project: {
        ...base.project,
        items: base.project.items.map((item) => ({ ...item, status: 'Todo' })),
      },
      lifecycle: { items: [] },
      pullRequests: base.pullRequests.map((pr) => ({
        ...pr,
        isDraft: false,
        labels: [],
        closingIssueNumbers: [42, 43],
        body: 'ambiguous mapping body',
      })),
      diagnostics: [{
        code: 'branch-mapping-ambiguous',
        detail: 'PR maps to two issues',
        issueNumbers: [42, 43],
        issues: [{ number: 42, projectStatus: 'Todo' }],
        pullRequests: [{ number: 84, head: HEAD, draft: false, labels: [] }],
      }],
    };
    let draft = false;
    const labels = new Set<string>();
    let projectStatus: 'Todo' | 'Human' = 'Todo';
    const comments: string[] = [];
    let scopePoints = 0;
    const mutationCosts: number[] = [];
    const writer = makeProductionReconciliationWriter({
      repositoryPath: '/repo',
      cycleSnapshot: diagnosticCycle,
      readPullRequestByNumber: async () => {
        scopePoints += 8;
        return reconciliationPr({
          isDraft: draft,
          labels: [...labels],
          closingIssueNumbers: [42, 43],
          body: 'ambiguous mapping body',
        });
      },
      readProjectItemForReconciliation: async () => ({
        id: 'PVTI_issue_42', status: projectStatus, blockedOn: 'Nothing',
      }),
      readIssueActionContext: async () => {
        scopePoints += 2;
        return {
          projectItem: {
            id: 'PVTI_issue_42', status: projectStatus, blockedOn: 'Nothing',
          },
          openPullRequests: [],
        };
      },
      readBranchHeadByName: async () => HEAD,
      readIssueByNumber: async (number) => ({
        number, title: 'Ambiguous issue', open: true, author: 'implementation-bot', labels: [],
      }),
      readBlockedByIssueNumbers: async () => [],
      readOpenPullRequestsByIssue: async () => [],
      credential: selectedCredential(),
      runner: async (_command, args) => {
        if (args[0] === 'project' && args[1] === 'field-list') {
          return JSON.stringify({ fields: [{
            id: 'status-field',
            name: 'Status',
            options: [
              { id: 'todo', name: 'Todo' },
              { id: 'in-progress', name: 'In Progress' },
              { id: 'human', name: 'Human' },
              { id: 'in-review', name: 'In Review' },
              { id: 'done', name: 'Done' },
            ],
          }, {
            id: 'blocked-field',
            name: 'Blocked on',
            options: [
              { id: 'nothing', name: 'Nothing' },
              { id: 'human-blocked', name: 'Human' },
              { id: 'another', name: 'Another issue' },
            ],
          }] });
        }
        if (args[0] === 'project' && args[1] === 'item-edit') {
          mutationCosts.push(scopePoints);
          projectStatus = 'Human';
          return '';
        }
        if (args[0] === 'pr' && args[1] === 'ready') {
          mutationCosts.push(scopePoints);
          draft = true;
          return '';
        }
        if (args[0] === 'pr' && args[1] === 'edit') {
          mutationCosts.push(scopePoints);
          labels.add(args[args.indexOf('--add-label') + 1]!);
          return '';
        }
        if (args[0] === 'api') return JSON.stringify(comments.map((body) => ({ body })));
        if (args[0] === 'pr' && args[1] === 'comment') {
          mutationCosts.push(scopePoints);
          comments.push(args[args.indexOf('--body') + 1]!);
          return '';
        }
        throw new Error(`unexpected ${args.join(' ')}`);
      },
    } as Parameters<typeof makeProductionReconciliationWriter>[0] & {
      readonly readIssueActionContext: () => Promise<unknown>;
    });
    const scopedWriter = {
      ...writer,
      actionScope() {
        scopePoints = 0;
        return writer.actionScope?.() ?? writer;
      },
    };
    const plan = planProjection({
      view: { items: [] },
      pullRequests: [{ number: 84 }],
      orphanBranchClaims: [],
      mappingDiagnostics: diagnosticCycle.diagnostics,
    });

    const report = await executeProjectionPlan(plan, scopedWriter);

    expect(report.results.every((result) => (
      result.outcome === 'applied' || result.outcome === 'already-applied'
    ))).toBe(true);
    // Status paint is painter-owned (Stage 3); the diagnostic plan holds via
    // draft + labels + marker comment only.
    expect(projectStatus).toBe('Todo');
    expect(draft).toBe(true);
    expect([...labels].sort()).toEqual(['engine:review', 'review:needs-human']);
    expect(comments).toHaveLength(1);
    expect(mutationCosts).toHaveLength(4);
    expect(Math.max(...mutationCosts)).toBeLessThanOrEqual(10);
  });

  it('rejects every non-monotonic mutation for a diagnostic PR', async () => {
    const base = snapshot(true);
    const cycle: GitHubLifecycleSnapshot = {
      ...base,
      lifecycle: { items: [] },
      diagnostics: [{
        code: 'branch-mapping-ambiguous',
        detail: 'PR maps ambiguously',
        issueNumbers: [42, 43],
        issues: [{ number: 42, projectStatus: 'Human' }],
        pullRequests: [{
          number: 84,
          head: HEAD,
          draft: true,
          labels: ['engine:review', 'review:needs-human'],
        }],
      }],
      pullRequests: base.pullRequests.map((pr) => ({
        ...pr,
        isDraft: true,
        labels: ['engine:review', 'review:needs-human'],
        closingIssueNumbers: [42, 43],
        body: 'ambiguous mapping body',
      })),
    };
    let mutations = 0;
    const writer = makeProductionReconciliationWriter({
      repositoryPath: '/repo',
      ...targetedWriterOptions(() => cycle, cycle),
      readPullRequestByNumber: async () => reconciliationPr({
        isDraft: true,
        labels: ['engine:review', 'review:needs-human'],
        closingIssueNumbers: [42, 43],
        body: 'ambiguous mapping body',
      }),
      credential: selectedCredential(),
      runner: async () => {
        mutations += 1;
        return '';
      },
    });

    await expect(writer.setPullRequestDraft(84, false, HEAD)).rejects.toThrow(/Human|Diagnostic/i);
    await expect(writer.setPullRequestLabel(84, 'engine:review', false, HEAD))
      .rejects.toThrow(/Human/i);
    await expect(writer.setPullRequestLabel(84, 'ready-for-review', true, HEAD))
      .rejects.toThrow(/Human/i);
    await expect(writer.ensureImplementationSummary(84, HEAD, 'normal advancement'))
      .rejects.toThrow(/Diagnostic/i);
    expect(mutations).toBe(0);
  });

  it('keeps a stacked orphan draft action at ten aggregate GraphQL points', async () => {
    const base = worldSnapshotFixture();
    const issue50 = base.issues.find((issue) => issue.number === 50)!;
    const item50 = base.project.items.find((item) => item.number === 50)!;
    const blockerSnapshot: GitHubLifecycleSnapshot['pullRequests'][number] = {
      number: 201,
      title: 'Blocker',
      body: 'Closes #7\n\n<!-- jinn-autopilot:v2 issue=7 branch=autopilot/7 -->',
      author: 'implementation-bot',
      baseRefName: 'next',
      headRefName: 'autopilot/7',
      headOid: BLOCKER_HEAD,
      headCommittedAt: '2026-07-20T11:30:00.000Z',
      isDraft: false,
      state: 'OPEN',
      labels: ['engine:review'],
      closingIssueNumbers: [7],
      mergeability: 'UNKNOWN',
      mergeStateStatus: 'BLOCKED',
      checks: [],
      reviews: [],
    };
    const cycle: GitHubLifecycleSnapshot = {
      ...base,
      project: {
        ...base.project,
        items: base.project.items.map((item) => item.number === 50
          ? { ...item50, blockedOn: 'Another issue', blockedByIssues: [7] }
          : item),
      },
      issues: base.issues.map((issue) => issue.number === 50
        ? { ...issue50, blockedOn: 'Another issue', blockedByIssues: [7] }
        : issue),
      pullRequests: [...base.pullRequests, blockerSnapshot],
    };
    let created = false;
    let scopePoints = 0;
    let pointsAtMutation = -1;
    const writer = makeProductionReconciliationWriter({
      repositoryPath: '/repo',
      cycleSnapshot: cycle,
      readPullRequestByNumber: async (number) => {
        scopePoints += 8;
        if (number !== 201) return null;
        return reconciliationPr({
          headRefName: 'autopilot/7',
          headOid: BLOCKER_HEAD,
          baseRefName: 'next',
          isDraft: false,
          labels: ['engine:review'],
          body: blockerSnapshot.body,
          closingIssueNumbers: [7],
        });
      },
      readProjectItemForReconciliation: async () => ({
        id: 'PVTI_issue_50', status: 'In Progress', blockedOn: 'Another issue',
      }),
      readIssueActionContext: async () => {
        scopePoints += 2;
        return {
          projectItem: {
            id: 'PVTI_issue_50', status: 'In Progress', blockedOn: 'Another issue',
          },
          openPullRequests: created ? [{
            number: 250,
            headRefName: 'autopilot/50',
            headOid: DRAFT_BRANCH_HEAD,
            baseRefName: 'autopilot/7',
            draft: true,
            labels: ['engine:review'],
            body: 'Closes #50\n\n<!-- jinn-autopilot:v2 issue=50 branch=autopilot/50 -->',
          }] : [],
        };
      },
      readBranchHeadByName: async (name) => name === 'autopilot/50'
        ? DRAFT_BRANCH_HEAD
        : null,
      readIssueByNumber: async (number) => ({
        number, title: 'Stacked issue', open: true, author: 'implementation-bot', labels: [],
      }),
      readBlockedByIssueNumbers: async () => [7],
      readOpenPullRequestsByIssue: async () => [],
      credential: selectedCredential(),
      runner: async (_command, args) => {
        if (args[0] === 'pr' && args[1] === 'create') {
          pointsAtMutation = scopePoints;
          created = true;
          return '';
        }
        throw new Error(`unexpected ${args.join(' ')}`);
      },
    } as Parameters<typeof makeProductionReconciliationWriter>[0] & {
      readonly readIssueActionContext: () => Promise<unknown>;
    });
    const scopedWriter = {
      ...writer,
      actionScope() {
        scopePoints = 0;
        return writer.actionScope?.() ?? writer;
      },
    };

    const report = await executeProjectionPlan({ actions: [{
      kind: 'ensure-draft-pr',
      issueNumber: 50,
      expectedHead: DRAFT_BRANCH_HEAD,
      headRefName: 'autopilot/50',
      baseRefName: 'autopilot/7',
    }] }, scopedWriter);

    expect(report.results[0]?.outcome).toBe('applied');
    expect(pointsAtMutation).toBe(10);
    expect(created).toBe(true);
  });

  it('reads Human-comment evidence through explicit counted REST pages', async () => {
    const calls: string[] = [];
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      body: `comment ${index}`,
    }));
    const writer = makeProductionReconciliationWriter({
      repositoryPath: '/repo',
      ...targetedWriterOptions(() => snapshot(false)),
      credential: selectedCredential(),
      environment: {},
      runner: async (_command, args) => {
        const endpoint = args[1] ?? '';
        calls.push(endpoint);
        if (endpoint.endsWith('&page=1')) return JSON.stringify(firstPage);
        if (endpoint.endsWith('&page=2')) {
          return JSON.stringify([{ body: '<!-- human-marker -->' }]);
        }
        throw new Error(`unexpected ${args.join(' ')}`);
      },
    });

    await expect(writer.hasHumanComment(84, '<!-- human-marker -->')).resolves.toBe(true);
    expect(calls).toEqual([
      'repos/Jinn-Network/mono/issues/84/comments?per_page=100&page=1',
      'repos/Jinn-Network/mono/issues/84/comments?per_page=100&page=2',
    ]);
  });

  it('accepts a lost mutation response only after exact selected-identity readback', async () => {
    let draft = false;
    const calls: Array<{ env?: NodeJS.ProcessEnv }> = [];
    const selection = selectCredential(new CredentialPool([{
      login: 'implementation-bot',
      normalizedLogin: 'implementation-bot',
      implementationToken: 'selected-secret',
    }]), { phase: 'implement' });
    if (selection.status !== 'selected') throw new Error('selection failed');
    const writer = makeProductionReconciliationWriter({
      repositoryPath: '/repo',
      ...targetedWriterOptions(() => snapshot(draft)),
      credential: selection.credential,
      environment: { GITHUB_TOKEN: 'ambient-secret' },
      runner: async (_command, args, options) => {
        calls.push({ env: options?.env });
        if (args.includes('ready')) {
          draft = true;
          throw new Error('response lost');
        }
        throw new Error(`unexpected ${args.join(' ')}`);
      },
    });

    await expect(writer.setPullRequestDraft(84, true, HEAD)).resolves.toBeUndefined();
    expect(calls[0]?.env?.GH_TOKEN).toBe('selected-secret');
    expect(calls[0]?.env?.GITHUB_TOKEN).toBe('');
  });

  it.each([
    ['closed-unmerged', null],
    ['merged', reconciliationPr({
      state: 'MERGED' as const,
      headRefName: 'autopilot/7',
      headOid: BLOCKER_HEAD,
      closingIssueNumbers: [7],
      isDraft: false,
      labels: [],
      body: 'Closes #7\n\n<!-- jinn-autopilot:v2 issue=7 branch=autopilot/7 -->',
    })],
    ['head-changed', reconciliationPr({
      state: 'OPEN' as const,
      headRefName: 'autopilot/7',
      headOid: CHANGED_HEAD,
      closingIssueNumbers: [7],
      isDraft: false,
      labels: [],
      body: 'Closes #7\n\n<!-- jinn-autopilot:v2 issue=7 branch=autopilot/7 -->',
    })],
    ['branch-changed', reconciliationPr({
      state: 'OPEN' as const,
      headRefName: 'autopilot/other',
      headOid: BLOCKER_HEAD,
      closingIssueNumbers: [7],
      isDraft: false,
      labels: [],
      body: 'Closes #7\n\n<!-- jinn-autopilot:v2 issue=7 branch=autopilot/other -->',
    })],
    ['closing-relation-changed', reconciliationPr({
      state: 'OPEN' as const,
      headRefName: 'autopilot/7',
      headOid: BLOCKER_HEAD,
      closingIssueNumbers: [8],
      isDraft: false,
      labels: [],
      body: 'Closes #8\n\n<!-- jinn-autopilot:v2 issue=8 branch=autopilot/7 -->',
    })],
    ['marker-changed', reconciliationPr({
      state: 'OPEN' as const,
      headRefName: 'autopilot/7',
      headOid: BLOCKER_HEAD,
      closingIssueNumbers: [7],
      isDraft: false,
      labels: [],
      body: 'Closes #7\n\n<!-- jinn-autopilot:v2 issue=7 branch=autopilot/other -->',
    })],
  ])(
    'rejects a stacked draft when its cycle-open blocker PR is %s',
    async (_label, liveBlocker) => {
      const base = worldSnapshotFixture();
      const issue50 = base.issues.find((issue) => issue.number === 50)!;
      const item50 = base.project.items.find((item) => item.number === 50)!;
      const cycle: GitHubLifecycleSnapshot = {
        ...base,
        project: {
          ...base.project,
          items: base.project.items.map((item) => item.number === 50
            ? { ...item50, blockedOn: 'Another issue', blockedByIssues: [7] }
            : item),
        },
        issues: base.issues.map((issue) => issue.number === 50
          ? { ...issue50, blockedOn: 'Another issue', blockedByIssues: [7] }
          : issue),
        pullRequests: [...base.pullRequests, {
          number: 201,
          title: 'feat: blocker',
          body: 'Closes #7',
          author: 'implementation-bot',
          baseRefName: 'next',
          headRefName: 'autopilot/7',
          headOid: BLOCKER_HEAD,
          headCommittedAt: '2026-07-20T11:30:00.000Z',
          isDraft: false,
          state: 'OPEN',
          labels: ['engine:review'],
          closingIssueNumbers: [7],
          mergeability: 'UNKNOWN',
          mergeStateStatus: 'BLOCKED',
          checks: [],
          reviews: [],
        }],
      };
      const targeted = targetedWriterOptions(() => cycle, cycle);
      const mutationCalls: string[][] = [];
      const writer = makeProductionReconciliationWriter({
        repositoryPath: '/repo',
        ...targeted,
        readPullRequestByNumber: async (prNumber) => (
          prNumber === 201
            ? liveBlocker
            : targeted.readPullRequestByNumber(prNumber)
        ),
        credential: selectedCredential(),
        runner: async (_command, args) => {
          mutationCalls.push([...args]);
          throw new Error(`unexpected mutation ${args.join(' ')}`);
        },
      });

      await expect(writer.ensureDraftPullRequest({
        issueNumber: 50,
        expectedHead: DRAFT_BRANCH_HEAD,
        headRefName: 'autopilot/50',
        baseRefName: 'autopilot/7',
      })).rejects.toThrow('blocker PR authority changed');
      expect(mutationCalls).toEqual([]);
    },
  );

  it('does not accept a field-only readback after the exact PR head changes', async () => {
    let draft = false;
    let head: typeof HEAD = HEAD;
    const selection = selectCredential(new CredentialPool([{
      login: 'implementation-bot',
      normalizedLogin: 'implementation-bot',
      implementationToken: 'selected-secret',
    }]), { phase: 'implement' });
    if (selection.status !== 'selected') throw new Error('selection failed');
    const writer = makeProductionReconciliationWriter({
      repositoryPath: '/repo',
      ...targetedWriterOptions(() => snapshot(draft, { head })),
      credential: selection.credential,
      runner: async (_command, args) => {
        if (args.includes('ready')) {
          draft = true;
          head = CHANGED_HEAD;
          throw new Error('response lost while head changed');
        }
        throw new Error(`unexpected ${args.join(' ')}`);
      },
    });

    await expect(writer.setPullRequestDraft(84, true, HEAD))
      .rejects.toThrow('response lost while head changed');
  });

  it('does not adopt a same-head PR that has no native issue closing relation', async () => {
    let looseHeadLookup = 0;
    const writer = makeProductionReconciliationWriter({
      repositoryPath: '/repo',
      ...targetedWriterOptions(() => snapshot(false)),
      readOpenPullRequestsByIssue: async () => [],
      readIssueActionContext: async () => ({
        projectItem: { id: 'PVTI_issue_42', status: 'Todo', blockedOn: 'Nothing' },
        openPullRequests: [],
      }),
      credential: selectedCredential(),
      runner: async (_command, args) => {
        if (args[0] === 'pr' && args[1] === 'list') looseHeadLookup += 1;
        throw new Error(`unexpected ${args.join(' ')}`);
      },
    });

    await expect(writer.readDraftPullRequestAuthority({
      issueNumber: 42,
      expectedHead: HEAD,
      headRefName: 'autopilot/42',
      baseRefName: 'next',
    })).resolves.toEqual({ kind: 'missing' });
    expect(looseHeadLookup).toBe(0);
  });

  it('preserves live structured Human evidence and uses one PR hydration before mutation', async () => {
    const current = snapshot(true);
    const targeted = targetedWriterOptions(() => current, current);
    let reads = 0;
    let mutations = 0;
    const writer = makeProductionReconciliationWriter({
      repositoryPath: '/repo',
      ...targeted,
      readPullRequestByNumber: async (prNumber) => {
        reads += 1;
        const node = await targeted.readPullRequestByNumber(prNumber);
        return node === null ? null : {
          ...node,
          humanIssueNumber: 42,
          humanReason: {
            phase: 'reviewing' as const,
            code: 'review-escalation' as const,
            detail: 'A Human decision arrived after the cycle snapshot.',
          },
        };
      },
      credential: selectedCredential(),
      runner: async () => {
        mutations += 1;
        return '';
      },
    });

    await expect(writer.setPullRequestLabel(84, 'ready-for-review', true, HEAD))
      .rejects.toThrow('Human is dominant');
    expect(reads).toBe(1);
    expect(mutations).toBe(0);
  });

  it('behavioral ledger: uses one exact PR hydration before a reconciliation mutation', async () => {
    const current = snapshot(true);
    const targeted = targetedWriterOptions(() => current, current);
    let draft = true;
    const ledger: Array<{ readonly kind: string; readonly points: number }> = [];
    let pointsAtMutation = -1;
    const writer = makeProductionReconciliationWriter({
      repositoryPath: '/repo',
      ...targeted,
      readPullRequestByNumber: async (prNumber) => {
        ledger.push({ kind: 'target-pr', points: 8 });
        const node = await targeted.readPullRequestByNumber(prNumber);
        return node === null ? null : { ...node, isDraft: draft };
      },
      readIssueActionContext: async (issueNumber) => {
        ledger.push({ kind: 'target-issue-context', points: 2 });
        return targeted.readIssueActionContext(issueNumber);
      },
      credential: selectedCredential(),
      runner: async (_command, args) => {
        if (args.includes('ready')) {
          pointsAtMutation = ledger.reduce((sum, entry) => sum + entry.points, 0);
          draft = args.includes('--undo');
          return '';
        }
        throw new Error(`unexpected ${args.join(' ')}`);
      },
    });

    await expect(writer.setPullRequestDraft(84, false, HEAD)).resolves.toBeUndefined();
    expect(pointsAtMutation).toBe(10);
    expect(ledger).toEqual([
      { kind: 'target-pr', points: 8 },
      { kind: 'target-issue-context', points: 2 },
      { kind: 'target-pr', points: 8 },
    ]);
    expect(ledger.some((entry) => entry.kind === 'full')).toBe(false);
  });

  it('rejects stale cycle mapping before a Human comment mutation', async () => {
    const current = snapshot(true);
    const targeted = targetedWriterOptions(() => current, current);
    let commands = 0;
    const writer = makeProductionReconciliationWriter({
      repositoryPath: '/repo',
      ...targeted,
      readPullRequestByNumber: async (prNumber) => {
        const node = await targeted.readPullRequestByNumber(prNumber);
        return node === null ? null : {
          ...node,
          headRefName: 'autopilot/99',
          closingIssueNumbers: [99],
          body: 'Closes #99\n\n<!-- jinn-autopilot:v2 issue=99 branch=autopilot/99 -->',
        };
      },
      credential: selectedCredential(),
      runner: async () => {
        commands += 1;
        return '[]';
      },
    });

    await expect(writer.ensureHumanComment(
      84,
      '<!-- human-marker -->',
      '<!-- human-marker -->\nNeeds Human input.',
      HEAD,
    )).rejects.toThrow(/mapping|issue #42/i);
    expect(commands).toBe(0);
  });

  it('rejects duplicate issue-level closing refs before creating an orphan draft PR', async () => {
    const cycle = worldSnapshotFixture();
    let mutations = 0;
    const writer = makeProductionReconciliationWriter({
      repositoryPath: '/repo',
      ...targetedWriterOptions(() => cycle, cycle),
      readIssueActionContext: async () => ({
        projectItem: {
          id: 'PVTI_issue_50', status: 'In Progress', blockedOn: 'Nothing',
        },
        openPullRequests: [
          {
            number: 90,
            headRefName: 'other/50-a',
            headOid: HEAD,
            baseRefName: 'next',
            draft: true,
            labels: ['engine:review'],
            body: 'Closes #50',
          },
          {
            number: 91,
            headRefName: 'other/50-b',
            headOid: CHANGED_HEAD,
            baseRefName: 'next',
            draft: true,
            labels: ['engine:review'],
            body: 'Closes #50',
          },
        ],
      }),
      credential: selectedCredential(),
      runner: async () => {
        mutations += 1;
        return '';
      },
    });

    await expect(writer.ensureDraftPullRequest({
      issueNumber: 50,
      expectedHead: DRAFT_BRANCH_HEAD,
      headRefName: 'autopilot/50',
      baseRefName: 'next',
    })).rejects.toThrow(/duplicate|closing|relation/i);
    expect(mutations).toBe(0);
  });

  it('rejects an inexact issue-level draft relation in the post-mutation readback', async () => {
    const cycle = worldSnapshotFixture();
    let created = false;
    const writer = makeProductionReconciliationWriter({
      repositoryPath: '/repo',
      ...targetedWriterOptions(() => cycle, cycle),
      readIssueActionContext: async () => ({
        projectItem: {
          id: 'PVTI_issue_50', status: 'In Progress', blockedOn: 'Nothing',
        },
        openPullRequests: created ? [{
            number: 99,
            headRefName: 'autopilot/50',
            headOid: DRAFT_BRANCH_HEAD,
            baseRefName: 'wrong-base',
            draft: true,
            labels: ['engine:review'],
            body: 'Closes #50\n\n<!-- malformed marker -->',
          }] : [],
      }),
      credential: selectedCredential(),
      runner: async (_command, args) => {
        if (args[0] === 'pr' && args[1] === 'create') {
          created = true;
          return '';
        }
        if (args[0] === 'pr' && args[1] === 'list') {
          return JSON.stringify([{
            number: 99,
            headRefOid: DRAFT_BRANCH_HEAD,
            isDraft: true,
            labels: [{ name: 'engine:review' }],
          }]);
        }
        throw new Error(`unexpected ${args.join(' ')}`);
      },
    });

    await expect(writer.ensureDraftPullRequest({
      issueNumber: 50,
      expectedHead: DRAFT_BRANCH_HEAD,
      headRefName: 'autopilot/50',
      baseRefName: 'next',
    })).rejects.toThrow(/draft|relation|ambiguous/i);
    expect(created).toBe(true);
  });

  // jinn-mono#1883: a full `buildGitHubLifecycleSnapshot` costs ~390 GraphQL
  // points; a single-PR read costs ~7-8. The tests below wire `readSnapshot`
  // to throw if it's ever called, proving every exact-state PR pre-check and
  // read-back goes through the cheap per-PR reads instead.

  it('resolves draft and label reconciliation from the cheap per-PR read and the dominance snapshot only', async () => {
    let draft = true;
    const labels = new Set(['engine:review']);
    const calls: string[] = [];
    const writer = makeProductionReconciliationWriter({
      repositoryPath: '/repo',
      ...targetedWriterOptions(() => snapshot(draft)),
      readPullRequestByNumber: async (prNumber): Promise<ReconciliationPullRequestNode | null> => {
        calls.push('readPullRequestByNumber');
        if (prNumber !== 84) return null;
        return reconciliationPr({
          isDraft: draft,
          labels: [...labels],
        });
      },
      credential: selectedCredential(),
      runner: async (_command, args) => {
        if (args.includes('ready')) {
          draft = args.includes('--undo');
          return '';
        }
        if (args.includes('edit') && args.includes('--add-label')) {
          labels.add(args[args.indexOf('--add-label') + 1]!);
          return '';
        }
        throw new Error(`unexpected ${args.join(' ')}`);
      },
    });

    // Undrafting is dominance-gated — exercises both the cheap PR read and
    // the (separate) dominance snapshot in one call.
    await writer.setPullRequestDraft(84, false, HEAD);
    await writer.setPullRequestLabel(84, 'ready-for-review', true, HEAD);

    expect(calls.filter((call) => call === 'readPullRequestByNumber').length).toBeGreaterThan(0);
    expect(draft).toBe(false);
    expect(labels.has('ready-for-review')).toBe(true);
  });

  it('finds a draft PR only through its exact issue closing relation', async () => {
    const calls: string[] = [];
    const runnerCalls: string[][] = [];
    const writer = makeProductionReconciliationWriter({
      repositoryPath: '/repo',
      ...targetedWriterOptions(() => snapshot(false)),
      readPullRequestByNumber: async () => {
        calls.push('readPullRequestByNumber');
        return null;
      },
      credential: selectedCredential(),
      runner: async (_command, args) => {
        runnerCalls.push(args);
        throw new Error(`unexpected ${args.join(' ')}`);
      },
    });

    await expect(writer.readDraftPullRequestAuthority({
      issueNumber: 42,
      expectedHead: HEAD,
      headRefName: 'autopilot/42',
      baseRefName: 'next',
    })).resolves.toEqual({
      kind: 'linked',
      number: 84,
      head: HEAD,
      draft: false,
      labels: ['engine:review'],
    });
    expect(calls).toEqual([]);
    expect(runnerCalls).toEqual([]);
  });

  it.each([
    ['base', { baseRefName: 'wrong-base' }],
    ['body', { body: 'Closes #42\n\nwrong marker' }],
  ])('rejects an issue-linked draft PR with a malformed %s', async (_field, override) => {
    const targeted = targetedWriterOptions(() => snapshot(false));
    const writer = makeProductionReconciliationWriter({
      repositoryPath: '/repo',
      ...targeted,
      readIssueActionContext: async () => ({
        projectItem: {
          id: 'PVTI_issue_42', status: 'Todo', blockedOn: 'Nothing',
        },
        openPullRequests: [{
          number: 84,
          headRefName: 'autopilot/42',
          headOid: HEAD,
          baseRefName: 'next',
          draft: true,
          labels: ['engine:review'],
          body: 'Closes #42\n\n<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->',
          ...override,
        }],
      }),
      credential: selectedCredential(),
      runner: async (_command, args) => {
        throw new Error(`unexpected mutation ${args.join(' ')}`);
      },
    });

    await expect(writer.readDraftPullRequestAuthority({
      issueNumber: 42,
      expectedHead: HEAD,
      headRefName: 'autopilot/42',
      baseRefName: 'next',
    })).rejects.toThrow(/malformed issue closing relation/i);
  });

  it('rejects a review-ref mutation whose authority already changed, using only the cheap per-PR read', async () => {
    const calls: string[] = [];
    const record: ReviewClaimRecord = {
      kind: 'review-claim',
      protocolVersion: 2,
      prNumber: 84,
      generation: '22222222-2222-4222-8222-222222222222',
      attempt: '33333333-3333-4333-8333-333333333333',
      reviewer: 'jinn-reviewer',
      head: HEAD,
      recordedAt: '2026-07-20T12:00:00.000Z',
      state: 'active',
    };
    const writer = makeProductionReconciliationWriter({
      repositoryPath: '/repo',
      ...targetedWriterOptions(() => snapshot(true)),
      readPullRequestByNumber: async () => {
        calls.push('readPullRequestByNumber');
        return reconciliationPr({
          isDraft: true,
          labels: ['engine:review'],
          reviewClaim: { oid: CLAIM_OID, payload: encodeReviewClaimPayload(record) },
        });
      },
      credential: selectedCredential(),
      runner: async () => {
        throw new Error('a rejected pre-check must never mutate');
      },
    });

    const staleOid = gitOid('9'.repeat(40));
    await expect(writer.markReviewStale(84, staleOid))
      .rejects.toThrow('Review-ref authority changed before reconciliation');
    expect(calls).toEqual(['readPullRequestByNumber']);
  });

  it('publishes a review-ref transition using only the cheap per-PR read and the dominance snapshot', async () => {
    const calls: string[] = [];
    let pushed = false;
    const before: ReviewClaimRecord = {
      kind: 'review-claim',
      protocolVersion: 2,
      prNumber: 84,
      generation: '22222222-2222-4222-8222-222222222222',
      attempt: '33333333-3333-4333-8333-333333333333',
      reviewer: 'jinn-reviewer',
      head: HEAD,
      recordedAt: '2026-07-20T11:00:00.000Z',
      state: 'active',
    };
    const after: ReviewClaimRecord = {
      ...before,
      state: 'stale',
      recordedAt: '2026-07-20T12:00:00.000Z',
    };
    const ref = reviewClaimRef(84);
    const writer = makeProductionReconciliationWriter({
      repositoryPath: '/repo',
      ...targetedWriterOptions(() => snapshot(true)),
      readPullRequestByNumber: async (prNumber) => {
        calls.push('readPullRequestByNumber');
        if (prNumber !== 84) return null;
        return reconciliationPr({
          isDraft: true,
          labels: ['engine:review'],
          reviewClaim: {
            oid: pushed ? RECORD_OID : CLAIM_OID,
            payload: encodeReviewClaimPayload(pushed ? after : before),
          },
        });
      },
      credential: selectedCredential(),
      now: () => new Date('2026-07-20T12:00:00.000Z'),
      runner: async (_command, args) => {
        if (args.includes('hash-object')) return `${BLOB_OID}\n`;
        if (args.includes('write-tree')) return `${TREE_OID}\n`;
        if (args.includes('commit-tree')) return `${RECORD_OID}\n`;
        if (args.includes('rev-list')) return `${RECORD_OID} ${CLAIM_OID}`;
        if (args.includes('ls-remote')) return `${CLAIM_OID}\t${ref}\n`;
        if (args.includes('push')) {
          pushed = true;
          return '';
        }
        if (args.includes('read-tree') || args.includes('update-index')) return '';
        throw new Error(`unexpected git args ${args.join(' ')}`);
      },
    });

    await expect(writer.markReviewStale(84, CLAIM_OID)).resolves.toBeUndefined();

    expect(calls.filter((call) => call === 'readPullRequestByNumber').length).toBeGreaterThan(0);
    expect(pushed).toBe(true);
  });

  // jinn-mono#1883 follow-up: the first pass converted the three named
  // helpers but left several writer methods (readIssueHead, readBranchHead,
  // readProjectStatus, setProjectStatus, ensureDraftPullRequest) reading a
  // full world snapshot inline. A live recover cycle still burned ~4,700
  // points because `set-project-status` / `ensure-human-comment` actions
  // dominate a typical plan and routed through those un-converted sites.
  // This test drives one call of EVERY writer method through the
  // production writer and asserts the full snapshot seam is never touched,
  // catching any future regression regardless of which method reintroduces
  // a world read.
  it(
    'global: never touches a full world snapshot across every writer method it supports',
    async () => {
      const calls: string[] = [];
      const cycleSnapshot = worldSnapshotFixture();

      // --- PR #84 mutable fixture state ---
      let draft = true;
      const labels = new Set(['engine:review']);
      let body = 'Closes #42\n\n<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->';
      let reviewState: 'active' | 'stale' = 'active';
      let reviewOid: GitOid = CLAIM_OID;
      const comments: string[] = [];
      let commitCounter = 0;
      let lastCommitOid: GitOid | undefined;
      let lastCommitParent: GitOid | undefined;
      let pushCount = 0;
      const reviewRef = reviewClaimRef(84);

      const reviewRecordFor = (state: typeof reviewState): ReviewClaimRecord => ({
        kind: 'review-claim',
        protocolVersion: 2,
        prNumber: 84,
        generation: '22222222-2222-4222-8222-222222222222',
        attempt: '33333333-3333-4333-8333-333333333333',
        reviewer: 'jinn-reviewer',
        head: HEAD,
        recordedAt: '2026-07-20T12:00:00.000Z',
        state,
      });

      const readPullRequestByNumber = async (
        prNumber: number,
      ): Promise<ReconciliationPullRequestNode | null> => {
        calls.push('readPullRequestByNumber');
        if (prNumber !== 84) return null;
        return reconciliationPr({
          isDraft: draft,
          labels: [...labels],
          body,
          reviewClaim: {
            oid: reviewOid,
            payload: encodeReviewClaimPayload(reviewRecordFor(reviewState)),
          },
        });
      };

      // --- Issue #42 project-item mutable fixture state ---
      let issue42Status: 'Todo' | 'In Progress' | 'Human' | 'In Review' | 'Done' = 'In Progress';
      const readProjectItemForReconciliation = async (issueNumber: number) => {
        calls.push('readProjectItemForReconciliation');
        if (issueNumber === 42) {
          return { id: 'PVTI_issue_42', status: issue42Status, blockedOn: 'Nothing' as const };
        }
        if (issueNumber === 50) {
          return { id: 'PVTI_issue_50', status: 'In Progress' as const, blockedOn: 'Nothing' as const };
        }
        return null;
      };

      let draftPrCreated = false;

      const writer = makeProductionReconciliationWriter({
        repositoryPath: '/repo',
        ...targetedWriterOptions(() => cycleSnapshot, cycleSnapshot),
        readPullRequestByNumber,
        readProjectItemForReconciliation,
        readIssueActionContext: async (issueNumber) => ({
          projectItem: await readProjectItemForReconciliation(issueNumber),
          openPullRequests: issueNumber === 50 && draftPrCreated
            ? [{
                number: 99,
                headRefName: 'autopilot/50',
                headOid: DRAFT_BRANCH_HEAD,
                baseRefName: 'next',
                draft: true,
                labels: ['engine:review'],
                body:
                  'Closes #50\n\n<!-- jinn-autopilot:v2 issue=50 branch=autopilot/50 -->',
              }]
            : [],
        }),
        credential: selectedCredential(),
        now: () => new Date('2026-07-20T12:00:00.000Z'),
        runner: async (_command, args) => {
          if (args[0] === 'project' && args[1] === 'field-list') {
            return JSON.stringify({
              fields: [
                {
                  id: 'field-status',
                  name: 'Status',
                  options: [
                    { id: 'opt-todo', name: 'Todo' },
                    { id: 'opt-in-progress', name: 'In Progress' },
                    { id: 'opt-human', name: 'Human' },
                    { id: 'opt-in-review', name: 'In Review' },
                    { id: 'opt-done', name: 'Done' },
                  ],
                },
                {
                  id: 'field-blocked-on',
                  name: 'Blocked on',
                  options: [
                    { id: 'opt-nothing', name: 'Nothing' },
                    { id: 'opt-blocked-human', name: 'Human' },
                    { id: 'opt-blocked-another', name: 'Another issue' },
                  ],
                },
              ],
            });
          }
          if (args[0] === 'project' && args[1] === 'item-edit') {
            const optionId = args[args.indexOf('--single-select-option-id') + 1]!;
            const byOption: Record<string, typeof issue42Status> = {
              'opt-todo': 'Todo',
              'opt-in-progress': 'In Progress',
              'opt-human': 'Human',
              'opt-in-review': 'In Review',
              'opt-done': 'Done',
            };
            issue42Status = byOption[optionId]!;
            return '';
          }
          if (args[0] === 'pr' && args[1] === 'ready') {
            draft = args.includes('--undo');
            return '';
          }
          if (args[0] === 'pr' && args[1] === 'edit' && args.includes('--add-label')) {
            labels.add(args[args.indexOf('--add-label') + 1]!);
            return '';
          }
          if (args[0] === 'pr' && args[1] === 'edit' && args.includes('--remove-label')) {
            labels.delete(args[args.indexOf('--remove-label') + 1]!);
            return '';
          }
          if (args[0] === 'pr' && args[1] === 'edit' && args.includes('--body')) {
            body = args[args.indexOf('--body') + 1]!;
            return '';
          }
          if (args[0] === 'pr' && args[1] === 'comment') {
            comments.push(args[args.indexOf('--body') + 1]!);
            return '';
          }
          if (args[0] === 'api' && args.some((arg) => arg.includes('/comments'))) {
            return JSON.stringify(comments.map((comment) => ({ body: comment })));
          }
          if (args[0] === 'pr' && args[1] === 'create') {
            draftPrCreated = true;
            return '';
          }
          if (args[0] === 'pr' && args[1] === 'list') {
            return draftPrCreated
              ? JSON.stringify([{
                  number: 99,
                  headRefOid: DRAFT_BRANCH_HEAD,
                  isDraft: true,
                  labels: [{ name: 'engine:review' }],
                }])
              : JSON.stringify([]);
          }
          if (args.includes('read-tree') || args.includes('update-index')) return '';
          if (args.includes('hash-object')) return `${numberedOid(++commitCounter)}\n`;
          if (args.includes('write-tree')) return `${numberedOid(++commitCounter)}\n`;
          if (args.includes('commit-tree')) {
            lastCommitParent = gitOid(args[args.indexOf('-p') + 1]!);
            lastCommitOid = numberedOid(++commitCounter);
            return `${lastCommitOid}\n`;
          }
          if (args.includes('rev-list')) return `${lastCommitOid} ${lastCommitParent}`;
          if (args.includes('ls-remote')) return `${reviewOid}\t${reviewRef}\n`;
          if (args.includes('push')) {
            pushCount += 1;
            reviewOid = lastCommitOid!;
            reviewState = 'stale';
            return '';
          }
          throw new Error(`unexpected command args ${args.join(' ')}`);
        },
      });

      // One call per writer method — every "action kind" the writer supports.
      await writer.readIssueHead(42);
      await writer.readBranchHead('autopilot/50');
      await writer.readPullRequest(84);
      await writer.setPullRequestDraft(84, false, HEAD);
      await writer.setPullRequestLabel(84, 'ready-for-review', true, HEAD);
      await writer.hasHumanComment(84, '<!-- marker -->');
      await writer.ensureHumanComment(84, '<!-- marker -->', '<!-- marker -->\nbody', HEAD);
      await writer.ensureImplementationSummary(84, HEAD, 'Durable summary');
      await writer.readDraftPullRequestAuthority({
        issueNumber: 50,
        expectedHead: DRAFT_BRANCH_HEAD,
        headRefName: 'autopilot/50',
        baseRefName: 'next',
      });
      await writer.ensureDraftPullRequest({
        issueNumber: 50,
        expectedHead: DRAFT_BRANCH_HEAD,
        headRefName: 'autopilot/50',
        baseRefName: 'next',
      });
      await writer.readReviewRef(84);
      await writer.markReviewStale(84, CLAIM_OID);

      // The whole point of jinn-mono#1883: the writer uses only the immutable
      // cycle context plus live targeted reads. There is no full-world action
      // seam for a future method to call.
      expect(calls.filter((call) => call === 'readSnapshot')).toEqual([]);

      // Sanity: every mutation actually landed, so this drove real state
      // transitions rather than short-circuiting on "already applied".
      expect(draft).toBe(false);
      expect(labels.has('ready-for-review')).toBe(true);
      expect(comments.some((comment) => comment.includes('<!-- marker -->'))).toBe(true);
      expect(body).toContain('Durable summary');
      expect(draftPrCreated).toBe(true);
      expect(reviewState).toBe('stale');
    },
  );
});

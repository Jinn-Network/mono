import { describe, expect, it } from 'vitest';
import { CredentialPool, selectCredential } from '../../src/lifecycle/credentials.js';
import { encodeReviewClaimPayload, reviewClaimRef } from '../../src/lifecycle/codecs.js';
import {
  makeProductionReconciliationWriter,
  type ReconciliationPullRequestNode,
} from '../../src/lifecycle/reconciliation-writer-production.js';
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

function numberedOid(n: number): GitOid {
  return gitOid(n.toString(16).padStart(40, '0'));
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
      items: options.projectStatus === undefined ? [] : [{
        id: 'PVTI_issue_42',
        number: 42,
        contentType: 'Issue',
        status: options.projectStatus,
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
    issues: [],
    branches: [],
    diagnostics: [],
    pullRequests: [{
      number: 84,
      title: 'feat: test',
      body: 'Closes #42',
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
    lifecycle: { items: [] },
    capturedAt: '2026-07-20T12:00:00.000Z',
  };
}

// World snapshot for the global regression test below — deliberately does
// NOT include PR #84 (every PR-side read/write is exercised through the
// cheap per-PR fake instead), only what the Project/Issue-scoped
// pre-checks still need: issue #42's branch head (for `readIssueHead` /
// `setProjectStatus`'s head check) and issue #50's existence + branch head
// (for `ensureDraftPullRequest`, which has no PR yet to read cheaply).
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
          status: 'Todo',
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
    issues: [{
      number: 50,
      title: 'feat: needs a draft PR',
      shape: 'feat',
      blockedOn: 'Nothing',
      blockedByIssues: [],
      effort: 'High',
      priority: 'P1',
      status: 'Todo',
      onBoard: true,
      author: 'implementation-bot',
      projectItemId: 'PVTI_issue_50',
      inCurrentSprint: false,
    }],
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
    pullRequests: [],
    diagnostics: [],
    lifecycle: { items: [] },
    capturedAt: '2026-07-20T12:00:00.000Z',
  };
}

describe('production reconciliation writer', () => {
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
      readSnapshot: async () => snapshot(draft),
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
      readSnapshot: async () => snapshot(draft, { head }),
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

  it('never moves a Human-owned Project item back into automation', async () => {
    let mutations = 0;
    const selection = selectCredential(new CredentialPool([{
      login: 'implementation-bot',
      normalizedLogin: 'implementation-bot',
      implementationToken: 'selected-secret',
    }]), { phase: 'implement' });
    if (selection.status !== 'selected') throw new Error('selection failed');
    const writer = makeProductionReconciliationWriter({
      repositoryPath: '/repo',
      readSnapshot: async () => snapshot(true, {
        projectStatus: 'Human',
        blockedOn: 'Human',
      }),
      credential: selection.credential,
      runner: async () => {
        mutations++;
        return '';
      },
    });

    await expect(writer.setProjectStatus(42, 'Todo', HEAD))
      .rejects.toThrow('Human is dominant');
    expect(mutations).toBe(0);
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
      readSnapshot: async () => {
        calls.push('readSnapshot');
        throw new Error('a full world snapshot must never back a single-PR check');
      },
      readPullRequestByNumber: async (prNumber): Promise<ReconciliationPullRequestNode | null> => {
        calls.push('readPullRequestByNumber');
        if (prNumber !== 84) return null;
        return {
          state: 'OPEN',
          headOid: HEAD,
          isDraft: draft,
          labels: [...labels],
          body: 'Closes #42',
          reviewClaim: null,
        };
      },
      readDominanceSnapshot: async () => {
        calls.push('readDominanceSnapshot');
        return snapshot(draft);
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

    expect(calls.filter((call) => call === 'readSnapshot')).toEqual([]);
    expect(calls.filter((call) => call === 'readDominanceSnapshot').length).toBeGreaterThan(0);
    expect(calls.filter((call) => call === 'readPullRequestByNumber').length).toBeGreaterThan(0);
    expect(draft).toBe(false);
    expect(labels.has('ready-for-review')).toBe(true);
  });

  it('finds an open PR by head branch via a cheap gh pr list filter, never a full world snapshot', async () => {
    const calls: string[] = [];
    const runnerCalls: string[][] = [];
    const writer = makeProductionReconciliationWriter({
      repositoryPath: '/repo',
      readSnapshot: async () => {
        calls.push('readSnapshot');
        throw new Error('a full world snapshot must never back an existence lookup');
      },
      readPullRequestByNumber: async () => {
        calls.push('readPullRequestByNumber');
        return null;
      },
      readDominanceSnapshot: async () => {
        calls.push('readDominanceSnapshot');
        throw new Error('an existence lookup does not need a dominance check');
      },
      credential: selectedCredential(),
      runner: async (_command, args) => {
        runnerCalls.push(args);
        return JSON.stringify([{
          number: 84,
          headRefOid: HEAD,
          isDraft: true,
          labels: [{ name: 'engine:review' }],
        }]);
      },
    });

    await expect(writer.findOpenPullRequest('autopilot/42')).resolves.toEqual({
      number: 84,
      head: HEAD,
      draft: true,
      labels: ['engine:review'],
    });
    expect(calls).toEqual([]);
    expect(runnerCalls[0]).toEqual(expect.arrayContaining(['pr', 'list', '--head', 'autopilot/42']));
  });

  it('reads review-ref state from the cheap per-PR read, never a full world snapshot', async () => {
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
      state: 'fixing',
    };
    const writer = makeProductionReconciliationWriter({
      repositoryPath: '/repo',
      readSnapshot: async () => {
        calls.push('readSnapshot');
        throw new Error('a full world snapshot must never back a review-ref read');
      },
      readPullRequestByNumber: async (prNumber) => {
        calls.push('readPullRequestByNumber');
        if (prNumber !== 84) return null;
        return {
          state: 'OPEN',
          headOid: HEAD,
          isDraft: true,
          labels: ['engine:review'],
          body: '',
          reviewClaim: { oid: CLAIM_OID, payload: encodeReviewClaimPayload(record) },
        };
      },
      readDominanceSnapshot: async () => {
        calls.push('readDominanceSnapshot');
        throw new Error('a plain read-ref does not need a dominance check');
      },
      credential: selectedCredential(),
      runner: async () => {
        throw new Error('a plain read-ref must never mutate');
      },
    });

    await expect(writer.readReviewRef(84)).resolves.toEqual({
      oid: CLAIM_OID,
      head: HEAD,
      state: 'fixing',
    });
    expect(calls).toEqual(['readPullRequestByNumber']);
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
      readSnapshot: async () => {
        calls.push('readSnapshot');
        throw new Error('a full world snapshot must never back a review-ref pre-check');
      },
      readPullRequestByNumber: async () => {
        calls.push('readPullRequestByNumber');
        return {
          state: 'OPEN',
          headOid: HEAD,
          isDraft: true,
          labels: ['engine:review'],
          body: '',
          reviewClaim: { oid: CLAIM_OID, payload: encodeReviewClaimPayload(record) },
        };
      },
      readDominanceSnapshot: async () => {
        calls.push('readDominanceSnapshot');
        throw new Error('a rejected pre-check must never reach the dominance check');
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
      readSnapshot: async () => {
        calls.push('readSnapshot');
        throw new Error('a full world snapshot must never back a review-ref publish');
      },
      readPullRequestByNumber: async (prNumber) => {
        calls.push('readPullRequestByNumber');
        if (prNumber !== 84) return null;
        return {
          state: 'OPEN',
          headOid: HEAD,
          isDraft: true,
          labels: ['engine:review'],
          body: '',
          reviewClaim: {
            oid: pushed ? RECORD_OID : CLAIM_OID,
            payload: encodeReviewClaimPayload(pushed ? after : before),
          },
        };
      },
      readDominanceSnapshot: async () => {
        calls.push('readDominanceSnapshot');
        return snapshot(true);
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

    expect(calls.filter((call) => call === 'readSnapshot')).toEqual([]);
    expect(calls.filter((call) => call === 'readDominanceSnapshot').length).toBeGreaterThan(0);
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
  // production writer and asserts the full snapshot is touched at most
  // once in total — the one memoized dominance read a real cycle amortizes
  // across the whole plan — catching any future regression regardless of
  // which specific method reintroduces a `snapshot()` call.
  it(
    'global: touches the full world snapshot at most once across every writer method it supports',
    async () => {
      const calls: string[] = [];
      let readSnapshotCalls = 0;
      const readSnapshot = async (): Promise<GitHubLifecycleSnapshot> => {
        calls.push('readSnapshot');
        readSnapshotCalls += 1;
        return worldSnapshotFixture();
      };
      let dominanceCache: ReturnType<typeof readSnapshot> | undefined;
      const readDominanceSnapshot = (): ReturnType<typeof readSnapshot> => {
        calls.push('readDominanceSnapshot');
        dominanceCache ??= readSnapshot();
        return dominanceCache;
      };

      // --- PR #84 mutable fixture state ---
      let draft = true;
      const labels = new Set(['engine:review']);
      let body = 'Closes #42';
      let reviewState: 'active' | 'stale' | 'fixing' = 'active';
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
        return {
          state: 'OPEN',
          headOid: HEAD,
          isDraft: draft,
          labels: [...labels],
          body,
          reviewClaim: {
            oid: reviewOid,
            payload: encodeReviewClaimPayload(reviewRecordFor(reviewState)),
          },
        };
      };

      // --- Issue #42 project-item mutable fixture state ---
      let issue42Status: 'Todo' | 'In Progress' | 'Human' | 'In Review' | 'Done' = 'In Progress';
      const readProjectItemForReconciliation = async (issueNumber: number) => {
        calls.push('readProjectItemForReconciliation');
        if (issueNumber !== 42) return null;
        return { id: 'PVTI_issue_42', status: issue42Status, blockedOn: 'Nothing' as const };
      };

      let draftPrCreated = false;

      const writer = makeProductionReconciliationWriter({
        repositoryPath: '/repo',
        readSnapshot,
        readPullRequestByNumber,
        readProjectItemForReconciliation,
        readDominanceSnapshot,
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
            return comments.join('\n');
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
            reviewState = pushCount === 1 ? 'stale' : 'fixing';
            return '';
          }
          throw new Error(`unexpected command args ${args.join(' ')}`);
        },
      });

      // One call per writer method — every "action kind" the writer supports.
      await writer.readIssueHead(42);
      await writer.readBranchHead('autopilot/50');
      await writer.readProjectStatus(42);
      await writer.setProjectStatus(42, 'In Review', HEAD);
      await writer.readPullRequest(84);
      await writer.setPullRequestDraft(84, false, HEAD);
      await writer.setPullRequestLabel(84, 'ready-for-review', true, HEAD);
      await writer.hasHumanComment(84, '<!-- marker -->');
      await writer.ensureHumanComment(84, '<!-- marker -->', '<!-- marker -->\nbody', HEAD);
      await writer.ensureImplementationSummary(84, HEAD, 'Durable summary');
      await writer.findOpenPullRequest('autopilot/50');
      await writer.ensureDraftPullRequest({
        issueNumber: 50,
        expectedHead: DRAFT_BRANCH_HEAD,
        headRefName: 'autopilot/50',
        baseRefName: 'next',
      });
      await writer.readReviewRef(84);
      await writer.markReviewStale(84, CLAIM_OID);
      const afterStale = await writer.readReviewRef(84);
      await writer.completeVerdictIntent(84, afterStale!.oid, 'fixing');

      // The whole point of jinn-mono#1883: however the caller memoizes the
      // dominance snapshot across a cycle (mirrored above), the writer
      // itself must never touch the full world snapshot more than once —
      // a global count, not a per-method one, so no future un-converted
      // `snapshot()` call site can hide behind a narrowly-scoped assertion.
      expect(readSnapshotCalls).toBeLessThanOrEqual(1);
      expect(readSnapshotCalls).toBe(1);

      // Sanity: every mutation actually landed, so this drove real state
      // transitions rather than short-circuiting on "already applied".
      expect(issue42Status).toBe('In Review');
      expect(draft).toBe(false);
      expect(labels.has('ready-for-review')).toBe(true);
      expect(comments.some((comment) => comment.includes('<!-- marker -->'))).toBe(true);
      expect(body).toContain('Durable summary');
      expect(draftPrCreated).toBe(true);
      expect(reviewState).toBe('fixing');
    },
  );
});

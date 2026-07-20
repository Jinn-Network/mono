import { describe, expect, it } from 'vitest';
import { CredentialPool } from '../../src/lifecycle/credentials.js';
import {
  evaluateMergeGate,
  executeMergeAction,
  type MergeCandidate,
  type MergeExecutorDeps,
} from '../../src/lifecycle/merge-executor.js';
import { gitOid, gitRefName } from '../../src/lifecycle/types.js';

const HEAD = gitOid('1'.repeat(40));

function candidate(overrides: Partial<MergeCandidate> = {}): MergeCandidate {
  return {
    issueNumber: 42,
    prNumber: 84,
    open: true,
    merged: false,
    head: HEAD,
    baseRefName: gitRefName('next'),
    expectedBaseRefName: gitRefName('next'),
    draft: false,
    labels: ['engine:review'],
    humanHold: false,
    author: 'implementation-bot',
    authorAllowed: true,
    uniqueIssueMapping: true,
    terminalApprovalMatches: true,
    effectiveReviews: [{
      reviewer: 'review-bot',
      state: 'APPROVED',
      commitId: HEAD,
    }],
    checks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    compareStatus: 'ahead',
    changedFilesComplete: true,
    codeownersComplete: true,
    codeownerSensitive: false,
    ...overrides,
  };
}

function pool(): CredentialPool {
  return new CredentialPool([{
    login: 'implementation-bot',
    normalizedLogin: 'implementation-bot',
    implementationToken: 'selected-secret',
  }]);
}

function harness(overrides: Partial<MergeExecutorDeps> = {}) {
  const events: string[] = [];
  const deps: MergeExecutorDeps = {
    readCandidate: async () => candidate(),
    credentials: pool(),
    mergeExactHead: async ({ head, credential }) => {
      events.push(`merge:${head}:${credential.login}`);
      return { status: 'merged', head, mergeCommitOid: gitOid('2'.repeat(40)) };
    },
    reconcileDone: async ({ expectedHead }) => {
      events.push(`done:${expectedHead}`);
    },
    ...overrides,
  };
  return { deps, events };
}

describe('head-pinned merge executor', () => {
  it.each([
    ['closed', { open: false }],
    ['draft', { draft: true }],
    ['Human', { humanHold: true }],
    ['author', { authorAllowed: false }],
    ['mapping', { uniqueIssueMapping: false }],
    ['marker', { terminalApprovalMatches: false }],
    ['requested changes', {
      effectiveReviews: [{ reviewer: 'other', state: 'CHANGES_REQUESTED' as const, commitId: HEAD }],
    }],
    ['empty checks', { checks: [] }],
    ['pending check', { checks: [{ name: 'test', status: 'IN_PROGRESS', conclusion: null }] }],
    ['failed check', {
      checks: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }],
    }],
    ['behind', { compareStatus: 'behind' as const }],
    ['conflict', { mergeable: 'CONFLICTING' as const }],
    ['unknown', { mergeable: 'UNKNOWN' as const }],
    ['changed files', { changedFilesComplete: false }],
    ['CODEOWNERS read', { codeownersComplete: false }],
    ['CODEOWNER path', { codeownerSensitive: true }],
    ['wrong base', { baseRefName: gitRefName('main') }],
  ])('fails closed for %s', (_name, override) => {
    expect(evaluateMergeGate(candidate(override))).toMatchObject({ pass: false });
  });

  it('rereads every gate and sends the exact head without bypass flags', async () => {
    const h = harness();
    await expect(
      executeMergeAction({ prNumber: 84, expectedHead: HEAD }, h.deps),
    ).resolves.toEqual({
      status: 'merged',
      prNumber: 84,
      head: HEAD,
      mergeCommitOid: gitOid('2'.repeat(40)),
    });
    expect(h.events).toEqual([`merge:${HEAD}:implementation-bot`, `done:${HEAD}`]);
  });

  it('rejects a changed head on the immediate pre-merge reread', async () => {
    let reads = 0;
    const moved = gitOid('9'.repeat(40));
    const h = harness({
      readCandidate: async () => candidate({ head: reads++ === 0 ? HEAD : moved }),
    });
    await expect(
      executeMergeAction({ prNumber: 84, expectedHead: HEAD }, h.deps),
    ).resolves.toEqual({ status: 'changed-head', prNumber: 84, head: moved });
    expect(h.events).toEqual([]);
  });

  it('allows concurrent attempts and accepts already-merged exact readback', async () => {
    let merged = false;
    const h = harness({
      mergeExactHead: async () => {
        if (merged) return { status: 'already-merged', head: HEAD, mergeCommitOid: gitOid('2'.repeat(40)) };
        merged = true;
        return { status: 'merged', head: HEAD, mergeCommitOid: gitOid('2'.repeat(40)) };
      },
    });
    const results = await Promise.all([
      executeMergeAction({ prNumber: 84, expectedHead: HEAD }, h.deps),
      executeMergeAction({ prNumber: 84, expectedHead: HEAD }, h.deps),
    ]);
    expect(results.every((result) => result.status === 'merged')).toBe(true);
  });

  it('does not report terminal success when Done projection is ambiguous', async () => {
    const h = harness({
      reconcileDone: async () => {
        throw new Error('readback ambiguous');
      },
    });
    await expect(
      executeMergeAction({ prNumber: 84, expectedHead: HEAD }, h.deps),
    ).resolves.toMatchObject({ status: 'merged-projection-pending' });
  });
});

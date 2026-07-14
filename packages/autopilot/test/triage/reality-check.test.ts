import { describe, it, expect } from 'vitest';
import { classifyRealityCheck } from '../../src/triage/reality-check.js';
import type {
  CommitSignal,
  PrSignal,
  RealityCheckInput,
} from '../../src/triage/types.js';

/**
 * Unit tests for the pure-function reality-check classifier.
 *
 * The classifier consumes a {@link RealityCheckInput} (already-gathered
 * signals) and emits a {@link RealityCheckVerdict}. Gathering itself lives
 * in `gather.ts`; these tests model the cases the gatherer is expected to
 * produce.
 */

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function pr(overrides: Partial<PrSignal> & { number: number }): PrSignal {
  return {
    state: 'MERGED',
    mergeCommitOid: null,
    bodyClosesIssue: true,
    headRefName: 'feat/fix-thing',
    title: 'fix: thing',
    ...overrides,
  };
}

function commit(overrides: Partial<CommitSignal> & { sha: string }): CommitSignal {
  return {
    subject: 'fix: something (#572)',
    isRevert: false,
    reachableFrom: { trunk: [], side: [] },
    ...overrides,
  };
}

function input(overrides: Partial<RealityCheckInput> & { issueNumber: number }): RealityCheckInput {
  return {
    closedByPrNumbers: [],
    prs: [],
    commits: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('classifyRealityCheck', () => {
  it('returns clear when there are no PRs and no commits', () => {
    const verdict = classifyRealityCheck(input({ issueNumber: 572 }));
    expect(verdict.classification).toBe('clear');
    expect(verdict.suggestedBlockedOn).toBeNull();
    expect(verdict.suggestedComment).toBeNull();
  });

  it('returns pr-open when an OPEN PR references the issue', () => {
    const verdict = classifyRealityCheck(
      input({
        issueNumber: 572,
        prs: [
          pr({
            number: 999,
            state: 'OPEN',
            bodyClosesIssue: true,
            title: 'feat: triage reality check',
          }),
        ],
      }),
    );
    expect(verdict.classification).toBe('pr-open');
    expect(verdict.suggestedBlockedOn).toBe('Another issue');
    expect(verdict.suggestedComment).toMatch(/#999/);
    expect(verdict.suggestedComment).toMatch(/coordinator deferring/i);
    expect(verdict.evidence.prNumber).toBe(999);
  });

  it('returns fixed-on-trunk when a merged PR + commit on next is found', () => {
    const verdict = classifyRealityCheck(
      input({
        issueNumber: 572,
        prs: [pr({ number: 600, state: 'MERGED', mergeCommitOid: 'abc1234' })],
        commits: [
          commit({
            sha: 'abc1234',
            subject: 'feat: ship triage (#572)',
            reachableFrom: { trunk: ['next'], side: [] },
          }),
        ],
      }),
    );
    expect(verdict.classification).toBe('fixed-on-trunk');
    expect(verdict.suggestedBlockedOn).toBe('Human');
    expect(verdict.suggestedComment).toMatch(/abc1234/);
    expect(verdict.suggestedComment).toMatch(/\bnext\b/);
    expect(verdict.evidence.sha).toBe('abc1234');
    expect(verdict.evidence.branch).toBe('next');
  });

  it('returns fixed-on-trunk when the commit is reachable from main', () => {
    const verdict = classifyRealityCheck(
      input({
        issueNumber: 572,
        prs: [pr({ number: 600, state: 'MERGED', mergeCommitOid: 'feedbee' })],
        commits: [
          commit({
            sha: 'feedbee',
            subject: 'fix: thing (#572)',
            reachableFrom: { trunk: ['main'], side: [] },
          }),
        ],
      }),
    );
    expect(verdict.classification).toBe('fixed-on-trunk');
    expect(verdict.evidence.branch).toBe('main');
  });

  it('returns fixed-pending-backmerge for issue #561 with c627afc2 only on release/v2026.05.25 (AC #4)', () => {
    const verdict = classifyRealityCheck(
      input({
        issueNumber: 561,
        prs: [pr({ number: 562, state: 'MERGED', mergeCommitOid: 'c627afc2' })],
        commits: [
          commit({
            sha: 'c627afc2',
            subject: 'fix: scarce thing (#561)',
            reachableFrom: {
              trunk: [],
              side: [{ kind: 'release', name: 'release/v2026.05.25' }],
            },
          }),
        ],
      }),
    );
    expect(verdict.classification).toBe('fixed-pending-backmerge');
    expect(verdict.suggestedBlockedOn).toBe('Human');
    expect(verdict.suggestedComment).toMatch(/release\/v2026\.05\.25/);
    expect(verdict.suggestedComment).toMatch(/c627afc2/);
    expect(verdict.suggestedComment).toMatch(/pending back-merge to `next`/);
    expect(verdict.evidence.branch).toBe('release/v2026.05.25');
    expect(verdict.evidence.sha).toBe('c627afc2');
  });

  it('returns fixed-pending-backmerge for hotfix branches too', () => {
    const verdict = classifyRealityCheck(
      input({
        issueNumber: 572,
        prs: [pr({ number: 600, state: 'MERGED', mergeCommitOid: 'deadbeef' })],
        commits: [
          commit({
            sha: 'deadbeef',
            subject: 'fix: urgent (#572)',
            reachableFrom: {
              trunk: [],
              side: [{ kind: 'hotfix', name: 'hotfix/v2026.05.20-x' }],
            },
          }),
        ],
      }),
    );
    expect(verdict.classification).toBe('fixed-pending-backmerge');
    expect(verdict.evidence.branch).toBe('hotfix/v2026.05.20-x');
  });

  it('returns fixed-direct-commit when a MERGED PR has mergeCommitOid:null and a trunk commit exists', () => {
    // A merged PR that references the issue but reports `mergeCommitOid: null`
    // (e.g. squash-merge edge cases, gh API hiccups) MUST NOT bind to the
    // trunk commit — `relatedClosingPr` requires a non-null oid. With no PR
    // binding, the trunk commit alone drives the verdict and we land on
    // `fixed-direct-commit`. Locks current behaviour so future refactors
    // don't silently regress it.
    const verdict = classifyRealityCheck(
      input({
        issueNumber: 572,
        prs: [
          pr({
            number: 600,
            state: 'MERGED',
            mergeCommitOid: null,
            bodyClosesIssue: true,
          }),
        ],
        commits: [
          commit({
            sha: 'abc1234',
            subject: 'fix: foo (#572)',
            reachableFrom: { trunk: ['next'], side: [] },
          }),
        ],
      }),
    );
    expect(verdict.classification).toBe('fixed-direct-commit');
    expect(verdict.evidence.sha).toBe('abc1234');
    expect(verdict.evidence.branch).toBe('next');
    expect(verdict.evidence.prNumber).toBeUndefined();
  });

  it('returns fixed-direct-commit when no PR exists but a commit is on next', () => {
    const verdict = classifyRealityCheck(
      input({
        issueNumber: 572,
        prs: [],
        commits: [
          commit({
            sha: 'abc1234',
            subject: 'fix: foo (#572)',
            reachableFrom: { trunk: ['next'], side: [] },
          }),
        ],
      }),
    );
    expect(verdict.classification).toBe('fixed-direct-commit');
    expect(verdict.suggestedBlockedOn).toBe('Human');
    expect(verdict.suggestedComment).toMatch(/abc1234/);
    expect(verdict.evidence.sha).toBe('abc1234');
  });

  it('downgrades fixed-on-trunk to clear when the most-recent commit is a revert', () => {
    const verdict = classifyRealityCheck(
      input({
        issueNumber: 572,
        prs: [pr({ number: 600, state: 'MERGED', mergeCommitOid: 'fix0000' })],
        // newest-first ordering: revert is the most recent
        commits: [
          commit({
            sha: 'revert01',
            subject: 'Revert "fix: foo (#572)"',
            isRevert: true,
            reachableFrom: { trunk: ['next'], side: [] },
          }),
          commit({
            sha: 'fix0000',
            subject: 'fix: foo (#572)',
            reachableFrom: { trunk: ['next'], side: [] },
          }),
        ],
      }),
    );
    expect(verdict.classification).toBe('clear');
    expect(verdict.evidence.revertedShas).toContain('revert01');
  });

  it('treats body-grep without Closes/Fixes/Resolves and not in closedByPrNumbers as clear', () => {
    const verdict = classifyRealityCheck(
      input({
        issueNumber: 572,
        // PR body merely mentions #572 (e.g. "related to #572"); no closure keyword
        // and not in closedByPrNumbers → bodyClosesIssue must be false from the gatherer.
        prs: [
          pr({
            number: 700,
            state: 'MERGED',
            mergeCommitOid: 'aaaa1234',
            bodyClosesIssue: false,
          }),
        ],
        commits: [],
      }),
    );
    expect(verdict.classification).toBe('clear');
  });

  it('honours closedByPullRequestsReferences even when body keyword is absent', () => {
    // Gatherer convention: when the PR is in closedByPrNumbers, it sets
    // bodyClosesIssue=true regardless of body text. The classifier treats it
    // identically. Belt-and-braces: assert the relationship is honoured.
    const verdict = classifyRealityCheck(
      input({
        issueNumber: 572,
        closedByPrNumbers: [700],
        prs: [
          pr({
            number: 700,
            state: 'MERGED',
            mergeCommitOid: 'aaaa1234',
            bodyClosesIssue: true, // set true by gatherer because of closedByPrNumbers
          }),
        ],
        commits: [
          commit({
            sha: 'aaaa1234',
            subject: 'fix: foo (#572)',
            reachableFrom: { trunk: ['next'], side: [] },
          }),
        ],
      }),
    );
    expect(verdict.classification).toBe('fixed-on-trunk');
  });

  it('treats unrelated PRs (bodyClosesIssue=false, no commit) as clear', () => {
    // Digit-boundary case: gatherer filtered out a PR whose body mentioned
    // #5721 — it never reaches the classifier as a hit. Model that as
    // bodyClosesIssue=false, no commit.
    const verdict = classifyRealityCheck(
      input({
        issueNumber: 572,
        prs: [
          pr({
            number: 800,
            state: 'MERGED',
            mergeCommitOid: 'cafef00d',
            bodyClosesIssue: false,
          }),
        ],
        commits: [],
      }),
    );
    expect(verdict.classification).toBe('clear');
  });

  it('downgrades fixed-pending-backmerge by one tier when the latest commit on the side branch is a revert', () => {
    // Less common but symmetrical: a revert on the side branch with no
    // surviving fix → downgrade to clear via the same `collapsedToClear`
    // post-pass the trunk bucket uses. The classifier always collapses to
    // `clear` here (it never emits `fixed-direct-commit` from the side-only
    // bucket); the revert SHAs are surfaced on the evidence so the operator
    // can see why.
    const verdict = classifyRealityCheck(
      input({
        issueNumber: 572,
        prs: [pr({ number: 600, state: 'MERGED', mergeCommitOid: 'fix0000' })],
        commits: [
          commit({
            sha: 'revert02',
            subject: 'Revert "fix: foo (#572)"',
            isRevert: true,
            reachableFrom: {
              trunk: [],
              side: [{ kind: 'release', name: 'release/v2026.05.25' }],
            },
          }),
          commit({
            sha: 'fix0000',
            subject: 'fix: foo (#572)',
            reachableFrom: {
              trunk: [],
              side: [{ kind: 'release', name: 'release/v2026.05.25' }],
            },
          }),
        ],
      }),
    );
    expect(verdict.classification).toBe('clear');
    expect(verdict.evidence.revertedShas).toContain('revert02');
  });
});

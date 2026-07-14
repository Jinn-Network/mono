/**
 * Triage reality-check classifier — pure function.
 *
 * Consumes pre-gathered signals (PRs + commits) and emits a verdict the
 * `implement-issue` skill uses to gate Step 2 (worktree creation). The
 * classifier never touches the network or the filesystem; the gatherer
 * (`gather.ts`) is the only module that shells out.
 *
 * The precedence order is fixed and documented on
 * {@link classifyRealityCheck}; tests in
 * `test/triage/reality-check.test.ts` lock it in.
 */

import type {
  CommitSignal,
  RealityCheckInput,
  RealityCheckVerdict,
  SuggestedBlockedOn,
} from './types.js';

// ---------------------------------------------------------------------------
// Subject-line patterns
// ---------------------------------------------------------------------------

/**
 * Matches a commit subject that is itself a revert. Recognises:
 *   - `Revert "fix: foo (#572)"` — git's default revert format
 *   - `revert(scope): foo` — Conventional-Commits revert prefix
 */
export const REVERT_SUBJECT_RE = /^(Revert "|revert\()/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Buckets {
  /** Commits that have at least one trunk reach. */
  trunk: CommitSignal[];
  /** Commits that have at least one side-branch reach but no trunk reach. */
  sideOnly: CommitSignal[];
}

function bucketCommits(commits: CommitSignal[]): Buckets {
  const trunk: CommitSignal[] = [];
  const sideOnly: CommitSignal[] = [];
  for (const c of commits) {
    if (c.reachableFrom.trunk.length > 0) {
      trunk.push(c);
    } else if (c.reachableFrom.side.length > 0) {
      sideOnly.push(c);
    }
    // Commits with no reach at all are informational only; ignored here.
  }
  return { trunk, sideOnly };
}

/** Pick the most-recent (commits are newest-first) non-revert commit. */
function firstNonRevert(commits: CommitSignal[]): CommitSignal | undefined {
  return commits.find((c) => !c.isRevert);
}

/** Collect the SHAs of revert commits in a bucket. */
function revertShas(commits: CommitSignal[]): string[] {
  return commits.filter((c) => c.isRevert).map((c) => c.sha);
}

/**
 * Per the design note: when the most-recent reachable commit referencing
 * `#N` on a bucket is a revert, downgrade by one tier. We collapse the
 * affected bucket's verdict to `clear` and surface the revert SHAs so the
 * operator can see why.
 *
 * Newest-first ordering means the dominant commit is index 0.
 */
function isRevertDominant(commits: CommitSignal[]): boolean {
  return commits[0]?.isRevert === true;
}

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/**
 * Classify the gathered signals.
 *
 * Precedence (evaluated top-down; the first matching rule wins):
 *
 *   1. `pr-open`                 — any PR with `state === 'OPEN'` and
 *                                  `bodyClosesIssue === true`.
 *   2. `fixed-on-trunk`          — at least one commit with a trunk reach.
 *                                  Revert-downgrade: if the most-recent
 *                                  reachable commit on trunk is a revert,
 *                                  downgrade by one tier (collapses to
 *                                  `clear` when no surviving fix exists).
 *   3. `fixed-pending-backmerge` — no trunk-reach commit, but at least one
 *                                  commit with a side-branch reach. Same
 *                                  revert-downgrade rule applies.
 *   4. `fixed-direct-commit`     — handled inside rule 2 when there is no
 *                                  associated merged PR (i.e. a direct
 *                                  trunk commit). The classifier emits this
 *                                  label specifically when no PR references
 *                                  the issue.
 *   5. `clear`                   — no surviving signal.
 */
export function classifyRealityCheck(input: RealityCheckInput): RealityCheckVerdict {
  // ---- 1. OPEN PR wins outright. -----------------------------------------
  const openPr = input.prs.find(
    (p) => p.state === 'OPEN' && p.bodyClosesIssue,
  );
  if (openPr != null) {
    return verdict('pr-open', {
      blockedOn: 'Another issue',
      comment: `Open PR #${openPr.number} appears to address this; coordinator deferring.`,
      evidence: { prNumber: openPr.number },
    });
  }

  // ---- 2 & 4. Trunk-reach commits. ---------------------------------------
  const bucketed = bucketCommits(input.commits);

  if (bucketed.trunk.length > 0) {
    const reverts = revertShas(bucketed.trunk);
    if (isRevertDominant(bucketed.trunk)) {
      return collapsedToClear(reverts);
    }
    // Safe: bucket is non-empty and head is not a revert, so `find` hits.
    const chosen = firstNonRevert(bucketed.trunk)!;
    const branch = chosen.reachableFrom.trunk[0];
    const closingPr = relatedClosingPr(input, chosen);
    const classification = closingPr != null ? 'fixed-on-trunk' : 'fixed-direct-commit';
    const comment =
      classification === 'fixed-on-trunk'
        ? `Fix landed on \`${branch}\` at ${chosen.sha} (PR #${closingPr!.number}). Coordinator deferring; verify before reopening.`
        : `Fix landed directly on \`${branch}\` at ${chosen.sha} (no PR). Coordinator deferring; verify before reopening.`;
    return verdict(classification, {
      blockedOn: 'Human',
      comment,
      evidence: {
        sha: chosen.sha,
        branch,
        ...(closingPr != null ? { prNumber: closingPr.number } : {}),
        ...(reverts.length > 0 ? { revertedShas: reverts } : {}),
      },
    });
  }

  // ---- 3. Side-branch reach only. ----------------------------------------
  if (bucketed.sideOnly.length > 0) {
    const reverts = revertShas(bucketed.sideOnly);
    if (isRevertDominant(bucketed.sideOnly)) {
      return collapsedToClear(reverts);
    }
    const chosen = firstNonRevert(bucketed.sideOnly)!;
    const sideBranch = chosen.reachableFrom.side[0];
    const closingPr = relatedClosingPr(input, chosen);
    const prSuffix = closingPr != null ? ` (PR #${closingPr.number})` : '';
    const comment =
      `Fix on \`${sideBranch.name}\` at ${chosen.sha}${prSuffix}` +
      `, pending back-merge to \`next\`. Coordinator deferring; verify before reopening.`;
    return verdict('fixed-pending-backmerge', {
      blockedOn: 'Human',
      comment,
      evidence: {
        sha: chosen.sha,
        branch: sideBranch.name,
        ...(closingPr != null ? { prNumber: closingPr.number } : {}),
        ...(reverts.length > 0 ? { revertedShas: reverts } : {}),
      },
    });
  }

  // ---- 5. No surviving signal. -------------------------------------------
  return verdict('clear', { blockedOn: null, comment: null, evidence: {} });
}

/** Revert-downgrade collapse: surface the reverting SHAs and report clear. */
function collapsedToClear(revertedShas: string[]): RealityCheckVerdict {
  return verdict('clear', {
    blockedOn: null,
    comment: null,
    evidence: { revertedShas },
  });
}

// ---------------------------------------------------------------------------
// Verdict factory + helpers
// ---------------------------------------------------------------------------

function verdict(
  classification: RealityCheckVerdict['classification'],
  parts: {
    blockedOn: SuggestedBlockedOn | null;
    comment: string | null;
    evidence: RealityCheckVerdict['evidence'];
  },
): RealityCheckVerdict {
  return {
    classification,
    evidence: parts.evidence,
    suggestedBlockedOn: parts.blockedOn,
    suggestedComment: parts.comment,
  };
}

/**
 * Find a PR that plausibly closed this issue with this specific commit:
 *
 *   - `mergeCommitOid` matches the commit SHA (prefix-tolerant), AND
 *   - `bodyClosesIssue` is true (either by closure keyword or by being in
 *     `closedByPullRequestsReferences`).
 *
 * The prefix-tolerance lets git's short SHA in `git log` match the full
 * 40-char `mergeCommitOid` from `gh`.
 */
function relatedClosingPr(input: RealityCheckInput, c: CommitSignal) {
  return input.prs.find(
    (p) =>
      p.bodyClosesIssue &&
      p.mergeCommitOid != null &&
      (p.mergeCommitOid === c.sha ||
        p.mergeCommitOid.startsWith(c.sha) ||
        c.sha.startsWith(p.mergeCommitOid)),
  );
}

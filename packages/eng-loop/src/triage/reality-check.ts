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

interface RelevantCommits {
  /** Commits that have at least one trunk reach. Empty if none. */
  trunk: CommitSignal[];
  /** Commits that have at least one side-branch reach but no trunk reach. */
  sideOnly: CommitSignal[];
  /** Commits with no reach at all (informational; not used for verdict). */
  unreachable: CommitSignal[];
}

function bucketCommits(commits: CommitSignal[]): RelevantCommits {
  const trunk: CommitSignal[] = [];
  const sideOnly: CommitSignal[] = [];
  const unreachable: CommitSignal[] = [];
  for (const c of commits) {
    if (c.reachableFrom.trunk.length > 0) {
      trunk.push(c);
    } else if (c.reachableFrom.side.length > 0) {
      sideOnly.push(c);
    } else {
      unreachable.push(c);
    }
  }
  return { trunk, sideOnly, unreachable };
}

/** Pick the most-recent (commits are newest-first) non-revert commit. */
function firstNonRevert(commits: CommitSignal[]): CommitSignal | undefined {
  return commits.find((c) => !c.isRevert);
}

/** Pick the most-recent commit overall (newest-first ordering). */
function firstAny(commits: CommitSignal[]): CommitSignal | undefined {
  return commits[0];
}

/** Collect the SHAs of revert commits in a bucket. */
function revertShas(commits: CommitSignal[]): string[] {
  return commits.filter((c) => c.isRevert).map((c) => c.sha);
}

/**
 * Per the design note: when the most-recent reachable commit referencing
 * `#N` on a bucket is a revert, downgrade by one tier. This implementation
 * applies the downgrade by treating the bucket's effective fix as "no
 * surviving non-revert commit" — i.e. the revert wins and the verdict
 * collapses one tier (e.g. `fixed-on-trunk` -> `clear` when no surviving
 * fix exists; `fixed-pending-backmerge` -> downgraded similarly).
 */
function isRevertDominant(commits: CommitSignal[]): boolean {
  // Newest-first ordering; the dominant commit is index 0.
  const head = commits[0];
  return head != null && head.isRevert;
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
      // Revert wins → downgrade to clear (no surviving signal). Surface the
      // revert SHAs so the operator can see why we collapsed.
      return verdict('clear', {
        blockedOn: null,
        comment: null,
        evidence: { revertedShas: reverts },
      });
    }
    const head = firstNonRevert(bucketed.trunk);
    // Defensive — if reverts are present but `firstNonRevert` returns
    // nothing, fall back to the head commit (shouldn't happen because
    // `isRevertDominant` already handled an all-revert bucket).
    const chosen = head ?? firstAny(bucketed.trunk)!;
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
      // Downgrade: pending-backmerge -> direct-commit; with no surviving
      // commit on either bucket, the verdict collapses to clear.
      return verdict('clear', {
        blockedOn: null,
        comment: null,
        evidence: { revertedShas: reverts },
      });
    }
    const head = firstNonRevert(bucketed.sideOnly) ?? firstAny(bucketed.sideOnly)!;
    const sideBranch = head.reachableFrom.side[0];
    const closingPr = relatedClosingPr(input, head);
    const comment =
      `Fix on \`${sideBranch.name}\` at ${head.sha}` +
      (closingPr != null ? ` (PR #${closingPr.number})` : '') +
      `, pending back-merge to \`next\`. Coordinator deferring; verify before reopening.`;
    return verdict('fixed-pending-backmerge', {
      blockedOn: 'Human',
      comment,
      evidence: {
        sha: head.sha,
        branch: sideBranch.name,
        ...(closingPr != null ? { prNumber: closingPr.number } : {}),
        ...(reverts.length > 0 ? { revertedShas: reverts } : {}),
      },
    });
  }

  // ---- 5. No surviving signal. -------------------------------------------
  return verdict('clear', { blockedOn: null, comment: null, evidence: {} });
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

/**
 * Triage reality-check — shared types.
 *
 * Step 1.5 of the `implement-issue` skill validates that the issue still
 * describes an unfixed problem before any worktree or Project mutations.
 * This module's job is to encode the classification outcome as a tagged
 * discriminated union so the SKILL.md branching is unambiguous and the
 * classifier is fully unit-testable.
 *
 * See `.claude/skills/implement-issue/SKILL.md` Step 1.5 for the human-side
 * rules; see `reality-check.ts` for the pure-function classifier; see
 * `gather.ts` for the shell-command signal gatherer.
 */

/**
 * The classifier's verdict.
 *
 * Evaluated in strict precedence order (highest first):
 *
 *   1. `pr-open`               — an OPEN PR references this issue
 *   2. `fixed-on-trunk`        — a merged PR + a commit on `next` or `main`
 *   3. `fixed-pending-backmerge` — a merged PR + a commit on a release/hotfix
 *                                 side-branch but not yet on `next`/`main`
 *   4. `fixed-direct-commit`   — no PR, but a commit referencing the issue is
 *                                reachable from `next` (direct trunk push)
 *   5. `clear`                 — no evidence; triage continues normally
 */
export type RealityClassification =
  | 'pr-open'
  | 'fixed-on-trunk'
  | 'fixed-pending-backmerge'
  | 'fixed-direct-commit'
  | 'clear';

/** The two trunk branches the dispatcher cares about. */
export type TrunkBranch = 'next' | 'main';

/** Side-branch kinds that are not trunk but may carry fixes pending a back-merge. */
export type SideBranchKind = 'release' | 'hotfix';

/**
 * One PR observed against the issue's number (either by body-reference or
 * via the issue's `closedByPullRequestsReferences` connection).
 */
export interface PrSignal {
  number: number;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  /** The squash-merge commit's SHA, or `null` when the PR is not merged or
   *  the merge strategy did not produce a single commit. */
  mergeCommitOid: string | null;
  /**
   * True when the PR body contains a Conventional-Commit-style closure
   * keyword (`Closes`/`Fixes`/`Resolves`) followed by `#<N>` at a word
   * boundary, OR the PR is in the issue's `closedByPullRequestsReferences`
   * connection. Body-grep alone (without the keyword) is treated as a
   * false-positive risk and ignored.
   */
  bodyClosesIssue: boolean;
  headRefName: string;
  title: string;
}

/**
 * One commit observed via `git log --all --grep="#<N>\b"`.
 *
 * The gatherer enriches each commit with the set of branches that contain
 * it (computed via `git branch -a --contains <sha>`), bucketed into trunk
 * and side branches. Branches outside `{ next, main, release/*, hotfix/* }`
 * are dropped — they do not influence classification.
 *
 * Commits MUST be ordered by recency (newest first) so the revert-downgrade
 * post-pass can detect a `Revert "…"` commit that supersedes the fix.
 */
export interface CommitSignal {
  sha: string;
  subject: string;
  /** `^Revert "` or `^revert(` — see {@link REVERT_SUBJECT_RE} in
   *  `reality-check.ts`. */
  isRevert: boolean;
  reachableFrom: {
    trunk: TrunkBranch[];
    side: { kind: SideBranchKind; name: string }[];
  };
}

/**
 * The classifier's input: all the signals the gatherer collected about a
 * single issue.
 */
export interface RealityCheckInput {
  issueNumber: number;
  /** PR numbers from `gh issue view --json closedByPullRequestsReferences`.
   *  Used as a trusted authority for `bodyClosesIssue` even when the body
   *  text lacks the closure keyword. */
  closedByPrNumbers: number[];
  prs: PrSignal[];
  /** Commits referencing the issue, ordered newest-first. */
  commits: CommitSignal[];
}

/** Project board "Blocked on" single-select option to set on a hit. */
export type SuggestedBlockedOn = 'Human' | 'Another issue';

/**
 * The classifier's output.
 *
 * The orchestrator (SKILL.md Step 1.5) reads `classification` to branch its
 * control flow, posts `suggestedComment` via `gh issue comment`, and sets
 * the Project's `Blocked on` field to `suggestedBlockedOn`. `evidence`
 * gives the comment author concrete handles (PR number, SHA, branch name)
 * for any escalation a human reviewer might do later.
 */
export interface RealityCheckVerdict {
  classification: RealityClassification;
  evidence: {
    prNumber?: number;
    sha?: string;
    branch?: string;
    /** SHAs of revert commits that downgraded the classification. */
    revertedShas?: string[];
  };
  /** `null` only when the verdict is `clear`. */
  suggestedBlockedOn: SuggestedBlockedOn | null;
  /** `null` only when the verdict is `clear`. */
  suggestedComment: string | null;
}

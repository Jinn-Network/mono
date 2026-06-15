/** The nine work-shape Issue Types (DR-2026-05-20-b). */
export type IssueShape =
  | 'feat' | 'fix' | 'refactor' | 'spike'
  | 'chore' | 'docs' | 'test' | 'incident' | 'design';

export type BlockedOn = 'Nothing' | 'Human' | 'Another issue';
export type Effort = 'Low' | 'Medium' | 'High';
export type Priority = 'P0' | 'P1' | 'P2' | 'P3' | 'P4';
// 'Human' is a parked lane: the dispatcher promotes escalated (Blocked on:
// Human) sessions into it so they leave the active "In Progress" column and
// are visible at a glance as "needs a human". It is never a dispatchable state
// (selectReady requires 'Todo') nor an in-flight state.
export type ProjectStatus = 'Todo' | 'In Progress' | 'Human' | 'In Review' | 'Done';

/** An issue as polled from the source, with its taxonomy fields. */
export interface PolledIssue {
  number: number;
  title: string;
  /** null = Issue Type not set — the issue is not triage-complete. */
  shape: IssueShape | null;
  blockedOn: BlockedOn | null;
  /**
   * Always `null` in v1. The "Blocked on" Project field stores the literal
   * string "Another issue" with no number suffix, so no issue number can be
   * extracted from it. Populating this field requires parsing the issue body,
   * deferred to Phase 3 (stacked dispatch). Keep the field for that future use.
   */
  blockedOnIssue: number | null;
  effort: Effort | null;
  priority: Priority | null;
  status: ProjectStatus | null;
  onBoard: boolean;
  /**
   * GitHub login of the issue's author — input to the `selectReady`
   * allowlist trust boundary (#497). Empty string = author missing from
   * the upstream `gh` payload; never matches any allowlist entry.
   */
  author: string;
  /**
   * The Project board item id (e.g. `PVTI_…`). Populated from the snapshot
   * when `onBoard` is true; `null` otherwise. `dispatchIssue` uses this to
   * mutate Project fields without re-querying the board — pre-#585 the
   * dispatcher made a separate `gh project item-list --limit 500` call here
   * costing ~96 GraphQL points per dispatch.
   */
  projectItemId: string | null;
  /**
   * True iff the issue's `Sprint` Iteration field on the Project board points
   * at the *current* iteration. The snapshot exposes `currentSprintIterationId`
   * at the top level and each item's `sprintIterationId`; this field is the
   * pre-computed equality so the ready-filter doesn't need to thread the
   * snapshot through. When no active sprint exists (or the field is absent),
   * every issue's value is `false` and sprint ordering becomes a no-op. (#609)
   */
  inCurrentSprint: boolean;
}

/** An issue that passed the ready-filter — safe to dispatch. */
export interface ReadyIssue extends PolledIssue {
  shape: IssueShape;          // non-null: ready issues are triage-complete
  priority: Priority;         // non-null: needed for ordering
  projectItemId: string;      // non-null: onBoard:true requires it (see ready-filter)
}

/** A session the dispatcher has spawned and is tracking. */
export interface InFlightSession {
  issueNumber: number;
  branch: string;
  worktreePath: string;
  pid: number | null;
  startedAt: number;     // epoch ms
  /**
   * Absolute path to the per-session stdout+stderr log
   * (`~/.jinn-client/eng-loop/sessions/<N>.log`, jinn-mono#533). Deterministic
   * from the issue number; `tail -f` this to watch a running session.
   */
  logPath: string;
}

/** The outcome of a finished implement-issue session. */
export interface SessionResult {
  issueNumber: number;
  outcome: 'pr-opened' | 'escalated';
  prNumber?: number;
  escalationStatus?: 'needs-decision' | 'blocked' | 'stuck';
}

export interface DispatcherConfig {
  /** Max simultaneous sessions. Default 3; practical ceiling ~5–7. */
  concurrencyCap: number;
  /** Stop pulling new issues when open ready PRs exceed this. */
  openPrBackpressure: number;
  /** Per-session wall-clock ceiling, ms. Generous — hours. */
  wallClockMs: number;
  /** v1 default implementer; per-issue label can override. */
  defaultImplementer: 'claude' | 'codex' | 'cursor';
  /**
   * GitHub logins whose issues the dispatcher may pick up (#497). Compared
   * case-insensitively against `PolledIssue.author`. Empty (the default) =
   * dispatch nothing — fail-safe when the operator forgets to configure it.
   * Source of truth is `JINN_DISPATCHER_AUTHOR_ALLOWLIST` (runner-read).
   */
  authorAllowlist: string[];
  /** Max simultaneous review-pr sessions. Separate from concurrencyCap so a PR
   *  flood cannot starve new implementation work (or vice-versa). */
  reviewCap: number;
  /** The opt-in label that gates review-pr participation. */
  engineReviewLabel: string;
  /**
   * GitHub login of the engine review bot. Used to detect whether a *current*
   * review already exists (review by this login at/after the latest commit).
   * Empty (the default) = skip all review dispatch — fail-safe, mirroring
   * `authorAllowlist`. Source: `JINN_REVIEW_BOT_LOGIN` (runner-read).
   */
  reviewBotLogin: string;
}

export const DEFAULT_CONFIG: DispatcherConfig = {
  concurrencyCap: 3,
  // PR backpressure ceiling: pause dispatch when this many open PRs target `next`.
  // 30 is enough headroom for a normal sprint's worth of in-flight + parked work
  // without the dispatcher idling on a healthy queue. Override per run with
  // `--backpressure N` on scripts/run-eng-loop.ts.
  openPrBackpressure: 30,
  wallClockMs: 4 * 60 * 60 * 1000,
  defaultImplementer: 'claude',
  authorAllowlist: [],
  reviewCap: 3,
  engineReviewLabel: 'engine:review',
  reviewBotLogin: '',
};

/** A PR as polled from the PR source, with the fields the review loop needs. */
export interface PolledPr {
  number: number;
  title: string;
  /** Head branch name, e.g. "feat/418-foo" — the branch the review worktree checks out. */
  headRefName: string;
  /** Head commit oid (full SHA). */
  headRefOid: string;
  isDraft: boolean;
  /** GitHub login of the PR author. */
  author: string;
  /** True iff the PR carries the engine-review opt-in label. */
  hasReviewLabel: boolean;
  /**
   * True iff the PR needs a (re)review: no review by `reviewBotLogin` has been
   * submitted at or after the PR's latest commit. Once a current review exists
   * this is false, so the dispatcher stops re-spawning for an unchanged PR.
   */
  needsReview: boolean;
}

/** A PR that passed the review-ready filter — safe to dispatch a review-pr session for. */
export interface ReviewablePr extends PolledPr {
  hasReviewLabel: true;
  needsReview: true;
}

/** A review-pr session the dispatcher has spawned and is tracking (PR-keyed). */
export interface InFlightReview {
  prNumber: number;
  branch: string;
  worktreePath: string;
  pid: number | null;
  startedAt: number;
}

import { DEFAULT_HERMES_PYTHON } from './hermes-runtime.js';

/** The nine work-shape Issue Types (DR-2026-05-20-b). */
export type IssueShape =
  | 'feat' | 'fix' | 'refactor' | 'spike'
  | 'chore' | 'docs' | 'test' | 'incident' | 'design';

export type BlockedOn = 'Nothing' | 'Human' | 'Another issue';
export type Effort = 'Low' | 'Medium' | 'High' | 'XHigh' | 'Max';
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
   * Issue numbers this issue is blocked_by, from GitHub's native issue
   * dependencies (the snapshot's `blockedBy` connection). Empty when the issue
   * has no dependencies. The board `Blocked on` field only carries the flag
   * `Another issue` with no target; this list is the machine-readable edge the
   * stack-readiness resolver uses to decide whether a blocked issue can be
   * auto-unblocked and stacked on its blocker's open PR
   * (spec 2026-07-13-eng-loop-dependency-stacking-design.md).
   */
  blockedByIssues: number[];
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
  /**
   * Git ref to branch the worktree off and target the PR at. Set only when the
   * issue was admitted despite `Blocked on: Another issue` because its single
   * blocker has an open PR — the value is the blocker's PR head branch (e.g.
   * `feat/1570-…`). Absent for normally-ready issues, which default to
   * `origin/next` in `dispatchIssue`.
   */
  stackBase?: string;
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
   * (`~/.jinn-client/autopilot/sessions/<N>.log`, jinn-mono#533). Deterministic
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

/**
 * The CLI implementer agents the dispatcher can route work to.
 *
 * `claude` and `hermes` are REAL coordinators — `dispatch.ts` spawns their
 * respective CLIs. `codex` / `cursor` remain directive-only (they select
 * prompt text inside a claude coordinator); see `dispatch.ts`.
 */
export type Implementer = 'claude' | 'codex' | 'cursor' | 'hermes';

/**
 * One entry in the ordered implementer-routing policy. A rule matches an issue
 * when *every* specified predicate holds: `effort` (if present) must equal the
 * issue's Effort, and `shape` (if present) must equal the issue's Issue Type. A
 * rule with neither `effort` nor `shape` matches every issue (a catch-all).
 * Resolution is first-match-wins over the ordered `implementerRules` list.
 */
export interface ImplementerRule {
  effort?: Effort;
  shape?: IssueShape;
  implementer: Implementer;
}

export interface DispatcherConfig {
  /** Max simultaneous sessions. Default 3; practical ceiling ~5–7. */
  concurrencyCap: number;
  /** Stop pulling new issues when open ready PRs exceed this. */
  openPrBackpressure: number;
  /** Per-session wall-clock ceiling, ms. Generous — hours. */
  wallClockMs: number;
  /** v1 default implementer; per-issue label can override. */
  defaultImplementer: Implementer;
  /**
   * Ordered implementer-routing policy (#887). Empty (the default) = fall
   * through to `defaultImplementer` — today's single-implementer behaviour.
   * First-match-wins; see `ImplementerRule`. Source of truth is
   * `JINN_DISPATCHER_IMPLEMENTER_RULES` (runner-read JSON array).
   */
  implementerRules: ImplementerRule[];
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
  /**
   * GH token (fine-grained PAT / installation token) that *implement* sessions
   * authenticate as when authoring PRs. Injected per session via `GH_TOKEN`
   * (DR-2026-06-15). Empty = sessions inherit the runner's ambient `gh` account
   * (single-identity / legacy behaviour). Source: `JINN_IMPL_GH_TOKEN`.
   */
  implGhToken: string;
  /**
   * GH token that *review* sessions authenticate as when posting reviews. Must
   * resolve to a different account than `implGhToken` (GitHub forbids approving
   * your own PR) and to `reviewBotLogin` (else review-detection never matches).
   * Both are checked fail-loud at boot. Source: `JINN_REVIEW_GH_TOKEN`.
   */
  reviewGhToken: string;
  /**
   * Arm the merge-prep session loop (DR-2026-07-16): when a stuck (conflicting /
   * still-behind) pipeline PR is detected, dispatch an AI session that resolves
   * MECHANICAL conflicts on the PR branch and escalates SEMANTIC ones. Default
   * false — dead code until set. Requires the review loop armed (a re-drafted PR
   * is re-approved there); enforced fail-loud by `assertMergePrepArming`.
   * Source: `JINN_MERGE_PREP` (=== '1').
   */
  mergePrepEnabled: boolean;
  /** Max simultaneous merge-prep sessions. Default 1 (singleton — stuck PRs are
   *  rare, and serializing removes prep-vs-prep races on shared `origin/next`). */
  mergePrepCap: number;
  /**
   * Model id for `hermes` coordinator sessions, as `--model` to `hermes chat`.
   * BARE — never `<org>/<model>`: an org-prefixed id makes hermes infer the
   * `openrouter` provider and bill an API key instead of the operator's Codex
   * subscription. Hermes does not validate the id at runtime; only the provider
   * can reject it. Source: `JINN_DISPATCHER_HERMES_MODEL`.
   */
  hermesModel: string;
  /**
   * Provider for `hermes` coordinator sessions, passed EXPLICITLY (never
   * inferred). `openai-codex` = "Codex CLI via ChatGPT subscription or API key"
   * (models.py ProviderEntry) — it auto-selects the `codex_responses` api_mode
   * and the Codex base_url, and resolves credentials from hermes' own Codex
   * token store. Source: `JINN_DISPATCHER_HERMES_PROVIDER`.
   */
  hermesProvider: string;
  /** Python interpreter from the Hermes installation. Source:
   * `JINN_DISPATCHER_HERMES_PYTHON`. */
  hermesPythonPath: string;
}

export const DEFAULT_CONFIG: DispatcherConfig = {
  concurrencyCap: 3,
  // PR backpressure ceiling: pause dispatch when this many open PRs target `next`.
  // 30 is enough headroom for a normal sprint's worth of in-flight + parked work
  // without the dispatcher idling on a healthy queue. Override per run with
  // `--backpressure N` on scripts/run-autopilot.ts.
  openPrBackpressure: 30,
  wallClockMs: 4 * 60 * 60 * 1000,
  defaultImplementer: 'claude',
  implementerRules: [],
  authorAllowlist: [],
  reviewCap: 3,
  engineReviewLabel: 'engine:review',
  reviewBotLogin: '',
  implGhToken: '',
  reviewGhToken: '',
  mergePrepEnabled: false,
  mergePrepCap: 1,
  // Bare id + explicit provider: mirrors the operator's own working codex setup
  // (~/.codex/config.toml model = "gpt-5.6-sol"; ~/.hermes/config.yaml
  // provider: openai-codex). An `openai/`-prefixed id would silently route to
  // OpenRouter instead of the subscription.
  hermesModel: 'gpt-5.6-sol',
  hermesProvider: 'openai-codex',
  hermesPythonPath: DEFAULT_HERMES_PYTHON,
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
   * submitted at or after the PR's latest commit, or the bot's current verdict
   * is APPROVED while the PR is still draft (an incomplete ready transition).
   * A current approval suppresses redispatch only once the PR is non-draft.
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
  /** Unique persisted ownership generation; null means cleanup is forbidden. */
  leaseId?: string | null;
}

/** An in-flight merge-prep session, one per `jinn-mono_worktrees/merge-<N>`
 *  worktree. Mirrors InFlightReview (PR-keyed, no logPath in the derived shape;
 *  the worktree is detached so `branch` is ''). */
export interface InFlightMergePrep {
  prNumber: number;
  branch: string;
  worktreePath: string;
  pid: number | null;
  startedAt: number;
}

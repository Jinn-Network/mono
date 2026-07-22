import { DEFAULT_HERMES_PYTHON } from './hermes-runtime.js';
import {
  DEFAULT_CURSOR_BIN,
  DEFAULT_CURSOR_REVIEW_MODEL,
} from './cursor-runtime.js';
import type { AutopilotRuntime } from '../autopilot-runtime.js';

/** The nine work-shape Issue Types (DR-2026-05-20-b). */
export const ISSUE_SHAPES = [
  'feat', 'fix', 'refactor', 'spike',
  'chore', 'docs', 'test', 'incident', 'design',
] as const;
export type IssueShape = (typeof ISSUE_SHAPES)[number];
/** Runtime validation set — derive parsers from `ISSUE_SHAPES`, never re-list literals. */
export const ISSUE_SHAPE_SET: ReadonlySet<IssueShape> = new Set(ISSUE_SHAPES);

export type BlockedOn = 'Nothing' | 'Human' | 'Another issue';
export const EFFORTS = ['Low', 'Medium', 'High', 'XHigh', 'Max'] as const;
export type Effort = (typeof EFFORTS)[number];
/** Runtime validation set — derive parsers from `EFFORTS`, never re-list literals. */
export const EFFORT_SET: ReadonlySet<Effort> = new Set(EFFORTS);
export type Priority = 'P0' | 'P1' | 'P2' | 'P3' | 'P4';
// 'Human' is a parked lane: the dispatcher promotes escalated (Blocked on:
// Human) sessions into it so they leave the active "In Progress" column and
// are visible at a glance as "needs a human". It is paint-only — never an
// admission or hold decision gate (hold authority is labels / Blocked on /
// structured markers).
export type ProjectStatus = 'Todo' | 'In Progress' | 'Human' | 'In Review' | 'Done';

/** An issue as polled from the source, with its taxonomy fields. */
export interface PolledIssue {
  number: number;
  title: string;
  /** Native GitHub labels retained for lifecycle Human-overlay evidence. */
  labels?: string[];
  /** Issue body; used for child-marker admission (Stage 2). */
  body?: string;
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
  shape: IssueShape;          // non-null: ready issues are triage-complete (children default to fix)
  priority: Priority;         // non-null: needed for ordering (children may resolve from labels)
  /**
   * Project item id when on the board. Machine children may be off-board
   * (`null`) and still ready (Stage 2).
   */
  projectItemId: string | null;
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

export interface DispatcherConfig {
  /** One process-wide runtime for implementation, review, and stages. */
  runtime: AutopilotRuntime;
  /** Max simultaneous sessions. Default 3; practical ceiling ~5–7. */
  concurrencyCap: number;
  /** Stop pulling new issues when open ready PRs exceed this. */
  openPrBackpressure: number;
  /** Per-session wall-clock ceiling, ms. Generous — hours. */
  wallClockMs: number;
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
  /**
   * Fixed Cursor model for review sessions (`effort: null`).
   * Implement sessions use `cursorModelForEffort` instead. Source:
   * `JINN_DISPATCHER_CURSOR_MODEL`.
   */
  cursorModel: string;
  /** Cursor Agent CLI binary. Source: `JINN_DISPATCHER_CURSOR_BIN`. */
  cursorBin: string;
  /**
   * Arm the delivery→PR bridge (issue #1892, spec
   * 2026-07-20-autopilot-marketplace-execution.md §"Delivery → PR bridge
   * (host-side)"): poll the marketplace indexer for delivered `jinn-repo.v1`
   * solution envelopes and turn each into a draft PR. Default false —
   * fail-safe. Source: `JINN_MARKETPLACE_BRIDGE`
   * (=== '1').
   */
  marketplaceBridgeEnabled: boolean;
  /**
   * Indexer base URL the bridge's `DeliveryReader` queries for solution
   * envelopes (GraphQL). Empty (the default) disables the bridge regardless
   * of `marketplaceBridgeEnabled` — no reader is constructed without it.
   * Source: `JINN_MARKETPLACE_INDEXER_URL`.
   */
  marketplaceIndexerUrl: string;
  /**
   * IPFS gateway base URL the bridge reads envelope/task documents from and
   * links in PR evidence sections. Source: `JINN_MARKETPLACE_IPFS_GATEWAY_URL`.
   */
  marketplaceIpfsGatewayUrl: string;
  /**
   * Creation-automation execution-mode switch (issue #1893, spec
   * 2026-07-20-autopilot-marketplace-execution.md §"Generator"): `'local'`
   * dispatches ready issues to a local coordinator session (`dispatchIssue`,
   * unchanged). `'marketplace'` routes them to the marketplace instead
   * (`routeToMarketplace` — see `./marketplace-route.js`): label + snapshot
   * marker, no local session, no GitHub credential handed to a solver.
   * Default `'local'` — fail-safe. Source:
   * `JINN_EXECUTION_MODE` (`'marketplace'` arms it; anything else is `local`).
   */
  executionMode: 'local' | 'marketplace';
}

export const DEFAULT_CONFIG: DispatcherConfig = {
  runtime: 'claude',
  concurrencyCap: 3,
  // PR backpressure ceiling: pause dispatch when this many open PRs target `next`.
  // 30 is enough headroom for a normal sprint's worth of in-flight + parked work
  // without the dispatcher idling on a healthy queue. Override per run with
  // `--backpressure N` on scripts/run-autopilot.ts.
  openPrBackpressure: 30,
  wallClockMs: 4 * 60 * 60 * 1000,
  authorAllowlist: [],
  reviewCap: 3,
  engineReviewLabel: 'engine:review',
  reviewBotLogin: '',
  implGhToken: '',
  reviewGhToken: '',

  // Bare id + explicit provider: mirrors the operator's own working codex setup
  // (~/.codex/config.toml model = "gpt-5.6-sol"; ~/.hermes/config.yaml
  // provider: openai-codex). An `openai/`-prefixed id would silently route to
  // OpenRouter instead of the subscription.
  hermesModel: 'gpt-5.6-sol',
  hermesProvider: 'openai-codex',
  hermesPythonPath: DEFAULT_HERMES_PYTHON,
  cursorModel: DEFAULT_CURSOR_REVIEW_MODEL,
  cursorBin: DEFAULT_CURSOR_BIN,
  marketplaceBridgeEnabled: false,
  marketplaceIndexerUrl: '',
  marketplaceIpfsGatewayUrl: 'https://gateway.autonolas.tech',
  executionMode: 'local',
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

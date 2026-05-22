/** The nine work-shape Issue Types (DR-2026-05-20-b). */
export type IssueShape =
  | 'feat' | 'fix' | 'refactor' | 'spike'
  | 'chore' | 'docs' | 'test' | 'incident' | 'design';

export type BlockedOn = 'Nothing' | 'Human' | 'Another issue';
export type Effort = 'Low' | 'Medium' | 'High';
export type Priority = 'P0' | 'P1' | 'P2' | 'P3' | 'P4';
export type ProjectStatus = 'Todo' | 'In Progress' | 'In Review' | 'Done';

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
   * GitHub login of the issue's author. Used by the author-allowlist
   * predicate in `selectReady` to enforce the trust boundary on the
   * autonomous dispatcher (issue #497). The empty string indicates the
   * field was missing from the upstream `gh issue list` payload (older
   * `gh` versions); such issues will never appear on the allowlist and
   * will be filtered as not-allowlisted.
   */
  author: string;
}

/** An issue that passed the ready-filter — safe to dispatch. */
export interface ReadyIssue extends PolledIssue {
  shape: IssueShape;     // non-null: ready issues are triage-complete
  priority: Priority;    // non-null: needed for ordering
}

/** A session the dispatcher has spawned and is tracking. */
export interface InFlightSession {
  issueNumber: number;
  branch: string;
  worktreePath: string;
  pid: number | null;
  startedAt: number;     // epoch ms
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
   * GitHub logins whose issues the dispatcher is allowed to pick up (#497).
   * Compared case-insensitively against `PolledIssue.author`. Default `[]` —
   * empty list means dispatch *nothing*, enforcing fail-safe behaviour when
   * the operator forgets to configure the allowlist. Source of truth is the
   * `JINN_DISPATCHER_AUTHOR_ALLOWLIST` env var read by the runner.
   */
  authorAllowlist: string[];
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
};

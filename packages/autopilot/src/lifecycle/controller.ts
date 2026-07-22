import { DEFAULT_FLOOR } from '../dispatcher/rate-limit-guard.js';
import {
  deriveLifecycle,
  deriveOrphanImplementationState,
} from './lifecycle.js';
import {
  planProjection,
  type OrphanBranchClaim,
  type ProjectionAction,
  type ProjectionContext,
} from './projection.js';
import {
  executeProjectionPlan,
  type ReconciliationReport,
  type ReconciliationWriter,
} from './reconciler.js';
import {
  LifecycleRateLimitError,
  type GitHubLifecycleSnapshot,
} from './snapshot.js';
import {
  scheduleActiveActions,
  type ActiveCandidate,
  type ActiveSchedulingSkip,
} from './active-scheduler.js';
import { childrenPathEnabled } from './child-issues.js';
import { chooseIntegrationLadderAction } from './integration-ladder.js';
import type {
  AutopilotMode,
  GitOid,
  HumanReason,
  IssueEligibilityReason,
  LifecycleMappingDiagnostic,
  LifecyclePhase,
  LifecycleView,
  LifecycleViewItem,
  NewWorkAction,
} from './types.js';

export type LifecycleCliCommand =
  | { readonly kind: 'status' }
  | { readonly kind: 'explain-issue'; readonly number: number }
  | { readonly kind: 'explain-pr'; readonly number: number };

export interface LifecycleCliOptions {
  readonly mode: AutopilotMode;
  readonly once: boolean;
  readonly command: LifecycleCliCommand;
  readonly json: boolean;
}

export interface LifecycleControllerDeps {
  readSnapshot(rateLimitFloor?: number): Promise<GitHubLifecycleSnapshot>;
  /**
   * Optional end-of-cycle GraphQL remaining probe. When set, the cycle report
   * includes `budget.pointsSpent` (start remaining − end remaining).
   */
  readRateLimitRemaining?(): Promise<number>;
  readonly writer?: ReconciliationWriter;
  readonly now: () => Date;
  readonly staleAfterMs: number;
  readonly runnerId: string;
  readonly cycleId: () => string;
  readonly rateLimitFloor?: number;
  readonly active?: {
    preflight(): Promise<{ readonly ok: boolean; readonly detail?: string }>;
    readLocalState(): {
      readonly remaining: {
        readonly implementation: number;
        readonly review: number;
      };
      readonly availableLogins: readonly string[];
      readonly implementationPreferredLogin: string;
    };
    readonly implementationBackpressureThreshold: number;
    /**
     * jinn-mono#1883: canary safety knob (`JINN_AUTOPILOT_ONLY_ISSUES`).
     * `undefined` means unrestricted — exactly current behavior. When set,
     * `runLifecycleCycle` restricts NEW-WORK claim scheduling (implement,
     * review, merge candidates) to issue numbers in this set.
     * It does not affect reconciliation/projection of existing items,
     * Human-overlay handling, or observe/recover output — those all run
     * unfiltered before this is consulted. Board archive lives in the
     * scheduled painter (Stage 3), not the cycle.
     */
    readonly onlyIssues?: ReadonlySet<number>;
    executeAction(
      action: NewWorkAction,
    ): Promise<{ readonly outcome: string; readonly reason?: string }>;
  };
}

export interface LifecycleStatusItem {
  readonly phase: LifecyclePhase;
  readonly underlyingPhase?: Exclude<LifecyclePhase, 'human'>;
  readonly issueNumber: number;
  readonly prNumber?: number;
  readonly head?: GitOid;
  readonly claimGeneration?: string;
  readonly progressAgeMs?: number;
  readonly stale: boolean;
  readonly legacy: boolean;
  readonly humanReason?: HumanReason;
  readonly eligible?: boolean;
  readonly eligibilityReason?: IssueEligibilityReason;
  readonly eligibilityDetail?: string;
  readonly desiredActions: readonly ProjectionAction[];
}

export interface LifecycleOrphanBranchClaimStatus {
  readonly kind: 'orphan-branch-claim';
  readonly phase: 'implementing' | 'awaiting-review' | 'human';
  readonly underlyingPhase?: 'implementing' | 'awaiting-review';
  readonly issueNumber: number;
  readonly head: GitOid;
  readonly headRefName: string;
  readonly claimGeneration: string;
  readonly claimAttempt: string;
  readonly claimRunner: string;
  readonly progressAgeMs?: number;
  readonly stale: boolean;
  readonly staleSince?: string;
  readonly staleReason?: 'branch-head-unchanged';
  readonly v2Marked: true;
  readonly humanHold: boolean;
  readonly humanReason?: HumanReason;
  readonly desiredActions: readonly ProjectionAction[];
}

export interface LifecycleStatusDiagnostic extends LifecycleMappingDiagnostic {
  readonly phase: 'human';
  readonly desiredActions: readonly ProjectionAction[];
}

export interface LifecycleLogEvent {
  readonly cycleId: string;
  readonly runnerId: string;
  readonly mode: AutopilotMode;
  readonly phase: LifecyclePhase;
  readonly subject: string;
  readonly head?: GitOid;
  readonly action: string;
  readonly outcome: string;
  readonly reason?: string;
}

export type LifecycleCycleReport =
  | {
      readonly status: 'rejected';
      readonly mode: AutopilotMode;
      readonly message: string;
      readonly items: readonly [];
      readonly orphanBranchClaims: readonly [];
      readonly diagnostics: readonly [];
      readonly events: readonly [];
    }
  | {
      readonly status: 'rate-limited';
      readonly mode: AutopilotMode;
      readonly message: string;
      readonly items: readonly [];
      readonly orphanBranchClaims: readonly [];
      readonly diagnostics: readonly [];
      readonly events: readonly [];
    }
  | {
      readonly status: 'ok';
      readonly mode: AutopilotMode;
      readonly cycleId: string;
      readonly runnerId: string;
      readonly capturedAt: string;
      readonly items: readonly LifecycleStatusItem[];
      readonly orphanBranchClaims: readonly LifecycleOrphanBranchClaimStatus[];
      readonly diagnostics: readonly LifecycleStatusDiagnostic[];
      readonly events: readonly LifecycleLogEvent[];
      readonly reconciliation?: ReconciliationReport;
      /** Stage 4: GraphQL points spent this cycle (start remaining − end). */
      readonly budget?: {
        readonly remainingStart: number;
        readonly remainingEnd: number;
        readonly pointsSpent: number;
      };
    };

function positiveNumber(raw: string | undefined, label: string): number {
  if (raw === undefined || !/^[1-9][0-9]*$/.test(raw)) throw new Error(`Invalid ${label}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`Invalid ${label}`);
  return value;
}

export function parseLifecycleCli(args: readonly string[]): LifecycleCliOptions {
  let mode: AutopilotMode = 'observe';
  let once = false;
  let dryRun = false;
  let json = false;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--once') {
      once = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--mode') {
      const value = args[index + 1];
      if (value !== 'observe' && value !== 'recover' && value !== 'active') {
        throw new Error('Invalid lifecycle mode');
      }
      mode = value;
      index += 1;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown lifecycle option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (dryRun) {
    mode = 'observe';
    once = true;
  }
  let command: LifecycleCliCommand = { kind: 'status' };
  if (positional.length === 1 && (positional[0] === 'status' || positional[0] === 'sessions')) {
    // Both names intentionally render the same GitHub-derived lifecycle view.
  } else if (positional.length > 0) {
    if (positional[0] !== 'explain' || positional.length !== 3) {
      throw new Error('Expected status, sessions, explain issue <N>, or explain pr <N>');
    }
    if (positional[1] === 'issue') {
      command = { kind: 'explain-issue', number: positiveNumber(positional[2], 'issue number') };
    } else if (positional[1] === 'pr') {
      command = { kind: 'explain-pr', number: positiveNumber(positional[2], 'PR number') };
    } else {
      throw new Error('Expected explain issue <N> or explain pr <N>');
    }
  }
  return { mode, once, command, json };
}

function projectionContext(
  snapshot: GitHubLifecycleSnapshot,
  view: ReturnType<typeof deriveLifecycle>,
  now: Date,
  staleAfterMs: number,
): ProjectionContext {
  const prBranches = new Set(snapshot.pullRequests.map((pr) => pr.headRefName));
  const ambiguousIssues = new Set(snapshot.diagnostics.flatMap((diagnostic) => (
    diagnostic.issueNumbers
  )));
  const terminalIssues = new Set<number>([
    ...snapshot.project.items
      .filter((item) => item.contentType === 'Issue' && item.status === 'Done')
      .map((item) => item.number),
    ...view.items
      .filter((item) => item.item.kind === 'pull-request' && item.phase === 'merged')
      .map((item) => item.item.issueNumber),
    ...snapshot.pullRequests
      .filter((pr) => pr.state === 'MERGED')
      .flatMap((pr) => pr.closingIssueNumbers),
  ]);
  const orphanBranchClaims: OrphanBranchClaim[] = snapshot.branches
    .filter((branch) => (
      branch.claim.phase === 'implement'
      && !prBranches.has(branch.headRefName)
      && !ambiguousIssues.has(branch.issueNumber)
      && !terminalIssues.has(branch.issueNumber)
    ))
    .map((branch) => {
      const projectIssue = snapshot.project.items.find((item) => (
        item.contentType === 'Issue' && item.number === branch.issueNumber
      ));
      const lifecycleIssue = snapshot.lifecycle.items.find((item) => (
        item.kind === 'issue' && item.issueNumber === branch.issueNumber
      ));
      const humanHold = projectIssue?.blockedOn === 'Human'
        || lifecycleIssue?.humanHold === true
        || lifecycleIssue?.labels.includes('review:needs-human') === true
        || lifecycleIssue?.labels.includes('autopilot:human') === true;
      const issueHumanReason = lifecycleIssue?.humanReason;
      const humanReason: HumanReason | undefined = issueHumanReason !== undefined
        ? issueHumanReason.phase === 'eligible'
          ? { ...issueHumanReason, phase: 'implementing' }
          : issueHumanReason
        : humanHold
          ? {
              phase: 'implementing' as const,
              code: 'implementation-escalation' as const,
              detail: projectIssue?.blockedOn === 'Human'
                ? 'Project Blocked on: Human'
                : lifecycleIssue?.labels.includes('autopilot:human') === true
                  ? 'Issue label: autopilot:human'
                  : 'Issue label: review:needs-human',
            }
          : undefined;
      const state = deriveOrphanImplementationState({
        headChangedAt: branch.headCommittedAt,
        phaseComplete: branch.claim.phaseComplete === true,
        humanHold,
        ...(humanReason === undefined ? {} : { humanReason }),
      }, now, staleAfterMs);
      return {
        issueNumber: branch.issueNumber,
        head: branch.headOid,
        headRefName: branch.headRefName,
        headChangedAt: branch.headCommittedAt,
        baseRefName: branch.claim.targetBase,
        claimAttempt: branch.claim.attempt,
        claimRunner: branch.claim.runner,
        projectStatus: projectIssue?.status ?? null,
        ...state,
        ...(humanHold ? { humanHold: true } : {}),
      };
    });
  return {
    view,
    pullRequests: snapshot.pullRequests.map((pr) => ({
      number: pr.number,
      ...(pr.reviewClaim === undefined ? {} : { reviewRefOid: pr.reviewClaim.oid }),
    })),
    orphanBranchClaims,
    mappingDiagnostics: snapshot.diagnostics,
  };
}

function actionMatchesView(action: ProjectionAction, view: LifecycleViewItem): boolean {
  if ('prNumber' in action && view.item.kind === 'pull-request') {
    return action.prNumber === view.item.prNumber;
  }
  return 'issueNumber' in action && action.issueNumber === view.item.issueNumber;
}

function progressAge(view: LifecycleViewItem, now: Date): number | undefined {
  if (view.item.kind !== 'pull-request') return undefined;
  const item = view.item;
  const headAt = Date.parse(item.headChangedAt);
  if (!Number.isFinite(headAt)) return undefined;
  let progressAt = headAt;
  const claim = item.reviewClaim;
  const verdict = item.terminalVerdict;
  if (
    claim?.verdict !== undefined
    && claim.head === item.head
    && verdict !== undefined
    && verdict.head === item.head
    && verdict.marker === claim.verdict.marker
    && verdict.state === claim.verdict.state
  ) {
    const verdictAt = Date.parse(verdict.recordedAt);
    if (Number.isFinite(verdictAt) && verdictAt <= now.getTime() && verdictAt > progressAt) {
      progressAt = verdictAt;
    }
  }
  return Math.max(0, now.getTime() - progressAt);
}

function statusItems(
  view: ReturnType<typeof deriveLifecycle>,
  actions: readonly ProjectionAction[],
  now: Date,
  orphanBranchClaims: readonly OrphanBranchClaim[],
): LifecycleStatusItem[] {
  const orphanIssues = new Set(orphanBranchClaims.map((claim) => claim.issueNumber));
  return view.items
    .filter((entry) => !orphanIssues.has(entry.item.issueNumber))
    .map((entry): LifecycleStatusItem => {
      const item = entry.item;
      const claimGeneration = item.kind === 'pull-request'
        ? item.reviewClaim?.generation ?? item.branchClaim?.attempt
        : undefined;
      const age = progressAge(entry, now);
      return {
        phase: entry.phase,
        ...(entry.underlyingPhase === undefined ? {} : { underlyingPhase: entry.underlyingPhase }),
        issueNumber: item.issueNumber,
        ...(item.kind === 'pull-request'
          ? { prNumber: item.prNumber, head: item.head }
          : {}),
        ...(claimGeneration === undefined ? {} : { claimGeneration }),
        ...(age === undefined ? {} : { progressAgeMs: age }),
        stale: entry.stale,
        legacy: !item.v2Marked,
        ...(entry.humanReason === undefined ? {} : { humanReason: entry.humanReason }),
        ...(item.kind === 'issue'
          ? {
              eligible: item.eligible,
              ...(item.eligibilityReason === undefined
                ? {}
                : { eligibilityReason: item.eligibilityReason }),
              ...(item.eligibilityDetail === undefined
                ? {}
                : { eligibilityDetail: item.eligibilityDetail }),
            }
          : {}),
        desiredActions: actions.filter((action) => actionMatchesView(action, entry)),
      };
    });
}

function orphanStatusItems(
  claims: readonly OrphanBranchClaim[],
  actions: readonly ProjectionAction[],
): LifecycleOrphanBranchClaimStatus[] {
  return claims.map((claim): LifecycleOrphanBranchClaimStatus => {
    return {
      kind: 'orphan-branch-claim',
      phase: claim.phase,
      ...(claim.underlyingPhase === undefined
        ? {}
        : { underlyingPhase: claim.underlyingPhase }),
      issueNumber: claim.issueNumber,
      head: claim.head,
      headRefName: claim.headRefName,
      claimGeneration: claim.claimAttempt,
      claimAttempt: claim.claimAttempt,
      claimRunner: claim.claimRunner,
      ...(claim.progressAgeMs === undefined ? {} : { progressAgeMs: claim.progressAgeMs }),
      stale: claim.stale,
      ...(claim.staleSince === undefined ? {} : { staleSince: claim.staleSince }),
      ...(claim.staleReason === undefined ? {} : { staleReason: claim.staleReason }),
      v2Marked: true,
      humanHold: claim.phase === 'human',
      ...(claim.humanReason === undefined ? {} : { humanReason: claim.humanReason }),
      desiredActions: actions.filter((action) => (
        'issueNumber' in action && action.issueNumber === claim.issueNumber
      )),
    };
  });
}

function eventFor(
  result: ReconciliationReport['results'][number],
  items: readonly LifecycleStatusItem[],
  orphanBranchClaims: readonly LifecycleOrphanBranchClaimStatus[],
  diagnostics: readonly LifecycleStatusDiagnostic[],
  cycleId: string,
  runnerId: string,
  mode: 'recover' | 'active',
): LifecycleLogEvent {
  const action = result.action;
  const item = items.find((candidate) => (
    ('prNumber' in action && candidate.prNumber === action.prNumber)
    || ('issueNumber' in action && candidate.issueNumber === action.issueNumber)
  ));
  const orphan = orphanBranchClaims.find((candidate) => (
    'issueNumber' in action && action.issueNumber === candidate.issueNumber
  ));
  const issue = 'issueNumber' in action
    ? action.issueNumber
    : item?.issueNumber ?? orphan?.issueNumber;
  const pr = 'prNumber' in action ? action.prNumber : item?.prNumber;
  const diagnostic = diagnostics.find((candidate) => (
    (issue !== undefined && candidate.issueNumbers.includes(issue))
    || (pr !== undefined && candidate.pullRequests.some((candidatePr) => candidatePr.number === pr))
  ));
  return {
    cycleId,
    runnerId,
    mode,
    phase: item?.phase ?? orphan?.phase ?? diagnostic?.phase ?? 'eligible',
    subject: [
      issue === undefined ? null : `issue:${issue}`,
      pr === undefined ? null : `pr:${pr}`,
    ].filter((value): value is string => value !== null).join('/'),
    ...('expectedHead' in action ? { head: action.expectedHead } : {}),
    action: action.kind,
    outcome: result.outcome,
  };
}

function activeCandidates(
  snapshot: GitHubLifecycleSnapshot,
  view: ReturnType<typeof deriveLifecycle>,
): ActiveCandidate[] {
  const byPr = new Map(snapshot.pullRequests.map((pr) => [pr.number, pr]));
  const childImplementation: ActiveCandidate[] = [];
  const freshImplementation: ActiveCandidate[] = [];
  const other: ActiveCandidate[] = [];
  for (const entry of view.items) {
    const item = entry.item;
    if (
      entry.phase === 'eligible'
      && item.kind === 'issue'
      && item.eligible
      && !item.humanHold
    ) {
      const isChild = item.labels.includes('review-finding')
        || item.labels.includes('reconcile');
      (isChild ? childImplementation : freshImplementation).push({
        phase: 'implementation',
        issueNumber: item.issueNumber,
      });
      continue;
    }
    if (item.kind !== 'pull-request' || item.humanHold || item.merged) continue;
    const pr = byPr.get(item.prNumber);
    if (pr === undefined) continue;
    if (
      entry.phase === 'implementing'
      && entry.stale
      && item.isDraft
    ) {
      freshImplementation.push({
        phase: 'implementation',
        issueNumber: item.issueNumber,
      });
    } else if (
      entry.phase === 'awaiting-review'
      && item.isDraft
      && item.reviewClaim?.head === item.head
      && item.reviewClaim.state === 'stale'
    ) {
      other.push({
        phase: 'review',
        issueNumber: item.issueNumber,
        prNumber: item.prNumber,
        head: item.head,
        author: pr.author,
      });
    } else if (
      entry.phase === 'awaiting-review'
      && item.approved
      && !item.needsReview
      && (item.mergeState === 'behind' || item.mergeState === 'conflict')
      && !(item.openChildKinds ?? []).includes('reconcile')
    ) {
      const childrenOn = childrenPathEnabled();
      const ciGreen = pr.checks.length > 0 && pr.checks.every((check) => (
        check.status === 'COMPLETED'
        && check.conclusion !== null
        && ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(check.conclusion)
      ));
      const ladder = chooseIntegrationLadderAction({
        approved: true,
        ciGreen,
        draft: item.isDraft,
        humanHold: false,
        mergeable: pr.mergeability,
        mergeStateStatus: pr.mergeStateStatus,
        compareStatus: item.mergeState === 'behind'
          ? 'behind'
          : item.mergeState === 'conflict'
            ? 'diverged'
            : item.mergeState === 'clean'
              ? 'ahead'
              : 'unknown',
        openReconcileChild: (item.openChildKinds ?? []).includes('reconcile'),
        openFindingChild: (item.openChildKinds ?? []).includes('review-finding'),
        childrenEnabled: childrenOn,
      });
      if (ladder.kind === 'update-branch') {
        other.push({
          phase: 'update-branch',
          issueNumber: item.issueNumber,
          prNumber: item.prNumber,
          head: item.head,
        });
      } else if (ladder.kind === 'file-reconcile-child') {
        other.push({
          phase: 'file-reconcile-child',
          issueNumber: item.issueNumber,
          prNumber: item.prNumber,
          head: item.head,
          effort: ladder.effort,
        });
      }
    } else if (entry.phase === 'merge-ready') {
      other.push({
        phase: 'merge',
        issueNumber: item.issueNumber,
        prNumber: item.prNumber,
        head: item.head,
      });
    } else if (entry.phase === 'blocked-by-child') {
      // No new work while a child is open or head-bound RC stands; child
      // implementation claims are scheduled from the child issue itself.
    }
  }
  // Children outrank fresh implementation claims for the remaining slots.
  return [...childImplementation, ...freshImplementation, ...other];
}

function phaseForAction(action: NewWorkAction): LifecyclePhase {
  if (action.kind === 'claim-implementation') return 'eligible';
  if (action.kind === 'claim-review') return 'awaiting-review';
  if (action.kind === 'update-branch' || action.kind === 'file-reconcile-child') {
    return 'awaiting-review';
  }
  return 'merge-ready';
}

function subjectForAction(action: NewWorkAction): string {
  return action.kind === 'claim-implementation'
    ? `issue:${action.issueNumber}`
    : `issue:${action.issueNumber}/pr:${action.prNumber}`;
}

function phaseForSchedulingSkip(
  skip: ActiveSchedulingSkip,
): LifecyclePhase {
  if (skip.phase === 'implementation') return 'eligible';
  if (skip.phase === 'review') return 'awaiting-review';
  if (
    skip.phase === 'update-branch'
    || skip.phase === 'file-reconcile-child'
  ) {
    return 'awaiting-review';
  }
  return 'merge-ready';
}

// Reconcile-before-claim is a per-item guarantee, not a whole-cycle gate: a
// projection action pending for issue/PR X (e.g. a correcting project-status
// write just attempted this cycle, or a permanently-unappliable action like
// a comment on a locked conversation) must defer a new claim for X, but must
// never suppress claim scheduling for an unrelated issue/PR Y. Derived from
// so an item whose reconciliation was just corrected this cycle still waits
// for a fresh snapshot next cycle before claiming — only the *scope* narrows
// from the whole cycle to the specific item.
//
// `ensure-implementation-summary` is excluded (jinn-mono#1883 follow-up): it
// is a benign, idempotent PR-body content sync (the writer no-ops once the
// body already matches) that is orthogonal to claiming — a review claim
// advances a dedicated ref, never the PR body. `implementationComplete &&
// item.implementationSummary !== undefined` is permanently true once
// implementation finishes, so without this exclusion the action is emitted
// every cycle for every finalized PR and its issue is blocked forever, so
// `claim-review` is never scheduled.
function blockedIssueNumbers(
  actions: readonly ProjectionAction[],
  view: LifecycleView,
): ReadonlySet<number> {
  const issueByPr = new Map<number, number>();
  for (const entry of view.items) {
    if (entry.item.kind === 'pull-request') {
      issueByPr.set(entry.item.prNumber, entry.item.issueNumber);
    }
  }
  const blocked = new Set<number>();
  for (const action of actions) {
    if (action.kind === 'ensure-implementation-summary') continue;
    if ('issueNumber' in action && action.issueNumber !== undefined) {
      blocked.add(action.issueNumber);
      continue;
    }
    if ('prNumber' in action) {
      const issueNumber = issueByPr.get(action.prNumber);
      if (issueNumber !== undefined) blocked.add(issueNumber);
    }
  }
  return blocked;
}

// jinn-mono#1883: `onlyIssues === undefined` is the unrestricted (default)
// state — matches unset/empty `JINN_AUTOPILOT_ONLY_ISSUES`. When it is set,
// a candidate is admitted only if its issue number is a member. Every
// `ActiveCandidate` variant carries a required `issueNumber` sourced from an
// already-resolved lifecycle item (ambiguous PR-to-issue mappings are
// diverted to diagnostics upstream and never reach `activeCandidates`), so
// `issueNumber` here is typed loosely (`number | undefined`) only to fail
// closed defensively if that invariant is ever broken.
export function matchesOnlyIssuesAllowlist(
  issueNumber: number | undefined,
  onlyIssues: ReadonlySet<number> | undefined,
): boolean {
  if (onlyIssues === undefined) return true;
  return issueNumber !== undefined && onlyIssues.has(issueNumber);
}

export async function runLifecycleCycle(
  mode: AutopilotMode,
  deps: LifecycleControllerDeps,
): Promise<LifecycleCycleReport> {
  if (mode === 'active' && deps.active === undefined) {
    return {
      status: 'rejected',
      mode,
      message: 'active executor not configured',
      items: [],
      orphanBranchClaims: [],
      diagnostics: [],
      events: [],
    };
  }
  if ((mode === 'recover' || mode === 'active') && deps.writer === undefined) {
    return {
      status: 'rejected',
      mode,
      message: 'recover writer not configured',
      items: [],
      orphanBranchClaims: [],
      diagnostics: [],
      events: [],
    };
  }
  if (mode === 'active') {
    const preflight = await deps.active!.preflight();
    if (!preflight.ok) {
      return {
        status: 'rejected',
        mode,
        message: `active capability preflight failed: ${
          preflight.detail ?? 'required capability is unverified'
        }`,
        items: [],
        orphanBranchClaims: [],
        diagnostics: [],
        events: [],
      };
    }
  }
  const rateLimitFloor = deps.rateLimitFloor ?? DEFAULT_FLOOR;
  let snapshot: GitHubLifecycleSnapshot;
  try {
    snapshot = await deps.readSnapshot(rateLimitFloor);
  } catch (error) {
    if (error instanceof LifecycleRateLimitError) {
      return {
        status: 'rate-limited',
        mode,
        message: error.message,
        items: [],
        orphanBranchClaims: [],
        diagnostics: [],
        events: [],
      };
    }
    throw error;
  }
  if (snapshot.project.rateLimit.remaining < rateLimitFloor) {
    return {
      status: 'rate-limited',
      mode,
      message: `GitHub rate-limit budget low: ${snapshot.project.rateLimit.remaining} remaining`,
      items: [],
      orphanBranchClaims: [],
      diagnostics: [],
      events: [],
    };
  }
  const remainingStart = snapshot.project.rateLimit.remaining;
  const attachBudget = async <Report extends { readonly status: 'ok' }>(
    report: Report,
  ): Promise<Report & {
    readonly budget?: {
      readonly remainingStart: number;
      readonly remainingEnd: number;
      readonly pointsSpent: number;
    };
  }> => {
    if (deps.readRateLimitRemaining === undefined) return report;
    const remainingEnd = await deps.readRateLimitRemaining();
    return {
      ...report,
      budget: {
        remainingStart,
        remainingEnd,
        pointsSpent: Math.max(0, remainingStart - remainingEnd),
      },
    };
  };
  const now = deps.now();
  const view = deriveLifecycle(snapshot.lifecycle, now, deps.staleAfterMs);
  const context = projectionContext(snapshot, view, now, deps.staleAfterMs);
  const plan = planProjection(context);
  const cycleId = deps.cycleId();
  const items = statusItems(view, plan.actions, now, context.orphanBranchClaims);
  const orphanBranchClaims = orphanStatusItems(
    context.orphanBranchClaims,
    plan.actions,
  );
  const diagnostics: LifecycleStatusDiagnostic[] = snapshot.diagnostics.map((diagnostic) => ({
    ...diagnostic,
    phase: 'human',
    desiredActions: plan.actions.filter((action) => (
      ('prNumber' in action
        && diagnostic.pullRequests.some((pr) => pr.number === action.prNumber))
      || ('issueNumber' in action
        && action.issueNumber !== undefined
        && diagnostic.issueNumbers.includes(action.issueNumber))
    )),
  }));
  if (mode === 'observe') {
    return attachBudget({
      status: 'ok',
      mode,
      cycleId,
      runnerId: deps.runnerId,
      capturedAt: snapshot.capturedAt,
      items,
      orphanBranchClaims,
      diagnostics,
      events: [],
    });
  }
  const reconciliation = await executeProjectionPlan(plan, deps.writer!);
  const reconciliationEvents = reconciliation.results.map((result) => (
    eventFor(
      result,
      items,
      orphanBranchClaims,
      diagnostics,
      cycleId,
      deps.runnerId,
      mode === 'active' ? 'active' : 'recover',
    )
  ));
  // Stage 3: board-archive relocated to the scheduled painter
  // (`scripts/paint-board.ts`); the cycle no longer mutates Project Status
  // or archives Done items.
  if (mode === 'active') {
    const actionEvents: LifecycleLogEvent[] = [];
    const blockedIssues = blockedIssueNumbers(plan.actions, view);
    const local = deps.active!.readLocalState();
    const openPipelineBacklog = snapshot.pullRequests.filter((pr) => (
      pr.state === 'OPEN' && pr.labels.includes('engine:review')
    )).length;
    const scheduling = scheduleActiveActions({
      candidates: activeCandidates(snapshot, view).filter((candidate) => (
        !blockedIssues.has(candidate.issueNumber)
        && matchesOnlyIssuesAllowlist(candidate.issueNumber, deps.active!.onlyIssues)
      )),
      remaining: local.remaining,
      availableLogins: local.availableLogins,
      implementationPreferredLogin: local.implementationPreferredLogin,
      openPipelineBacklog,
      implementationBackpressureThreshold:
        deps.active!.implementationBackpressureThreshold,
    });
    actionEvents.push(...scheduling.skips.map((skip): LifecycleLogEvent => ({
      cycleId,
      runnerId: deps.runnerId,
      mode: 'active',
      phase: phaseForSchedulingSkip(skip),
      subject: skip.subject,
      action: 'schedule',
      outcome: 'skipped',
      reason: skip.reason,
    })));
    for (const action of scheduling.actions) {
      try {
        const result = await deps.active!.executeAction(action);
        actionEvents.push({
          cycleId,
          runnerId: deps.runnerId,
          mode: 'active',
          phase: phaseForAction(action),
          subject: subjectForAction(action),
          ...('head' in action ? { head: action.head } : {}),
          action: action.kind,
          outcome: result.outcome,
          ...(result.reason === undefined ? {} : { reason: result.reason }),
        });
      } catch (error) {
        actionEvents.push({
          cycleId,
          runnerId: deps.runnerId,
          mode: 'active',
          phase: phaseForAction(action),
          subject: subjectForAction(action),
          ...('head' in action ? { head: action.head } : {}),
          action: action.kind,
          outcome: 'failed',
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return attachBudget({
      status: 'ok',
      mode,
      cycleId,
      runnerId: deps.runnerId,
      capturedAt: snapshot.capturedAt,
      items,
      orphanBranchClaims,
      diagnostics,
      events: [...reconciliationEvents, ...actionEvents],
      reconciliation,
    });
  }
  return attachBudget({
    status: 'ok',
    mode,
    cycleId,
    runnerId: deps.runnerId,
    capturedAt: snapshot.capturedAt,
    items,
    orphanBranchClaims,
    diagnostics,
    events: reconciliationEvents,
    reconciliation,
  });
}

export function renderLifecycleJson(report: LifecycleCycleReport): string {
  return JSON.stringify(report, null, 2);
}

function explanation(item: LifecycleStatusItem): string {
  const identity = item.prNumber === undefined
    ? `Issue #${item.issueNumber}`
    : `PR #${item.prNumber} (issue #${item.issueNumber})`;
  if (item.phase === 'human') {
    return `${identity} is blocked in Human: ${item.humanReason?.detail ?? 'explicit Human hold'}.`;
  }
  if (item.stale) {
    return `${identity} is stale in ${item.phase}; recovery is awaiting an exact-head correction.`;
  }
  if (item.phase === 'eligible') {
    if (item.eligible === true) return `${identity} is eligible for an ordinary claim.`;
    return `${identity} is not eligible for an ordinary claim: ${
      item.eligibilityDetail ?? item.eligibilityReason ?? 'source admission gates did not select it'
    }.`;
  }
  if (item.phase === 'implementing') {
    return `${identity} is implementing and awaiting durable phase completion before review.`;
  }
  if (item.phase === 'awaiting-review') return `${identity} is awaiting an exact-head review claim.`;
  if (item.phase === 'reviewing') return `${identity} is reviewing the current exact head.`;
  if (item.phase === 'merge-ready') return `${identity} is awaiting the native merge gate.`;
  return `${identity} is merged and awaiting no lifecycle gate.`;
}

function orphanExplanation(item: LifecycleOrphanBranchClaimStatus): string {
  const identity = `Issue #${item.issueNumber} orphan branch claim ${item.headRefName}`;
  if (item.phase === 'human') {
    return `${identity} is blocked in Human: ${
      item.humanReason?.detail ?? 'explicit Human hold'
    }.`;
  }
  if (item.stale) {
    return `${identity} is stale in implementation and awaiting exact-head draft repair and requeue.`;
  }
  if (item.phase === 'awaiting-review') {
    return `${identity} completed implementation and is awaiting draft PR review recovery.`;
  }
  return `${identity} is implementing and awaiting draft PR repair.`;
}

export function explainIssue(report: LifecycleCycleReport, issueNumber: number): string {
  if (report.status !== 'ok') return report.message;
  const items = report.items.filter((item) => item.issueNumber === issueNumber);
  const orphans = report.orphanBranchClaims.filter((item) => item.issueNumber === issueNumber);
  const diagnostics = report.diagnostics.filter((diagnostic) => (
    diagnostic.issueNumbers.includes(issueNumber)
  ));
  if (items.length === 0 && orphans.length === 0 && diagnostics.length === 0) {
    return `Issue #${issueNumber} is not present in the complete lifecycle snapshot.`;
  }
  return [
    ...items.map(explanation),
    ...orphans.map(orphanExplanation),
    ...diagnostics.map((diagnostic) => `Issue #${issueNumber} is blocked in Human: ${diagnostic.detail}.`),
  ].join('\n');
}

export function explainPullRequest(report: LifecycleCycleReport, prNumber: number): string {
  if (report.status !== 'ok') return report.message;
  const item = report.items.find((candidate) => candidate.prNumber === prNumber);
  const diagnostic = report.diagnostics.find((candidate) => (
    candidate.pullRequests.some((pr) => pr.number === prNumber)
  ));
  if (item === undefined && diagnostic === undefined) {
    return `PR #${prNumber} is not present in the complete lifecycle snapshot.`;
  }
  return item === undefined
    ? `PR #${prNumber} is blocked in Human: ${diagnostic!.detail}.`
    : explanation(item);
}

export function renderLifecycleHuman(report: LifecycleCycleReport): string {
  if (report.status !== 'ok') return report.message;
  if (
    report.items.length === 0
    && report.orphanBranchClaims.length === 0
    && report.diagnostics.length === 0
    && report.events.length === 0
    && report.budget === undefined
  ) {
    return 'No lifecycle items.';
  }
  return [
    ...report.items.map(explanation),
    ...report.orphanBranchClaims.map(orphanExplanation),
    ...report.diagnostics.map((diagnostic) => `Human diagnostic: ${diagnostic.detail}.`),
    ...report.events.map((event) =>
      `${event.action} ${event.subject}: ${event.outcome}${
        event.reason === undefined ? '' : ` (${event.reason})`
      }.`),
    ...(report.budget === undefined
      ? []
      : [
          `points-spent: ${report.budget.pointsSpent} `
          + `(remaining ${report.budget.remainingStart} → ${report.budget.remainingEnd})`,
        ]),
  ].join('\n');
}

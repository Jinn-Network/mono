import { DEFAULT_FLOOR } from '../dispatcher/rate-limit-guard.js';
import { deriveLifecycle } from './lifecycle.js';
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
import type {
  AutopilotMode,
  GitOid,
  HumanReason,
  IssueEligibilityReason,
  LifecycleMappingDiagnostic,
  LifecyclePhase,
  LifecycleViewItem,
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
  readonly writer?: ReconciliationWriter;
  readonly now: () => Date;
  readonly staleAfterMs: number;
  readonly runnerId: string;
  readonly cycleId: () => string;
  readonly rateLimitFloor?: number;
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
  readonly phase: 'implementing' | 'human';
  readonly issueNumber: number;
  readonly head: GitOid;
  readonly headRefName: string;
  readonly claimGeneration: string;
  readonly claimAttempt: string;
  readonly claimRunner: string;
  readonly progressAgeMs: number;
  readonly stale: false;
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
      readonly mode: 'observe' | 'recover';
      readonly message: string;
      readonly items: readonly [];
      readonly orphanBranchClaims: readonly [];
      readonly diagnostics: readonly [];
      readonly events: readonly [];
    }
  | {
      readonly status: 'ok';
      readonly mode: 'observe' | 'recover';
      readonly cycleId: string;
      readonly runnerId: string;
      readonly capturedAt: string;
      readonly items: readonly LifecycleStatusItem[];
      readonly orphanBranchClaims: readonly LifecycleOrphanBranchClaimStatus[];
      readonly diagnostics: readonly LifecycleStatusDiagnostic[];
      readonly events: readonly LifecycleLogEvent[];
      readonly reconciliation?: ReconciliationReport;
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
): ProjectionContext {
  const prBranches = new Set(snapshot.pullRequests.map((pr) => pr.headRefName));
  const ambiguousIssues = new Set(snapshot.diagnostics.flatMap((diagnostic) => (
    diagnostic.issueNumbers
  )));
  const orphanBranchClaims: OrphanBranchClaim[] = snapshot.branches
    .filter((branch) => (
      branch.claim.phase === 'implement'
      && !prBranches.has(branch.headRefName)
      && !ambiguousIssues.has(branch.issueNumber)
    ))
    .map((branch) => {
      const projectIssue = snapshot.project.items.find((item) => (
        item.contentType === 'Issue' && item.number === branch.issueNumber
      ));
      const lifecycleIssue = snapshot.lifecycle.items.find((item) => (
        item.kind === 'issue' && item.issueNumber === branch.issueNumber
      ));
      const humanHold = projectIssue?.blockedOn === 'Human'
        || projectIssue?.status === 'Human'
        || lifecycleIssue?.humanHold === true
        || lifecycleIssue?.labels.includes('review:needs-human') === true;
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
                : projectIssue?.status === 'Human'
                  ? 'Project status: Human'
                  : 'Issue label: review:needs-human',
            }
          : undefined;
      return {
        issueNumber: branch.issueNumber,
        head: branch.headOid,
        headRefName: branch.headRefName,
        headChangedAt: branch.headCommittedAt,
        baseRefName: branch.claim.targetBase,
        claimAttempt: branch.claim.attempt,
        claimRunner: branch.claim.runner,
        projectStatus: projectIssue?.status ?? null,
        ...(humanHold ? { humanHold: true } : {}),
        ...(humanReason === undefined ? {} : { humanReason }),
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
  now: Date,
): LifecycleOrphanBranchClaimStatus[] {
  return claims.map((claim): LifecycleOrphanBranchClaimStatus => {
    const headAt = Date.parse(claim.headChangedAt);
    const progressAgeMs = Math.max(0, now.getTime() - headAt);
    const human = claim.humanHold === true
      || claim.humanReason !== undefined
      || claim.projectStatus === 'Human';
    return {
      kind: 'orphan-branch-claim',
      phase: human ? 'human' : 'implementing',
      issueNumber: claim.issueNumber,
      head: claim.head,
      headRefName: claim.headRefName,
      claimGeneration: claim.claimAttempt,
      claimAttempt: claim.claimAttempt,
      claimRunner: claim.claimRunner,
      progressAgeMs,
      stale: false,
      v2Marked: true,
      humanHold: human,
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
    mode: 'recover',
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

export async function runLifecycleCycle(
  mode: AutopilotMode,
  deps: LifecycleControllerDeps,
): Promise<LifecycleCycleReport> {
  if (mode === 'active') {
    return {
      status: 'rejected',
      mode,
      message: 'active writer not wired yet',
      items: [],
      orphanBranchClaims: [],
      diagnostics: [],
      events: [],
    };
  }
  if (mode === 'recover' && deps.writer === undefined) {
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
  const now = deps.now();
  const view = deriveLifecycle(snapshot.lifecycle, now, deps.staleAfterMs);
  const context = projectionContext(snapshot, view);
  const plan = planProjection(context);
  const cycleId = deps.cycleId();
  const items = statusItems(view, plan.actions, now, context.orphanBranchClaims);
  const orphanBranchClaims = orphanStatusItems(
    context.orphanBranchClaims,
    plan.actions,
    now,
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
    return {
      status: 'ok',
      mode,
      cycleId,
      runnerId: deps.runnerId,
      capturedAt: snapshot.capturedAt,
      items,
      orphanBranchClaims,
      diagnostics,
      events: [],
    };
  }
  const reconciliation = await executeProjectionPlan(plan, deps.writer!);
  return {
    status: 'ok',
    mode,
    cycleId,
    runnerId: deps.runnerId,
    capturedAt: snapshot.capturedAt,
    items,
    orphanBranchClaims,
    diagnostics,
    events: reconciliation.results.map((result) => (
      eventFor(result, items, orphanBranchClaims, diagnostics, cycleId, deps.runnerId)
    )),
    reconciliation,
  };
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
  if (item.phase === 'review-fixing') return `${identity} is awaiting review fixes and re-review.`;
  if (item.phase === 'merge-prep') return `${identity} is awaiting mechanical merge preparation.`;
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
  ) {
    return 'No lifecycle items.';
  }
  return [
    ...report.items.map(explanation),
    ...report.orphanBranchClaims.map(orphanExplanation),
    ...report.diagnostics.map((diagnostic) => `Human diagnostic: ${diagnostic.detail}.`),
  ].join('\n');
}

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
import type { GitHubLifecycleSnapshot } from './snapshot.js';
import type {
  AutopilotMode,
  GitOid,
  HumanReason,
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
  readSnapshot(): Promise<GitHubLifecycleSnapshot>;
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
      readonly events: readonly [];
    }
  | {
      readonly status: 'rate-limited';
      readonly mode: 'observe' | 'recover';
      readonly message: string;
      readonly items: readonly [];
      readonly events: readonly [];
    }
  | {
      readonly status: 'ok';
      readonly mode: 'observe' | 'recover';
      readonly cycleId: string;
      readonly runnerId: string;
      readonly capturedAt: string;
      readonly items: readonly LifecycleStatusItem[];
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
  if (positional.length > 0 && positional[0] !== 'status' && positional[0] !== 'sessions') {
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
  const orphanBranchClaims: OrphanBranchClaim[] = snapshot.branches
    .filter((branch) => (
      branch.claim.phase === 'implement'
      && !prBranches.has(branch.headRefName)
    ))
    .map((branch) => ({
      issueNumber: branch.issueNumber,
      head: branch.headOid,
      headRefName: branch.headRefName,
      baseRefName: branch.claim.targetBase,
      projectStatus: snapshot.project.items.find((item) => (
        item.contentType === 'Issue' && item.number === branch.issueNumber
      ))?.status ?? null,
    }));
  return {
    view,
    pullRequests: snapshot.pullRequests.map((pr) => ({
      number: pr.number,
      ...(pr.reviewClaim === undefined ? {} : { reviewRefOid: pr.reviewClaim.oid }),
    })),
    orphanBranchClaims,
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
  const changedAt = Date.parse(view.item.headChangedAt);
  return Number.isFinite(changedAt) ? Math.max(0, now.getTime() - changedAt) : undefined;
}

function statusItems(
  view: ReturnType<typeof deriveLifecycle>,
  actions: readonly ProjectionAction[],
  now: Date,
): LifecycleStatusItem[] {
  return view.items.map((entry): LifecycleStatusItem => {
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
      desiredActions: actions.filter((action) => actionMatchesView(action, entry)),
    };
  });
}

function eventFor(
  result: ReconciliationReport['results'][number],
  items: readonly LifecycleStatusItem[],
  cycleId: string,
  runnerId: string,
): LifecycleLogEvent {
  const action = result.action;
  const item = items.find((candidate) => (
    ('prNumber' in action && candidate.prNumber === action.prNumber)
    || ('issueNumber' in action && candidate.issueNumber === action.issueNumber)
  ));
  const issue = 'issueNumber' in action ? action.issueNumber : item?.issueNumber;
  const pr = 'prNumber' in action ? action.prNumber : item?.prNumber;
  return {
    cycleId,
    runnerId,
    mode: 'recover',
    phase: item?.phase ?? 'eligible',
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
      events: [],
    };
  }
  if (mode === 'recover' && deps.writer === undefined) {
    return {
      status: 'rejected',
      mode,
      message: 'recover writer not configured',
      items: [],
      events: [],
    };
  }
  const snapshot = await deps.readSnapshot();
  if (snapshot.project.rateLimit.remaining < (deps.rateLimitFloor ?? DEFAULT_FLOOR)) {
    return {
      status: 'rate-limited',
      mode,
      message: `GitHub rate-limit budget low: ${snapshot.project.rateLimit.remaining} remaining`,
      items: [],
      events: [],
    };
  }
  const now = deps.now();
  const view = deriveLifecycle(snapshot.lifecycle, now, deps.staleAfterMs);
  const plan = planProjection(projectionContext(snapshot, view));
  const cycleId = deps.cycleId();
  const items = statusItems(view, plan.actions, now);
  if (mode === 'observe') {
    return {
      status: 'ok',
      mode,
      cycleId,
      runnerId: deps.runnerId,
      capturedAt: snapshot.capturedAt,
      items,
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
    events: reconciliation.results.map((result) => (
      eventFor(result, items, cycleId, deps.runnerId)
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
  if (item.phase === 'eligible') return `${identity} is eligible for an ordinary claim.`;
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

export function explainIssue(report: LifecycleCycleReport, issueNumber: number): string {
  if (report.status !== 'ok') return report.message;
  const items = report.items.filter((item) => item.issueNumber === issueNumber);
  return items.length === 0
    ? `Issue #${issueNumber} is not present in the complete lifecycle snapshot.`
    : items.map(explanation).join('\n');
}

export function explainPullRequest(report: LifecycleCycleReport, prNumber: number): string {
  if (report.status !== 'ok') return report.message;
  const item = report.items.find((candidate) => candidate.prNumber === prNumber);
  return item === undefined
    ? `PR #${prNumber} is not present in the complete lifecycle snapshot.`
    : explanation(item);
}

export function renderLifecycleHuman(report: LifecycleCycleReport): string {
  if (report.status !== 'ok') return report.message;
  if (report.items.length === 0) return 'No lifecycle items.';
  return report.items.map(explanation).join('\n');
}

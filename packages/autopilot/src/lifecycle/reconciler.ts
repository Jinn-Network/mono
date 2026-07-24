import { DEFAULT_CONFIG } from '../dispatcher/types.js';
import type { ProjectionAction, ProjectionPlan } from './projection.js';
import { LifecycleRateLimitError } from './snapshot.js';
import type { GitOid } from './types.js';

export interface ReconciliationPullRequestState {
  readonly head: GitOid;
  readonly draft: boolean;
  readonly labels: readonly string[];
}

export interface ReconciliationReviewRefState {
  readonly oid: GitOid;
  readonly head: GitOid;
  readonly state:
    | 'active'
    | 'verdict-intent'
    | 'terminal-approved'
    | 'human'
    | 'stale';
}

export type ReconciliationDraftPullRequestAuthority =
  | { readonly kind: 'missing' }
  | {
      readonly kind: 'linked';
      readonly number: number;
      readonly head: GitOid;
      readonly draft: boolean;
      readonly labels: readonly string[];
    };

export interface ReconciliationWriter {
  /** Starts a one-action authority cache. Direct callers may omit it. */
  actionScope?(): ReconciliationWriter;
  readIssueHead(issueNumber: number): Promise<GitOid | null>;
  readBranchHead(headRefName: string): Promise<GitOid | null>;
  readPullRequest(prNumber: number): Promise<ReconciliationPullRequestState | null>;
  setPullRequestDraft(
    prNumber: number,
    draft: boolean,
    expectedHead?: GitOid,
  ): Promise<void>;
  setPullRequestLabel(
    prNumber: number,
    label: string,
    present: boolean,
    expectedHead?: GitOid,
  ): Promise<void>;
  hasHumanComment(prNumber: number, marker: string): Promise<boolean>;
  ensureHumanComment(
    prNumber: number,
    marker: string,
    body: string,
    expectedHead?: GitOid,
  ): Promise<void>;
  ensureImplementationSummary(
    prNumber: number,
    expectedHead: GitOid,
    summary: string,
  ): Promise<void>;
  readDraftPullRequestAuthority(input: {
    readonly issueNumber: number;
    readonly expectedHead: GitOid;
    readonly headRefName: string;
    readonly baseRefName: string;
  }): Promise<ReconciliationDraftPullRequestAuthority>;
  ensureDraftPullRequest(input: {
    readonly issueNumber: number;
    readonly expectedHead: GitOid;
    readonly headRefName: string;
    readonly baseRefName: string;
  }): Promise<void>;
  readReviewRef(prNumber: number): Promise<ReconciliationReviewRefState | null>;
  markReviewStale(prNumber: number, expectedReviewRefOid: GitOid): Promise<void>;
  completeVerdictIntent(
    prNumber: number,
    expectedReviewRefOid: GitOid,
    state: 'terminal-approved',
  ): Promise<void>;
}

export type ReconciliationOutcome =
  | 'applied'
  | 'already-applied'
  | 'changed-head'
  | 'lost-race'
  | 'awaiting-prerequisite'
  | 'failed'
  | 'eligible'
  // The GitHub rate-limit budget was exhausted mid-plan (see
  // `LifecycleRateLimitError`); this action was never attempted so it never
  // spent any more of the budget. Distinct from `awaiting-prerequisite`,
  // which is a plan-internal ordering wait, not a budget floor.
  | 'budget-deferred';

export interface ReconciliationResult {
  readonly action: ProjectionAction;
  readonly outcome: ReconciliationOutcome;
  readonly detail?: string;
}

export interface ReconciliationReport {
  readonly results: readonly ReconciliationResult[];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


async function prHeadMatches(
  writer: ReconciliationWriter,
  prNumber: number,
  expectedHead: GitOid,
): Promise<boolean> {
  return (await writer.readPullRequest(prNumber))?.head === expectedHead;
}


async function setDraft(
  action: Extract<ProjectionAction, { kind: 'set-pr-draft' }>,
  writer: ReconciliationWriter,
): Promise<ReconciliationResult> {
  const before = await writer.readPullRequest(action.prNumber);
  if (before?.head !== action.expectedHead) return { action, outcome: 'changed-head' };
  if (before.draft === action.draft) return { action, outcome: 'already-applied' };
  try {
    await writer.setPullRequestDraft(
      action.prNumber,
      action.draft,
      action.expectedHead,
    );
    return { action, outcome: 'applied' };
  } catch (error) {
    try {
      const after = await writer.readPullRequest(action.prNumber);
      if (after?.head === action.expectedHead && after.draft === action.draft) {
        return { action, outcome: 'already-applied' };
      }
    } catch {
      // Preserve original error.
    }
    return { action, outcome: 'failed', detail: message(error) };
  }
}

async function setLabel(
  action: Extract<ProjectionAction, { kind: 'set-pr-label' }>,
  writer: ReconciliationWriter,
): Promise<ReconciliationResult> {
  const before = await writer.readPullRequest(action.prNumber);
  if (before?.head !== action.expectedHead) return { action, outcome: 'changed-head' };
  if (before.labels.includes(action.label) === action.present) {
    return { action, outcome: 'already-applied' };
  }
  try {
    await writer.setPullRequestLabel(
      action.prNumber,
      action.label,
      action.present,
      action.expectedHead,
    );
    return { action, outcome: 'applied' };
  } catch (error) {
    try {
      const after = await writer.readPullRequest(action.prNumber);
      if (
        after?.head === action.expectedHead
        && after.labels.includes(action.label) === action.present
      ) {
        return { action, outcome: 'already-applied' };
      }
    } catch {
      // Preserve original error.
    }
    return { action, outcome: 'failed', detail: message(error) };
  }
}

async function ensureComment(
  action: Extract<ProjectionAction, { kind: 'ensure-human-comment' }>,
  writer: ReconciliationWriter,
): Promise<ReconciliationResult> {
  if (!await prHeadMatches(writer, action.prNumber, action.expectedHead)) {
    return { action, outcome: 'changed-head' };
  }
  if (await writer.hasHumanComment(action.prNumber, action.marker)) {
    return { action, outcome: 'already-applied' };
  }
  if (!await prHeadMatches(writer, action.prNumber, action.expectedHead)) {
    return { action, outcome: 'changed-head' };
  }
  try {
    await writer.ensureHumanComment(
      action.prNumber,
      action.marker,
      action.body,
      action.expectedHead,
    );
    return { action, outcome: 'applied' };
  } catch (error) {
    try {
      if (await writer.hasHumanComment(action.prNumber, action.marker)) {
        return { action, outcome: 'already-applied' };
      }
    } catch {
      // Preserve original error.
    }
    return { action, outcome: 'failed', detail: message(error) };
  }
}

async function ensureImplementationSummary(
  action: Extract<ProjectionAction, { kind: 'ensure-implementation-summary' }>,
  writer: ReconciliationWriter,
): Promise<ReconciliationResult> {
  if (!await prHeadMatches(writer, action.prNumber, action.expectedHead)) {
    return { action, outcome: 'changed-head' };
  }
  try {
    await writer.ensureImplementationSummary(
      action.prNumber,
      action.expectedHead,
      action.summary,
    );
    if (!await prHeadMatches(writer, action.prNumber, action.expectedHead)) {
      return { action, outcome: 'changed-head' };
    }
    return { action, outcome: 'applied' };
  } catch (error) {
    return { action, outcome: 'failed', detail: message(error) };
  }
}

async function ensureDraftPr(
  action: Extract<ProjectionAction, { kind: 'ensure-draft-pr' }>,
  writer: ReconciliationWriter,
): Promise<ReconciliationResult> {
  if (await writer.readBranchHead(action.headRefName) !== action.expectedHead) {
    return { action, outcome: 'changed-head' };
  }
  const before = await writer.readDraftPullRequestAuthority(action);
  if (before.kind === 'linked') {
    if (before.head !== action.expectedHead) return { action, outcome: 'changed-head' };
    let applied = false;
    if (!before.draft) {
      const result = await setDraft({
        kind: 'set-pr-draft',
        prNumber: before.number,
        expectedHead: action.expectedHead,
        draft: true,
      }, writer);
      if (result.outcome !== 'applied' && result.outcome !== 'already-applied') {
        return {
          action,
          outcome: result.outcome,
          ...(result.detail === undefined ? {} : { detail: result.detail }),
        };
      }
      applied ||= result.outcome === 'applied';
    }
    const current = await writer.readPullRequest(before.number);
    if (current?.head !== action.expectedHead) return { action, outcome: 'changed-head' };
    if (!current.labels.includes(DEFAULT_CONFIG.engineReviewLabel)) {
      const result = await setLabel({
        kind: 'set-pr-label',
        prNumber: before.number,
        expectedHead: action.expectedHead,
        label: DEFAULT_CONFIG.engineReviewLabel,
        present: true,
      }, writer);
      if (result.outcome !== 'applied' && result.outcome !== 'already-applied') {
        return {
          action,
          outcome: result.outcome,
          ...(result.detail === undefined ? {} : { detail: result.detail }),
        };
      }
      applied ||= result.outcome === 'applied';
    }
    const confirmed = await writer.readDraftPullRequestAuthority(action);
    if (
      confirmed.kind !== 'linked'
      || confirmed.head !== action.expectedHead
      || !confirmed.draft
      || !confirmed.labels.includes(DEFAULT_CONFIG.engineReviewLabel)
    ) {
      return { action, outcome: 'lost-race' };
    }
    return { action, outcome: applied ? 'applied' : 'already-applied' };
  }
  if (await writer.readBranchHead(action.headRefName) !== action.expectedHead) {
    return { action, outcome: 'changed-head' };
  }
  try {
    await writer.ensureDraftPullRequest(action);
    return { action, outcome: 'applied' };
  } catch (error) {
    try {
      const after = await writer.readDraftPullRequestAuthority(action);
      if (
        after.kind === 'linked'
        && after.head === action.expectedHead
        && after.draft
        && after.labels.includes(DEFAULT_CONFIG.engineReviewLabel)
      ) {
        return { action, outcome: 'already-applied' };
      }
    } catch {
      // Preserve original error.
    }
    return { action, outcome: 'failed', detail: message(error) };
  }
}

async function updateReviewRef(
  action: Extract<
  ProjectionAction,
  { kind: 'mark-review-stale' | 'complete-verdict-intent' }
  >,
  writer: ReconciliationWriter,
): Promise<ReconciliationResult> {
  if (!await prHeadMatches(writer, action.prNumber, action.expectedHead)) {
    return { action, outcome: 'changed-head' };
  }
  const desired = action.kind === 'mark-review-stale' ? 'stale' : action.state;
  const before = await writer.readReviewRef(action.prNumber);
  if (before?.head !== action.expectedHead) return { action, outcome: 'changed-head' };
  if (before.state === desired) return { action, outcome: 'already-applied' };
  if (before.oid !== action.expectedReviewRefOid) return { action, outcome: 'lost-race' };
  try {
    if (action.kind === 'mark-review-stale') {
      await writer.markReviewStale(action.prNumber, action.expectedReviewRefOid);
    } else {
      await writer.completeVerdictIntent(
        action.prNumber,
        action.expectedReviewRefOid,
        action.state,
      );
    }
    return { action, outcome: 'applied' };
  } catch (error) {
    try {
      const after = await writer.readReviewRef(action.prNumber);
      if (after?.head === action.expectedHead && after.state === desired) {
        return { action, outcome: 'already-applied' };
      }
      if (after?.oid !== action.expectedReviewRefOid) {
        return { action, outcome: 'lost-race' };
      }
    } catch {
      // Preserve original error.
    }
    return { action, outcome: 'failed', detail: message(error) };
  }
}

async function executeOne(
  action: ProjectionAction,
  writer: ReconciliationWriter,
): Promise<ReconciliationResult> {
  switch (action.kind) {
    case 'set-pr-draft':
      return setDraft(action, writer);
    case 'set-pr-label':
      return setLabel(action, writer);
    case 'ensure-human-comment':
      return ensureComment(action, writer);
    case 'ensure-implementation-summary':
      return ensureImplementationSummary(action, writer);
    case 'ensure-draft-pr':
      return ensureDraftPr(action, writer);
    case 'mark-review-stale':
    case 'complete-verdict-intent':
      return updateReviewRef(action, writer);
  }
}

export async function executeProjectionPlan(
  plan: ProjectionPlan,
  writer: ReconciliationWriter,
): Promise<ReconciliationReport> {
  const results: ReconciliationResult[] = [];
  let previousSucceeded = true;
  let implementationCompletionSucceeded: boolean | undefined;
  for (let index = 0; index < plan.actions.length; index += 1) {
    const action = plan.actions[index]!;
    if (
      'requiresPreviousSuccess' in action
      && action.requiresPreviousSuccess === true
      && !(implementationCompletionSucceeded ?? previousSucceeded)
    ) {
      results.push({ action, outcome: 'awaiting-prerequisite' });
      implementationCompletionSucceeded = false;
      continue;
    }
    try {
      const actionWriter = writer.actionScope?.() ?? writer;
      const result = await executeOne(action, actionWriter);
      results.push(result);
      previousSucceeded = result.outcome === 'applied'
        || result.outcome === 'already-applied';
      if (
        action.kind === 'ensure-implementation-summary'
        || (
          'requiresPreviousSuccess' in action
          && action.requiresPreviousSuccess === true
        )
      ) {
        implementationCompletionSucceeded = previousSucceeded;
      }
    } catch (error) {
      results.push({ action, outcome: 'failed', detail: message(error) });
      if (error instanceof LifecycleRateLimitError) {
        // The budget floor is hit; every remaining action would immediately
        // fail the same way after spending more of it on a doomed read. Stop
        // spending and mark the rest deferred rather than failed-and-retried.
        for (let rest = index + 1; rest < plan.actions.length; rest += 1) {
          results.push({ action: plan.actions[rest]!, outcome: 'budget-deferred' });
        }
        return { results };
      }
      previousSucceeded = false;
      if (
        action.kind === 'ensure-implementation-summary'
        || (
          'requiresPreviousSuccess' in action
          && action.requiresPreviousSuccess === true
        )
      ) {
        implementationCompletionSucceeded = false;
      }
    }
  }
  return { results };
}

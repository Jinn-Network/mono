import type { ProjectStatus } from '../dispatcher/types.js';
import type { ProjectionAction, ProjectionPlan } from './projection.js';
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
    | 'fixing'
    | 'terminal-approved'
    | 'human'
    | 'stale';
}

export interface ReconciliationWriter {
  readIssueHead(issueNumber: number): Promise<GitOid | null>;
  readBranchHead(headRefName: string): Promise<GitOid | null>;
  readProjectStatus(issueNumber: number): Promise<ProjectStatus | null>;
  setProjectStatus(issueNumber: number, status: ProjectStatus): Promise<void>;
  readPullRequest(prNumber: number): Promise<ReconciliationPullRequestState | null>;
  setPullRequestDraft(prNumber: number, draft: boolean): Promise<void>;
  setPullRequestLabel(prNumber: number, label: string, present: boolean): Promise<void>;
  hasHumanComment(prNumber: number, marker: string): Promise<boolean>;
  ensureHumanComment(prNumber: number, marker: string, body: string): Promise<void>;
  findOpenPullRequest(headRefName: string): Promise<{
    readonly head: GitOid;
    readonly draft: boolean;
  } | null>;
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
    state: 'fixing' | 'terminal-approved',
  ): Promise<void>;
}

export type ReconciliationOutcome =
  | 'applied'
  | 'already-applied'
  | 'changed-head'
  | 'lost-race'
  | 'awaiting-prerequisite'
  | 'failed'
  | 'eligible';

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

async function issueHeadMatches(
  writer: ReconciliationWriter,
  issueNumber: number,
  expectedHead: GitOid,
): Promise<boolean> {
  return await writer.readIssueHead(issueNumber) === expectedHead;
}

async function prHeadMatches(
  writer: ReconciliationWriter,
  prNumber: number,
  expectedHead: GitOid,
): Promise<boolean> {
  return (await writer.readPullRequest(prNumber))?.head === expectedHead;
}

async function setProjectStatus(
  action: Extract<ProjectionAction, { kind: 'set-project-status' | 'requeue-implementation' }>,
  writer: ReconciliationWriter,
): Promise<ReconciliationResult> {
  if (
    action.expectedHead !== undefined
    && !await issueHeadMatches(writer, action.issueNumber, action.expectedHead)
  ) {
    return { action, outcome: 'changed-head' };
  }
  const desired = action.kind === 'requeue-implementation' ? 'Todo' : action.status;
  if (await writer.readProjectStatus(action.issueNumber) === desired) {
    return { action, outcome: 'already-applied' };
  }
  if (
    action.expectedHead !== undefined
    && !await issueHeadMatches(writer, action.issueNumber, action.expectedHead)
  ) {
    return { action, outcome: 'changed-head' };
  }
  try {
    await writer.setProjectStatus(action.issueNumber, desired);
    return { action, outcome: 'applied' };
  } catch (error) {
    try {
      if (await writer.readProjectStatus(action.issueNumber) === desired) {
        return { action, outcome: 'already-applied' };
      }
    } catch {
      // Preserve the original mutation error in the report.
    }
    return { action, outcome: 'failed', detail: message(error) };
  }
}

async function setDraft(
  action: Extract<ProjectionAction, { kind: 'set-pr-draft' }>,
  writer: ReconciliationWriter,
): Promise<ReconciliationResult> {
  const before = await writer.readPullRequest(action.prNumber);
  if (before?.head !== action.expectedHead) return { action, outcome: 'changed-head' };
  if (before.draft === action.draft) return { action, outcome: 'already-applied' };
  if (action.requiresReviewState !== undefined) {
    const review = await writer.readReviewRef(action.prNumber);
    if (
      review?.head !== action.expectedHead
      || review.state !== action.requiresReviewState
    ) {
      return { action, outcome: 'awaiting-prerequisite' };
    }
    if (!await prHeadMatches(writer, action.prNumber, action.expectedHead)) {
      return { action, outcome: 'changed-head' };
    }
  }
  try {
    await writer.setPullRequestDraft(action.prNumber, action.draft);
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
    await writer.setPullRequestLabel(action.prNumber, action.label, action.present);
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
    await writer.ensureHumanComment(action.prNumber, action.marker, action.body);
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

async function ensureDraftPr(
  action: Extract<ProjectionAction, { kind: 'ensure-draft-pr' }>,
  writer: ReconciliationWriter,
): Promise<ReconciliationResult> {
  if (await writer.readBranchHead(action.headRefName) !== action.expectedHead) {
    return { action, outcome: 'changed-head' };
  }
  const before = await writer.findOpenPullRequest(action.headRefName);
  if (before !== null) {
    return before.head === action.expectedHead
      ? { action, outcome: 'already-applied' }
      : { action, outcome: 'changed-head' };
  }
  if (await writer.readBranchHead(action.headRefName) !== action.expectedHead) {
    return { action, outcome: 'changed-head' };
  }
  try {
    await writer.ensureDraftPullRequest(action);
    return { action, outcome: 'applied' };
  } catch (error) {
    try {
      const after = await writer.findOpenPullRequest(action.headRefName);
      if (after?.head === action.expectedHead) {
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
    case 'set-project-status':
    case 'requeue-implementation':
      return setProjectStatus(action, writer);
    case 'set-pr-draft':
      return setDraft(action, writer);
    case 'set-pr-label':
      return setLabel(action, writer);
    case 'ensure-human-comment':
      return ensureComment(action, writer);
    case 'ensure-draft-pr':
      return ensureDraftPr(action, writer);
    case 'mark-review-stale':
    case 'complete-verdict-intent':
      return updateReviewRef(action, writer);
    case 'expose-merge-prep':
      return { action, outcome: 'eligible' };
  }
}

export async function executeProjectionPlan(
  plan: ProjectionPlan,
  writer: ReconciliationWriter,
): Promise<ReconciliationReport> {
  const results: ReconciliationResult[] = [];
  for (const action of plan.actions) {
    try {
      results.push(await executeOne(action, writer));
    } catch (error) {
      results.push({ action, outcome: 'failed', detail: message(error) });
    }
  }
  return { results };
}

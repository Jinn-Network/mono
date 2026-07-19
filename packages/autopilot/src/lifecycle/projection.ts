import type { ProjectStatus } from '../dispatcher/types.js';
import { DEFAULT_CONFIG } from '../dispatcher/types.js';
import { NEEDS_HUMAN_LABEL } from '../dispatcher/merge-sweep.js';
import type {
  GitOid,
  LifecyclePhase,
  LifecycleView,
  LifecycleViewItem,
} from './types.js';

export interface ProjectionPullRequest {
  readonly number: number;
  readonly reviewRefOid?: GitOid;
}

export interface OrphanBranchClaim {
  readonly issueNumber: number;
  readonly head: GitOid;
  readonly headRefName: string;
  readonly baseRefName: string;
  readonly projectStatus: ProjectStatus | null;
}

export interface ProjectionContext {
  readonly view: LifecycleView;
  readonly pullRequests: readonly ProjectionPullRequest[];
  readonly orphanBranchClaims: readonly OrphanBranchClaim[];
}

interface HeadPinned {
  readonly expectedHead: GitOid;
}

export type ProjectionAction =
  | ({
      readonly kind: 'set-project-status';
      readonly issueNumber: number;
      readonly status: ProjectStatus;
    } & Partial<HeadPinned>)
  | ({
      readonly kind: 'set-pr-draft';
      readonly prNumber: number;
      readonly draft: boolean;
      readonly requiresReviewState?: 'fixing' | 'terminal-approved';
    } & HeadPinned)
  | ({
      readonly kind: 'set-pr-label';
      readonly prNumber: number;
      readonly label: string;
      readonly present: boolean;
    } & HeadPinned)
  | ({
      readonly kind: 'ensure-human-comment';
      readonly issueNumber: number;
      readonly prNumber: number;
      readonly marker: string;
      readonly body: string;
    } & HeadPinned)
  | ({
      readonly kind: 'requeue-implementation';
      readonly issueNumber: number;
    } & HeadPinned)
  | ({
      readonly kind: 'mark-review-stale';
      readonly prNumber: number;
      readonly expectedReviewRefOid: GitOid;
    } & HeadPinned)
  | ({
      readonly kind: 'complete-verdict-intent';
      readonly prNumber: number;
      readonly expectedReviewRefOid: GitOid;
      readonly state: 'fixing' | 'terminal-approved';
    } & HeadPinned)
  | ({
      readonly kind: 'expose-merge-prep';
      readonly prNumber: number;
    } & HeadPinned)
  | ({
      readonly kind: 'ensure-draft-pr';
      readonly issueNumber: number;
      readonly headRefName: string;
      readonly baseRefName: string;
    } & HeadPinned);

export interface ProjectionPlan {
  readonly actions: readonly ProjectionAction[];
}

function desiredStatus(item: LifecycleViewItem): ProjectStatus {
  if (item.phase === 'human') return 'Human';
  if (item.stale && item.phase === 'implementing') return 'Todo';
  switch (item.phase) {
    case 'eligible': return 'Todo';
    case 'implementing': return 'In Progress';
    case 'merged': return 'Done';
    case 'awaiting-review':
    case 'reviewing':
    case 'review-fixing':
    case 'merge-prep':
    case 'merge-ready':
      return 'In Review';
  }
}

function activeMutation(view: LifecycleViewItem): boolean {
  if (view.phase === 'human') return true;
  if (view.phase === 'implementing' || view.phase === 'review-fixing' || view.phase === 'merge-prep') {
    return true;
  }
  const item = view.item;
  return item.kind === 'pull-request'
    && item.reviewClaim?.state === 'verdict-intent'
    && item.reviewClaim.verdict.state === 'REQUEST_CHANGES';
}

function humanMarker(view: LifecycleViewItem): { marker: string; body: string } | null {
  if (
    view.phase !== 'human'
    || view.humanReason === undefined
    || view.item.kind !== 'pull-request'
  ) {
    return null;
  }
  const reason = view.humanReason;
  const marker = `<!-- jinn-autopilot-human:v2 issue=${view.item.issueNumber} `
    + `pr=${view.item.prNumber} phase=${reason.phase} code=${reason.code} -->`;
  return {
    marker,
    body: `${marker}\n\nAutopilot parked this item for Human review.\n\n${reason.detail}`,
  };
}

function planItem(
  view: LifecycleViewItem,
  reviewRefByPr: ReadonlyMap<number, GitOid>,
  labels: { readonly review: string; readonly human: string },
): ProjectionAction[] {
  const item = view.item;
  if (!item.v2Marked && view.phase !== 'human') return [];
  const desired = desiredStatus(view);
  const actions: ProjectionAction[] = [];
  if (item.projectStatus !== desired && !(view.stale && view.phase === 'implementing')) {
    actions.push({
      kind: 'set-project-status',
      issueNumber: item.issueNumber,
      ...(item.kind === 'pull-request' ? { expectedHead: item.head } : {}),
      status: desired,
    });
  }
  if (item.kind !== 'pull-request') return actions;

  let completedReviewState: 'fixing' | 'terminal-approved' | undefined;
  if (
    item.v2Marked
    && item.reviewClaim?.state === 'verdict-intent'
    && item.terminalVerdict !== undefined
    && item.terminalVerdict.head === item.head
    && item.terminalVerdict.marker === item.reviewClaim.verdict.marker
    && item.terminalVerdict.state === item.reviewClaim.verdict.state
  ) {
    const refOid = reviewRefByPr.get(item.prNumber);
    if (refOid !== undefined) {
      completedReviewState = item.reviewClaim.verdict.state === 'APPROVE'
        ? 'terminal-approved'
        : 'fixing';
      actions.push({
        kind: 'complete-verdict-intent',
        prNumber: item.prNumber,
        expectedHead: item.head,
        expectedReviewRefOid: refOid,
        state: completedReviewState,
      });
    }
  }

  if (item.v2Marked) {
    const draft = activeMutation(view);
    if (item.isDraft !== draft) {
      actions.push({
        kind: 'set-pr-draft',
        prNumber: item.prNumber,
        expectedHead: item.head,
        draft,
        ...(completedReviewState === undefined
          ? {}
          : { requiresReviewState: completedReviewState }),
      });
    }
    const wantsReviewLabel = view.phase !== 'human'
      && !['implementing', 'merged'].includes(view.phase);
    if (item.labels.includes(labels.review) !== wantsReviewLabel) {
      actions.push({
        kind: 'set-pr-label',
        prNumber: item.prNumber,
        expectedHead: item.head,
        label: labels.review,
        present: wantsReviewLabel,
      });
    }
  }

  const wantsHumanLabel = view.phase === 'human';
  if (item.labels.includes(labels.human) !== wantsHumanLabel) {
    actions.push({
      kind: 'set-pr-label',
      prNumber: item.prNumber,
      expectedHead: item.head,
      label: labels.human,
      present: wantsHumanLabel,
    });
  }
  const comment = humanMarker(view);
  if (comment !== null) {
    actions.push({
      kind: 'ensure-human-comment',
      issueNumber: item.issueNumber,
      prNumber: item.prNumber,
      expectedHead: item.head,
      ...comment,
    });
  }

  if (view.phase === 'human' || !item.v2Marked) return actions;
  if (view.stale && view.phase === 'implementing') {
    actions.push({
      kind: 'requeue-implementation',
      issueNumber: item.issueNumber,
      expectedHead: item.head,
    });
  } else if (view.stale && (view.phase === 'reviewing' || view.phase === 'review-fixing')) {
    const refOid = reviewRefByPr.get(item.prNumber);
    if (refOid !== undefined) {
      actions.push({
        kind: 'mark-review-stale',
        prNumber: item.prNumber,
        expectedHead: item.head,
        expectedReviewRefOid: refOid,
      });
    }
  } else if (view.stale && view.phase === 'merge-prep') {
    actions.push({
      kind: 'expose-merge-prep',
      prNumber: item.prNumber,
      expectedHead: item.head,
    });
  }

  return actions;
}

export function planProjection(
  context: ProjectionContext,
  options: {
    readonly reviewLabel?: string;
    readonly humanLabel?: string;
  } = {},
): ProjectionPlan {
  const labels = {
    review: options.reviewLabel ?? DEFAULT_CONFIG.engineReviewLabel,
    human: options.humanLabel ?? NEEDS_HUMAN_LABEL,
  };
  const reviewRefByPr = new Map<number, GitOid>();
  for (const pr of context.pullRequests) {
    if (pr.reviewRefOid !== undefined) reviewRefByPr.set(pr.number, pr.reviewRefOid);
  }
  const actions = context.view.items.flatMap((view) => (
    planItem(view, reviewRefByPr, labels)
  ));
  const existingPrIssues = new Set(
    context.view.items
      .filter((view) => view.item.kind === 'pull-request')
      .map((view) => view.item.issueNumber),
  );
  for (const claim of context.orphanBranchClaims) {
    if (existingPrIssues.has(claim.issueNumber)) continue;
    if (claim.projectStatus !== 'In Progress') {
      actions.push({
        kind: 'set-project-status',
        issueNumber: claim.issueNumber,
        expectedHead: claim.head,
        status: 'In Progress',
      });
    }
    actions.push({
      kind: 'ensure-draft-pr',
      issueNumber: claim.issueNumber,
      expectedHead: claim.head,
      headRefName: claim.headRefName,
      baseRefName: claim.baseRefName,
    });
  }
  return { actions };
}

export function phaseStatus(phase: LifecyclePhase): ProjectStatus {
  if (phase === 'human') return 'Human';
  if (phase === 'eligible') return 'Todo';
  if (phase === 'implementing') return 'In Progress';
  if (phase === 'merged') return 'Done';
  return 'In Review';
}

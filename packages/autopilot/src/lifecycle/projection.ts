import type { ProjectStatus } from '../dispatcher/types.js';
import { DEFAULT_CONFIG } from '../dispatcher/types.js';
import { NEEDS_HUMAN_LABEL } from '../dispatcher/merge-sweep.js';
import { formatHumanCommentMarker } from './codecs.js';
import type {
  GitOid,
  HumanReason,
  LifecycleMappingDiagnostic,
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
  readonly headChangedAt: string;
  readonly baseRefName: string;
  readonly claimAttempt: string;
  readonly claimRunner: string;
  readonly projectStatus: ProjectStatus | null;
  readonly phase: 'implementing' | 'awaiting-review' | 'human';
  readonly underlyingPhase?: 'implementing' | 'awaiting-review';
  readonly progressAgeMs?: number;
  readonly stale: boolean;
  readonly staleSince?: string;
  readonly staleReason?: 'branch-head-unchanged';
  readonly humanHold?: boolean;
  readonly humanReason?: HumanReason;
}

export interface ProjectionContext {
  readonly view: LifecycleView;
  readonly pullRequests: readonly ProjectionPullRequest[];
  readonly orphanBranchClaims: readonly OrphanBranchClaim[];
  readonly mappingDiagnostics?: readonly LifecycleMappingDiagnostic[];
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
      readonly issueNumber?: number;
      readonly prNumber: number;
      readonly marker: string;
      readonly body: string;
    } & HeadPinned)
  | ({
      readonly kind: 'ensure-implementation-summary';
      readonly prNumber: number;
      readonly summary: string;
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
  const marker = formatHumanCommentMarker({
    issueNumber: view.item.issueNumber,
    prNumber: view.item.prNumber,
    reason,
  });
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
  const implementationComplete = item.kind === 'pull-request'
    && item.branchClaim?.phase === 'implement'
    && item.branchClaim.phaseComplete === true;
  if (
    !implementationComplete
    && item.projectStatus !== desired
    && !(view.stale && view.phase === 'implementing')
  ) {
    actions.push({
      kind: 'set-project-status',
      issueNumber: item.issueNumber,
      ...(item.kind === 'pull-request' ? { expectedHead: item.head } : {}),
      status: desired,
    });
  }
  if (item.kind !== 'pull-request') return actions;

  if (implementationComplete && item.implementationSummary !== undefined) {
    actions.push({
      kind: 'ensure-implementation-summary',
      prNumber: item.prNumber,
      expectedHead: item.head,
      summary: item.implementationSummary,
    });
  }

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
    if (!implementationComplete && item.isDraft !== draft) {
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
    const wantsReviewLabel = true;
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

  if (implementationComplete) {
    if (item.projectStatus !== desired) {
      actions.push({
        kind: 'set-project-status',
        issueNumber: item.issueNumber,
        expectedHead: item.head,
        status: desired,
      });
    }
    const draft = activeMutation(view);
    if (item.isDraft !== draft) {
      actions.push({
        kind: 'set-pr-draft',
        prNumber: item.prNumber,
        expectedHead: item.head,
        draft,
      });
    }
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
    if (claim.phase === 'human') {
      const alreadyProjectsHuman = actions.some((action) => (
        action.kind === 'set-project-status'
        && action.issueNumber === claim.issueNumber
        && action.status === 'Human'
      ));
      if (claim.projectStatus !== 'Human' && !alreadyProjectsHuman) {
        actions.push({
          kind: 'set-project-status',
          issueNumber: claim.issueNumber,
          expectedHead: claim.head,
          status: 'Human',
        });
      }
      continue;
    }
    if (claim.phase === 'awaiting-review') {
      actions.push({
        kind: 'ensure-draft-pr',
        issueNumber: claim.issueNumber,
        expectedHead: claim.head,
        headRefName: claim.headRefName,
        baseRefName: claim.baseRefName,
      });
      if (claim.projectStatus !== 'In Review') {
        actions.push({
          kind: 'set-project-status',
          issueNumber: claim.issueNumber,
          expectedHead: claim.head,
          status: 'In Review',
        });
      }
      continue;
    }
    if (!claim.stale && claim.projectStatus !== 'In Progress') {
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
    if (claim.stale) {
      actions.push({
        kind: 'requeue-implementation',
        issueNumber: claim.issueNumber,
        expectedHead: claim.head,
      });
    }
  }
  for (const diagnostic of context.mappingDiagnostics ?? []) {
    const reason: HumanReason = {
      phase: 'implementing',
      code: 'branch-mapping-ambiguous',
      detail: diagnostic.detail,
    };
    for (const issue of diagnostic.issues) {
      if (issue.projectStatus === 'Human') continue;
      actions.push({
        kind: 'set-project-status',
        issueNumber: issue.number,
        status: 'Human',
      });
    }
    for (const pr of diagnostic.pullRequests) {
      if (!pr.labels.includes(labels.review)) {
        actions.push({
          kind: 'set-pr-label',
          prNumber: pr.number,
          expectedHead: pr.head,
          label: labels.review,
          present: true,
        });
      }
      if (!pr.draft) {
        actions.push({
          kind: 'set-pr-draft',
          prNumber: pr.number,
          expectedHead: pr.head,
          draft: true,
        });
      }
      if (!pr.labels.includes(labels.human)) {
        actions.push({
          kind: 'set-pr-label',
          prNumber: pr.number,
          expectedHead: pr.head,
          label: labels.human,
          present: true,
        });
      }
      const marker = formatHumanCommentMarker({ prNumber: pr.number, reason });
      actions.push({
        kind: 'ensure-human-comment',
        prNumber: pr.number,
        expectedHead: pr.head,
        marker,
        body: `${marker}\n\nAutopilot parked this item for Human review.\n\n${reason.detail}`,
      });
    }
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

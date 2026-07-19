import type {
  AutopilotMode,
  LifecycleItem,
  LifecyclePhase,
  LifecycleSnapshot,
  LifecycleView,
  LifecycleViewItem,
  LocalCapacity,
  PlannedAction,
  PullRequestLifecycleItem,
  RecoveryAction,
  ReviewClaimRecord,
} from './types.js';

function timestampMs(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function branchClaimMatchesItem(item: PullRequestLifecycleItem): boolean {
  const claim = item.branchClaim;
  return claim === undefined
    || (claim.issueNumber === item.issueNumber
      && (claim.prNumber === undefined || claim.prNumber === item.prNumber));
}

function reviewClaimMatchesItem(item: PullRequestLifecycleItem): boolean {
  return item.reviewClaim === undefined || item.reviewClaim.prNumber === item.prNumber;
}

function correlatedBranchClaim(item: PullRequestLifecycleItem) {
  return branchClaimMatchesItem(item) ? item.branchClaim : undefined;
}

function correlatedReviewClaim(item: PullRequestLifecycleItem) {
  return reviewClaimMatchesItem(item) ? item.reviewClaim : undefined;
}

function humanOverlay(item: LifecycleItem): boolean {
  return item.projectStatus === 'Human'
    || item.labels.includes('review:needs-human')
    || item.humanReason !== undefined
    || (item.kind === 'pull-request'
      && (!branchClaimMatchesItem(item)
        || !reviewClaimMatchesItem(item)
        || item.reviewClaim?.state === 'human'));
}

function underlyingPhase(item: LifecycleItem): Exclude<LifecyclePhase, 'human'> {
  if (item.kind === 'issue') return 'eligible';
  if (item.merged) return 'merged';

  const branchClaim = correlatedBranchClaim(item);
  if (branchClaim?.phase === 'implement' && branchClaim.phaseComplete !== true) {
    return 'implementing';
  }
  if (branchClaim?.phase === 'merge-prep' && branchClaim.phaseComplete !== true) {
    return 'merge-prep';
  }

  const review = correlatedReviewClaim(item);
  const currentReview = review !== undefined && review.head === item.head;
  if (currentReview && !['stale', 'terminal-approved', 'human'].includes(review.state)) {
    return item.isDraft || review.state === 'fixing' ? 'review-fixing' : 'reviewing';
  }

  if (item.approved && !item.needsReview) {
    if (item.mergeState === 'clean') return 'merge-ready';
    if (item.mergeState === 'behind' || item.mergeState === 'conflict') return 'merge-prep';
  }
  return 'awaiting-review';
}

function matchingVerdictTime(
  item: PullRequestLifecycleItem,
  review: ReviewClaimRecord,
): number | null {
  const verdict = item.terminalVerdict;
  if (
    verdict === undefined
    || review.verdict === undefined
    || verdict.head !== review.head
    || verdict.marker !== review.verdict.marker
    || verdict.state !== review.verdict.state
  ) {
    return null;
  }
  return timestampMs(verdict.recordedAt);
}

function staleEvidence(
  item: LifecycleItem,
  phase: Exclude<LifecyclePhase, 'human'>,
  nowMs: number,
  staleAfterMs: number,
): Pick<LifecycleViewItem, 'stale' | 'staleSince' | 'staleReason'> {
  if (!item.v2Marked || staleAfterMs < 0 || item.kind !== 'pull-request') {
    return { stale: false };
  }

  if (
    (phase === 'implementing' || phase === 'merge-prep')
    && correlatedBranchClaim(item) !== undefined
    && correlatedBranchClaim(item)?.phaseComplete !== true
  ) {
    const headTime = timestampMs(item.headChangedAt);
    if (headTime === null || headTime > nowMs || nowMs - headTime < staleAfterMs) {
      return { stale: false };
    }
    return {
      stale: true,
      staleSince: new Date(headTime + staleAfterMs).toISOString(),
      staleReason: 'branch-head-unchanged',
    };
  }

  const review = correlatedReviewClaim(item);
  if (
    (phase === 'reviewing' || phase === 'review-fixing')
    && review !== undefined
    && review.head === item.head
    && !['stale', 'terminal-approved', 'human'].includes(review.state)
  ) {
    const headTime = timestampMs(item.headChangedAt);
    const verdictTime = matchingVerdictTime(item, review);
    if (verdictTime !== null) return { stale: false };
    if (headTime === null) return { stale: false };
    if (headTime > nowMs || nowMs - headTime < staleAfterMs) {
      return { stale: false };
    }
    return {
      stale: true,
      staleSince: new Date(headTime + staleAfterMs).toISOString(),
      staleReason: 'review-progress-unchanged',
    };
  }

  return { stale: false };
}

function deriveItem(item: LifecycleItem, nowMs: number, staleAfterMs: number): LifecycleViewItem {
  const underlying = underlyingPhase(item);
  const supersededReview = item.kind === 'pull-request'
    && item.reviewClaim !== undefined
    && item.reviewClaim.head !== item.head;
  if (underlying === 'merged') {
    return { item, phase: 'merged', stale: false, supersededReview };
  }
  if (humanOverlay(item)) {
    return {
      item,
      phase: 'human',
      underlyingPhase: underlying,
      stale: false,
      supersededReview,
    };
  }
  return {
    item,
    phase: underlying,
    ...staleEvidence(item, underlying, nowMs, staleAfterMs),
    supersededReview,
  };
}

export function deriveLifecycle(
  snapshot: LifecycleSnapshot,
  now: Date,
  staleAfterMs: number,
): LifecycleView {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error('Invalid lifecycle derivation time');
  if (!Number.isFinite(staleAfterMs) || staleAfterMs < 0) {
    throw new Error('staleAfterMs must be a non-negative finite number');
  }
  return { items: snapshot.items.map((item) => deriveItem(item, nowMs, staleAfterMs)) };
}

function recoveryForView(view: LifecycleViewItem): readonly RecoveryAction[] {
  if (!view.stale || view.phase === 'human' || view.item.kind !== 'pull-request') return [];
  const item = view.item;
  if (view.phase === 'implementing') {
    return [{
      kind: 'requeue-implementation',
      issueNumber: item.issueNumber,
      expectedHead: item.head,
    }];
  }
  if (view.phase === 'merge-prep') {
    return [{
      kind: 'requeue-merge-prep',
      prNumber: item.prNumber,
      expectedHead: item.head,
    }];
  }
  if (
    (view.phase === 'reviewing' || view.phase === 'review-fixing')
    && item.reviewClaim !== undefined
  ) {
    return [{
      kind: 'mark-review-stale',
      prNumber: item.prNumber,
      expectedGeneration: item.reviewClaim.generation,
      expectedHead: item.head,
    }];
  }
  return [];
}

export function deriveRecovery(
  item: LifecycleItem,
  now: Date,
  staleAfterMs: number,
): readonly RecoveryAction[] {
  const view = deriveLifecycle({ items: [item] }, now, staleAfterMs).items[0];
  return view === undefined ? [] : recoveryForView(view);
}

function nonNegativeSlots(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function reviewEnrollmentEligible(item: PullRequestLifecycleItem): boolean {
  if (!item.isDraft) return item.needsReview && !item.approved;
  return item.reviewClaim?.state === 'stale' && item.reviewClaim.head === item.head;
}

export function planCycle(
  view: LifecycleView,
  localCapacity: LocalCapacity,
  mode: AutopilotMode,
): readonly PlannedAction[] {
  if (mode === 'observe') return [];

  const recovery = view.items.flatMap(recoveryForView);
  if (mode === 'recover') return recovery;

  let lanes = nonNegativeSlots(localCapacity.usableCredentialLanes);
  let implementationSlots = nonNegativeSlots(localCapacity.implementationSlots);
  let reviewSlots = nonNegativeSlots(localCapacity.reviewSlots);
  let mergePrepSlots = nonNegativeSlots(localCapacity.mergePrepSlots);
  const planned: PlannedAction[] = [...recovery];

  for (const candidate of view.items) {
    if (
      lanes === 0
      || implementationSlots === 0
      || candidate.phase !== 'eligible'
      || candidate.stale
      || candidate.item.kind !== 'issue'
      || !candidate.item.eligible
    ) {
      continue;
    }
    planned.push({ kind: 'claim-implementation', issueNumber: candidate.item.issueNumber });
    lanes -= 1;
    implementationSlots -= 1;
  }

  for (const candidate of view.items) {
    if (
      lanes === 0
      || reviewSlots === 0
      || candidate.phase !== 'awaiting-review'
      || candidate.stale
      || candidate.item.kind !== 'pull-request'
      || !reviewEnrollmentEligible(candidate.item)
    ) {
      continue;
    }
    planned.push({
      kind: 'claim-review',
      issueNumber: candidate.item.issueNumber,
      prNumber: candidate.item.prNumber,
      head: candidate.item.head,
      recoverFixes: candidate.item.isDraft,
    });
    lanes -= 1;
    reviewSlots -= 1;
  }

  for (const candidate of view.items) {
    if (
      lanes === 0
      || mergePrepSlots === 0
      || candidate.phase !== 'merge-prep'
      || candidate.stale
      || candidate.item.kind !== 'pull-request'
      || candidate.item.branchClaim !== undefined
    ) {
      continue;
    }
    planned.push({
      kind: 'claim-merge-prep',
      issueNumber: candidate.item.issueNumber,
      prNumber: candidate.item.prNumber,
      head: candidate.item.head,
    });
    lanes -= 1;
    mergePrepSlots -= 1;
  }

  for (const candidate of view.items) {
    if (candidate.phase !== 'merge-ready' || candidate.item.kind !== 'pull-request') continue;
    planned.push({
      kind: 'merge',
      issueNumber: candidate.item.issueNumber,
      prNumber: candidate.item.prNumber,
      head: candidate.item.head,
    });
  }
  return planned;
}

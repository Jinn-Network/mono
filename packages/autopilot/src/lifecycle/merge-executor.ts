import {
  selectCredential,
  type CredentialPool,
  type SelectedCredential,
} from './credentials.js';
import type {
  GitOid,
  GitRefName,
} from './types.js';
import {
  classifyCiChecks,
  isCiGreen,
} from './ci-classifier.js';

export interface MergeEffectiveReview {
  readonly reviewer: string;
  readonly state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  readonly commitId: GitOid;
}

export interface MergeCandidate {
  readonly issueNumber: number;
  readonly prNumber: number;
  readonly open: boolean;
  readonly merged: boolean;
  readonly head: GitOid;
  readonly baseRefName: GitRefName;
  readonly expectedBaseRefName: GitRefName;
  readonly draft: boolean;
  readonly labels: readonly string[];
  readonly humanHold: boolean;
  readonly author: string;
  readonly authorAllowed: boolean;
  readonly uniqueIssueMapping: boolean;
  readonly terminalApprovalMatches: boolean;
  readonly terminalApprovalReviewer?: string;
  readonly effectiveReviews: readonly MergeEffectiveReview[];
  readonly checks: readonly {
    readonly name: string;
    readonly status: string;
    readonly conclusion: string | null;
  }[];
  readonly mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  readonly mergeStateStatus: string;
  readonly compareStatus: 'ahead' | 'identical' | 'behind' | 'diverged' | 'unknown';
  readonly changedFilesComplete: boolean;
  readonly codeownersComplete: boolean;
  readonly codeownerSensitive: boolean;
}

export interface MergeGateResult {
  readonly pass: boolean;
  readonly reasons: readonly string[];
}

export function evaluateMergeGate(candidate: MergeCandidate): MergeGateResult {
  const reasons: string[] = [];
  if (!candidate.open || candidate.merged) reasons.push('pull-request-not-open');
  if (candidate.draft) reasons.push('draft');
  if (candidate.humanHold) reasons.push('human');
  if (!candidate.labels.includes('engine:review')) reasons.push('review-label');
  if (!candidate.authorAllowed) reasons.push('author');
  if (!candidate.uniqueIssueMapping) reasons.push('mapping');
  if (candidate.baseRefName !== candidate.expectedBaseRefName) reasons.push('base');
  if (!candidate.terminalApprovalMatches) reasons.push('terminal-approval');
  if (
    candidate.terminalApprovalReviewer !== undefined
    && candidate.terminalApprovalReviewer.toLowerCase() === candidate.author.toLowerCase()
  ) {
    reasons.push('self-review');
  }
  if (candidate.effectiveReviews.some((review) => (
    review.commitId === candidate.head && review.state === 'CHANGES_REQUESTED'
  ))) {
    reasons.push('changes-requested');
  }
  if (!isCiGreen(candidate.checks)) {
    const classification = classifyCiChecks(candidate.checks);
    if (classification.state === 'missing') reasons.push('checks-missing');
    else reasons.push('checks-not-green');
  }
  if (
    candidate.mergeable !== 'MERGEABLE'
    || !['CLEAN', 'UNSTABLE', 'HAS_HOOKS'].includes(candidate.mergeStateStatus)
  ) {
    reasons.push('mergeability');
  }
  if (candidate.compareStatus === 'behind' || candidate.compareStatus === 'diverged') {
    reasons.push('behind');
  } else if (candidate.compareStatus === 'unknown') {
    reasons.push('compare-unknown');
  }
  if (!candidate.changedFilesComplete) reasons.push('changed-files-incomplete');
  if (!candidate.codeownersComplete) reasons.push('codeowners-incomplete');
  if (candidate.codeownerSensitive) reasons.push('codeowner-sensitive');
  return { pass: reasons.length === 0, reasons };
}

export type ExactMergeOutcome =
  | {
      readonly status: 'merged' | 'already-merged';
      readonly head: GitOid;
      readonly mergeCommitOid: GitOid;
    }
  | {
      readonly status: 'rejected' | 'changed-head' | 'ambiguous';
      readonly head: GitOid;
      readonly reason?: string;
    };

export interface MergeExecutorDeps {
  readCandidate(prNumber: number): Promise<MergeCandidate | null>;
  readonly credentials: CredentialPool;
  mergeExactHead(input: {
    readonly prNumber: number;
    readonly head: GitOid;
    readonly credential: SelectedCredential;
  }): Promise<ExactMergeOutcome>;
  reconcileDone(input: {
    readonly issueNumber: number;
    readonly prNumber: number;
    readonly expectedHead: GitOid;
    readonly credential: SelectedCredential;
  }): Promise<void>;
  updateBranch?(input: {
    readonly prNumber: number;
    readonly expectedHead: GitOid;
    readonly credential: SelectedCredential;
  }): Promise<{ readonly status: 'updated' | 'changed-head' | 'rejected'; readonly head: GitOid }>;
  fileReconcileChild?(input: {
    readonly prNumber: number;
    readonly effort: 'low' | 'medium' | 'high';
    readonly credential: SelectedCredential;
  }): Promise<
    | { readonly number: number; readonly created: boolean; readonly runawayHold?: undefined }
    | { readonly runawayHold: true; readonly priorCount: number }
  >;
}

export type MergeExecutionResult =
  | {
      readonly status: 'merged';
      readonly prNumber: number;
      readonly head: GitOid;
      readonly mergeCommitOid: GitOid;
    }
  | {
      readonly status: 'merged-projection-pending';
      readonly prNumber: number;
      readonly head: GitOid;
      readonly mergeCommitOid: GitOid;
    }
  | {
      readonly status: 'ineligible';
      readonly prNumber: number;
      readonly head?: GitOid;
      readonly reasons: readonly string[];
    }
  | {
      readonly status: 'changed-head';
      readonly prNumber: number;
      readonly head: GitOid;
    }
  | {
      readonly status: 'rejected' | 'ambiguous';
      readonly prNumber: number;
      readonly head: GitOid;
      readonly reason?: string;
    };

export async function executeMergeAction(
  action: { readonly prNumber: number; readonly expectedHead: GitOid },
  deps: MergeExecutorDeps,
): Promise<MergeExecutionResult> {
  if (!Number.isSafeInteger(action.prNumber) || action.prNumber <= 0) {
    throw new Error('Merge action requires a positive PR number');
  }
  const initial = await deps.readCandidate(action.prNumber);
  if (initial === null) {
    return {
      status: 'ineligible',
      prNumber: action.prNumber,
      reasons: ['pull-request-missing'],
    };
  }
  if (initial.head !== action.expectedHead) {
    return { status: 'changed-head', prNumber: action.prNumber, head: initial.head };
  }
  const initialGate = evaluateMergeGate(initial);
  if (!initialGate.pass) {
    return {
      status: 'ineligible',
      prNumber: action.prNumber,
      head: initial.head,
      reasons: initialGate.reasons,
    };
  }
  const selection = selectCredential(deps.credentials, { phase: 'merge' });
  if (selection.status !== 'selected') {
    return {
      status: 'ineligible',
      prNumber: action.prNumber,
      head: initial.head,
      reasons: ['credential-unavailable'],
    };
  }
  const current = await deps.readCandidate(action.prNumber);
  if (current === null) {
    return {
      status: 'ineligible',
      prNumber: action.prNumber,
      reasons: ['pull-request-missing'],
    };
  }
  if (current.head !== action.expectedHead) {
    return { status: 'changed-head', prNumber: action.prNumber, head: current.head };
  }
  const gate = evaluateMergeGate(current);
  if (!gate.pass) {
    return {
      status: 'ineligible',
      prNumber: action.prNumber,
      head: current.head,
      reasons: gate.reasons,
    };
  }
  const outcome = await deps.mergeExactHead({
    prNumber: action.prNumber,
    head: action.expectedHead,
    credential: selection.credential,
  });
  if (outcome.status !== 'merged' && outcome.status !== 'already-merged') {
    if (outcome.status === 'changed-head') {
      return {
        status: 'changed-head',
        prNumber: action.prNumber,
        head: outcome.head,
      };
    }
    return {
      status: outcome.status,
      prNumber: action.prNumber,
      head: outcome.head,
      ...(!('reason' in outcome) || outcome.reason === undefined
        ? {}
        : { reason: outcome.reason }),
    };
  }
  try {
    await deps.reconcileDone({
      issueNumber: current.issueNumber,
      prNumber: current.prNumber,
      expectedHead: action.expectedHead,
      credential: selection.credential,
    });
  } catch {
    return {
      status: 'merged-projection-pending',
      prNumber: action.prNumber,
      head: action.expectedHead,
      mergeCommitOid: outcome.mergeCommitOid,
    };
  }
  return {
    status: 'merged',
    prNumber: action.prNumber,
    head: action.expectedHead,
    mergeCommitOid: outcome.mergeCommitOid,
  };
}

export type UpdateBranchResult =
  | { readonly status: 'updated'; readonly prNumber: number; readonly head: GitOid }
  | { readonly status: 'changed-head'; readonly prNumber: number; readonly head: GitOid }
  | { readonly status: 'ineligible' | 'rejected'; readonly prNumber: number; readonly reason: string };

export async function executeUpdateBranchAction(
  action: { readonly prNumber: number; readonly expectedHead: GitOid },
  deps: MergeExecutorDeps,
): Promise<UpdateBranchResult> {
  if (deps.updateBranch === undefined) {
    return { status: 'ineligible', prNumber: action.prNumber, reason: 'update-branch-unavailable' };
  }
  const candidate = await deps.readCandidate(action.prNumber);
  if (candidate === null) {
    return { status: 'ineligible', prNumber: action.prNumber, reason: 'pull-request-missing' };
  }
  if (candidate.head !== action.expectedHead) {
    return { status: 'changed-head', prNumber: action.prNumber, head: candidate.head };
  }
  const selection = selectCredential(deps.credentials, { phase: 'merge' });
  if (selection.status !== 'selected') {
    return { status: 'ineligible', prNumber: action.prNumber, reason: 'credential-unavailable' };
  }
  const outcome = await deps.updateBranch({
    prNumber: action.prNumber,
    expectedHead: action.expectedHead,
    credential: selection.credential,
  });
  if (outcome.status === 'changed-head') {
    return { status: 'changed-head', prNumber: action.prNumber, head: outcome.head };
  }
  if (outcome.status === 'rejected') {
    return { status: 'rejected', prNumber: action.prNumber, reason: 'update-branch-rejected' };
  }
  return { status: 'updated', prNumber: action.prNumber, head: outcome.head };
}

export type FileReconcileChildResult =
  | {
      readonly status: 'filed' | 'already-open';
      readonly prNumber: number;
      readonly childNumber: number;
    }
  | {
      readonly status: 'runaway-hold';
      readonly prNumber: number;
      readonly priorCount: number;
    }
  | { readonly status: 'ineligible'; readonly prNumber: number; readonly reason: string };

export async function executeFileReconcileChildAction(
  action: {
    readonly prNumber: number;
    readonly expectedHead: GitOid;
    readonly effort: 'low' | 'medium' | 'high';
  },
  deps: MergeExecutorDeps,
): Promise<FileReconcileChildResult> {
  if (deps.fileReconcileChild === undefined) {
    return {
      status: 'ineligible',
      prNumber: action.prNumber,
      reason: 'file-reconcile-child-unavailable',
    };
  }
  const candidate = await deps.readCandidate(action.prNumber);
  if (candidate === null) {
    return { status: 'ineligible', prNumber: action.prNumber, reason: 'pull-request-missing' };
  }
  if (candidate.head !== action.expectedHead) {
    return { status: 'ineligible', prNumber: action.prNumber, reason: 'changed-head' };
  }
  const selection = selectCredential(deps.credentials, { phase: 'merge' });
  if (selection.status !== 'selected') {
    return { status: 'ineligible', prNumber: action.prNumber, reason: 'credential-unavailable' };
  }
  const filed = await deps.fileReconcileChild({
    prNumber: action.prNumber,
    effort: action.effort,
    credential: selection.credential,
  });
  if (filed.runawayHold === true) {
    return {
      status: 'runaway-hold',
      prNumber: action.prNumber,
      priorCount: filed.priorCount,
    };
  }
  return {
    status: filed.created ? 'filed' : 'already-open',
    prNumber: action.prNumber,
    childNumber: filed.number,
  };
}

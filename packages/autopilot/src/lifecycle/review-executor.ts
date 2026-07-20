import type { SpawnResult } from '../dispatcher/coordinator-session.js';
import type {
  AttemptPaths,
  ReviewApprovalPolicy,
} from './attempt-workspace.js';
import type {
  CredentialPool,
  SelectedCredential,
} from './credentials.js';
import {
  buildSanitizedChildEnv,
  selectCredential,
} from './credentials.js';
import type { NativeReviewState } from './snapshot.js';
import type {
  GitOid,
  GitRefName,
  HumanReason,
  PublicationOutcome,
  ReviewClaimRecord,
} from './types.js';

export interface ReviewNativeReview {
  readonly reviewer: string;
  readonly state: NativeReviewState;
  readonly commitId: GitOid;
  readonly body: string;
  readonly submittedAt: string;
}

export interface ReviewActionCandidate {
  readonly issueNumber: number;
  readonly number: number;
  readonly open: boolean;
  readonly head: GitOid;
  readonly headChangedAt: string;
  readonly headRefName: GitRefName;
  readonly baseRefName: GitRefName;
  readonly draft: boolean;
  readonly author: string;
  readonly labels: readonly string[];
  readonly body: string;
  readonly humanHold: boolean;
  readonly approvalPolicy: ReviewApprovalPolicy;
  readonly nativeReviews: readonly ReviewNativeReview[];
  readonly terminalApprovalMatches?: boolean;
  readonly mappingProblem?: string;
  readonly reviewRef?: {
    readonly oid: GitOid;
    readonly record: ReviewClaimRecord;
  };
}

export interface ReviewAttemptBinding {
  readonly attemptId: string;
  readonly paths: Pick<
  AttemptPaths,
  'worktree' | 'manifest' | 'log' | 'ghConfigDir' | 'askpass'
  >;
}

export interface ReviewExecutorDeps {
  readCandidate(prNumber: number): Promise<ReviewActionCandidate | null>;
  confirmAcquisition(input: {
    readonly prNumber: number;
    readonly expectedHead: GitOid;
    readonly expectedReviewRefOid: GitOid;
  }): Promise<ReviewActionCandidate | null>;
  readonly credentials: CredentialPool;
  createReviewRecord(input: {
    readonly record: ReviewClaimRecord;
    readonly parent: GitOid | null;
    readonly credential: SelectedCredential;
  }): Promise<GitOid>;
  publishReviewClaim(input: {
    readonly prNumber: number;
    readonly recordParent: GitOid | null;
    readonly expectedRemoteRecordOid: GitOid | null;
    readonly recordOid: GitOid;
    readonly credential: SelectedCredential;
  }): Promise<PublicationOutcome>;
  createAttempt(input: {
    readonly attemptId: string;
    readonly issueNumber: number;
    readonly prNumber: number;
    readonly branch: GitRefName;
    readonly targetBase: GitRefName;
    readonly expectedHead: GitOid;
    readonly claimOid: GitOid;
    readonly reviewGeneration: string;
    readonly reviewRefOid: GitOid;
    readonly approvalPolicy: ReviewApprovalPolicy;
    readonly selectedLogin: string;
  }): Promise<ReviewAttemptBinding>;
  repairProjection(input: {
    readonly candidate: ReviewActionCandidate;
    readonly expectedReviewRefOid: GitOid;
    readonly credential: SelectedCredential;
  }): Promise<void>;
  spawnCoordinator(input: {
    readonly attemptId: string;
    readonly candidate: ReviewActionCandidate;
    readonly recoverFixes: boolean;
    readonly environment: NodeJS.ProcessEnv;
    readonly worktreePath: string;
    readonly logPath: string;
  }): SpawnResult;
  trackChild(manifestPath: string, child: SpawnResult): void;
  escalateHuman(input: {
    readonly candidate: ReviewActionCandidate;
    readonly reason: HumanReason;
  }): Promise<void>;
  readonly ambientEnvironment: NodeJS.ProcessEnv;
  nextAttemptId(): string;
  nextGeneration(): string;
  readonly runnerId: string;
  now(): Date;
  readonly staleAfterMs: number;
}

export type ReviewExecutionResult =
  | {
      readonly status: 'spawned';
      readonly prNumber: number;
      readonly head: GitOid;
      readonly reviewRefOid: GitOid;
      readonly attemptId: string;
      readonly generation: string;
      readonly reviewer: string;
      readonly recoverFixes: boolean;
      readonly approvalPolicy: ReviewApprovalPolicy;
    }
  | { readonly status: 'already-approved'; readonly prNumber: number; readonly head: GitOid }
  | { readonly status: 'ineligible'; readonly prNumber: number; readonly detail: string }
  | { readonly status: 'human'; readonly prNumber: number; readonly code: 'reviewer-identity-unavailable' | 'review-escalation' }
  | { readonly status: 'lost' | 'ambiguous'; readonly prNumber: number };

export async function executeReviewAction(
  action: {
    readonly prNumber: number;
    readonly expectedHead?: GitOid;
    readonly recoverFixes?: boolean;
  },
  deps: ReviewExecutorDeps,
): Promise<ReviewExecutionResult> {
  if (!Number.isSafeInteger(action.prNumber) || action.prNumber <= 0) {
    throw new Error('Review action requires a positive PR number');
  }
  const candidate = await deps.readCandidate(action.prNumber);
  if (
    candidate === null
    || candidate.number !== action.prNumber
    || !candidate.open
  ) {
    return {
      status: 'ineligible',
      prNumber: action.prNumber,
      detail: candidate === null ? 'Pull request is missing.' : 'Pull request is not open.',
    };
  }
  if (action.expectedHead !== undefined && candidate.head !== action.expectedHead) {
    return {
      status: 'ineligible',
      prNumber: candidate.number,
      detail: 'Pull request head changed after scheduling.',
    };
  }
  const lifecycleMarker =
    `<!-- jinn-autopilot:v2 issue=${candidate.issueNumber} branch=${candidate.headRefName} -->`;
  const closingMarker = new RegExp(
    String.raw`<!-- jinn-autopilot:v2 issue=([1-9][0-9]*) branch=([^ >]+) -->`,
  ).exec(candidate.body);
  if (
    candidate.mappingProblem !== undefined
    ||
    closingMarker === null
    || Number(closingMarker[1]) !== candidate.issueNumber
    || closingMarker[2] !== candidate.headRefName
    || !candidate.body.includes(lifecycleMarker)
  ) {
    const reason: HumanReason = {
      phase: 'awaiting-review',
      code: 'review-escalation',
      detail: candidate.mappingProblem ?? 'PR lifecycle mapping or marker is contradictory.',
    };
    await deps.escalateHuman({ candidate, reason });
    return {
      status: 'human',
      prNumber: candidate.number,
      code: 'review-escalation',
    };
  }
  if (candidate.humanHold) {
    const reason: HumanReason = {
      phase: 'reviewing',
      code: 'review-escalation',
      detail: 'Human authority is active; repair its durable projection before stopping.',
    };
    await deps.escalateHuman({ candidate, reason });
    return {
      status: 'human',
      prNumber: candidate.number,
      code: 'review-escalation',
    };
  }
  const current = candidate.reviewRef;
  if (
    current?.record.state === 'terminal-approved'
    && current.record.head === candidate.head
    && candidate.terminalApprovalMatches === true
  ) {
    return {
      status: 'already-approved',
      prNumber: candidate.number,
      head: candidate.head,
    };
  }

  const currentHeadClaim = current?.record.head === candidate.head
    ? current.record
    : undefined;
  if (currentHeadClaim?.state === 'human') {
    const reason: HumanReason = {
      phase: 'reviewing',
      code: 'review-escalation',
      detail: 'The exact current review generation is held for Human judgment.',
    };
    await deps.escalateHuman({ candidate, reason });
    return {
      status: 'human',
      prNumber: candidate.number,
      code: 'review-escalation',
    };
  }
  const headChangedAt = Date.parse(candidate.headChangedAt);
  const nowMs = deps.now().getTime();
  if (!Number.isFinite(headChangedAt) || headChangedAt > nowMs) {
    return {
      status: 'ineligible',
      prNumber: candidate.number,
      detail: 'Review progress timestamp is invalid.',
    };
  }
  // Winning a review claim generation initializes its own progress clock (the
  // one permitted progress event for review, mirroring the branch claim commit
  // for implement/merge-prep) — see staleEvidence in lifecycle.ts, the
  // canonical definition this mirrors. Later metadata-only transitions
  // (verdict-intent, fixing, ...) do not get their own fresh window.
  let progressTime = headChangedAt;
  if (currentHeadClaim?.state === 'active') {
    const acquisitionTime = Date.parse(currentHeadClaim.recordedAt);
    if (!Number.isFinite(acquisitionTime) || acquisitionTime > nowMs) {
      return {
        status: 'ineligible',
        prNumber: candidate.number,
        detail: 'Review claim acquisition timestamp is invalid.',
      };
    }
    if (acquisitionTime > progressTime) progressTime = acquisitionTime;
  }
  const stale = nowMs - progressTime >= deps.staleAfterMs;
  if (
    currentHeadClaim !== undefined
    && currentHeadClaim.state !== 'stale'
    && currentHeadClaim.state !== 'terminal-approved'
    && !stale
  ) {
    return {
      status: 'ineligible',
      prNumber: candidate.number,
      detail: 'The exact PR head already has an active review generation.',
    };
  }
  const recoverFixes = candidate.draft
    && currentHeadClaim !== undefined
    && ['fixing', 'stale', 'verdict-intent'].includes(currentHeadClaim.state)
    && stale;
  if (
    action.recoverFixes !== undefined
    && action.recoverFixes !== recoverFixes
  ) {
    return {
      status: 'ineligible',
      prNumber: candidate.number,
      detail: 'Review recovery mode changed after scheduling.',
    };
  }
  if (candidate.draft && !recoverFixes) {
    return {
      status: 'ineligible',
      prNumber: candidate.number,
      detail: 'A draft PR is reviewable only as stale review-fix recovery.',
    };
  }

  const selection = selectCredential(deps.credentials, {
    phase: 'review',
    prAuthor: candidate.author,
    ...(recoverFixes
      ? {
          previousReviewerLogin: currentHeadClaim!.reviewer,
          nativeRequestedChanges: true,
        }
      : {}),
  });
  if (selection.status !== 'selected') {
    if (recoverFixes) {
      const reason: HumanReason = {
        phase: 'review-fixing',
        code: 'reviewer-identity-unavailable',
        detail: selection.detail,
      };
      await deps.escalateHuman({ candidate, reason });
      return {
        status: 'human',
        prNumber: candidate.number,
        code: 'reviewer-identity-unavailable',
      };
    }
    return {
      status: 'ineligible',
      prNumber: candidate.number,
      detail: selection.detail,
    };
  }

  const attemptId = deps.nextAttemptId();
  const generation = deps.nextGeneration();
  const record: ReviewClaimRecord = {
    kind: 'review-claim',
    protocolVersion: 2,
    prNumber: candidate.number,
    generation,
    attempt: attemptId,
    reviewer: selection.login,
    head: candidate.head,
    state: 'active',
    recordedAt: deps.now().toISOString(),
  };
  const parent = current?.oid ?? null;
  const recordOid = await deps.createReviewRecord({
    record,
    parent,
    credential: selection.credential,
  });
  const outcome = await deps.publishReviewClaim({
    prNumber: candidate.number,
    recordParent: parent,
    expectedRemoteRecordOid: parent,
    recordOid,
    credential: selection.credential,
  });
  if (outcome.status === 'lost') {
    return { status: 'lost', prNumber: candidate.number };
  }
  if (
    outcome.status === 'ambiguous'
    || !('observed' in outcome)
    || outcome.published !== recordOid
    || outcome.observed !== recordOid
  ) {
    return { status: 'ambiguous', prNumber: candidate.number };
  }

  const attempt = await deps.createAttempt({
    attemptId,
    issueNumber: candidate.issueNumber,
    prNumber: candidate.number,
    branch: candidate.headRefName,
    targetBase: candidate.baseRefName,
    expectedHead: candidate.head,
    claimOid: recordOid,
    reviewGeneration: generation,
    reviewRefOid: recordOid,
    approvalPolicy: candidate.approvalPolicy,
    selectedLogin: selection.login,
  });
  if (attempt.attemptId !== attemptId) {
    throw new Error('Detached review attempt does not match its claim');
  }
  await deps.repairProjection({
    candidate,
    expectedReviewRefOid: recordOid,
    credential: selection.credential,
  });
  const confirmed = await deps.confirmAcquisition({
    prNumber: candidate.number,
    expectedHead: candidate.head,
    expectedReviewRefOid: recordOid,
  });
  if (confirmed?.humanHold) {
    const reason: HumanReason = {
      phase: recoverFixes ? 'review-fixing' : 'reviewing',
      code: 'review-escalation',
      detail: 'A Human hold arrived during review acquisition.',
    };
    await deps.escalateHuman({ candidate: confirmed, reason });
    return {
      status: 'human',
      prNumber: candidate.number,
      code: 'review-escalation',
    };
  }
  if (
    confirmed === null
    || !confirmed.open
    || confirmed.number !== candidate.number
    || confirmed.head !== candidate.head
    || confirmed.issueNumber !== candidate.issueNumber
    || confirmed.headRefName !== candidate.headRefName
    || confirmed.baseRefName !== candidate.baseRefName
    || confirmed.mappingProblem !== undefined
    || confirmed.approvalPolicy !== candidate.approvalPolicy
  ) {
    if (
      confirmed !== null
      && (
        confirmed.mappingProblem !== undefined
        || confirmed.approvalPolicy !== candidate.approvalPolicy
      )
    ) {
      const reason: HumanReason = {
        phase: recoverFixes ? 'review-fixing' : 'reviewing',
        code: 'review-escalation',
        detail: confirmed.mappingProblem
          ?? 'The current-head CODEOWNER approval policy changed during acquisition.',
      };
      await deps.escalateHuman({ candidate: confirmed, reason });
      return {
        status: 'human',
        prNumber: candidate.number,
        code: 'review-escalation',
      };
    }
    return { status: 'lost', prNumber: candidate.number };
  }
  const confirmedClaim = confirmed.reviewRef;
  if (
    confirmedClaim?.oid !== recordOid
    || confirmedClaim.record.prNumber !== candidate.number
    || confirmedClaim.record.generation !== generation
    || confirmedClaim.record.attempt !== attemptId
    || confirmedClaim.record.reviewer.toLowerCase() !== selection.login.toLowerCase()
    || confirmedClaim.record.head !== candidate.head
    || confirmedClaim.record.state !== 'active'
  ) {
    return { status: 'lost', prNumber: candidate.number };
  }
  const environment = buildSanitizedChildEnv(
    deps.ambientEnvironment,
    selection.credential,
    {
      ghConfigDir: attempt.paths.ghConfigDir,
      askpassPath: attempt.paths.askpass,
      manifestPath: attempt.paths.manifest,
    },
  );
  const child = deps.spawnCoordinator({
    attemptId,
    candidate: confirmed,
    recoverFixes,
    environment,
    worktreePath: attempt.paths.worktree,
    logPath: attempt.paths.log,
  });
  if (child.pid === undefined) {
    throw new Error('Review coordinator did not report a child PID');
  }
  deps.trackChild(attempt.paths.manifest, child);
  return {
    status: 'spawned',
    prNumber: candidate.number,
    head: candidate.head,
    reviewRefOid: recordOid,
    attemptId,
    generation,
    reviewer: selection.login,
    recoverFixes,
    approvalPolicy: candidate.approvalPolicy,
  };
}

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
    readonly credential: SelectedCredential;
  }): Promise<ReviewAttemptBinding>;
  repairProjection(input: {
    readonly candidate: ReviewActionCandidate;
    readonly expectedReviewRefOid: GitOid;
    readonly credential: SelectedCredential;
  }): Promise<void>;
  spawnCoordinator(input: {
    readonly attemptId: string;
    readonly candidate: ReviewActionCandidate;
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
  /**
   * Injectable delay, used only to pace {@link confirmReviewAcquisition}'s
   * bounded retry against GitHub GraphQL replication lag. Production wires a
   * real `setTimeout`-based sleep; tests fake it so retries resolve
   * instantly and can assert on the delay values requested.
   */
  sleep(ms: number): Promise<void>;
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
      readonly approvalPolicy: ReviewApprovalPolicy;
    }
  | { readonly status: 'already-approved'; readonly prNumber: number; readonly head: GitOid }
  | { readonly status: 'ineligible'; readonly prNumber: number; readonly detail: string }
  | { readonly status: 'human'; readonly prNumber: number; readonly code: 'reviewer-identity-unavailable' | 'review-escalation' }
  | { readonly status: 'lost' | 'ambiguous'; readonly prNumber: number };

/**
 * Bounded retry count for {@link confirmReviewAcquisition}'s post-win
 * confirmation read. jinn-mono#1925 lived this: a review-claim push won its
 * exact-lease race (confirmed by git-protocol's own ls-remote readback and
 * by `repairProjection`'s direct ref check) but the very next GraphQL
 * snapshot read still reported the *pre-push* ref state, because GitHub's
 * GraphQL API can lag a just-pushed ref's replication by up to a few
 * seconds. The old single-shot confirm treated that lag as a loss and
 * orphaned our own winning claim. Three attempts with a short delay between
 * them gives replication time to catch up without weakening the fencing
 * invariant below.
 */
const REVIEW_ACQUISITION_MAX_ATTEMPTS = 3;

/** Delay between {@link confirmReviewAcquisition} retry attempts. */
const REVIEW_ACQUISITION_RETRY_DELAY_MS = 1000;

type ReviewAcquisitionOutcome =
  | { readonly outcome: 'confirmed'; readonly confirmed: ReviewActionCandidate }
  | {
      readonly outcome: 'human';
      readonly candidate: ReviewActionCandidate;
      readonly reason: HumanReason;
    }
  | { readonly outcome: 'lost' }
  | { readonly outcome: 'ambiguous' };

/**
 * Confirms a just-published review-claim record is the ref's exact current
 * state, tolerating GraphQL replication lag without weakening fencing.
 *
 * The invariant that must never move: a session spawns only once our exact
 * record OID has been observed as current. This function re-reads the full
 * candidate (preserving every existing revalidation: open/head/issue/branch
 * mapping/approval-policy/Human-hold) on every attempt via the same
 * `confirmAcquisition` port method the caller used before this fix -- only
 * the review-claim-ref-specific check at the end gets bounded-retry
 * treatment, because that is the only field this function reads back that
 * *we* just wrote in this operation (everything else -- head, labels,
 * project status -- was already read-back-confirmed by `repairProjection`
 * before this runs, or predates this operation entirely).
 *
 * On each attempt, the observed review-ref OID is one of three things:
 *   - our own `recordOid` -> confirmed, proceed.
 *   - the exact pre-push state (`recordParent`, or absent when the parent
 *     was null) -> replication lag; retry.
 *   - anything else -> a foreign write actually won the ref; fail closed
 *     immediately with no further retries.
 */
async function confirmReviewAcquisition(
  deps: ReviewExecutorDeps,
  input: {
    readonly candidate: ReviewActionCandidate;
    readonly recordOid: GitOid;
    readonly recordParent: GitOid | null;
    readonly generation: string;
    readonly attemptId: string;
    readonly reviewerLogin: string;
  },
): Promise<ReviewAcquisitionOutcome> {
  const phase: HumanReason['phase'] = 'reviewing';
  for (let attempt = 1; attempt <= REVIEW_ACQUISITION_MAX_ATTEMPTS; attempt += 1) {
    const confirmed = await deps.confirmAcquisition({
      prNumber: input.candidate.number,
      expectedHead: input.candidate.head,
      expectedReviewRefOid: input.recordOid,
    });
    if (confirmed?.humanHold) {
      return {
        outcome: 'human',
        candidate: confirmed,
        reason: {
          phase,
          code: 'review-escalation',
          detail: 'A Human hold arrived during review acquisition.',
        },
      };
    }
    if (
      confirmed === null
      || !confirmed.open
      || confirmed.number !== input.candidate.number
      || confirmed.head !== input.candidate.head
      || confirmed.issueNumber !== input.candidate.issueNumber
      || confirmed.headRefName !== input.candidate.headRefName
      || confirmed.baseRefName !== input.candidate.baseRefName
      || confirmed.mappingProblem !== undefined
      || confirmed.approvalPolicy !== input.candidate.approvalPolicy
    ) {
      if (
        confirmed !== null
        && (
          confirmed.mappingProblem !== undefined
          || confirmed.approvalPolicy !== input.candidate.approvalPolicy
        )
      ) {
        return {
          outcome: 'human',
          candidate: confirmed,
          reason: {
            phase,
            code: 'review-escalation',
            detail: confirmed.mappingProblem
              ?? 'The current-head CODEOWNER approval policy changed during acquisition.',
          },
        };
      }
      return { outcome: 'lost' };
    }
    const confirmedClaim = confirmed.reviewRef;
    if (
      confirmedClaim?.oid === input.recordOid
      && confirmedClaim.record.prNumber === input.candidate.number
      && confirmedClaim.record.generation === input.generation
      && confirmedClaim.record.attempt === input.attemptId
      && confirmedClaim.record.reviewer.toLowerCase() === input.reviewerLogin.toLowerCase()
      && confirmedClaim.record.head === input.candidate.head
      && confirmedClaim.record.state === 'active'
    ) {
      return { outcome: 'confirmed', confirmed };
    }
    const observedOid = confirmedClaim?.oid ?? null;
    if (observedOid !== input.recordParent) {
      // Neither our record nor the pre-push state -- a foreign write
      // genuinely won. Fail closed immediately; no more retries.
      return { outcome: 'lost' };
    }
    if (attempt === REVIEW_ACQUISITION_MAX_ATTEMPTS) return { outcome: 'ambiguous' };
    await deps.sleep(REVIEW_ACQUISITION_RETRY_DELAY_MS);
  }
  /* istanbul ignore next -- unreachable: the loop always returns */
  return { outcome: 'ambiguous' };
}

export async function executeReviewAction(
  action: {
    readonly prNumber: number;
    readonly expectedHead?: GitOid;
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
  // for implement) — see staleEvidence in lifecycle.ts, the canonical
  // definition this mirrors. Later metadata-only transitions (verdict-intent,
  // ...) do not get their own fresh window.
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
  if (candidate.draft) {
    return {
      status: 'ineligible',
      prNumber: candidate.number,
      detail: 'Draft pull requests are not claimable for review.',
    };
  }

  const selection = selectCredential(deps.credentials, {
    phase: 'review',
    prAuthor: candidate.author,
  });
  if (selection.status !== 'selected') {
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
    credential: selection.credential,
  });
  if (attempt.attemptId !== attemptId) {
    throw new Error('Detached review attempt does not match its claim');
  }
  await deps.repairProjection({
    candidate,
    expectedReviewRefOid: recordOid,
    credential: selection.credential,
  });
  const acquisition = await confirmReviewAcquisition(deps, {
    candidate,
    recordOid,
    recordParent: parent,
    generation,
    attemptId,
    reviewerLogin: selection.login,
  });
  if (acquisition.outcome === 'human') {
    await deps.escalateHuman({ candidate: acquisition.candidate, reason: acquisition.reason });
    return {
      status: 'human',
      prNumber: candidate.number,
      code: 'review-escalation',
    };
  }
  if (acquisition.outcome === 'lost') {
    return { status: 'lost', prNumber: candidate.number };
  }
  if (acquisition.outcome === 'ambiguous') {
    return { status: 'ambiguous', prNumber: candidate.number };
  }
  const confirmed = acquisition.confirmed;
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
    approvalPolicy: candidate.approvalPolicy,
  };
}

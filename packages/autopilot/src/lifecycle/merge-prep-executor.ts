import type { SpawnResult } from '../dispatcher/coordinator-session.js';
import type { AttemptPaths } from './attempt-workspace.js';
import {
  buildSanitizedChildEnv,
  selectCredential,
  type CredentialPool,
  type SelectedCredential,
} from './credentials.js';
import { validateCanonicalGitHubHttpsRemote } from './implementation-executor.js';
import type {
  BranchClaim,
  ClaimOutcome,
  GitOid,
  GitRefName,
  HumanReason,
} from './types.js';

export interface MergePrepCandidate {
  readonly issueNumber: number;
  readonly prNumber: number;
  readonly open: boolean;
  readonly head: GitOid;
  readonly headRefName: GitRefName;
  readonly baseRefName: GitRefName;
  readonly targetBaseOid: GitOid;
  readonly draft: boolean;
  readonly labels: readonly string[];
  readonly body: string;
  readonly humanHold: boolean;
  readonly terminalApprovalMatches: boolean;
  readonly mergeState: 'clean' | 'behind' | 'conflict' | 'blocked';
  readonly codeownerSensitive: boolean;
  readonly changedFilesComplete: boolean;
  readonly branchClaim?: BranchClaim;
}

export interface MergePrepAttemptBinding {
  readonly attemptId: string;
  readonly paths: Pick<
  AttemptPaths,
  'worktree' | 'manifest' | 'log' | 'ghConfigDir' | 'askpass'
  >;
}

export interface MergePrepExecutorDeps {
  readCandidate(prNumber: number): Promise<MergePrepCandidate | null>;
  confirmAuthority(input: {
    readonly prNumber: number;
    readonly claimOid: GitOid;
    readonly expectedOldHead: GitOid;
    readonly targetBaseOid: GitOid;
  }): Promise<MergePrepCandidate | null>;
  readonly credentials: CredentialPool;
  readonly remoteUrl: string;
  createClaimCommit(input: {
    readonly claim: BranchClaim & { readonly phase: 'merge-prep' };
    readonly parent: GitOid;
    readonly credential: SelectedCredential;
  }): Promise<GitOid>;
  claimBranch(input: {
    readonly branch: GitRefName;
    readonly expectedRemoteHead: GitOid;
    readonly claimOid: GitOid;
    readonly remoteUrl: string;
    readonly credential: SelectedCredential;
  }): Promise<ClaimOutcome>;
  repairProjection(input: {
    readonly candidate: MergePrepCandidate;
    readonly claimOid: GitOid;
    readonly credential: SelectedCredential;
  }): Promise<void>;
  createAttempt(input: {
    readonly attemptId: string;
    readonly issueNumber: number;
    readonly prNumber: number;
    readonly branch: GitRefName;
    readonly targetBase: GitRefName;
    readonly targetBaseOid: GitOid;
    readonly expectedHead: GitOid;
    readonly claimOid: GitOid;
    readonly selectedLogin: string;
    readonly credential: SelectedCredential;
  }): Promise<MergePrepAttemptBinding>;
  spawnCoordinator(input: {
    readonly attemptId: string;
    readonly candidate: MergePrepCandidate;
    readonly expectedOldHead: GitOid;
    readonly environment: NodeJS.ProcessEnv;
    readonly worktreePath: string;
    readonly logPath: string;
  }): SpawnResult;
  trackChild(manifestPath: string, child: SpawnResult): void;
  escalateHuman(input: {
    readonly candidate: MergePrepCandidate;
    readonly reason: HumanReason;
  }): Promise<void>;
  readonly ambientEnvironment: NodeJS.ProcessEnv;
  nextAttemptId(): string;
  readonly runnerId: string;
  now(): Date;
  /**
   * Injectable delay, used only to pace {@link confirmMergePrepAuthority}'s
   * bounded retry against GitHub GraphQL replication lag. See the identical
   * seam in review-executor.ts's `confirmReviewAcquisition`.
   */
  sleep(ms: number): Promise<void>;
}

export type MergePrepExecutionResult =
  | {
      readonly status: 'spawned';
      readonly issueNumber: number;
      readonly prNumber: number;
      readonly claimOid: GitOid;
      readonly attemptId: string;
    }
  | {
      readonly status: 'ineligible';
      readonly prNumber: number;
      readonly detail: string;
    }
  | {
      readonly status: 'lost' | 'ambiguous';
      readonly prNumber: number;
      readonly reason?: 'target-base-changed' | 'authority-changed';
    }
  | {
      readonly status: 'human';
      readonly prNumber: number;
    };

function markerMatches(candidate: MergePrepCandidate): boolean {
  return candidate.body.includes(
    `<!-- jinn-autopilot:v2 issue=${candidate.issueNumber} branch=${candidate.headRefName} -->`,
  );
}

function ineligibility(
  candidate: MergePrepCandidate,
  expectedHead: GitOid,
  recoverStale: boolean,
): string | null {
  if (!candidate.open) return 'Pull request is not open.';
  if (candidate.head !== expectedHead) return 'Pull request head changed.';
  if (candidate.draft && !recoverStale) {
    return 'Draft pull requests are not merge-prep eligible.';
  }
  if (
    recoverStale
    && (
      candidate.branchClaim?.phase !== 'merge-prep'
      || candidate.branchClaim.phaseComplete === true
    )
  ) {
    return 'Stale merge-prep recovery no longer has an incomplete prep claim.';
  }
  if (
    !recoverStale
    && candidate.branchClaim?.phase === 'merge-prep'
    && candidate.branchClaim.phaseComplete !== true
  ) {
    return 'The exact branch already has an active merge-prep claim.';
  }
  if (candidate.humanHold) return 'Human authority is active.';
  if (!candidate.labels.includes('engine:review')) return 'Review lifecycle label is absent.';
  if (!markerMatches(candidate)) return 'Lifecycle mapping marker is contradictory.';
  if (!candidate.terminalApprovalMatches) return 'Exact-head terminal approval is absent.';
  if (candidate.mergeState !== 'behind' && candidate.mergeState !== 'conflict') {
    return 'Pull request is not behind or conflicting.';
  }
  if (!candidate.changedFilesComplete) return 'Changed-file policy is incomplete.';
  if (candidate.codeownerSensitive) return 'CODEOWNER-sensitive changes require Human authority.';
  return null;
}

function exactWinningAuthority(
  current: MergePrepCandidate | null,
  original: MergePrepCandidate,
  claim: BranchClaim & { readonly phase: 'merge-prep'; readonly targetBaseOid: GitOid },
  claimOid: GitOid,
): current is MergePrepCandidate {
  const currentClaim = current?.branchClaim;
  return current !== null
    && current.open
    && current.prNumber === original.prNumber
    && current.issueNumber === original.issueNumber
    && current.head === claimOid
    && current.headRefName === original.headRefName
    && current.baseRefName === original.baseRefName
    && current.targetBaseOid === original.targetBaseOid
    && current.draft
    && !current.humanHold
    && current.changedFilesComplete
    && !current.codeownerSensitive
    && current.labels.includes('engine:review')
    && markerMatches(current)
    && currentClaim?.phase === 'merge-prep'
    && currentClaim.issueNumber === claim.issueNumber
    && currentClaim.prNumber === claim.prNumber
    && currentClaim.attempt === claim.attempt
    && currentClaim.runner === claim.runner
    && currentClaim.login.toLowerCase() === claim.login.toLowerCase()
    && currentClaim.expectedHead === claim.expectedHead
    && currentClaim.targetBase === claim.targetBase
    && currentClaim.targetBaseOid === claim.targetBaseOid;
}

/**
 * Bounded retry count for {@link confirmMergePrepAuthority}'s post-win
 * confirmation read. Identical seam and rationale to
 * `confirmReviewAcquisition` in review-executor.ts (jinn-mono#1925): a
 * merge-prep claim commit can win its exact-lease branch push while the
 * very next GraphQL PR snapshot read still reports the *pre-push* head,
 * because GitHub's GraphQL API can lag a just-pushed ref's replication by
 * up to a few seconds. A single-shot confirm would treat that lag as a
 * loss and orphan our own winning claim.
 */
const MERGE_PREP_CONFIRM_MAX_ATTEMPTS = 3;

/** Delay between {@link confirmMergePrepAuthority} retry attempts. */
const MERGE_PREP_CONFIRM_RETRY_DELAY_MS = 1000;

type MergePrepConfirmOutcome =
  | { readonly outcome: 'confirmed'; readonly current: MergePrepCandidate }
  | { readonly outcome: 'target-base-changed' }
  | { readonly outcome: 'authority-changed' }
  | { readonly outcome: 'ambiguous' };

/**
 * Confirms a just-won merge-prep branch claim is the branch's exact current
 * state, tolerating GraphQL replication lag without weakening fencing.
 *
 * The invariant that must never move: a session spawns only once our exact
 * claim commit has been observed as the branch's current head. This
 * function re-reads the full candidate (preserving every existing
 * revalidation `exactWinningAuthority` performs -- open/issue/PR/branch
 * mapping/draft/Human-hold/CODEOWNER/label/claim-trailer identity) on every
 * attempt via the same `confirmAuthority` port method the caller used
 * before this fix. Only the branch-head-specific check gets bounded-retry
 * treatment, because `head` is the one field this reads back that *we*
 * just wrote in this operation; `repairProjection` already read-back
 * confirmed labels and Project status before this runs.
 *
 * On each attempt, the observed head is one of three things:
 *   - our own `claimOid` -> confirmed (once every other field also
 *     matches), proceed.
 *   - the exact pre-push head (`original.head`) -> replication lag; retry.
 *   - anything else -> a foreign write actually won the branch; fail
 *     closed immediately with no further retries.
 *
 * `distinguishTargetBaseChange` preserves this executor's pre-existing
 * behavior of giving the first confirmation (right after the win) a
 * distinct `target-base-changed` reason, separate from the generic
 * `authority-changed`; the second confirmation (after workspace creation)
 * folds both into `authority-changed`, matching prior behavior exactly.
 */
async function confirmMergePrepAuthority(
  deps: Pick<MergePrepExecutorDeps, 'sleep'>,
  input: {
    readonly confirm: () => Promise<MergePrepCandidate | null>;
    readonly original: MergePrepCandidate;
    readonly claim: BranchClaim & { readonly phase: 'merge-prep'; readonly targetBaseOid: GitOid };
    readonly claimOid: GitOid;
    readonly distinguishTargetBaseChange: boolean;
  },
): Promise<MergePrepConfirmOutcome> {
  for (let attempt = 1; attempt <= MERGE_PREP_CONFIRM_MAX_ATTEMPTS; attempt += 1) {
    const current = await input.confirm();
    if (
      input.distinguishTargetBaseChange
      && current?.targetBaseOid !== input.original.targetBaseOid
    ) {
      return { outcome: 'target-base-changed' };
    }
    // Captured before the type-guard call below: TypeScript's negative
    // narrowing of a nullable user-defined type-guard parameter collapses
    // to `never` after an early return from the positive branch, so `head`
    // is read out here rather than through `current` afterward.
    const observedHead = current?.head ?? null;
    if (exactWinningAuthority(current, input.original, input.claim, input.claimOid)) {
      return { outcome: 'confirmed', current };
    }
    if (observedHead !== input.original.head) {
      return { outcome: 'authority-changed' };
    }
    if (attempt === MERGE_PREP_CONFIRM_MAX_ATTEMPTS) return { outcome: 'ambiguous' };
    await deps.sleep(MERGE_PREP_CONFIRM_RETRY_DELAY_MS);
  }
  /* istanbul ignore next -- unreachable: the loop always returns */
  return { outcome: 'ambiguous' };
}

export async function executeMergePrepAction(
  action: {
    readonly prNumber: number;
    readonly expectedHead: GitOid;
    readonly recoverStale?: boolean;
  },
  deps: MergePrepExecutorDeps,
): Promise<MergePrepExecutionResult> {
  if (!Number.isSafeInteger(action.prNumber) || action.prNumber <= 0) {
    throw new Error('Merge-prep action requires a positive PR number');
  }
  const candidate = await deps.readCandidate(action.prNumber);
  if (candidate === null || candidate.prNumber !== action.prNumber) {
    return { status: 'ineligible', prNumber: action.prNumber, detail: 'Pull request is missing.' };
  }
  const detail = ineligibility(
    candidate,
    action.expectedHead,
    action.recoverStale ?? false,
  );
  if (detail !== null) {
    return { status: 'ineligible', prNumber: action.prNumber, detail };
  }
  const selection = selectCredential(deps.credentials, { phase: 'merge-prep' });
  if (selection.status !== 'selected') {
    return { status: 'ineligible', prNumber: action.prNumber, detail: selection.detail };
  }
  const remoteUrl = validateCanonicalGitHubHttpsRemote(deps.remoteUrl);
  const attemptId = deps.nextAttemptId();
  const claim: BranchClaim & {
    readonly phase: 'merge-prep';
    readonly targetBaseOid: GitOid;
  } = {
    kind: 'branch-claim',
    protocolVersion: 2,
    phase: 'merge-prep',
    issueNumber: candidate.issueNumber,
    prNumber: candidate.prNumber,
    attempt: attemptId,
    runner: deps.runnerId,
    login: selection.login,
    expectedHead: candidate.head,
    targetBase: candidate.baseRefName,
    targetBaseOid: candidate.targetBaseOid,
    claimedAt: deps.now().toISOString(),
  };
  const claimOid = await deps.createClaimCommit({
    claim,
    parent: candidate.head,
    credential: selection.credential,
  });
  const outcome = await deps.claimBranch({
    branch: candidate.headRefName,
    expectedRemoteHead: candidate.head,
    claimOid,
    remoteUrl,
    credential: selection.credential,
  });
  if (outcome.status === 'lost') return { status: 'lost', prNumber: candidate.prNumber };
  if (
    outcome.status === 'ambiguous'
    || outcome.published !== claimOid
    || outcome.observed !== claimOid
  ) {
    return { status: 'ambiguous', prNumber: candidate.prNumber };
  }

  await deps.repairProjection({ candidate, claimOid, credential: selection.credential });
  const confirm = () => deps.confirmAuthority({
    prNumber: candidate.prNumber,
    claimOid,
    expectedOldHead: candidate.head,
    targetBaseOid: candidate.targetBaseOid,
  });
  const firstConfirm = await confirmMergePrepAuthority(deps, {
    confirm,
    original: candidate,
    claim,
    claimOid,
    distinguishTargetBaseChange: true,
  });
  if (firstConfirm.outcome === 'target-base-changed') {
    return {
      status: 'lost',
      prNumber: candidate.prNumber,
      reason: 'target-base-changed',
    };
  }
  if (firstConfirm.outcome === 'authority-changed') {
    return { status: 'lost', prNumber: candidate.prNumber, reason: 'authority-changed' };
  }
  if (firstConfirm.outcome === 'ambiguous') {
    return { status: 'ambiguous', prNumber: candidate.prNumber };
  }
  let current: MergePrepCandidate = firstConfirm.current;
  const attempt = await deps.createAttempt({
    attemptId,
    issueNumber: candidate.issueNumber,
    prNumber: candidate.prNumber,
    branch: candidate.headRefName,
    targetBase: candidate.baseRefName,
    targetBaseOid: candidate.targetBaseOid,
    expectedHead: claimOid,
    claimOid,
    selectedLogin: selection.login,
    credential: selection.credential,
  });
  if (attempt.attemptId !== attemptId) {
    throw new Error('Detached merge-prep attempt does not match its claim');
  }
  const secondConfirm = await confirmMergePrepAuthority(deps, {
    confirm,
    original: candidate,
    claim,
    claimOid,
    distinguishTargetBaseChange: false,
  });
  if (secondConfirm.outcome === 'ambiguous') {
    return { status: 'ambiguous', prNumber: candidate.prNumber };
  }
  if (secondConfirm.outcome !== 'confirmed') {
    return { status: 'lost', prNumber: candidate.prNumber, reason: 'authority-changed' };
  }
  current = secondConfirm.current;
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
    candidate: current,
    expectedOldHead: candidate.head,
    environment,
    worktreePath: attempt.paths.worktree,
    logPath: attempt.paths.log,
  });
  if (child.pid === undefined) {
    throw new Error('Merge-prep coordinator did not report a child PID');
  }
  deps.trackChild(attempt.paths.manifest, child);
  return {
    status: 'spawned',
    issueNumber: candidate.issueNumber,
    prNumber: candidate.prNumber,
    claimOid,
    attemptId,
  };
}

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
  let current = await confirm();
  if (current?.targetBaseOid !== candidate.targetBaseOid) {
    return {
      status: 'lost',
      prNumber: candidate.prNumber,
      reason: 'target-base-changed',
    };
  }
  if (!exactWinningAuthority(current, candidate, claim, claimOid)) {
    return { status: 'lost', prNumber: candidate.prNumber, reason: 'authority-changed' };
  }
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
  current = await confirm();
  if (!exactWinningAuthority(current, candidate, claim, claimOid)) {
    return { status: 'lost', prNumber: candidate.prNumber, reason: 'authority-changed' };
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

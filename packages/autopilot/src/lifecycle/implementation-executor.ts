import type { DispatcherConfig, Effort } from '../dispatcher/types.js';
import type { CommandRunner } from '../dispatcher/issue-source.js';
import {
  spawnCoordinatorSession,
  type SpawnFn,
  type SpawnResult,
} from '../dispatcher/coordinator-session.js';
import type { RealityCheckVerdict } from '../triage/types.js';
import { gatherRealityCheckSignals } from '../triage/gather.js';
import { classifyRealityCheck } from '../triage/reality-check.js';
import {
  buildSanitizedChildEnv,
  selectCredential,
  type CredentialPool,
  type SelectedCredential,
} from './credentials.js';
import type { HumanReason } from './types.js';
import {
  gitOid,
  gitRefName,
  type BranchClaim,
  type ClaimOutcome,
  type GitOid,
  type GitRefName,
} from './types.js';

export const CANONICAL_GITHUB_HTTPS_REMOTE =
  'https://github.com/Jinn-Network/mono.git';

export async function runCanonicalImplementationRealityCheck(
  issueNumber: number,
  runner: CommandRunner,
): Promise<RealityCheckVerdict> {
  return classifyRealityCheck(
    await gatherRealityCheckSignals(issueNumber, runner),
  );
}

export interface ImplementationIssue {
  readonly number: number;
  readonly title: string;
  readonly open: boolean;
  readonly eligible: boolean;
  readonly targetBase: GitRefName;
  readonly effort: Effort | null;
  /** Present when this issue is a Stage 2 machine child targeting a parent PR. */
  readonly child?: {
    readonly parentPr: number;
    readonly kind: 'review-finding' | 'reconcile';
  };
}

export interface ImplementationPullRequest {
  readonly number: number;
  readonly headRefName: GitRefName;
  readonly head: GitOid;
  readonly baseRefName: GitRefName;
  readonly draft: boolean;
  readonly labels: readonly string[];
  readonly body: string;
}

export interface ImplementationAttemptBinding {
  readonly attemptId: string;
  readonly paths: {
    readonly worktree: string;
    readonly manifest: string;
    readonly log: string;
    readonly ghConfigDir: string;
    readonly askpass: string;
  };
}

interface ClaimPublicationInput {
  readonly branch: GitRefName;
  readonly candidateParent: GitOid;
  readonly expectedRemoteHead: GitOid | null;
  readonly claimOid: GitOid;
  readonly remoteUrl: string;
  readonly login: string;
  readonly credential: SelectedCredential;
}

interface DraftPullRequestInput {
  readonly issueNumber: number;
  readonly branch: GitRefName;
  readonly claimOid: GitOid;
  readonly targetBase: GitRefName;
  readonly title: string;
  readonly body: string;
  readonly draft: true;
  readonly label: string;
  readonly credential: SelectedCredential;
}

interface CreateAttemptInput {
  readonly attemptId: string;
  readonly issueNumber: number;
  readonly branch: GitRefName;
  readonly targetBase: GitRefName;
  readonly expectedHead: GitOid;
  readonly claimOid: GitOid;
  readonly prNumber: number;
  readonly selectedLogin: string;
  readonly credential: SelectedCredential;
}

interface SpawnImplementationInput {
  readonly attemptId: string;
  readonly issue: ImplementationIssue;
  readonly prNumber: number;
  readonly branch: GitRefName;
  readonly targetBase: GitRefName;
  readonly environment: NodeJS.ProcessEnv;
  readonly worktreePath: string;
  readonly logPath: string;
}

export interface ImplementationExecutorDeps {
  readIssue(issueNumber: number): Promise<ImplementationIssue | null>;
  runRealityCheck(issueNumber: number): Promise<RealityCheckVerdict>;
  listOpenPullRequests(issueNumber: number): Promise<readonly ImplementationPullRequest[]>;
  credentials: CredentialPool;
  remoteUrl: string;
  readTargetBaseHead(targetBase: GitRefName, credential: SelectedCredential): Promise<GitOid>;
  createClaimCommit(input: {
    readonly claim: BranchClaim;
    readonly parent: GitOid;
    readonly attempt: string;
    readonly credential: SelectedCredential;
  }): Promise<GitOid>;
  claimBranch(input: ClaimPublicationInput): Promise<ClaimOutcome>;
  ensureDraftPullRequest(input: DraftPullRequestInput): Promise<ImplementationPullRequest>;
  readParentPullRequest?(prNumber: number): Promise<ImplementationPullRequest | null>;
  setProjectInProgress(
    issueNumber: number,
    expectedHead: GitOid,
    credential: SelectedCredential,
  ): Promise<void>;
  createAttempt(input: CreateAttemptInput): Promise<ImplementationAttemptBinding>;
  spawnCoordinator(input: SpawnImplementationInput): SpawnResult;
  trackChild(manifestPath: string, child: SpawnResult): void;
  escalateHuman(input: {
    readonly issueNumber: number;
    readonly reason: HumanReason;
  }): Promise<void>;
  closeChildIssue?(input: {
    readonly issueNumber: number;
    readonly comment: string;
    readonly credential: SelectedCredential;
  }): Promise<void>;
  ambientEnvironment: NodeJS.ProcessEnv;
  nextAttemptId(): string;
  runnerId: string;
  now(): Date;
}

export type ImplementationExecutionResult =
  | {
      readonly status: 'spawned';
      readonly issueNumber: number;
      readonly prNumber: number;
      readonly branch: GitRefName;
      readonly claimOid: GitOid;
      readonly attemptId: string;
    }
  | {
      readonly status: 'ineligible';
      readonly issueNumber: number;
      readonly detail: string;
    }
  | {
      readonly status: 'human';
      readonly issueNumber: number;
      readonly code: 'branch-mapping-ambiguous';
    }
  | {
      readonly status: 'lost' | 'ambiguous';
      readonly issueNumber: number;
    }
  | {
      readonly status: 'partial';
      readonly issueNumber: number;
      readonly code: 'pr-not-converged' | 'target-base-changed';
      readonly claimOid: GitOid;
    };

function positiveIssueNumber(issueNumber: number): number {
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
    throw new Error('Implementation action requires a positive issue number');
  }
  return issueNumber;
}

export function validateCanonicalGitHubHttpsRemote(remoteUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(remoteUrl);
  } catch {
    throw new Error('Implementation publication requires the canonical HTTPS GitHub remote');
  }
  if (
    parsed.href !== CANONICAL_GITHUB_HTTPS_REMOTE
    || parsed.protocol !== 'https:'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.search !== ''
    || parsed.hash !== ''
  ) {
    throw new Error('Implementation publication requires the canonical HTTPS GitHub remote');
  }
  return parsed.href;
}

function bodyFor(issueNumber: number, branch: GitRefName): string {
  return [
    `Closes #${issueNumber}`,
    '',
    `<!-- jinn-autopilot:v2 issue=${issueNumber} branch=${branch} -->`,
  ].join('\n');
}

function humanBranchAmbiguity(
  issueNumber: number,
  pullRequests: readonly ImplementationPullRequest[],
  realityPrNumber?: number,
): HumanReason {
  if (realityPrNumber !== undefined && pullRequests.length === 0) {
    return {
      phase: 'eligible',
      code: 'branch-mapping-ambiguous',
      detail:
        `Canonical reality-check evidence names open PR #${realityPrNumber} for issue ` +
        `#${issueNumber}, but the bounded issue-to-PR mapping names no open PR.`,
    };
  }
  if (
    realityPrNumber !== undefined
    && pullRequests.length === 1
    && pullRequests[0]!.number !== realityPrNumber
  ) {
    return {
      phase: 'eligible',
      code: 'branch-mapping-ambiguous',
      detail:
        `Canonical reality-check evidence names open PR #${realityPrNumber} for issue ` +
        `#${issueNumber}, but the bounded issue-to-PR mapping names sole PR ` +
        `#${pullRequests[0]!.number} (${pullRequests[0]!.headRefName} → ` +
        `${pullRequests[0]!.baseRefName}).`,
    };
  }
  return {
    phase: 'eligible',
    code: 'branch-mapping-ambiguous',
    detail:
      `Issue #${issueNumber} has contradictory open implementation branches: ` +
      pullRequests.map((pullRequest) =>
        `PR #${pullRequest.number} (${pullRequest.headRefName} → ${pullRequest.baseRefName})`,
      ).join(', '),
  };
}

function prConverged(
  pullRequest: ImplementationPullRequest,
  input: DraftPullRequestInput,
): boolean {
  return pullRequest.headRefName === input.branch
    && pullRequest.head === input.claimOid
    && pullRequest.baseRefName === input.targetBase
    && pullRequest.draft
    && pullRequest.labels.includes(input.label)
    && pullRequest.body.includes(`Closes #${input.issueNumber}`)
    && pullRequest.body.includes(
      `<!-- jinn-autopilot:v2 issue=${input.issueNumber} branch=${input.branch} -->`,
    );
}

function realityPermitsImplementation(
  verdict: RealityCheckVerdict,
  openPullRequests: readonly ImplementationPullRequest[],
): boolean {
  if (verdict.classification === 'clear') return true;
  return verdict.classification === 'pr-open'
    && openPullRequests.length === 1
    && verdict.evidence.prNumber === openPullRequests[0]!.number;
}

function canonicalScenario(
  issue: ImplementationIssue,
  branch: GitRefName,
  prNumber: number,
  worktreePath: string,
): string {
  if (issue.child !== undefined) {
    const skill = issue.child.kind === 'reconcile' ? 'reconcile' : 'fix-child';
    return [
      `Use the ${skill} skill on child issue #${issue.number} for parent PR #${prNumber}.`,
      `Issue: #${issue.number} — ${issue.title}`,
      `The v2 lifecycle already claimed parent branch \`${branch}\` (phase ${
        issue.child.kind === 'reconcile' ? 'reconcile' : 'fix'
      }) and created the detached worktree at \`${worktreePath}\`.`,
      'Do not open a new PR. Work lands as append-only commits on the parent branch.',
      'Finish with `autopilot session child-complete` or park with `autopilot session human --reason-file <path>`.',
    ].join('\n');
  }
  return [
    `Use the implement-issue skill on issue #${issue.number}.`,
    `Issue: #${issue.number} — ${issue.title}`,
    `The v2 lifecycle already claimed \`${branch}\`, opened draft PR #${prNumber}, and created the detached worktree at \`${worktreePath}\`.`,
    'Use `autopilot session checkpoint` for meaningful durable checkpoints.',
    'Finish with `autopilot session implementation-complete --summary-file <path>` or park with `autopilot session human --reason-file <path>`.',
  ].join('\n');
}

export function makeCanonicalImplementationSpawner(
  config: DispatcherConfig,
  spawn: SpawnFn,
): ImplementationExecutorDeps['spawnCoordinator'] {
  return (input) => {
    const skill = input.issue.child?.kind === 'reconcile'
      ? 'reconcile'
      : input.issue.child?.kind === 'review-finding'
        ? 'fix-child'
        : 'implement-issue';
    return spawnCoordinatorSession(
      {
        kind: 'implement',
        number: input.issue.number,
        skill,
        scenario: canonicalScenario(
          input.issue,
          input.branch,
          input.prNumber,
          input.worktreePath,
        ),
        worktreePath: input.worktreePath,
        effort: input.issue.effort,
        env: input.environment,
        spawnOptions: {
          detached: true,
          stdio: ['ignore', 'inherit', 'inherit'],
          logPath: input.logPath,
        },
      },
      config,
      { spawn },
    );
  };
}

export async function executeImplementationAction(
  action: { readonly issueNumber: number },
  deps: ImplementationExecutorDeps,
): Promise<ImplementationExecutionResult> {
  const issueNumber = positiveIssueNumber(action.issueNumber);
  const issue = await deps.readIssue(issueNumber);
  if (issue === null || issue.number !== issueNumber || !issue.open) {
    return {
      status: 'ineligible',
      issueNumber,
      detail: issue === null ? 'Issue is missing.' : 'Issue is not currently eligible.',
    };
  }

  if (issue.child !== undefined) {
    return executeChildImplementationAction(
      { ...issue, child: issue.child },
      deps,
    );
  }

  const reality = await deps.runRealityCheck(issueNumber);
  const openPullRequests = await deps.listOpenPullRequests(issueNumber);
  const realityPrNumber = reality.classification === 'pr-open'
    ? reality.evidence.prNumber
    : undefined;
  if (
    openPullRequests.length > 1
    || (
      openPullRequests.length === 1
      && openPullRequests[0]!.baseRefName !== issue.targetBase
    )
    || (
      realityPrNumber !== undefined
      && (
        openPullRequests.length !== 1
        || openPullRequests[0]!.number !== realityPrNumber
      )
    )
  ) {
    const reason = humanBranchAmbiguity(
      issueNumber,
      openPullRequests,
      realityPrNumber,
    );
    await deps.escalateHuman({ issueNumber, reason });
    return { status: 'human', issueNumber, code: 'branch-mapping-ambiguous' };
  }
  if (!issue.eligible || !realityPermitsImplementation(reality, openPullRequests)) {
    return {
      status: 'ineligible',
      issueNumber,
      detail: !issue.eligible
        ? 'Issue is not currently eligible.'
        : `Canonical reality check classified the issue as ${reality.classification}.`,
    };
  }

  const selection = selectCredential(deps.credentials, { phase: 'implement' });
  if (selection.status !== 'selected') {
    return { status: 'ineligible', issueNumber, detail: selection.detail };
  }
  const remoteUrl = validateCanonicalGitHubHttpsRemote(deps.remoteUrl);
  const adopted = openPullRequests[0];
  const branch = adopted?.headRefName ?? gitRefName(`autopilot/${issueNumber}`);
  const candidateParent = adopted?.head
    ?? await deps.readTargetBaseHead(issue.targetBase, selection.credential);
  const expectedRemoteHead = adopted?.head ?? null;
  const attemptId = deps.nextAttemptId();
  const claimedAt = deps.now().toISOString();
  const claim: BranchClaim = {
    kind: 'branch-claim',
    protocolVersion: 2,
    phase: 'implement',
    issueNumber,
    ...(adopted === undefined ? {} : { prNumber: adopted.number }),
    attempt: attemptId,
    runner: deps.runnerId,
    login: selection.login,
    expectedHead: gitOid(candidateParent),
    targetBase: issue.targetBase,
    claimedAt,
  };
  const claimOid = await deps.createClaimCommit({
    claim,
    parent: candidateParent,
    attempt: attemptId,
    credential: selection.credential,
  });
  const outcome = await deps.claimBranch({
    branch,
    candidateParent,
    expectedRemoteHead,
    claimOid,
    remoteUrl,
    login: selection.login,
    credential: selection.credential,
  });
  if (outcome.status === 'lost') return { status: 'lost', issueNumber };
  if (outcome.status === 'ambiguous') return { status: 'ambiguous', issueNumber };
  if (outcome.published !== claimOid || outcome.observed !== claimOid) {
    return { status: 'ambiguous', issueNumber };
  }

  const currentIssue = await deps.readIssue(issueNumber);
  if (
    currentIssue === null
    || currentIssue.number !== issueNumber
    || !currentIssue.open
    || !currentIssue.eligible
    || currentIssue.targetBase !== issue.targetBase
  ) {
    return {
      status: 'partial',
      issueNumber,
      code: 'target-base-changed',
      claimOid,
    };
  }

  const draftInput: DraftPullRequestInput = {
    issueNumber,
    branch,
    claimOid,
    targetBase: issue.targetBase,
    title: issue.title,
    body: bodyFor(issueNumber, branch),
    draft: true,
    label: 'engine:review',
    credential: selection.credential,
  };
  const pullRequest = await deps.ensureDraftPullRequest(draftInput);
  if (!prConverged(pullRequest, draftInput)) {
    return {
      status: 'partial',
      issueNumber,
      code: 'pr-not-converged',
      claimOid,
    };
  }
  await deps.setProjectInProgress(issueNumber, claimOid, selection.credential);

  const attempt = await deps.createAttempt({
    attemptId,
    issueNumber,
    branch,
    targetBase: issue.targetBase,
    expectedHead: claimOid,
    claimOid,
    prNumber: pullRequest.number,
    selectedLogin: selection.login,
    credential: selection.credential,
  });
  if (attempt.attemptId !== attemptId) {
    throw new Error('Detached implementation attempt does not match its claim');
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
    issue,
    prNumber: pullRequest.number,
    branch,
    targetBase: issue.targetBase,
    environment,
    worktreePath: attempt.paths.worktree,
    logPath: attempt.paths.log,
  });
  if (child.pid === undefined) {
    throw new Error('Implementation coordinator did not report a child PID');
  }
  deps.trackChild(attempt.paths.manifest, child);
  return {
    status: 'spawned',
    issueNumber,
    prNumber: pullRequest.number,
    branch,
    claimOid,
    attemptId,
  };
}

async function executeChildImplementationAction(
  issue: ImplementationIssue & {
    readonly child: { readonly parentPr: number; readonly kind: 'review-finding' | 'reconcile' };
  },
  deps: ImplementationExecutorDeps,
): Promise<ImplementationExecutionResult> {
  const issueNumber = issue.number;
  if (!issue.eligible) {
    return {
      status: 'ineligible',
      issueNumber,
      detail: 'Issue is not currently eligible.',
    };
  }
  if (deps.readParentPullRequest === undefined) {
    return {
      status: 'ineligible',
      issueNumber,
      detail: 'Parent PR lookup is unavailable for child claims.',
    };
  }
  const parent = await deps.readParentPullRequest(issue.child.parentPr);
  if (parent === null || parent.baseRefName !== issue.targetBase) {
    return {
      status: 'ineligible',
      issueNumber,
      detail: 'Parent pull request is missing or retargeted.',
    };
  }

  const selection = selectCredential(deps.credentials, { phase: 'implement' });
  if (selection.status !== 'selected') {
    return { status: 'ineligible', issueNumber, detail: selection.detail };
  }
  const remoteUrl = validateCanonicalGitHubHttpsRemote(deps.remoteUrl);
  const branch = parent.headRefName;
  const candidateParent = parent.head;
  const attemptId = deps.nextAttemptId();
  const claimedAt = deps.now().toISOString();
  const phase = issue.child.kind === 'reconcile' ? 'reconcile' as const : 'fix' as const;
  const claim: BranchClaim = {
    kind: 'branch-claim',
    protocolVersion: 2,
    phase,
    issueNumber,
    prNumber: parent.number,
    attempt: attemptId,
    runner: deps.runnerId,
    login: selection.login,
    expectedHead: gitOid(candidateParent),
    targetBase: issue.targetBase,
    claimedAt,
  };
  const claimOid = await deps.createClaimCommit({
    claim,
    parent: candidateParent,
    attempt: attemptId,
    credential: selection.credential,
  });
  const outcome = await deps.claimBranch({
    branch,
    candidateParent,
    expectedRemoteHead: parent.head,
    claimOid,
    remoteUrl,
    login: selection.login,
    credential: selection.credential,
  });
  if (outcome.status === 'lost') return { status: 'lost', issueNumber };
  if (outcome.status === 'ambiguous') return { status: 'ambiguous', issueNumber };
  if (outcome.published !== claimOid || outcome.observed !== claimOid) {
    return { status: 'ambiguous', issueNumber };
  }

  const attempt = await deps.createAttempt({
    attemptId,
    issueNumber,
    branch,
    targetBase: issue.targetBase,
    expectedHead: claimOid,
    claimOid,
    prNumber: parent.number,
    selectedLogin: selection.login,
    credential: selection.credential,
  });
  if (attempt.attemptId !== attemptId) {
    throw new Error('Detached child attempt does not match its claim');
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
    issue,
    prNumber: parent.number,
    branch,
    targetBase: issue.targetBase,
    environment,
    worktreePath: attempt.paths.worktree,
    logPath: attempt.paths.log,
  });
  if (child.pid === undefined) {
    throw new Error('Child coordinator did not report a child PID');
  }
  deps.trackChild(attempt.paths.manifest, child);
  return {
    status: 'spawned',
    issueNumber,
    prNumber: parent.number,
    branch,
    claimOid,
    attemptId,
  };
}

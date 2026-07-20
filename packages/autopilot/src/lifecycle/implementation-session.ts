import type { AttemptManifest } from './attempt-workspace.js';
import { formatHumanCommentMarker } from './codecs.js';
import type {
  BranchClaim,
  GitOid,
  HumanReason,
  PublicationOutcome,
  ReviewVerdictState,
} from './types.js';

export interface ImplementationAuthority {
  readonly remoteHead: GitOid;
  readonly latestClaimOid: GitOid;
  readonly latestClaim: BranchClaim;
}

export interface ImplementationSessionPullRequest {
  readonly number: number;
  readonly head: GitOid;
  readonly headRefName: string;
  readonly baseRefName: string;
  readonly draft: boolean;
  readonly labels: readonly string[];
  readonly body: string;
}

export interface ImplementationSessionPort {
  readManifest(path: string): AttemptManifest;
  readAuthority(manifest: AttemptManifest): Promise<ImplementationAuthority>;
  readLocalHead(manifest: AttemptManifest): Promise<GitOid>;
  readBranchClaim(
    manifest: AttemptManifest,
    oid: GitOid,
  ): Promise<BranchClaim | null>;
  isAncestor(
    manifest: AttemptManifest,
    ancestor: GitOid,
    descendant: GitOid,
  ): Promise<boolean>;
  treesDiffer(
    manifest: AttemptManifest,
    left: GitOid,
    right: GitOid,
  ): Promise<boolean>;
  publishBranch(input: {
    readonly manifest: AttemptManifest;
    readonly expectedRemoteHead: GitOid;
    readonly newHead: GitOid;
  }): Promise<PublicationOutcome>;
  advanceManifestHead(
    manifestPath: string,
    expectedHead: GitOid,
    nextHead: GitOid,
  ): AttemptManifest;
  createCompletionCommit(input: {
    readonly manifest: AttemptManifest;
    readonly parent: GitOid;
    readonly completionClaim: BranchClaim & { readonly phaseComplete: true };
    readonly summary: string;
  }): Promise<GitOid>;
  readPullRequest(
    prNumber: number,
    expectedHead: GitOid,
  ): Promise<ImplementationSessionPullRequest>;
  ensureCompletionSummary(
    prNumber: number,
    expectedHead: GitOid,
    summary: string,
  ): Promise<void>;
  setPullRequestLabel(
    prNumber: number,
    expectedHead: GitOid,
    label: string,
    present: boolean,
  ): Promise<void>;
  setProjectStatus(
    issueNumber: number,
    expectedHead: GitOid,
    status: 'In Review' | 'Human',
  ): Promise<void>;
  readProjectStatus(
    issueNumber: number,
    expectedHead: GitOid,
  ): Promise<'Todo' | 'In Progress' | 'Human' | 'In Review' | 'Done' | null>;
  setPullRequestDraft(
    prNumber: number,
    expectedHead: GitOid,
    draft: boolean,
  ): Promise<void>;
  hasHumanComment(
    prNumber: number,
    expectedHead: GitOid,
    marker: string,
  ): Promise<boolean>;
  ensureHumanComment(
    prNumber: number,
    expectedHead: GitOid,
    marker: string,
    body: string,
  ): Promise<void>;
}

export type CheckpointResult =
  | { readonly status: 'published' | 'already-applied'; readonly head: GitOid }
  | { readonly status: 'stale' | 'ambiguous'; readonly head: GitOid };

export type ImplementationCompleteResult =
  | { readonly status: 'complete'; readonly head: GitOid }
  | {
      readonly status: 'partial';
      readonly head: GitOid;
      readonly pending: 'checkpoint' | 'marker' | 'summary' | 'project' | 'ready';
    };

export type HumanHoldResult = {
  readonly status: 'human';
  readonly head: GitOid;
};

export const IMPLEMENTATION_SUMMARY_START =
  '<!-- jinn-autopilot:v2 implementation-summary:start -->';
export const IMPLEMENTATION_SUMMARY_END =
  '<!-- jinn-autopilot:v2 implementation-summary:end -->';

export function hasImplementationSummary(body: string, summary: string): boolean {
  return body.includes(
    `${IMPLEMENTATION_SUMMARY_START}\n${summary.trim()}\n${IMPLEMENTATION_SUMMARY_END}`,
  );
}

export interface ImplementationSessionProtocol {
  checkpoint(manifest: AttemptManifest): Promise<CheckpointResult>;
  implementationComplete(
    manifest: AttemptManifest,
    summary: string,
  ): Promise<ImplementationCompleteResult>;
  reviewVerdict(
    manifest: AttemptManifest,
    state: ReviewVerdictState,
    body: string,
  ): Promise<never>;
  reviewFixPublish(manifest: AttemptManifest): Promise<never>;
  mergePrepComplete(manifest: AttemptManifest, summary: string): Promise<never>;
  human(manifest: AttemptManifest, reason: string): Promise<HumanHoldResult>;
}

function notWired(operation: string): never {
  throw new Error(`session ${operation}: operation not wired`);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireImplementationManifest(
  supplied: AttemptManifest,
  port: ImplementationSessionPort,
): AttemptManifest {
  const fresh = port.readManifest(supplied.paths.manifest);
  if (
    fresh.phase !== 'implement'
    || fresh.attemptId !== supplied.attemptId
    || fresh.paths.manifest !== supplied.paths.manifest
    || fresh.paths.worktree !== supplied.paths.worktree
    || fresh.prNumber === undefined
  ) {
    throw new Error('Implementation session manifest authority changed or is invalid');
  }
  return fresh;
}

async function requireAuthority(
  manifest: AttemptManifest,
  port: ImplementationSessionPort,
): Promise<ImplementationAuthority> {
  const authority = await port.readAuthority(manifest);
  const latest = authority.latestClaim;
  if (
    latest.phase !== 'implement'
    || latest.attempt !== manifest.attemptId
    || latest.issueNumber !== manifest.issueNumber
    || latest.prNumber !== manifest.prNumber
    || latest.runner !== manifest.runnerId
    || latest.login.toLowerCase() !== manifest.selectedLogin.toLowerCase()
    || latest.targetBase !== manifest.targetBase
    || !await port.isAncestor(manifest, manifest.claimOid as GitOid, authority.remoteHead)
    || !await port.isAncestor(manifest, authority.latestClaimOid, authority.remoteHead)
  ) {
    throw new Error('Implementation attempt no longer owns the latest claim');
  }
  return authority;
}

async function requireActiveImplementationPullRequest(
  manifest: AttemptManifest,
  authority: ImplementationAuthority,
  port: ImplementationSessionPort,
): Promise<ImplementationSessionPullRequest> {
  const pullRequest = await port.readPullRequest(manifest.prNumber!, authority.remoteHead);
  const marker =
    `<!-- jinn-autopilot:v2 issue=${manifest.issueNumber} branch=${manifest.branch} -->`;
  if (
    pullRequest.number !== manifest.prNumber
    || pullRequest.head !== authority.remoteHead
    || pullRequest.headRefName !== manifest.branch
    || pullRequest.baseRefName !== manifest.targetBase
    || !pullRequest.draft
    || !pullRequest.body.includes(marker)
  ) {
    throw new Error('Implementation pull request authority changed or is invalid');
  }
  return pullRequest;
}

function branchOutcome(
  outcome: PublicationOutcome,
): 'published' | 'already-applied' | 'stale' | 'ambiguous' {
  if (outcome.status === 'won') return 'published';
  if (outcome.status === 'already-applied') return 'already-applied';
  if (outcome.status === 'lost') return 'stale';
  return 'ambiguous';
}

async function checkpoint(
  supplied: AttemptManifest,
  port: ImplementationSessionPort,
): Promise<CheckpointResult> {
  let manifest = requireImplementationManifest(supplied, port);
  const authority = await requireAuthority(manifest, port);
  if (authority.latestClaim.phaseComplete === true) {
    throw new Error('Implementation is already phase-complete');
  }
  await requireActiveImplementationPullRequest(manifest, authority, port);
  const localHead = await port.readLocalHead(manifest);

  if (authority.remoteHead !== manifest.expectedHead) {
    if (authority.remoteHead === localHead) {
      if (!await port.isAncestor(manifest, manifest.expectedHead as GitOid, localHead)) {
        return { status: 'stale', head: authority.remoteHead };
      }
      if (!await port.treesDiffer(manifest, manifest.expectedHead as GitOid, localHead)) {
        throw new Error('Checkpoint must contain a real tree/content change');
      }
      manifest = port.advanceManifestHead(
        manifest.paths.manifest,
        manifest.expectedHead as GitOid,
        localHead,
      );
      return { status: 'already-applied', head: manifest.expectedHead as GitOid };
    }
    return { status: 'stale', head: authority.remoteHead };
  }
  if (localHead === manifest.expectedHead) {
    return { status: 'already-applied', head: localHead };
  }
  if (!await port.isAncestor(manifest, manifest.expectedHead as GitOid, localHead)) {
    throw new Error('Local checkpoint HEAD is not a descendant of the manifest expected head');
  }
  if (!await port.treesDiffer(manifest, manifest.expectedHead as GitOid, localHead)) {
    throw new Error('Checkpoint must contain a real tree/content change');
  }

  const outcome = await port.publishBranch({
    manifest,
    expectedRemoteHead: manifest.expectedHead as GitOid,
    newHead: localHead,
  });
  const status = branchOutcome(outcome);
  if (status === 'ambiguous') return { status, head: localHead };
  if (status === 'stale') {
    const observed = 'observed' in outcome && typeof outcome.observed === 'string'
      ? outcome.observed as GitOid
      : authority.remoteHead;
    return { status, head: observed };
  }
  port.advanceManifestHead(
    manifest.paths.manifest,
    manifest.expectedHead as GitOid,
    localHead,
  );
  return { status, head: localHead };
}

function completionClaim(
  manifest: AttemptManifest,
  parent: GitOid,
): BranchClaim & { readonly phaseComplete: true } {
  return {
    kind: 'branch-claim',
    protocolVersion: 2,
    phase: 'implement',
    issueNumber: manifest.issueNumber,
    prNumber: manifest.prNumber!,
    attempt: manifest.attemptId,
    runner: manifest.runnerId,
    login: manifest.selectedLogin,
    expectedHead: parent,
    targetBase: manifest.targetBase as BranchClaim['targetBase'],
    claimedAt: new Date().toISOString(),
    phaseComplete: true,
  };
}

function isOwnedCompletionClaim(
  manifest: AttemptManifest,
  candidate: BranchClaim | null,
  expectedParent: GitOid,
): candidate is BranchClaim & { readonly phaseComplete: true } {
  return candidate?.phase === 'implement'
    && candidate.phaseComplete === true
    && candidate.issueNumber === manifest.issueNumber
    && candidate.prNumber === manifest.prNumber
    && candidate.attempt === manifest.attemptId
    && candidate.runner === manifest.runnerId
    && candidate.login.toLowerCase() === manifest.selectedLogin.toLowerCase()
    && candidate.targetBase === manifest.targetBase
    && candidate.expectedHead === expectedParent;
}

async function ensureCompletionProjection(
  manifest: AttemptManifest,
  head: GitOid,
  summary: string,
  port: ImplementationSessionPort,
): Promise<ImplementationCompleteResult> {
  const prNumber = manifest.prNumber!;
  let pullRequest: ImplementationSessionPullRequest;
  try {
    pullRequest = await port.readPullRequest(prNumber, head);
    const projectStatus = await port.readProjectStatus(manifest.issueNumber, head);
    if (
      pullRequest.number !== prNumber
      || pullRequest.head !== head
      || pullRequest.headRefName !== manifest.branch
      || pullRequest.baseRefName !== manifest.targetBase
    ) {
      return { status: 'partial', head, pending: 'project' };
    }
    if (
      !pullRequest.draft
      && hasImplementationSummary(pullRequest.body, summary)
      && pullRequest.labels.includes('engine:review')
      && projectStatus === 'In Review'
    ) {
      return { status: 'complete', head };
    }
    if (!pullRequest.draft) {
      await port.setPullRequestDraft(prNumber, head, true);
    }
  } catch {
    return { status: 'partial', head, pending: 'project' };
  }

  try {
    await port.ensureCompletionSummary(prNumber, head, summary);
  } catch {
    return { status: 'partial', head, pending: 'summary' };
  }

  try {
    pullRequest = await port.readPullRequest(prNumber, head);
    if (pullRequest.head !== head) {
      return { status: 'partial', head, pending: 'project' };
    }
    if (!pullRequest.labels.includes('engine:review')) {
      await port.setPullRequestLabel(prNumber, head, 'engine:review', true);
    }
    await port.setProjectStatus(manifest.issueNumber, head, 'In Review');
  } catch {
    return { status: 'partial', head, pending: 'project' };
  }

  try {
    pullRequest = await port.readPullRequest(prNumber, head);
    if (pullRequest.head !== head) {
      return { status: 'partial', head, pending: 'ready' };
    }
    if (pullRequest.draft) {
      await port.setPullRequestDraft(prNumber, head, false);
    }
  } catch {
    return { status: 'partial', head, pending: 'ready' };
  }
  return { status: 'complete', head };
}

async function implementationComplete(
  supplied: AttemptManifest,
  summary: string,
  port: ImplementationSessionPort,
): Promise<ImplementationCompleteResult> {
  let manifest = requireImplementationManifest(supplied, port);
  let authority = await requireAuthority(manifest, port);
  let localHead = await port.readLocalHead(manifest);

  if (authority.latestClaim.phaseComplete === true) {
    if (
      authority.latestClaimOid !== authority.remoteHead
      || localHead !== authority.remoteHead
      || !await port.isAncestor(manifest, manifest.expectedHead as GitOid, localHead)
    ) {
      throw new Error('Phase-complete authority does not match the exact local/remote head');
    }
    if (manifest.expectedHead !== authority.remoteHead) {
      manifest = port.advanceManifestHead(
        manifest.paths.manifest,
        manifest.expectedHead as GitOid,
        authority.remoteHead,
      );
    }
    return ensureCompletionProjection(manifest, authority.remoteHead, summary, port);
  }

  if (localHead !== manifest.expectedHead) {
    const localClaim = await port.readBranchClaim(manifest, localHead);
    if (
      isOwnedCompletionClaim(
        manifest,
        localClaim,
        manifest.expectedHead as GitOid,
      )
    ) {
      const retry = await port.publishBranch({
        manifest,
        expectedRemoteHead: manifest.expectedHead as GitOid,
        newHead: localHead,
      });
      if (retry.status === 'won' || retry.status === 'already-applied') {
        manifest = port.advanceManifestHead(
          manifest.paths.manifest,
          manifest.expectedHead as GitOid,
          localHead,
        );
        return ensureCompletionProjection(manifest, localHead, summary, port);
      }
      return { status: 'partial', head: localHead, pending: 'marker' };
    }
    const checkpointResult = await checkpoint(manifest, port);
    if (
      checkpointResult.status !== 'published'
      && checkpointResult.status !== 'already-applied'
    ) {
      return {
        status: 'partial',
        head: checkpointResult.head,
        pending: 'checkpoint',
      };
    }
    manifest = requireImplementationManifest(manifest, port);
    authority = await requireAuthority(manifest, port);
    localHead = await port.readLocalHead(manifest);
  }
  if (
    authority.remoteHead !== manifest.expectedHead
    || localHead !== manifest.expectedHead
  ) {
    return { status: 'partial', head: authority.remoteHead, pending: 'checkpoint' };
  }
  await requireActiveImplementationPullRequest(manifest, authority, port);

  const markerClaim = completionClaim(manifest, authority.remoteHead);
  const marker = await port.createCompletionCommit({
    manifest,
    parent: authority.remoteHead,
    completionClaim: markerClaim,
    summary,
  });
  const outcome = await port.publishBranch({
    manifest,
    expectedRemoteHead: authority.remoteHead,
    newHead: marker,
  });
  if (outcome.status === 'ambiguous' || outcome.status === 'lost') {
    return { status: 'partial', head: marker, pending: 'marker' };
  }
  manifest = port.advanceManifestHead(
    manifest.paths.manifest,
    manifest.expectedHead as GitOid,
    marker,
  );
  return ensureCompletionProjection(manifest, marker, summary, port);
}

function humanReason(detail: string): HumanReason {
  return {
    phase: 'implementing',
    code: 'implementation-escalation',
    detail,
  };
}

async function human(
  supplied: AttemptManifest,
  detail: string,
  port: ImplementationSessionPort,
): Promise<HumanHoldResult> {
  const manifest = requireImplementationManifest(supplied, port);
  const authority = await requireAuthority(manifest, port);
  if (authority.latestClaim.phaseComplete === true) {
    throw new Error('A phase-complete implementation cannot enter a Human hold');
  }
  const prNumber = manifest.prNumber!;
  const reason = humanReason(detail);
  const marker = formatHumanCommentMarker({
    issueNumber: manifest.issueNumber,
    prNumber,
    reason,
  });
  const body = `${marker}\n\nAutopilot parked this item for Human review.\n\n${detail}`;
  let pullRequest = await port.readPullRequest(prNumber, authority.remoteHead);
  if (pullRequest.head !== authority.remoteHead) {
    throw new Error('Implementation PR head changed while applying a Human hold');
  }
  if (!pullRequest.draft) {
    await port.setPullRequestDraft(prNumber, authority.remoteHead, true);
  }
  if (!pullRequest.labels.includes('engine:review')) {
    await port.setPullRequestLabel(
      prNumber,
      authority.remoteHead,
      'engine:review',
      true,
    );
  }
  if (!pullRequest.labels.includes('review:needs-human')) {
    await port.setPullRequestLabel(
      prNumber,
      authority.remoteHead,
      'review:needs-human',
      true,
    );
  }
  if (!await port.hasHumanComment(prNumber, authority.remoteHead, marker)) {
    await port.ensureHumanComment(prNumber, authority.remoteHead, marker, body);
  }
  await port.setProjectStatus(manifest.issueNumber, authority.remoteHead, 'Human');
  pullRequest = await port.readPullRequest(prNumber, authority.remoteHead);
  if (pullRequest.head !== authority.remoteHead || !pullRequest.draft) {
    throw new Error('Human hold projection did not converge on a draft PR');
  }
  return { status: 'human', head: authority.remoteHead };
}

export function makeImplementationSessionProtocol(
  port: ImplementationSessionPort,
): ImplementationSessionProtocol {
  return {
    checkpoint: (manifest) => checkpoint(manifest, port),
    implementationComplete: (manifest, summary) =>
      implementationComplete(manifest, summary, port),
    reviewVerdict: async () => notWired('review-verdict'),
    reviewFixPublish: async () => notWired('review-fix-publish'),
    mergePrepComplete: async () => notWired('merge-prep-complete'),
    human: (manifest, reason) => human(manifest, reason, port),
  };
}

export function implementationSessionErrorDetail(error: unknown): string {
  return message(error);
}

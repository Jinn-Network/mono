import type { AttemptManifest } from './attempt-workspace.js';
import { formatHumanCommentMarker } from './codecs.js';
import type {
  BranchClaim,
  GitOid,
  HumanReason,
  PublicationOutcome,
} from './types.js';

export interface MergePrepSessionPullRequest {
  readonly number: number;
  readonly issueNumber: number;
  readonly head: GitOid;
  readonly headRefName: string;
  readonly baseRefName: string;
  readonly draft: boolean;
  readonly labels: readonly string[];
  readonly body: string;
  readonly humanHold: boolean;
  readonly codeownerSensitive: boolean;
  readonly changedFilesComplete: boolean;
}

export interface MergePrepAuthority {
  readonly remoteHead: GitOid;
  readonly latestClaimOid: GitOid;
  readonly latestClaim: BranchClaim;
  readonly targetBaseOid: GitOid;
  readonly pullRequest: MergePrepSessionPullRequest;
}

export interface MergePrepSessionPort {
  readManifest(path: string): AttemptManifest;
  readAuthority(manifest: AttemptManifest): Promise<MergePrepAuthority>;
  readLocalHead(manifest: AttemptManifest): Promise<GitOid>;
  readLocalStatusClean(manifest: AttemptManifest): Promise<boolean>;
  classifyPreparedResult(
    manifest: AttemptManifest,
  ): Promise<'mechanical' | 'semantic' | 'codeowner' | 'unproven'>;
  isAncestor(manifest: AttemptManifest, ancestor: GitOid, descendant: GitOid): Promise<boolean>;
  treesDiffer(manifest: AttemptManifest, left: GitOid, right: GitOid): Promise<boolean>;
  readBranchClaim(manifest: AttemptManifest, oid: GitOid): Promise<BranchClaim | null>;
  readCompletionSummary(manifest: AttemptManifest, oid: GitOid): Promise<string | null>;
  createCompletionCommit(input: {
    readonly manifest: AttemptManifest;
    readonly preparedHead: GitOid;
    readonly completionClaim: BranchClaim & {
      readonly phase: 'merge-prep';
      readonly phaseComplete: true;
    };
    readonly summary: string;
  }): Promise<GitOid>;
  publishPrepared(input: {
    readonly manifest: AttemptManifest;
    readonly expectedRemoteHead: GitOid;
    readonly newHead: GitOid;
  }): Promise<PublicationOutcome>;
  advanceManifestHead(path: string, expectedHead: GitOid, nextHead: GitOid): AttemptManifest;
  ensureCompletionSummary(prNumber: number, expectedHead: GitOid, summary: string): Promise<void>;
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
  setPullRequestDraft(prNumber: number, expectedHead: GitOid, draft: boolean): Promise<void>;
  hasHumanComment(prNumber: number, expectedHead: GitOid, marker: string): Promise<boolean>;
  ensureHumanComment(
    prNumber: number,
    expectedHead: GitOid,
    marker: string,
    body: string,
  ): Promise<void>;
}

export type MergePrepCompleteResult =
  | { readonly status: 'complete'; readonly head: GitOid }
  | {
      readonly status: 'partial';
      readonly head: GitOid;
      readonly pending:
        | 'authority'
        | 'cleanliness'
        | 'classification'
        | 'prepared-result'
        | 'publication'
        | 'projection'
        | 'ready';
    };

export interface MergePrepSessionProtocol {
  mergePrepComplete(
    manifest: AttemptManifest,
    summary: string,
  ): Promise<MergePrepCompleteResult>;
  human(
    manifest: AttemptManifest,
    reason: string,
  ): Promise<{ readonly status: 'human'; readonly head: GitOid }>;
}

function requireManifest(
  supplied: AttemptManifest,
  port: MergePrepSessionPort,
): AttemptManifest {
  const fresh = port.readManifest(supplied.paths.manifest);
  if (
    fresh.phase !== 'merge-prep'
    || fresh.attemptId !== supplied.attemptId
    || fresh.issueNumber !== supplied.issueNumber
    || fresh.prNumber !== supplied.prNumber
    || fresh.paths.manifest !== supplied.paths.manifest
    || fresh.paths.worktree !== supplied.paths.worktree
    || fresh.targetBaseOid === undefined
  ) {
    throw new Error('Merge-prep session manifest authority changed or is invalid');
  }
  return fresh;
}

function exactClaim(
  manifest: AttemptManifest,
  claim: BranchClaim,
  phaseComplete: boolean,
): claim is BranchClaim & {
  readonly phase: 'merge-prep';
  readonly targetBaseOid: GitOid;
} {
  return claim.phase === 'merge-prep'
    && (claim.phaseComplete === true) === phaseComplete
    && claim.issueNumber === manifest.issueNumber
    && claim.prNumber === manifest.prNumber
    && claim.attempt === manifest.attemptId
    && claim.runner === manifest.runnerId
    && claim.login.toLowerCase() === manifest.selectedLogin.toLowerCase()
    && claim.expectedHead !== undefined
    && claim.targetBase === manifest.targetBase
    && claim.targetBaseOid === manifest.targetBaseOid;
}

function validPullRequest(
  manifest: AttemptManifest,
  authority: MergePrepAuthority,
): boolean {
  const pr = authority.pullRequest;
  return pr.number === manifest.prNumber
    && pr.issueNumber === manifest.issueNumber
    && pr.head === authority.remoteHead
    && pr.headRefName === manifest.branch
    && pr.baseRefName === manifest.targetBase
    && pr.body.includes(
      `<!-- jinn-autopilot:v2 issue=${manifest.issueNumber} branch=${manifest.branch} -->`,
    )
    && pr.changedFilesComplete
    && !pr.codeownerSensitive;
}

async function currentAuthority(
  manifest: AttemptManifest,
  port: MergePrepSessionPort,
): Promise<MergePrepAuthority | null> {
  const authority = await port.readAuthority(manifest);
  if (
    authority.targetBaseOid !== manifest.targetBaseOid
    || !validPullRequest(manifest, authority)
    || authority.pullRequest.humanHold
    || !exactClaim(
      manifest,
      authority.latestClaim,
      authority.latestClaim.phaseComplete === true,
    )
  ) {
    return null;
  }
  return authority;
}

function completionClaim(
  original: BranchClaim & {
    readonly phase: 'merge-prep';
    readonly targetBaseOid: GitOid;
  },
): BranchClaim & {
  readonly phase: 'merge-prep';
  readonly targetBaseOid: GitOid;
  readonly phaseComplete: true;
} {
  return {
    ...original,
    claimedAt: new Date().toISOString(),
    phaseComplete: true,
  };
}

async function projectComplete(
  manifest: AttemptManifest,
  head: GitOid,
  summary: string,
  port: MergePrepSessionPort,
): Promise<MergePrepCompleteResult> {
  let authority = await currentAuthority(manifest, port);
  if (
    authority === null
    || authority.remoteHead !== head
    || authority.latestClaimOid !== head
    || !authority.pullRequest.draft
  ) {
    return { status: 'partial', head, pending: 'authority' };
  }
  try {
    await port.ensureCompletionSummary(manifest.prNumber!, head, summary);
    if (!authority.pullRequest.labels.includes('engine:review')) {
      await port.setPullRequestLabel(manifest.prNumber!, head, 'engine:review', true);
    }
    await port.setProjectStatus(manifest.issueNumber, head, 'In Review');
  } catch {
    return { status: 'partial', head, pending: 'projection' };
  }
  authority = await currentAuthority(manifest, port);
  if (
    authority === null
    || authority.remoteHead !== head
    || authority.latestClaimOid !== head
    || !authority.pullRequest.draft
  ) {
    return { status: 'partial', head, pending: 'ready' };
  }
  try {
    await port.setPullRequestDraft(manifest.prNumber!, head, false);
  } catch {
    return { status: 'partial', head, pending: 'ready' };
  }
  return { status: 'complete', head };
}

async function mergePrepComplete(
  supplied: AttemptManifest,
  summary: string,
  port: MergePrepSessionPort,
): Promise<MergePrepCompleteResult> {
  let manifest = requireManifest(supplied, port);
  let authority = await currentAuthority(manifest, port);
  if (authority === null) {
    return {
      status: 'partial',
      head: manifest.expectedHead as GitOid,
      pending: 'authority',
    };
  }
  const localHead = await port.readLocalHead(manifest);
  if (authority.latestClaim.phaseComplete === true) {
    if (
      authority.remoteHead !== authority.latestClaimOid
      || localHead !== authority.remoteHead
    ) {
      return { status: 'partial', head: authority.remoteHead, pending: 'authority' };
    }
    const durable = await port.readCompletionSummary(manifest, authority.remoteHead);
    if (durable === null || durable.trim() !== summary.trim()) {
      return { status: 'partial', head: authority.remoteHead, pending: 'authority' };
    }
    if (manifest.expectedHead !== authority.remoteHead) {
      manifest = port.advanceManifestHead(
        manifest.paths.manifest,
        manifest.expectedHead as GitOid,
        authority.remoteHead,
      );
    }
    return projectComplete(manifest, authority.remoteHead, durable, port);
  }
  if (
    authority.remoteHead !== manifest.claimOid
    || authority.latestClaimOid !== manifest.claimOid
    || !exactClaim(manifest, authority.latestClaim, false)
  ) {
    return { status: 'partial', head: authority.remoteHead, pending: 'authority' };
  }
  if (!await port.readLocalStatusClean(manifest)) {
    return { status: 'partial', head: localHead, pending: 'cleanliness' };
  }
  const classification = await port.classifyPreparedResult(manifest);
  if (classification !== 'mechanical') {
    return { status: 'partial', head: localHead, pending: 'classification' };
  }
  if (
    localHead === manifest.claimOid
    || !await port.isAncestor(manifest, manifest.targetBaseOid as GitOid, localHead)
    || !await port.treesDiffer(manifest, authority.latestClaim.expectedHead, localHead)
  ) {
    return { status: 'partial', head: localHead, pending: 'prepared-result' };
  }
  const marker = await port.createCompletionCommit({
    manifest,
    preparedHead: localHead,
    completionClaim: completionClaim(authority.latestClaim),
    summary,
  });
  const outcome = await port.publishPrepared({
    manifest,
    expectedRemoteHead: manifest.claimOid as GitOid,
    newHead: marker,
  });
  if (
    (outcome.status !== 'won' && outcome.status !== 'already-applied')
    || outcome.observed !== marker
  ) {
    return { status: 'partial', head: marker, pending: 'publication' };
  }
  manifest = port.advanceManifestHead(
    manifest.paths.manifest,
    manifest.expectedHead as GitOid,
    marker,
  );
  return projectComplete(manifest, marker, summary, port);
}

async function human(
  supplied: AttemptManifest,
  detail: string,
  port: MergePrepSessionPort,
): Promise<{ readonly status: 'human'; readonly head: GitOid }> {
  const manifest = requireManifest(supplied, port);
  let authority = await currentAuthority(manifest, port);
  if (
    authority === null
    || authority.latestClaim.phaseComplete === true
    || authority.remoteHead !== manifest.claimOid
  ) {
    throw new Error('Merge-prep attempt no longer owns exact Human authority');
  }
  const head = authority.remoteHead;
  if (!authority.pullRequest.draft) {
    await port.setPullRequestDraft(manifest.prNumber!, head, true);
  }
  const reason: HumanReason = {
    phase: 'merge-prep',
    code: authority.pullRequest.codeownerSensitive
      ? 'codeowner-sensitive-conflict'
      : 'semantic-conflict',
    detail,
  };
  const marker = formatHumanCommentMarker({
    issueNumber: manifest.issueNumber,
    prNumber: manifest.prNumber!,
    reason,
  });
  authority = await port.readAuthority(manifest);
  if (authority.remoteHead !== head) {
    throw new Error('Merge-prep Human authority changed');
  }
  if (!authority.pullRequest.labels.includes('review:needs-human')) {
    await port.setPullRequestLabel(
      manifest.prNumber!,
      head,
      'review:needs-human',
      true,
    );
  }
  if (!await port.hasHumanComment(manifest.prNumber!, head, marker)) {
    await port.ensureHumanComment(
      manifest.prNumber!,
      head,
      marker,
      `${marker}\n\nAutopilot parked merge preparation for Human review.\n\n${detail}`,
    );
  }
  await port.setProjectStatus(manifest.issueNumber, head, 'Human');
  return { status: 'human', head };
}

export function makeMergePrepSessionProtocol(
  port: MergePrepSessionPort,
): MergePrepSessionProtocol {
  return {
    mergePrepComplete: (manifest, summary) =>
      mergePrepComplete(manifest, summary, port),
    human: (manifest, reason) => human(manifest, reason, port),
  };
}

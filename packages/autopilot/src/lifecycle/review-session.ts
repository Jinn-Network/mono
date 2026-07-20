import type { AttemptManifest } from './attempt-workspace.js';
import {
  formatAutomatedReviewMarker,
  formatHumanCommentMarker,
  parseAutomatedReviewMarker,
} from './codecs.js';
import type { ReviewNativeReview } from './review-executor.js';
import type {
  GitOid,
  HumanReason,
  PublicationOutcome,
  ReviewClaimRecord,
  ReviewVerdict,
  ReviewVerdictState,
} from './types.js';

export interface ReviewSessionAuthority {
  readonly reviewRefOid: GitOid;
  readonly record: ReviewClaimRecord;
}

export interface ReviewSessionPullRequest {
  readonly number: number;
  readonly issueNumber: number;
  readonly open: boolean;
  readonly head: GitOid;
  readonly headRefName: string;
  readonly baseRefName: string;
  readonly draft: boolean;
  readonly author: string;
  readonly labels: readonly string[];
  readonly body: string;
  readonly approvalPolicy: 'approve-eligible' | 'human-codeowner';
  readonly mappingProblem?: string;
}

export interface ReviewSessionPort {
  readManifest(path: string): AttemptManifest;
  readAuthority(manifest: AttemptManifest): Promise<ReviewSessionAuthority>;
  readPullRequest(
    prNumber: number,
    expectedHead: GitOid,
  ): Promise<ReviewSessionPullRequest>;
  readNativeReviews(
    prNumber: number,
    expectedHead: GitOid,
  ): Promise<readonly ReviewNativeReview[]>;
  hasHumanHold(
    issueNumber: number,
    prNumber: number,
    expectedHead: GitOid,
  ): Promise<boolean>;
  createReviewRecord(input: {
    readonly manifest: AttemptManifest;
    readonly parent: GitOid;
    readonly record: ReviewClaimRecord;
  }): Promise<GitOid>;
  publishReviewClaim(input: {
    readonly manifest: AttemptManifest;
    readonly recordParent: GitOid;
    readonly expectedRemoteRecordOid: GitOid;
    readonly recordOid: GitOid;
    readonly record: ReviewClaimRecord;
  }): Promise<PublicationOutcome>;
  submitNativeReview(input: {
    readonly manifest: AttemptManifest;
    readonly prNumber: number;
    readonly commitId: GitOid;
    readonly reviewer: string;
    readonly state: ReviewVerdictState;
    readonly body: string;
  }): Promise<void>;
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
  setPullRequestDraft(
    prNumber: number,
    expectedHead: GitOid,
    draft: boolean,
  ): Promise<void>;
  readLocalFix(manifest: AttemptManifest): Promise<{
    readonly head: GitOid;
    readonly clean: boolean;
    readonly parentMatches: boolean;
    readonly treeChanged: boolean;
  }>;
  publishReviewFix(input: {
    readonly manifest: AttemptManifest;
    readonly expectedRemoteHead: GitOid;
    readonly newHead: GitOid;
    readonly expectedRemoteRecordOid: GitOid;
    readonly recordOid: GitOid;
    readonly record: ReviewClaimRecord;
  }): Promise<PublicationOutcome>;
  advanceManifestPair(
    path: string,
    expectedHead: GitOid,
    expectedReviewRefOid: GitOid,
    nextHead: GitOid,
    nextReviewRefOid: GitOid,
  ): AttemptManifest;
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
  nextMarker(): string;
  now(): Date;
}

export type ReviewVerdictResult =
  | { readonly status: 'fixing'; readonly head: GitOid }
  | { readonly status: 'approved'; readonly head: GitOid }
  | { readonly status: 'human'; readonly head: GitOid }
  | { readonly status: 'stale' | 'ambiguous'; readonly head: GitOid };

export type ReviewFixPublishResult =
  | {
      readonly status: 'published' | 'already-applied';
      readonly head: GitOid;
      readonly reviewRefOid: GitOid;
    }
  | { readonly status: 'human'; readonly head: GitOid }
  | { readonly status: 'stale' | 'ambiguous'; readonly head: GitOid };

export interface ReviewSessionProtocol {
  reviewVerdict(
    manifest: AttemptManifest,
    state: ReviewVerdictState,
    body: string,
  ): Promise<ReviewVerdictResult>;
  reviewFixPublish(manifest: AttemptManifest): Promise<ReviewFixPublishResult>;
  human(
    manifest: AttemptManifest,
    reason: string,
  ): Promise<{ readonly status: 'human'; readonly head: GitOid }>;
}

function requireReviewManifest(
  supplied: AttemptManifest,
  port: ReviewSessionPort,
): AttemptManifest {
  const fresh = port.readManifest(supplied.paths.manifest);
  if (
    fresh.phase !== 'review'
    || fresh.attemptId !== supplied.attemptId
    || fresh.paths.manifest !== supplied.paths.manifest
    || fresh.paths.worktree !== supplied.paths.worktree
    || fresh.prNumber === undefined
    || fresh.reviewGeneration === undefined
    || fresh.reviewRefOid === undefined
    || fresh.reviewApprovalPolicy === undefined
  ) {
    throw new Error('Review session manifest authority changed or is invalid');
  }
  return fresh;
}

async function requireAuthority(
  manifest: AttemptManifest,
  port: ReviewSessionPort,
): Promise<ReviewSessionAuthority> {
  const authority = await port.readAuthority(manifest);
  if (!authorityMatchesManifest(authority, manifest)) {
    throw new Error('Review attempt no longer owns the exact review authority');
  }
  return authority;
}

function authorityMatchesManifest(
  authority: ReviewSessionAuthority,
  manifest: AttemptManifest,
): boolean {
  const record = authority.record;
  return authority.reviewRefOid === manifest.reviewRefOid
    && record.prNumber === manifest.prNumber
    && record.generation === manifest.reviewGeneration
    && record.attempt === manifest.attemptId
    && record.reviewer.toLowerCase() === manifest.selectedLogin.toLowerCase()
    && record.head === manifest.expectedHead;
}

function pullRequestAuthorityProblem(
  manifest: AttemptManifest,
  pullRequest: ReviewSessionPullRequest,
): string | undefined {
  const marker =
    `<!-- jinn-autopilot:v2 issue=${manifest.issueNumber} branch=${manifest.branch} -->`;
  if (!pullRequest.open) return 'The review pull request is no longer open.';
  if (pullRequest.mappingProblem !== undefined) return pullRequest.mappingProblem;
  if (
    pullRequest.issueNumber !== manifest.issueNumber
    || pullRequest.headRefName !== manifest.branch
    || pullRequest.baseRefName !== manifest.targetBase
    || !pullRequest.body.includes(marker)
  ) {
    return 'The unique PR, issue, branch, base, or lifecycle-marker mapping changed.';
  }
  if (pullRequest.approvalPolicy !== manifest.reviewApprovalPolicy) {
    return 'The current-head CODEOWNER approval policy changed.';
  }
  return undefined;
}

async function readExactPullRequest(
  manifest: AttemptManifest,
  port: ReviewSessionPort,
): Promise<ReviewSessionPullRequest> {
  const head = manifest.expectedHead as GitOid;
  const pullRequest = await port.readPullRequest(manifest.prNumber!, head);
  if (
    pullRequest.number !== manifest.prNumber
    || pullRequest.head !== head
    || pullRequest.author.toLowerCase() === manifest.selectedLogin.toLowerCase()
  ) {
    throw new Error('Review pull request authority changed or is invalid');
  }
  return pullRequest;
}

async function requirePullRequest(
  manifest: AttemptManifest,
  port: ReviewSessionPort,
): Promise<ReviewSessionPullRequest> {
  const pullRequest = await readExactPullRequest(manifest, port);
  if (pullRequestAuthorityProblem(manifest, pullRequest) !== undefined) {
    throw new Error('Review pull request authority changed or is invalid');
  }
  return pullRequest;
}

function nextRecord(
  manifest: AttemptManifest,
  state: ReviewClaimRecord['state'],
  now: Date,
  verdict?: { readonly state: ReviewVerdictState; readonly marker: string },
): ReviewClaimRecord {
  const common = {
    kind: 'review-claim' as const,
    protocolVersion: 2 as const,
    prNumber: manifest.prNumber!,
    generation: manifest.reviewGeneration!,
    attempt: manifest.attemptId,
    reviewer: manifest.selectedLogin,
    head: manifest.expectedHead as GitOid,
    recordedAt: now.toISOString(),
  };
  if (state === 'verdict-intent') {
    if (verdict === undefined) throw new Error('Verdict intent requires verdict metadata');
    return { ...common, state, verdict };
  }
  if (state === 'terminal-approved') {
    if (verdict?.state !== 'APPROVE') {
      throw new Error('Terminal approval requires approval metadata');
    }
    return { ...common, state, verdict: { ...verdict, state: 'APPROVE' } };
  }
  return { ...common, state };
}

async function publishRecord(
  manifest: AttemptManifest,
  authority: ReviewSessionAuthority,
  record: ReviewClaimRecord,
  port: ReviewSessionPort,
): Promise<{ readonly status: 'published'; readonly oid: GitOid } | {
  readonly status: 'stale' | 'ambiguous';
}> {
  const oid = await port.createReviewRecord({
    manifest,
    parent: authority.reviewRefOid,
    record,
  });
  const outcome = await port.publishReviewClaim({
    manifest,
    recordParent: authority.reviewRefOid,
    expectedRemoteRecordOid: authority.reviewRefOid,
    recordOid: oid,
    record,
  });
  if (outcome.status === 'lost') return { status: 'stale' };
  if (
    outcome.status === 'ambiguous'
    || !('observed' in outcome)
    || outcome.published !== oid
    || outcome.observed !== oid
  ) {
    return { status: 'ambiguous' };
  }
  return { status: 'published', oid };
}

function nativeState(state: ReviewVerdictState): ReviewNativeReview['state'] {
  return state === 'APPROVE' ? 'APPROVED' : 'CHANGES_REQUESTED';
}

function canonicalMarker(
  manifest: AttemptManifest,
  verdict: ReviewVerdict,
): string {
  return formatAutomatedReviewMarker({
    generation: manifest.reviewGeneration!,
    attempt: manifest.attemptId,
    intent: verdict.marker,
    reviewer: manifest.selectedLogin,
    head: manifest.expectedHead as GitOid,
    verdict: verdict.state,
  });
}

async function matchingNativeReview(
  manifest: AttemptManifest,
  verdict: ReviewVerdict,
  port: ReviewSessionPort,
): Promise<ReviewNativeReview | undefined> {
  const marker = canonicalMarker(manifest, verdict);
  return (await port.readNativeReviews(
    manifest.prNumber!,
    manifest.expectedHead as GitOid,
  )).find((review) => (
    review.reviewer.toLowerCase() === manifest.selectedLogin.toLowerCase()
    && review.commitId === manifest.expectedHead
    && review.state === nativeState(verdict.state)
    && review.body.includes(marker)
  ));
}

async function humanIsActive(
  manifest: AttemptManifest,
  port: ReviewSessionPort,
): Promise<boolean> {
  return port.hasHumanHold(
    manifest.issueNumber,
    manifest.prNumber!,
    manifest.expectedHead as GitOid,
  );
}

async function enterHuman(
  supplied: AttemptManifest,
  detail: string,
  port: ReviewSessionPort,
  observedPullRequest?: ReviewSessionPullRequest,
): Promise<{ readonly status: 'human'; readonly head: GitOid }> {
  let manifest = requireReviewManifest(supplied, port);
  let authority = await requireAuthority(manifest, port);
  const head = manifest.expectedHead as GitOid;
  const reason: HumanReason = {
    phase: authority.record.state === 'fixing' ? 'review-fixing' : 'reviewing',
    code: 'review-escalation',
    detail,
  };
  if (authority.record.state !== 'human') {
    const humanRecord = nextRecord(manifest, 'human', port.now());
    const published = await publishRecord(manifest, authority, humanRecord, port);
    if (published.status !== 'published') {
      throw new Error('Human review record did not win exact-parent authority');
    }
    manifest = requireReviewManifest(manifest, port);
    authority = await requireAuthority(manifest, port);
  }
  const marker = formatHumanCommentMarker({
    issueNumber: manifest.issueNumber,
    prNumber: manifest.prNumber!,
    reason,
  });
  const pullRequest = observedPullRequest ?? await readExactPullRequest(manifest, port);
  if (pullRequest.open && !pullRequest.draft) {
    await port.setPullRequestDraft(manifest.prNumber!, head, true);
  }
  if (!pullRequest.labels.includes('engine:review')) {
    await port.setPullRequestLabel(manifest.prNumber!, head, 'engine:review', true);
  }
  if (!pullRequest.labels.includes('review:needs-human')) {
    await port.setPullRequestLabel(manifest.prNumber!, head, 'review:needs-human', true);
  }
  if (!await port.hasHumanComment(manifest.prNumber!, head, marker)) {
    await port.ensureHumanComment(
      manifest.prNumber!,
      head,
      marker,
      `${marker}\n\nAutopilot parked this review for Human judgment.\n\n${detail}`,
    );
  }
  if (pullRequest.issueNumber === manifest.issueNumber) {
    await port.setProjectStatus(manifest.issueNumber, head, 'Human');
  }
  return { status: 'human', head };
}

function effectiveNativeReviews(
  reviews: readonly ReviewNativeReview[],
): readonly ReviewNativeReview[] {
  const latest = new Map<string, ReviewNativeReview>();
  for (const review of [...reviews].sort((left, right) =>
    left.submittedAt.localeCompare(right.submittedAt))) {
    if (
      !['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)
    ) {
      continue;
    }
    latest.set(review.reviewer.toLowerCase(), review);
  }
  return [...latest.values()];
}

async function requireNoNativeChangeRequests(
  manifest: AttemptManifest,
  port: ReviewSessionPort,
  allowOwnedPriorRequest = false,
): Promise<void> {
  const head = manifest.expectedHead as GitOid;
  const blocking = effectiveNativeReviews(
    await port.readNativeReviews(manifest.prNumber!, head),
  ).find((review) => {
    if (review.state !== 'CHANGES_REQUESTED') return false;
    if (
      allowOwnedPriorRequest
      && review.commitId !== head
      && review.reviewer.toLowerCase() === manifest.selectedLogin.toLowerCase()
    ) {
      const markerText = review.body.match(/<!-- jinn-autopilot-review:v2\b[^>]* -->/)?.[0];
      if (markerText !== undefined) {
        try {
          const marker = parseAutomatedReviewMarker(markerText);
          if (
            marker.generation === manifest.reviewGeneration
            && marker.attempt === manifest.attemptId
            && marker.reviewer.toLowerCase() === manifest.selectedLogin.toLowerCase()
            && marker.head === review.commitId
            && marker.verdict === 'REQUEST_CHANGES'
          ) {
            return false;
          }
        } catch {
          // A malformed or copied marker never exempts a native blocker.
        }
      }
    }
    return true;
  });
  if (blocking !== undefined) {
    throw new Error(
      `Native requested changes by ${blocking.reviewer} block automated approval`,
    );
  }
}

async function reconcileFixingProjection(
  manifest: AttemptManifest,
  pullRequest: ReviewSessionPullRequest,
  port: ReviewSessionPort,
): Promise<ReviewVerdictResult> {
  const head = manifest.expectedHead as GitOid;
  if (!pullRequest.labels.includes('review:changes-requested')) {
    await port.setPullRequestLabel(
      manifest.prNumber!,
      head,
      'review:changes-requested',
      true,
    );
  }
  if (pullRequest.labels.includes('review:approved')) {
    if (await humanIsActive(manifest, port)) return { status: 'human', head };
    await port.setPullRequestLabel(manifest.prNumber!, head, 'review:approved', false);
  }
  if (!pullRequest.draft) {
    await port.setPullRequestDraft(manifest.prNumber!, head, true);
  }
  return { status: 'fixing', head };
}

async function reviewVerdict(
  supplied: AttemptManifest,
  state: ReviewVerdictState,
  body: string,
  port: ReviewSessionPort,
): Promise<ReviewVerdictResult> {
  let manifest = requireReviewManifest(supplied, port);
  let authority = await requireAuthority(manifest, port);
  let pullRequest = await readExactPullRequest(manifest, port);
  const head = manifest.expectedHead as GitOid;
  const authorityProblem = pullRequestAuthorityProblem(manifest, pullRequest);
  if (authorityProblem !== undefined) {
    return enterHuman(manifest, authorityProblem, port, pullRequest);
  }
  if (await humanIsActive(manifest, port)) return { status: 'human', head };
  if (state === 'APPROVE' && manifest.reviewApprovalPolicy === 'human-codeowner') {
    return enterHuman(manifest, 'Human CODEOWNER approval is required.', port);
  }
  if (state === 'APPROVE') {
    await requireNoNativeChangeRequests(manifest, port, true);
  }

  let intent: Extract<ReviewClaimRecord, { readonly state: 'verdict-intent' }>;
  if (authority.record.state === 'verdict-intent') {
    if (authority.record.verdict.state !== state) {
      throw new Error('Review verdict retry contradicts the current intent');
    }
    intent = authority.record;
  } else if (
    authority.record.state === 'fixing'
    && state === 'REQUEST_CHANGES'
  ) {
    return reconcileFixingProjection(manifest, pullRequest, port);
  } else if (
    authority.record.state === 'terminal-approved'
    && state === 'APPROVE'
  ) {
    intent = {
      ...authority.record,
      state: 'verdict-intent',
    };
  } else if (authority.record.state === 'active') {
    intent = nextRecord(
      manifest,
      'verdict-intent',
      port.now(),
      { state, marker: port.nextMarker() },
    ) as Extract<ReviewClaimRecord, { readonly state: 'verdict-intent' }>;
    const published = await publishRecord(manifest, authority, intent, port);
    if (published.status !== 'published') return { status: published.status, head };
    manifest = requireReviewManifest(manifest, port);
    authority = await requireAuthority(manifest, port);
  } else {
    throw new Error(`Review verdict is invalid from ${authority.record.state} authority`);
  }

  let confirmed = await matchingNativeReview(manifest, intent.verdict, port);
  if (confirmed === undefined) {
    const marker = canonicalMarker(manifest, intent.verdict);
    let submissionError: unknown;
    try {
      await port.submitNativeReview({
        manifest,
        prNumber: manifest.prNumber!,
        commitId: head,
        reviewer: manifest.selectedLogin,
        state,
        body: `${body.trim()}\n\n${marker}`,
      });
    } catch (error) {
      submissionError = error;
    }
    confirmed = await matchingNativeReview(manifest, intent.verdict, port);
    if (confirmed === undefined && submissionError !== undefined) {
      throw submissionError;
    }
  }
  if (confirmed === undefined) {
    return { status: 'ambiguous', head };
  }

  if (state === 'REQUEST_CHANGES') {
    if (authority.record.state !== 'fixing') {
      const fixing = nextRecord(manifest, 'fixing', port.now());
      const published = await publishRecord(manifest, authority, fixing, port);
      if (published.status !== 'published') return { status: published.status, head };
      manifest = requireReviewManifest(manifest, port);
      authority = await requireAuthority(manifest, port);
    }
    pullRequest = await requirePullRequest(manifest, port);
    return reconcileFixingProjection(manifest, pullRequest, port);
  }

  await requireNoNativeChangeRequests(manifest, port);
  if (authority.record.state !== 'terminal-approved') {
    await requireNoNativeChangeRequests(manifest, port);
    const terminal = nextRecord(
      manifest,
      'terminal-approved',
      port.now(),
      intent.verdict,
    );
    const published = await publishRecord(manifest, authority, terminal, port);
    if (published.status !== 'published') return { status: published.status, head };
    manifest = requireReviewManifest(manifest, port);
    authority = await requireAuthority(manifest, port);
  }
  pullRequest = await requirePullRequest(manifest, port);
  if (!pullRequest.labels.includes('review:approved')) {
    await port.setPullRequestLabel(manifest.prNumber!, head, 'review:approved', true);
  }
  if (pullRequest.labels.includes('review:changes-requested')) {
    if (await humanIsActive(manifest, port)) return { status: 'human', head };
    await port.setPullRequestLabel(
      manifest.prNumber!,
      head,
      'review:changes-requested',
      false,
    );
  }
  if (await humanIsActive(manifest, port)) return { status: 'human', head };
  await port.setProjectStatus(manifest.issueNumber, head, 'In Review');
  if (await humanIsActive(manifest, port)) return { status: 'human', head };
  await requireNoNativeChangeRequests(manifest, port);
  pullRequest = await requirePullRequest(manifest, port);
  if (pullRequest.draft) {
    await port.setPullRequestDraft(manifest.prNumber!, head, false);
  }
  return { status: 'approved', head };
}

async function reviewFixPublish(
  supplied: AttemptManifest,
  port: ReviewSessionPort,
): Promise<ReviewFixPublishResult> {
  const manifest = requireReviewManifest(supplied, port);
  const head = manifest.expectedHead as GitOid;
  const authority = await port.readAuthority(manifest);
  if (!authorityMatchesManifest(authority, manifest)) {
    const record = authority.record;
    const recoveredHead = record.head;
    const isPublishedPair = (
      authority.reviewRefOid !== manifest.reviewRefOid
      && recoveredHead !== head
      && record.state === 'active'
      && record.prNumber === manifest.prNumber
      && record.generation === manifest.reviewGeneration
      && record.attempt === manifest.attemptId
      && record.reviewer.toLowerCase() === manifest.selectedLogin.toLowerCase()
    );
    if (!isPublishedPair) {
      throw new Error('Review attempt no longer owns the exact review authority');
    }
    const progressed = {
      ...manifest,
      expectedHead: recoveredHead,
      reviewRefOid: authority.reviewRefOid,
    };
    const pullRequest = await requirePullRequest(progressed, port);
    if (!pullRequest.draft) {
      throw new Error('Recovered review fix authority requires a draft PR');
    }
    if (await humanIsActive(progressed, port)) {
      throw new Error('Review fix recovery stopped because a Human hold is active');
    }
    const local = await port.readLocalFix(manifest);
    if (
      !local.clean
      || !local.parentMatches
      || !local.treeChanged
      || local.head !== recoveredHead
    ) {
      throw new Error('Published review fix pair does not match preserved local work');
    }
    port.advanceManifestPair(
      manifest.paths.manifest,
      head,
      manifest.reviewRefOid as GitOid,
      recoveredHead,
      authority.reviewRefOid,
    );
    return {
      status: 'already-applied',
      head: recoveredHead,
      reviewRefOid: authority.reviewRefOid,
    };
  }
  if (authority.record.state !== 'fixing') {
    throw new Error('Review fix publication requires exact fixing authority');
  }
  const pullRequest = await readExactPullRequest(manifest, port);
  const authorityProblem = pullRequestAuthorityProblem(manifest, pullRequest);
  if (authorityProblem !== undefined) {
    return enterHuman(manifest, authorityProblem, port, pullRequest);
  }
  if (!pullRequest.draft) throw new Error('Review fixes require a draft PR');
  if (await humanIsActive(manifest, port)) {
    throw new Error('Review fix publication stopped because a Human hold is active');
  }
  const local = await port.readLocalFix(manifest);
  if (!local.clean) {
    throw new Error('Review fix worktree is not clean; preserve local work');
  }
  if (!local.parentMatches) {
    throw new Error('Review fix HEAD is not rooted at the exact old head');
  }
  if (!local.treeChanged || local.head === head) {
    throw new Error('Review fix must contain a genuinely new tree');
  }
  const active = {
    ...nextRecord(manifest, 'active', port.now()),
    head: local.head,
  } as ReviewClaimRecord;
  const recordOid = await port.createReviewRecord({
    manifest,
    parent: authority.reviewRefOid,
    record: active,
  });
  const outcome = await port.publishReviewFix({
    manifest,
    expectedRemoteHead: head,
    newHead: local.head,
    expectedRemoteRecordOid: authority.reviewRefOid,
    recordOid,
    record: active,
  });
  if (outcome.status === 'lost') return { status: 'stale', head };
  if (outcome.status === 'ambiguous' || !('observed' in outcome)) {
    return { status: 'ambiguous', head };
  }
  const observed = outcome.observed;
  if (
    typeof observed !== 'object'
    || observed === null
    || observed.branch !== local.head
    || observed.review !== recordOid
  ) {
    return { status: 'stale', head };
  }
  port.advanceManifestPair(
    manifest.paths.manifest,
    head,
    authority.reviewRefOid,
    local.head,
    recordOid,
  );
  return {
    status: outcome.status === 'already-applied' ? 'already-applied' : 'published',
    head: local.head,
    reviewRefOid: recordOid,
  };
}

export function makeReviewSessionProtocol(
  port: ReviewSessionPort,
): ReviewSessionProtocol {
  return {
    reviewVerdict: (manifest, state, body) =>
      reviewVerdict(manifest, state, body, port),
    reviewFixPublish: (manifest) => reviewFixPublish(manifest, port),
    human: (manifest, reason) => enterHuman(manifest, reason, port),
  };
}

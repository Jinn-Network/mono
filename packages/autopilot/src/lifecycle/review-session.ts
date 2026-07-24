import type { AttemptManifest } from './attempt-workspace.js';
import {
  formatAutomatedReviewMarker,
  formatHumanCommentMarker,
  parseAutomatedReviewMarker,
} from './codecs.js';
import type {
  FiledReviewFollowUp,
  ReviewFollowUpEntry,
} from './review-follow-ups.js';
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
  setPullRequestDraft(
    prNumber: number,
    expectedHead: GitOid,
    draft: boolean,
  ): Promise<void>;
  hasHumanComment(
    prNumber: number,
    expectedHead: GitOid,
    body: string,
  ): Promise<boolean>;
  ensureHumanComment(
    prNumber: number,
    expectedHead: GitOid,
    marker: string,
    body: string,
  ): Promise<void>;
  fileFindingChild?(input: {
    readonly parentPr: number;
    readonly title: string;
    readonly body: string;
    readonly effort: 'low' | 'medium' | 'high';
  }): Promise<
    | { readonly number: number; readonly created: boolean; readonly runawayHold?: undefined }
    | { readonly runawayHold: true; readonly priorCount: number }
  >;
  fileReviewFollowUps?(input: {
    readonly parentPr: number;
    readonly head: GitOid;
    readonly entries: readonly ReviewFollowUpEntry[];
  }): Promise<readonly FiledReviewFollowUp[]>;
  nextMarker(): string;
  now(): Date;
}

export type ReviewVerdictResult =
  | { readonly status: 'requested-changes'; readonly head: GitOid }
  | {
      readonly status: 'approved';
      readonly head: GitOid;
      readonly followUpNumbers?: readonly number[];
    }
  | { readonly status: 'human'; readonly head: GitOid }
  | { readonly status: 'stale' | 'ambiguous'; readonly head: GitOid };

export type ReviewFindingsResult =
  | {
      readonly status: 'filed';
      readonly head: GitOid;
      readonly childNumber: number;
      readonly created: boolean;
    }
  | { readonly status: 'human'; readonly head: GitOid }
  | { readonly status: 'stale' | 'ambiguous'; readonly head: GitOid };

export interface ReviewSessionProtocol {
  reviewVerdict(
    manifest: AttemptManifest,
    state: ReviewVerdictState,
    body: string,
    followUps?: readonly ReviewFollowUpEntry[],
  ): Promise<ReviewVerdictResult>;
  reviewFindings?(
    manifest: AttemptManifest,
    findings: string,
  ): Promise<ReviewFindingsResult>;
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
    phase: 'reviewing',
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
  const commentBody =
    `${marker}\n\nAutopilot parked this review for Human judgment.\n\n${detail}`;
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
  if (!await port.hasHumanComment(manifest.prNumber!, head, commentBody)) {
    await port.ensureHumanComment(
      manifest.prNumber!,
      head,
      marker,
      commentBody,
    );
  }
  // Stage 3: Human Status paint is painter-owned; label+marker are authority.
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

async function releaseRequestedChangesProjection(
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
  return { status: 'requested-changes', head };
}

async function reviewVerdict(
  supplied: AttemptManifest,
  state: ReviewVerdictState,
  body: string,
  port: ReviewSessionPort,
  followUps?: readonly ReviewFollowUpEntry[],
): Promise<ReviewVerdictResult> {
  if (followUps !== undefined && followUps.length > 0 && state !== 'APPROVE') {
    throw new Error('Follow-ups are only valid with APPROVE');
  }

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

  let followUpNumbers: number[] | undefined;
  if (followUps !== undefined && followUps.length > 0) {
    if (port.fileReviewFollowUps === undefined) {
      throw new Error('Review follow-ups require a follow-up filing port');
    }
    const filed = await port.fileReviewFollowUps({
      parentPr: manifest.prNumber!,
      head,
      entries: followUps,
    });
    followUpNumbers = filed.map((entry) => entry.number);
  }
  const bodyWithFollowUps =
    followUpNumbers === undefined || followUpNumbers.length === 0
      ? body
      : `${body.trim()}\n\nFollow-up issues: ${followUpNumbers.map((n) => `#${n}`).join(', ')}`;

  let intent: Extract<ReviewClaimRecord, { readonly state: 'verdict-intent' }>;
  if (authority.record.state === 'verdict-intent') {
    if (authority.record.verdict.state !== state) {
      throw new Error('Review verdict retry contradicts the current intent');
    }
    intent = authority.record;
  } else if (
    authority.record.state === 'stale'
    && state === 'REQUEST_CHANGES'
  ) {
    return releaseRequestedChangesProjection(manifest, pullRequest, port);
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
        body: `${bodyWithFollowUps.trim()}\n\n${marker}`,
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
    // Stage 5: release the claim (stale). No fixing state, no redraft, no branch push.
    if (authority.record.state !== 'stale') {
      const released = nextRecord(manifest, 'stale', port.now());
      const published = await publishRecord(manifest, authority, released, port);
      if (published.status !== 'published') return { status: published.status, head };
      manifest = requireReviewManifest(manifest, port);
      authority = await requireAuthority(manifest, port);
    }
    pullRequest = await requirePullRequest(manifest, port);
    return releaseRequestedChangesProjection(manifest, pullRequest, port);
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
  // Stage 3: In Review Status paint is painter-owned (no setProjectStatus).
  await requireNoNativeChangeRequests(manifest, port);
  pullRequest = await requirePullRequest(manifest, port);
  if (await humanIsActive(manifest, port)) return { status: 'human', head };
  if (pullRequest.draft) {
    await port.setPullRequestDraft(manifest.prNumber!, head, false);
  }
  return followUpNumbers === undefined || followUpNumbers.length === 0
    ? { status: 'approved', head }
    : { status: 'approved', head, followUpNumbers };
}

/**
 * Stage 2 children path: native REQUEST_CHANGES + file one finding child +
 * release the review claim. No redraft, no fixing state, no branch push.
 */
async function reviewFindings(
  supplied: AttemptManifest,
  findings: string,
  port: ReviewSessionPort,
): Promise<ReviewFindingsResult> {
  if (port.fileFindingChild === undefined) {
    throw new Error('Review findings require a child-issue port');
  }
  let manifest = requireReviewManifest(supplied, port);
  let authority = await requireAuthority(manifest, port);
  let pullRequest = await readExactPullRequest(manifest, port);
  const head = manifest.expectedHead as GitOid;
  const authorityProblem = pullRequestAuthorityProblem(manifest, pullRequest);
  if (authorityProblem !== undefined) {
    return enterHuman(manifest, authorityProblem, port, pullRequest);
  }
  if (await humanIsActive(manifest, port)) return { status: 'human', head };
  if (authority.record.state !== 'active' && authority.record.state !== 'verdict-intent') {
    throw new Error(`Review findings are invalid from ${authority.record.state} authority`);
  }

  const child = await port.fileFindingChild({
    parentPr: manifest.prNumber!,
    title: `Address review findings for PR #${manifest.prNumber}`,
    body: findings.trim(),
    effort: 'medium',
  });
  if (child.runawayHold === true) {
    return enterHuman(
      manifest,
      `Runaway child guard: ${child.priorCount} prior review-finding children `
      + `on PR #${manifest.prNumber}; parking for Human.`,
      port,
      pullRequest,
    );
  }

  let intent: Extract<ReviewClaimRecord, { readonly state: 'verdict-intent' }>;
  if (authority.record.state === 'verdict-intent') {
    if (authority.record.verdict.state !== 'REQUEST_CHANGES') {
      throw new Error('Review findings retry contradicts the current intent');
    }
    intent = authority.record;
  } else {
    intent = nextRecord(
      manifest,
      'verdict-intent',
      port.now(),
      { state: 'REQUEST_CHANGES', marker: port.nextMarker() },
    ) as Extract<ReviewClaimRecord, { readonly state: 'verdict-intent' }>;
    const published = await publishRecord(manifest, authority, intent, port);
    if (published.status !== 'published') return { status: published.status, head };
    manifest = requireReviewManifest(manifest, port);
    authority = await requireAuthority(manifest, port);
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
        state: 'REQUEST_CHANGES',
        body: `${findings.trim()}\n\nChild issue: #${child.number}\n\n${marker}`,
      });
    } catch (error) {
      submissionError = error;
    }
    confirmed = await matchingNativeReview(manifest, intent.verdict, port);
    if (confirmed === undefined && submissionError !== undefined) {
      throw submissionError;
    }
  }
  if (confirmed === undefined) return { status: 'ambiguous', head };

  // Release claim (stale) — children path does not enter fixing / redraft.
  if (authority.record.state !== 'stale') {
    const released = nextRecord(manifest, 'stale', port.now());
    const published = await publishRecord(manifest, authority, released, port);
    if (published.status !== 'published') return { status: published.status, head };
  }
  pullRequest = await requirePullRequest(manifest, port);
  if (!pullRequest.labels.includes('review:changes-requested')) {
    await port.setPullRequestLabel(
      manifest.prNumber!,
      head,
      'review:changes-requested',
      true,
    );
  }
  if (pullRequest.labels.includes('review:approved')) {
    await port.setPullRequestLabel(manifest.prNumber!, head, 'review:approved', false);
  }
  return {
    status: 'filed',
    head,
    childNumber: child.number,
    created: child.created,
  };
}

export function makeReviewSessionProtocol(
  port: ReviewSessionPort,
): ReviewSessionProtocol {
  return {
    reviewVerdict: (manifest, state, body, followUps) =>
      reviewVerdict(manifest, state, body, port, followUps),
    reviewFindings: (manifest, findings) => reviewFindings(manifest, findings, port),
    human: (manifest, reason) => enterHuman(manifest, reason, port),
  };
}

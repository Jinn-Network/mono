import type { PolledIssue } from '../dispatcher/types.js';
import type { ProjectSnapshot } from '../dispatcher/project-snapshot.js';
import { toIssueBoardState } from '../dispatcher/project-snapshot.js';
import { DEFAULT_FLOOR } from '../dispatcher/rate-limit-guard.js';
import type { PrLink } from '../dispatcher/pr-links.js';
import { resolveStackReady } from '../dispatcher/stack-readiness.js';
import { selectReady } from '../dispatcher/ready-filter.js';
import {
  decodeBranchClaimTrailers,
  decodeReviewClaimPayload,
  formatAutomatedReviewMarker,
} from './codecs.js';
import { parseChildMarker, isMachineChildIssue, type ChildKind } from './child-issues.js';
import {
  gitOid,
  isoTimestamp,
  type BranchClaim,
  type GitOid,
  type HumanReason,
  type IssueEligibilityReason,
  type LifecycleItem,
  type LifecycleMappingDiagnostic,
  type LifecycleSnapshot,
  type ReviewClaimRecord,
  type ReviewVerdictState,
} from './types.js';

export type NativeReviewState =
  | 'APPROVED'
  | 'CHANGES_REQUESTED'
  | 'COMMENTED'
  | 'DISMISSED'
  | 'PENDING';

export interface NativeReviewSnapshot {
  readonly reviewer: string;
  readonly state: NativeReviewState;
  readonly commitId: GitOid;
  readonly body: string;
  readonly submittedAt: string;
}

export interface CheckSummary {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
}

export interface ReviewClaimSnapshot {
  readonly oid: GitOid;
  readonly record: ReviewClaimRecord;
}

export interface BranchClaimSnapshot {
  readonly issueNumber: number;
  readonly headRefName: string;
  readonly headOid: GitOid;
  readonly headCommittedAt: string;
  readonly claim: BranchClaim;
  readonly implementationCompletionSummary?: string;
}

export interface RawBranchClaim {
  readonly issueNumber: number;
  readonly headRefName: string;
  readonly headOid: string;
  readonly headCommittedAt: string;
  readonly claimTrailers: string;
  readonly implementationCompletionSummary?: string | null;
}

export interface PullRequestSnapshot {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly author: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly headOid: GitOid;
  readonly headCommittedAt: string;
  readonly isDraft: boolean;
  readonly state: 'OPEN' | 'MERGED';
  readonly labels: readonly string[];
  readonly closingIssueNumbers: readonly number[];
  readonly mergeability: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  readonly mergeStateStatus: string;
  readonly checks: readonly CheckSummary[];
  readonly reviews: readonly NativeReviewSnapshot[];
  readonly branchClaim?: BranchClaim;
  readonly implementationCompletionSummary?: string;
  readonly reviewClaim?: ReviewClaimSnapshot;
  readonly humanIssueNumber?: number;
  readonly humanReason?: HumanReason;
  readonly mergedAt?: string;
  readonly mergeCommitOid?: GitOid;
}

export interface RawNativeReview {
  readonly reviewer: string;
  readonly state: NativeReviewState;
  readonly commitId: string;
  readonly body: string;
  readonly submittedAt: string;
}

export interface RawPullRequest {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly author: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly headOid: string;
  readonly headCommittedAt: string;
  readonly isDraft: boolean;
  readonly state: 'OPEN' | 'MERGED';
  readonly labels: readonly string[];
  readonly closingIssueNumbers: readonly number[];
  readonly mergeability: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  readonly mergeStateStatus: string;
  readonly checks: readonly CheckSummary[];
  readonly reviews: readonly RawNativeReview[];
  readonly branchClaimTrailers: string | null;
  readonly implementationCompletionSummary?: string | null;
  readonly reviewClaim: { readonly oid: string; readonly payload: string } | null;
  readonly humanIssueNumber?: number | null;
  readonly humanReason: HumanReason | null;
  readonly mergedAt: string | null;
  readonly mergeCommitOid: string | null;
}

export interface PullRequestPage {
  readonly nodes: readonly RawPullRequest[];
  readonly pageInfo: {
    readonly hasNextPage: boolean;
    readonly endCursor: string | null;
  };
}

export interface GitHubLifecycleReader {
  readProjectSnapshot(): Promise<ProjectSnapshot>;
  readIssues(board: ReturnType<typeof toIssueBoardState>): Promise<readonly PolledIssue[]>;
  readPullRequests(
    cursor: string | null,
    nonDoneIssueNumbers?: readonly number[],
  ): Promise<PullRequestPage>;
  readBranchClaims?(): Promise<readonly RawBranchClaim[]>;
}

export interface GitHubLifecycleSnapshot {
  readonly project: ProjectSnapshot;
  readonly issues: readonly PolledIssue[];
  readonly pullRequests: readonly PullRequestSnapshot[];
  readonly branches: readonly BranchClaimSnapshot[];
  readonly diagnostics: readonly LifecycleMappingDiagnostic[];
  readonly lifecycle: LifecycleSnapshot;
  readonly capturedAt: string;
}

function parseBranchClaim(raw: RawBranchClaim): BranchClaimSnapshot {
  try {
    assertPositiveInteger(raw.issueNumber, 'issue number');
    isoTimestamp(raw.headCommittedAt);
    const claim = decodeBranchClaimTrailers(raw.claimTrailers);
    if (claim.issueNumber !== raw.issueNumber) {
      throw new Error('Branch claim issue does not match ref issue');
    }
    return {
      issueNumber: raw.issueNumber,
      headRefName: raw.headRefName,
      headOid: gitOid(raw.headOid),
      headCommittedAt: raw.headCommittedAt,
      claim,
      ...(raw.implementationCompletionSummary === undefined
        || raw.implementationCompletionSummary === null
        ? {}
        : { implementationCompletionSummary: raw.implementationCompletionSummary }),
    };
  } catch (cause) {
    throw new SnapshotDecodeError(`branch ${raw.headRefName}`, cause);
  }
}

export class SnapshotDecodeError extends Error {
  constructor(subject: string, cause: unknown) {
    super(`SnapshotDecodeError: could not decode ${subject}: ${errorMessage(cause)}`);
    this.name = 'SnapshotDecodeError';
  }
}

export class LifecycleRateLimitError extends Error {
  constructor(readonly remaining: number) {
    super(`GitHub rate-limit budget low: ${remaining} remaining`);
    this.name = 'LifecycleRateLimitError';
  }
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid ${label}`);
  }
}

function parsePullRequest(raw: RawPullRequest): PullRequestSnapshot {
  try {
    assertPositiveInteger(raw.number, 'PR number');
    const headOid = gitOid(raw.headOid);
    isoTimestamp(raw.headCommittedAt);
    const reviews = raw.reviews.map((review): NativeReviewSnapshot => {
      isoTimestamp(review.submittedAt);
      return {
        ...review,
        commitId: gitOid(review.commitId),
      };
    });
    const branchClaim = raw.branchClaimTrailers === null
      ? undefined
      : decodeBranchClaimTrailers(raw.branchClaimTrailers);
    const reviewClaim = raw.reviewClaim === null
      ? undefined
      : {
          oid: gitOid(raw.reviewClaim.oid),
          record: decodeReviewClaimPayload(raw.reviewClaim.payload),
        };
    if (raw.mergedAt !== null) isoTimestamp(raw.mergedAt);
    if (raw.humanIssueNumber !== undefined && raw.humanIssueNumber !== null) {
      assertPositiveInteger(raw.humanIssueNumber, 'Human marker issue number');
    }
    return {
      number: raw.number,
      title: raw.title,
      body: raw.body,
      author: raw.author,
      baseRefName: raw.baseRefName,
      headRefName: raw.headRefName,
      headOid,
      headCommittedAt: raw.headCommittedAt,
      isDraft: raw.isDraft,
      state: raw.state,
      labels: [...raw.labels],
      closingIssueNumbers: [...raw.closingIssueNumbers],
      mergeability: raw.mergeability,
      mergeStateStatus: raw.mergeStateStatus,
      checks: raw.checks.map((check) => ({ ...check })),
      reviews,
      ...(branchClaim === undefined ? {} : { branchClaim }),
      ...(raw.implementationCompletionSummary === undefined
        || raw.implementationCompletionSummary === null
        ? {}
        : { implementationCompletionSummary: raw.implementationCompletionSummary }),
      ...(reviewClaim === undefined ? {} : { reviewClaim }),
      ...(raw.humanIssueNumber === undefined || raw.humanIssueNumber === null
        ? {}
        : { humanIssueNumber: raw.humanIssueNumber }),
      ...(raw.humanReason === null ? {} : { humanReason: raw.humanReason }),
      ...(raw.mergedAt === null ? {} : { mergedAt: raw.mergedAt }),
      ...(raw.mergeCommitOid === null ? {} : { mergeCommitOid: gitOid(raw.mergeCommitOid) }),
    };
  } catch (cause) {
    throw new SnapshotDecodeError(`PR #${raw.number}`, cause);
  }
}

function prLinksByIssue(
  prs: readonly PullRequestSnapshot[],
  issueByPr: ReadonlyMap<number, number>,
): Map<number, PrLink[]> {
  const out = new Map<number, PrLink[]>();
  for (const pr of prs) {
    const link: PrLink = {
      prNumber: pr.number,
      headRefName: pr.headRefName,
      baseRefName: pr.baseRefName,
      state: pr.state,
      isDraft: pr.isDraft,
      author: pr.author,
      labels: [...pr.labels],
    };
    const issueNumber = issueByPr.get(pr.number);
    if (issueNumber === undefined) continue;
    const links = out.get(issueNumber) ?? [];
    links.push(link);
    out.set(issueNumber, links);
  }
  return out;
}

function latestDecisiveReview(
  pr: PullRequestSnapshot,
): NativeReviewSnapshot | undefined {
  return pr.reviews
    .filter((review) => (
      review.commitId === pr.headOid
      && (review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED')
    ))
    .sort((left, right) => right.submittedAt.localeCompare(left.submittedAt))[0];
}

function terminalVerdict(pr: PullRequestSnapshot) {
  const claim = pr.reviewClaim?.record;
  if (claim?.verdict === undefined) return undefined;
  const expectedMarker = formatAutomatedReviewMarker({
    generation: claim.generation,
    attempt: claim.attempt,
    intent: claim.verdict.marker,
    reviewer: claim.reviewer,
    head: claim.head,
    verdict: claim.verdict.state,
  });
  const nativeState = claim.verdict.state === 'APPROVE' ? 'APPROVED' : 'CHANGES_REQUESTED';
  const review = pr.reviews
    .filter((candidate) => (
      candidate.commitId === claim.head
      && candidate.reviewer.toLowerCase() === claim.reviewer.toLowerCase()
      && candidate.state === nativeState
      && candidate.body.includes(expectedMarker)
    ))
    .sort((left, right) => right.submittedAt.localeCompare(left.submittedAt))[0];
  if (review === undefined) return undefined;
  return {
    head: review.commitId,
    state: claim.verdict.state,
    recordedAt: review.submittedAt,
    marker: claim.verdict.marker,
  } as const;
}

function mergeState(pr: PullRequestSnapshot): Extract<
LifecycleItem,
{ kind: 'pull-request' }
>['mergeState'] {
  if (pr.mergeability === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY') return 'conflict';
  if (pr.mergeStateStatus === 'BEHIND') return 'behind';
  if (pr.mergeability === 'MERGEABLE' && ['CLEAN', 'UNSTABLE', 'HAS_HOOKS'].includes(
    pr.mergeStateStatus,
  )) {
    return 'clean';
  }
  return 'blocked';
}

function lifecyclePr(
  pr: PullRequestSnapshot,
  issue: PolledIssue,
  openChildKinds: readonly ChildKind[] = [],
): Extract<LifecycleItem, { kind: 'pull-request' }> {
  const decisive = latestDecisiveReview(pr);
  const reviewClaim = pr.reviewClaim?.record;
  const issueLabels = [...(issue.labels ?? [])];
  const humanSource = reviewClaim?.state === 'human'
    && reviewClaim.head === pr.headOid
    ? 'Current-head Human review record'
    : issue.blockedOn === 'Human'
      ? 'Project Blocked on: Human'
      : pr.labels.includes('review:needs-human')
        ? 'PR label: review:needs-human'
        : issueLabels.includes('review:needs-human')
          ? 'Issue label: review:needs-human'
          : issueLabels.includes('autopilot:human')
            ? 'Issue label: autopilot:human'
            : undefined;
  const implementationActive = pr.branchClaim?.phase === 'implement'
    && pr.branchClaim.phaseComplete !== true;
  const reviewPhase = reviewClaim !== undefined && reviewClaim.head === pr.headOid
    ? 'reviewing' as const
    : 'awaiting-review' as const;
  const synthesizedHumanReason: HumanReason | undefined = humanSource === undefined
    ? undefined
    : implementationActive
      ? {
          phase: 'implementing',
          code: 'implementation-escalation',
          detail: humanSource,
        }
      : {
          phase: reviewPhase,
          code: 'review-escalation',
          detail: humanSource,
        };
  const humanReason = pr.humanReason ?? synthesizedHumanReason;
  const humanHold = humanReason !== undefined;
  return {
    kind: 'pull-request',
    issueNumber: issue.number,
    prNumber: pr.number,
    v2Marked: pr.branchClaim !== undefined
      || reviewClaim !== undefined
      || (pr.state === 'MERGED' && (
        pr.labels.includes('engine:review')
        || stableBranchIssue(pr.headRefName) === issue.number
        || /<!-- jinn-autopilot-[a-z-]+:v2\b/.test(pr.body)
      )),
    projectStatus: issue.status,
    labels: [...pr.labels],
    ...(humanHold ? { humanHold: true } : {}),
    ...(humanReason === undefined ? {} : { humanReason }),
    head: pr.headOid,
    headChangedAt: pr.headCommittedAt,
    isDraft: pr.isDraft,
    merged: pr.state === 'MERGED',
    needsReview: decisive?.state !== 'APPROVED',
    approved: decisive?.state === 'APPROVED',
    mergeState: mergeState(pr),
    ...(openChildKinds.length === 0 ? {} : { openChildKinds: [...openChildKinds] }),
    ...(pr.branchClaim === undefined ? {} : { branchClaim: pr.branchClaim }),
    ...(pr.implementationCompletionSummary === undefined
      ? {}
      : { implementationSummary: pr.implementationCompletionSummary }),
    ...(reviewClaim === undefined ? {} : { reviewClaim }),
    ...(terminalVerdict(pr) === undefined ? {} : { terminalVerdict: terminalVerdict(pr) }),
  };
}

function stableBranchIssue(headRefName: string): number | undefined {
  const match = /^autopilot\/([1-9][0-9]*)$/.exec(headRefName);
  if (match === null) return undefined;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) ? number : undefined;
}

function resolveMappings(
  prs: readonly PullRequestSnapshot[],
  branches: readonly BranchClaimSnapshot[],
  byIssue: ReadonlyMap<number, PolledIssue>,
): {
  readonly issueByPr: ReadonlyMap<number, number>;
  readonly diagnostics: readonly LifecycleMappingDiagnostic[];
  readonly affectedIssues: ReadonlySet<number>;
} {
  const candidatesByPr = new Map<number, Set<number>>();
  const prsByIssue = new Map<number, Set<number>>();
  const intrinsicallyAmbiguous = new Set<number>();
  const intrinsicDetails = new Map<number, string[]>();
  const diagnosticExtraIssues = new Map<number, Set<number>>();
  const stableClaims = new Map(
    branches
      .filter((branch) => (
        branch.claim.phase === 'implement'
        && branch.headRefName === `autopilot/${branch.issueNumber}`
      ))
      .map((branch) => [branch.issueNumber, branch]),
  );
  for (const pr of prs) {
    const candidates = new Set<number>();
    for (const issueNumber of pr.closingIssueNumbers) {
      if (byIssue.has(issueNumber)) candidates.add(issueNumber);
    }
    const stableIssue = stableBranchIssue(pr.headRefName);
    if (stableIssue !== undefined && byIssue.has(stableIssue)) candidates.add(stableIssue);
    candidatesByPr.set(pr.number, candidates);
    for (const issueNumber of candidates) {
      const issuePrs = prsByIssue.get(issueNumber) ?? new Set<number>();
      issuePrs.add(pr.number);
      prsByIssue.set(issueNumber, issuePrs);
    }
    const closing = new Set(pr.closingIssueNumbers);
    const details: string[] = [];
    if (
      pr.humanIssueNumber !== undefined
      && (candidates.size !== 1 || !candidates.has(pr.humanIssueNumber))
    ) {
      intrinsicallyAmbiguous.add(pr.number);
      details.push(
        `structured Human marker issue #${pr.humanIssueNumber} contradicts the resolved PR mapping`,
      );
      if (byIssue.has(pr.humanIssueNumber)) {
        diagnosticExtraIssues.set(pr.number, new Set([pr.humanIssueNumber]));
      }
    }
    const mappedIssue = candidates.size === 1 ? [...candidates][0] : undefined;
    const stableClaim = mappedIssue === undefined ? undefined : stableClaims.get(mappedIssue);
    if (stableClaim !== undefined && pr.headRefName !== stableClaim.headRefName) {
      intrinsicallyAmbiguous.add(pr.number);
      details.push(
        `stable branch ${stableClaim.headRefName} claim contradicts adopted PR #${pr.number} branch ${pr.headRefName}`,
      );
    }
    if (details.length > 0) intrinsicDetails.set(pr.number, details);
    if (
      candidates.size !== 1
      || closing.size > 1
      || (stableIssue !== undefined && closing.size > 0 && !closing.has(stableIssue))
      || (pr.closingIssueNumbers.length > 0
        && !pr.closingIssueNumbers.some((number) => byIssue.has(number)))
    ) {
      intrinsicallyAmbiguous.add(pr.number);
    }
  }

  const ambiguousPrs = new Set(intrinsicallyAmbiguous);
  for (const issuePrs of prsByIssue.values()) {
    if (issuePrs.size > 1) {
      for (const prNumber of issuePrs) ambiguousPrs.add(prNumber);
    }
  }

  const prByNumber = new Map(prs.map((pr) => [pr.number, pr]));
  const seenPrs = new Set<number>();
  const diagnostics: LifecycleMappingDiagnostic[] = [];
  const affectedIssues = new Set<number>();
  for (const seed of [...ambiguousPrs].sort((left, right) => left - right)) {
    if (seenPrs.has(seed)) continue;
    const componentPrs = new Set<number>();
    const componentIssues = new Set<number>();
    const pendingPrs = [seed];
    while (pendingPrs.length > 0) {
      const prNumber = pendingPrs.pop()!;
      if (componentPrs.has(prNumber)) continue;
      componentPrs.add(prNumber);
      ambiguousPrs.add(prNumber);
      seenPrs.add(prNumber);
      const connectedIssues = new Set([
        ...(candidatesByPr.get(prNumber) ?? []),
        ...(diagnosticExtraIssues.get(prNumber) ?? []),
      ]);
      for (const issueNumber of connectedIssues) {
        if (componentIssues.has(issueNumber)) continue;
        componentIssues.add(issueNumber);
        for (const linkedPr of prsByIssue.get(issueNumber) ?? []) {
          if (!componentPrs.has(linkedPr)) pendingPrs.push(linkedPr);
        }
      }
    }
    for (const issueNumber of componentIssues) affectedIssues.add(issueNumber);
    const diagnosticPrs = [...componentPrs]
      .map((number) => prByNumber.get(number)!)
      .sort((left, right) => left.number - right.number);
    const issueNumbers = [...componentIssues].sort((left, right) => left - right);
    const prNumbers = diagnosticPrs.map((pr) => pr.number);
    const details = [...new Set(diagnosticPrs.flatMap((pr) => (
      intrinsicDetails.get(pr.number) ?? []
    )))];
    diagnostics.push({
      code: 'branch-mapping-ambiguous',
      detail: `Ambiguous lifecycle mapping between issue(s) ${
        issueNumbers.length === 0 ? 'none' : issueNumbers.map((number) => `#${number}`).join(', ')
      } and PR(s) ${prNumbers.map((number) => `#${number}`).join(', ')}${
        details.length === 0 ? '' : `: ${details.join('; ')}`
      }`,
      issueNumbers,
      issues: issueNumbers.map((number) => ({
        number,
        projectStatus: byIssue.get(number)?.status ?? null,
      })),
      pullRequests: diagnosticPrs.map((pr) => ({
        number: pr.number,
        head: pr.headOid,
        draft: pr.isDraft,
        labels: [...pr.labels],
      })),
    });
  }

  const issueByPr = new Map<number, number>();
  for (const pr of prs) {
    if (ambiguousPrs.has(pr.number)) continue;
    const candidates = candidatesByPr.get(pr.number);
    if (candidates?.size === 1) issueByPr.set(pr.number, [...candidates][0]!);
  }
  return { issueByPr, diagnostics, affectedIssues };
}

function eligibilityEvidence(
  issue: PolledIssue,
  eligible: boolean,
  authorDisallowed: boolean,
  stackReady: ReadonlyMap<number, unknown>,
  hasClaimBranch = false,
): { readonly reason: IssueEligibilityReason; readonly detail: string } {
  if (eligible) return { reason: 'eligible', detail: 'All implementation admission gates pass' };
  if (issue.blockedOn === 'Another issue' && !stackReady.has(issue.number)) {
    const blockers = issue.blockedByIssues.map((number) => `#${number}`).join(', ');
    return {
      reason: 'dependency-blocked',
      detail: blockers.length === 0
        ? 'Blocked by an unresolved issue dependency'
        : `Blocked by unresolved issue ${blockers}`,
    };
  }
  if (authorDisallowed) {
    return {
      reason: 'author-disallowed',
      detail: `Issue author ${issue.author || '(missing)'} is not selected by the author allowlist`,
    };
  }
  if (hasClaimBranch) {
    return {
      reason: 'not-selected',
      detail: `Issue has an in-flight claim branch autopilot/${issue.number}`,
    };
  }
  if (isMachineChildIssue(issue)) {
    return {
      reason: 'not-selected',
      detail: 'Machine child issue is not currently selectable',
    };
  }
  const sourceReason =
    issue.shape === null ? 'Issue Type is not set'
      : issue.priority === null ? 'Priority is not set'
        : !issue.onBoard || issue.projectItemId === null ? 'Issue is not on the Project'
          : issue.blockedOn === 'Human' ? 'Project Blocked on is Human'
            : `Project Blocked on is ${issue.blockedOn ?? 'unset'}`;
  return { reason: 'not-selected', detail: sourceReason };
}

function openChildrenByParent(
  issues: readonly PolledIssue[],
): Map<number, ChildKind[]> {
  const byParent = new Map<number, ChildKind[]>();
  for (const issue of issues) {
    const marker = parseChildMarker(issue.body ?? '');
    if (marker === null) continue;
    const current = byParent.get(marker.parentPr) ?? [];
    if (!current.includes(marker.kind)) current.push(marker.kind);
    byParent.set(marker.parentPr, current);
  }
  return byParent;
}

function lifecycleItems(
  issues: readonly PolledIssue[],
  prs: readonly PullRequestSnapshot[],
  branches: readonly BranchClaimSnapshot[],
  authorAllowlist: ReadonlySet<string>,
  project: ProjectSnapshot,
): {
  readonly items: readonly LifecycleItem[];
  readonly diagnostics: readonly LifecycleMappingDiagnostic[];
} {
  const byIssue = new Map(issues.map((issue) => [issue.number, issue]));
  for (const entry of project.items) {
    if (entry.contentType !== 'Issue' || byIssue.has(entry.number)) continue;
    byIssue.set(entry.number, {
      number: entry.number,
      title: '',
      shape: entry.issueType,
      blockedOn: entry.blockedOn,
      blockedByIssues: [...entry.blockedByIssues],
      effort: entry.effort,
      priority: entry.priority,
      status: entry.status,
      onBoard: true,
      author: '',
      projectItemId: entry.id,
      inCurrentSprint: entry.sprintIterationId !== null
        && entry.sprintIterationId === project.currentSprintIterationId,
    });
  }
  const mappings = resolveMappings(prs, branches, byIssue);
  const links = prLinksByIssue(prs, mappings.issueByPr);
  const stackReady = resolveStackReady([...issues], links, authorAllowlist);
  const claimBranchIssues = new Set(
    branches
      .filter((branch) => (
        branch.claim.phase === 'implement'
        && branch.headRefName === `autopilot/${branch.issueNumber}`
      ))
      .map((branch) => branch.issueNumber),
  );
  const issuesWithPr = new Set([
    ...mappings.issueByPr.values(),
    ...mappings.affectedIssues,
  ]);
  const inFlight = new Set([
    ...issuesWithPr,
    ...claimBranchIssues,
  ]);
  const selected = selectReady([...issues], inFlight, authorAllowlist, stackReady);
  const ready = new Set(selected.ready.map((issue) => issue.number));
  const skippedForAuthor = new Set(selected.skippedForAuthor.map((issue) => issue.number));
  const childrenByParent = openChildrenByParent([...byIssue.values()]);
  const out: LifecycleItem[] = [];
  for (const issue of issues) {
    if (issuesWithPr.has(issue.number)) continue;
    const issueLabels = [...(issue.labels ?? [])];
    const sourceHumanHold = issue.blockedOn === 'Human'
      || issueLabels.includes('review:needs-human')
      || issueLabels.includes('autopilot:human');
    const selectedReady = ready.has(issue.number);
    const eligible = selectedReady && !sourceHumanHold;
    const holdDetail = issue.blockedOn === 'Human'
      ? 'Project Blocked on is Human'
      : issueLabels.includes('autopilot:human')
        ? 'Issue carries autopilot:human'
        : issueLabels.includes('review:needs-human')
          ? 'Issue carries review:needs-human'
          : undefined;
    const eligibility = sourceHumanHold && selectedReady && holdDetail !== undefined
      ? { reason: 'not-selected' as const, detail: holdDetail }
      : eligibilityEvidence(
        issue,
        eligible,
        skippedForAuthor.has(issue.number),
        stackReady,
        claimBranchIssues.has(issue.number),
      );
    const sourceHumanReason: HumanReason | undefined = sourceHumanHold
      ? {
          phase: 'eligible',
          code: 'implementation-escalation',
          detail: holdDetail ?? 'Human hold',
        }
      : undefined;
    out.push({
      kind: 'issue',
      issueNumber: issue.number,
      v2Marked: isMachineChildIssue(issue),
      projectStatus: issue.status,
      labels: issueLabels,
      ...(sourceHumanHold ? { humanHold: true } : {}),
      ...(sourceHumanReason === undefined ? {} : { humanReason: sourceHumanReason }),
      eligible,
      eligibilityReason: eligibility.reason,
      eligibilityDetail: eligibility.detail,
    });
  }
  for (const pr of prs) {
    const issueNumber = mappings.issueByPr.get(pr.number);
    if (issueNumber === undefined) continue;
    const issue = byIssue.get(issueNumber);
    if (issue !== undefined) {
      out.push(lifecyclePr(pr, issue, childrenByParent.get(pr.number) ?? []));
    }
  }
  return { items: out, diagnostics: mappings.diagnostics };
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}

export async function buildGitHubLifecycleSnapshot(
  reader: GitHubLifecycleReader,
  options: {
    readonly authorAllowlist: ReadonlySet<string>;
    readonly now?: () => Date;
    readonly maxPages?: number;
    readonly rateLimitFloor?: number;
  },
): Promise<GitHubLifecycleSnapshot> {
  const project = await reader.readProjectSnapshot();
  if (project.rateLimit.remaining < (options.rateLimitFloor ?? DEFAULT_FLOOR)) {
    throw new LifecycleRateLimitError(project.rateLimit.remaining);
  }
  const issues = await reader.readIssues(toIssueBoardState(project));
  const nonDoneIssueNumbers = project.items
    .filter((item) => item.contentType === 'Issue' && item.status !== 'Done')
    .map((item) => item.number);
  const rawPrs: RawPullRequest[] = [];
  const maxPages = options.maxPages ?? 100;
  let cursor: string | null = null;
  const seen = new Set<string>();
  for (let pageNumber = 1; ; pageNumber += 1) {
    if (pageNumber > maxPages) throw new Error('PR pagination exceeded safety limit');
    const page = await reader.readPullRequests(cursor, nonDoneIssueNumbers);
    rawPrs.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) break;
    const next = page.pageInfo.endCursor;
    if (next === null || seen.has(next)) {
      throw new Error('PR pagination cursor did not advance');
    }
    seen.add(next);
    cursor = next;
  }
  const pullRequests = rawPrs.map(parsePullRequest);
  const branches = (await reader.readBranchClaims?.() ?? []).map(parseBranchClaim);
  const now = (options.now ?? (() => new Date()))();
  isoTimestamp(now.toISOString());
  const lifecycle = lifecycleItems(
    issues,
    pullRequests,
    branches,
    options.authorAllowlist,
    project,
  );
  const snapshot: GitHubLifecycleSnapshot = {
    project,
    issues: [...issues],
    pullRequests,
    branches,
    diagnostics: lifecycle.diagnostics,
    lifecycle: {
      items: lifecycle.items,
    },
    capturedAt: now.toISOString(),
  };
  return deepFreeze(snapshot);
}

export function nativeStateForVerdict(
  state: ReviewVerdictState,
): Extract<NativeReviewState, 'APPROVED' | 'CHANGES_REQUESTED'> {
  return state === 'APPROVE' ? 'APPROVED' : 'CHANGES_REQUESTED';
}

import type { PolledIssue } from '../dispatcher/types.js';
import type { ProjectSnapshot } from '../dispatcher/project-snapshot.js';
import { toIssueBoardState } from '../dispatcher/project-snapshot.js';
import type { PrLink } from '../dispatcher/pr-links.js';
import { resolveStackReady } from '../dispatcher/stack-readiness.js';
import { selectReady } from '../dispatcher/ready-filter.js';
import {
  decodeBranchClaimTrailers,
  decodeReviewClaimPayload,
  formatAutomatedReviewMarker,
} from './codecs.js';
import {
  gitOid,
  isoTimestamp,
  type BranchClaim,
  type GitOid,
  type HumanReason,
  type LifecycleItem,
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
}

export interface RawBranchClaim {
  readonly issueNumber: number;
  readonly headRefName: string;
  readonly headOid: string;
  readonly headCommittedAt: string;
  readonly claimTrailers: string;
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
  readonly reviewClaim?: ReviewClaimSnapshot;
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
  readonly reviewClaim: { readonly oid: string; readonly payload: string } | null;
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
  readPullRequests(cursor: string | null): Promise<PullRequestPage>;
  readBranchClaims?(): Promise<readonly RawBranchClaim[]>;
}

export interface GitHubLifecycleSnapshot {
  readonly project: ProjectSnapshot;
  readonly issues: readonly PolledIssue[];
  readonly pullRequests: readonly PullRequestSnapshot[];
  readonly branches: readonly BranchClaimSnapshot[];
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
      ...(reviewClaim === undefined ? {} : { reviewClaim }),
      ...(raw.humanReason === null ? {} : { humanReason: raw.humanReason }),
      ...(raw.mergedAt === null ? {} : { mergedAt: raw.mergedAt }),
      ...(raw.mergeCommitOid === null ? {} : { mergeCommitOid: gitOid(raw.mergeCommitOid) }),
    };
  } catch (cause) {
    throw new SnapshotDecodeError(`PR #${raw.number}`, cause);
  }
}

function prLinksByIssue(prs: readonly PullRequestSnapshot[]): Map<number, PrLink[]> {
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
    for (const issueNumber of pr.closingIssueNumbers) {
      const links = out.get(issueNumber) ?? [];
      links.push(link);
      out.set(issueNumber, links);
    }
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
    head: claim.head,
    verdict: claim.verdict.state,
  });
  const nativeState = claim.verdict.state === 'APPROVE' ? 'APPROVED' : 'CHANGES_REQUESTED';
  const review = pr.reviews
    .filter((candidate) => (
      candidate.commitId === claim.head
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
): Extract<LifecycleItem, { kind: 'pull-request' }> {
  const decisive = latestDecisiveReview(pr);
  const reviewClaim = pr.reviewClaim?.record;
  return {
    kind: 'pull-request',
    issueNumber: issue.number,
    prNumber: pr.number,
    v2Marked: pr.branchClaim !== undefined || reviewClaim !== undefined,
    projectStatus: issue.status,
    labels: [...pr.labels],
    ...(issue.blockedOn === 'Human' ? { humanHold: true } : {}),
    ...(pr.humanReason === undefined ? {} : { humanReason: pr.humanReason }),
    head: pr.headOid,
    headChangedAt: pr.headCommittedAt,
    isDraft: pr.isDraft,
    merged: pr.state === 'MERGED',
    needsReview: decisive?.state !== 'APPROVED',
    approved: decisive?.state === 'APPROVED',
    mergeState: mergeState(pr),
    ...(pr.branchClaim === undefined ? {} : { branchClaim: pr.branchClaim }),
    ...(reviewClaim === undefined ? {} : { reviewClaim }),
    ...(terminalVerdict(pr) === undefined ? {} : { terminalVerdict: terminalVerdict(pr) }),
  };
}

function lifecycleItems(
  issues: readonly PolledIssue[],
  prs: readonly PullRequestSnapshot[],
  authorAllowlist: ReadonlySet<string>,
  project: ProjectSnapshot,
): readonly LifecycleItem[] {
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
  const links = prLinksByIssue(prs);
  const stackReady = resolveStackReady([...issues], links, authorAllowlist);
  const issuesWithPr = new Set(prs.flatMap((pr) => pr.closingIssueNumbers));
  const ready = new Set(
    selectReady(
      [...issues],
      issuesWithPr,
      authorAllowlist,
      stackReady,
    ).ready.map((issue) => issue.number),
  );
  const out: LifecycleItem[] = [];
  for (const issue of issues) {
    if (issuesWithPr.has(issue.number)) continue;
    out.push({
      kind: 'issue',
      issueNumber: issue.number,
      v2Marked: false,
      projectStatus: issue.status,
      labels: [],
      ...(issue.blockedOn === 'Human' ? { humanHold: true } : {}),
      eligible: ready.has(issue.number),
    });
  }
  for (const pr of prs) {
    if (pr.closingIssueNumbers.length !== 1) continue;
    const issue = byIssue.get(pr.closingIssueNumbers[0]!);
    if (issue !== undefined) out.push(lifecyclePr(pr, issue));
  }
  return out;
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
  },
): Promise<GitHubLifecycleSnapshot> {
  const project = await reader.readProjectSnapshot();
  const issues = await reader.readIssues(toIssueBoardState(project));
  const rawPrs: RawPullRequest[] = [];
  const maxPages = options.maxPages ?? 100;
  let cursor: string | null = null;
  const seen = new Set<string>();
  for (let pageNumber = 1; ; pageNumber += 1) {
    if (pageNumber > maxPages) throw new Error('PR pagination exceeded safety limit');
    const page = await reader.readPullRequests(cursor);
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
  const snapshot: GitHubLifecycleSnapshot = {
    project,
    issues: [...issues],
    pullRequests,
    branches,
    lifecycle: {
      items: lifecycleItems(issues, pullRequests, options.authorAllowlist, project),
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

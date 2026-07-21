import {
  GhIssueSource,
  defaultRunner,
  type CommandRunner,
} from '../dispatcher/issue-source.js';
import {
  fetchProjectSnapshot,
  type ProjectSnapshot,
} from '../dispatcher/project-snapshot.js';
import type { IssueBoardState } from '../dispatcher/issue-source.js';
import { PROJECT_NUMBER, REPO } from '../dispatcher/constants.js';
import type { BlockedOn, ProjectStatus } from '../dispatcher/types.js';
import type {
  GitHubLifecycleReader,
  PullRequestPage,
  RawBranchClaim,
  RawNativeReview,
  RawPullRequest,
} from './snapshot.js';
import {
  decodeBranchClaimTrailers,
  extractImplementationCompletionSummary,
  parseHumanCommentEvidence,
  reviewClaimRef,
  terminalBranchClaimTrailers,
} from './codecs.js';
import { CANONICAL_GITHUB_HTTPS_REMOTE } from './implementation-executor.js';
import { gitOid, type GitOid, type GitRefName } from './types.js';
export { extractImplementationCompletionSummary } from './codecs.js';

export const REVIEW_CLAIM_PAYLOAD_FILE = 'jinn-autopilot-review.json';
const PR_PAGE_SIZE = 50;
const MERGED_ISSUE_BATCH_SIZE = 20;
const COMMIT_HISTORY_PAGE_SIZE = 100;
const MAX_COMMIT_HISTORY_PAGES = 100;

const PR_FIELDS = `
        number title body baseRefName headRefName headRefOid isDraft state
        author { login }
        labels(first: 100) { pageInfo { hasNextPage } nodes { name } }
        closingIssuesReferences(first: 20) { pageInfo { hasNextPage } nodes { number } }
        mergeable mergeStateStatus mergedAt mergeCommit { oid }
        commits(last: 100) {
          pageInfo { hasPreviousPage }
          nodes { commit { oid committedDate message } }
        }
        reviews(first: 100) {
          pageInfo { hasNextPage }
          nodes {
            author { login }
            state
            commit { oid }
            body
            submittedAt
          }
        }
        comments(last: 100) {
          pageInfo { hasPreviousPage }
          nodes { body createdAt }
        }
        statusCheckRollup {
          contexts(first: 100) {
            pageInfo { hasNextPage }
            nodes {
              __typename
              ... on CheckRun { name status conclusion }
              ... on StatusContext { context state }
            }
          }
        }`;

const MERGED_PR_FIELDS = `
        number title body baseRefName headRefName headRefOid isDraft state
        author { login }
        labels(first: 100) { pageInfo { hasNextPage } nodes { name } }
        closingIssuesReferences(first: 20) { pageInfo { hasNextPage } nodes { number } }
        mergeable mergeStateStatus mergedAt mergeCommit { oid }
        commits(last: 1) {
          nodes { commit { oid committedDate } }
        }`;

const PR_QUERY = `query($cursor: String) {
  repository(owner: "Jinn-Network", name: "mono") {
    pullRequests(first: ${PR_PAGE_SIZE}, after: $cursor, states: [OPEN], labels: ["engine:review"], orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        ${PR_FIELDS}
      }
    }
  }
}`;

const PR_BY_NUMBER_QUERY = `query($number: Int!) {
  repository(owner: "Jinn-Network", name: "mono") {
    pullRequest(number: $number) {
      ${PR_FIELDS}
    }
  }
}`;

function mergedOutcomesQuery(issueNumbers: readonly number[]): string {
  const issues = issueNumbers.map((number) => `
    issue${number}: issue(number: ${number}) {
      closedByPullRequestsReferences(first: 100, includeClosedPrs: true) {
        pageInfo { hasNextPage }
        nodes { ${MERGED_PR_FIELDS} }
      }
    }`).join('\n');
  return `query {
  repository(owner: "Jinn-Network", name: "mono") {
${issues}
  }
}`;
}

// GitHub's GraphQL `repository.ref(qualifiedName:)` returns null forever for
// refs under a custom namespace like `refs/jinn-autopilot/...` — proven live
// (jinn-mono#1883-follow-up): a direct query against a ref that demonstrably
// exists via `git ls-remote` still resolves to null, while the identical
// query shape against `refs/heads/next` resolves fine. Every review-claim
// read below therefore goes over the git transport instead (the mechanism
// the live capability probe already validates — see capability-probe.ts).
export const REVIEW_CLAIM_REF_PREFIX = 'refs/jinn-autopilot/review-claims/v1/';
export const REVIEW_CLAIM_REF_GLOB = `${REVIEW_CLAIM_REF_PREFIX}*`;

/**
 * Parses `git ls-remote <remote> '<REVIEW_CLAIM_REF_GLOB>'` output into a
 * map of ref suffix (the text after the fixed prefix) -> OID. A line that
 * cannot be split into an exact (oid, ref) pair, or whose ref falls outside
 * the requested prefix, is a transport-level parsing failure and throws.
 * A well-formed ref under the prefix whose suffix is not a PR number (e.g. a
 * capability-probe's disposable `capability-<uuid>` ref, see
 * capability-probe.ts) is not itself malformed — callers filter by shape.
 */
export function parseReviewClaimRefGitListing(raw: string): Map<string, GitOid> {
  const trimmed = raw.trimEnd();
  const listing = new Map<string, GitOid>();
  if (trimmed.length === 0) return listing;
  for (const line of trimmed.split('\n')) {
    const fields = line.split('\t');
    const [oid, ref] = fields;
    if (
      fields.length !== 2
      || oid === undefined || oid.length === 0
      || ref === undefined || !ref.startsWith(REVIEW_CLAIM_REF_PREFIX)
    ) {
      throw new Error('Malformed git ls-remote output for review-claim refs');
    }
    listing.set(ref.slice(REVIEW_CLAIM_REF_PREFIX.length), gitOid(oid));
  }
  return listing;
}

function parseSingleReviewClaimRef(raw: string, ref: GitRefName): GitOid | null {
  const trimmed = raw.trimEnd();
  if (trimmed.length === 0) return null;
  const lines = trimmed.split('\n');
  if (lines.length !== 1) {
    throw new Error(`Review claim ${ref} ls-remote is ambiguous`);
  }
  const fields = lines[0]!.split('\t');
  const [oid, matchedRef] = fields;
  if (fields.length !== 2 || oid === undefined || oid.length === 0 || matchedRef !== ref) {
    throw new Error('Malformed git ls-remote output for review-claim ref');
  }
  return gitOid(oid);
}

/**
 * Single-issue targeted read of its Project item's `Status` / `Blocked on`
 * fields (jinn-mono#1883 cost defect): the same `fieldValueByName` shape the
 * world Project-board snapshot (`fetchProjectSnapshot`) reads for every
 * item, scoped to one issue via `Issue.projectItems` instead of paginating
 * the whole board (~91 pages measured on the live board).
 */
const PROJECT_ITEM_BY_ISSUE_QUERY = `query($number: Int!) {
  repository(owner: "Jinn-Network", name: "mono") {
    issue(number: $number) {
      projectItems(first: 10) {
        nodes {
          id
          project { number }
          status:    fieldValueByName(name: "Status")     { ... on ProjectV2ItemFieldSingleSelectValue { name } }
          blockedOn: fieldValueByName(name: "Blocked on") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
        }
      }
    }
  }
}`;

interface ProjectItemByIssueResponse {
  data: {
    repository: {
      issue: {
        projectItems: {
          nodes: Array<{
            id: string;
            project: { number: number };
            status: { name: string } | null;
            blockedOn: { name: string } | null;
          }>;
        };
      } | null;
    };
  };
}

const VALID_PROJECT_STATUS = new Set<string>([
  'Todo', 'In Progress', 'Human', 'In Review', 'Done',
]);
const VALID_BLOCKED_ON = new Set<string>(['Nothing', 'Human', 'Another issue']);

function parseProjectStatus(name: string | undefined): ProjectStatus | null {
  return name !== undefined && VALID_PROJECT_STATUS.has(name) ? (name as ProjectStatus) : null;
}

function parseBlockedOn(name: string | undefined): BlockedOn | null {
  return name !== undefined && VALID_BLOCKED_ON.has(name) ? (name as BlockedOn) : null;
}

interface GraphQlPage {
  data: {
    repository: {
      pullRequests: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: GraphQlPr[];
      };
    };
  };
}

interface GraphQlPrResponse {
  data: {
    repository: {
      pullRequest: GraphQlPr | null;
    };
  };
}

interface GraphQlPr {
  number: number;
  title: string;
  body: string;
  author: { login?: string } | null;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  isDraft: boolean;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  labels: {
    pageInfo: { hasNextPage: boolean };
    nodes: Array<{ name: string }>;
  };
  closingIssuesReferences: {
    pageInfo: { hasNextPage: boolean };
    nodes: Array<{ number: number }>;
  };
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  mergeStateStatus: string;
  mergedAt: string | null;
  mergeCommit: { oid: string } | null;
  commits: {
    pageInfo: { hasPreviousPage: boolean };
    nodes: Array<{ commit: { oid: string; committedDate: string; message: string } }>;
  };
  reviews: {
    pageInfo: { hasNextPage: boolean };
    nodes: Array<{
      author: { login?: string } | null;
      state: RawNativeReview['state'];
      commit: { oid: string } | null;
      body: string;
      submittedAt: string;
    }>;
  };
  comments: {
    pageInfo: { hasPreviousPage: boolean };
    nodes: Array<{ body: string; createdAt: string }>;
  };
  statusCheckRollup: {
    contexts: {
      pageInfo: { hasNextPage: boolean };
      nodes: Array<{
        __typename: 'CheckRun' | 'StatusContext';
        name?: string;
        status?: string;
        conclusion?: string | null;
        context?: string;
        state?: string;
      }>;
    };
  } | null;
}

interface GraphQlMergedPr {
  number: number;
  title: string;
  body: string;
  author: { login?: string } | null;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  isDraft: boolean;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  labels: {
    pageInfo: { hasNextPage: boolean };
    nodes: Array<{ name: string }>;
  };
  closingIssuesReferences: {
    pageInfo: { hasNextPage: boolean };
    nodes: Array<{ number: number }>;
  };
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  mergeStateStatus: string;
  mergedAt: string | null;
  mergeCommit: { oid: string } | null;
  commits: {
    nodes: Array<{ commit: { oid: string; committedDate: string } }>;
  };
}

interface MergedOutcomesResponse {
  data: {
    repository: Record<string, {
      closedByPullRequestsReferences: {
        pageInfo: { hasNextPage: boolean };
        nodes: GraphQlMergedPr[];
      };
    } | null>;
  };
}

function branchTrailers(message: string): string | null {
  return terminalBranchClaimTrailers(message);
}

function matchingBranchTrailers(
  message: string,
  issueNumber?: number,
  prNumber?: number,
): string | null {
  const trailers = branchTrailers(message);
  if (trailers === null) return null;
  const claim = decodeBranchClaimTrailers(trailers);
  if (issueNumber !== undefined && claim.issueNumber !== issueNumber) return null;
  if (
    prNumber !== undefined
    && claim.prNumber !== undefined
    && claim.prNumber !== prNumber
  ) {
    return null;
  }
  return trailers;
}

/**
 * Raised for evidence that is scoped to a single PR node and whose validity
 * depends on content any GitHub user can post (comments) or on a page-size
 * cap being exceeded (pagination truncation). Callers isolate this error to
 * the one PR it concerns instead of failing the whole snapshot read — see
 * `readPullRequests` / `readMergedOutcomes`.
 */
export class PrEvidenceInconsistentError extends Error {
  constructor(readonly prNumber: number, message: string) {
    super(message);
    this.name = 'PrEvidenceInconsistentError';
  }
}

function toErrorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function assertCompletePrNode(pr: GraphQlPr): void {
  if (pr.labels.pageInfo.hasNextPage) {
    throw new PrEvidenceInconsistentError(pr.number, `PR #${pr.number} labels were truncated`);
  }
  if (pr.closingIssuesReferences.pageInfo.hasNextPage) {
    throw new PrEvidenceInconsistentError(
      pr.number,
      `PR #${pr.number} closing issue references were truncated`,
    );
  }
  if (pr.reviews.pageInfo.hasNextPage) {
    throw new PrEvidenceInconsistentError(pr.number, `PR #${pr.number} reviews were truncated`);
  }
  if (pr.comments.pageInfo.hasPreviousPage) {
    throw new PrEvidenceInconsistentError(pr.number, `PR #${pr.number} comments were truncated`);
  }
  if (pr.statusCheckRollup?.contexts.pageInfo.hasNextPage === true) {
    throw new PrEvidenceInconsistentError(pr.number, `PR #${pr.number} checks were truncated`);
  }
}

/**
 * Per-PR completeness check for the merged-outcomes decode path
 * (`readMergedOutcomes`), mirroring `assertCompleteMergedPrNode`'s
 * open-PR sibling `assertCompletePrNode`. Raises `PrEvidenceInconsistentError`
 * so the caller can skip just this one merged PR's contribution instead of
 * failing the whole snapshot (jinn-mono#1883-follow-up: PR #1710 — a real
 * merged PR whose branch was garbage-collected post-merge — was tripping a
 * bare `Error` here and halting every v2 cycle).
 */
function assertCompleteMergedPrNode(pr: GraphQlMergedPr): void {
  if (pr.labels.pageInfo.hasNextPage) {
    throw new PrEvidenceInconsistentError(pr.number, `PR #${pr.number} labels were truncated`);
  }
  if (pr.closingIssuesReferences.pageInfo.hasNextPage) {
    throw new PrEvidenceInconsistentError(
      pr.number,
      `PR #${pr.number} closing issue references were truncated`,
    );
  }
}

/**
 * Decodes one merged-outcomes PR node, or raises `PrEvidenceInconsistentError`
 * when its evidence can't be trusted (truncated pagination, or a head commit
 * that no longer matches `headRefOid` — e.g. a merged PR whose branch was
 * garbage-collected). Callers must skip the PR on that error rather than
 * assert a Done projection from unverifiable data. Callers must only invoke
 * this for a node already known to be in the `MERGED` state (the caller's
 * OPEN/CLOSED branches are handled separately).
 */
function rawMergedPullRequest(pr: GraphQlMergedPr): RawPullRequest {
  assertCompleteMergedPrNode(pr);
  const latest = pr.commits.nodes.at(-1)?.commit;
  if (latest === undefined || latest.oid !== pr.headRefOid) {
    throw new PrEvidenceInconsistentError(
      pr.number,
      `PR #${pr.number} is missing its exact merged head commit`,
    );
  }
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body,
    author: pr.author?.login ?? '',
    baseRefName: pr.baseRefName,
    headRefName: pr.headRefName,
    headOid: pr.headRefOid,
    headCommittedAt: latest.committedDate,
    isDraft: pr.isDraft,
    state: 'MERGED',
    labels: pr.labels.nodes.map((label) => label.name),
    closingIssueNumbers: pr.closingIssuesReferences.nodes.map((issue) => issue.number),
    mergeability: pr.mergeable,
    mergeStateStatus: pr.mergeStateStatus,
    checks: [],
    reviews: [],
    branchClaimTrailers: null,
    reviewClaim: null,
    humanIssueNumber: null,
    humanReason: null,
    mergedAt: pr.mergedAt,
    mergeCommitOid: pr.mergeCommit?.oid ?? null,
  };
}

function inconsistentPullRequest(pr: GraphQlPr, detail: string): RawPullRequest {
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body,
    author: pr.author?.login ?? '',
    baseRefName: pr.baseRefName,
    headRefName: pr.headRefName,
    headOid: pr.headRefOid,
    headCommittedAt: pr.commits.nodes.at(-1)?.commit.committedDate ?? new Date(0).toISOString(),
    isDraft: pr.isDraft,
    state: 'OPEN',
    labels: pr.labels.nodes.map((label) => label.name),
    closingIssueNumbers: pr.closingIssuesReferences.nodes.map((issue) => issue.number),
    mergeability: pr.mergeable,
    mergeStateStatus: pr.mergeStateStatus,
    checks: [],
    reviews: [],
    branchClaimTrailers: null,
    reviewClaim: null,
    humanIssueNumber: null,
    humanReason: { phase: 'awaiting-review', code: 'review-escalation', detail },
    mergedAt: pr.mergedAt,
    mergeCommitOid: pr.mergeCommit?.oid ?? null,
  };
}

function checks(pr: GraphQlPr): RawPullRequest['checks'] {
  return (pr.statusCheckRollup?.contexts.nodes ?? []).map((node) => (
    node.__typename === 'CheckRun'
      ? {
          name: node.name ?? '',
          status: node.status ?? 'UNKNOWN',
          conclusion: node.conclusion ?? null,
        }
      : {
          name: node.context ?? '',
          status: 'COMPLETED',
          conclusion: node.state ?? null,
        }
  ));
}

export interface GhLifecycleReaderOptions {
  /**
   * Local checkout the git-transport review-claim reads run against
   * (`git -C <repositoryPath> ...`). Defaults to `.` (the process cwd) —
   * production callers (scripts/run-autopilot-v2.ts) always pass the
   * coordinator's own worktree root explicitly.
   */
  readonly repositoryPath?: string;
  /**
   * Remote argument for `ls-remote`/`fetch` — accepts either a configured
   * remote name or a bare URL (git treats both identically). Defaults to
   * the canonical HTTPS URL directly so review-claim reads need no local
   * `git remote add` precondition and work in every mode (observe/recover
   * run this before the runbook's "configure jinn-autopilot-v2" step).
   */
  readonly remoteName?: string;
}

export class GhLifecycleReader implements GitHubLifecycleReader {
  private readonly issues: GhIssueSource;
  private readonly repositoryPath: string;
  private readonly remoteName: string;
  // Review-claim metadata commits are content-addressed and append-only: an
  // OID's payload never changes, so this cache never needs invalidation for
  // the life of the reader (jinn-mono#1883-follow-up).
  private readonly reviewClaimPayloadByOid = new Map<GitOid, string>();
  private readonly ancestryByCandidate = new Map<string, Promise<{
    readonly headCommittedAt: string;
    readonly claimTrailers: string | null;
    readonly completionSummary: string | null;
  }>>();

  constructor(
    private readonly run: CommandRunner = defaultRunner,
    options: GhLifecycleReaderOptions = {},
  ) {
    this.issues = new GhIssueSource(run);
    this.repositoryPath = options.repositoryPath ?? '.';
    this.remoteName = options.remoteName ?? CANONICAL_GITHUB_HTTPS_REMOTE;
  }

  readProjectSnapshot(): Promise<ProjectSnapshot> {
    return fetchProjectSnapshot(this.run);
  }

  async readIssues(board: IssueBoardState) {
    const issues = await this.issues.poll(board);
    if (issues.length >= 200) {
      throw new Error(
        'Open issue source reached its 200-item limit; refusing a potentially truncated snapshot',
      );
    }
    return issues;
  }

  private gitRun(args: string[]): Promise<string> {
    // GIT_TERMINAL_PROMPT=0: these reads never need a credential (the
    // review-claims repo is public); fail fast instead of hanging if a
    // misconfigured transport ever tries to prompt for one.
    return this.run('git', ['-C', this.repositoryPath, ...args], {
      env: { GIT_TERMINAL_PROMPT: '0' },
    });
  }

  /**
   * One `git ls-remote` for every review-claim ref, replacing the N
   * per-PR GraphQL `ref(qualifiedName:)` reads that GitHub permanently
   * returns null for (jinn-mono#1883-follow-up). Called once per
   * `readPullRequests` page and shared across its open + merged-outcome PRs.
   */
  private async listReviewClaimRefs(): Promise<Map<number, GitOid>> {
    const raw = await this.gitRun(['ls-remote', this.remoteName, REVIEW_CLAIM_REF_GLOB]);
    const bySuffix = parseReviewClaimRefGitListing(raw);
    const byPrNumber = new Map<number, GitOid>();
    for (const [suffix, oid] of bySuffix) {
      if (/^[1-9][0-9]*$/.test(suffix)) byPrNumber.set(Number(suffix), oid);
    }
    return byPrNumber;
  }

  /** Targeted single-ref read for the reconciliation single-PR path. */
  private async readSingleReviewClaimRef(ref: GitRefName): Promise<GitOid | null> {
    const raw = await this.gitRun(['ls-remote', this.remoteName, ref]);
    return parseSingleReviewClaimRef(raw, ref);
  }

  private async objectExistsLocally(oid: GitOid): Promise<boolean> {
    try {
      await this.gitRun(['cat-file', '-e', oid]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Reads the `jinn-autopilot-review.json` payload for a review-claim
   * commit OID, fetching it over git only on a local cache miss (an OID
   * already present locally — e.g. just pushed by this same process —
   * costs no network call). Cached by OID afterward: content-addressed,
   * append-only, so an OID's payload never needs refetching.
   */
  private async readReviewClaimPayload(ref: GitRefName, oid: GitOid): Promise<string> {
    const cached = this.reviewClaimPayloadByOid.get(oid);
    if (cached !== undefined) return cached;
    if (!(await this.objectExistsLocally(oid))) {
      await this.gitRun(['fetch', '--no-tags', '--depth=1', this.remoteName, ref]);
    }
    let payload: string;
    try {
      payload = await this.gitRun(['cat-file', '-p', `${oid}:${REVIEW_CLAIM_PAYLOAD_FILE}`]);
    } catch {
      throw new Error(`Review claim ${ref} is missing ${REVIEW_CLAIM_PAYLOAD_FILE}`);
    }
    this.reviewClaimPayloadByOid.set(oid, payload);
    return payload;
  }

  private async reviewClaim(
    prNumber: number,
    listing?: ReadonlyMap<number, GitOid>,
  ): Promise<RawPullRequest['reviewClaim']> {
    const ref = reviewClaimRef(prNumber);
    const oid = listing !== undefined
      ? listing.get(prNumber) ?? null
      : await this.readSingleReviewClaimRef(ref);
    if (oid === null) return null;
    const payload = await this.readReviewClaimPayload(ref, oid);
    return { oid, payload };
  }

  private branchAncestry(
    headOid: string,
    issueNumber?: number,
    prNumber?: number,
  ): Promise<{
    readonly headCommittedAt: string;
    readonly claimTrailers: string | null;
    readonly completionSummary: string | null;
  }> {
    const cacheKey = `${headOid}:${issueNumber ?? '*'}:${prNumber ?? '*'}`;
    const cached = this.ancestryByCandidate.get(cacheKey);
    if (cached !== undefined) return cached;
    const pending = this.readBranchAncestry(headOid, issueNumber, prNumber)
      .catch((error: unknown) => {
        this.ancestryByCandidate.delete(cacheKey);
        throw error;
      });
    this.ancestryByCandidate.set(cacheKey, pending);
    return pending;
  }

  private async readBranchAncestry(
    headOid: string,
    issueNumber?: number,
    prNumber?: number,
  ): Promise<{
    readonly headCommittedAt: string;
    readonly claimTrailers: string | null;
    readonly completionSummary: string | null;
  }> {
    let headCommittedAt: string | undefined;
    for (let page = 1; page <= MAX_COMMIT_HISTORY_PAGES; page += 1) {
      const endpoint = `repos/${REPO}/commits?sha=${encodeURIComponent(headOid)}`
        + `&per_page=${COMMIT_HISTORY_PAGE_SIZE}&page=${page}`;
      const raw = await this.run('gh', ['api', endpoint]);
      const commits = JSON.parse(raw) as Array<{
        sha?: string;
        commit?: { message?: string; committer?: { date?: string } };
      }>;
      if (!Array.isArray(commits)) throw new Error(`Branch ${headOid} ancestry is malformed`);
      if (page === 1) {
        const head = commits[0];
        if (head?.sha !== headOid) {
          throw new Error(`Branch ${headOid} ancestry is missing its exact head`);
        }
        headCommittedAt = head.commit?.committer?.date;
        if (typeof headCommittedAt !== 'string') {
          throw new Error(`Branch ${headOid} is missing its GitHub commit time`);
        }
      }
      const evidence = commits
        .map((commit) => {
          const message = commit.commit?.message ?? '';
          const claimTrailers = matchingBranchTrailers(message, issueNumber, prNumber);
          return claimTrailers === null
            ? null
            : {
                claimTrailers,
                completionSummary: extractImplementationCompletionSummary(
                  message,
                  claimTrailers,
                ),
              };
        })
        .find((candidate) => candidate !== null) ?? null;
      if (evidence !== null) return { headCommittedAt: headCommittedAt!, ...evidence };
      if (commits.length < COMMIT_HISTORY_PAGE_SIZE) {
        return {
          headCommittedAt: headCommittedAt!,
          claimTrailers: null,
          completionSummary: null,
        };
      }
    }
    throw new Error(`Branch ${headOid} ancestry pagination exceeded safety limit`);
  }

  private async rawPullRequest(
    pr: GraphQlPr,
    includeReviewClaim: boolean,
    reviewClaimListing?: ReadonlyMap<number, GitOid>,
  ): Promise<RawPullRequest> {
    if (pr.state === 'CLOSED') {
      throw new Error(`Closed-unmerged PR #${pr.number} is not an active lifecycle item`);
    }
    assertCompletePrNode(pr);
    const latest = pr.commits.nodes.at(-1)?.commit;
    if (latest === undefined || latest.oid !== pr.headRefOid) {
      throw new Error(`PR #${pr.number} is missing its exact current head commit`);
    }
    const branchIssues = new Set(pr.closingIssuesReferences.nodes.map((issue) => issue.number));
    const stableMatch = /^autopilot\/([1-9][0-9]*)$/.exec(pr.headRefName);
    if (stableMatch !== null) branchIssues.add(Number(stableMatch[1]));
    const branchIssue = branchIssues.size === 1 ? [...branchIssues][0] : undefined;
    let claimEvidence = [...pr.commits.nodes]
      .reverse()
      .map((node) => {
        const claimTrailers = matchingBranchTrailers(
          node.commit.message,
          branchIssue,
          pr.number,
        );
        return claimTrailers === null
          ? null
          : {
              claimTrailers,
              completionSummary: extractImplementationCompletionSummary(
                node.commit.message,
                claimTrailers,
              ),
            };
      })
      .find((candidate) => candidate !== null) ?? null;
    if (claimEvidence === null && includeReviewClaim && pr.commits.pageInfo.hasPreviousPage) {
      const ancestry = await this.branchAncestry(pr.headRefOid, branchIssue, pr.number);
      if (ancestry.claimTrailers !== null) {
        claimEvidence = {
          claimTrailers: ancestry.claimTrailers,
          completionSummary: ancestry.completionSummary,
        };
      }
    }
    const reviews: RawNativeReview[] = pr.reviews.nodes.map((review) => {
      if (review.commit === null) {
        throw new Error(`PR #${pr.number} review is missing exact commit_id`);
      }
      return {
        reviewer: review.author?.login ?? '',
        state: review.state,
        commitId: review.commit.oid,
        body: review.body,
        submittedAt: review.submittedAt,
      };
    });
    let humanEvidence: ReturnType<typeof parseHumanCommentEvidence> | undefined;
    try {
      humanEvidence = [...pr.comments.nodes]
        .reverse()
        .map((comment) => parseHumanCommentEvidence(comment.body))
        .find((evidence) => evidence !== null);
    } catch (cause) {
      throw new PrEvidenceInconsistentError(
        pr.number,
        `PR #${pr.number} has undecodable structured Human evidence: ${toErrorMessage(cause)}`,
      );
    }
    if (humanEvidence !== undefined && humanEvidence.prNumber !== pr.number) {
      throw new PrEvidenceInconsistentError(
        pr.number,
        `PR #${pr.number} has contradictory structured Human evidence`,
      );
    }
    return {
      number: pr.number,
      title: pr.title,
      body: pr.body,
      author: pr.author?.login ?? '',
      baseRefName: pr.baseRefName,
      headRefName: pr.headRefName,
      headOid: pr.headRefOid,
      headCommittedAt: latest.committedDate,
      isDraft: pr.isDraft,
      state: pr.state,
      labels: pr.labels.nodes.map((label) => label.name),
      closingIssueNumbers: pr.closingIssuesReferences.nodes.map((issue) => issue.number),
      mergeability: pr.mergeable,
      mergeStateStatus: pr.mergeStateStatus,
      checks: checks(pr),
      reviews,
      branchClaimTrailers: claimEvidence?.claimTrailers ?? null,
      implementationCompletionSummary: claimEvidence?.completionSummary ?? null,
      reviewClaim: includeReviewClaim
        ? await this.reviewClaim(pr.number, reviewClaimListing)
        : null,
      humanIssueNumber: humanEvidence?.issueNumber ?? null,
      humanReason: humanEvidence?.reason ?? null,
      mergedAt: pr.mergedAt,
      mergeCommitOid: pr.mergeCommit?.oid ?? null,
    };
  }

  private async readMergedOutcomes(
    nonDoneIssueNumbers: readonly number[],
    reviewClaimListing: ReadonlyMap<number, GitOid>,
  ): Promise<RawPullRequest[]> {
    const unique = [...new Set(nonDoneIssueNumbers)].sort((left, right) => left - right);
    for (const number of unique) {
      if (!Number.isSafeInteger(number) || number <= 0) throw new Error('Invalid issue number');
    }
    const merged: RawPullRequest[] = [];
    for (let offset = 0; offset < unique.length; offset += MERGED_ISSUE_BATCH_SIZE) {
      const batch = unique.slice(offset, offset + MERGED_ISSUE_BATCH_SIZE);
      const query = mergedOutcomesQuery(batch);
      const raw = await this.run('gh', ['api', 'graphql', '-f', `query=${query}`]);
      const response = JSON.parse(raw) as MergedOutcomesResponse;
      for (const number of batch) {
        const connection = response.data.repository[`issue${number}`]
          ?.closedByPullRequestsReferences;
        if (connection === undefined) continue;
        if (connection.pageInfo.hasNextPage) {
          // Pagination cap on this one issue's closing-PR connection — skip only
          // this issue's merged-outcome contribution, not the whole batch/snapshot.
          console.warn(
            `[github-reader] skipping merged outcomes for issue #${number} (continuing): `
              + `closing PR outcomes were truncated`,
          );
          continue;
        }
        for (const pr of connection.nodes) {
          if (pr.state === 'OPEN') {
            if (pr.labels.nodes.some((label) => label.name === 'engine:review')) continue;
            const full = await this.readPullRequestByNumber(pr.number);
            if (full.state !== 'OPEN') continue;
            merged.push(
              await this.rawPullRequest(full, true, reviewClaimListing).catch((error: unknown) => {
                if (!(error instanceof PrEvidenceInconsistentError)) throw error;
                return inconsistentPullRequest(full, error.message);
              }),
            );
            continue;
          }
          if (pr.state === 'CLOSED') continue;
          // A single merged PR's evidence (truncated pagination, or a head
          // commit that no longer matches headRefOid — e.g. a garbage-collected
          // branch, see PR #1710) must not abort the whole snapshot. Skip just
          // this PR's contribution to merged outcomes: we cannot verify it, so
          // we must not assert a Done projection from it (fail-closed-safe).
          try {
            merged.push(rawMergedPullRequest(pr));
          } catch (error: unknown) {
            if (!(error instanceof PrEvidenceInconsistentError)) throw error;
            console.warn(
              `[github-reader] skipping merged PR #${pr.number} evidence (continuing): `
                + error.message,
            );
          }
        }
      }
    }
    return merged;
  }

  private async readPullRequestByNumber(prNumber: number): Promise<GraphQlPr> {
    const raw = await this.run('gh', [
      'api', 'graphql',
      '-f', `query=${PR_BY_NUMBER_QUERY}`,
      '-F', `number=${prNumber}`,
    ]);
    const response = JSON.parse(raw) as GraphQlPrResponse;
    const pr = response.data.repository.pullRequest;
    if (pr === null) throw new Error(`PR #${prNumber} disappeared during lifecycle read`);
    return pr;
  }

  /**
   * Single-PR read for reconciliation exact-state pre-checks/read-backs
   * (jinn-mono#1883 cost defect): the same per-node GraphQL shape and
   * review-claim ref read (`readPullRequestByNumber` / `reviewClaim`) the
   * world snapshot uses for each PR, without walking the whole open-PR +
   * Project graph to inspect one. ~7-8 GraphQL points versus ~390 for a full
   * `buildGitHubLifecycleSnapshot` call. Returns `null` for a PR that is not
   * open or merged (closed-unmerged is not an active lifecycle item, matching
   * how the world snapshot already excludes it).
   */
  async readPullRequestForReconciliation(prNumber: number): Promise<RawPullRequest | null> {
    const raw = await this.readPullRequestByNumber(prNumber);
    if (raw.state === 'CLOSED') return null;
    return this.rawPullRequest(raw, true).catch((error: unknown) => {
      if (!(error instanceof PrEvidenceInconsistentError)) throw error;
      return inconsistentPullRequest(raw, error.message);
    });
  }

  /**
   * Single-issue read of its Project item's `id` / `Status` / `Blocked on`
   * (jinn-mono#1883 cost defect): a targeted `Issue.projectItems` lookup
   * instead of paginating the whole Project board to find one item.
   * Returns `null` when the issue has no item on this Project.
   */
  async readProjectItemForReconciliation(issueNumber: number): Promise<{
    readonly id: string;
    readonly status: ProjectStatus | null;
    readonly blockedOn: BlockedOn | null;
  } | null> {
    const raw = await this.run('gh', [
      'api', 'graphql',
      '-f', `query=${PROJECT_ITEM_BY_ISSUE_QUERY}`,
      '-F', `number=${issueNumber}`,
    ]);
    const response = JSON.parse(raw) as ProjectItemByIssueResponse;
    const nodes = response.data.repository.issue?.projectItems.nodes ?? [];
    const node = nodes.find((candidate) => candidate.project.number === PROJECT_NUMBER);
    if (node === undefined) return null;
    return {
      id: node.id,
      status: parseProjectStatus(node.status?.name),
      blockedOn: parseBlockedOn(node.blockedOn?.name),
    };
  }

  async readPullRequests(
    cursor: string | null,
    nonDoneIssueNumbers: readonly number[] = [],
  ): Promise<PullRequestPage> {
    const args = ['api', 'graphql', '-f', `query=${PR_QUERY}`];
    if (cursor !== null) args.push('-F', `cursor=${cursor}`);
    const raw = await this.run('gh', args);
    const response = JSON.parse(raw) as GraphQlPage;
    const connection = response.data.repository.pullRequests;
    // One git-transport listing serves every open + merged-outcome PR's
    // review-claim lookup below (jinn-mono#1883-follow-up) instead of one
    // GraphQL ref read per PR.
    const reviewClaimListing = await this.listReviewClaimRefs();
    const openNodes = await Promise.all(connection.nodes.map((pr) => (
      this.rawPullRequest(pr, true, reviewClaimListing).catch((error: unknown) => {
        if (!(error instanceof PrEvidenceInconsistentError)) throw error;
        return inconsistentPullRequest(pr, error.message);
      })
    )));
    const mergedNodes = cursor === null
      ? await this.readMergedOutcomes(nonDoneIssueNumbers, reviewClaimListing)
      : [];
    const byNumber = new Map<number, RawPullRequest>();
    for (const pr of [...openNodes, ...mergedNodes]) {
      if (!byNumber.has(pr.number)) byNumber.set(pr.number, pr);
    }
    return { nodes: [...byNumber.values()], pageInfo: connection.pageInfo };
  }

  async readBranchClaims(): Promise<readonly RawBranchClaim[]> {
    const raw = await this.run('gh', [
      'api',
      `repos/${REPO}/git/matching-refs/heads/autopilot/`,
      '--paginate',
      '--slurp',
    ]);
    const parsed = JSON.parse(raw) as unknown;
    const pages = Array.isArray(parsed) ? parsed : [];
    const refs = pages.flatMap((page) => Array.isArray(page) ? page : []) as Array<{
      ref?: string;
      object?: { sha?: string };
    }>;
    const claims: RawBranchClaim[] = [];
    for (const ref of refs) {
      const name = ref.ref;
      const oid = ref.object?.sha;
      const match = /^refs\/heads\/autopilot\/([1-9][0-9]*)$/.exec(name ?? '');
      if (match === null || oid === undefined) continue;
      const issueNumber = Number(match[1]);
      const ancestry = await this.branchAncestry(oid, issueNumber);
      const trailers = ancestry.claimTrailers;
      if (trailers === null) continue;
      claims.push({
        issueNumber,
        headRefName: `autopilot/${match[1]}`,
        headOid: oid,
        headCommittedAt: ancestry.headCommittedAt,
        claimTrailers: trailers,
        implementationCompletionSummary: ancestry.completionSummary,
      });
    }
    return claims;
  }
}

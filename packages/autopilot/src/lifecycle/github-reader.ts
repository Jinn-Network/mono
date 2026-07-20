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
import { REPO } from '../dispatcher/constants.js';
import type {
  GitHubLifecycleReader,
  PullRequestPage,
  RawBranchClaim,
  RawNativeReview,
  RawPullRequest,
} from './snapshot.js';
import { parseHumanCommentEvidence } from './codecs.js';

export const REVIEW_CLAIM_PAYLOAD_FILE = 'jinn-autopilot-review.json';
const PR_PAGE_SIZE = 50;
const MERGED_ISSUE_BATCH_SIZE = 20;

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

function mergedOutcomesQuery(issueNumbers: readonly number[]): string {
  const issues = issueNumbers.map((number) => `
    issue${number}: issue(number: ${number}) {
      closedByPullRequestsReferences(first: 100) {
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

const REVIEW_REF_QUERY = `query($ref: String!) {
  repository(owner: "Jinn-Network", name: "mono") {
    ref(qualifiedName: $ref) {
      target {
        oid
        ... on Commit {
          tree {
            entries {
              name
              object {
                ... on Blob { text }
              }
            }
          }
        }
      }
    }
  }
}`;

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

interface GraphQlPr {
  number: number;
  title: string;
  body: string;
  author: { login?: string } | null;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  isDraft: boolean;
  state: 'OPEN' | 'MERGED';
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
  state: 'OPEN' | 'MERGED';
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

interface ReviewRefResponse {
  data: {
    repository: {
      ref: {
        target: {
          oid: string;
          tree: {
            entries: Array<{
              name: string;
              object: { text?: string | null } | null;
            }>;
          };
        };
      } | null;
    };
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
  const lines = message
    .split('\n')
    .filter((line) => line.startsWith('Jinn-Autopilot-'));
  return lines.some((line) => line === 'Jinn-Autopilot-Protocol: 2')
    ? lines.join('\n')
    : null;
}

function assertCompletePrNode(pr: GraphQlPr): void {
  if (pr.labels.pageInfo.hasNextPage) {
    throw new Error(`PR #${pr.number} labels were truncated`);
  }
  if (pr.closingIssuesReferences.pageInfo.hasNextPage) {
    throw new Error(`PR #${pr.number} closing issue references were truncated`);
  }
  if (pr.reviews.pageInfo.hasNextPage) {
    throw new Error(`PR #${pr.number} reviews were truncated`);
  }
  if (pr.comments.pageInfo.hasPreviousPage) {
    throw new Error(`PR #${pr.number} comments were truncated`);
  }
  if (pr.statusCheckRollup?.contexts.pageInfo.hasNextPage === true) {
    throw new Error(`PR #${pr.number} checks were truncated`);
  }
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

export class GhLifecycleReader implements GitHubLifecycleReader {
  private readonly issues: GhIssueSource;

  constructor(private readonly run: CommandRunner = defaultRunner) {
    this.issues = new GhIssueSource(run);
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

  private async reviewClaim(prNumber: number): Promise<RawPullRequest['reviewClaim']> {
    const ref = `refs/jinn-autopilot/review-claims/v1/${prNumber}`;
    const raw = await this.run('gh', [
      'api', 'graphql',
      '-f', `query=${REVIEW_REF_QUERY}`,
      '-F', `ref=${ref}`,
    ]);
    const response = JSON.parse(raw) as ReviewRefResponse;
    const target = response.data.repository.ref?.target;
    if (target === undefined) return null;
    const entry = target.tree.entries.find(
      (candidate) => candidate.name === REVIEW_CLAIM_PAYLOAD_FILE,
    );
    const payload = entry?.object?.text;
    if (typeof payload !== 'string') {
      throw new Error(`Review claim ${ref} is missing ${REVIEW_CLAIM_PAYLOAD_FILE}`);
    }
    return { oid: target.oid, payload };
  }

  private async rawPullRequest(
    pr: GraphQlPr,
    includeReviewClaim: boolean,
  ): Promise<RawPullRequest> {
    assertCompletePrNode(pr);
    const latest = pr.commits.nodes.at(-1)?.commit;
    if (latest === undefined || latest.oid !== pr.headRefOid) {
      throw new Error(`PR #${pr.number} is missing its exact current head commit`);
    }
    const claimTrailers = [...pr.commits.nodes]
      .reverse()
      .map((node) => branchTrailers(node.commit.message))
      .find((trailers) => trailers !== null) ?? null;
    if (
      claimTrailers === null
      && includeReviewClaim
      && pr.commits.pageInfo.hasPreviousPage
      && /^autopilot\/[1-9][0-9]*$/.test(pr.headRefName)
    ) {
      throw new Error(`PR #${pr.number} history was truncated before its v2 branch claim`);
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
    const humanEvidence = [...pr.comments.nodes]
      .reverse()
      .map((comment) => parseHumanCommentEvidence(comment.body))
      .find((evidence) => evidence !== null);
    if (humanEvidence !== undefined && humanEvidence.prNumber !== pr.number) {
      throw new Error(`PR #${pr.number} has contradictory structured Human evidence`);
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
      branchClaimTrailers: claimTrailers,
      reviewClaim: includeReviewClaim ? await this.reviewClaim(pr.number) : null,
      humanReason: humanEvidence?.reason ?? null,
      mergedAt: pr.mergedAt,
      mergeCommitOid: pr.mergeCommit?.oid ?? null,
    };
  }

  private async readMergedOutcomes(
    nonDoneIssueNumbers: readonly number[],
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
          throw new Error(`Issue #${number} closing PR outcomes were truncated`);
        }
        for (const pr of connection.nodes) {
          if (pr.state !== 'MERGED') continue;
          if (pr.labels.pageInfo.hasNextPage) {
            throw new Error(`PR #${pr.number} labels were truncated`);
          }
          if (pr.closingIssuesReferences.pageInfo.hasNextPage) {
            throw new Error(`PR #${pr.number} closing issue references were truncated`);
          }
          const latest = pr.commits.nodes.at(-1)?.commit;
          if (latest === undefined || latest.oid !== pr.headRefOid) {
            throw new Error(`PR #${pr.number} is missing its exact merged head commit`);
          }
          merged.push({
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
            checks: [],
            reviews: [],
            branchClaimTrailers: null,
            reviewClaim: null,
            humanReason: null,
            mergedAt: pr.mergedAt,
            mergeCommitOid: pr.mergeCommit?.oid ?? null,
          });
        }
      }
    }
    return merged;
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
    const openNodes = await Promise.all(connection.nodes.map((pr) => (
      this.rawPullRequest(pr, true)
    )));
    const mergedNodes = cursor === null
      ? await this.readMergedOutcomes(nonDoneIssueNumbers)
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
      const commitRaw = await this.run('gh', ['api', `repos/${REPO}/commits/${oid}`]);
      const commit = JSON.parse(commitRaw) as {
        commit?: { message?: string; committer?: { date?: string } };
      };
      const trailers = branchTrailers(commit.commit?.message ?? '');
      if (trailers === null) continue;
      claims.push({
        issueNumber: Number(match[1]),
        headRefName: `autopilot/${match[1]}`,
        headOid: oid,
        headCommittedAt: commit.commit?.committer?.date ?? '',
        claimTrailers: trailers,
      });
    }
    return claims;
  }
}

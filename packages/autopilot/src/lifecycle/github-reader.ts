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

export const REVIEW_CLAIM_PAYLOAD_FILE = 'jinn-autopilot-review.json';
const PR_PAGE_SIZE = 50;

const PR_QUERY = `query($cursor: String) {
  repository(owner: "Jinn-Network", name: "mono") {
    pullRequests(first: ${PR_PAGE_SIZE}, after: $cursor, states: [OPEN, MERGED], orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
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
        statusCheckRollup {
          contexts(first: 100) {
            pageInfo { hasNextPage }
            nodes {
              __typename
              ... on CheckRun { name status conclusion }
              ... on StatusContext { context state }
            }
          }
        }
      }
    }
  }
}`;

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

  async readPullRequests(cursor: string | null): Promise<PullRequestPage> {
    const args = ['api', 'graphql', '-f', `query=${PR_QUERY}`];
    if (cursor !== null) args.push('-F', `cursor=${cursor}`);
    const raw = await this.run('gh', args);
    const response = JSON.parse(raw) as GraphQlPage;
    const connection = response.data.repository.pullRequests;
    const nodes = await Promise.all(connection.nodes.map(async (pr): Promise<RawPullRequest> => {
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
        reviewClaim: await this.reviewClaim(pr.number),
        humanReason: null,
        mergedAt: pr.mergedAt,
        mergeCommitOid: pr.mergeCommit?.oid ?? null,
      };
    }));
    return { nodes, pageInfo: connection.pageInfo };
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

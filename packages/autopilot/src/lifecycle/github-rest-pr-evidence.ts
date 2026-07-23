import { REPO } from '../dispatcher/constants.js';
import { parseHumanCommentEvidence } from './codecs.js';
import { GitHubRestSchemaError } from './github-rest-discovery.js';
import type { ConditionalRestClient, ConditionalRestResponse } from './github-rest.js';
import type { PullRequestEvidenceProbe } from './incremental-snapshot-source.js';
import type {
  CheckSummary,
  NativeReviewSnapshot,
  NativeReviewState,
  PullRequestSnapshot,
} from './snapshot.js';
import { gitOid } from './types.js';

function record(value: unknown, subject: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GitHubRestSchemaError(`${subject} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rows(value: unknown, subject: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new GitHubRestSchemaError(`${subject} must be an array`);
  return value;
}

function string(value: unknown, subject: string): string {
  if (typeof value !== 'string') throw new GitHubRestSchemaError(`${subject} must be a string`);
  return value;
}

function nonEmptyString(value: unknown, subject: string): string {
  const decoded = string(value, subject);
  if (decoded.length === 0) throw new GitHubRestSchemaError(`${subject} must not be empty`);
  return decoded;
}

function nonNegativeInteger(value: unknown, subject: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new GitHubRestSchemaError(`${subject} must be a non-negative integer`);
  }
  return value as number;
}

function exactTimestamp(value: unknown, subject: string): string {
  const decoded = nonEmptyString(value, subject);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/
    .exec(decoded);
  if (match === null) throw new GitHubRestSchemaError(`${subject} must be an exact UTC timestamp`);
  const parts = match.slice(1).map((part) => Number(part ?? '0'));
  const parsed = new Date(Date.parse(decoded));
  if (
    !Number.isFinite(parsed.getTime())
    || parsed.getUTCFullYear() !== parts[0]
    || parsed.getUTCMonth() + 1 !== parts[1]
    || parsed.getUTCDate() !== parts[2]
    || parsed.getUTCHours() !== parts[3]
    || parsed.getUTCMinutes() !== parts[4]
    || parsed.getUTCSeconds() !== parts[5]
    || parsed.getUTCMilliseconds() !== parts[6]
  ) {
    throw new GitHubRestSchemaError(`${subject} contains an impossible calendar value`);
  }
  return decoded;
}

function completeBody(response: ConditionalRestResponse, subject: string): unknown {
  if (response.nextEndpoint !== null) {
    throw new GitHubRestSchemaError(`${subject} pagination is truncated`);
  }
  return response.body;
}

function reviews(value: unknown): readonly NativeReviewSnapshot[] {
  const validStates = new Set<NativeReviewState>([
    'APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING',
  ]);
  return rows(value, 'PR reviews').map((raw, index): NativeReviewSnapshot => {
    const review = record(raw, `PR review ${index}`);
    const user = record(review.user, `PR review ${index}.user`);
    const state = nonEmptyString(review.state, `PR review ${index}.state`);
    if (!validStates.has(state as NativeReviewState)) {
      throw new GitHubRestSchemaError(`PR review ${index}.state is unknown`);
    }
    return {
      reviewer: nonEmptyString(user.login, `PR review ${index}.user.login`),
      state: state as NativeReviewState,
      commitId: gitOid(nonEmptyString(review.commit_id, `PR review ${index}.commit_id`)),
      body: string(review.body, `PR review ${index}.body`),
      submittedAt: exactTimestamp(review.submitted_at, `PR review ${index}.submitted_at`),
    };
  });
}

function exactPullRequestDetail(
  value: unknown,
  expected: PullRequestSnapshot,
): {
  readonly title: string;
  readonly body: string;
  readonly author: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly isDraft: boolean;
  readonly state: 'OPEN' | 'CLOSED';
  readonly labels: readonly string[];
  readonly mergeability: PullRequestSnapshot['mergeability'];
  readonly mergeStateStatus: string;
} {
  const detail = record(value, 'PR detail');
  if (detail.number !== expected.number) {
    throw new GitHubRestSchemaError(
      `PR detail identity #${String(detail.number)} does not match #${expected.number}`,
    );
  }
  const head = record(detail.head, 'PR detail.head');
  const headOid = nonEmptyString(head.sha, 'PR detail.head.sha');
  gitOid(headOid);
  if (headOid !== expected.headOid) {
    throw new GitHubRestSchemaError('PR detail exact head does not match cached evidence');
  }
  const base = record(detail.base, 'PR detail.base');
  const user = detail.user === null ? null : record(detail.user, 'PR detail.user');
  const rawState = nonEmptyString(detail.state, 'PR detail.state');
  if (rawState !== 'open' && rawState !== 'closed') {
    throw new GitHubRestSchemaError('PR detail.state is unknown');
  }
  if (typeof detail.draft !== 'boolean') {
    throw new GitHubRestSchemaError('PR detail.draft must be boolean');
  }
  const closedAt = detail.closed_at === null
    ? null
    : exactTimestamp(detail.closed_at, 'PR detail.closed_at');
  const mergedAt = detail.merged_at === null
    ? null
    : exactTimestamp(detail.merged_at, 'PR detail.merged_at');
  if (rawState === 'open' && (closedAt !== null || mergedAt !== null)) {
    throw new GitHubRestSchemaError('open PR detail has closed or merged timestamps');
  }
  if (rawState === 'closed' && closedAt === null) {
    throw new GitHubRestSchemaError('closed PR detail has no closed_at timestamp');
  }
  const mergeable = detail.mergeable;
  if (mergeable !== true && mergeable !== false && mergeable !== null) {
    throw new GitHubRestSchemaError('PR detail.mergeable must be boolean or null');
  }
  const labels = rows(detail.labels, 'PR detail.labels').map((raw, index) => (
    nonEmptyString(record(raw, `PR detail label ${index}`).name, `PR detail label ${index}.name`)
  ));
  return {
    title: string(detail.title, 'PR detail.title'),
    body: detail.body === null ? '' : string(detail.body, 'PR detail.body'),
    author: user === null ? '' : nonEmptyString(user.login, 'PR detail.user.login'),
    baseRefName: nonEmptyString(base.ref, 'PR detail.base.ref'),
    headRefName: nonEmptyString(head.ref, 'PR detail.head.ref'),
    isDraft: detail.draft,
    state: rawState.toUpperCase() as 'OPEN' | 'CLOSED',
    labels,
    mergeability: mergeable === null ? 'UNKNOWN' : mergeable ? 'MERGEABLE' : 'CONFLICTING',
    mergeStateStatus: nonEmptyString(
      detail.mergeable_state,
      'PR detail.mergeable_state',
    ).toUpperCase(),
  };
}

function latestHuman(value: unknown, prNumber: number): {
  readonly issueNumber?: number;
  readonly reason: NonNullable<PullRequestSnapshot['humanReason']>;
} | null {
  const evidence = rows(value, 'PR comments').map((raw, index) => {
    const comment = record(raw, `PR comment ${index}`);
    const createdAt = exactTimestamp(comment.created_at, `PR comment ${index}.created_at`);
    const parsed = parseHumanCommentEvidence(string(comment.body, `PR comment ${index}.body`));
    if (parsed !== null && parsed.prNumber !== prNumber) {
      throw new GitHubRestSchemaError(
        `PR comment ${index} Human marker names PR #${parsed.prNumber}, expected #${prNumber}`,
      );
    }
    return parsed === null ? null : { createdAt, parsed };
  }).filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  if (evidence === undefined) return null;
  return {
    ...(evidence.parsed.issueNumber === undefined
      ? {}
      : { issueNumber: evidence.parsed.issueNumber }),
    reason: evidence.parsed.reason,
  };
}

function checkRuns(value: unknown): readonly CheckSummary[] {
  const response = record(value, 'check-runs response');
  const parsed = rows(response.check_runs, 'check-runs response.check_runs').map((raw, index) => {
    const check = record(raw, `check run ${index}`);
    const conclusion = check.conclusion;
    if (conclusion !== null && typeof conclusion !== 'string') {
      throw new GitHubRestSchemaError(`check run ${index}.conclusion must be a string or null`);
    }
    const runAttempt = check.run_attempt;
    const suite = check.check_suite === null || check.check_suite === undefined
      ? null
      : record(check.check_suite, `check run ${index}.check_suite`);
    const runId = check.id;
    return {
      name: nonEmptyString(check.name, `check run ${index}.name`),
      status: nonEmptyString(check.status, `check run ${index}.status`).toUpperCase(),
      conclusion: conclusion?.toUpperCase() ?? null,
      source: 'check-run' as const,
      ...(typeof runId === 'number' && Number.isSafeInteger(runId) && runId > 0
        ? { runId }
        : {}),
      ...(suite === null ? {} : {
        checkSuiteId: nonNegativeInteger(suite.id, `check run ${index}.check_suite.id`),
      }),
      ...(runAttempt === undefined || runAttempt === null ? {} : {
        runAttempt: nonNegativeInteger(runAttempt, `check run ${index}.run_attempt`),
      }),
    };
  });
  if (nonNegativeInteger(response.total_count, 'check-runs response.total_count') !== parsed.length) {
    throw new GitHubRestSchemaError('check-runs response is incomplete');
  }
  return parsed;
}

function commitStatuses(value: unknown): readonly CheckSummary[] {
  const response = record(value, 'commit-status response');
  nonEmptyString(response.state, 'commit-status response.state');
  const parsed = rows(response.statuses, 'commit-status response.statuses').map((raw, index) => {
    const status = record(raw, `commit status ${index}`);
    return {
      name: nonEmptyString(status.context, `commit status ${index}.context`),
      status: 'COMPLETED',
      conclusion: nonEmptyString(status.state, `commit status ${index}.state`).toUpperCase(),
      source: 'commit-status' as const,
    };
  });
  if (nonNegativeInteger(response.total_count, 'commit-status response.total_count') !== parsed.length) {
    throw new GitHubRestSchemaError('commit-status response is incomplete');
  }
  return parsed;
}

function canonical<Value>(values: readonly Value[]): string {
  return JSON.stringify([...values].sort((left, right) => (
    JSON.stringify(left).localeCompare(JSON.stringify(right))
  )));
}

function normalizeCheckForComparison(check: CheckSummary): {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
} {
  return {
    name: check.name,
    status: check.status,
    conclusion: check.conclusion,
  };
}

function canonicalChecks(checks: readonly CheckSummary[]): string {
  return canonical(checks.map(normalizeCheckForComparison));
}

export class ConditionalPullRequestEvidenceProbe implements PullRequestEvidenceProbe {
  constructor(private readonly rest: ConditionalRestClient) {}

  async changed(pr: PullRequestSnapshot): Promise<boolean> {
    if (pr.state !== 'OPEN') return false;
    const detailResponse = await this.rest.getJson(`repos/${REPO}/pulls/${pr.number}`);
    const reviewResponse = await this.rest.getJson(
      `repos/${REPO}/pulls/${pr.number}/reviews?per_page=100&page=1`,
    );
    const commentResponse = await this.rest.getJson(
      `repos/${REPO}/issues/${pr.number}/comments?per_page=100&page=1`,
    );
    const checkResponse = await this.rest.getJson(
      `repos/${REPO}/commits/${pr.headOid}/check-runs?per_page=100&page=1`,
    );
    const statusResponse = await this.rest.getJson(
      `repos/${REPO}/commits/${pr.headOid}/status?per_page=100&page=1`,
    );
    const detail = exactPullRequestDetail(
      completeBody(detailResponse, 'PR detail'),
      pr,
    );
    const currentReviews = reviews(completeBody(reviewResponse, 'PR reviews'));
    const currentHuman = latestHuman(
      completeBody(commentResponse, 'PR comments'),
      pr.number,
    );
    const currentChecks = [
      ...checkRuns(completeBody(checkResponse, 'check runs')),
      ...commitStatuses(completeBody(statusResponse, 'commit statuses')),
    ];
    const cachedHuman = pr.humanReason === undefined
      ? null
      : {
          ...(pr.humanIssueNumber === undefined ? {} : { issueNumber: pr.humanIssueNumber }),
          reason: pr.humanReason,
        };
    const cachedDetail = {
      title: pr.title,
      body: pr.body,
      author: pr.author,
      baseRefName: pr.baseRefName,
      headRefName: pr.headRefName,
      isDraft: pr.isDraft,
      state: pr.state,
      labels: pr.labels,
      mergeability: pr.mergeability,
      mergeStateStatus: pr.mergeStateStatus,
    };
    return JSON.stringify({ ...detail, labels: [...detail.labels].sort() })
        !== JSON.stringify({ ...cachedDetail, labels: [...cachedDetail.labels].sort() })
      || canonical(currentReviews) !== canonical(pr.reviews)
      || JSON.stringify(currentHuman) !== JSON.stringify(cachedHuman)
      || canonicalChecks(currentChecks) !== canonicalChecks(pr.checks);
  }
}

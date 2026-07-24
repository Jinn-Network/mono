import type {
  AutopilotGitHubReadPort,
  GitHubIssueComment,
  GitHubIssueCommentPage,
  GitHubNativeReview,
  GitHubNativeReviewPage,
  GitHubNativeReviewState,
  GitHubPullRequestFacts,
} from './github-adoption-receipt-observer.js';

const REPOSITORY_PATH = 'repos/Jinn-Network/mono';
const DEFAULT_BASE_URL = 'https://api.github.com';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 100;

export interface JinnMonoGitHubAdoptionReadOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly token?: string;
  readonly timeoutMs?: number;
  readonly pageSize?: number;
  readonly maxPages?: number;
}

function positiveInteger(
  input: unknown,
  name: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof input !== 'number'
    || !Number.isSafeInteger(input)
    || input < 1
    || input > maximum
  ) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return input;
}

function stringField(
  value: unknown,
  field: string,
  allowEmpty = false,
): string {
  if (
    typeof value !== 'string'
    || (!allowEmpty && value.length === 0)
  ) {
    throw new Error(`Malformed GitHub ${field}`);
  }
  return value;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Malformed GitHub ${name}`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`Malformed GitHub ${name}`);
  return value;
}

function isoTimestamp(value: unknown, field: string): string {
  const timestamp = stringField(value, field);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(timestamp)
    || !Number.isFinite(Date.parse(timestamp))
  ) {
    throw new Error(`Malformed GitHub ${field}`);
  }
  return timestamp;
}

function parseCursor(
  cursor: string | undefined,
  maxPages: number,
): number {
  if (cursor === undefined) return 1;
  if (!/^[1-9][0-9]*$/.test(cursor)) {
    throw new Error('GitHub page cursor is malformed');
  }
  return positiveInteger(Number(cursor), 'GitHub page', maxPages);
}

function nextCursor(
  linkHeader: string | null,
  maxPages: number,
): string | undefined {
  if (linkHeader === null) return undefined;
  for (const part of linkHeader.split(',')) {
    const match = /^\s*<([^>]+)>;\s*rel="([^"]+)"\s*$/.exec(part);
    if (match?.[2] !== 'next') continue;
    let url: URL;
    try {
      url = new URL(match[1]!);
    } catch {
      throw new Error('Malformed GitHub pagination link');
    }
    const page = url.searchParams.get('page');
    if (page === null || !/^[1-9][0-9]*$/.test(page)) {
      throw new Error('Malformed GitHub next-page cursor');
    }
    positiveInteger(Number(page), 'GitHub next page', maxPages);
    return page;
  }
  return undefined;
}

function parseComment(value: unknown): GitHubIssueComment {
  const raw = record(value, 'comment');
  const user = record(raw['user'], 'comment author');
  return {
    id: positiveInteger(raw['id'], 'GitHub comment id'),
    authorLogin: stringField(user['login'], 'comment author login'),
    body: stringField(raw['body'], 'comment body', true),
    createdAt: isoTimestamp(raw['created_at'], 'comment created_at'),
    updatedAt: isoTimestamp(raw['updated_at'], 'comment updated_at'),
  };
}

const NATIVE_REVIEW_STATES = new Set<GitHubNativeReviewState>([
  'APPROVED',
  'CHANGES_REQUESTED',
  'COMMENTED',
  'DISMISSED',
  'PENDING',
]);

function parseReview(value: unknown): GitHubNativeReview {
  const raw = record(value, 'review');
  const user = record(raw['user'], 'review author');
  const state = stringField(raw['state'], 'review state');
  if (!NATIVE_REVIEW_STATES.has(state as GitHubNativeReviewState)) {
    throw new Error('Malformed GitHub review state');
  }
  const commitId = stringField(raw['commit_id'], 'review commit_id');
  if (!/^[0-9a-f]{40}$/.test(commitId)) {
    throw new Error('Malformed GitHub review commit_id');
  }
  return {
    id: positiveInteger(raw['id'], 'GitHub review id'),
    authorLogin: stringField(user['login'], 'review author login'),
    state: state as GitHubNativeReviewState,
    commitId,
    body: stringField(raw['body'], 'review body', true),
    submittedAt: isoTimestamp(raw['submitted_at'], 'review submitted_at'),
  };
}

/**
 * Read-only GitHub REST port for the public Jinn-Network/mono repository.
 */
export function createJinnMonoGitHubAdoptionReadPort(
  options: JinnMonoGitHubAdoptionReadOptions = {},
): AutopilotGitHubReadPort {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  let parsedBase: URL;
  try {
    parsedBase = new URL(baseUrl);
  } catch {
    throw new Error('GitHub REST base URL is invalid');
  }
  if (parsedBase.protocol !== 'https:' && parsedBase.protocol !== 'http:') {
    throw new Error('GitHub REST base URL must use HTTP or HTTPS');
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = positiveInteger(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    'GitHub timeout',
    120_000,
  );
  const pageSize = positiveInteger(
    options.pageSize ?? DEFAULT_PAGE_SIZE,
    'GitHub page size',
    100,
  );
  const maxPages = positiveInteger(
    options.maxPages ?? DEFAULT_MAX_PAGES,
    'GitHub maximum pages',
    DEFAULT_MAX_PAGES,
  );
  const token = options.token?.trim();

  const requestJson = async (
    path: string,
  ): Promise<{ readonly value: unknown; readonly headers: Headers }> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}/${path}`, {
        method: 'GET',
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'jinn-autopilot-marketplace-adoption',
          ...(token === undefined || token.length === 0
            ? {}
            : { authorization: `Bearer ${token}` }),
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(
          `GitHub adoption read failed with HTTP ${response.status}`,
        );
      }
      return {
        value: await response.json() as unknown,
        headers: response.headers,
      };
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`GitHub adoption read timed out after ${timeoutMs} ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };

  const pagePath = (
    path: string,
    cursor: string | undefined,
  ): { readonly path: string; readonly page: number } => {
    const page = parseCursor(cursor, maxPages);
    return {
      page,
      path: `${path}?per_page=${pageSize}&page=${page}`,
    };
  };

  return {
    async listPrIssueComments({
      prNumber,
      cursor,
    }): Promise<GitHubIssueCommentPage> {
      positiveInteger(prNumber, 'GitHub PR number');
      const page = pagePath(
        `${REPOSITORY_PATH}/issues/${prNumber}/comments`,
        cursor,
      );
      const response = await requestJson(page.path);
      const comments = array(response.value, 'comments').map(parseComment);
      const next = nextCursor(response.headers.get('link'), maxPages);
      return {
        comments,
        ...(next === undefined ? {} : { nextCursor: next }),
      };
    },

    async readPullRequest(prNumber): Promise<GitHubPullRequestFacts> {
      positiveInteger(prNumber, 'GitHub PR number');
      const response = await requestJson(
        `${REPOSITORY_PATH}/pulls/${prNumber}`,
      );
      const raw = record(response.value, 'pull request');
      const head = record(raw['head'], 'pull request head');
      const headSha = stringField(head['sha'], 'pull request head SHA');
      if (!/^[0-9a-f]{40}$/.test(headSha)) {
        throw new Error('Malformed GitHub pull request head SHA');
      }
      const labels = array(raw['labels'], 'pull request labels').map(
        (entry) => stringField(
          record(entry, 'pull request label')['name'],
          'pull request label name',
        ),
      );
      return { headSha, labels };
    },

    async listPullRequestReviews({
      prNumber,
      cursor,
    }): Promise<GitHubNativeReviewPage> {
      positiveInteger(prNumber, 'GitHub PR number');
      const page = pagePath(
        `${REPOSITORY_PATH}/pulls/${prNumber}/reviews`,
        cursor,
      );
      const response = await requestJson(page.path);
      const reviews = array(response.value, 'reviews').map(parseReview);
      const next = nextCursor(response.headers.get('link'), maxPages);
      return {
        reviews,
        ...(next === undefined ? {} : { nextCursor: next }),
      };
    },
  };
}

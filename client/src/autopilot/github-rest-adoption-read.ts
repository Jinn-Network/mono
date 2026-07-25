import type {
  AutopilotGitHubReadPort,
  GitHubIssueComment,
  GitHubIssueCommentPage,
  GitHubNativeReview,
  GitHubNativeReviewPage,
  GitHubNativeReviewState,
  GitHubPullRequestFacts,
  GitHubReviewClaimRecord,
} from './github-adoption-receipt-observer.js';

const REPOSITORY_PATH = 'repos/Jinn-Network/mono';
const DEFAULT_BASE_URL = 'https://api.github.com';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 100;
const MAX_REVIEW_AUTHORITY_DEPTH = 64;

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

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  name: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown !== undefined) {
    throw new Error(`Malformed GitHub ${name}: unknown field ${unknown}`);
  }
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

function parseComment(value: unknown): GitHubIssueComment | null {
  try {
    const raw = record(value, 'comment');
    const user = record(raw['user'], 'comment author');
    return {
      id: positiveInteger(raw['id'], 'GitHub comment id'),
      authorLogin: stringField(user['login'], 'comment author login'),
      body: stringField(raw['body'], 'comment body', true),
      createdAt: isoTimestamp(raw['created_at'], 'comment created_at'),
      updatedAt: isoTimestamp(raw['updated_at'], 'comment updated_at'),
    };
  } catch {
    // Deleted users and old nullable bodies are valid GitHub history. They
    // cannot authenticate an adoption receipt, so filter them before the
    // strict authorized-receipt parser sees them.
    return null;
  }
}

const NATIVE_REVIEW_STATES = new Set<GitHubNativeReviewState>([
  'APPROVED',
  'CHANGES_REQUESTED',
  'COMMENTED',
  'DISMISSED',
  'PENDING',
]);

function parseReview(value: unknown): GitHubNativeReview | null {
  let raw: Record<string, unknown>;
  let id: number;
  let state: GitHubNativeReviewState;
  try {
    raw = record(value, 'review');
    id = positiveInteger(raw['id'], 'GitHub review id');
    const parsedState = stringField(raw['state'], 'review state');
    if (!NATIVE_REVIEW_STATES.has(parsedState as GitHubNativeReviewState)) {
      return null;
    }
    state = parsedState as GitHubNativeReviewState;
  } catch {
    return null;
  }

  try {
    const user = record(raw['user'], 'review author');
    const commitId = stringField(raw['commit_id'], 'review commit_id');
    if (!/^[0-9a-f]{40}$/.test(commitId)) {
      throw new Error('Malformed GitHub review commit_id');
    }
    return {
      id,
      authorLogin: stringField(user['login'], 'review author login'),
      state,
      commitId,
      body: stringField(raw['body'], 'review body', true),
      submittedAt: isoTimestamp(raw['submitted_at'], 'review submitted_at'),
    };
  } catch {
    if (state !== 'CHANGES_REQUESTED') return null;
    // An unattributed/legacy requested-changes row cannot authorize a
    // receipt, but it must remain a unique conservative merge blocker. Never
    // group it with a known login: its nullable timestamp cannot establish
    // whether a later-looking approval actually supersedes it.
    return {
      id,
      authorLogin: `@unattributed-review:${id}`,
      state,
      commitId: '0'.repeat(40),
      body: '',
      submittedAt: '0001-01-01T00:00:00.000Z',
    };
  }
}

function gitOid(value: unknown, field: string): string {
  const oid = stringField(value, field);
  if (!/^[0-9a-f]{40}$/.test(oid)) {
    throw new Error(`Malformed GitHub ${field}`);
  }
  return oid;
}

function parseReviewClaimRecord(value: unknown): GitHubReviewClaimRecord {
  const raw = record(value, 'review claim');
  exactKeys(raw, [
    'protocolVersion',
    'prNumber',
    'generation',
    'attempt',
    'reviewer',
    'head',
    'state',
    'recordedAt',
    'verdict',
  ], 'review claim');
  const state = stringField(raw['state'], 'review claim state');
  if (!['active', 'verdict-intent', 'terminal-approved', 'human', 'stale']
    .includes(state)) {
    throw new Error('Malformed GitHub review claim state');
  }
  const generation = stringField(
    raw['generation'],
    'review claim generation',
  );
  const attempt = stringField(raw['attempt'], 'review claim attempt');
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      .test(generation)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      .test(attempt)
  ) {
    throw new Error('Malformed GitHub review claim identity');
  }
  const verdictRaw = raw['verdict'];
  let verdict: GitHubReviewClaimRecord['verdict'];
  if (verdictRaw !== undefined) {
    const parsed = record(verdictRaw, 'review claim verdict');
    exactKeys(parsed, ['state', 'marker'], 'review claim verdict');
    const verdictState = stringField(
      parsed['state'],
      'review claim verdict state',
    );
    if (verdictState !== 'APPROVE' && verdictState !== 'REQUEST_CHANGES') {
      throw new Error('Malformed GitHub review claim verdict state');
    }
    verdict = {
      state: verdictState,
      marker: stringField(parsed['marker'], 'review claim verdict marker'),
    };
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
        .test(verdict.marker)
    ) {
      throw new Error('Malformed GitHub review claim verdict marker');
    }
  }
  if (
    (state === 'verdict-intent' || state === 'terminal-approved')
      !== (verdict !== undefined)
    || (state === 'terminal-approved' && verdict?.state !== 'APPROVE')
  ) {
    throw new Error('Malformed GitHub review claim state/verdict combination');
  }
  const reviewer = stringField(raw['reviewer'], 'review claim reviewer');
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(reviewer)) {
    throw new Error('Malformed GitHub review claim reviewer');
  }
  return {
    protocolVersion: raw['protocolVersion'] === 2
      ? 2
      : (() => { throw new Error('Malformed GitHub review claim protocol'); })(),
    prNumber: positiveInteger(raw['prNumber'], 'GitHub review claim PR'),
    generation,
    attempt,
    reviewer,
    head: gitOid(raw['head'], 'review claim head'),
    state: state as GitHubReviewClaimRecord['state'],
    recordedAt: isoTimestamp(raw['recordedAt'], 'review claim recordedAt'),
    ...(verdict === undefined ? {} : { verdict }),
  };
}

export function validateReviewClaimTransition(
  child: GitHubReviewClaimRecord,
  parent: GitHubReviewClaimRecord,
): void {
  if (child.prNumber !== parent.prNumber) {
    throw new Error('GitHub review authority changed PR identity');
  }
  if (Date.parse(child.recordedAt) < Date.parse(parent.recordedAt)) {
    throw new Error('GitHub review authority timestamp moved backwards');
  }
  if (child.generation !== parent.generation) {
    if (
      child.state !== 'active'
      || child.attempt === parent.attempt
      || !['stale', 'terminal-approved'].includes(parent.state)
    ) {
      throw new Error('GitHub review authority has an invalid generation transition');
    }
    return;
  }
  if (
    child.attempt !== parent.attempt
    || child.reviewer.toLowerCase() !== parent.reviewer.toLowerCase()
    || child.head !== parent.head
  ) {
    throw new Error('GitHub review authority changed identity within a generation');
  }
  const allowed = new Set<string>(
    parent.state === 'active'
      ? ['verdict-intent', 'stale', 'human']
      : parent.state === 'verdict-intent'
        ? ['terminal-approved', 'stale', 'human']
        : parent.state === 'terminal-approved' || parent.state === 'stale'
          ? ['human']
          : [],
  );
  if (!allowed.has(child.state)) {
    throw new Error(
      `GitHub review authority has invalid ${parent.state} -> ${child.state} transition`,
    );
  }
  if (
    parent.state === 'verdict-intent'
    && child.state === 'terminal-approved'
    && (
      parent.verdict === undefined
      || child.verdict?.state !== parent.verdict.state
      || child.verdict.marker !== parent.verdict.marker
    )
  ) {
    throw new Error(
      'GitHub review authority changed verdict intent at terminalization',
    );
  }
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
  const immutableCommits = new Map<string, Record<string, unknown>>();
  const immutableTrees = new Map<string, Record<string, unknown>>();
  const immutableBlobs = new Map<string, string>();

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
      const comments = array(response.value, 'comments')
        .map(parseComment)
        .filter((comment): comment is GitHubIssueComment => comment !== null);
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

    async readIssue(issueNumber) {
      positiveInteger(issueNumber, 'GitHub issue number');
      const response = await requestJson(
        `${REPOSITORY_PATH}/issues/${issueNumber}`,
      );
      const raw = record(response.value, 'issue');
      const number = positiveInteger(raw['number'], 'GitHub issue number');
      const state = stringField(raw['state'], 'issue state').toUpperCase();
      if (state !== 'OPEN' && state !== 'CLOSED') {
        throw new Error('Malformed GitHub issue state');
      }
      return {
        number,
        state,
        body: stringField(raw['body'], 'issue body', true),
        labels: array(raw['labels'], 'issue labels').map(
          (entry) => stringField(
            record(entry, 'issue label')['name'],
            'issue label name',
          ),
        ),
        isPullRequest: raw['pull_request'] !== undefined,
      };
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
      const reviews = array(response.value, 'reviews')
        .map(parseReview)
        .filter((review): review is GitHubNativeReview => review !== null);
      const next = nextCursor(response.headers.get('link'), maxPages);
      return {
        reviews,
        ...(next === undefined ? {} : { nextCursor: next }),
      };
    },

    async readReviewAuthority(prNumber, expectedRootOid) {
      positiveInteger(prNumber, 'GitHub PR number');
      if (expectedRootOid !== undefined) {
        gitOid(expectedRootOid, 'expected review root SHA');
      }
      const ref = encodeURIComponent(
        `jinn-autopilot/review-claims/v1/${prNumber}`,
      );
      const refResponse = record(
        (await requestJson(`${REPOSITORY_PATH}/git/ref/${ref}`)).value,
        'review ref',
      );
      let oid = gitOid(
        record(refResponse['object'], 'review ref object')['sha'],
        'review ref SHA',
      );
      const currentOid = oid;
      const history: Array<{
        oid: string;
        record: GitHubReviewClaimRecord;
      }> = [];
      for (let depth = 0; depth < MAX_REVIEW_AUTHORITY_DEPTH; depth += 1) {
        let commit = immutableCommits.get(oid);
        if (commit === undefined) {
          commit = record(
            (await requestJson(`${REPOSITORY_PATH}/git/commits/${oid}`)).value,
            'review commit',
          );
          immutableCommits.set(oid, commit);
        }
        const treeOid = gitOid(
          record(commit['tree'], 'review commit tree')['sha'],
          'review commit tree SHA',
        );
        let tree = immutableTrees.get(treeOid);
        if (tree === undefined) {
          tree = record(
            (await requestJson(`${REPOSITORY_PATH}/git/trees/${treeOid}`)).value,
            'review tree',
          );
          immutableTrees.set(treeOid, tree);
        }
        const entry = array(tree['tree'], 'review tree entries')
          .map((value) => record(value, 'review tree entry'))
          .find((value) => value['path'] === 'jinn-autopilot-review.json');
        if (entry === undefined || entry['type'] !== 'blob') {
          throw new Error('GitHub review claim blob is missing');
        }
        const blobOid = gitOid(entry['sha'], 'review claim blob SHA');
        let encoded = immutableBlobs.get(blobOid);
        if (encoded === undefined) {
          const blob = record(
            (await requestJson(`${REPOSITORY_PATH}/git/blobs/${blobOid}`)).value,
            'review claim blob',
          );
          if (blob['encoding'] !== 'base64') {
            throw new Error('Malformed GitHub review claim blob encoding');
          }
          encoded = stringField(
            blob['content'],
            'review claim blob content',
          ).replace(/\s+/gu, '');
          immutableBlobs.set(blobOid, encoded);
        }
        if (
          encoded.length === 0
          || encoded.length > 32 * 1024
          || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
            .test(encoded)
        ) {
          throw new Error('Malformed GitHub review claim blob content');
        }
        const payload = Buffer.from(encoded, 'base64').toString('utf8');
        if (Buffer.from(payload, 'utf8').toString('base64') !== encoded) {
          throw new Error('Malformed GitHub review claim blob content');
        }
        const parsedRecord = parseReviewClaimRecord(
          JSON.parse(payload) as unknown,
        );
        const child = history.at(-1)?.record;
        if (child !== undefined) {
          validateReviewClaimTransition(child, parsedRecord);
        }
        history.push({
          oid,
          record: parsedRecord,
        });
        if (oid === expectedRootOid) break;
        const parents = array(commit['parents'], 'review commit parents');
        if (parents.length === 0) break;
        if (parents.length !== 1) {
          throw new Error('GitHub review authority is not first-parent linear');
        }
        oid = gitOid(
          record(parents[0], 'review commit parent')['sha'],
          'review commit parent SHA',
        );
      }
      return { oid: currentOid, history };
    },
  };
}

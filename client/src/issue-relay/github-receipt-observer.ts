import { createHash } from 'node:crypto';
import { z } from 'zod/v3';
import {
  IssueRelayAdoptionReceiptV1Schema,
  IssueRelayEvaluationAnchorV1Schema,
  IssueRelayRoundV1Schema,
  parseIssueRelayAdoptionReceiptComment,
  parseIssueRelayEvaluationAnchorComment,
  type IssueRelayAdoptionReceiptV1,
  type IssueRelayCorrelationV1,
  type IssueRelayEvaluationAnchorV1,
  type IssueRelayRoundV1,
} from '@jinn-network/sdk/solvernets/jinn-repo';

const DEFAULT_MAX_PAGES = 20;
const MAX_MAX_PAGES = 100;
const GENERATION_MARKER = '<!-- jinn-issue-relay:generation:v1 -->';
const MAX_MARKER_BYTES = 256 * 1024;
const GitOidSchema = z.string().regex(/^[0-9a-f]{40}$/);
const DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const SafeSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const NonEmptyStringSchema = z.string().min(1);
const TimestampSchema = z.string().datetime({ offset: true });

export interface IssueRelayGitHubComment {
  readonly id: number;
  readonly authorLogin: string;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface IssueRelayGitHubCommentPage {
  readonly comments: readonly IssueRelayGitHubComment[];
  readonly nextCursor?: string;
}

export interface IssueRelayCheckSummary {
  readonly digest: `sha256:${string}`;
  readonly required: readonly {
    readonly name: string;
    readonly status: 'passed';
    readonly url?: string;
  }[];
  readonly optional: readonly {
    readonly name: string;
    readonly status: 'passed' | 'failed' | 'pending';
    readonly url?: string;
  }[];
}

export interface IssueRelayPullRequestFacts {
  readonly number: number;
  readonly targetRepository: string;
  readonly workspaceRepository: string;
  readonly targetBase: string;
  readonly baseOid: string;
  readonly headRef: string;
  readonly headSha: string;
  readonly checks: IssueRelayCheckSummary;
}

export interface IssueRelayGitHubReadPort {
  listIssueComments(input: {
    readonly repository: string;
    readonly issueNumber: number;
    readonly cursor?: string;
  }): Promise<IssueRelayGitHubCommentPage>;
  listPullRequestComments(input: {
    readonly repository: string;
    readonly prNumber: number;
    readonly cursor?: string;
  }): Promise<IssueRelayGitHubCommentPage>;
  readPullRequest(input: {
    readonly repository: string;
    readonly prNumber: number;
  }): Promise<IssueRelayPullRequestFacts>;
}

export interface IssueRelayGitHubRestReadOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly requiredCheckNames?: readonly string[];
}

function githubRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Malformed GitHub ${label}`);
  }
  return value as Record<string, unknown>;
}

function githubString(
  value: unknown,
  label: string,
  allowEmpty = false,
): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new Error(`Malformed GitHub ${label}`);
  }
  return value;
}

function githubPositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Malformed GitHub ${label}`);
  }
  return value;
}

function githubArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`Malformed GitHub ${label}`);
  return value;
}

function exactRepository(value: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error('Malformed GitHub repository slug');
  }
  return value;
}

function exactOid(value: unknown, label: string): string {
  const oid = githubString(value, label);
  if (!/^[0-9a-f]{40}$/.test(oid)) throw new Error(`Malformed GitHub ${label}`);
  return oid;
}

function pageCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 1;
  if (!/^[1-9][0-9]*$/.test(cursor)) {
    throw new Error('Malformed GitHub page cursor');
  }
  const page = Number(cursor);
  if (!Number.isSafeInteger(page) || page > MAX_MAX_PAGES) {
    throw new Error('GitHub page cursor exceeds its bound');
  }
  return page;
}

function nextPage(linkHeader: string | null): string | undefined {
  if (linkHeader === null) return undefined;
  for (const part of linkHeader.split(',')) {
    const match = /^\s*<([^>]+)>;\s*rel="([^"]+)"\s*$/.exec(part);
    if (match?.[2] !== 'next') continue;
    const page = new URL(match[1]!).searchParams.get('page');
    pageCursor(page ?? undefined);
    return page!;
  }
  return undefined;
}

function restComment(value: unknown): IssueRelayGitHubComment {
  const raw = githubRecord(value, 'comment');
  return {
    id: githubPositiveInteger(raw['id'], 'comment id'),
    authorLogin: githubString(
      githubRecord(raw['user'], 'comment author')['login'],
      'comment author login',
    ),
    body: githubString(raw['body'], 'comment body', true),
    createdAt: githubString(raw['created_at'], 'comment created_at'),
    updatedAt: githubString(raw['updated_at'], 'comment updated_at'),
  };
}

type RestCheckStatus = 'passed' | 'failed' | 'pending';

function checkRunStatus(raw: Record<string, unknown>): RestCheckStatus {
  if (githubString(raw['status'], 'check run status') !== 'completed') {
    return 'pending';
  }
  const conclusion = githubString(
    raw['conclusion'],
    'check run conclusion',
    true,
  );
  if (['success', 'neutral', 'skipped'].includes(conclusion)) return 'passed';
  if (
    [
      'failure',
      'cancelled',
      'timed_out',
      'action_required',
      'startup_failure',
      'stale',
    ].includes(conclusion)
  ) {
    return 'failed';
  }
  return 'pending';
}

function statusContextStatus(value: unknown): RestCheckStatus {
  const state = githubString(value, 'commit status state');
  if (state === 'success') return 'passed';
  if (state === 'failure' || state === 'error') return 'failed';
  if (state === 'pending') return 'pending';
  throw new Error('Malformed GitHub commit status state');
}

function checkDigest(input: {
  readonly head: string;
  readonly required: IssueRelayCheckSummary['required'];
  readonly optional: IssueRelayCheckSummary['optional'];
}): `sha256:${string}` {
  const canonical = (value: unknown): string => {
    if (typeof value === 'string') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value !== null && typeof value === 'object') {
      return `{${Object.keys(value as Record<string, unknown>).sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(
          (value as Record<string, unknown>)[key],
        )}`)
        .join(',')}}`;
    }
    return JSON.stringify(value);
  };
  return `sha256:${createHash('sha256').update(canonical(input)).digest('hex')}`;
}

/**
 * Credential-free GitHub REST reader for Relay evidence. It intentionally has
 * no token option: the evaluator admission path consumes only public facts.
 */
export function createIssueRelayGitHubRestReadPort(
  options: IssueRelayGitHubRestReadOptions = {},
): IssueRelayGitHubReadPort {
  const baseUrl = (options.baseUrl ?? 'https://api.github.com').replace(/\/+$/, '');
  const parsedBase = new URL(baseUrl);
  if (!['http:', 'https:'].includes(parsedBase.protocol)) {
    throw new Error('GitHub REST base URL must use HTTP or HTTPS');
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new Error('GitHub REST timeout must be between 1 and 120000 ms');
  }
  const requiredNames = new Set(
    (options.requiredCheckNames ?? []).map((name) => {
      if (
        name.length === 0
        || name.trim() !== name
        || /[\r\n\0]/.test(name)
      ) {
        throw new Error('Relay required check names must be non-empty single lines');
      }
      return name;
    }),
  );

  const getJson = async (
    path: string,
  ): Promise<{ readonly value: unknown; readonly headers: Headers }> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    try {
      const response = await fetchImpl(`${baseUrl}/${path}`, {
        method: 'GET',
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'jinn-issue-relay-evaluator',
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`GitHub Relay read failed with HTTP ${response.status}`);
      }
      return {
        value: await response.json() as unknown,
        headers: response.headers,
      };
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`GitHub Relay read timed out after ${timeoutMs} ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };

  const commentsPage = async (
    repository: string,
    number: number,
    cursor?: string,
  ): Promise<IssueRelayGitHubCommentPage> => {
    const page = pageCursor(cursor);
    const response = await getJson(
      `repos/${exactRepository(repository)}/issues/${
        githubPositiveInteger(number, 'issue number')
      }/comments?per_page=100&page=${page}`,
    );
    const comments = githubArray(response.value, 'comments').map(restComment);
    const nextCursor = nextPage(response.headers.get('link'));
    return {
      comments,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  };

  return {
    listIssueComments: ({ repository, issueNumber, cursor }) =>
      commentsPage(repository, issueNumber, cursor),
    listPullRequestComments: ({ repository, prNumber, cursor }) =>
      commentsPage(repository, prNumber, cursor),
    async readPullRequest({ repository, prNumber }) {
      const checkedRepository = exactRepository(repository);
      const checkedNumber = githubPositiveInteger(prNumber, 'pull request number');
      const raw = githubRecord(
        (await getJson(`repos/${checkedRepository}/pulls/${checkedNumber}`)).value,
        'pull request',
      );
      const base = githubRecord(raw['base'], 'pull request base');
      const head = githubRecord(raw['head'], 'pull request head');
      const targetRepository = exactRepository(githubString(
        githubRecord(base['repo'], 'pull request base repository')['full_name'],
        'pull request base repository name',
      ));
      const workspaceRepository = exactRepository(githubString(
        githubRecord(head['repo'], 'pull request head repository')['full_name'],
        'pull request head repository name',
      ));
      const headSha = exactOid(head['sha'], 'pull request head SHA');
      const checkRuns = githubRecord(
        (await getJson(
          `repos/${checkedRepository}/commits/${headSha}/check-runs?per_page=100&page=1`,
        )).value,
        'check-runs response',
      );
      const checkRunRows = githubArray(checkRuns['check_runs'], 'check runs');
      if (
        typeof checkRuns['total_count'] === 'number'
        && checkRuns['total_count'] !== checkRunRows.length
      ) {
        throw new Error('GitHub check-runs response is incomplete');
      }
      const combinedStatus = githubRecord(
        (await getJson(
          `repos/${checkedRepository}/commits/${headSha}/status?per_page=100&page=1`,
        )).value,
        'combined status response',
      );
      const statusRows = githubArray(
        combinedStatus['statuses'],
        'commit statuses',
      );
      if (
        typeof combinedStatus['total_count'] === 'number'
        && combinedStatus['total_count'] !== statusRows.length
      ) {
        throw new Error('GitHub commit-status response is incomplete');
      }
      const checks = new Map<string, {
        readonly name: string;
        readonly status: RestCheckStatus;
        readonly url?: string;
      }>();
      const addCheck = (entry: {
        readonly name: string;
        readonly status: RestCheckStatus;
        readonly url?: string;
      }): void => {
        const previous = checks.get(entry.name);
        if (
          previous !== undefined
          && (
            previous.status !== entry.status
            || previous.url !== entry.url
          )
        ) {
          throw new Error(`Conflicting GitHub checks named ${entry.name}`);
        }
        checks.set(entry.name, entry);
      };
      for (const value of checkRunRows) {
        const run = githubRecord(value, 'check run');
        const url = run['details_url'] === null || run['details_url'] === undefined
          ? undefined
          : githubString(run['details_url'], 'check run details URL');
        addCheck({
          name: githubString(run['name'], 'check run name'),
          status: checkRunStatus(run),
          ...(url === undefined ? {} : { url }),
        });
      }
      for (const value of statusRows) {
        const status = githubRecord(value, 'commit status');
        const url = status['target_url'] === null || status['target_url'] === undefined
          ? undefined
          : githubString(status['target_url'], 'commit status target URL');
        addCheck({
          name: githubString(status['context'], 'commit status context'),
          status: statusContextStatus(status['state']),
          ...(url === undefined ? {} : { url }),
        });
      }
      const sorted = [...checks.values()].sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
      const required = sorted
        .filter(({ name }) => requiredNames.has(name))
        .map((entry) => {
          if (entry.status !== 'passed') {
            throw new Error(`Required GitHub check ${entry.name} has not passed`);
          }
          return { ...entry, status: 'passed' as const };
        });
      for (const requiredName of requiredNames) {
        if (!checks.has(requiredName)) {
          throw new Error(`Required GitHub check ${requiredName} is missing`);
        }
      }
      const optional = sorted.filter(({ name }) => !requiredNames.has(name));
      return {
        number: githubPositiveInteger(raw['number'], 'pull request number'),
        targetRepository,
        workspaceRepository,
        targetBase: githubString(base['ref'], 'pull request base ref'),
        baseOid: exactOid(base['sha'], 'pull request base SHA'),
        headRef: githubString(head['ref'], 'pull request head ref'),
        headSha,
        checks: {
          digest: checkDigest({ head: headSha, required, optional }),
          required,
          optional,
        },
      };
    },
  };
}

const SnapshotSchema = z.object({
  repository: z.object({
    slug: NonEmptyStringSchema,
    nodeId: NonEmptyStringSchema,
    visibility: z.literal('PUBLIC'),
    defaultBranch: NonEmptyStringSchema,
    baseOid: GitOidSchema,
  }).strict(),
  issue: z.object({
    number: z.number().int().positive(),
    url: z.string().url(),
    title: NonEmptyStringSchema,
    body: z.string(),
    authorLogin: NonEmptyStringSchema,
    authorId: NonEmptyStringSchema,
    updatedAt: TimestampSchema,
  }).strict(),
  optIn: z.object({
    label: z.literal('engine:marketplace'),
    actorLogin: NonEmptyStringSchema,
    createdAt: TimestampSchema,
    permission: z.enum(['WRITE', 'MAINTAIN', 'ADMIN']),
  }).strict(),
  language: z.literal('typescript'),
  verificationProfile: z.literal('jinn-mono.v1'),
  acceptanceEvidence: z.array(NonEmptyStringSchema),
  admissionPolicyVersion: z.literal('jinn-issue-relay-admission.v1'),
  capturedAt: TimestampSchema,
  schemaVersion: z.literal('jinn-issue-relay-snapshot.v1'),
  snapshotDigest: DigestSchema,
}).strict();

const MarkerRoundSchema = z.object({
  round: z.number().int().nonnegative(),
  purpose: z.enum(['initial', 'repair']),
  workspaceRepository: NonEmptyStringSchema,
  inputHead: GitOidSchema,
  task: z.object({
    taskKey: NonEmptyStringSchema,
    taskId: NonEmptyStringSchema,
    taskCid: NonEmptyStringSchema,
    fundedAt: TimestampSchema,
  }).strict().optional(),
  solution: z.object({
    envelopeCid: NonEmptyStringSchema,
    operatorSafe: SafeSchema,
    observedAt: TimestampSchema,
  }).strict().optional(),
  adoption: z.object({
    disposition: z.enum(['accepted', 'rejected']),
    resultingHead: GitOidSchema.optional(),
    receiptDigest: DigestSchema,
  }).strict().optional(),
  checks: z.object({
    head: GitOidSchema,
    status: z.enum(['pending', 'passed', 'failed']),
    digest: DigestSchema,
  }).strict().optional(),
  verdict: z.object({
    outcome: z.enum(['pass', 'request-changes', 'human', 'unresolved']),
    evaluatedHead: GitOidSchema,
    envelopeCid: NonEmptyStringSchema,
  }).strict().optional(),
}).strict();

const IssueRelayGenerationMarkerSchema = z.object({
  schemaVersion: z.literal('jinn-issue-relay-generation.v1'),
  generation: NonEmptyStringSchema,
  snapshot: SnapshotSchema,
  phase: z.enum([
    'awaiting-clarification',
    'refused',
    'admitted',
    'submitted',
    'solution-delivered',
    'draft-open',
    'evaluating',
    'repair-needed',
    'ready',
    'cancelling',
    'closed',
    'exhausted',
  ]),
  deadlineAt: TimestampSchema,
  rounds: z.array(MarkerRoundSchema),
  pr: z.object({
    number: z.number().int().positive(),
    branch: NonEmptyStringSchema,
    head: GitOidSchema,
    draft: z.boolean(),
  }).strict().optional(),
  cancellation: z.object({
    requestedAt: TimestampSchema,
    reason: z.enum(['issue-closed', 'label-removed', 'operator']),
  }).strict().optional(),
  updatedAt: TimestampSchema,
}).strict();

export type IssueRelayGenerationMarker = z.infer<
  typeof IssueRelayGenerationMarkerSchema
>;

export type IssueRelayEvaluationReceiptObservation =
  | {
      readonly state: 'accepted';
      readonly marker: IssueRelayGenerationMarker;
      readonly receipt: Extract<
        IssueRelayAdoptionReceiptV1,
        { disposition: 'accepted' }
      >;
      readonly anchor: IssueRelayEvaluationAnchorV1;
      readonly pullRequest: IssueRelayPullRequestFacts;
    }
  | {
      readonly state: 'rejected';
      readonly receipt: Extract<
        IssueRelayAdoptionReceiptV1,
        { disposition: 'rejected' }
      >;
      readonly detail: string;
    }
  | {
      readonly state: 'pending' | 'contradictory';
      readonly detail: string;
    };

function parseGenerationMarker(body: string): IssueRelayGenerationMarker | null {
  if (new TextEncoder().encode(body).byteLength > MAX_MARKER_BYTES) return null;
  const match = /^<!-- jinn-issue-relay:generation:v1 -->\n\n```json\n([^\r\n]*)\n```$/.exec(body);
  if (match?.[1] === undefined) return null;
  try {
    const decoded = IssueRelayGenerationMarkerSchema.safeParse(
      JSON.parse(match[1]) as unknown,
    );
    if (!decoded.success || JSON.stringify(decoded.data) !== match[1]) return null;
    return decoded.data;
  } catch {
    return null;
  }
}

function normalizedLogin(login: string): string {
  return login.trim().toLowerCase();
}

function sameComment(
  left: IssueRelayGitHubComment,
  right: IssueRelayGitHubComment,
): boolean {
  return left.id === right.id
    && left.authorLogin === right.authorLogin
    && left.body === right.body
    && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt;
}

function pageBound(value: number | undefined): number {
  const bound = value ?? DEFAULT_MAX_PAGES;
  if (!Number.isSafeInteger(bound) || bound < 1 || bound > MAX_MAX_PAGES) {
    throw new Error(`Relay GitHub pagination bound must be between 1 and ${MAX_MAX_PAGES}`);
  }
  return bound;
}

async function listAllComments(input: {
  readonly maxPages?: number;
  list(cursor?: string): Promise<IssueRelayGitHubCommentPage>;
}): Promise<readonly IssueRelayGitHubComment[]> {
  const limit = pageBound(input.maxPages);
  const comments = new Map<number, IssueRelayGitHubComment>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < limit; page += 1) {
    const result = await input.list(cursor);
    for (const comment of result.comments) {
      const previous = comments.get(comment.id);
      if (previous !== undefined && !sameComment(previous, comment)) {
        throw new Error(`Relay GitHub comment ${comment.id} changed across pagination`);
      }
      comments.set(comment.id, comment);
    }
    if (result.nextCursor === undefined) return [...comments.values()];
    if (seenCursors.has(result.nextCursor)) {
      throw new Error('Relay GitHub pagination repeated a cursor');
    }
    seenCursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new Error(`Relay GitHub pagination exceeded its ${limit}-page bound`);
}

function sameCorrelation(
  left: IssueRelayCorrelationV1,
  right: IssueRelayCorrelationV1,
): boolean {
  return left.generation === right.generation
    && left.round === right.round
    && left.snapshotDigest === right.snapshotDigest
    && left.taskId === right.taskId
    && left.attemptIndex === right.attemptIndex
    && left.requestId === right.requestId
    && left.deliveryEnvelopeCid === right.deliveryEnvelopeCid;
}

function sameStableDelivery(
  left: IssueRelayCorrelationV1,
  right: IssueRelayCorrelationV1,
): boolean {
  return left.taskId === right.taskId
    && left.attemptIndex === right.attemptIndex
    && left.requestId === right.requestId
    && left.deliveryEnvelopeCid === right.deliveryEnvelopeCid;
}

function uniqueCanonical<T>(values: readonly T[]): readonly T[] {
  const entries = new Map(values.map((value) => [JSON.stringify(value), value]));
  return [...entries.values()];
}

function contradictory(detail: string): IssueRelayEvaluationReceiptObservation {
  return { state: 'contradictory', detail };
}

function markerContradiction(input: {
  readonly marker: IssueRelayGenerationMarker;
  readonly round: IssueRelayRoundV1;
  readonly issueNumber: number;
  readonly correlation: IssueRelayCorrelationV1;
}): string | null {
  const markerRound = input.marker.rounds[input.round.round];
  if (
    input.marker.generation !== input.round.generation
    || input.marker.snapshot.snapshotDigest !== input.round.snapshotDigest
    || input.marker.snapshot.repository.slug !== input.round.targetRepository
    || input.marker.snapshot.issue.number !== input.issueNumber
  ) {
    return 'Relay issue generation marker does not match the exact round';
  }
  if (
    markerRound === undefined
    || markerRound.round !== input.round.round
    || markerRound.purpose !== input.round.purpose
    || markerRound.workspaceRepository !== input.round.workspaceRepository
    || markerRound.inputHead !== input.round.inputHead
    || markerRound.task?.taskId !== input.correlation.taskId
    || markerRound.solution?.envelopeCid !== input.correlation.deliveryEnvelopeCid
  ) {
    return 'Relay issue generation marker round/task/solution binding is contradictory';
  }
  if (
    markerRound.task.taskKey
      !== `issue-relay:${input.round.generation}:round:${input.round.round}`
  ) {
    return 'Relay issue generation marker task key is contradictory';
  }
  if (
    input.round.purpose === 'repair'
    && input.round.prNumber !== input.marker.pr?.number
  ) {
    return 'Relay issue generation marker repair PR is contradictory';
  }
  if (input.marker.pr === undefined) {
    return 'Relay issue generation marker does not name a pull request';
  }
  return null;
}

/**
 * Observes only service-authored, canonical Relay comments and live PR facts.
 * This is a read-only admission boundary: malformed, mutable, conflicting, or
 * stale evidence never becomes evaluator context.
 */
export async function observeExactIssueRelayEvaluationReceipts(input: {
  readonly round: IssueRelayRoundV1;
  readonly issueNumber: number;
  readonly correlation: IssueRelayCorrelationV1;
  readonly relayBotLogin: string;
  readonly github: IssueRelayGitHubReadPort;
  readonly maxPages?: number;
}): Promise<IssueRelayEvaluationReceiptObservation> {
  const parsedRound = IssueRelayRoundV1Schema.safeParse(input.round);
  if (!parsedRound.success || input.relayBotLogin.trim().length === 0) {
    return contradictory('Relay round or exact bot identity is invalid');
  }

  let issueComments: readonly IssueRelayGitHubComment[];
  try {
    issueComments = await listAllComments({
      maxPages: input.maxPages,
      list: (cursor) => input.github.listIssueComments({
        repository: input.round.targetRepository,
        issueNumber: input.issueNumber,
        ...(cursor === undefined ? {} : { cursor }),
      }),
    });
  } catch (error) {
    return contradictory(error instanceof Error ? error.message : String(error));
  }

  const bot = normalizedLogin(input.relayBotLogin);
  const markers = uniqueCanonical(issueComments
    .filter((comment) => normalizedLogin(comment.authorLogin) === bot)
    .map((comment) => parseGenerationMarker(comment.body))
    .filter((marker): marker is IssueRelayGenerationMarker => marker !== null));
  const exactMarkers = markers.filter((marker) =>
    marker.generation === input.round.generation);
  if (exactMarkers.length === 0) {
    return { state: 'pending', detail: 'No exact service-authored Relay generation marker is observable' };
  }
  if (exactMarkers.length !== 1) {
    return contradictory('Conflicting service-authored Relay generation markers are observable');
  }
  const marker = exactMarkers[0]!;
  const round = parsedRound.data as IssueRelayRoundV1;
  const markerProblem = markerContradiction({
    marker,
    round,
    issueNumber: input.issueNumber,
    correlation: input.correlation,
  });
  if (markerProblem !== null) return contradictory(markerProblem);
  const prNumber = marker.pr!.number;

  let prComments: readonly IssueRelayGitHubComment[];
  try {
    prComments = await listAllComments({
      maxPages: input.maxPages,
      list: (cursor) => input.github.listPullRequestComments({
        repository: input.round.targetRepository,
        prNumber,
        ...(cursor === undefined ? {} : { cursor }),
      }),
    });
  } catch (error) {
    return contradictory(error instanceof Error ? error.message : String(error));
  }
  const authorizedComments = prComments.filter((comment) =>
    normalizedLogin(comment.authorLogin) === bot);
  const receipts = uniqueCanonical(authorizedComments
    .map((comment) => parseIssueRelayAdoptionReceiptComment(comment.body))
    .filter((value): value is IssueRelayAdoptionReceiptV1 => value !== null)
    .filter((value) => sameStableDelivery(value.correlation, input.correlation)));
  if (receipts.length === 0) {
    return { state: 'pending', detail: 'No exact accepted Relay adoption receipt is observable' };
  }
  if (new Set(receipts.map((value) => value.disposition)).size > 1) {
    return contradictory('Authorized accepted and rejected Relay receipts exist for the same delivery');
  }
  if (
    receipts.length !== 1
    || !sameCorrelation(receipts[0]!.correlation, input.correlation)
  ) {
    return contradictory('Relay adoption receipt correlation is conflicting');
  }
  const parsedReceipt = IssueRelayAdoptionReceiptV1Schema.safeParse(receipts[0]);
  if (!parsedReceipt.success) return contradictory('Relay adoption receipt is malformed');
  const receipt = parsedReceipt.data as IssueRelayAdoptionReceiptV1;
  if (receipt.disposition === 'rejected') {
    return {
      state: 'rejected',
      receipt: receipt as Extract<
        IssueRelayAdoptionReceiptV1,
        { disposition: 'rejected' }
      >,
      detail: `Relay host rejected adoption: ${receipt.reason}`,
    };
  }

  const anchors = uniqueCanonical(authorizedComments
    .map((comment) => parseIssueRelayEvaluationAnchorComment(comment.body))
    .filter((value): value is IssueRelayEvaluationAnchorV1 => value !== null)
    .filter((value) => sameStableDelivery(value.correlation, input.correlation)));
  if (anchors.length === 0) {
    return { state: 'pending', detail: 'No exact Relay evaluation anchor is observable' };
  }
  if (
    anchors.length !== 1
    || !sameCorrelation(anchors[0]!.correlation, input.correlation)
  ) {
    return contradictory('Relay evaluation anchor correlation is conflicting');
  }
  const parsedAnchor = IssueRelayEvaluationAnchorV1Schema.safeParse(anchors[0]);
  if (!parsedAnchor.success) return contradictory('Relay evaluation anchor is malformed');
  const anchor = parsedAnchor.data as IssueRelayEvaluationAnchorV1;

  let pullRequest: IssueRelayPullRequestFacts;
  try {
    pullRequest = await input.github.readPullRequest({
      repository: input.round.targetRepository,
      prNumber,
    });
  } catch (error) {
    return contradictory(
      `Relay pull request read failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (pullRequest.headSha !== receipt.resultingHead) {
    return {
      state: 'pending',
      detail: `Current PR head ${pullRequest.headSha} does not match adopted head ${receipt.resultingHead}`,
    };
  }
  const markerRound = marker.rounds[input.round.round]!;
  const bindings: Array<[unknown, unknown, string]> = [
    [marker.pr!.number, receipt.prNumber, 'issue marker pull request'],
    [marker.pr!.head, receipt.resultingHead, 'issue marker head'],
    [marker.pr!.branch, receipt.headRef, 'issue marker head ref'],
    [markerRound.adoption?.resultingHead, receipt.resultingHead, 'marker adoption head'],
    [markerRound.adoption?.receiptDigest, anchor.adoptionReceiptDigest, 'adoption receipt digest'],
    [markerRound.checks?.head, receipt.resultingHead, 'marker check head'],
    [markerRound.checks?.status, 'passed', 'marker check status'],
    [markerRound.checks?.digest, anchor.checksDigest, 'marker check digest'],
    [pullRequest.number, receipt.prNumber, 'live pull request number'],
    [pullRequest.targetRepository, receipt.targetRepository, 'live target repository'],
    [pullRequest.workspaceRepository, receipt.workspaceRepository, 'live head repository'],
    [pullRequest.targetBase, anchor.targetBase, 'live target base'],
    [pullRequest.baseOid, anchor.baseOid, 'live base OID'],
    [pullRequest.headRef, receipt.headRef, 'live head ref'],
    [pullRequest.headSha, anchor.evaluatedHead, 'live evaluated head'],
    [anchor.targetRepository, receipt.targetRepository, 'anchor target repository'],
    [anchor.workspaceRepository, receipt.workspaceRepository, 'anchor workspace repository'],
    [anchor.prNumber, receipt.prNumber, 'anchor pull request'],
    [anchor.headRef, receipt.headRef, 'anchor head ref'],
    [anchor.evaluatedHead, receipt.resultingHead, 'anchor evaluated head'],
    [pullRequest.checks.digest, anchor.checksDigest, 'live check digest'],
  ];
  const mismatch = bindings.find(([left, right]) => left !== right);
  if (mismatch !== undefined) {
    return contradictory(`Relay ${mismatch[2]} is contradictory`);
  }

  return {
    state: 'accepted',
    marker,
    receipt: receipt as Extract<
      IssueRelayAdoptionReceiptV1,
      { disposition: 'accepted' }
    >,
    anchor,
    pullRequest,
  };
}

import {
  ORG,
  PROJECT_NUMBER,
  REPO,
  REPO_REST_DATABASE_ID,
} from '../dispatcher/constants.js';
import {
  ProjectFieldSchemaError,
  SCHEMA_DRIFT_MIN_ISSUE_COUNT,
  resolveCurrentSprintIterationId,
  type ProjectContentType,
  type ProjectSnapshot,
  type RateLimitInfo,
  type SnapshotItem,
} from '../dispatcher/project-snapshot.js';
import type {
  BlockedOn,
  Effort,
  IssueShape,
  Priority,
  ProjectStatus,
} from '../dispatcher/types.js';
import {
  ConditionalRestClient,
  type ConditionalRestResponse,
} from './github-rest.js';

const PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 100;

const PROJECT_FIELDS = [
  ['Status', 'single_select'],
  ['Priority', 'single_select'],
  ['Effort', 'single_select'],
  ['Blocked on', 'single_select'],
  ['Sprint', 'iteration'],
  ['Type', 'issue_type'],
] as const;

const VALID_STATUS = new Set(['Todo', 'In Progress', 'Human', 'In Review', 'Done']);
const VALID_PRIORITY = new Set(['P0', 'P1', 'P2', 'P3', 'P4']);
const VALID_EFFORT = new Set(['Low', 'Medium', 'High', 'XHigh', 'Max']);
const VALID_BLOCKED_ON = new Set(['Nothing', 'Human', 'Another issue']);
const VALID_SHAPES = new Set([
  'feat', 'fix', 'refactor', 'spike', 'chore', 'docs', 'test', 'incident', 'design',
]);

type ProjectFieldName = typeof PROJECT_FIELDS[number][0];
type ProjectFieldDataType = typeof PROJECT_FIELDS[number][1];

interface IterationConfiguration {
  readonly id: string;
  readonly startDate: string;
  readonly duration: number;
}

interface DiscoveredField {
  readonly id: number;
  readonly name: ProjectFieldName;
  readonly dataType: ProjectFieldDataType;
  readonly iterations: readonly IterationConfiguration[];
}

export interface OpenIssueIndexEntry {
  readonly number: number;
  readonly title: string;
  readonly updatedAt: string;
  readonly author: string;
  readonly labels: readonly string[];
}

export interface PullRequestIndexEntry {
  readonly number: number;
  readonly title: string;
  readonly state: 'OPEN' | 'CLOSED';
  readonly updatedAt: string;
  readonly headOid: string;
  readonly headRefName: string;
  readonly baseRefName: string;
  readonly isDraft: boolean;
  readonly closedAt: string | null;
  readonly mergedAt: string | null;
}

export interface ActionIssueEntry {
  readonly number: number;
  readonly title: string;
  readonly open: boolean;
  readonly author: string;
  readonly labels: readonly string[];
}

export interface ActionPullRequestEntry {
  readonly number: number;
  readonly headRefName: string;
  readonly headOid: string;
  readonly baseRefName: string;
  readonly draft: boolean;
  readonly labels: readonly string[];
  readonly body: string;
}

export interface GitHubRestDiscoveryReaderOptions {
  readonly maxPages?: number;
}

export interface RestProjectSnapshotOptions {
  readonly nowMs?: number;
}

export class GitHubRestSchemaError extends Error {
  constructor(detail: string) {
    super(`GitHub REST discovery schema is invalid: ${detail}`);
    this.name = 'GitHubRestSchemaError';
  }
}

export class GitHubRestPaginationError extends Error {
  constructor(detail: string) {
    super(`GitHub REST pagination is incomplete: ${detail}`);
    this.name = 'GitHubRestPaginationError';
  }
}

function record(value: unknown, subject: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GitHubRestSchemaError(`${subject} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rows(value: unknown, subject: string): unknown[] {
  if (!Array.isArray(value)) throw new GitHubRestSchemaError(`${subject} must be an array`);
  return value;
}

function nonEmptyString(value: unknown, subject: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new GitHubRestSchemaError(`${subject} must be a non-empty string`);
  }
  return value;
}

function positiveInteger(value: unknown, subject: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new GitHubRestSchemaError(`${subject} must be a positive integer`);
  }
  return value;
}

function exactUtcTimestamp(value: unknown, subject: string): {
  readonly value: string;
  readonly ms: number;
} {
  const timestamp = nonEmptyString(value, subject);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/
    .exec(timestamp);
  if (match === null) {
    throw new GitHubRestSchemaError(`${subject} must be an exact UTC ISO-8601 timestamp`);
  }
  const [year, month, day, hour, minute, second, millisecond] = match
    .slice(1)
    .map((part) => Number(part ?? '0')) as [number, number, number, number, number, number, number];
  const ms = Date.parse(timestamp);
  const parsed = new Date(ms);
  if (
    !Number.isFinite(ms)
    || parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() + 1 !== month
    || parsed.getUTCDate() !== day
    || parsed.getUTCHours() !== hour
    || parsed.getUTCMinutes() !== minute
    || parsed.getUTCSeconds() !== second
    || parsed.getUTCMilliseconds() !== millisecond
  ) {
    throw new GitHubRestSchemaError(`${subject} contains an impossible UTC calendar value`);
  }
  return { value: timestamp, ms };
}

function isoTimestamp(value: unknown, subject: string): string {
  return exactUtcTimestamp(value, subject).value;
}

function nullableTimestamp(value: unknown, subject: string): string | null {
  return value === null ? null : isoTimestamp(value, subject);
}

function dateOnly(value: unknown, subject: string): string {
  const date = nonEmptyString(value, subject);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) {
    throw new GitHubRestSchemaError(`${subject} must be an exact YYYY-MM-DD date`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.parse(`${date}T00:00:00.000Z`));
  if (
    !Number.isFinite(parsed.getTime())
    || parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() + 1 !== month
    || parsed.getUTCDate() !== day
  ) {
    throw new GitHubRestSchemaError(`${subject} contains an impossible calendar date`);
  }
  return date;
}

function parseIterationConfiguration(value: unknown): readonly IterationConfiguration[] {
  const configuration = record(value, 'Sprint field configuration');
  return rows(configuration.iterations, 'Sprint field configuration.iterations').map(
    (entry, index) => {
      const iteration = record(entry, `Sprint iteration ${index}`);
      return {
        id: nonEmptyString(iteration.id, `Sprint iteration ${index}.id`),
        startDate: dateOnly(iteration.start_date, `Sprint iteration ${index}.start_date`),
        duration: positiveInteger(iteration.duration, `Sprint iteration ${index}.duration`),
      };
    },
  );
}

function discoverFields(input: readonly unknown[]): Map<ProjectFieldName, DiscoveredField> {
  const discovered = new Map<ProjectFieldName, DiscoveredField>();
  for (const [index, raw] of input.entries()) {
    const field = record(raw, `Project field ${index}`);
    const name = nonEmptyString(field.name, `Project field ${index}.name`);
    const expected = PROJECT_FIELDS.find(([requiredName]) => requiredName === name);
    if (expected === undefined) continue;
    if (field.data_type !== expected[1]) {
      throw new GitHubRestSchemaError(
        `Project field '${name}' must have data_type '${expected[1]}'`,
      );
    }
    if (discovered.has(expected[0])) {
      throw new GitHubRestSchemaError(`Project field '${name}' is duplicated`);
    }
    discovered.set(expected[0], {
      id: positiveInteger(field.id, `Project field '${name}'.id`),
      name: expected[0],
      dataType: expected[1],
      iterations: expected[0] === 'Sprint'
        ? parseIterationConfiguration(field.configuration)
        : [],
    });
  }
  for (const [name] of PROJECT_FIELDS) {
    if (!discovered.has(name)) {
      throw new GitHubRestSchemaError(`required Project field '${name}' is missing`);
    }
  }
  return discovered;
}

function richName(value: unknown, subject: string): string {
  const rich = record(value, subject);
  return nonEmptyString(rich.raw, `${subject}.raw`);
}

function parseNamedValue(value: unknown, subject: string): string | null {
  if (value === null) return null;
  const selected = record(value, subject);
  nonEmptyString(selected.id, `${subject}.id`);
  return richName(selected.name, `${subject}.name`);
}

function parseSprintValue(value: unknown): string | null {
  if (value === null) return null;
  const iteration = record(value, 'Sprint item value');
  const id = nonEmptyString(iteration.id, 'Sprint item value.id');
  richName(iteration.title, 'Sprint item value.title');
  dateOnly(iteration.start_date, 'Sprint item value.start_date');
  positiveInteger(iteration.duration, 'Sprint item value.duration');
  return id;
}

function parseIssueTypeValue(value: unknown): string | null {
  if (value === null) return null;
  const issueType = record(value, 'Type item value');
  positiveInteger(issueType.id, 'Type item value.id');
  nonEmptyString(issueType.node_id, 'Type item value.node_id');
  return nonEmptyString(issueType.name, 'Type item value.name');
}

function knownValue<T extends string>(
  value: string | null,
  valid: ReadonlySet<string>,
  subject: string,
): T | null {
  if (value === null) return null;
  if (!valid.has(value)) {
    throw new GitHubRestSchemaError(`${subject} taxonomy option '${value}' is unknown`);
  }
  return value as T;
}

function itemFieldValues(
  item: Record<string, unknown>,
  fields: ReadonlyMap<ProjectFieldName, DiscoveredField>,
): Map<ProjectFieldName, unknown> {
  const byName = new Map<ProjectFieldName, unknown>();
  const byId = new Map([...fields.values()].map((field) => [field.id, field]));
  for (const [index, raw] of rows(item.fields, 'Project item.fields').entries()) {
    const entry = record(raw, `Project item field ${index}`);
    const id = positiveInteger(entry.id, `Project item field ${index}.id`);
    const expected = byId.get(id);
    if (expected === undefined) {
      throw new GitHubRestSchemaError(`Project item returned unrequested field id ${id}`);
    }
    if (entry.name !== expected.name || entry.data_type !== expected.dataType) {
      throw new GitHubRestSchemaError(
        `Project item field ${id} metadata does not match discovered field '${expected.name}'`,
      );
    }
    if (!Object.hasOwn(entry, 'value')) {
      throw new GitHubRestSchemaError(`Project item field '${expected.name}' has no value member`);
    }
    if (byName.has(expected.name)) {
      throw new GitHubRestSchemaError(`Project item field '${expected.name}' is duplicated`);
    }
    byName.set(expected.name, entry.value);
  }
  for (const [name] of PROJECT_FIELDS) {
    if (!byName.has(name)) {
      throw new GitHubRestSchemaError(`Project item field '${name}' is missing`);
    }
  }
  return byName;
}

function contentType(value: unknown): ProjectContentType {
  if (value === 'Issue' || value === 'PullRequest' || value === 'DraftIssue') return value;
  throw new GitHubRestSchemaError('Project item content_type is unknown');
}

function parseProjectItem(
  input: unknown,
  fields: ReadonlyMap<ProjectFieldName, DiscoveredField>,
): SnapshotItem | null {
  const item = record(input, 'Project item');
  const nodeId = nonEmptyString(item.node_id, 'Project item.node_id');
  const type = contentType(item.content_type);
  if (item.content === null) return null;
  const content = record(item.content, 'Project item.content');
  const number = type === 'DraftIssue'
    ? -1
    : positiveInteger(content.number, 'Project item.content.number');
  const values = itemFieldValues(item, fields);
  const status = parseNamedValue(values.get('Status'), 'Status item value');
  const priority = parseNamedValue(values.get('Priority'), 'Priority item value');
  const effort = parseNamedValue(values.get('Effort'), 'Effort item value');
  const blockedOn = parseNamedValue(values.get('Blocked on'), 'Blocked on item value');
  const shape = parseIssueTypeValue(values.get('Type'));
  return {
    id: nodeId,
    number,
    contentType: type,
    status: knownValue<ProjectStatus>(status, VALID_STATUS, 'Status'),
    priority: knownValue<Priority>(priority, VALID_PRIORITY, 'Priority'),
    effort: knownValue<Effort>(effort, VALID_EFFORT, 'Effort'),
    blockedOn: knownValue<BlockedOn>(blockedOn, VALID_BLOCKED_ON, 'Blocked on'),
    issueType: type === 'Issue'
      ? knownValue<IssueShape>(shape, VALID_SHAPES, 'Type')
      : null,
    blockedByIssues: [],
    sprintIterationId: parseSprintValue(values.get('Sprint')),
  };
}

function parseDependencyNumbers(input: readonly unknown[]): number[] {
  return input.map((raw, index) => {
    const dependency = record(raw, `blocked_by dependency ${index}`);
    return positiveInteger(dependency.number, `blocked_by dependency ${index}.number`);
  });
}

function parseLabels(value: unknown, subject: string): string[] {
  return rows(value, subject).map((raw, index) => {
    if (typeof raw === 'string' && raw.length > 0) return raw;
    const label = record(raw, `${subject}[${index}]`);
    return nonEmptyString(label.name, `${subject}[${index}].name`);
  });
}

function parseIssueIndexRow(input: unknown, index: number): OpenIssueIndexEntry | null {
  const issue = record(input, `open issue ${index}`);
  const number = positiveInteger(issue.number, `open issue ${index}.number`);
  if (issue.state !== 'open') {
    throw new GitHubRestSchemaError(`open issue ${index}.state must be 'open'`);
  }
  if (Object.hasOwn(issue, 'pull_request')) {
    const marker = record(issue.pull_request, `open issue ${index}.pull_request`);
    const apiUrl = `https://api.github.com/repos/${REPO}/pulls/${number}`;
    const htmlUrl = `https://github.com/${REPO}/pull/${number}`;
    const expected = new Map<string, string>([
      ['url', apiUrl],
      ['html_url', htmlUrl],
      ['diff_url', `${htmlUrl}.diff`],
      ['patch_url', `${htmlUrl}.patch`],
    ]);
    for (const [field, value] of expected) {
      if (marker[field] !== value) {
        throw new GitHubRestSchemaError(
          `open issue ${index}.pull_request.${field} does not identify PR #${number}`,
        );
      }
    }
    return null;
  }
  const user = issue.user === null || issue.user === undefined
    ? null
    : record(issue.user, `open issue ${index}.user`);
  return {
    number,
    title: nonEmptyString(issue.title, `open issue ${index}.title`),
    updatedAt: isoTimestamp(issue.updated_at, `open issue ${index}.updated_at`),
    author: user === null ? '' : nonEmptyString(user.login, `open issue ${index}.user.login`),
    labels: parseLabels(issue.labels, `open issue ${index}.labels`),
  };
}

function parsePullRequestIndexRow(
  input: unknown,
  index: number,
  expectedState: 'open' | 'closed',
): PullRequestIndexEntry {
  const pr = record(input, `pull request ${index}`);
  if (pr.state !== expectedState) {
    throw new GitHubRestSchemaError(`pull request ${index}.state is not '${expectedState}'`);
  }
  if (typeof pr.draft !== 'boolean') {
    throw new GitHubRestSchemaError(`pull request ${index}.draft must be boolean`);
  }
  const head = record(pr.head, `pull request ${index}.head`);
  const base = record(pr.base, `pull request ${index}.base`);
  const headOid = nonEmptyString(head.sha, `pull request ${index}.head.sha`);
  if (!/^[0-9a-f]{40}$/.test(headOid)) {
    throw new GitHubRestSchemaError(`pull request ${index}.head.sha must be a 40-character OID`);
  }
  const number = positiveInteger(pr.number, `pull request ${index}.number`);
  const title = nonEmptyString(pr.title, `pull request ${index}.title`);
  const updatedAt = isoTimestamp(pr.updated_at, `pull request ${index}.updated_at`);
  const headRefName = nonEmptyString(head.ref, `pull request ${index}.head.ref`);
  const baseRefName = nonEmptyString(base.ref, `pull request ${index}.base.ref`);
  let closedAt: string | null;
  let mergedAt: string | null;
  if (expectedState === 'open') {
    if (pr.closed_at !== null || pr.merged_at !== null) {
      throw new GitHubRestSchemaError(
        `pull request ${index} is open but closed_at or merged_at is non-null`,
      );
    }
    closedAt = null;
    mergedAt = null;
  } else {
    closedAt = isoTimestamp(pr.closed_at, `pull request ${index}.closed_at`);
    mergedAt = nullableTimestamp(pr.merged_at, `pull request ${index}.merged_at`);
    const updatedMs = exactUtcTimestamp(updatedAt, `pull request ${index}.updated_at`).ms;
    const closedMs = exactUtcTimestamp(closedAt, `pull request ${index}.closed_at`).ms;
    if (closedMs > updatedMs) {
      throw new GitHubRestSchemaError(`pull request ${index} was updated before it closed`);
    }
    if (
      mergedAt !== null
      && exactUtcTimestamp(mergedAt, `pull request ${index}.merged_at`).ms > closedMs
    ) {
      throw new GitHubRestSchemaError(`pull request ${index} merged after it closed`);
    }
  }
  return {
    number,
    title,
    state: expectedState === 'open' ? 'OPEN' : 'CLOSED',
    updatedAt,
    headOid,
    headRefName,
    baseRefName,
    isDraft: pr.draft,
    closedAt,
    mergedAt,
  };
}

type PaginationMode = 'after' | 'page' | 'page+after';

interface EndpointQueryPart {
  readonly key: string;
  readonly value: string;
  readonly raw: string;
}

interface ParsedEndpoint {
  readonly path: string;
  readonly query: readonly EndpointQueryPart[];
}

function decodeQueryPart(value: string, subject: string): string {
  try {
    return decodeURIComponent(value.replaceAll('+', '%20'));
  } catch {
    throw new GitHubRestPaginationError(`${subject} is not valid percent-encoding`);
  }
}

function parseEndpoint(endpoint: string, subject: string): ParsedEndpoint {
  const question = endpoint.indexOf('?');
  const path = question < 0 ? endpoint : endpoint.slice(0, question);
  const rawQuery = question < 0 ? '' : endpoint.slice(question + 1);
  if (path.length === 0 || rawQuery.length === 0) {
    throw new GitHubRestPaginationError(`${subject} must contain a path and query`);
  }
  const seen = new Set<string>();
  const query = rawQuery.split('&').map((raw): EndpointQueryPart => {
    const equals = raw.indexOf('=');
    if (equals <= 0) {
      throw new GitHubRestPaginationError(`${subject} query member is malformed`);
    }
    const key = decodeQueryPart(raw.slice(0, equals), `${subject} query key`);
    const value = decodeQueryPart(raw.slice(equals + 1), `${subject} query value`);
    if (seen.has(key)) {
      throw new GitHubRestPaginationError(`${subject} query key '${key}' is duplicated`);
    }
    seen.add(key);
    return { key, value, raw };
  });
  return { path, query };
}

function allowedPaginationPath(original: string, linked: string): boolean {
  if (linked === original) return true;
  const named = /^orgs\/([^/]+)\/projectsV2\/([1-9][0-9]*)\/(fields|items)$/.exec(original);
  const numeric = /^organizations\/([1-9][0-9]*)\/projectsV2\/([1-9][0-9]*)\/(fields|items)$/
    .exec(linked);
  if (named?.[1] === ORG
    && named[2] === numeric?.[2]
    && named[3] === numeric?.[3]) {
    return true;
  }
  const namedRepositoryPrefix = `repos/${REPO}/`;
  const numericRepositoryPrefix = `repositories/${REPO_REST_DATABASE_ID}/`;
  if (
    !original.startsWith(namedRepositoryPrefix)
    || !linked.startsWith(numericRepositoryPrefix)
  ) {
    return false;
  }
  const originalTail = original.slice(namedRepositoryPrefix.length);
  return originalTail.length > 0
    && linked.slice(numericRepositoryPrefix.length) === originalTail;
}

class ConfinedPaginator {
  private readonly original: ParsedEndpoint;
  private readonly immutable: readonly EndpointQueryPart[];
  private readonly immutableByKey: ReadonlyMap<string, string>;
  private readonly seenCursors = new Set<string>();
  private currentCursor: string | null;
  private currentPage: number | null;

  constructor(
    originalEndpoint: string,
    private readonly mode: PaginationMode,
  ) {
    this.original = parseEndpoint(originalEndpoint, 'original endpoint');
    this.immutable = this.original.query.filter((part) => (
      part.key !== mode && (mode !== 'page+after' || (part.key !== 'page' && part.key !== 'after'))
    ));
    this.immutableByKey = new Map(this.immutable.map((part) => [part.key, part.value]));
    const page = this.original.query.find((part) => part.key === 'page')?.value
      ?? (mode === 'page' || mode === 'page+after' ? '1' : null);
    if (page !== null && !/^[1-9][0-9]*$/.test(page)) {
      throw new GitHubRestPaginationError('original page cursor is not a positive integer');
    }
    this.currentPage = page === null ? null : Number(page);
    this.currentCursor = mode === 'page+after'
      ? this.original.query.find((part) => part.key === 'after')?.value ?? null
      : this.original.query.find((part) => part.key === mode)?.value
        ?? (mode === 'page' ? '1' : null);
    if (this.currentCursor !== null) this.seenCursors.add(this.currentCursor);
  }

  next(linkedEndpoint: string | null): string | null {
    if (linkedEndpoint === null) return null;
    const linked = parseEndpoint(linkedEndpoint, 'next Link');
    if (!allowedPaginationPath(this.original.path, linked.path)) {
      throw new GitHubRestPaginationError('next Link changed the resource path');
    }
    const linkedByKey = new Map(linked.query.map((part) => [part.key, part.value]));
    const cursorKeys = this.mode === 'page+after' ? ['page', 'after'] : [this.mode];
    if (
      linkedByKey.size !== this.immutableByKey.size + cursorKeys.length
      || cursorKeys.some((key) => !linkedByKey.has(key))
    ) {
      throw new GitHubRestPaginationError('next Link has missing or unknown query keys');
    }
    for (const [key, expected] of this.immutableByKey) {
      if (linkedByKey.get(key) !== expected) {
        throw new GitHubRestPaginationError(`next Link changed immutable query filter '${key}'`);
      }
    }
    if (this.mode === 'page+after') {
      const nextPageText = linkedByKey.get('page')!;
      const nextCursor = linkedByKey.get('after')!;
      if (!/^[1-9][0-9]*$/.test(nextPageText)) {
        throw new GitHubRestPaginationError('next Link page cursor is not a positive integer');
      }
      const nextPage = Number(nextPageText);
      if (
        !Number.isSafeInteger(nextPage)
        || this.currentPage === null
        || nextPage !== this.currentPage + 1
      ) {
        throw new GitHubRestPaginationError('next Link page cursor did not advance by one');
      }
      if (nextCursor.length === 0 || this.seenCursors.has(nextCursor)) {
        throw new GitHubRestPaginationError('next Link cursor did not progress');
      }
      this.seenCursors.add(nextCursor);
      this.currentCursor = nextCursor;
      this.currentPage = nextPage;
      return this.reconstructedEndpoint([
        `page=${encodeURIComponent(nextPageText)}`,
        `after=${encodeURIComponent(nextCursor)}`,
      ]);
    }
    const nextCursor = linkedByKey.get(this.mode)!;
    if (nextCursor.length === 0 || this.seenCursors.has(nextCursor)) {
      throw new GitHubRestPaginationError('next Link cursor did not progress');
    }
    if (this.mode === 'page') {
      if (!/^[1-9][0-9]*$/.test(nextCursor)) {
        throw new GitHubRestPaginationError('next Link page cursor is not a positive integer');
      }
      const nextPage = Number(nextCursor);
      if (
        !Number.isSafeInteger(nextPage)
        || this.currentPage === null
        || nextPage !== this.currentPage + 1
      ) {
        throw new GitHubRestPaginationError('next Link page cursor did not advance by one');
      }
      this.currentPage = nextPage;
    }
    this.seenCursors.add(nextCursor);
    this.currentCursor = nextCursor;
    return this.reconstructedEndpoint([`${this.mode}=${encodeURIComponent(nextCursor)}`]);
  }

  private reconstructedEndpoint(cursorParts: readonly string[]): string {
    return `${this.original.path}?${[
      ...this.immutable.map((part) => part.raw),
      ...cursorParts,
    ].join('&')}`;
  }
}

export class GitHubRestDiscoveryReader {
  private readonly maxPages: number;

  constructor(
    private readonly rest: ConditionalRestClient,
    options: GitHubRestDiscoveryReaderOptions = {},
  ) {
    this.maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    if (!Number.isSafeInteger(this.maxPages) || this.maxPages <= 0) {
      throw new Error('GitHub REST maxPages must be a positive integer');
    }
  }

  private async readPages(
    startEndpoint: string,
    mode: PaginationMode,
  ): Promise<{
    readonly rows: unknown[];
    readonly rateLimit: RateLimitInfo;
  }> {
    const allRows: unknown[] = [];
    const seen = new Set<string>();
    const paginator = new ConfinedPaginator(startEndpoint, mode);
    let endpoint: string | null = startEndpoint;
    let last: ConditionalRestResponse | null = null;
    for (let page = 1; endpoint !== null; page += 1) {
      if (page > this.maxPages) {
        throw new GitHubRestPaginationError(`exceeded ${this.maxPages} pages`);
      }
      if (seen.has(endpoint)) {
        throw new GitHubRestPaginationError(`next-link loop at '${endpoint}'`);
      }
      seen.add(endpoint);
      last = await this.rest.getJson(endpoint);
      allRows.push(...rows(last.body, `REST page ${page}`));
      endpoint = paginator.next(last.nextEndpoint);
    }
    if (last === null) throw new GitHubRestPaginationError('no page was read');
    return { rows: allRows, rateLimit: last.rateLimit };
  }

  async readIssueForAction(issueNumber: number): Promise<ActionIssueEntry | null> {
    positiveInteger(issueNumber, 'target issue number');
    const response = await this.rest.getJson(`repos/${REPO}/issues/${issueNumber}`);
    const issue = record(response.body, `target issue ${issueNumber}`);
    if (positiveInteger(issue.number, `target issue ${issueNumber}.number`) !== issueNumber) {
      throw new GitHubRestSchemaError('target issue response returned a different number');
    }
    if (Object.hasOwn(issue, 'pull_request')) {
      throw new GitHubRestSchemaError('target issue response identified a pull request');
    }
    if (issue.state !== 'open' && issue.state !== 'closed') {
      throw new GitHubRestSchemaError(`target issue ${issueNumber}.state is unknown`);
    }
    const user = record(issue.user, `target issue ${issueNumber}.user`);
    return {
      number: issueNumber,
      title: nonEmptyString(issue.title, `target issue ${issueNumber}.title`),
      open: issue.state === 'open',
      author: nonEmptyString(user.login, `target issue ${issueNumber}.user.login`),
      labels: parseLabels(issue.labels, `target issue ${issueNumber}.labels`),
    };
  }

  async readBlockedByIssueNumbersForAction(issueNumber: number): Promise<readonly number[]> {
    positiveInteger(issueNumber, 'target dependency issue number');
    const pages = await this.readPages(
      `repos/${REPO}/issues/${issueNumber}/dependencies/blocked_by`
        + `?per_page=${PAGE_SIZE}&page=1`,
      'page',
    );
    return parseDependencyNumbers(pages.rows);
  }

  async readPullRequestForAction(prNumber: number): Promise<ActionPullRequestEntry | null> {
    positiveInteger(prNumber, 'target pull request number');
    const response = await this.rest.getJson(`repos/${REPO}/pulls/${prNumber}`);
    const pr = record(response.body, `target pull request ${prNumber}`);
    if (positiveInteger(pr.number, `target pull request ${prNumber}.number`) !== prNumber) {
      throw new GitHubRestSchemaError('target pull request response returned a different number');
    }
    if (pr.state === 'closed') return null;
    if (pr.state !== 'open') {
      throw new GitHubRestSchemaError(`target pull request ${prNumber}.state is unknown`);
    }
    if (typeof pr.draft !== 'boolean') {
      throw new GitHubRestSchemaError(`target pull request ${prNumber}.draft must be boolean`);
    }
    const head = record(pr.head, `target pull request ${prNumber}.head`);
    const base = record(pr.base, `target pull request ${prNumber}.base`);
    return {
      number: prNumber,
      headRefName: nonEmptyString(head.ref, `target pull request ${prNumber}.head.ref`),
      headOid: nonEmptyString(head.sha, `target pull request ${prNumber}.head.sha`),
      baseRefName: nonEmptyString(base.ref, `target pull request ${prNumber}.base.ref`),
      draft: pr.draft,
      labels: parseLabels(pr.labels, `target pull request ${prNumber}.labels`),
      body: typeof pr.body === 'string' ? pr.body : '',
    };
  }

  async readProjectSnapshot(
    options: RestProjectSnapshotOptions = {},
  ): Promise<ProjectSnapshot> {
    const fieldPages = await this.readPages(
      `orgs/${ORG}/projectsV2/${PROJECT_NUMBER}/fields?per_page=${PAGE_SIZE}`,
      'after',
    );
    const fields = discoverFields(fieldPages.rows);
    const fieldIds = PROJECT_FIELDS.map(([name]) => fields.get(name)!.id);
    const itemPages = await this.readPages(
      `orgs/${ORG}/projectsV2/${PROJECT_NUMBER}/items?fields=${fieldIds.join(',')}`
        + `&per_page=${PAGE_SIZE}`,
      'after',
    );
    const items = itemPages.rows
      .map((item) => parseProjectItem(item, fields))
      .filter((item): item is SnapshotItem => item !== null);
    const issues = items.filter((item) => item.contentType === 'Issue');
    if (issues.length >= SCHEMA_DRIFT_MIN_ISSUE_COUNT) {
      if (issues.every((item) => (
        item.status === null
        && item.priority === null
        && item.effort === null
        && item.blockedOn === null
      ))) {
        throw new ProjectFieldSchemaError(issues.length, 'all');
      }
      if (issues.every((item) => item.status === null)) {
        throw new ProjectFieldSchemaError(issues.length, 'Status');
      }
    }
    let rateLimit = itemPages.rateLimit;
    for (const item of items) {
      if (
        item.contentType !== 'Issue'
        || item.blockedOn !== 'Another issue'
      ) continue;
      const dependencyPages = await this.readPages(
        `repos/${REPO}/issues/${item.number}/dependencies/blocked_by`
          + `?per_page=${PAGE_SIZE}&page=1`,
        'page',
      );
      item.blockedByIssues = parseDependencyNumbers(dependencyPages.rows);
      rateLimit = dependencyPages.rateLimit;
    }
    const sprint = fields.get('Sprint')!;
    return {
      items,
      rateLimit,
      currentSprintIterationId: resolveCurrentSprintIterationId(
        sprint.iterations.map((iteration) => ({
          id: iteration.id,
          startDate: iteration.startDate,
          duration: iteration.duration,
        })),
        options.nowMs ?? Date.now(),
      ),
    };
  }

  async readOpenIssueIndex(): Promise<readonly OpenIssueIndexEntry[]> {
    const pages = await this.readPages(
      `repos/${REPO}/issues?state=open&sort=updated&direction=desc`
        + `&per_page=${PAGE_SIZE}&page=1`,
      'page+after',
    );
    return pages.rows
      .map(parseIssueIndexRow)
      .filter((issue): issue is OpenIssueIndexEntry => issue !== null);
  }

  async readOpenPullRequestIndex(): Promise<readonly PullRequestIndexEntry[]> {
    const pages = await this.readPages(
      `repos/${REPO}/pulls?state=open&sort=updated&direction=desc`
        + `&per_page=${PAGE_SIZE}&page=1`,
      'page',
    );
    return pages.rows.map((row, index) => parsePullRequestIndexRow(row, index, 'open'));
  }

  async readRecentlyClosedPullRequestIndex(
    updatedSince: string,
  ): Promise<readonly PullRequestIndexEntry[]> {
    const sinceMs = exactUtcTimestamp(updatedSince, 'recently-closed cutoff').ms;
    const result: PullRequestIndexEntry[] = [];
    const seen = new Set<string>();
    let endpoint: string | null =
      `repos/${REPO}/pulls?state=closed&sort=updated&direction=desc`
      + `&per_page=${PAGE_SIZE}&page=1`;
    const paginator = new ConfinedPaginator(endpoint, 'page');
    let previousUpdatedMs = Number.POSITIVE_INFINITY;
    for (let page = 1; endpoint !== null; page += 1) {
      if (page > this.maxPages) {
        throw new GitHubRestPaginationError(`exceeded ${this.maxPages} recently-closed PR pages`);
      }
      if (seen.has(endpoint)) {
        throw new GitHubRestPaginationError(`next-link loop at '${endpoint}'`);
      }
      seen.add(endpoint);
      const response = await this.rest.getJson(endpoint);
      const pageRows = rows(response.body, `recently-closed PR page ${page}`)
        .map((row, index) => parsePullRequestIndexRow(row, index, 'closed'));
      let reachedCutoff = false;
      for (const pr of pageRows) {
        const updatedMs = exactUtcTimestamp(pr.updatedAt, `pull request ${pr.number}.updated_at`).ms;
        if (updatedMs > previousUpdatedMs) {
          throw new GitHubRestSchemaError('recently-closed pull requests are not updated-descending');
        }
        previousUpdatedMs = updatedMs;
        if (updatedMs < sinceMs) {
          reachedCutoff = true;
          continue;
        }
        result.push(pr);
      }
      endpoint = reachedCutoff ? null : paginator.next(response.nextEndpoint);
    }
    return result;
  }
}

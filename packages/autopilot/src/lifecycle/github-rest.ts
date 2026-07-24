import type { CommandRunner } from '../dispatcher/issue-source.js';
import { defaultRunner } from '../dispatcher/issue-source.js';
import type { RateLimitInfo } from '../dispatcher/project-snapshot.js';
import {
  GitHubUsageMeter,
  commandErrorStdout,
  makeGitHubUsageCommandRunner,
} from './github-usage.js';

export const GITHUB_REST_API_VERSION = '2026-03-10';

export interface ConditionalRestCacheEntry {
  readonly etag: string;
  readonly body: string;
  readonly nextEndpoint: string | null;
}

/** Non-secret representation persisted by the lifecycle discovery cache. */
export interface PersistedConditionalRestCacheEntry extends ConditionalRestCacheEntry {
  readonly endpoint: string;
}

export interface ConditionalRestResponse {
  readonly body: unknown;
  readonly etag: string;
  readonly status: 200 | 304;
  readonly nextEndpoint: string | null;
  readonly rateLimit: RateLimitInfo;
}

export interface ConditionalRestClientOptions {
  readonly usageMeter?: GitHubUsageMeter;
  readonly runnerIsMetered?: boolean;
  readonly cache?: Map<string, ConditionalRestCacheEntry>;
}

export class ConditionalRestProtocolError extends Error {
  constructor(detail: string) {
    super(`GitHub conditional REST response is invalid: ${detail}`);
    this.name = 'ConditionalRestProtocolError';
  }
}

interface ParsedHttpResponse {
  readonly status: number;
  readonly headers: ReadonlyMap<string, readonly string[]>;
  readonly body: string;
}

function parseIncludedResponse(raw: string): ParsedHttpResponse {
  if (raw.includes('\0') || /\r(?!\n)/.test(raw)) {
    throw new ConditionalRestProtocolError('response contains invalid control characters');
  }
  const normalized = raw.replaceAll('\r\n', '\n');
  const boundary = normalized.indexOf('\n\n');
  if (boundary < 0) {
    throw new ConditionalRestProtocolError('header/body boundary is missing');
  }
  const headerLines = normalized.slice(0, boundary).split('\n');
  const statusLine = headerLines.shift();
  const statusMatch = /^(?:HTTP\/1\.[01]|HTTP\/2(?:\.0)?) ([1-5][0-9]{2})(?: [^\r\n]*)?$/.exec(
    statusLine ?? '',
  );
  if (statusMatch?.[1] === undefined) {
    throw new ConditionalRestProtocolError('HTTP status line is malformed');
  }
  const headers = new Map<string, string[]>();
  for (const line of headerLines) {
    const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*([^\r\n]*)$/.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) {
      throw new ConditionalRestProtocolError('HTTP header line is malformed');
    }
    const name = match[1].toLowerCase();
    const values = headers.get(name) ?? [];
    values.push(match[2].trim());
    headers.set(name, values);
  }
  return {
    status: Number(statusMatch[1]),
    headers,
    body: normalized.slice(boundary + 2),
  };
}

function oneHeader(
  response: ParsedHttpResponse,
  name: string,
  required = true,
): string | null {
  const values = response.headers.get(name);
  if (values === undefined) {
    if (!required) return null;
    throw new ConditionalRestProtocolError(`${name} header is missing`);
  }
  if (values.length !== 1 || values[0] === undefined || values[0].length === 0) {
    throw new ConditionalRestProtocolError(`${name} header must occur exactly once`);
  }
  return values[0];
}

function assertEtag(etag: string): void {
  if (!/^(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*"$/.test(etag)) {
    throw new ConditionalRestProtocolError('ETag is malformed');
  }
}

function weakEtagMatches(left: string, right: string): boolean {
  assertEtag(left);
  assertEtag(right);
  const leftOpaque = left.startsWith('W/') ? left.slice(2) : left;
  const rightOpaque = right.startsWith('W/') ? right.slice(2) : right;
  return leftOpaque === rightOpaque;
}

function integerHeader(response: ParsedHttpResponse, name: string): number {
  const raw = oneHeader(response, name)!;
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) {
    throw new ConditionalRestProtocolError(`${name} must be a non-negative integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new ConditionalRestProtocolError(`${name} exceeds the safe integer range`);
  }
  return value;
}

function parseRateLimit(response: ParsedHttpResponse): RateLimitInfo {
  if (oneHeader(response, 'x-ratelimit-resource') !== 'core') {
    throw new ConditionalRestProtocolError('x-ratelimit-resource must be core');
  }
  const resetSeconds = integerHeader(response, 'x-ratelimit-reset');
  const resetAt = new Date(resetSeconds * 1_000);
  if (!Number.isFinite(resetAt.getTime())) {
    throw new ConditionalRestProtocolError('x-ratelimit-reset is invalid');
  }
  return {
    remaining: integerHeader(response, 'x-ratelimit-remaining'),
    used: integerHeader(response, 'x-ratelimit-used'),
    resetAt: resetAt.toISOString(),
  };
}

function endpointFromLink(urlText: string): string {
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    throw new ConditionalRestProtocolError('Link URL is malformed');
  }
  if (
    url.protocol !== 'https:'
    || url.hostname !== 'api.github.com'
    || url.port !== ''
    || url.username !== ''
    || url.password !== ''
    || url.hash !== ''
  ) {
    throw new ConditionalRestProtocolError('Link URL is outside api.github.com');
  }
  return `${url.pathname.replace(/^\//, '')}${url.search}`;
}

function splitLinkHeader(raw: string): string[] {
  const segments: string[] = [];
  let start = 0;
  let inAngle = false;
  let inQuote = false;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (character === '<' && !inQuote) {
      if (inAngle) throw new ConditionalRestProtocolError('Link header is malformed');
      inAngle = true;
    } else if (character === '>' && !inQuote) {
      if (!inAngle) throw new ConditionalRestProtocolError('Link header is malformed');
      inAngle = false;
    } else if (character === '"' && !inAngle) {
      inQuote = !inQuote;
    } else if (character === ',' && !inAngle && !inQuote) {
      segments.push(raw.slice(start, index));
      start = index + 1;
    }
  }
  if (inAngle || inQuote) throw new ConditionalRestProtocolError('Link header is malformed');
  segments.push(raw.slice(start));
  return segments;
}

function parseNextEndpoint(response: ParsedHttpResponse): string | null {
  const raw = oneHeader(response, 'link', false);
  if (raw === null) return null;
  let next: string | null = null;
  for (const segment of splitLinkHeader(raw)) {
    const match = /^\s*<([^<>]+)>;\s*rel="(next|prev|first|last)"\s*$/.exec(segment);
    if (match?.[1] === undefined || match[2] === undefined) {
      throw new ConditionalRestProtocolError('Link header is malformed');
    }
    if (match[2] === 'next') {
      if (next !== null) {
        throw new ConditionalRestProtocolError('Link header has duplicate next relations');
      }
      next = endpointFromLink(match[1]);
    }
  }
  return next;
}

function parseJson(body: string, subject: string): unknown {
  if (body.length === 0) {
    throw new ConditionalRestProtocolError(`${subject} JSON body is empty`);
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ConditionalRestProtocolError(`${subject} JSON body is malformed`);
  }
}

export function isConfinedRestEndpoint(endpoint: string): boolean {
  if (
    endpoint.length === 0
    || endpoint.startsWith('-')
    || endpoint.startsWith('/')
    || endpoint.includes('://')
    || /[\u0000-\u0020\u007f]/.test(endpoint)
    || endpoint.includes('#')
    || endpoint.includes('\\')
  ) {
    return false;
  }
  const path = endpoint.split('?', 1)[0]!;
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(path);
  } catch {
    return false;
  }
  return decodedPath.length > 0
    && !decodedPath.includes('\\')
    && decodedPath.split('/').every((segment) => segment !== '.' && segment !== '..');
}

function assertEndpoint(endpoint: string): void {
  if (!isConfinedRestEndpoint(endpoint)) {
    throw new Error('GitHub REST endpoint must be a safe relative API path');
  }
}

export class ConditionalRestClient {
  private readonly run: CommandRunner;
  private readonly usageMeter: GitHubUsageMeter;
  private readonly cache: Map<string, ConditionalRestCacheEntry>;

  constructor(
    run: CommandRunner = defaultRunner,
    options: ConditionalRestClientOptions = {},
  ) {
    this.usageMeter = options.usageMeter ?? new GitHubUsageMeter();
    this.run = options.runnerIsMetered === true
      ? run
      : makeGitHubUsageCommandRunner(run, this.usageMeter);
    this.cache = options.cache ?? new Map();
  }

  exportCache(): readonly PersistedConditionalRestCacheEntry[] {
    return [...this.cache.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([endpoint, entry]) => ({ endpoint, ...entry }));
  }

  restoreCache(entries: readonly PersistedConditionalRestCacheEntry[]): void {
    const restored = new Map<string, ConditionalRestCacheEntry>();
    for (const entry of entries) {
      assertEndpoint(entry.endpoint);
      assertEtag(entry.etag);
      parseJson(entry.body, `cached response for ${entry.endpoint}`);
      if (entry.nextEndpoint !== null) assertEndpoint(entry.nextEndpoint);
      if (restored.has(entry.endpoint)) {
        throw new ConditionalRestProtocolError(
          `cache contains duplicate endpoint '${entry.endpoint}'`,
        );
      }
      restored.set(entry.endpoint, {
        etag: entry.etag,
        body: entry.body,
        nextEndpoint: entry.nextEndpoint,
      });
    }
    this.cache.clear();
    for (const [endpoint, entry] of restored) this.cache.set(endpoint, entry);
  }

  async getJson(endpoint: string): Promise<ConditionalRestResponse> {
    assertEndpoint(endpoint);
    const cached = this.cache.get(endpoint);
    if (cached !== undefined) assertEtag(cached.etag);
    const args = [
      'api',
      '--include',
      endpoint,
      '-H',
      'Accept: application/vnd.github+json',
      '-H',
      `X-GitHub-Api-Version: ${GITHUB_REST_API_VERSION}`,
    ];
    if (cached !== undefined) args.push('-H', `If-None-Match: ${cached.etag}`);

    let response: ParsedHttpResponse;
    try {
      response = parseIncludedResponse(await this.run('gh', args));
    } catch (error) {
      const stdout = commandErrorStdout(error);
      if (stdout === null) throw error;
      let rejectedResponse: ParsedHttpResponse;
      try {
        rejectedResponse = parseIncludedResponse(stdout);
      } catch {
        throw error;
      }
      if (rejectedResponse.status !== 304) throw error;
      response = rejectedResponse;
    }
    if (response.status !== 200 && response.status !== 304) {
      throw new ConditionalRestProtocolError(`unexpected HTTP status ${response.status}`);
    }
    const rateLimit = parseRateLimit(response);
    const etag = oneHeader(response, 'etag')!;
    assertEtag(etag);

    if (response.status === 304) {
      if (response.body.length !== 0) {
        throw new ConditionalRestProtocolError('304 response body must be empty');
      }
      if (cached === undefined || !weakEtagMatches(cached.etag, etag)) {
        throw new ConditionalRestProtocolError('304 response has no matching cache entry');
      }
      const body = parseJson(cached.body, 'cached');
      if (cached.nextEndpoint !== null) assertEndpoint(cached.nextEndpoint);
      this.cache.set(endpoint, { ...cached, etag });
      this.usageMeter.recordCacheHit();
      return {
        body,
        etag,
        status: 304,
        nextEndpoint: cached.nextEndpoint,
        rateLimit,
      };
    }

    const contentType = oneHeader(response, 'content-type')!;
    if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
      throw new ConditionalRestProtocolError('content-type is not application/json');
    }
    const body = parseJson(response.body, 'response');
    const nextEndpoint = parseNextEndpoint(response);
    this.cache.set(endpoint, { etag, body: response.body, nextEndpoint });
    return { body, etag, status: 200, nextEndpoint, rateLimit };
  }
}

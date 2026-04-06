import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

// Mock cross-fetch module before importing the tool
vi.mock('cross-fetch', () => ({ default: fetchMock }));

// Mock env module before importing the tool
vi.mock('jinn-node/agent/mcp/tools/shared/env.js', () => ({
  getPonderGraphqlUrl: () => 'http://localhost:42069/graphql',
  loadEnvOnce: () => {},
}));

import {
  readContentStream,
  readContentStreamParams,
  readContentStreamSchema,
} from 'jinn-node/agent/mcp/tools/read-content-stream.js';

describe('readContentStream', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    fetchMock.mockReset();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // ─── Exports ──────────────────────────────────────────────────────

  it('exports params schema, type schema object, and handler', () => {
    expect(readContentStreamParams).toBeDefined();
    expect(readContentStreamSchema).toBeDefined();
    expect(readContentStreamSchema.description).toContain('content stream');
    expect(readContentStreamSchema.inputSchema).toBeDefined();
    expect(typeof readContentStream).toBe('function');
  });

  // ─── Returns artifacts from a specific stream with correct fields ──

  it('returns artifacts from a specific stream with correct fields', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            artifacts: {
              items: [
                { id: '3', name: 'Article C', contentPreview: 'Preview C', cid: 'bafyC', requestId: 'req-3', blockTimestamp: '1740500000' },
                { id: '2', name: 'Article B', contentPreview: 'Preview B', cid: 'bafyB', requestId: 'req-2', blockTimestamp: '1740496400' },
                { id: '1', name: 'Article A', contentPreview: 'Preview A', cid: 'bafyA', requestId: 'req-1', blockTimestamp: '1740492800' },
              ],
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = await readContentStream({ stream: 'FEED:blog-posts' });
    const body = JSON.parse(result.content[0].text);

    expect(body.meta.ok).toBe(true);
    expect(body.meta.source).toBe('ponder');
    expect(body.meta.type).toBe('content_stream');
    expect(body.meta.stream).toBe('FEED:blog-posts');
    expect(body.meta.since).toBeDefined();
    expect(body.data).toHaveLength(3);

    // Check each item has the correct fields including createdAt
    const first = body.data[0];
    expect(first.name).toBe('Article C');
    expect(first.contentPreview).toBe('Preview C');
    expect(first.cid).toBe('bafyC');
    expect(first.requestId).toBe('req-3');
    expect(first.createdAt).toBe(new Date(1740500000 * 1000).toISOString());
  });

  // ─── Validates stream parameter starts with FEED: ──────────────────

  it('returns VALIDATION_ERROR for non-FEED streams', async () => {
    const result = await readContentStream({ stream: 'not-a-feed' });
    const body = JSON.parse(result.content[0].text);

    expect(body.meta.ok).toBe(false);
    expect(body.meta.code).toBe('VALIDATION_ERROR');
    expect(body.data).toEqual([]);
  });

  // ─── Requires stream parameter ─────────────────────────────────────

  it('returns VALIDATION_ERROR when stream is missing', async () => {
    const result = await readContentStream({});
    const body = JSON.parse(result.content[0].text);

    expect(body.meta.ok).toBe(false);
    expect(body.meta.code).toBe('VALIDATION_ERROR');
    expect(body.data).toEqual([]);
  });

  // ─── Returns empty array when stream has no items ──────────────────

  it('returns empty array when stream has no items', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            artifacts: {
              items: [],
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = await readContentStream({ stream: 'FEED:empty-stream' });
    const body = JSON.parse(result.content[0].text);

    expect(body.meta.ok).toBe(true);
    expect(body.data).toEqual([]);
    expect(body.meta.stream).toBe('FEED:empty-stream');
  });

  // ─── Handles Ponder errors gracefully ──────────────────────────────

  it('handles Ponder errors gracefully', async () => {
    fetchMock.mockRejectedValue(new Error('Connection refused'));

    const result = await readContentStream({ stream: 'FEED:blog-posts' });
    const body = JSON.parse(result.content[0].text);

    expect(body.meta.ok).toBe(false);
    expect(body.meta.code).toBe('EXECUTION_ERROR');
    expect(body.meta.message).toContain('Connection refused');
    expect(body.data).toEqual([]);
  });

  // ─── Sends correct GraphQL query ───────────────────────────────────

  it('sends GraphQL query filtering by exact topic match', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ data: { artifacts: { items: [] } } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await readContentStream({ stream: 'FEED:commit-highlights' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:42069/graphql');
    expect(options.method).toBe('POST');

    const requestBody = JSON.parse(options.body);
    expect(requestBody.variables?.topic).toBe('FEED:commit-highlights');
  });

  // ─── Respects limit parameter ──────────────────────────────────────

  it('respects limit parameter in GraphQL query', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ data: { artifacts: { items: [] } } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await readContentStream({ stream: 'FEED:blog-posts', limit: 5 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0];
    const requestBody = JSON.parse(options.body);
    expect(requestBody.variables?.limit).toBe(5);
  });

  // ─── Defaults since to 24h ago ─────────────────────────────────────

  it('defaults since to 24h ago when not provided', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ data: { artifacts: { items: [] } } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const before = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const result = await readContentStream({ stream: 'FEED:blog-posts' });
    const after = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const body = JSON.parse(result.content[0].text);
    expect(body.meta.since).toBeDefined();
    // The since timestamp should be roughly 24h ago
    expect(body.meta.since >= before).toBe(true);
    expect(body.meta.since <= after).toBe(true);
  });

  // ─── Passes since as blockTimestamp_gte in GraphQL query ──────────

  it('passes since as unix seconds in GraphQL sinceTs variable', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ data: { artifacts: { items: [] } } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const since = '2026-02-25T14:00:00.000Z';
    await readContentStream({ stream: 'FEED:commit-highlights', since });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0];
    const requestBody = JSON.parse(options.body);

    // blockTimestamp is stored as Unix seconds
    const expectedUnix = String(Math.floor(new Date(since).getTime() / 1000));
    expect(requestBody.variables?.sinceTs).toBe(expectedUnix);
    expect(requestBody.query).toContain('blockTimestamp_gte');
  });

  // ─── Handles non-ok HTTP responses with clear error ───────────────

  it('handles non-ok HTTP responses with status in error message', async () => {
    fetchMock.mockResolvedValue(
      new Response('Internal Server Error', { status: 500, statusText: 'Internal Server Error' }),
    );

    const result = await readContentStream({ stream: 'FEED:blog-posts' });
    const body = JSON.parse(result.content[0].text);

    expect(body.meta.ok).toBe(false);
    expect(body.meta.code).toBe('EXECUTION_ERROR');
    expect(body.meta.message).toContain('500');
  });
});

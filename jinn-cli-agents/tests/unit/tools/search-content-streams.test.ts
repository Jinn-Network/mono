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
  searchContentStreams,
  searchContentStreamsParams,
  searchContentStreamsSchema,
} from 'jinn-node/agent/mcp/tools/search-content-streams.js';

describe('searchContentStreams', () => {
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
    expect(searchContentStreamsParams).toBeDefined();
    expect(searchContentStreamsSchema).toBeDefined();
    expect(searchContentStreamsSchema.description).toContain('content streams');
    expect(searchContentStreamsSchema.inputSchema).toBeDefined();
    expect(typeof searchContentStreams).toBe('function');
  });

  // ─── Returns distinct FEED: streams with correct item counts ──────

  it('returns distinct FEED: streams with correct item counts', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            artifacts: {
              items: [
                { id: '5', name: 'Tweet 2', topic: 'FEED:twitter-posts' },
                { id: '4', name: 'Tweet 1', topic: 'FEED:twitter-posts' },
                { id: '3', name: 'Article C', topic: 'FEED:blog-posts' },
                { id: '2', name: 'Article B', topic: 'FEED:blog-posts' },
                { id: '1', name: 'Article A', topic: 'FEED:blog-posts' },
              ],
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = await searchContentStreams({});
    const body = JSON.parse(result.content[0].text);

    expect(body.meta.ok).toBe(true);
    expect(body.meta.source).toBe('ponder');
    expect(body.meta.type).toBe('content_streams');
    expect(body.data).toHaveLength(2);

    const blogStream = body.data.find((s: any) => s.stream === 'FEED:blog-posts');
    expect(blogStream).toBeDefined();
    expect(blogStream.itemCount).toBe(3);
    expect(blogStream.latestItemName).toBe('Article C');

    const twitterStream = body.data.find((s: any) => s.stream === 'FEED:twitter-posts');
    expect(twitterStream).toBeDefined();
    expect(twitterStream.itemCount).toBe(2);
    expect(twitterStream.latestItemName).toBe('Tweet 2');
  });

  // ─── Filters by query keyword ─────────────────────────────────────

  it('filters by query keyword (case-insensitive)', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            artifacts: {
              items: [
                { id: '3', name: 'Tweet 1', topic: 'FEED:twitter-posts' },
                { id: '2', name: 'Article B', topic: 'FEED:blog-posts' },
                { id: '1', name: 'Article A', topic: 'FEED:blog-posts' },
              ],
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = await searchContentStreams({ query: 'BLOG' });
    const body = JSON.parse(result.content[0].text);

    expect(body.meta.ok).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].stream).toBe('FEED:blog-posts');
    expect(body.data[0].itemCount).toBe(2);
  });

  // ─── Returns empty array when no FEED: artifacts exist ─────────────

  it('returns empty array when no FEED: artifacts exist', async () => {
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

    const result = await searchContentStreams({});
    const body = JSON.parse(result.content[0].text);

    expect(body.meta.ok).toBe(true);
    expect(body.data).toEqual([]);
  });

  // ─── Handles Ponder errors gracefully ──────────────────────────────

  it('handles Ponder errors gracefully', async () => {
    fetchMock.mockRejectedValue(new Error('Connection refused'));

    const result = await searchContentStreams({});
    const body = JSON.parse(result.content[0].text);

    expect(body.meta.ok).toBe(false);
    expect(body.meta.code).toBe('EXECUTION_ERROR');
    expect(body.meta.message).toContain('Connection refused');
    expect(body.data).toEqual([]);
  });

  // ─── Handles non-ok HTTP responses ─────────────────────────────────

  it('handles non-ok HTTP responses with status in error message', async () => {
    fetchMock.mockResolvedValue(
      new Response('Internal Server Error', { status: 500, statusText: 'Internal Server Error' }),
    );

    const result = await searchContentStreams({});
    const body = JSON.parse(result.content[0].text);

    expect(body.meta.ok).toBe(false);
    expect(body.meta.code).toBe('EXECUTION_ERROR');
    expect(body.meta.message).toContain('500');
  });

  // ─── Respects limit parameter ──────────────────────────────────────

  it('respects limit parameter', async () => {
    // Create many distinct streams
    const items = Array.from({ length: 10 }, (_, i) => ({
      id: String(9 - i),
      name: `Item ${9 - i}`,
      topic: `FEED:stream-${9 - i}`,
    }));

    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ data: { artifacts: { items } } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = await searchContentStreams({ limit: 3 });
    const body = JSON.parse(result.content[0].text);

    expect(body.meta.ok).toBe(true);
    expect(body.data).toHaveLength(3);
  });

  // ─── Validation error ──────────────────────────────────────────────

  it('returns validation error for invalid limit', async () => {
    const result = await searchContentStreams({ limit: -5 });
    const body = JSON.parse(result.content[0].text);

    expect(body.meta.ok).toBe(false);
    expect(body.meta.code).toBe('VALIDATION_ERROR');
    expect(body.data).toEqual([]);
  });

  // ─── GraphQL query targets FEED: prefix ─────────────────────────────

  it('sends GraphQL query filtering by FEED: topic prefix', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ data: { artifacts: { items: [] } } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await searchContentStreams({});

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:42069/graphql');
    expect(options.method).toBe('POST');

    const requestBody = JSON.parse(options.body);
    expect(requestBody.query).toContain('topic_starts_with');
    expect(requestBody.variables?.topicPrefix || requestBody.query).toContain('FEED:');
  });

  // ─── Truncation flag ──────────────────────────────────────────────

  it('sets meta.truncated to false when under aggregation limit', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: { artifacts: { items: [{ id: '1', name: 'Item', topic: 'FEED:test' }] } },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = await searchContentStreams({});
    const body = JSON.parse(result.content[0].text);

    expect(body.meta.truncated).toBe(false);
  });

  it('sets meta.truncated to true when at aggregation limit', async () => {
    const items = Array.from({ length: 1000 }, (_, i) => ({
      id: String(i),
      name: `Item ${i}`,
      topic: `FEED:stream-${i % 10}`,
    }));

    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ data: { artifacts: { items } } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = await searchContentStreams({});
    const body = JSON.parse(result.content[0].text);

    expect(body.meta.truncated).toBe(true);
  });
});

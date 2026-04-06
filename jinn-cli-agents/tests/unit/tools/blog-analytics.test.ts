import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock credential-client before importing tools
vi.mock('jinn-node/agent/shared/credential-client.js', () => ({
  getCredentialBundle: vi.fn(),
}));

import { getCredentialBundle } from 'jinn-node/agent/shared/credential-client.js';
import {
  blogGetStats,
  blogGetTopPages,
  blogGetReferrers,
  blogGetMetrics,
  blogGetPageviews,
  blogGetPerformanceSummary,
} from 'jinn-node/agent/mcp/tools/blog-analytics.js';

const mockGetCredentialBundle = vi.mocked(getCredentialBundle);

const MOCK_BUNDLE = {
  access_token: 'test-token',
  expires_in: 3600,
  provider: 'umami',
  config: { UMAMI_HOST: 'https://analytics.example.com' },
};

const MOCK_STATS = {
  pageviews: { value: 100, prev: 80 },
  visitors: { value: 50, prev: 40 },
  visits: { value: 60, prev: 45 },
  bounces: { value: 20, prev: 15 },
  totaltime: { value: 180000, prev: 150000 },
};

describe('blog analytics websiteId resolution', () => {
  const originalEnv = { ...process.env };
  const fetchMock = vi.fn();

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.JINN_JOB_UMAMI_WEBSITE_ID;
    fetchMock.mockReset();
    mockGetCredentialBundle.mockReset();
    mockGetCredentialBundle.mockResolvedValue(MOCK_BUNDLE);
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...originalEnv };
  });

  // ─── Core: websiteId precedence ────────────────────────────────

  it('uses explicit websiteId arg when provided (no env var)', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(MOCK_STATS), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const result = await blogGetStats({ websiteId: 'explicit-site-123', days: 7 });
    const body = JSON.parse(result.content[0].text);

    expect(body.meta.ok).toBe(true);
    // Verify the fetch URL contains the explicit websiteId
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = fetchMock.mock.calls[0][0];
    expect(calledUrl).toContain('/websites/explicit-site-123/');
  });

  it('falls back to JINN_JOB_UMAMI_WEBSITE_ID env var when no arg', async () => {
    process.env.JINN_JOB_UMAMI_WEBSITE_ID = 'env-site-456';
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(MOCK_STATS), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const result = await blogGetStats({ days: 7 });
    const body = JSON.parse(result.content[0].text);

    expect(body.meta.ok).toBe(true);
    const calledUrl = fetchMock.mock.calls[0][0];
    expect(calledUrl).toContain('/websites/env-site-456/');
  });

  it('explicit websiteId takes precedence over env var', async () => {
    process.env.JINN_JOB_UMAMI_WEBSITE_ID = 'env-site-456';
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(MOCK_STATS), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const result = await blogGetStats({ websiteId: 'explicit-wins', days: 7 });
    const body = JSON.parse(result.content[0].text);

    expect(body.meta.ok).toBe(true);
    const calledUrl = fetchMock.mock.calls[0][0];
    expect(calledUrl).toContain('/websites/explicit-wins/');
  });

  it('throws clear error when neither arg nor env var provided', async () => {
    const result = await blogGetStats({ days: 7 });
    const body = JSON.parse(result.content[0].text);

    expect(body.meta.ok).toBe(false);
    expect(body.meta.message).toContain('websiteId argument or JINN_JOB_UMAMI_WEBSITE_ID');
  });

  // ─── All tool handlers pass websiteId through ──────────────────

  const toolsWithArgs: Array<{ name: string; fn: (args: unknown) => Promise<any>; extraArgs?: Record<string, unknown> }> = [
    { name: 'blogGetStats', fn: blogGetStats },
    { name: 'blogGetTopPages', fn: blogGetTopPages },
    { name: 'blogGetReferrers', fn: blogGetReferrers },
    { name: 'blogGetMetrics', fn: blogGetMetrics, extraArgs: { type: 'path' } },
    { name: 'blogGetPageviews', fn: blogGetPageviews },
    { name: 'blogGetPerformanceSummary', fn: blogGetPerformanceSummary },
  ];

  for (const { name, fn, extraArgs } of toolsWithArgs) {
    it(`${name} passes explicit websiteId to Umami API`, async () => {
      // Performance summary makes 3 parallel calls
      const mockData = name === 'blogGetPerformanceSummary'
        ? MOCK_STATS  // First call returns stats
        : name === 'blogGetStats'
          ? MOCK_STATS
          : [{ x: '/test', y: 10 }];

      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(mockData), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );

      await fn({ websiteId: `${name}-site`, days: 7, ...extraArgs });

      // Every fetch call should use the explicit websiteId
      for (const call of fetchMock.mock.calls) {
        expect(call[0]).toContain(`/websites/${name}-site/`);
      }
    });
  }

  // ─── Error classification unchanged ────────────────────────────

  it('classifies credential bridge errors as CREDENTIAL_ERROR', async () => {
    mockGetCredentialBundle.mockRejectedValue(new Error('Credential bridge unavailable'));

    const result = await blogGetStats({ websiteId: 'any', days: 7 });
    const body = JSON.parse(result.content[0].text);

    expect(body.meta.ok).toBe(false);
    expect(body.meta.code).toBe('CREDENTIAL_ERROR');
  });

  it('classifies API errors as EXECUTION_ERROR', async () => {
    fetchMock.mockResolvedValue(
      new Response('Internal Server Error', { status: 500, statusText: 'Internal Server Error' }),
    );

    const result = await blogGetStats({ websiteId: 'any', days: 7 });
    const body = JSON.parse(result.content[0].text);

    expect(body.meta.ok).toBe(false);
    expect(body.meta.code).toBe('EXECUTION_ERROR');
  });
});

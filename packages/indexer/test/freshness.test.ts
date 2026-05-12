/**
 * Tests for src/api/freshness.ts — Hono middleware that adds ETag /
 * Cache-Control headers and short-circuits 304 Not Modified responses.
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { withFreshness } from '../src/api/freshness.js';

/** Build a minimal Hono app wired with the freshness middleware. */
function makeApp(lastIndexedBlock = 123n, lastIndexedAt = '2026-01-01T00:00:00Z') {
  const app = new Hono();
  app.use('*', withFreshness(() => ({ lastIndexedBlock, lastIndexedAt })));
  app.get('/x', (c) => c.json({ ok: true }));
  return app;
}

describe('withFreshness middleware', () => {
  it('adds ETag header in the W/"<block>" format', async () => {
    const app = makeApp(123n);
    const res = await app.request('/x');
    expect(res.headers.get('etag')).toBe('W/"123"');
  });

  it('adds Cache-Control header with correct directives', async () => {
    const app = makeApp(123n);
    const res = await app.request('/x');
    expect(res.headers.get('cache-control')).toBe('public, max-age=30, stale-while-revalidate=60');
  });

  it('returns 200 and body for a request with no If-None-Match', async () => {
    const app = makeApp(123n);
    const res = await app.request('/x');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it('returns 304 Not Modified when If-None-Match matches the current ETag', async () => {
    const app = makeApp(123n);
    const res = await app.request('/x', {
      headers: { 'If-None-Match': 'W/"123"' },
    });
    expect(res.status).toBe(304);
    // 304 must have an empty body
    const text = await res.text();
    expect(text).toBe('');
  });

  it('returns 200 when If-None-Match does NOT match the current ETag', async () => {
    const app = makeApp(123n);
    const res = await app.request('/x', {
      headers: { 'If-None-Match': 'W/"999"' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it('ETag reflects the lastIndexedBlock passed to getMeta', async () => {
    const app = makeApp(9999999n);
    const res = await app.request('/x');
    expect(res.headers.get('etag')).toBe('W/"9999999"');
  });

  it('headers are present on 200 responses from downstream handlers', async () => {
    const app = makeApp(42n);
    const res = await app.request('/x');
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBeTruthy();
    expect(res.headers.get('cache-control')).toBeTruthy();
  });

  it('works when getMeta returns a Promise', async () => {
    const app = new Hono();
    app.use(
      '*',
      withFreshness(async () => ({
        lastIndexedBlock: 77n,
        lastIndexedAt: '2026-06-01T00:00:00Z',
      })),
    );
    app.get('/y', (c) => c.json({ async: true }));

    const res = await app.request('/y');
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('W/"77"');

    const res304 = await app.request('/y', {
      headers: { 'If-None-Match': 'W/"77"' },
    });
    expect(res304.status).toBe(304);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { Store } from '../../src/store/store.js';
import { CapturesStore } from '../../src/store/captures.js';
import {
  CapturePublishRateLimitError,
  addCapturesRoutes,
} from '../../src/api/captures.js';

describe('captures API', () => {
  let store: Store;
  let captures: CapturesStore;
  let app: Hono;

  beforeEach(() => {
    store = new Store(':memory:');
    captures = new CapturesStore(store);
    captures.savePending({
      sessionId: 'sess-1',
      capturedAt: '2026-05-08T00:00:00.000Z',
      originatingTool: { name: 'claude-code', version: '1.0.0' },
      capturePath: 'B',
      status: 'pending',
      spanCount: 0,
      durationMs: 0,
      redactedSpanCount: 0,
      repoRemoteUrl: 'git@example.com:repo.git',
      repoCommitHash: 'a'.repeat(40),
    });
    captures.appendSpan({
      sessionId: 'sess-1',
      spanId: 'b'.repeat(16),
      traceId: 'c'.repeat(32),
      parentSpanId: null,
      name: 'user-message',
      startTimeUnixNano: '1',
      endTimeUnixNano: '2',
      attributes: { 'jinn.session.id': 'sess-1' },
      redactedKeys: [],
    });
    app = new Hono();
  });

  afterEach(() => {
    store.close();
  });

  it('lists pending captures and returns drill-in detail', async () => {
    addCapturesRoutes(app, { captures });

    const list = await app.request('/api/captures/pending');
    expect(list.status).toBe(200);
    const listBody = await list.json() as { captures: Array<{ sessionId: string }> };
    expect(listBody.captures.map((c) => c.sessionId)).toEqual(['sess-1']);

    const detail = await app.request('/api/captures/sess-1');
    expect(detail.status).toBe(200);
    const detailBody = await detail.json() as { spans: Array<{ name: string }> };
    expect(detailBody.spans[0].name).toBe('user-message');
  });

  it('approves by invoking publishCapture and marking the row approved', async () => {
    addCapturesRoutes(app, {
      captures,
      publishCapture: async (sessionId) => ({ envelopeCid: `bafy-${sessionId}` }),
    });

    const res = await app.request('/api/captures/sess-1/approve', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json() as { envelopeCid: string };
    expect(body.envelopeCid).toBe('bafy-sess-1');
    expect(captures.listPending()).toEqual([]);
    expect(captures.getApproved('sess-1')?.envelopeCid).toBe('bafy-sess-1');
  });

  it('does not approve when no publisher is wired', async () => {
    addCapturesRoutes(app, { captures });

    const res = await app.request('/api/captures/sess-1/approve', { method: 'POST' });
    expect(res.status).toBe(503);
    expect(captures.getBySession('sess-1')?.status).toBe('pending');
  });

  it('returns 429 and keeps the capture pending when publish is rate-limited', async () => {
    addCapturesRoutes(app, {
      captures,
      publishCapture: async () => {
        throw new CapturePublishRateLimitError('repo_rate_limit', 1000);
      },
    });

    const res = await app.request('/api/captures/sess-1/approve', { method: 'POST' });
    expect(res.status).toBe(429);
    const body = await res.json() as { reason: string; retryAfterMs: number };
    expect(body.reason).toBe('repo_rate_limit');
    expect(body.retryAfterMs).toBe(1000);
    expect(captures.getBySession('sess-1')?.status).toBe('pending');
  });

  it('skips pending captures and records trusted repo changes', async () => {
    const trusted: Array<{ repoRemoteUrl: string; trusted: boolean }> = [];
    addCapturesRoutes(app, {
      captures,
      setTrustedRepo: (repoRemoteUrl, isTrusted) => {
        trusted.push({ repoRemoteUrl, trusted: isTrusted });
      },
    });

    const trust = await app.request('/api/captures/trust-repos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoRemoteUrl: 'git@example.com:repo.git', trusted: true }),
    });
    expect(trust.status).toBe(200);
    expect(trusted).toEqual([{ repoRemoteUrl: 'git@example.com:repo.git', trusted: true }]);

    const skipped = await app.request('/api/captures/sess-1/skip', { method: 'POST' });
    expect(skipped.status).toBe(200);
    expect(captures.getSkipped('sess-1')).not.toBeNull();
  });
});

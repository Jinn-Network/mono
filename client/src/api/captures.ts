import type { Hono } from 'hono';
import type { CapturesStore, PendingCaptureRow, SpanRow } from '../store/captures.js';

export interface CaptureDetail {
  capture: PendingCaptureRow;
  spans: SpanRow[];
}

export interface CapturesRoutesDeps {
  captures: CapturesStore;
  publishCapture?: (sessionId: string) => Promise<{ envelopeCid: string }>;
  setTrustedRepo?: (repoRemoteUrl: string, trusted: boolean) => Promise<void> | void;
}

export class CapturePublishUnavailableError extends Error {
  constructor(message = 'Capture publishing is not available yet') {
    super(message);
    this.name = 'CapturePublishUnavailableError';
  }
}

export class CapturePublishRateLimitError extends Error {
  readonly retryAfterMs?: number;
  readonly reason: string;

  constructor(reason: string, retryAfterMs?: number) {
    super(`Capture publish rate limit exceeded: ${reason}`);
    this.name = 'CapturePublishRateLimitError';
    this.reason = reason;
    this.retryAfterMs = retryAfterMs;
  }
}

export function addCapturesRoutes(app: Hono, deps: CapturesRoutesDeps): void {
  app.get('/api/captures/pending', (c) => {
    return c.json({ captures: deps.captures.listPending() });
  });

  app.get('/api/captures/:sessionId', (c) => {
    const sessionId = c.req.param('sessionId');
    const capture = deps.captures.getBySession(sessionId);
    if (!capture) return c.json({ error: 'capture_not_found' }, 404);
    return c.json({
      capture,
      spans: deps.captures.getSpansBySession(sessionId),
    } satisfies CaptureDetail);
  });

  app.post('/api/captures/:sessionId/approve', async (c) => {
    const sessionId = c.req.param('sessionId');
    const capture = deps.captures.getBySession(sessionId);
    if (!capture || capture.status !== 'pending') {
      return c.json({ error: 'capture_not_found' }, 404);
    }
    if (!deps.publishCapture) {
      return c.json({ error: 'capture_publish_unavailable' }, 503);
    }
    let published: { envelopeCid: string };
    try {
      published = await deps.publishCapture(sessionId);
    } catch (err) {
      if (err instanceof CapturePublishRateLimitError) {
        return c.json({
          error: 'capture_publish_rate_limited',
          reason: err.reason,
          retryAfterMs: err.retryAfterMs,
        }, 429);
      }
      if (err instanceof CapturePublishUnavailableError) {
        return c.json({ error: 'capture_publish_unavailable', message: err.message }, 503);
      }
      throw err;
    }
    const publishedAt = new Date().toISOString();
    deps.captures.markApproved(sessionId, {
      envelopeCid: published.envelopeCid,
      publishedAt,
    });
    return c.json({ ok: true, sessionId, envelopeCid: published.envelopeCid, publishedAt });
  });

  app.post('/api/captures/:sessionId/skip', (c) => {
    const sessionId = c.req.param('sessionId');
    const capture = deps.captures.getBySession(sessionId);
    if (!capture || capture.status !== 'pending') {
      return c.json({ error: 'capture_not_found' }, 404);
    }
    const skippedAt = new Date().toISOString();
    deps.captures.markSkipped(sessionId, { skippedAt });
    return c.json({ ok: true, sessionId, skippedAt });
  });

  app.post('/api/captures/trust-repos', async (c) => {
    const body = await c.req.json().catch(() => null) as unknown;
    if (
      typeof body !== 'object' ||
      body === null ||
      typeof (body as Record<string, unknown>)['repoRemoteUrl'] !== 'string'
    ) {
      return c.json({ error: 'invalid_trust_repo_payload' }, 400);
    }
    const repoRemoteUrl = (body as { repoRemoteUrl: string }).repoRemoteUrl;
    const trustedRaw = (body as Record<string, unknown>)['trusted'];
    const trusted = typeof trustedRaw === 'boolean' ? trustedRaw : true;
    await deps.setTrustedRepo?.(repoRemoteUrl, trusted);
    return c.json({ ok: true, repoRemoteUrl, trusted });
  });
}

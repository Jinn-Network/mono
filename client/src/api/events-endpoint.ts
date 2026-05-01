/**
 * /v1/events SSE stream + /v1/events/recent JSON endpoint.
 *
 * Backed by the singleton EventRingBuffer in src/events/emitter.ts. The SSE
 * channel sends a small backfill (last 50 events) then streams new events
 * pushed to the buffer until the client disconnects.
 */
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { getEventBuffer } from '../events/emitter.js';
import type { StructuredEventKind } from '../events/types.js';

const ALLOWED_KINDS: StructuredEventKind[] = ['intent', 'reward', 'fleet', 'system', 'error', 'log'];

function parseKinds(s: string | undefined): StructuredEventKind[] | undefined {
  if (!s) return undefined;
  const parts = s.split(',').map((k) => k.trim()).filter(Boolean);
  const out = parts.filter((p): p is StructuredEventKind => ALLOWED_KINDS.includes(p as StructuredEventKind));
  return out.length > 0 ? out : undefined;
}

export function addEventsRoutes(app: Hono): void {
  app.get('/v1/events/recent', (c) => {
    const kinds = parseKinds(c.req.query('kinds'));
    const sinceId = c.req.query('sinceId') ?? undefined;
    const limitRaw = c.req.query('limit');
    const limit = limitRaw ? Math.max(1, Math.min(1000, parseInt(limitRaw, 10) || 100)) : 100;
    const events = getEventBuffer().snapshot({ kinds, sinceId, limit });
    return c.json({ events });
  });

  app.get('/v1/events', (c) => {
    const kinds = parseKinds(c.req.query('kinds'));
    return streamSSE(c, async (stream) => {
      const buf = getEventBuffer();
      // Backfill the last 50 events on connect so the SPA has immediate context.
      const backfill = buf.snapshot({ kinds, limit: 50 });
      for (const e of backfill) {
        await stream.writeSSE({ data: JSON.stringify(e), event: e.kind, id: e.id });
      }
      const unsub = buf.subscribe(async (e) => {
        if (kinds && !kinds.includes(e.kind)) return;
        try {
          await stream.writeSSE({ data: JSON.stringify(e), event: e.kind, id: e.id });
        } catch {
          // client dropped; the close handler will run unsub
        }
      });
      // Block until the client disconnects.
      await new Promise<void>((resolve) => {
        c.req.raw.signal.addEventListener('abort', () => { unsub(); resolve(); });
      });
    });
  });
}

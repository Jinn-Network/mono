import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { addEventsRoutes } from '../../src/api/events-endpoint.js';
import { getEventBuffer } from '../../src/events/emitter.js';

describe('/v1/events/recent', () => {
  beforeEach(() => {
    getEventBuffer().clear();
  });

  it('returns recent events in JSON', async () => {
    const buf = getEventBuffer();
    buf.push({ schemaVersion: 1, id: 'e1', ts: '2026-05-01T00:00:00Z', kind: 'system', message: 'a' });
    buf.push({ schemaVersion: 1, id: 'e2', ts: '2026-05-01T00:00:01Z', kind: 'intent', message: 'b' });

    const app = new Hono();
    addEventsRoutes(app);
    const res = await app.request('/v1/events/recent');
    expect(res.status).toBe(200);
    const body = await res.json() as { events: Array<{ id: string }> };
    expect(body.events.length).toBeGreaterThanOrEqual(2);
    expect(body.events.map((e) => e.id)).toContain('e1');
  });

  it('filters by kind via query param', async () => {
    const buf = getEventBuffer();
    buf.push({ schemaVersion: 1, id: 'e1', ts: '2026-05-01T00:00:00Z', kind: 'system', message: 'a' });
    buf.push({ schemaVersion: 1, id: 'e2', ts: '2026-05-01T00:00:01Z', kind: 'intent', message: 'b' });

    const app = new Hono();
    addEventsRoutes(app);
    const res = await app.request('/v1/events/recent?kinds=intent');
    const body = await res.json() as { events: Array<{ id: string; kind: string }> };
    expect(body.events.every((e) => e.kind === 'intent')).toBe(true);
  });

  it('respects limit query param', async () => {
    const buf = getEventBuffer();
    for (let i = 0; i < 5; i++) {
      buf.push({ schemaVersion: 1, id: `e${i}`, ts: '2026-05-01T00:00:00Z', kind: 'system', message: `m${i}` });
    }
    const app = new Hono();
    addEventsRoutes(app);
    const res = await app.request('/v1/events/recent?limit=2');
    const body = await res.json() as { events: Array<{ id: string }> };
    expect(body.events.length).toBe(2);
    // Last 2 events: e3, e4
    expect(body.events.map((e) => e.id)).toEqual(['e3', 'e4']);
  });

  it('respects sinceId query param', async () => {
    const buf = getEventBuffer();
    buf.push({ schemaVersion: 1, id: 'e1', ts: '2026-05-01T00:00:00Z', kind: 'system', message: 'a' });
    buf.push({ schemaVersion: 1, id: 'e2', ts: '2026-05-01T00:00:01Z', kind: 'system', message: 'b' });
    buf.push({ schemaVersion: 1, id: 'e3', ts: '2026-05-01T00:00:02Z', kind: 'system', message: 'c' });
    const app = new Hono();
    addEventsRoutes(app);
    const res = await app.request('/v1/events/recent?sinceId=e1');
    const body = await res.json() as { events: Array<{ id: string }> };
    expect(body.events.map((e) => e.id)).toEqual(['e2', 'e3']);
  });
});

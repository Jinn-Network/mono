import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import {
  addEventsRoutes,
  type LifecycleEventTail,
  type LifecycleTailRow,
} from '../../src/api/events-endpoint.js';

function row(partial: Partial<LifecycleTailRow> & Pick<LifecycleTailRow, 'id' | 'kind'>): LifecycleTailRow {
  return {
    ts: '2026-08-17T00:00:00.000Z',
    requestId: null,
    serviceIndex: null,
    txHash: null,
    solverType: null,
    outcome: 'ok',
    detail: `event ${partial.id}`,
    ...partial,
  };
}

function memoryTail(initial: LifecycleTailRow[] = []): LifecycleEventTail & {
  push: (next: LifecycleTailRow) => void;
} {
  const rows = [...initial];
  const listeners = new Set<(next: LifecycleTailRow) => void>();
  return {
    getAfterId(afterId, limit) {
      return rows.filter((r) => r.id > afterId).slice(0, limit);
    },
    getRecent(limit) {
      return [...rows].sort((a, b) => b.id - a.id).slice(0, limit);
    },
    hasId(id) {
      return rows.some((r) => r.id === id);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    push(next) {
      rows.push(next);
      for (const listener of listeners) listener(next);
    },
  };
}

function mount(tail: LifecycleEventTail): Hono {
  const app = new Hono();
  addEventsRoutes(app, {
    tail,
    source: 'urn:jinn:operator-daemon:test',
    subject: 'urn:jinn:operator:local',
  });
  return app;
}

describe('/v1/events/recent', () => {
  it('returns lifecycle CloudEvents in JSON', async () => {
    const app = mount(
      memoryTail([
        row({ id: 1, kind: 'startup' }),
        row({ id: 2, kind: 'task_posted' }),
      ]),
    );
    const res = await app.request('/v1/events/recent');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: Array<{ id: string; type: string; data: { kind: string; title: string } }>;
    };
    expect(body.events.map((e) => e.id)).toEqual(['1', '2']);
    expect(body.events[1]?.type).toBe('network.jinn.operator-lifecycle.task-posted.v1');
    expect(body.events[1]?.data.kind).toBe('task_posted');
    expect(body.events[1]?.data.title.length).toBeGreaterThan(0);
  });

  it('filters by snake LifecycleKind via query param', async () => {
    const app = mount(
      memoryTail([
        row({ id: 1, kind: 'startup' }),
        row({ id: 2, kind: 'task_posted' }),
      ]),
    );
    const res = await app.request('/v1/events/recent?kinds=task_posted');
    const body = (await res.json()) as { events: Array<{ data: { kind: string } }> };
    expect(body.events.every((e) => e.data.kind === 'task_posted')).toBe(true);
    expect(body.events).toHaveLength(1);
  });

  it('respects limit query param', async () => {
    const app = mount(
      memoryTail([
        row({ id: 1, kind: 'startup' }),
        row({ id: 2, kind: 'startup' }),
        row({ id: 3, kind: 'startup' }),
        row({ id: 4, kind: 'startup' }),
        row({ id: 5, kind: 'startup' }),
      ]),
    );
    const res = await app.request('/v1/events/recent?limit=2');
    const body = (await res.json()) as { events: Array<{ id: string }> };
    expect(body.events.map((e) => e.id)).toEqual(['4', '5']);
  });

  it('respects sinceId as the activity-events id', async () => {
    const app = mount(
      memoryTail([
        row({ id: 1, kind: 'startup' }),
        row({ id: 2, kind: 'startup' }),
        row({ id: 3, kind: 'startup' }),
      ]),
    );
    const res = await app.request('/v1/events/recent?sinceId=1');
    const body = (await res.json()) as { events: Array<{ id: string }> };
    expect(body.events.map((e) => e.id)).toEqual(['2', '3']);
  });
});

describe('/v1/events SSE Last-Event-ID', () => {
  async function readSseUntilAbort(app: Hono, headers: Record<string, string>): Promise<string> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 80);
    try {
      const res = await app.request('/v1/events', { headers, signal: ac.signal });
      return await res.text();
    } catch {
      return '';
    } finally {
      clearTimeout(timer);
    }
  }

  it('does not re-send the Last-Event-ID event on resume', async () => {
    const app = mount(
      memoryTail([
        row({ id: 1, kind: 'startup', detail: 'first' }),
        row({ id: 2, kind: 'task_posted', detail: 'second' }),
        row({ id: 3, kind: 'startup', detail: 'third' }),
      ]),
    );
    const text = await readSseUntilAbort(app, { 'Last-Event-ID': '1' });
    expect(text).not.toMatch(/id: 1\n/);
    expect(text).toMatch(/id: 2\n/);
    expect(text).toMatch(/id: 3\n/);
    expect(text).not.toMatch(/^event:/m);
  });

  it('emits an id-not-in-buffer comment when Last-Event-ID is unknown', async () => {
    const app = mount(memoryTail([row({ id: 10, kind: 'startup' })]));
    const text = await readSseUntilAbort(app, { 'Last-Event-ID': '999' });
    expect(text).toMatch(/id-not-in-buffer/);
    expect(text).not.toMatch(/id: 10\n/);
  });
});

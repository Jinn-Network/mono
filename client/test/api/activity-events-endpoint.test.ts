import { afterEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { Store, type ActivityEventRow } from '../../src/store/store.js';
import { addActivityEventsRoutes } from '../../src/api/activity-events-endpoint.js';

let stores: Store[] = [];

afterEach(() => {
  for (const store of stores) store.close();
  stores = [];
});

function memoryStore(): Store {
  const store = new Store(':memory:');
  stores.push(store);
  return store;
}

interface PageResponse {
  events: ActivityEventRow[];
  nextCursor: number | null;
  counts: Record<string, number>;
}

function appFor(store: Store): Hono {
  const app = new Hono();
  addActivityEventsRoutes(app, { store });
  return app;
}

describe('GET /v1/activity-events', () => {
  it('returns recent activity events newest-first with counts', async () => {
    const store = memoryStore();
    store.recordActivityEvent({ ts: '2026-05-01T00:00:00Z', kind: 'task_posted', outcome: 'ok' });
    store.recordActivityEvent({ ts: '2026-05-01T00:00:01Z', kind: 'request_claimed', outcome: 'ok' });
    store.recordActivityEvent({ ts: '2026-05-01T00:00:02Z', kind: 'tick_error', outcome: 'failed' });

    const res = await appFor(store).request('/v1/activity-events');
    expect(res.status).toBe(200);
    const body = await res.json() as PageResponse;
    expect(body.events).toHaveLength(3);
    expect(body.events[0].kind).toBe('tick_error');
    expect(body.events[2].kind).toBe('task_posted');
    expect(body.counts).toEqual({ task_posted: 1, request_claimed: 1, tick_error: 1 });
    expect(body.nextCursor).toBeNull();
  });

  it('filters by valid lifecycle kinds and rejects unknown kinds', async () => {
    const store = memoryStore();
    store.recordActivityEvent({ ts: '2026-05-01T00:00:00Z', kind: 'task_posted' });
    store.recordActivityEvent({ ts: '2026-05-01T00:00:01Z', kind: 'reward_claimed' });
    store.recordActivityEvent({ ts: '2026-05-01T00:00:02Z', kind: 'balance_topup' });

    const res = await appFor(store).request(
      '/v1/activity-events?kinds=reward_claimed,not_a_real_kind',
    );
    expect(res.status).toBe(200);
    const body = await res.json() as PageResponse;
    expect(body.events.map((e) => e.kind)).toEqual(['reward_claimed']);
  });

  it('filters by outcome query param', async () => {
    const store = memoryStore();
    store.recordActivityEvent({ ts: '2026-05-01T00:00:00Z', kind: 'task_posted', outcome: 'ok' });
    store.recordActivityEvent({ ts: '2026-05-01T00:00:01Z', kind: 'tick_error', outcome: 'failed' });
    store.recordActivityEvent({ ts: '2026-05-01T00:00:02Z', kind: 'engine_transition', outcome: 'warn' });

    const res = await appFor(store).request('/v1/activity-events?outcome=failed');
    expect(res.status).toBe(200);
    const body = await res.json() as PageResponse;
    expect(body.events).toHaveLength(1);
    expect(body.events[0].kind).toBe('tick_error');
  });

  it('filters by exact requestId', async () => {
    const store = memoryStore();
    store.recordActivityEvent({ ts: '2026-05-01T00:00:00Z', kind: 'task_posted', requestId: 'req-a' });
    store.recordActivityEvent({ ts: '2026-05-01T00:00:01Z', kind: 'request_claimed', requestId: 'req-b' });
    store.recordActivityEvent({ ts: '2026-05-01T00:00:02Z', kind: 'delivery_submitted', requestId: 'req-a' });

    const res = await appFor(store).request('/v1/activity-events?requestId=req-a');
    expect(res.status).toBe(200);
    const body = await res.json() as PageResponse;
    expect(body.events.map((e) => e.kind)).toEqual(['delivery_submitted', 'task_posted']);
    expect(body.events.every((e) => e.requestId === 'req-a')).toBe(true);
  });

  it('rejects an invalid outcome by returning the unfiltered page', async () => {
    const store = memoryStore();
    store.recordActivityEvent({ ts: '2026-05-01T00:00:00Z', kind: 'task_posted', outcome: 'ok' });
    const res = await appFor(store).request('/v1/activity-events?outcome=bogus');
    expect(res.status).toBe(200);
    const body = await res.json() as PageResponse;
    expect(body.events).toHaveLength(1);
  });

  it('paginates via beforeId / nextCursor', async () => {
    const store = memoryStore();
    for (let i = 0; i < 5; i++) {
      store.recordActivityEvent({ ts: `2026-05-01T00:00:0${i}Z`, kind: 'task_posted' });
    }

    const page1 = await (await appFor(store).request('/v1/activity-events?limit=2')).json() as PageResponse;
    expect(page1.events).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const firstIds = page1.events.map((e) => e.id);

    const page2 = await (await appFor(store).request(
      `/v1/activity-events?limit=2&beforeId=${page1.nextCursor}`,
    )).json() as PageResponse;
    expect(page2.events).toHaveLength(2);
    for (const event of page2.events) expect(firstIds).not.toContain(event.id);

    const page3 = await (await appFor(store).request(
      `/v1/activity-events?limit=2&beforeId=${page2.nextCursor}`,
    )).json() as PageResponse;
    expect(page3.events).toHaveLength(1);
    expect(page3.nextCursor).toBeNull();
  });

  it('includes events with a null ts across id-cursored pages', async () => {
    const store = memoryStore();
    store.recordActivityEvent({ ts: null, kind: 'startup' });
    store.recordActivityEvent({ ts: '2026-05-01T00:00:01Z', kind: 'task_posted' });
    store.recordActivityEvent({ ts: null, kind: 'shutdown' });

    const page1 = await (await appFor(store).request('/v1/activity-events?limit=2')).json() as PageResponse;
    const page2 = await (await appFor(store).request(
      `/v1/activity-events?limit=2&beforeId=${page1.nextCursor}`,
    )).json() as PageResponse;
    const allKinds = [...page1.events, ...page2.events].map((e) => e.kind).sort();
    expect(allKinds).toEqual(['shutdown', 'startup', 'task_posted']);
  });
});

describe('GET /v1/activity-events/:id', () => {
  it('returns a single event by id', async () => {
    const store = memoryStore();
    store.recordActivityEvent({
      ts: '2026-05-01T00:00:00Z',
      kind: 'delivery_submitted',
      requestId: 'req-1',
      txHash: '0xdeadbeef',
      outcome: 'ok',
    });
    const id = store.getActivityEventsPage()[0].id;

    const res = await appFor(store).request(`/v1/activity-events/${id}`);
    expect(res.status).toBe(200);
    const body = await res.json() as ActivityEventRow;
    expect(body.kind).toBe('delivery_submitted');
    expect(body.requestId).toBe('req-1');
    expect(body.txHash).toBe('0xdeadbeef');
  });

  it('returns 404 for an unknown id', async () => {
    const store = memoryStore();
    const res = await appFor(store).request('/v1/activity-events/999999');
    expect(res.status).toBe(404);
  });

  it('returns 400 for a non-numeric id', async () => {
    const store = memoryStore();
    const res = await appFor(store).request('/v1/activity-events/not-a-number');
    expect(res.status).toBe(400);
  });
});

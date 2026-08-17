/**
 * /v1/activity-events — paginated, filtered access to the persistent
 * `activity_events` lifecycle stream.
 *
 * Distinct from /v1/events (the lifecycle CloudEvents SSE tail). This
 * endpoint reads the SQLite table populated by emitEvent() and supports
 * kind/outcome/request-id filtering plus id-cursored pagination.
 */
import type { Hono } from 'hono';
import type { Store } from '../store/store.js';
import { ALLOWED_LIFECYCLE_KINDS } from '../observability/emit-event.js';

const ALLOWED_OUTCOMES = ['ok', 'failed', 'warn'] as const;

export interface ActivityEventRoutesDeps {
  store: Store;
}

function parseKinds(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const parts = raw.split(',').map((k) => k.trim()).filter(Boolean);
  const out = parts.filter((p) =>
    (ALLOWED_LIFECYCLE_KINDS as readonly string[]).includes(p),
  );
  return out.length > 0 ? out : undefined;
}

function parseOutcome(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  return (ALLOWED_OUTCOMES as readonly string[]).includes(raw) ? raw : undefined;
}

function parseBeforeId(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) return undefined;
  return parseInt(raw, 10);
}

function parseLimit(raw: string | undefined): number {
  if (!raw) return 50;
  return Math.max(1, Math.min(200, parseInt(raw, 10) || 50));
}

export function addActivityEventsRoutes(
  app: Hono,
  deps: ActivityEventRoutesDeps,
): void {
  app.get('/v1/activity-events', (c) => {
    const kinds = parseKinds(c.req.query('kinds'));
    const outcome = parseOutcome(c.req.query('outcome'));
    const requestId = c.req.query('requestId')?.trim() || undefined;
    const beforeId = parseBeforeId(c.req.query('beforeId'));
    const limit = parseLimit(c.req.query('limit'));

    const events = deps.store.getActivityEventsPage({
      kinds,
      outcome,
      requestId,
      beforeId,
      limit,
    });
    const nextCursor =
      events.length === limit && events.length > 0
        ? events[events.length - 1].id
        : null;
    const counts = deps.store.getActivityCountsByKind();

    return c.json({ events, nextCursor, counts });
  });

  app.get('/v1/activity-events/:id', (c) => {
    const idRaw = c.req.param('id');
    if (!/^\d+$/.test(idRaw)) {
      return c.json({ error: 'invalid_event_id' }, 400);
    }
    const event = deps.store.getActivityEventById(parseInt(idRaw, 10));
    if (!event) {
      return c.json({ error: 'event_not_found' }, 404);
    }
    return c.json(event);
  });
}

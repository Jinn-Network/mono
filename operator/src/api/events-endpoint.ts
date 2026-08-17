/**
 * /v1/events SSE stream + /v1/events/recent JSON endpoint.
 *
 * Lifecycle-kind CloudEvents (spec §6.4). The private StructuredEvent ring in
 * `src/events/emitter.ts` is unchanged — notifications still count `claim_failed`
 * from that buffer. Dual-emit is rejected: this route speaks only the CE shape.
 *
 * SSE `id:` is the SQLite `activity_events` id (stringified). Do not set a custom
 * `event:` name — SPA `onmessage` only fires for the default `message` type.
 * `Last-Event-ID` resumes after that id; an unknown id yields an empty backfill
 * plus a comment `id-not-in-buffer`.
 */
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { parseLastEventId, sseResumePlan } from '@jinn-network/read-plane';
import {
  activityRowToCloudEvent,
  type LifecycleCloudEventSource,
} from './contract/lifecycle-cloudevents.js';
import { subscribeLifecycle } from '../observability/emit-event.js';
import type { Store } from '../store/store.js';

export interface LifecycleTailRow {
  id: number;
  ts: string | null;
  kind: string;
  requestId?: string | null;
  serviceIndex?: number | null;
  txHash?: string | null;
  solverType?: string | null;
  outcome?: string | null;
  detail?: string | null;
  title?: string;
}

export interface LifecycleEventTail {
  getAfterId(afterId: number, limit: number): LifecycleTailRow[];
  getRecent(limit: number): LifecycleTailRow[];
  hasId(id: number): boolean;
  subscribe(listener: (row: LifecycleTailRow) => void): () => void;
}

export interface EventsRoutesConfig extends LifecycleCloudEventSource {
  tail: LifecycleEventTail;
}

function parseKinds(s: string | undefined): string[] | undefined {
  if (!s) return undefined;
  const parts = s.split(',').map((k) => k.trim()).filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

function matchesKinds(kind: string, kinds: string[] | undefined): boolean {
  if (!kinds) return true;
  return kinds.includes(kind);
}

function toCloudEvent(row: LifecycleTailRow, uris: LifecycleCloudEventSource) {
  return activityRowToCloudEvent(row, uris);
}

function parseResumeId(raw: string | undefined): number | undefined {
  return parseLastEventId(raw);
}

export function createStoreLifecycleTail(store: Store): LifecycleEventTail {
  return {
    getAfterId: (afterId, limit) => store.getActivityEventsAfterId(afterId, limit),
    getRecent: (limit) => store.getRecentActivityEvents(limit),
    hasId: (id) => store.getActivityEventById(id) !== null,
    subscribe: (listener) => subscribeLifecycle(listener),
  };
}

export function addEventsRoutes(app: Hono, config: EventsRoutesConfig): void {
  const { tail, source, subject } = config;
  const uris = { source, subject };

  app.get('/v1/events/recent', (c) => {
    const kinds = parseKinds(c.req.query('kinds'));
    const sinceId = parseResumeId(c.req.query('sinceId') ?? undefined);
    const limitRaw = c.req.query('limit');
    const limit = limitRaw ? Math.max(1, Math.min(1000, parseInt(limitRaw, 10) || 100)) : 100;
    const rows =
      sinceId !== undefined
        ? tail.getAfterId(sinceId, limit)
        : [...tail.getRecent(limit)].reverse();
    const events = rows
      .filter((row) => matchesKinds(row.kind, kinds))
      .map((row) => toCloudEvent(row, uris));
    return c.json({ events });
  });

  app.get('/v1/events', (c) => {
    const kinds = parseKinds(c.req.query('kinds'));
    const lastEventId = parseResumeId(c.req.header('Last-Event-ID') ?? undefined);
    return streamSSE(c, async (stream) => {
      const plan = sseResumePlan(lastEventId, (id) => tail.hasId(id));
      if (plan.action === 'id-not-in-buffer') {
        await stream.write(': id-not-in-buffer\n\n');
      } else {
        const backfill =
          plan.afterId !== undefined
            ? tail.getAfterId(plan.afterId, 50)
            : [...tail.getRecent(50)].reverse();
        for (const row of backfill) {
          if (!matchesKinds(row.kind, kinds)) continue;
          const event = toCloudEvent(row, uris);
          await stream.writeSSE({ data: JSON.stringify(event), id: event.id });
        }
      }
      const unsub = tail.subscribe(async (row) => {
        if (!matchesKinds(row.kind, kinds)) return;
        try {
          const event = toCloudEvent(row, uris);
          await stream.writeSSE({ data: JSON.stringify(event), id: event.id });
        } catch {
          // client dropped; the close handler will run unsub
        }
      });
      await new Promise<void>((resolve) => {
        c.req.raw.signal.addEventListener('abort', () => {
          unsub();
          resolve();
        });
      });
    });
  });
}

/**
 * History response assembler.
 *
 * Contract: spec/2026-04-14-client-surface.md §4.4.
 */

import type { GatheredStatusRaw } from './status-build.js';

type EventKind =
  | 'intent_posted'
  | 'request_claimed'
  | 'delivery_submitted'
  | 'evaluation_submitted'
  | 'reward_claimed'
  | 'other';

export interface HistoryEvent {
  id: string;
  at: string;
  serviceIndex: number;
  kind: EventKind;
  subkind?: string;
  intentId: string | null;
  txHash: string | null;
  outcome: 'ok' | 'failed' | 'pending';
}

export interface HistoryV1Response {
  schemaVersion: 1;
  generatedAt: string;
  cursor: { next: string | null };
  events: HistoryEvent[];
}

export interface HistoryOptions {
  limit: number;
  since?: string;
  cursor?: string;
}

/** own_activity roles → spec §3.3 event kinds */
const ROLE_TO_KIND: Record<string, EventKind> = {
  created: 'intent_posted',
  claimed: 'request_claimed',
  delivered: 'delivery_submitted',
  evaluated: 'evaluation_submitted',
};

const REF_MS = Date.UTC(2026, 3, 14, 12, 0, 0);

function syntheticAt(i: number): string {
  return new Date(REF_MS - i * 60 * 60 * 1000).toISOString();
}

export function assembleHistoryV1(raw: GatheredStatusRaw, opts: HistoryOptions): HistoryV1Response {
  const limit = Math.min(Math.max(opts.limit, 1), 500);
  const generatedAt = new Date().toISOString();

  let rows = raw.recentActivity.map((e, i) => ({
    ...e,
    at: syntheticAt(i),
  }));

  if (opts.since) {
    const sinceTs = new Date(opts.since).getTime();
    rows = rows.filter(e => !Number.isNaN(sinceTs) && new Date(e.at).getTime() >= sinceTs);
  }

  const events: HistoryEvent[] = rows.slice(0, limit).map((e, i) => {
    const kind = ROLE_TO_KIND[e.role] ?? 'other';
    return {
      id: `evt_${String(i).padStart(5, '0')}`,
      at: e.at,
      serviceIndex: 0,
      kind,
      ...(kind === 'other' ? { subkind: e.role } : {}),
      intentId: e.requestId ?? null,
      txHash: null,
      outcome: 'ok' as const,
    };
  });

  return {
    schemaVersion: 1,
    generatedAt,
    cursor: { next: events.length === limit ? events[events.length - 1]!.at : null },
    events,
  };
}

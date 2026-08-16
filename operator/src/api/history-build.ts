/**
 * History response assembler.
 *
 * Contract: spec/2026-04-14-client-surface.md §4.4.
 */

import type { GatheredStatusRaw } from './status-build.js';

type EventKind =
  | 'task_posted'
  | 'request_claimed'
  | 'delivery_submitted'
  | 'evaluation_submitted'
  | 'reward_claimed'
  | 'other';

type ActivitySourceRow = GatheredStatusRaw['recentActivity'][number];

export interface HistoryEvent {
  id: string;
  at: string;
  serviceIndex: number;
  kind: EventKind;
  subkind?: string;
  taskId: string | null;
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

function toEventKind(kind: string): EventKind {
  switch (kind) {
    case 'created':
      return 'task_posted';
    case 'claimed':
      return 'request_claimed';
    case 'delivered':
      return 'delivery_submitted';
    case 'evaluated':
      return 'evaluation_submitted';
    case 'task_posted':
    case 'request_claimed':
    case 'delivery_submitted':
    case 'evaluation_submitted':
    case 'reward_claimed':
      return kind;
    default:
      return 'other';
  }
}

/**
 * @param activityFromStore When set (e.g. from `jinn history`), pre-filtered rows with correct limit/cursor; {@link opts} filter fields are not re-applied.
 */
export function assembleHistoryV1(
  raw: GatheredStatusRaw,
  opts: HistoryOptions,
  activityFromStore?: ActivitySourceRow[],
): HistoryV1Response {
  const limit = Math.min(Math.max(opts.limit, 1), 500);
  const generatedAt = new Date().toISOString();

  let source: ActivitySourceRow[];

  if (activityFromStore) {
    source = activityFromStore;
  } else {
    let rows = raw.recentActivity;
    if (opts.since) {
      const sinceTs = new Date(opts.since).getTime();
      rows = rows.filter(
        (e) =>
          e.ts != null
          && !Number.isNaN(sinceTs)
          && new Date(e.ts).getTime() >= sinceTs,
      );
    }
    if (opts.cursor) {
      const cursorTs = new Date(opts.cursor).getTime();
      rows = rows.filter(
        (e) =>
          e.ts != null
          && !Number.isNaN(cursorTs)
          && new Date(e.ts).getTime() < cursorTs,
      );
    }
    source = rows;
  }

  const withTs = source.filter((e): e is typeof e & { ts: string } => e.ts != null);
  const events: HistoryEvent[] = withTs.slice(0, limit).map((e, i) => {
    const kind = toEventKind(e.kind);
    return {
      id: `evt_${String(e.id ?? i).padStart(5, '0')}`,
      at: e.ts,
      serviceIndex: e.serviceIndex ?? 0,
      kind,
      ...(kind === 'other' ? { subkind: e.kind } : {}),
      taskId: e.requestId ?? null,
      txHash: e.txHash ?? null,
      outcome: e.outcome === 'failed' ? 'failed' : 'ok',
    };
  });

  return {
    schemaVersion: 1,
    generatedAt,
    cursor: { next: events.length === limit ? events[events.length - 1]!.at : null },
    events,
  };
}

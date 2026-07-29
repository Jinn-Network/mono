import type { CellStatusEvent } from "./launch.js";

/** Fold live cell status events into a coarse per-cell summary for dashboards (§10.1 op 4). */
export type CellStatusSummary = {
  cellKey: string;
  latest: CellStatusEvent;
  dispatches: number;
  attempt?: string;
};

export function summarizeCellStatus(events: readonly CellStatusEvent[]): CellStatusSummary[] {
  const byCell = new Map<string, CellStatusSummary>();
  for (const event of events) {
    const existing = byCell.get(event.cellKey);
    if (existing === undefined) {
      byCell.set(event.cellKey, {
        cellKey: event.cellKey,
        latest: event,
        dispatches: event.dispatch,
        ...(event.attempt === undefined ? {} : { attempt: event.attempt }),
      });
      continue;
    }
    existing.latest = event;
    existing.dispatches = Math.max(existing.dispatches, event.dispatch);
    if (event.attempt !== undefined) existing.attempt = event.attempt;
  }
  return [...byCell.values()].sort((left, right) =>
    left.cellKey < right.cellKey ? -1 : left.cellKey > right.cellKey ? 1 : 0,
  );
}

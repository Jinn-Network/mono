/**
 * Bounded in-memory ring buffer of structured daemon events with subscribe/snapshot.
 *
 * - `push` records an event and notifies subscribers; subscriber errors are isolated.
 * - `snapshot` returns a defensive copy filtered by kinds/sinceId/limit.
 * - Default capacity 1000; trim is amortized O(1) at expected event rates.
 */
import type { StructuredEvent, StructuredEventKind } from './types.js';

export interface EventFilter {
  kinds?: StructuredEventKind[];
  sinceId?: string;
  limit?: number;
}

export type EventSubscriber = (event: StructuredEvent) => void;

export class EventRingBuffer {
  private buffer: StructuredEvent[] = [];
  private subscribers = new Set<EventSubscriber>();

  constructor(private capacity: number = 1000) {}

  push(event: StructuredEvent): void {
    this.buffer.push(event);
    if (this.buffer.length > this.capacity) {
      this.buffer = this.buffer.slice(-this.capacity);
    }
    for (const sub of this.subscribers) {
      try {
        sub(event);
      } catch (err) {
        // never let subscriber errors propagate, but leave a breadcrumb
        console.error('[events] subscriber threw:', err instanceof Error ? err.message : err);
      }
    }
  }

  snapshot(filter: EventFilter = {}): StructuredEvent[] {
    let out = this.buffer;
    if (filter.sinceId) {
      const idx = out.findIndex((e) => e.id === filter.sinceId);
      out = idx >= 0 ? out.slice(idx + 1) : out;
    }
    if (filter.kinds && filter.kinds.length > 0) {
      const allowed = new Set(filter.kinds);
      out = out.filter((e) => allowed.has(e.kind));
    }
    if (filter.limit !== undefined) out = out.slice(-filter.limit);
    return [...out];
  }

  subscribe(sub: EventSubscriber): () => void {
    this.subscribers.add(sub);
    return () => this.subscribers.delete(sub);
  }

  /** Drop all buffered events; subscribers are retained. Intended for test isolation. */
  clear(): void {
    this.buffer = [];
  }
}

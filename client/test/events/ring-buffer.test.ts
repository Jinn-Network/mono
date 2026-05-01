import { describe, it, expect } from 'vitest';
import { EventRingBuffer } from '../../src/events/ring-buffer.js';
import type { StructuredEvent } from '../../src/events/types.js';

function evt(id: string, kind: 'intent' | 'system' = 'system'): StructuredEvent {
  return {
    schemaVersion: 1,
    id,
    ts: new Date().toISOString(),
    kind,
    message: `event ${id}`,
  };
}

describe('EventRingBuffer', () => {
  it('keeps the last N events', () => {
    const rb = new EventRingBuffer(3);
    rb.push(evt('a'));
    rb.push(evt('b'));
    rb.push(evt('c'));
    rb.push(evt('d'));
    expect(rb.snapshot().map((e) => e.id)).toEqual(['b', 'c', 'd']);
  });

  it('filters by kind', () => {
    const rb = new EventRingBuffer(10);
    rb.push(evt('a', 'intent'));
    rb.push(evt('b', 'system'));
    rb.push(evt('c', 'intent'));
    expect(rb.snapshot({ kinds: ['intent'] }).map((e) => e.id)).toEqual(['a', 'c']);
  });

  it('notifies subscribers and supports unsubscribe', () => {
    const rb = new EventRingBuffer(10);
    const seen: string[] = [];
    const unsub = rb.subscribe((e) => seen.push(e.id));
    rb.push(evt('a'));
    rb.push(evt('b'));
    unsub();
    rb.push(evt('c'));
    expect(seen).toEqual(['a', 'b']);
  });

  it('snapshots events after sinceId', () => {
    const rb = new EventRingBuffer(10);
    rb.push(evt('a'));
    rb.push(evt('b'));
    rb.push(evt('c'));
    expect(rb.snapshot({ sinceId: 'a' }).map((e) => e.id)).toEqual(['b', 'c']);
  });

  it('snapshots returns full buffer when sinceId is unknown', () => {
    const rb = new EventRingBuffer(10);
    rb.push(evt('a'));
    rb.push(evt('b'));
    expect(rb.snapshot({ sinceId: 'unknown' }).map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('limit returns the last N events', () => {
    const rb = new EventRingBuffer(10);
    rb.push(evt('a'));
    rb.push(evt('b'));
    rb.push(evt('c'));
    expect(rb.snapshot({ limit: 2 }).map((e) => e.id)).toEqual(['b', 'c']);
  });

  it('isolates subscriber errors from each other', () => {
    const rb = new EventRingBuffer(10);
    const seen: string[] = [];
    rb.subscribe(() => { throw new Error('first sub crashes'); });
    rb.subscribe((e) => seen.push(e.id));
    rb.push(evt('a'));
    expect(seen).toEqual(['a']);
  });

  it('returns a defensive copy from snapshot', () => {
    const rb = new EventRingBuffer(10);
    rb.push(evt('a'));
    const snap = rb.snapshot();
    snap.push(evt('mutated'));
    expect(rb.snapshot().map((e) => e.id)).toEqual(['a']);
  });

  it('clear() empties the buffer but retains subscribers', () => {
    const rb = new EventRingBuffer(10);
    const seen: string[] = [];
    rb.subscribe((e) => seen.push(e.id));
    rb.push(evt('a'));
    rb.clear();
    expect(rb.snapshot()).toEqual([]);
    rb.push(evt('b'));
    expect(seen).toEqual(['a', 'b']);
  });
});

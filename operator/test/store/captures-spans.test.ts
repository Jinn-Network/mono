import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Store } from '../../src/store/store.js';
import { CapturesStore } from '../../src/store/captures.js';

describe('CapturesStore: per-span persistence', () => {
  let store: Store;
  let captures: CapturesStore;

  beforeEach(() => {
    store = new Store(':memory:');
    captures = new CapturesStore(store);
    // Seed a pending capture so the foreign-keyish session_id makes sense.
    captures.savePending({
      sessionId: 'sess-1',
      capturedAt: '2026-05-07T00:00:00.000Z',
      originatingTool: { name: 'claude-code' },
      capturePath: 'A',
      status: 'pending',
      spanCount: 0,
      durationMs: 0,
      redactedSpanCount: 0,
    });
  });

  afterEach(() => store.close());

  it('saves a span and reads it back by sessionId', () => {
    captures.appendSpan({
      sessionId: 'sess-1',
      spanId: 'b'.repeat(16),
      traceId: 'a'.repeat(32),
      parentSpanId: null,
      name: 'op',
      startTimeUnixNano: '1000',
      endTimeUnixNano: '2000',
      attributes: { foo: 'bar', token: '<REDACTED>' },
      redactedKeys: ['token'],
    });
    const rows = captures.getSpansBySession('sess-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('op');
    expect(rows[0].attributes).toEqual({ foo: 'bar', token: '<REDACTED>' });
    expect(rows[0].redactedKeys).toEqual(['token']);
  });

  it('incrementSpanCounts updates pending_captures aggregates', () => {
    captures.appendSpan({
      sessionId: 'sess-1',
      spanId: 'b'.repeat(16),
      traceId: 'a'.repeat(32),
      parentSpanId: null,
      name: 'op',
      startTimeUnixNano: '1000',
      endTimeUnixNano: '2000',
      attributes: { token: '<REDACTED>' },
      redactedKeys: ['token'],
    });
    captures.incrementSpanCounts('sess-1', { spans: 1, redactedSpans: 1, durationMsDelta: 1 });
    const rows = captures.listPending();
    expect(rows[0].spanCount).toBe(1);
    expect(rows[0].redactedSpanCount).toBe(1);
    expect(rows[0].durationMs).toBe(1);
  });

  it('multiple spans on the same session', () => {
    captures.appendSpan({
      sessionId: 'sess-1',
      spanId: 'b'.repeat(16),
      traceId: 'a'.repeat(32),
      parentSpanId: null,
      name: 'op1',
      startTimeUnixNano: '1000',
      endTimeUnixNano: '2000',
      attributes: {},
      redactedKeys: [],
    });
    captures.appendSpan({
      sessionId: 'sess-1',
      spanId: 'c'.repeat(16),
      traceId: 'a'.repeat(32),
      parentSpanId: 'b'.repeat(16),
      name: 'op2',
      startTimeUnixNano: '2000',
      endTimeUnixNano: '3000',
      attributes: {},
      redactedKeys: [],
    });
    const rows = captures.getSpansBySession('sess-1');
    expect(rows).toHaveLength(2);
  });

  it('rejects duplicate spanId within a session', () => {
    captures.appendSpan({
      sessionId: 'sess-1',
      spanId: 'b'.repeat(16),
      traceId: 'a'.repeat(32),
      parentSpanId: null,
      name: 'op',
      startTimeUnixNano: '1',
      endTimeUnixNano: '2',
      attributes: {},
      redactedKeys: [],
    });
    expect(() => captures.appendSpan({
      sessionId: 'sess-1',
      spanId: 'b'.repeat(16),
      traceId: 'a'.repeat(32),
      parentSpanId: null,
      name: 'dup',
      startTimeUnixNano: '1',
      endTimeUnixNano: '2',
      attributes: {},
      redactedKeys: [],
    })).toThrow();
  });
});

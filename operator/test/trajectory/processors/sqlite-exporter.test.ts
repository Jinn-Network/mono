import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Store } from '../../../src/store/store.js';
import { CapturesStore } from '../../../src/store/captures.js';
import { SqliteExporterProcessor } from '../../../src/trajectory/processors/sqlite-exporter.js';
import { TranscriptContentScrubProcessor } from '../../../src/trajectory/processors/transcript-content-scrub.js';
import { ReadableSpan } from '@opentelemetry/sdk-trace-base';

function fakeSpan(opts: {
  spanId: string;
  attrs: Record<string, unknown>;
  parentSpanId?: string;
  name?: string;
  startNs?: bigint;
  endNs?: bigint;
}): ReadableSpan {
  return {
    name: opts.name ?? 'op',
    attributes: { ...opts.attrs },
    spanContext: () => ({ traceId: 'a'.repeat(32), spanId: opts.spanId, traceFlags: 0 }),
    parentSpanContext: opts.parentSpanId
      ? { traceId: 'a'.repeat(32), spanId: opts.parentSpanId, traceFlags: 0 }
      : undefined,
    startTime: [Number((opts.startNs ?? 1000n) / 1_000_000_000n), Number((opts.startNs ?? 1000n) % 1_000_000_000n)],
    endTime: [Number((opts.endNs ?? 2000n) / 1_000_000_000n), Number((opts.endNs ?? 2000n) % 1_000_000_000n)],
  } as unknown as ReadableSpan;
}

describe('SqliteExporterProcessor', () => {
  let store: Store;
  let captures: CapturesStore;

  beforeEach(() => {
    store = new Store(':memory:');
    captures = new CapturesStore(store);
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

  it('writes capture-bound span (jinn.session.id) and reads it back', () => {
    const proc = new SqliteExporterProcessor({ captures });
    const span = fakeSpan({
      spanId: 'b'.repeat(16),
      attrs: { 'jinn.session.id': 'sess-1', foo: 'bar' },
    });
    proc.onEnd(span);
    const rows = captures.getSpansBySession('sess-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('op');
  });

  it('updates pending_captures aggregates as spans flow', () => {
    const proc = new SqliteExporterProcessor({ captures });
    proc.onEnd(fakeSpan({ spanId: 'b'.repeat(16), attrs: { 'jinn.session.id': 'sess-1', token: '<REDACTED>' } }));
    proc.onEnd(fakeSpan({ spanId: 'c'.repeat(16), attrs: { 'jinn.session.id': 'sess-1' } }));
    const pending = captures.listPending();
    expect(pending[0].spanCount).toBe(2);
    expect(pending[0].redactedSpanCount).toBe(1);  // only first span had a redaction
  });

  it('persists transcript content redactions from the scrub processor', () => {
    const scrub = new TranscriptContentScrubProcessor();
    const exporter = new SqliteExporterProcessor({ captures });
    const span = fakeSpan({
      spanId: 'd'.repeat(16),
      attrs: {
        'jinn.session.id': 'sess-1',
        'message.content': 'please use api_key=sk-aaaaaaaaaaaaaaaaaaaaaaaa',
      },
    });

    scrub.onEnd(span);
    exporter.onEnd(span);

    const [row] = captures.getSpansBySession('sess-1');
    expect(row.attributes['message.content']).toBe('<REDACTED>');
    expect(row.redactedKeys).toEqual(['message.content']);
    expect(captures.getBySession('sess-1')?.redactedSpanCount).toBe(1);
  });

  it('skips spans that have no jinn.session.id (out of scope: solver flows)', () => {
    const proc = new SqliteExporterProcessor({ captures });
    proc.onEnd(fakeSpan({ spanId: 'b'.repeat(16), attrs: { 'jinn.task.id': 'task-1', foo: 'bar' } }));
    expect(captures.getSpansBySession('sess-1')).toHaveLength(0);
    expect(captures.getSpansBySession('task-1')).toHaveLength(0);
  });

  it('skips spans whose sessionId has no pending row (race-free)', () => {
    const proc = new SqliteExporterProcessor({ captures });
    proc.onEnd(fakeSpan({ spanId: 'b'.repeat(16), attrs: { 'jinn.session.id': 'sess-unknown' } }));
    expect(captures.getSpansBySession('sess-unknown')).toHaveLength(0);
  });
});

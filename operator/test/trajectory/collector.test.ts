import { describe, it, expect, beforeEach } from 'vitest';
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { TrajectoryCollector } from '../../src/trajectory/collector.js';
import { computeGenesisHash, computePrevSpanHash } from '../../src/trajectory/hash-chain.js';

describe('TrajectoryCollector', () => {
  let c: TrajectoryCollector;
  beforeEach(() => {
    c = new TrajectoryCollector({ taskCid: 'bafy-task', runId: 'run-1' });
  });

  it('starts with empty spans and zero redactions', () => {
    expect(c.snapshot().spans).toEqual([]);
    expect(c.snapshot().redactionManifest.totalRedactions).toBe(0);
  });

  it('assigns jinn.prevSpanHash = genesis on the first span', () => {
    const span = c.addSpan({
      name: 'phase.design',
      kind: 'INTERNAL',
      startTimeUnixNano: '1',
      endTimeUnixNano: '2',
      attributes: { 'jinn.span.kind': 'jinn.phase', 'jinn.phase.name': 'design' },
      events: [],
      status: { code: 'OK' },
    });
    expect(span.attributes['jinn.prevSpanHash']).toBe(computeGenesisHash('bafy-task'));
  });

  it('assigns jinn.prevSpanHash = hash(previous) on subsequent spans', () => {
    const s1 = c.addSpan({
      name: 'a',
      kind: 'INTERNAL',
      startTimeUnixNano: '1',
      endTimeUnixNano: '2',
      attributes: { 'jinn.span.kind': 'jinn.phase', 'jinn.phase.name': 'design' },
      events: [],
      status: { code: 'OK' },
    });
    const s2 = c.addSpan({
      name: 'b',
      kind: 'INTERNAL',
      startTimeUnixNano: '2',
      endTimeUnixNano: '3',
      attributes: { 'jinn.span.kind': 'jinn.phase', 'jinn.phase.name': 'planning' },
      events: [],
      status: { code: 'OK' },
    });
    expect(s2.attributes['jinn.prevSpanHash']).toBe(computePrevSpanHash(s1));
  });

  it('assigns unique 16-hex spanIds + shared 32-hex traceId', () => {
    const s1 = c.addSpan({
      name: 'a',
      kind: 'INTERNAL',
      startTimeUnixNano: '1',
      endTimeUnixNano: '2',
      attributes: { 'jinn.span.kind': 'jinn.phase', 'jinn.phase.name': 'design' },
      events: [],
      status: { code: 'OK' },
    });
    const s2 = c.addSpan({
      name: 'b',
      kind: 'INTERNAL',
      startTimeUnixNano: '2',
      endTimeUnixNano: '3',
      attributes: { 'jinn.span.kind': 'jinn.phase', 'jinn.phase.name': 'planning' },
      events: [],
      status: { code: 'OK' },
    });
    expect(s1.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(s2.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(s1.spanId).not.toBe(s2.spanId);
    expect(s1.traceId).toBe(s2.traceId);
  });

  it('scrubs secret span attributes and records them in the redactionManifest', () => {
    const s = c.addSpan({
      name: 'llm',
      kind: 'CLIENT',
      startTimeUnixNano: '1',
      endTimeUnixNano: '2',
      attributes: {
        'jinn.span.kind': 'jinn.llm_call',
        'gen_ai.system': 'anthropic',
        'gen_ai.request.model': 'claude-opus-4-7',
        'gen_ai.usage.input_tokens': 1,
        'gen_ai.usage.output_tokens': 1,
        'http.request.header.authorization': 'Bearer sk-abc',
      },
      events: [],
      status: { code: 'OK' },
    });
    expect(s.attributes['http.request.header.authorization']).toBe(
      '<redacted:http.request.header.authorization>',
    );
    const snap = c.snapshot();
    expect(snap.redactionManifest.totalRedactions).toBe(1);
    expect(snap.redactionManifest.spans[0].spanId).toBe(s.spanId);
    expect(snap.redactionManifest.spans[0].redactedKeys).toEqual([
      'http.request.header.authorization',
    ]);
  });

  it('scrubs secret event attributes and records them in the redactionManifest', () => {
    // A span whose event carries a secret-keyed attribute (e.g. from an MCP
    // tool invocation that echoes back a token field).
    const s = c.addSpan({
      name: 'mcp',
      kind: 'CLIENT',
      startTimeUnixNano: '1',
      endTimeUnixNano: '2',
      attributes: { 'jinn.span.kind': 'jinn.mcp_call', 'mcp.tool.name': 'fetch' },
      events: [
        {
          timeUnixNano: '1500000000000000000',
          name: 'mcp.tool.response',
          attributes: {
            'mcp.response.token': 'sk-ant-api03-supersecret1234567890abcdef',
            'mcp.response.status': 'ok',
          },
        },
      ],
      status: { code: 'OK' },
    });

    const event = s.events[0];
    // Secret-keyed attribute must be scrubbed
    expect(event.attributes!['mcp.response.token']).toBe('<redacted:mcp.response.token>');
    // Non-secret attribute is untouched
    expect(event.attributes!['mcp.response.status']).toBe('ok');

    const snap = c.snapshot();
    expect(snap.redactionManifest.totalRedactions).toBe(1);
    expect(snap.redactionManifest.spans[0].redactedKeys).toContain('mcp.response.token');
  });

  it('scrubs both span attributes and event attributes in the same span', () => {
    const s = c.addSpan({
      name: 'llm',
      kind: 'CLIENT',
      startTimeUnixNano: '1',
      endTimeUnixNano: '2',
      attributes: {
        'jinn.span.kind': 'jinn.llm_call',
        'gen_ai.system': 'anthropic',
        'http.request.header.authorization': 'Bearer tok',
      },
      events: [
        {
          timeUnixNano: '1500000000000000000',
          name: 'llm.response',
          attributes: { 'llm.response.apiKey': 'sk-leaked-key', 'llm.response.tokens': 42 },
        },
      ],
      status: { code: 'OK' },
    });

    expect(s.attributes['http.request.header.authorization']).toBe(
      '<redacted:http.request.header.authorization>',
    );
    expect(s.events[0].attributes!['llm.response.apiKey']).toBe('<redacted:llm.response.apiKey>');
    expect(s.events[0].attributes!['llm.response.tokens']).toBe(42);

    const snap = c.snapshot();
    expect(snap.redactionManifest.totalRedactions).toBe(2);
  });

  it('passes events without attributes unchanged', () => {
    const s = c.addSpan({
      name: 'phase',
      kind: 'INTERNAL',
      startTimeUnixNano: '1',
      endTimeUnixNano: '2',
      attributes: { 'jinn.span.kind': 'jinn.phase', 'jinn.phase.name': 'design' },
      events: [{ timeUnixNano: '1500000000000000000', name: 'checkpoint' }],
      status: { code: 'OK' },
    });
    expect(s.events[0].name).toBe('checkpoint');
    expect(s.events[0].attributes).toBeUndefined();
    expect(c.snapshot().redactionManifest.totalRedactions).toBe(0);
  });

  it('threads parentSpanId through explicit parentage', () => {
    const parent = c.addSpan({
      name: 'phase',
      kind: 'INTERNAL',
      startTimeUnixNano: '1',
      endTimeUnixNano: '10',
      attributes: { 'jinn.span.kind': 'jinn.phase', 'jinn.phase.name': 'design' },
      events: [],
      status: { code: 'OK' },
    });
    const child = c.addSpan({
      name: 'llm',
      kind: 'CLIENT',
      startTimeUnixNano: '2',
      endTimeUnixNano: '3',
      attributes: {
        'jinn.span.kind': 'jinn.llm_call',
        'gen_ai.system': 'anthropic',
        'gen_ai.request.model': 'm',
        'gen_ai.usage.input_tokens': 1,
        'gen_ai.usage.output_tokens': 1,
      },
      events: [],
      status: { code: 'OK' },
      parentSpanId: parent.spanId,
    });
    expect(child.parentSpanId).toBe(parent.spanId);
  });

  it('runs finalized spans through OpenTelemetry SpanProcessors before snapshotting', () => {
    class MutatingProcessor implements SpanProcessor {
      seen: ReadableSpan[] = [];
      forceFlush() { return Promise.resolve(); }
      shutdown() { return Promise.resolve(); }
      onStart() {}
      onEnd(span: ReadableSpan) {
        this.seen.push(span);
        span.attributes['processor.touched'] = true;
      }
    }

    const processor = new MutatingProcessor();
    const collector = new TrajectoryCollector({
      taskCid: 'bafy-task',
      runId: 'run-processors',
      processors: [processor],
    });

    const span = collector.addSpan({
      name: 'phase',
      kind: 'INTERNAL',
      startTimeUnixNano: '1',
      endTimeUnixNano: '2',
      attributes: { 'jinn.span.kind': 'jinn.phase', 'jinn.phase.name': 'design' },
      events: [],
      status: { code: 'OK' },
    });

    expect(processor.seen).toHaveLength(1);
    expect(processor.seen[0].spanContext().spanId).toBe(span.spanId);
    expect(span.attributes['processor.touched']).toBe(true);
    expect(collector.snapshot().spans[0].attributes['processor.touched']).toBe(true);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { TrajectoryCollector } from '../../src/trajectory/collector.js';
import { computeGenesisHash, computePrevSpanHash } from '../../src/trajectory/hash-chain.js';

describe('TrajectoryCollector', () => {
  let c: TrajectoryCollector;
  beforeEach(() => {
    c = new TrajectoryCollector({ intentCid: 'bafy-intent', runId: 'run-1' });
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
    expect(span.attributes['jinn.prevSpanHash']).toBe(computeGenesisHash('bafy-intent'));
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

  it('scrubs secret attributes and records them in the redactionManifest', () => {
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
});

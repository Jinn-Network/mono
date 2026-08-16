import { describe, expect, test } from 'vitest';
import { buildScrubPipeline } from '../../../src/trajectory/scrub/build.js';
import { scrubSpansForEmit, scrubCaptureSpans } from '../../../src/trajectory/scrub/emit-scrub.js';
import type { Span } from '../../../src/trajectory/schema.js';

const GH = 'ghp_016C7e0aBcDeFgHiJkLmNoPqRsTuVwXyZ012';

function makeSpan(attrs: Record<string, unknown>, events: Span['events'] = []): Span {
  return {
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    parentSpanId: null,
    name: 'test',
    kind: 'INTERNAL',
    startTimeUnixNano: '0',
    endTimeUnixNano: '1',
    attributes: { 'jinn.span.kind': 'tool', ...attrs },
    events,
    status: { code: 'OK' },
  } as Span;
}

describe('scrubSpansForEmit', () => {
  test('scrubs content attributes, preserves jinn.* structural keys, rebuilds chain + manifest', async () => {
    const pipeline = buildScrubPipeline();
    const cid = 'bafybeigdyrqtjklmnopqrstuvwxyz234567abcdefghijklmno';
    const spans = [makeSpan({ 'tool.output': `token ${GH}`, 'jinn.task.id': cid })];

    const result = await scrubSpansForEmit(spans, pipeline, 'task-cid');
    const s = result.spans[0];

    expect(s.attributes['tool.output']).not.toContain(GH);
    // redacted to a placeholder by whichever stage caught it first (openredaction
    // has a GitHub-token pattern; secretlint also matches) — both bracket-wrap.
    expect(s.attributes['tool.output']).toMatch(/\[[A-Z_:]+/);
    // jinn.* structural key preserved despite looking high-entropy
    expect(s.attributes['jinn.task.id']).toBe(cid);
    expect(typeof s.attributes['jinn.prevSpanHash']).toBe('string');

    expect(result.redactionManifest.spans[0]?.spanId).toBe('b'.repeat(16));
    expect(result.redactionManifest.totalRedactions).toBe(
      result.redactionManifest.spans.reduce((a, x) => a + x.redactedKeys.length, 0),
    );
    expect(result.redactionManifest.totalRedactions).toBeGreaterThanOrEqual(1);
  });

  test('scrubs event attributes too', async () => {
    const pipeline = buildScrubPipeline();
    const spans = [
      makeSpan({}, [{ timeUnixNano: '0', name: 'stdout', attributes: { 'chunk': `key ${GH}` } }]),
    ];
    const result = await scrubSpansForEmit(spans, pipeline, 'task-cid');
    expect(JSON.stringify(result.spans[0].events)).not.toContain(GH);
  });
});

describe('scrubCaptureSpans', () => {
  // Capture spans (jinn.capture-trajectory.v1) are flat: attributes + an existing
  // redactedKeys list, NO events and NO hash chain. scrubCaptureSpans must scrub
  // attribute values, union the pipeline's redactions into redactedKeys, and leave
  // the capture-span shape otherwise untouched (no jinn.prevSpanHash injection).
  test('scrubs content attributes, merges redactedKeys, preserves jinn.*, adds no hash chain', async () => {
    const pipeline = buildScrubPipeline();
    const spans = [
      {
        sessionId: 'sess-1',
        spanId: 'b'.repeat(16),
        traceId: 'c'.repeat(32),
        parentSpanId: null,
        name: 'tool',
        startTimeUnixNano: '1',
        endTimeUnixNano: '2',
        attributes: { 'jinn.span.kind': 'tool', 'tool.output': `leaked ${GH}` } as Record<string, unknown>,
        redactedKeys: ['preexisting'],
      },
    ];

    const out = await scrubCaptureSpans(spans, pipeline);
    const s = out[0];

    expect(s.attributes['tool.output']).not.toContain(GH);
    // jinn.* structural key passes through untouched
    expect(s.attributes['jinn.span.kind']).toBe('tool');
    // captures carry no in-run hash chain — scrub must not invent one
    expect(s.attributes).not.toHaveProperty('jinn.prevSpanHash');
    // redactedKeys = stored ∪ newly-redacted
    expect(s.redactedKeys).toContain('preexisting');
    expect(s.redactedKeys).toContain('tool.output');
    // unrelated fields preserved
    expect(s.spanId).toBe('b'.repeat(16));
    expect(s.name).toBe('tool');
  });
});

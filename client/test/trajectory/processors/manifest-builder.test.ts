import { describe, it, expect } from 'vitest';
import { ManifestBuilderProcessor } from '../../../src/trajectory/processors/manifest-builder.js';
import { ReadableSpan } from '@opentelemetry/sdk-trace-base';

function fakeSpan(name: string, spanId: string, attrs: Record<string, unknown>): ReadableSpan {
  return {
    name,
    attributes: { ...attrs },
    spanContext: () => ({ traceId: 'a'.repeat(32), spanId, traceFlags: 0 }),
  } as unknown as ReadableSpan;
}

describe('ManifestBuilderProcessor', () => {
  it('records redactions on a span and emits a manifest', () => {
    const builder = new ManifestBuilderProcessor();
    const s = fakeSpan('s1', 'b'.repeat(16), {
      'shell.cwd': '/users/anon/x',
      'token': '<REDACTED>',
      'untouched': 'plain value',
    });
    builder.onEnd(s);
    const manifest = builder.flushManifest();
    expect(manifest.spans).toHaveLength(1);
    expect(manifest.spans[0].spanId).toBe('b'.repeat(16));
    expect(manifest.spans[0].redactedKeys).toContain('token');
    expect(manifest.spans[0].redactedKeys).not.toContain('untouched');
  });

  it('detects all <PLACEHOLDER>-style sentinels as redacted', () => {
    const builder = new ManifestBuilderProcessor();
    const s = fakeSpan('s', 'b'.repeat(16), {
      a: '<USER>',
      b: '<HOST>',
      c: '<MACHINE>',
      d: '<EMAIL>',
      e: '<AUTHOR>',
      f: '<IPV4>',
      g: '<REDACTED>',
      h: 'normal',
    });
    builder.onEnd(s);
    const manifest = builder.flushManifest();
    const keys = manifest.spans[0].redactedKeys;
    expect(keys).toEqual(expect.arrayContaining(['a', 'b', 'c', 'd', 'e', 'f', 'g']));
    expect(keys).not.toContain('h');
  });

  it('omits spans with no redactions from the manifest', () => {
    const builder = new ManifestBuilderProcessor();
    const s = fakeSpan('clean', 'c'.repeat(16), { only: 'plain', also: 'plain' });
    builder.onEnd(s);
    const manifest = builder.flushManifest();
    expect(manifest.spans).toHaveLength(0);
  });

  it('flushManifest drains the records (subsequent flush is empty)', () => {
    const builder = new ManifestBuilderProcessor();
    const s = fakeSpan('s', 'b'.repeat(16), { token: '<REDACTED>' });
    builder.onEnd(s);
    builder.flushManifest();
    const second = builder.flushManifest();
    expect(second.spans).toHaveLength(0);
  });

  it('does not mutate span attributes', () => {
    const builder = new ManifestBuilderProcessor();
    const orig = { token: '<REDACTED>', other: 'x' };
    const s = fakeSpan('s', 'b'.repeat(16), orig);
    builder.onEnd(s);
    expect(s.attributes).toEqual(orig);  // unchanged
  });

  it('handles non-string attribute values without including them', () => {
    const builder = new ManifestBuilderProcessor();
    const s = fakeSpan('s', 'b'.repeat(16), {
      count: 42,
      flag: true,
      arr: ['<REDACTED>'],  // non-string at top level (it's an array)
      tok: '<REDACTED>',
    });
    builder.onEnd(s);
    const manifest = builder.flushManifest();
    expect(manifest.spans[0].redactedKeys).toEqual(['tok']);
  });
});

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GLINER_MODEL,
  DEFAULT_GLINER_PII_LABELS,
  DEFAULT_INSTANCE_ALLOWLIST,
  DEFAULT_POLICY,
  REDACTION_MANIFEST_SCHEMA_VERSION,
  buildScrubPipeline,
  computeAllowlistDigest,
  computePolicyHash,
  mergeRedactionManifests,
  perClassCountKey,
  scrubSpansForEmit,
} from '../src/scrub/index.js';
import { RedactionManifestSchema } from '../src/trajectory/schema.js';
import type { Span } from '../src/trajectory/schema.js';

const FAKE_ADDRESS = `0x${'a'.repeat(40)}`;
const GH = 'ghp_016C7e0aBcDeFgHiJkLmNoPqRsTuVwXyZ012';

function makeSpan(attrs: Record<string, unknown>): Span {
  return {
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    parentSpanId: null,
    name: 'test',
    kind: 'INTERNAL',
    startTimeUnixNano: '0',
    endTimeUnixNano: '1',
    attributes: { 'jinn.span.kind': 'jinn.tool_call', 'jinn.prevSpanHash': '0x' + '00'.repeat(32), ...attrs },
    events: [],
    status: { code: 'OK' },
  };
}

describe('scrub provenance (#1974)', () => {
  it('computePolicyHash is stable across key order and detector order', () => {
    const allowlistDigest = computeAllowlistDigest(DEFAULT_INSTANCE_ALLOWLIST.entries);
    const a = computePolicyHash({
      policy: DEFAULT_POLICY,
      detectors: [
        { name: 'plain-patterns', version: '0.1.0' },
        { name: 'key-policy', version: '0.3.0' },
      ],
      modelId: DEFAULT_GLINER_MODEL,
      labels: [...DEFAULT_GLINER_PII_LABELS].reverse(),
      allowlistDigest,
    });
    const b = computePolicyHash({
      policy: DEFAULT_POLICY,
      detectors: [
        { name: 'key-policy', version: '0.3.0' },
        { name: 'plain-patterns', version: '0.1.0' },
      ],
      modelId: DEFAULT_GLINER_MODEL,
      labels: [...DEFAULT_GLINER_PII_LABELS],
      allowlistDigest,
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('computePolicyHash changes when model id changes', () => {
    const allowlistDigest = computeAllowlistDigest(DEFAULT_INSTANCE_ALLOWLIST.entries);
    const base = {
      policy: DEFAULT_POLICY,
      detectors: [{ name: 'key-policy', version: '0.3.0' }],
      labels: ['person'],
      allowlistDigest,
    };
    const a = computePolicyHash({ ...base, modelId: 'model-a' });
    const b = computePolicyHash({ ...base, modelId: 'model-b' });
    expect(a).not.toBe(b);
  });

  it('old redaction manifests without provenance fields still parse', () => {
    const legacy = {
      spans: [{ spanId: '1'.repeat(16), redactedKeys: ['tool.output'] }],
      totalRedactions: 1,
    };
    expect(() => RedactionManifestSchema.parse(legacy)).not.toThrow();
    const parsed = RedactionManifestSchema.parse(legacy);
    expect(parsed.schemaVersion).toBeUndefined();
    expect(parsed.policyHash).toBeUndefined();
    expect(parsed.perClassCounts).toBeUndefined();
  });

  it('emit populates schemaVersion, policyHash, and per-class counts', async () => {
    const pipeline = buildScrubPipeline({ failClosedOnUnresolvedFlags: false });
    const result = await scrubSpansForEmit(
      [makeSpan({ 'tool.output': `sent to ${FAKE_ADDRESS} token ${GH}` })],
      pipeline,
      'task-cid',
    );
    const m = result.redactionManifest;
    expect(m.schemaVersion).toBe(REDACTION_MANIFEST_SCHEMA_VERSION);
    expect(m.policyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(m.policyHash).toBe(pipeline.policyHash());
    expect(m.perClassCounts?.[perClassCountKey('C1', 'redact')]).toBeGreaterThanOrEqual(1);
    expect(m.perClassCounts?.[perClassCountKey('A1', 'redact')]).toBeGreaterThanOrEqual(1);
    expect(() => RedactionManifestSchema.parse(m)).not.toThrow();
  });

  it('pipeline.run perClassCounts match applied C1 redacts', async () => {
    const pipeline = buildScrubPipeline({ failClosedOnUnresolvedFlags: false });
    const result = await pipeline.run({
      content: `pay ${FAKE_ADDRESS} then ${FAKE_ADDRESS}`,
    });
    expect(String(result.attributes.content)).not.toContain(FAKE_ADDRESS);
    // Two non-overlapping C1 spans → two redacts.
    expect(result.perClassCounts?.[perClassCountKey('C1', 'redact')]).toBe(2);
  });

  it('mergeRedactionManifests sums perClassCounts and preserves policyHash', () => {
    const a = {
      spans: [{ spanId: '1'.repeat(16), redactedKeys: ['a'] }],
      totalRedactions: 1,
      schemaVersion: 2,
      policyHash: 'aa'.repeat(32),
      perClassCounts: { 'C1:redact': 1 },
    };
    const b = {
      spans: [{ spanId: '2'.repeat(16), redactedKeys: ['b'] }],
      totalRedactions: 1,
      schemaVersion: 2,
      perClassCounts: { 'C1:redact': 2, 'A1:redact': 1 },
    };
    const merged = mergeRedactionManifests(a, b);
    expect(merged.totalRedactions).toBe(2);
    expect(merged.policyHash).toBe('aa'.repeat(32));
    expect(merged.schemaVersion).toBe(2);
    expect(merged.perClassCounts).toEqual({ 'C1:redact': 3, 'A1:redact': 1 });
  });
});

import { describe, it, expect } from 'vitest';
import {
  JinnSpanKindSchema,
  SpanSchema,
  RedactionManifestSchema,
  JinnTrajectoryV1Schema,
} from '../../src/trajectory/schema.js';

describe('JinnSpanKindSchema', () => {
  it('accepts every normative kind', () => {
    for (const k of [
      'jinn.phase',
      'jinn.llm_call',
      'jinn.mcp_call',
      'jinn.artifact.emit',
      'jinn.venue_io',
      'jinn.state_transition',
      'jinn.agent_turn',
      'jinn.tool_call',
    ]) {
      expect(() => JinnSpanKindSchema.parse(k)).not.toThrow();
    }
  });
  it('rejects unknown kinds', () => {
    expect(() => JinnSpanKindSchema.parse('jinn.gossip')).toThrow();
  });
});

describe('SpanSchema', () => {
  const base = {
    traceId: '0'.repeat(32),
    spanId: '1'.repeat(16),
    parentSpanId: null,
    name: 'phase.design',
    kind: 'INTERNAL',
    startTimeUnixNano: '1700000000000000000',
    endTimeUnixNano: '1700000000001000000',
    attributes: {
      'jinn.span.kind': 'jinn.phase',
      'jinn.prevSpanHash': '0x' + 'aa'.repeat(32),
    },
    events: [],
    status: { code: 'OK' },
  };

  it('accepts a minimal span', () => {
    expect(() => SpanSchema.parse(base)).not.toThrow();
  });

  it('rejects a span without jinn.prevSpanHash', () => {
    const { attributes: _a, ...rest } = base;
    expect(() =>
      SpanSchema.parse({
        ...rest,
        attributes: { 'jinn.span.kind': 'jinn.phase' },
      }),
    ).toThrow();
  });

  it('rejects a span without jinn.span.kind', () => {
    expect(() =>
      SpanSchema.parse({
        ...base,
        attributes: { 'jinn.prevSpanHash': '0x' + 'bb'.repeat(32) },
      }),
    ).toThrow();
  });
});

describe('RedactionManifestSchema', () => {
  it('accepts a valid manifest', () => {
    const m = {
      spans: [{ spanId: '1'.repeat(16), redactedKeys: ['http.request.header.authorization'] }],
      totalRedactions: 1,
    };
    expect(() => RedactionManifestSchema.parse(m)).not.toThrow();
  });

  it('rejects when totalRedactions disagrees with spans sum', () => {
    const m = {
      spans: [{ spanId: '1'.repeat(16), redactedKeys: ['a', 'b'] }],
      totalRedactions: 1,
    };
    expect(() => RedactionManifestSchema.parse(m)).toThrow();
  });

  it('accepts additive v2 provenance fields and still parses legacy manifests', () => {
    const legacy = {
      spans: [{ spanId: '1'.repeat(16), redactedKeys: ['a'] }],
      totalRedactions: 1,
    };
    expect(() => RedactionManifestSchema.parse(legacy)).not.toThrow();
    expect(() =>
      RedactionManifestSchema.parse({
        ...legacy,
        schemaVersion: 2,
        policyHash: 'ab'.repeat(32),
        perClassCounts: { 'A1:redact': 1 },
      }),
    ).not.toThrow();
  });
});

describe('JinnTrajectoryV1Schema', () => {
  const valid = {
    schemaVersion: 'jinn.trajectory.v1',
    runId: '550e8400-e29b-41d4-a716-446655440000',
    parentEnvelopeCid: null,
    spans: [],
    redactionManifest: { spans: [], totalRedactions: 0 },
    signature: {
      algo: 'secp256k1',
      signer: '0x' + '22'.repeat(20),
      hash: '0x' + 'ef'.repeat(32),
      sig: '0x' + '12'.repeat(65),
    },
  };

  it('accepts a well-formed trajectory blob', () => {
    expect(() => JinnTrajectoryV1Schema.parse(valid)).not.toThrow();
  });

  it('rejects wrong schemaVersion', () => {
    expect(() =>
      JinnTrajectoryV1Schema.parse({ ...valid, schemaVersion: 'jinn.trajectory.v2' }),
    ).toThrow();
  });

  it('strips the retired backfill-only derivedFrom field', () => {
    const parsed = JinnTrajectoryV1Schema.parse({ ...valid, derivedFrom: 'bafy-source-cid' });
    expect('derivedFrom' in parsed).toBe(false);
  });
});

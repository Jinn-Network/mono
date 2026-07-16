import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { describeCorpusPortContract } from '@jinn-network/plugin/testing';
import type { HarnessLayer, CorpusSearchHit, CorpusRecord as WireCorpusRecord } from '../../src/consume.js';
import { createCorpusAdapter } from '../../src/adapters/corpus-adapter.js';
import { TRACE_ENVELOPE_ARTIFACT_TYPE } from '../../src/publish.js';
import type { TraceEnvelopeV0 } from '../../src/envelope.js';

function makeHit(overrides: Partial<CorpusSearchHit> = {}): CorpusSearchHit {
  return {
    title: 'coding / restoration',
    ref: 'bafyRef1',
    solverType: 'coding',
    role: 'restoration',
    artifactTypes: ['jinn.trace.v0'],
    kind: 'trace',
    evidenceTier: 'unknown',
    generatedAt: 0,
    publishedAt: 0,
    operator: { agentId: '1', safeAddress: '0xabc' },
    task: null,
    ...overrides,
  };
}

/**
 * A fake HarnessLayer whose corpus never touches RPC/IPFS. `search` returns a
 * fixed hit list; `get` throws for every ref (the missing-manifest path the
 * adapter must translate to `ok(null)`).
 */
function makeFakeLayer(): HarnessLayer {
  const hits: CorpusSearchHit[] = [
    makeHit({ ref: 'bafySkill', kind: 'skill', title: 'skill / one', summary: 'a distilled skill' }),
    makeHit({ ref: 'bafyTrace', kind: 'trace', title: 'trace / two', summary: 'a prior trace' }),
  ];
  return {
    config: {
      discoveryUrl: '',
      ipfsGatewayUrl: '',
      dbPath: '',
      captureMetaUrl: '',
    },
    corpus: {
      async search() {
        return hits;
      },
      async get() {
        throw new Error('manifest not found');
      },
    },
  };
}

describeCorpusPortContract(() => createCorpusAdapter({ layer: makeFakeLayer() }));

describe('CorpusAdapter mapping', () => {
  it('maps CorpusSearchHit → KnowledgeHit, carrying tags/origin/publishedAt (rescope R2)', async () => {
    const adapter = createCorpusAdapter({ layer: makeFakeLayer() });
    const result = await adapter.search('anything');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value).toEqual([
      { ref: 'bafySkill', kind: 'skill', title: 'skill / one', snippet: 'a distilled skill', tags: [], origin: '1', publishedAt: 0 },
      { ref: 'bafyTrace', kind: 'trace', title: 'trace / two', snippet: 'a prior trace', tags: [], origin: '1', publishedAt: 0 },
    ]);
  });

  it('carries capture-meta tags and prefers the agentId as origin over the free-form safeAddress', async () => {
    const layer = makeFakeLayer();
    layer.corpus.search = async () => [
      makeHit({
        ref: 'bafyTagged',
        tags: ['dashboard', 'vitest'],
        operator: { agentId: '42', safeAddress: '0xforgeable' },
      }),
    ];
    const adapter = createCorpusAdapter({ layer });
    const result = await adapter.search('anything');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value[0]).toMatchObject({ tags: ['dashboard', 'vitest'], origin: '42' });
  });

  it('degrades to an empty array when the underlying search throws', async () => {
    const layer = makeFakeLayer();
    layer.corpus.search = async () => {
      throw new Error('discovery unreachable');
    };
    const adapter = createCorpusAdapter({ layer });
    const result = await adapter.search('anything');
    expect(result.status).toBe('degraded');
    if (result.status === 'degraded') expect(result.value).toEqual([]);
  });
});

function traceEnvelope(overrides: Partial<TraceEnvelopeV0> = {}): TraceEnvelopeV0 {
  return {
    schemaVersion: 'jinn.trace-envelope.v0',
    session: { sessionId: 'seed:mono-dashboard-flake', capturedAt: '2026-07-04T00:00:00.000Z' },
    task: {
      summary: 'Fix the dashboard version-status flake',
      distributionTags: ['mono', 'dashboard', 'vitest', 'version-status', 'async', 'flake'],
    },
    environment: { harness: { name: 'hermes-agent', version: '0.1.0' }, model: 'claude-test', tools: ['bash'] },
    steps: [
      {
        spanId: 's1',
        parentSpanId: null,
        name: 'run tests',
        startTimeUnixNano: '1000000000',
        endTimeUnixNano: '2000000000',
        attributes: { 'tool.args': 'yarn test', 'tool.result': 'FAIL', 'tool.exitCode': 1 },
        redactedKeys: [],
      },
    ],
    outcome: { status: 'completed', verifiabilityTier: 'tests-passed', summary: 'Awaited the fetch; the flake is fixed.' },
    cost: { durationMs: 1000 },
    consent: { contributionConsent: true, scrubCompleted: true },
    provenance: 'imported',
    ...overrides,
  };
}

/** A WireCorpusRecord (consume.ts's shape) carrying a real, sha256-verifiable trace-envelope artifact. */
function wireRecordWithTrace(overrides: Partial<TraceEnvelopeV0> = {}, ref = 'bafySourceEpisode'): WireCorpusRecord {
  const envelope = traceEnvelope(overrides);
  const content = Buffer.from(JSON.stringify(envelope), 'utf-8');
  const sha256 = createHash('sha256').update(content).digest('hex');
  return {
    ref,
    envelope: { participant: { safeAddress: '0xparticipant' } } as WireCorpusRecord['envelope'],
    provenance: {
      operator: { agentId: 'agent-77', safeAddress: '0xoperator' },
      evidenceTier: 'self-signed',
      publishedAt: 1_751_587_200,
    },
    artifacts: [
      { sha256, artifactType: TRACE_ENVELOPE_ARTIFACT_TYPE, content, source: 'ipfs', sizeBytes: content.length },
    ],
  };
}

describe('CorpusAdapter.get() — content-bearing decode (rescope R2, #1772)', () => {
  it('returns the full decoded content (task summary, steps, outcome, tags, provenance, capturedAt) — not metadata', async () => {
    const layer = makeFakeLayer();
    const wireRecord = wireRecordWithTrace();
    layer.corpus.get = async () => wireRecord;
    const adapter = createCorpusAdapter({ layer });

    const result = await adapter.get('bafySourceEpisode');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok' || result.value === null) throw new Error('expected a decoded record');
    expect(result.value).toEqual({
      ref: 'bafySourceEpisode',
      task: { summary: 'Fix the dashboard version-status flake' },
      outcome: { status: 'completed', verifiabilityTier: 'tests-passed' },
      synthesis: 'Awaited the fetch; the flake is fixed.',
      steps: [{ name: 'run tests', attributes: { 'tool.args': 'yarn test', 'tool.result': 'FAIL', 'tool.exitCode': 1 } }],
      tags: ['mono', 'dashboard', 'vitest', 'version-status', 'async', 'flake'],
      provenance: 'imported',
      origin: 'agent-77',
      capturedAt: '2026-07-04T00:00:00.000Z',
    });
  });

  it('prefers the on-chain agentId as origin, falling back to safeAddress when agentId is absent', async () => {
    const layer = makeFakeLayer();
    const wireRecord = wireRecordWithTrace();
    wireRecord.provenance.operator = { agentId: '', safeAddress: '0xfallback' };
    layer.corpus.get = async () => wireRecord;
    const adapter = createCorpusAdapter({ layer });

    const result = await adapter.get('bafySourceEpisode');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok' || result.value === null) throw new Error('expected a decoded record');
    expect(result.value.origin).toBe('0xfallback');
  });

  it('refuses to serve content on a sha256 mismatch — degraded, not a silent pass-through', async () => {
    const layer = makeFakeLayer();
    const wireRecord = wireRecordWithTrace();
    wireRecord.artifacts[0]!.sha256 = 'f'.repeat(64); // corrupt
    layer.corpus.get = async () => wireRecord;
    const adapter = createCorpusAdapter({ layer });

    const result = await adapter.get('bafySourceEpisode');
    expect(result.status).toBe('degraded');
    if (result.status !== 'degraded') return;
    expect(result.reason).toContain('sha256 mismatch');
    expect(result.value).toBeNull();
  });

  it('returns ok(null) for a record carrying no trace-envelope artifact (e.g. a skill-only record)', async () => {
    const layer = makeFakeLayer();
    const wireRecord = wireRecordWithTrace();
    wireRecord.artifacts = [];
    layer.corpus.get = async () => wireRecord;
    const adapter = createCorpusAdapter({ layer });

    expect(await adapter.get('bafySourceEpisode')).toEqual({ status: 'ok', value: null });
  });

  it('returns ok(null) when the underlying manifest is missing (unknown ref)', async () => {
    const adapter = createCorpusAdapter({ layer: makeFakeLayer() });
    expect(await adapter.get('does-not-exist')).toEqual({ status: 'ok', value: null });
  });
});

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { dedupeKnowledgeHits, RETRIEVAL_VISIBLE_TAG } from '@jinn-network/plugin';
import { describeCorpusPortContract } from '@jinn-network/plugin/testing';
import type { HarnessLayer, CorpusSearchHit, CorpusRecord as WireCorpusRecord } from '../../src/consume.js';
import { createCorpusAdapter } from '../../src/adapters/corpus-adapter.js';
import { TRACE_ENVELOPE_ARTIFACT_TYPE } from '../../src/publish.js';
import type { TraceEnvelopeV0, TraceStep } from '../../src/envelope.js';
import { SKILL_ARTIFACT_TYPE } from '../../../../src/types/skill-artifact.js';

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
      { ref: 'bafySkill', kind: 'skill', title: 'skill / one', snippet: 'a distilled skill', tags: [], origin: '1', publishedAt: 0, retrievalVisible: false },
      { ref: 'bafyTrace', kind: 'trace', title: 'trace / two', snippet: 'a prior trace', tags: [], origin: '1', publishedAt: 0, retrievalVisible: false },
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

  it('does not let a forged safeAddress collapse distinct unattributed records during content dedup', async () => {
    const layer = makeFakeLayer();
    layer.corpus.search = async () => [
      makeHit({
        ref: 'bafyDistinctA',
        summary: 'same task summary',
        operator: { agentId: '', safeAddress: '0xforged' },
      }),
      makeHit({
        ref: 'bafyDistinctB',
        summary: 'same task summary',
        operator: { agentId: '', safeAddress: '0xforged' },
      }),
    ];
    const adapter = createCorpusAdapter({ layer });

    const result = await adapter.search('anything');

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.map((hit) => hit.origin)).toEqual(['bafyDistinctA', 'bafyDistinctB']);
    expect(dedupeKnowledgeHits(result.value)).toHaveLength(2);
  });

  // Issue #1824 (corpus-supply-design §5 W2): the adapter computes the
  // ranking-visible fact from the wire hit's tags and strips the mark tag so
  // it never enters the scoring haystack (haystackFor scores tags — an
  // unstripped mark would inflate scores via substring matches) or the
  // rendered packet.
  describe('retrieval-visibility mark mapping (#1824)', () => {
    it('maps a marked wire hit to retrievalVisible: true and strips the mark tag from tags', async () => {
      const layer = makeFakeLayer();
      layer.corpus.search = async () => [
        makeHit({ ref: 'bafyMarked', tags: ['dashboard', RETRIEVAL_VISIBLE_TAG, 'vitest'] }),
      ];
      const adapter = createCorpusAdapter({ layer });
      const result = await adapter.search('anything');
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      expect(result.value[0]?.retrievalVisible).toBe(true);
      expect(result.value[0]?.tags).toEqual(['dashboard', 'vitest']);
    });

    it('maps an unmarked wire hit to an explicit retrievalVisible: false with tags unchanged', async () => {
      const layer = makeFakeLayer();
      layer.corpus.search = async () => [
        makeHit({ ref: 'bafyUnmarked', tags: ['dashboard', 'vitest'] }),
      ];
      const adapter = createCorpusAdapter({ layer });
      const result = await adapter.search('anything');
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      expect(result.value[0]?.retrievalVisible).toBe(false);
      expect(result.value[0]?.tags).toEqual(['dashboard', 'vitest']);
    });

    it('strips only the mark tag from a wire hit at the full 16-tag budget', async () => {
      const fifteen = Array.from({ length: 15 }, (_, i) => `tag-${i}`);
      const layer = makeFakeLayer();
      layer.corpus.search = async () => [
        makeHit({ ref: 'bafyFullBudget', tags: [...fifteen, RETRIEVAL_VISIBLE_TAG] }),
      ];
      const adapter = createCorpusAdapter({ layer });
      const result = await adapter.search('anything');
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      expect(result.value[0]?.retrievalVisible).toBe(true);
      expect(result.value[0]?.tags).toEqual(fifteen);
    });
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
      retrievalVisible: false,
    });
  });

  it('prefers the on-chain agentId for display attribution, falling back to safeAddress when absent', async () => {
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

  it('falls back to a seed-authored synthesis step when outcome.summary is absent (rescope R4 seed lane)', async () => {
    // The evidence-episode seed lane (seed-import/episode-execute.ts) authors
    // synthesis longer than outcome.summary's 500-char cap allows, so it
    // carries the text on a `seed.synthesis` step attribute instead.
    const layer = makeFakeLayer();
    const wireRecord = wireRecordWithTrace({
      outcome: { status: 'completed', verifiabilityTier: 'tests-passed' },
      steps: [
        {
          spanId: 's1',
          parentSpanId: null,
          name: 'seed:step:failure',
          startTimeUnixNano: '1000000000',
          endTimeUnixNano: '1000000000',
          attributes: { 'seed.step.label': 'failure', 'seed.step.title': 't', 'seed.step.text': 'FAIL' },
          redactedKeys: [],
        },
        {
          spanId: 's2',
          parentSpanId: null,
          name: 'seed:synthesis',
          startTimeUnixNano: '2000000000',
          endTimeUnixNano: '2000000000',
          attributes: {
            'seed.synthesis': 'A synthesis longer than the 500-char outcome.summary cap would allow.',
            'seed.attribution': { repo: 'acme/widget', origin: 'operator-recorded-session' },
          },
          redactedKeys: [],
        },
      ],
    });
    layer.corpus.get = async () => wireRecord;
    const adapter = createCorpusAdapter({ layer });

    const result = await adapter.get('bafySourceEpisode');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok' || result.value === null) throw new Error('expected a decoded record');
    expect(result.value.synthesis).toBe('A synthesis longer than the 500-char outcome.summary cap would allow.');
  });

  it('prefers outcome.summary over a seed-authored synthesis step when both are present', async () => {
    const layer = makeFakeLayer();
    const wireRecord = wireRecordWithTrace({
      outcome: { status: 'completed', verifiabilityTier: 'tests-passed', summary: 'the real capture synthesis' },
      steps: [
        {
          spanId: 's1',
          parentSpanId: null,
          name: 'seed:synthesis',
          startTimeUnixNano: '1000000000',
          endTimeUnixNano: '1000000000',
          attributes: { 'seed.synthesis': 'a seed synthesis that must not win' },
          redactedKeys: [],
        },
      ],
    });
    layer.corpus.get = async () => wireRecord;
    const adapter = createCorpusAdapter({ layer });

    const result = await adapter.get('bafySourceEpisode');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok' || result.value === null) throw new Error('expected a decoded record');
    expect(result.value.synthesis).toBe('the real capture synthesis');
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

/** The exact step shape `seed-import/execute.ts` `toCapturedTask` publishes
 *  for a legacy (pre-#1394) seed-imported skill: a single synthetic step
 *  named `seed:skill-md` carrying the SKILL.md as a string `skill.md`
 *  attribute plus `seed.attribution` — no first-class `jinn.skill.v1`
 *  artifact, so this record's wire `kind` is `'trace'`. */
function seedSkillMdStep(skillMd = '# Video Edit\n\nEdit video clips with RunComfy workflows.'): TraceStep {
  return {
    spanId: 'seed-1',
    parentSpanId: null,
    name: 'seed:skill-md',
    startTimeUnixNano: '1000000000',
    endTimeUnixNano: '1000000000',
    attributes: {
      'skill.md': skillMd,
      'seed.attribution': {
        skill: 'agentspace-so/runcomfy-agent-skills/video-edit',
        source: 'https://github.com/agentspace-so/runcomfy-agent-skills',
        licence: 'MIT',
      },
    },
    redactedKeys: [],
  };
}

describe('CorpusAdapter.get() — content-level skill classification (mono #1782)', () => {
  it('classifies a legacy pre-#1394 seeded record as a skill payload via its skill.md step attribute, even though the wire kind is trace', async () => {
    const layer = makeFakeLayer();
    const wireRecord = wireRecordWithTrace({
      task: {
        summary: 'Seed import: agentspace-so/runcomfy-agent-skills/video-edit',
        distributionTags: ['seed-import', 'runcomfy-agent-skills', 'video-edit'],
      },
      steps: [seedSkillMdStep()],
      outcome: { status: 'completed', verifiabilityTier: 'user-accepted' },
      provenance: 'imported',
    });
    layer.corpus.get = async () => wireRecord;
    const adapter = createCorpusAdapter({ layer });

    const result = await adapter.get('bafySourceEpisode');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok' || result.value === null) throw new Error('expected a decoded record');
    expect(result.value.isSkillPayload).toBe(true);
  });

  it('recognises a skill.md attribute on any step, not only one named seed:skill-md', async () => {
    const layer = makeFakeLayer();
    const wireRecord = wireRecordWithTrace({
      steps: [{ ...seedSkillMdStep(), name: 'some-other-step-name' }],
    });
    layer.corpus.get = async () => wireRecord;
    const adapter = createCorpusAdapter({ layer });

    const result = await adapter.get('bafySourceEpisode');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok' || result.value === null) throw new Error('expected a decoded record');
    expect(result.value.isSkillPayload).toBe(true);
  });

  it('classifies a first-class jinn.skill.v1-backed record as a skill payload even when the wire kind says trace', async () => {
    const layer = makeFakeLayer();
    const wireRecord = wireRecordWithTrace();
    wireRecord.artifacts.push({
      sha256: 'a'.repeat(64),
      artifactType: SKILL_ARTIFACT_TYPE,
      content: Buffer.from('{}'),
      source: 'ipfs',
      sizeBytes: 2,
    });
    layer.corpus.get = async () => wireRecord;
    const adapter = createCorpusAdapter({ layer });

    const result = await adapter.get('bafySourceEpisode');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok' || result.value === null) throw new Error('expected a decoded record');
    expect(result.value.isSkillPayload).toBe(true);
  });

  it('does not set isSkillPayload for an ordinary trace record (regression — the seeded evidence fixtures project as before)', async () => {
    const layer = makeFakeLayer();
    const wireRecord = wireRecordWithTrace();
    layer.corpus.get = async () => wireRecord;
    const adapter = createCorpusAdapter({ layer });

    const result = await adapter.get('bafySourceEpisode');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok' || result.value === null) throw new Error('expected a decoded record');
    expect(result.value.isSkillPayload).toBeUndefined();
  });

  it('sets retrievalVisible: true when the decoded envelope’s own distributionTags carry the mark (#1824)', async () => {
    const layer = makeFakeLayer();
    const wireRecord = wireRecordWithTrace({
      task: {
        summary: 'Fix the dashboard version-status flake',
        distributionTags: ['dashboard', RETRIEVAL_VISIBLE_TAG],
      },
    });
    layer.corpus.get = async () => wireRecord;
    const adapter = createCorpusAdapter({ layer });

    const result = await adapter.get('bafySourceEpisode');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok' || result.value === null) throw new Error('expected a decoded record');
    expect(result.value.retrievalVisible).toBe(true);
    // CorpusRecord.tags is provenance-adjacent display data on the content
    // path, not the scoring haystack — deliberately NOT stripped (see the
    // adapter's comment on the asymmetry with the search-hit path).
    expect(result.value.tags).toContain(RETRIEVAL_VISIBLE_TAG);
  });

  it('sets retrievalVisible: false when the decoded envelope lacks the mark (#1824)', async () => {
    const layer = makeFakeLayer();
    layer.corpus.get = async () => wireRecordWithTrace();
    const adapter = createCorpusAdapter({ layer });

    const result = await adapter.get('bafySourceEpisode');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok' || result.value === null) throw new Error('expected a decoded record');
    expect(result.value.retrievalVisible).toBe(false);
  });

  it('does not classify a step whose skill.md attribute is present but empty or non-string', async () => {
    const layer = makeFakeLayer();
    const wireRecord = wireRecordWithTrace({
      steps: [
        {
          spanId: 's1',
          parentSpanId: null,
          name: 'run tests',
          startTimeUnixNano: '1000000000',
          endTimeUnixNano: '2000000000',
          attributes: { 'skill.md': '', 'tool.args': 'yarn test', 'tool.exitCode': 0 },
          redactedKeys: [],
        },
      ],
    });
    layer.corpus.get = async () => wireRecord;
    const adapter = createCorpusAdapter({ layer });

    const result = await adapter.get('bafySourceEpisode');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok' || result.value === null) throw new Error('expected a decoded record');
    expect(result.value.isSkillPayload).toBeUndefined();
  });
});

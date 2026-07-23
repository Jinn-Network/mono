import { describe, expect, it } from 'vitest';
import { describeCorpusPortContract } from '../../src/testing/contract-kits.js';
import { InMemoryCorpusPort, type InMemoryCorpusSeed } from '../../src/testing/in-memory-corpus.js';

describeCorpusPortContract(() => new InMemoryCorpusPort());

function seedRecord(overrides: Partial<InMemoryCorpusSeed> = {}): InMemoryCorpusSeed {
  return {
    ref: 'bafySeed1',
    kind: 'trace',
    task: { summary: 'Fix the dashboard version-status flake' },
    outcome: { status: 'completed', verifiabilityTier: 'tests-passed' },
    steps: [],
    tags: ['dashboard', 'vitest'],
    provenance: 'imported',
    origin: 'seed:acme',
    capturedAt: '2026-07-15T00:00:00.000Z',
    ...overrides,
  };
}

describe('InMemoryCorpusPort (rescope §3 — content-bearing get())', () => {
  it('get() returns the full decoded content, not just metadata', async () => {
    const port = new InMemoryCorpusPort([seedRecord()]);
    const result = await port.get('bafySeed1');
    // CorpusRecord — the hit-only fields (kind/title/tier/payloadKind/publishedAt) are not part of it.
    expect(result).toEqual({
      status: 'ok',
      value: {
        ref: 'bafySeed1',
        task: { summary: 'Fix the dashboard version-status flake' },
        outcome: { status: 'completed', verifiabilityTier: 'tests-passed' },
        steps: [],
        tags: ['dashboard', 'vitest'],
        provenance: 'imported',
        origin: 'seed:acme',
        capturedAt: '2026-07-15T00:00:00.000Z',
        retrievalVisible: true,
      },
    });
  });

  it('search() projects seeded records into KnowledgeHit metadata, carrying tags and origin', async () => {
    const port = new InMemoryCorpusPort([seedRecord({ title: 'dashboard fix', tier: 'tests-passed' })]);
    const result = await port.search('dashboard');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value).toEqual([{
      ref: 'bafySeed1',
      kind: 'trace',
      title: 'dashboard fix',
      snippet: 'Fix the dashboard version-status flake',
      tier: 'tests-passed',
      tags: ['dashboard', 'vitest'],
      origin: 'seed:acme',
      retrievalVisible: true,
    }]);
  });

  it('preserves a seeded canonical episode identity through get() and may expose it on search()', async () => {
    const port = new InMemoryCorpusPort([
      seedRecord({ canonicalEpisodeId: 'episode-contract' }),
    ]);

    const recordResult = await port.get('bafySeed1');
    expect(recordResult).toMatchObject({
      status: 'ok',
      value: { canonicalEpisodeId: 'episode-contract' },
    });

    const hitResult = await port.search('dashboard');
    expect(hitResult).toMatchObject({
      status: 'ok',
      value: [{ canonicalEpisodeId: 'episode-contract' }],
    });
  });

  // #1824: seeds default to retrieval-visible so pre-allowlist scenarios keep
  // working; an explicit false must survive both views for exclusion tests.
  it('carries an explicit retrievalVisible: false through both search() and get()', async () => {
    const port = new InMemoryCorpusPort([seedRecord({ retrievalVisible: false })]);
    const hitResult = await port.search('dashboard');
    expect(hitResult.status).toBe('ok');
    if (hitResult.status !== 'ok') return;
    expect(hitResult.value[0]?.retrievalVisible).toBe(false);

    const recordResult = await port.get('bafySeed1');
    expect(recordResult.status).toBe('ok');
    if (recordResult.status !== 'ok' || recordResult.value === null) throw new Error('expected a record');
    expect(recordResult.value.retrievalVisible).toBe(false);
  });

  it('get() on an unseeded ref returns ok(null)', async () => {
    const port = new InMemoryCorpusPort([seedRecord()]);
    expect(await port.get('does-not-exist')).toEqual({ status: 'ok', value: null });
  });

  // Mono #1782: isSkillPayload is a content-level fact on CorpusRecord,
  // independent of the search hit's wire kind/payloadKind — the kit must
  // carry it through get() so a fixture can express "hit-level says
  // nothing, content-level says skill" (the legacy-seed bug shape).
  it('get() carries the content-level isSkillPayload fact through, independent of the hit-level kind/payloadKind', async () => {
    const port = new InMemoryCorpusPort([
      seedRecord({ ref: 'bafySkillPayload', kind: 'trace', isSkillPayload: true }),
    ]);
    const result = await port.get('bafySkillPayload');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok' || result.value === null) throw new Error('expected a decoded record');
    expect(result.value.isSkillPayload).toBe(true);

    const hitResult = await port.search('bafySkillPayload');
    expect(hitResult.status).toBe('ok');
    if (hitResult.status !== 'ok') return;
    // The synthesized search hit never carries a content-level fact — only
    // the adapter's real decode path can classify a payload post-fetch.
    expect(hitResult.value[0]).not.toHaveProperty('isSkillPayload');
  });

  it('get() omits isSkillPayload when the seed does not set it (no false-y noise on an ordinary record)', async () => {
    const port = new InMemoryCorpusPort([seedRecord()]);
    const result = await port.get('bafySeed1');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok' || result.value === null) throw new Error('expected a decoded record');
    expect(result.value).not.toHaveProperty('isSkillPayload');
  });
});

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
    }]);
  });

  it('get() on an unseeded ref returns ok(null)', async () => {
    const port = new InMemoryCorpusPort([seedRecord()]);
    expect(await port.get('does-not-exist')).toEqual({ status: 'ok', value: null });
  });
});

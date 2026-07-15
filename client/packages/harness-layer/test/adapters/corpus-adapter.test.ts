import { describe, expect, it } from 'vitest';
import { describeCorpusPortContract } from '@jinn-network/plugin/testing';
import type { HarnessLayer, CorpusSearchHit } from '../../src/consume.js';
import { createCorpusAdapter } from '../../src/adapters/corpus-adapter.js';

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
  it('maps CorpusSearchHit → KnowledgeHit (skill + trace, summary→snippet, no score)', async () => {
    const adapter = createCorpusAdapter({ layer: makeFakeLayer() });
    const result = await adapter.search('anything');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value).toEqual([
      { ref: 'bafySkill', kind: 'skill', title: 'skill / one', snippet: 'a distilled skill' },
      { ref: 'bafyTrace', kind: 'trace', title: 'trace / two', snippet: 'a prior trace' },
    ]);
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

import { describe, it, expect, vi } from 'vitest';
import { handleSearchArtifacts } from '../../src/mcp/search-artifacts.js';
import { Store } from '../../src/store/store.js';

describe('search_artifacts (corpus-backed)', () => {
  it('returns local + network results', async () => {
    const store = new Store(':memory:');
    store.saveServedArtifact({
      sha256: 'a'.repeat(64),
      artifactType: 'output.prediction.v0',
      requestId: '0x' + 'b'.repeat(64),
      content: Buffer.from('local'),
      priceUsdc: '0',
      createdAt: '2026-04-30T00:00:00.000Z',
    });
    const corpus = {
      query: vi.fn(async () => [
        {
          manifestCid: 'bafyOther',
          manifestHash: '0x' + 'c'.repeat(64),
          operator: { agentId: '2', safeAddress: '0x' + '2'.repeat(40) },
          evidenceTier: 'committed' as const,
          publishedAt: 1745978400,
        },
      ]),
    } as never;
    const out = await handleSearchArtifacts(corpus, store, { kind: 'output.prediction.v0', limit: 10 });
    expect(out.local).toHaveLength(1);
    expect(out.local[0]?.source).toBe('served');
    expect(out.local[0]?.sha256).toBe('a'.repeat(64));
    expect(out.network).toHaveLength(1);
    expect(out.network[0]?.manifestCid).toBe('bafyOther');
    store.close();
  });

  it('returns cached network artifacts in local results', async () => {
    const store = new Store(':memory:');
    store.saveNetworkArtifact({
      sha256: 'd'.repeat(64),
      artifactType: 'output.prediction.v0',
      content: Buffer.from('cached'),
      source: 'origin',
      paidAmountUsdc: '0',
      fetchedAt: '2026-04-30T00:00:00.000Z',
    });
    const corpus = { query: vi.fn(async () => []) } as never;
    const out = await handleSearchArtifacts(corpus, store, { kind: 'output.prediction.v0', limit: 10 });
    expect(out.local).toHaveLength(1);
    expect(out.local[0]?.source).toBe('network');
    expect(out.network).toHaveLength(0);
    store.close();
  });

  it('filters local results by artifact type when kind specified', async () => {
    const store = new Store(':memory:');
    store.saveServedArtifact({
      sha256: 'a'.repeat(64),
      artifactType: 'output.prediction.v0',
      content: Buffer.from('p'),
      priceUsdc: '0',
      createdAt: '2026-04-30T00:00:00.000Z',
    });
    store.saveServedArtifact({
      sha256: 'b'.repeat(64),
      artifactType: 'output.something.else',
      content: Buffer.from('q'),
      priceUsdc: '0',
      createdAt: '2026-04-30T00:00:00.000Z',
    });
    const corpus = { query: vi.fn(async () => []) } as never;
    const out = await handleSearchArtifacts(corpus, store, { kind: 'output.prediction.v0', limit: 10 });
    expect(out.local).toHaveLength(1);
    expect(out.local[0]?.artifactType).toBe('output.prediction.v0');
    store.close();
  });
});

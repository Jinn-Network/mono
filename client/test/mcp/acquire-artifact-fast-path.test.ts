import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Store } from '../../src/store/store.js';
import { handleAcquireArtifact } from '../../src/mcp/acquire-artifact.js';

describe('acquire_artifact (corpus + fast paths)', () => {
  let store: Store;
  beforeEach(() => { store = new Store(':memory:'); });
  afterEach(() => store.close());

  it('returns from served_artifacts without calling corpus', async () => {
    const sha256 = 'a'.repeat(64);
    const bytes = Buffer.from('own content');
    store.saveServedArtifact({
      sha256,
      artifactType: 'design_document',
      content: bytes,
      priceUsdc: '0',
      createdAt: '2026-04-30T00:00:00.000Z',
    });
    const corpus = { acquireBySha256: vi.fn() } as never;
    const out = await handleAcquireArtifact(corpus, store, {
      sha256,
      access: { endpoint: 'https://op.example.com', priceUsdc: '0' },
    });
    expect(out.source).toBe('self-store');
    expect(out.bytes.toString()).toBe('own content');
    expect(out.artifactType).toBe('design_document');
    expect(corpus.acquireBySha256).not.toHaveBeenCalled();
  });

  it('returns from network_artifacts cache without calling corpus', async () => {
    const sha256 = 'b'.repeat(64);
    const bytes = Buffer.from('cached content');
    store.saveNetworkArtifact({
      sha256,
      artifactType: 'design_document',
      content: bytes,
      source: 'origin',
      paidAmountUsdc: '0',
      fetchedAt: '2026-04-30T00:00:00.000Z',
    });
    const corpus = { acquireBySha256: vi.fn() } as never;
    const out = await handleAcquireArtifact(corpus, store, {
      sha256,
      access: { endpoint: 'https://op.example.com', priceUsdc: '0' },
    });
    expect(out.source).toBe('cache');
    expect(out.bytes.toString()).toBe('cached content');
    expect(corpus.acquireBySha256).not.toHaveBeenCalled();
  });

  it('falls through to corpus.acquireBySha256 when no fast path hits', async () => {
    const sha256 = 'c'.repeat(64);
    const corpus = {
      acquireBySha256: vi.fn(async () => ({
        sha256,
        bytes: Buffer.from('fetched'),
        artifactType: 'design_document',
        source: 'origin' as const,
        paidAmountUsdc: '0',
        fetchedAt: '2026-04-30T00:00:00.000Z',
      })),
    } as never;
    const out = await handleAcquireArtifact(corpus, store, {
      sha256,
      access: { endpoint: 'https://op.example.com', priceUsdc: '0' },
    });
    expect(out.source).toBe('origin');
    expect(corpus.acquireBySha256).toHaveBeenCalledOnce();
    expect(corpus.acquireBySha256).toHaveBeenCalledWith(
      sha256,
      { endpoint: 'https://op.example.com', priceUsdc: '0' },
      { artifactType: undefined, envelopeCid: undefined },
    );
  });

  it('passes envelopeCid + artifactType hints through to corpus', async () => {
    const sha256 = 'e'.repeat(64);
    const corpus = {
      acquireBySha256: vi.fn(async () => ({
        sha256,
        bytes: Buffer.from('x'),
        artifactType: 'design_document',
        source: 'origin' as const,
        paidAmountUsdc: '0.01',
        fetchedAt: '2026-04-30T00:00:00.000Z',
      })),
    } as never;
    await handleAcquireArtifact(corpus, store, {
      sha256,
      access: { endpoint: 'https://op.example.com', priceUsdc: '0.01' },
      envelopeCid: 'bafyEnv',
      artifactType: 'design_document',
    });
    expect(corpus.acquireBySha256).toHaveBeenCalledWith(
      sha256,
      { endpoint: 'https://op.example.com', priceUsdc: '0.01' },
      { artifactType: 'design_document', envelopeCid: 'bafyEnv' },
    );
  });

  it('touches network_artifacts last_used_at on cache hit', async () => {
    const sha256 = 'f'.repeat(64);
    store.saveNetworkArtifact({
      sha256,
      artifactType: 'design_document',
      content: Buffer.from('cached'),
      source: 'origin',
      paidAmountUsdc: '0',
      fetchedAt: '2026-04-30T00:00:00.000Z',
    });
    const corpus = { acquireBySha256: vi.fn() } as never;
    await handleAcquireArtifact(corpus, store, {
      sha256,
      access: { endpoint: 'https://op.example.com', priceUsdc: '0' },
    });
    const row = store.getNetworkArtifact(sha256);
    expect(row).not.toBeNull();
    // last_used_at should be ISO timestamp now (post 2026-04-30)
    expect(row!.lastUsedAt >= '2026-04-30T00:00:00.000Z').toBe(true);
  });
});

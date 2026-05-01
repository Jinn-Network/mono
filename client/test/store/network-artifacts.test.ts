import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Store } from '../../src/store/store.js';

describe('Store.network_artifacts', () => {
  let store: Store;
  beforeEach(() => { store = new Store(':memory:'); });
  afterEach(() => { store.close(); });

  it('saves a fetched artifact and reads it back by sha256', () => {
    const sha256 = 'e'.repeat(64);
    const content = Buffer.from('cached content', 'utf-8');
    store.saveNetworkArtifact({
      sha256,
      artifactType: 'trajectory',
      envelopeCid: 'bafyEnvelopeA',
      content,
      source: 'origin',
      sourceOperator: '0x' + '1'.repeat(40),
      sourceEndpoint: 'https://operator.example.com',
      paidAmountUsdc: '0.001',
      fetchedAt: '2026-04-30T00:00:00.000Z',
    });

    const row = store.getNetworkArtifact(sha256);
    expect(row).not.toBeNull();
    expect(row!.sha256).toBe(sha256);
    expect(row!.content.equals(content)).toBe(true);
    expect(row!.source).toBe('origin');
    expect(row!.sourceOperator).toBe('0x' + '1'.repeat(40));
    expect(row!.paidAmountUsdc).toBe('0.001');
    expect(row!.lastUsedAt).toBe('2026-04-30T00:00:00.000Z');
    expect(row!.peerCatalogId).toBeNull();
  });

  it('resolves catalog text via peer_catalog_id after save', () => {
    const sha256 = 'a'.repeat(64);
    store.saveNetworkArtifact({
      sha256,
      artifactType: 'api-catalog',
      content: Buffer.from('peer body', 'utf-8'),
      source: 'origin',
      sourceEndpoint: 'http://peer.example',
      paidAmountUsdc: '0',
      fetchedAt: '2026-04-30T12:00:00.000Z',
      peerCatalogId: 'artifact-xyz',
    });
    expect(store.resolveCatalogArtifactContent('artifact-xyz')).toBe('peer body');
  });

  it('updates last_used_at on touchNetworkArtifactUsage', () => {
    const sha256 = 'f'.repeat(64);
    store.saveNetworkArtifact({
      sha256,
      artifactType: 'trajectory',
      content: Buffer.from('x'),
      source: 'origin',
      paidAmountUsdc: '0',
      fetchedAt: '2026-04-30T00:00:00.000Z',
    });
    store.touchNetworkArtifactUsage(sha256, '2026-04-30T00:01:00.000Z');
    const row = store.getNetworkArtifact(sha256);
    expect(row!.lastUsedAt).toBe('2026-04-30T00:01:00.000Z');
  });

  it('returns null for unknown sha256', () => {
    expect(store.getNetworkArtifact('e'.repeat(64))).toBeNull();
  });
});

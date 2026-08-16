import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Store } from '../../src/store/store.js';

describe('Store.served_artifacts', () => {
  let store: Store;
  beforeEach(() => { store = new Store(':memory:'); });
  afterEach(() => { store.close(); });

  it('saves and reads back a served artifact by sha256', () => {
    const sha256 = 'a'.repeat(64);
    const content = Buffer.from('hello world', 'utf-8');
    store.saveServedArtifact({
      sha256,
      artifactType: 'output.prediction.v0',
      requestId: '0x' + 'b'.repeat(64),
      content,
      priceUsdc: '0',
      createdAt: '2026-04-30T00:00:00.000Z',
    });

    const row = store.getServedArtifact(sha256);
    expect(row).not.toBeNull();
    expect(row!.sha256).toBe(sha256);
    expect(row!.artifactType).toBe('output.prediction.v0');
    expect(row!.content.equals(content)).toBe(true);
    expect(row!.contentSize).toBe(content.length);
    expect(row!.priceUsdc).toBe('0');
    expect(row!.envelopeCid).toBeNull();
  });

  it('returns null for unknown sha256', () => {
    expect(store.getServedArtifact('a'.repeat(64))).toBeNull();
  });

  it('backfills envelope_cid after publish', () => {
    const sha256 = 'c'.repeat(64);
    store.saveServedArtifact({
      sha256,
      artifactType: 'trajectory',
      content: Buffer.from('x'),
      priceUsdc: '0',
      createdAt: '2026-04-30T00:00:00.000Z',
    });
    store.setServedArtifactEnvelopeCid(sha256, 'bafyEnvelope1');
    const row = store.getServedArtifact(sha256);
    expect(row!.envelopeCid).toBe('bafyEnvelope1');
  });

  it('lists served_artifacts by requestId', () => {
    const reqId = '0x' + 'd'.repeat(64);
    for (let i = 0; i < 3; i++) {
      store.saveServedArtifact({
        sha256: String(i).padStart(64, '0'),
        artifactType: 'output.prediction.v0',
        requestId: reqId,
        content: Buffer.from(String(i)),
        priceUsdc: '0',
        createdAt: '2026-04-30T00:00:00.000Z',
      });
    }
    const rows = store.getServedArtifactsByRequestId(reqId);
    expect(rows).toHaveLength(3);
  });
});

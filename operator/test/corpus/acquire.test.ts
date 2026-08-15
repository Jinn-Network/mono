import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Store } from '../../src/store/store.js';
import { acquireArtifactContent } from '../../src/corpus/acquire.js';

const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

describe('acquireArtifactContent', () => {
  let store: Store;
  const access = { endpoint: 'https://op.example.com', priceUsdc: '0.001' };
  const realBytes = Buffer.from('hello-test', 'utf-8');

  beforeEach(() => {
    store = new Store(':memory:');
  });

  afterEach(() => store.close());

  it('cache fast path returns cached bytes without network call', async () => {
    const now = '2026-04-30T00:00:00.000Z';
    const realSha = (await import('node:crypto')).createHash('sha256').update(realBytes).digest('hex');
    store.saveNetworkArtifact({
      sha256: realSha,
      artifactType: 'design_document',
      content: realBytes,
      source: 'origin',
      paidAmountUsdc: '0',
      fetchedAt: now,
    });

    const acquireFn = vi.fn();
    const result = await acquireArtifactContent({
      sha256: realSha,
      artifactType: 'design_document',
      access,
      store,
      selfSafeAddress: '0x' + 'f'.repeat(40),
      privateKey: TEST_KEY,
      acquireFn,
    });
    expect(result.source).toBe('cache');
    expect(result.bytes.equals(realBytes)).toBe(true);
    expect(acquireFn).not.toHaveBeenCalled();
  });

  it('self-store fast path serves and mirrors to cache', async () => {
    const realSha = (await import('node:crypto')).createHash('sha256').update(realBytes).digest('hex');
    store.saveServedArtifact({
      sha256: realSha,
      artifactType: 'design_document',
      content: realBytes,
      priceUsdc: '0',
      createdAt: '2026-04-30T00:00:00.000Z',
    });
    const acquireFn = vi.fn();
    const result = await acquireArtifactContent({
      sha256: realSha,
      artifactType: 'design_document',
      access,
      store,
      selfSafeAddress: '0x' + 'f'.repeat(40),
      privateKey: TEST_KEY,
      acquireFn,
      ownerSafe: '0x' + 'f'.repeat(40),
    });
    expect(result.source).toBe('self-store');
    expect(result.paidAmountUsdc).toBe('0');
    expect(acquireFn).not.toHaveBeenCalled();
  });

  it('origin fetch hash-verifies and caches', async () => {
    const realSha = (await import('node:crypto')).createHash('sha256').update(realBytes).digest('hex');
    const acquireFn = vi.fn(async () => realBytes);

    const result = await acquireArtifactContent({
      sha256: realSha,
      artifactType: 'design_document',
      access,
      store,
      selfSafeAddress: '0x' + 'f'.repeat(40),
      privateKey: TEST_KEY,
      acquireFn,
      ownerSafe: '0x' + 'a'.repeat(40),
    });
    expect(result.source).toBe('origin');
    expect(result.paidAmountUsdc).toBe('0.001');
    expect(acquireFn).toHaveBeenCalledOnce();
    expect(store.getNetworkArtifact(realSha)).not.toBeNull();
  });

  it('prefers donated IPFS source and caches verified bytes without origin fetch', async () => {
    const realSha = (await import('node:crypto')).createHash('sha256').update(realBytes).digest('hex');
    const acquireFn = vi.fn();
    const fetchFromIpfs = vi.fn(async () => ({
      schemaVersion: 'jinn.artifact.donation.v1',
      artifactType: 'design_document',
      sha256: realSha,
      encoding: 'jinn.artifact.donation.v1',
      data: realBytes.toString('base64'),
    }));

    const result = await acquireArtifactContent({
      sha256: realSha,
      artifactType: 'design_document',
      access,
      store,
      selfSafeAddress: '0x' + 'f'.repeat(40),
      privateKey: TEST_KEY,
      acquireFn,
      fetchFromIpfs,
      ipfsGatewayUrl: 'https://gateway.example.com',
      ownerSafe: '0x' + 'a'.repeat(40),
      sources: [{
        kind: 'ipfs',
        cid: 'bafy-donated',
        sha256: realSha,
        encoding: 'jinn.artifact.donation.v1',
      }],
    });

    expect(result.source).toBe('ipfs');
    expect(result.paidAmountUsdc).toBe('0');
    expect(result.bytes.equals(realBytes)).toBe(true);
    expect(fetchFromIpfs).toHaveBeenCalledWith('https://gateway.example.com', 'bafy-donated');
    expect(acquireFn).not.toHaveBeenCalled();
    expect(store.getNetworkArtifact(realSha)?.content.equals(realBytes)).toBe(true);
  });

  it('falls back to origin when donated IPFS source fails', async () => {
    const realSha = (await import('node:crypto')).createHash('sha256').update(realBytes).digest('hex');
    const acquireFn = vi.fn(async () => realBytes);
    const fetchFromIpfs = vi.fn(async () => {
      throw new Error('gateway timeout');
    });

    const result = await acquireArtifactContent({
      sha256: realSha,
      artifactType: 'design_document',
      access,
      store,
      selfSafeAddress: '0x' + 'f'.repeat(40),
      privateKey: TEST_KEY,
      acquireFn,
      fetchFromIpfs,
      ipfsGatewayUrl: 'https://gateway.example.com',
      ownerSafe: '0x' + 'a'.repeat(40),
      sources: [{
        kind: 'ipfs',
        cid: 'bafy-donated',
        sha256: realSha,
        encoding: 'jinn.artifact.donation.v1',
      }],
    });

    expect(result.source).toBe('origin');
    expect(result.paidAmountUsdc).toBe('0.001');
    expect(result.bytes.equals(realBytes)).toBe(true);
    expect(fetchFromIpfs).toHaveBeenCalledWith('https://gateway.example.com', 'bafy-donated');
    expect(acquireFn).toHaveBeenCalledOnce();
    expect(store.getNetworkArtifact(realSha)?.content.equals(realBytes)).toBe(true);
  });

  it('treats donated IPFS sha mismatch as fatal and does not cache', async () => {
    const declaredSha = (await import('node:crypto')).createHash('sha256').update(realBytes).digest('hex');
    const wrongBytes = Buffer.from('wrong donated bytes');
    const acquireFn = vi.fn(async () => realBytes);
    const fetchFromIpfs = vi.fn(async () => ({
      schemaVersion: 'jinn.artifact.donation.v1',
      sha256: declaredSha,
      encoding: 'jinn.artifact.donation.v1',
      data: wrongBytes.toString('base64'),
    }));

    await expect(
      acquireArtifactContent({
        sha256: declaredSha,
        artifactType: 'design_document',
        access,
        store,
        selfSafeAddress: '0x' + 'f'.repeat(40),
        privateKey: TEST_KEY,
        acquireFn,
        fetchFromIpfs,
        ipfsGatewayUrl: 'https://gateway.example.com',
        ownerSafe: '0x' + 'a'.repeat(40),
        sources: [{
          kind: 'ipfs',
          cid: 'bafy-donated',
          sha256: declaredSha,
          encoding: 'jinn.artifact.donation.v1',
        }],
      }),
    ).rejects.toThrow(/HashMismatch|hash mismatch/);
    expect(acquireFn).not.toHaveBeenCalled();
    expect(store.getNetworkArtifact(declaredSha)).toBeNull();
  });

  it('surfaces a free-fetch AcquireResult not_found as AcquireError', async () => {
    const declaredSha = 'b'.repeat(64);
    // Fake returns the discriminated AcquireResult shape (ok:false) rather
    // than Buffer | null, exercising the free-fetch union branch.
    const acquireFn = vi.fn(async () => ({ ok: false as const, reason: 'not_found' as const, message: 'HTTP 404' }));
    await expect(
      acquireArtifactContent({
        sha256: declaredSha,
        artifactType: 'design_document',
        access,
        store,
        selfSafeAddress: '0x' + 'f'.repeat(40),
        privateKey: TEST_KEY,
        acquireFn,
        ownerSafe: '0x' + 'a'.repeat(40),
      }),
    ).rejects.toThrow(/not_found/);
    expect(store.getNetworkArtifact(declaredSha)).toBeNull();
  });

  it('origin fetch with hash mismatch throws and does not cache', async () => {
    const acquireFn = vi.fn(async () => Buffer.from('wrong bytes'));
    const declaredSha = 'a'.repeat(64);
    await expect(
      acquireArtifactContent({
        sha256: declaredSha,
        artifactType: 'design_document',
        access,
        store,
        selfSafeAddress: '0x' + 'f'.repeat(40),
        privateKey: TEST_KEY,
        acquireFn,
        ownerSafe: '0x' + 'a'.repeat(40),
      }),
    ).rejects.toThrow(/HashMismatch|hash mismatch/);
    expect(store.getNetworkArtifact(declaredSha)).toBeNull();
  });

  it('self-store re-verifies sha256 and refuses to mirror corrupt bytes', async () => {
    // Simulate cache-poisoning: served_artifacts row claims sha256=declaredSha
    // but actually contains wrong bytes. The self-store fast path must NOT
    // copy them into network_artifacts where peers could fetch them.
    const declaredSha = 'a'.repeat(64);
    const wrongBytes = Buffer.from('not what was promised');
    const selfSafe = '0x' + 'f'.repeat(40);

    // Direct-write into the DB so we can inject a row whose sha256 doesn't
    // match its bytes (saveServedArtifact would compute the hash for us;
    // we want to bypass that to mimic a corrupted row on disk).
    const fakeStore = {
      getNetworkArtifact: () => null,
      getServedArtifact: () => ({
        sha256: declaredSha,
        artifactType: 'design_document',
        envelopeCid: null,
        content: wrongBytes,
        priceUsdc: '0',
        createdAt: '2026-04-30T00:00:00.000Z',
      }),
      saveNetworkArtifact: vi.fn(),
      touchNetworkArtifactUsage: vi.fn(),
    } as unknown as Store;

    const acquireFn = vi.fn();
    await expect(
      acquireArtifactContent({
        sha256: declaredSha,
        artifactType: 'design_document',
        access,
        store: fakeStore,
        selfSafeAddress: selfSafe,
        privateKey: TEST_KEY,
        acquireFn,
        ownerSafe: selfSafe,
      }),
    ).rejects.toThrow(/HashMismatch|hash mismatch/);
    // Critical: the corrupt bytes must not have been written to the
    // peer-serving network_artifacts cache.
    expect(fakeStore.saveNetworkArtifact).not.toHaveBeenCalled();
    // We never fell through to origin either.
    expect(acquireFn).not.toHaveBeenCalled();
  });
});

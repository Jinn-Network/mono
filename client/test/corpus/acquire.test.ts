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
});

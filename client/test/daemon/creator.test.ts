import { describe, it, expect, vi } from 'vitest';
import { CreatorLoop } from '../../src/daemon/creator.js';
import { LocalAdapter } from '../../src/adapters/local/adapter.js';
import { GeneratedIntentSource, StaticConfiguredIntentSource } from '../../src/intents/sources.js';
import { Store } from '../../src/store/store.js';
import { PermanentError, type RestorationJob } from '../../src/types/index.js';

const SAFE = '0x00112233445566778899aabbccddeeff00112233';

describe('CreatorLoop', () => {
  it('posts desired states with type and attemptId', async () => {
    const adapter = new LocalAdapter();
    await adapter.initialize();
    const store = new Store(':memory:');

    const states: RestorationJob[] = [
      { id: 'ds-1', description: 'API returns 200' },
    ];

    const postSpy = vi.spyOn(adapter, 'postRestorationJob');
    const loop = new CreatorLoop(adapter, [new StaticConfiguredIntentSource(states)], store);

    await loop.tick();

    expect(postSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'ds-1',
        description: 'API returns 200',
        type: 'restoration',
        attemptId: 'ds-1/1',
        attemptNumber: 1,
      }),
    );
    store.close();
    await adapter.stop();
  });

  it('does not re-post already posted desired states', async () => {
    const adapter = new LocalAdapter();
    await adapter.initialize();
    const store = new Store(':memory:');

    const states: RestorationJob[] = [
      { id: 'ds-1', description: 'API returns 200' },
    ];

    const postSpy = vi.spyOn(adapter, 'postRestorationJob');
    const loop = new CreatorLoop(adapter, [new StaticConfiguredIntentSource(states)], store);

    await loop.tick();
    await loop.tick();

    expect(postSpy).toHaveBeenCalledTimes(1);
    store.close();
    await adapter.stop();
  });

  it('calls intent generators each tick and posts their results', async () => {
    const adapter = new LocalAdapter();
    await adapter.initialize();
    const store = new Store(':memory:');

    const generated: RestorationJob = {
      id: 'auto-1',
      description: 'auto-generated',
      window: { startTs: 0, endTs: 3_600_000 },
    };
    const generator = vi.fn(async () => generated);

    const postSpy = vi.spyOn(adapter, 'postRestorationJob');
    const loop = new CreatorLoop(
      adapter,
      [new GeneratedIntentSource('generated:prediction.v0', generator)],
      store,
    );

    await loop.tick();
    expect(generator).toHaveBeenCalledTimes(1);
    expect(postSpy).toHaveBeenCalledWith(expect.objectContaining({ id: 'auto-1', type: 'restoration' }));

    store.close();
    await adapter.stop();
  });

  it('skips null generator returns silently', async () => {
    const adapter = new LocalAdapter();
    await adapter.initialize();
    const store = new Store(':memory:');

    const generator = vi.fn(async () => null);
    const postSpy = vi.spyOn(adapter, 'postRestorationJob');
    const loop = new CreatorLoop(
      adapter,
      [new GeneratedIntentSource('generated:prediction.v0', generator)],
      store,
    );

    await loop.tick();
    expect(generator).toHaveBeenCalledTimes(1);
    expect(postSpy).not.toHaveBeenCalled();

    store.close();
    await adapter.stop();
  });

  it('SQLite idempotency survives simulated daemon restart (shared store)', async () => {
    const adapter = new LocalAdapter();
    await adapter.initialize();
    const store = new Store(':memory:');

    const states: RestorationJob[] = [{ id: 'ds-restart', description: 'survives restart' }];

    const postSpy = vi.spyOn(adapter, 'postRestorationJob');

    // First loop instance posts.
    const source = new StaticConfiguredIntentSource(states);
    const loop1 = new CreatorLoop(adapter, [source], store, SAFE);
    await loop1.tick();
    expect(postSpy).toHaveBeenCalledTimes(1);

    // New loop instance (fresh in-memory Map) reusing the same store.
    const loop2 = new CreatorLoop(adapter, [source], store, SAFE);
    await loop2.tick();
    expect(postSpy).toHaveBeenCalledTimes(1); // no double-post

    store.close();
    await adapter.stop();
  });

  it('generator errors are caught; next tick retries', async () => {
    const adapter = new LocalAdapter();
    await adapter.initialize();
    const store = new Store(':memory:');

    let attempts = 0;
    const generator = vi.fn(async () => {
      attempts++;
      if (attempts === 1) throw new Error('transient read failure');
      return { id: 'auto-retry', description: 'after retry' } as RestorationJob;
    });

    const postSpy = vi.spyOn(adapter, 'postRestorationJob');
    const loop = new CreatorLoop(
      adapter,
      [new GeneratedIntentSource('generated:prediction.v0', generator)],
      store,
    );

    await loop.tick(); // generator throws; no post
    expect(postSpy).not.toHaveBeenCalled();

    await loop.tick(); // generator succeeds; posts
    expect(postSpy).toHaveBeenCalledTimes(1);

    store.close();
    await adapter.stop();
  });

  it('backs off permanent create failures for the same intent', async () => {
    const adapter = new LocalAdapter();
    await adapter.initialize();
    const store = new Store(':memory:');

    const states: RestorationJob[] = [{ id: 'gated', description: 'router-gated' }];
    const postSpy = vi
      .spyOn(adapter, 'postRestorationJob')
      .mockRejectedValue(new PermanentError('No request IDs returned from router'));
    const loop = new CreatorLoop(adapter, [new StaticConfiguredIntentSource(states)], store, SAFE);

    await expect(loop.tick()).rejects.toThrow(/No request IDs/);
    await loop.tick();

    expect(postSpy).toHaveBeenCalledTimes(1);
    store.close();
    await adapter.stop();
  });

  it('posts generated intents once per bucket and again in a new bucket', async () => {
    const adapter = new LocalAdapter();
    await adapter.initialize();
    const store = new Store(':memory:');

    let bucketStart = 0;
    const generator = vi.fn(async () => ({
      id: `auto-${bucketStart}`,
      description: 'bucketed',
      window: { startTs: bucketStart, endTs: bucketStart + 600_000 },
    } satisfies RestorationJob));

    const postSpy = vi.spyOn(adapter, 'postRestorationJob');
    const loop = new CreatorLoop(
      adapter,
      [new GeneratedIntentSource('generated:prediction.v0', generator)],
      store,
      SAFE,
    );

    await loop.tick();
    await loop.tick();
    expect(postSpy).toHaveBeenCalledTimes(1);

    bucketStart = 600_000;
    await loop.tick();
    expect(postSpy).toHaveBeenCalledTimes(2);

    store.close();
    await adapter.stop();
  });
});

import { describe, it, expect, vi } from 'vitest';
import { CreatorLoop } from '../../src/daemon/creator.js';
import { LocalAdapter } from '../../src/adapters/local/adapter.js';
import { Store } from '../../src/store/store.js';
import type { DesiredState } from '../../src/types/index.js';

describe('CreatorLoop', () => {
  it('posts desired states with type and attemptId', async () => {
    const adapter = new LocalAdapter();
    await adapter.initialize();
    const store = new Store(':memory:');

    const states: DesiredState[] = [
      { id: 'ds-1', description: 'API returns 200' },
    ];

    const postSpy = vi.spyOn(adapter, 'postDesiredState');
    const loop = new CreatorLoop(adapter, states, store);

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

    const states: DesiredState[] = [
      { id: 'ds-1', description: 'API returns 200' },
    ];

    const postSpy = vi.spyOn(adapter, 'postDesiredState');
    const loop = new CreatorLoop(adapter, states, store);

    await loop.tick();
    await loop.tick();

    expect(postSpy).toHaveBeenCalledTimes(1);
    store.close();
    await adapter.stop();
  });
});

import { describe, it, expect } from 'vitest';
import { RestorerLoop } from '../../src/daemon/restorer.js';
import { LocalAdapter } from '../../src/adapters/local/adapter.js';
import { SimpleRunner } from '../../src/runner/simple.js';
import { Store } from '../../src/store/store.js';

describe('RestorerLoop', () => {
  it('claims a request, runs restoration, and submits result', async () => {
    const adapter = new LocalAdapter();
    await adapter.initialize();

    const runner = new SimpleRunner(async (desc) => `Done: ${desc}`);
    const store = new Store(':memory:');

    const restorer = new RestorerLoop(adapter, runner, store);

    await adapter.postDesiredState({ id: 'ds-1', description: 'Fix the thing' });

    const processed = await restorer.processOne();
    expect(processed).toBe(true);

    const deliveries: unknown[] = [];
    for await (const d of adapter.watchForDeliveries()) {
      deliveries.push(d);
      break;
    }
    expect(deliveries).toHaveLength(1);

    store.close();
    await adapter.stop();
  });
});

import { describe, it, expect } from 'vitest';
import { LocalAdapter } from '../../src/adapters/local/adapter.js';
import { SimpleRunner } from '../../src/runner/simple.js';
import { Store } from '../../src/store/store.js';
import { CreatorLoop } from '../../src/daemon/creator.js';
import { RestorerLoop } from '../../src/daemon/restorer.js';

describe('End-to-end local loop', () => {
  it('runs the full create → restore → evaluate cycle with linked requests', async () => {
    const adapter = new LocalAdapter();
    await adapter.initialize();

    const store = new Store(':memory:');

    // Creator posts a desired state (creates restoration + evaluation requests)
    const creator = new CreatorLoop(adapter, [
      { id: 'ds-1', description: 'The service should be healthy' },
    ], store);
    await creator.tick();

    // Restorer picks up and processes the restoration request
    const runner = new SimpleRunner(async (desc) => `Restored: ${desc}`);
    const restorer = new RestorerLoop(adapter, runner, store);
    await restorer.processOne();

    // After restoration delivery, the evaluation request becomes available
    // Restorer picks up and processes the evaluation request
    await restorer.processOne();

    store.close();
    await adapter.stop();
  });
});

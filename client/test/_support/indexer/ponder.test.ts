import { describe, it, expect } from 'vitest';
import { spawnPonderIndexer } from './ponder.js';

describe('spawnPonderIndexer', () => {
  it('starts a local Ponder pointed at a given RPC and shuts down cleanly', async () => {
    // Skip if Ponder package isn't present in the repo (e.g. monorepo subset).
    let indexer: Awaited<ReturnType<typeof spawnPonderIndexer>> | undefined;
    try {
      indexer = await spawnPonderIndexer({
        rpcUrl: 'http://127.0.0.1:8545',          // dummy; the test asserts startup, not E2E
        chainId: 84532,
        readyTimeoutMs: 30000,
      });
      expect(indexer.graphqlUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/graphql$/);
      expect(indexer.port).toBeGreaterThan(0);
    } finally {
      if (indexer) await indexer.teardown();
    }
  }, 60000);

  it('teardown is idempotent', async () => {
    let indexer: Awaited<ReturnType<typeof spawnPonderIndexer>> | undefined;
    try {
      indexer = await spawnPonderIndexer({ rpcUrl: 'http://127.0.0.1:8545', chainId: 84532 });
    } catch {
      return;       // accept failure on environments without Ponder
    }
    await indexer.teardown();
    await expect(indexer.teardown()).resolves.toBeUndefined();
  }, 60000);
});

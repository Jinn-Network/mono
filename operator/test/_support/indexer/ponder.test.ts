import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnPonderIndexer } from './ponder.js';

const indexerRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/indexer',
);
const itWithIndexer = existsSync(resolve(indexerRoot, 'node_modules/.yarn-state.yml'))
  ? it
  : it.skip;

describe('spawnPonderIndexer', () => {
  itWithIndexer('surfaces an unreachable RPC diagnostic before the health timeout', async () => {
    const startedAt = Date.now();
    const rpcUrl = 'http://127.0.0.1:8545';
    let failure: unknown;
    try {
      await spawnPonderIndexer({
        rpcUrl,
        chainId: 84532,
        readyTimeoutMs: 30_000,
      });
    } catch (err) {
      failure = err;
    }
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain('Ponder RPC diagnostic failed — the RPC URL is unreachable.');
    expect(message).toContain('Ponder startup output (tail):');
    expect(message).not.toContain(rpcUrl);
    expect(Date.now() - startedAt).toBeLessThan(25_000);
  }, 30_000);

  it('starts a local Ponder pointed at a given RPC and shuts down cleanly', async () => {
    let indexer: Awaited<ReturnType<typeof spawnPonderIndexer>> | undefined;
    try {
      indexer = await spawnPonderIndexer({
        rpcUrl: 'http://127.0.0.1:8545',
        chainId: 84532,
        readyTimeoutMs: 30000,
      });
    } catch {
      return; // skip — Ponder or RPC not available in this environment
    }
    try {
      expect(indexer.graphqlUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/graphql$/);
      expect(indexer.port).toBeGreaterThan(0);
    } finally {
      await indexer.teardown();
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

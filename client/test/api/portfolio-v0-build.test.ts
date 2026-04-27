import { describe, expect, it } from 'vitest';
import { withTempStore } from '@test/store.js';
import { IntentPersistence } from '../../src/restorer/engine/persistence.js';
import { gatherPortfolioV0Status } from '../../src/api/portfolio-v0-build.js';

function seedIntent(
  persistence: IntentPersistence,
  requestId: string,
  windowStartTs = Date.now(),
  windowEndTs = Date.now() + 3600_000,
) {
  persistence.insertDiscovered({
    requestId,
    intentCid: `bafytest${requestId}`,
    onchainCreationTx: `0xtx${requestId}`,
    onchainCreationBlock: 1,
    specKind: 'portfolio.v0',
    windowStartTs,
    windowEndTs,
    desiredState: { id: requestId, description: 'test' },
  });
}

describe('gatherPortfolioV0Status', () => {
  it('returns empty lists when no intents exist', async () => {
    await withTempStore(async (store) => {
      const result = gatherPortfolioV0Status(store);
      expect(result.inFlight).toEqual([]);
      expect(result.recentVerdicts).toEqual([]);
      expect(result.recentSnapshots).toEqual([]);
    });
  });

  it('lists in-flight intents in DISCOVERED state', async () => {
    await withTempStore(async (store) => {
      const persistence = new IntentPersistence(store.db);
      seedIntent(persistence, 'req-1');
      seedIntent(persistence, 'req-2');

      const result = gatherPortfolioV0Status(store);
      expect(result.inFlight).toHaveLength(2);
      expect(result.inFlight.map((i) => i.requestId)).toContain('req-1');
      expect(result.inFlight.map((i) => i.requestId)).toContain('req-2');
      expect(result.inFlight[0].state).toBe('DISCOVERED');
      expect(result.inFlight[0].lastError).toBeNull();
    });
  });

  it('moves intent to recentVerdicts once FAILED', async () => {
    await withTempStore(async (store) => {
      const persistence = new IntentPersistence(store.db);
      seedIntent(persistence, 'req-fail');
      persistence.markFailed('req-fail', 'test failure reason');

      const result = gatherPortfolioV0Status(store);
      expect(result.inFlight).toHaveLength(0);
      expect(result.recentVerdicts).toHaveLength(1);
      expect(result.recentVerdicts[0].requestId).toBe('req-fail');
      expect(result.recentVerdicts[0].state).toBe('FAILED');
      expect(result.recentVerdicts[0].failureReason).toBe('test failure reason');
    });
  });

  it('includes specKind and implName in in-flight summaries', async () => {
    await withTempStore(async (store) => {
      const persistence = new IntentPersistence(store.db);
      seedIntent(persistence, 'req-spec');

      const result = gatherPortfolioV0Status(store);
      expect(result.inFlight[0].specKind).toBe('portfolio.v0');
      expect(result.inFlight[0].implName).toBeNull(); // not yet assigned
    });
  });

  it('returns recentSnapshots from system_snapshot-tagged artifacts', async () => {
    await withTempStore(async (store) => {
      store.insertArtifact({
        id: 'snap-1',
        desiredStateId: 'ds-1',
        requestId: 'req-snap',
        title: 'System Snapshot 1',
        content: '{"equity":100}',
        tags: ['system_snapshot', 'portfolio.v0'],
        outcome: 'SUCCESS',
      });
      store.insertArtifact({
        id: 'not-a-snap',
        desiredStateId: 'ds-2',
        requestId: 'req-other',
        title: 'Not a snapshot',
        content: 'stuff',
        tags: ['other'],
        outcome: 'SUCCESS',
      });

      const result = gatherPortfolioV0Status(store);
      expect(result.recentSnapshots).toHaveLength(1);
      expect(result.recentSnapshots[0].id).toBe('snap-1');
      expect(result.recentSnapshots[0].requestId).toBe('req-snap');
      expect(result.recentSnapshots[0].title).toBe('System Snapshot 1');
    });
  });
});

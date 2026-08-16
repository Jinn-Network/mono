import { describe, expect, it } from 'vitest';
import { withTempStore } from '@test/store.js';
import { gatherPortfolioV0Status } from '../../src/api/portfolio-v0-build.js';
import type { Store } from '../../src/store/store.js';
import { markNativeFailed, patchNativeRun, seedNativeRun } from '@test/seed-native-run.js';

function seedIntent(
  store: Store,
  requestId: string,
  windowStartTs = Date.now(),
  windowEndTs = Date.now() + 3600_000,
) {
  seedNativeRun(store, {
    requestId,
    taskCid: `bafytest${requestId}`,
    solverType: 'portfolio.v0',
    windowStartTs,
    windowEndTs,
    task: { id: requestId, description: 'test' },
  });
}

describe('gatherPortfolioV0Status', () => {
  it('returns empty lists when no tasks exist', async () => {
    await withTempStore(async (store) => {
      const result = gatherPortfolioV0Status(store.taskRunReadModel(), store);
      expect(result.inFlight).toEqual([]);
      expect(result.recentVerdicts).toEqual([]);
      expect(result.recentSnapshots).toEqual([]);
    });
  });

  it('lists in-flight tasks in DISCOVERED state', async () => {
    await withTempStore(async (store) => {
      seedIntent(store, 'req-1');
      seedIntent(store, 'req-2');

      const result = gatherPortfolioV0Status(store.taskRunReadModel(), store);
      expect(result.inFlight).toHaveLength(2);
      expect(result.inFlight.map((i) => i.requestId)).toContain('req-1');
      expect(result.inFlight.map((i) => i.requestId)).toContain('req-2');
      expect(result.inFlight[0].state).toBe('DISCOVERED');
      expect(result.inFlight[0].lastError).toBeNull();
    });
  });

  it('moves task to recentVerdicts once FAILED', async () => {
    await withTempStore(async (store) => {
      seedIntent(store, 'req-fail');
      markNativeFailed(store, 'req-fail', 'test failure reason');

      const result = gatherPortfolioV0Status(store.taskRunReadModel(), store);
      expect(result.inFlight).toHaveLength(0);
      expect(result.recentVerdicts).toHaveLength(1);
      expect(result.recentVerdicts[0].requestId).toBe('req-fail');
      expect(result.recentVerdicts[0].state).toBe('FAILED');
      expect(result.recentVerdicts[0].failureReason).toBe('test failure reason');
    });
  });

  it('splits FAILED runs into settled fails and local errors via delivery_tx_hash', async () => {
    await withTempStore(async (store) => {
      seedIntent(store, 'req-local-error');
      seedIntent(store, 'req-settled-fail');
      markNativeFailed(store, 'req-local-error', 'SkippableError');
      markNativeFailed(store, 'req-settled-fail', 'claimDelivery reverted');
      patchNativeRun(store, 'req-settled-fail', { deliveryTxHash: '0xdeadbeef' });

      const result = gatherPortfolioV0Status(store.taskRunReadModel(), store);
      expect(result.totals.failed).toBe(2);
      expect(result.totals.settledFailed).toBe(1);
      expect(result.totals.localErrors).toBe(1);
    });
  });

  it('scopes totals and lists to solverType=portfolio.v0 — other solvers do not leak', async () => {
    await withTempStore(async (store) => {
      seedIntent(store, 'pv0-failed');
      markNativeFailed(store, 'pv0-failed', 'portfolio failure');
      seedIntent(store, 'pv0-delivered');
      patchNativeRun(store, 'pv0-delivered', { state: 'COMPLETE' });
      seedIntent(store, 'pv0-running');
      patchNativeRun(store, 'pv0-running', { state: 'RUNNING' });

      seedNativeRun(store, {
        requestId: 'pred-failed',
        taskCid: 'bafy-pred-failed',
        solverType: 'prediction.v1',
        windowStartTs: 1_000,
        windowEndTs: 2_000,
        task: { id: 'pred-failed', description: 'prediction task', solverType: 'prediction.v1' },
      });
      markNativeFailed(store, 'pred-failed', 'prediction failure');
      patchNativeRun(store, 'pred-failed', { deliveryTxHash: '0xpredfail' });

      seedNativeRun(store, {
        requestId: 'swe-failed',
        taskCid: 'bafy-swe-failed',
        solverType: 'swe-rebench-v2.v1',
        windowStartTs: 1_000,
        windowEndTs: 2_000,
        task: { id: 'swe-failed', description: 'swe task', solverType: 'swe-rebench-v2.v1' },
      });
      markNativeFailed(store, 'swe-failed', 'swe failure');

      const result = gatherPortfolioV0Status(store.taskRunReadModel(), store);

      expect(result.totals.delivered).toBe(1);
      expect(result.totals.failed).toBe(1);
      expect(result.totals.settledFailed).toBe(0);
      expect(result.totals.localErrors).toBe(1);
      expect(result.totals.active).toBe(1);

      const inFlightIds = result.inFlight.map((row) => row.requestId);
      const verdictIds = result.recentVerdicts.map((row) => row.requestId);
      expect(inFlightIds).toContain('pv0-running');
      expect(inFlightIds).not.toContain('swe-failed');
      expect(verdictIds).toContain('pv0-failed');
      expect(verdictIds).not.toContain('pred-failed');
      expect(verdictIds).not.toContain('swe-failed');
    });
  });

  it('keeps portfolio rows when solver_type is missing but task_payload still identifies the net', async () => {
    await withTempStore(async (store) => {
      seedIntent(store, 'canonical-pv0');
      patchNativeRun(store, 'canonical-pv0', {
        solverType: null,
        task: {
          id: 'canonical-pv0',
          description: 'test',
          contractId: 'portfolio',
          contractVersion: 'v0',
        },
      });

      seedIntent(store, 'legacy-pv0');
      markNativeFailed(store, 'legacy-pv0', 'legacy failure');
      patchNativeRun(store, 'legacy-pv0', {
        solverType: null,
        task: {
          id: 'legacy-pv0',
          description: 'test',
          solverType: 'portfolio.v0',
        },
      });

      const result = gatherPortfolioV0Status(store.taskRunReadModel(), store);

      expect(result.totals.active).toBe(1);
      expect(result.totals.failed).toBe(1);
      expect(result.inFlight.map((row) => row.requestId)).toContain('canonical-pv0');
      expect(result.recentVerdicts.map((row) => row.requestId)).toContain('legacy-pv0');
    });
  });

  it('includes solverType and implName in in-flight summaries', async () => {
    await withTempStore(async (store) => {
      seedIntent(store, 'req-spec');

      const result = gatherPortfolioV0Status(store.taskRunReadModel(), store);
      expect(result.inFlight[0].solverType).toBe('portfolio.v0');
      expect(result.inFlight[0].implName).toBeNull();
    });
  });

  it('returns recentSnapshots from system_snapshot-tagged artifacts', async () => {
    await withTempStore(async (store) => {
      store.insertArtifact({
        id: 'snap-1',
        taskId: 'ds-1',
        requestId: 'req-snap',
        title: 'System Snapshot 1',
        content: '{"equity":100}',
        tags: ['system_snapshot', 'portfolio.v0'],
        outcome: 'SUCCESS',
      });
      store.insertArtifact({
        id: 'not-a-snap',
        taskId: 'ds-2',
        requestId: 'req-other',
        title: 'Not a snapshot',
        content: 'stuff',
        tags: ['other'],
        outcome: 'SUCCESS',
      });

      const result = gatherPortfolioV0Status(store.taskRunReadModel(), store);
      expect(result.recentSnapshots).toHaveLength(1);
      expect(result.recentSnapshots[0].id).toBe('snap-1');
      expect(result.recentSnapshots[0].requestId).toBe('req-snap');
      expect(result.recentSnapshots[0].title).toBe('System Snapshot 1');
    });
  });
});

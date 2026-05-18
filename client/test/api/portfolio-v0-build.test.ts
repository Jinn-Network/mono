import { describe, expect, it } from 'vitest';
import { withTempStore } from '@test/store.js';
import { TaskRunPersistence } from '../../src/harnesses/engine/persistence.js';
import { gatherPortfolioV0Status } from '../../src/api/portfolio-v0-build.js';

function seedIntent(
  persistence: TaskRunPersistence,
  requestId: string,
  windowStartTs = Date.now(),
  windowEndTs = Date.now() + 3600_000,
) {
  persistence.insertDiscovered({
    requestId,
    taskCid: `bafytest${requestId}`,
    onchainCreationTx: `0xtx${requestId}`,
    onchainCreationBlock: 1,
    solverType: 'portfolio.v0',
    windowStartTs,
    windowEndTs,
    task: { id: requestId, description: 'test' },
  });
}

describe('gatherPortfolioV0Status', () => {
  it('returns empty lists when no tasks exist', async () => {
    await withTempStore(async (store) => {
      const result = gatherPortfolioV0Status(store);
      expect(result.inFlight).toEqual([]);
      expect(result.recentVerdicts).toEqual([]);
      expect(result.recentSnapshots).toEqual([]);
    });
  });

  it('lists in-flight tasks in DISCOVERED state', async () => {
    await withTempStore(async (store) => {
      const persistence = new TaskRunPersistence(store.db);
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

  it('moves task to recentVerdicts once FAILED', async () => {
    await withTempStore(async (store) => {
      const persistence = new TaskRunPersistence(store.db);
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

  it('splits FAILED runs into settled fails and local errors via delivery_tx_hash', async () => {
    await withTempStore(async (store) => {
      const persistence = new TaskRunPersistence(store.db);
      seedIntent(persistence, 'req-local-error');
      seedIntent(persistence, 'req-settled-fail');
      persistence.markFailed('req-local-error', 'SkippableError');
      persistence.markFailed('req-settled-fail', 'claimDelivery reverted');
      store.db
        .prepare('UPDATE task_runs SET delivery_tx_hash = ? WHERE request_id = ?')
        .run('0xdeadbeef', 'req-settled-fail');

      const result = gatherPortfolioV0Status(store);
      expect(result.totals.failed).toBe(2);
      expect(result.totals.settledFailed).toBe(1);
      expect(result.totals.localErrors).toBe(1);
    });
  });

  it('scopes totals and lists to solverType=portfolio.v0 — other solvers do not leak', async () => {
    await withTempStore(async (store) => {
      const persistence = new TaskRunPersistence(store.db);
      // portfolio.v0 — should be counted.
      seedIntent(persistence, 'pv0-failed');
      persistence.markFailed('pv0-failed', 'portfolio failure');
      seedIntent(persistence, 'pv0-delivered');
      store.db.prepare(`UPDATE task_runs SET state = 'COMPLETE' WHERE request_id = ?`).run('pv0-delivered');
      seedIntent(persistence, 'pv0-running');
      store.db.prepare(`UPDATE task_runs SET state = 'RUNNING' WHERE request_id = ?`).run('pv0-running');

      // Foreign solverType — must NOT leak into portfolio.v0 counters.
      persistence.insertDiscovered({
        requestId: 'pred-failed',
        taskCid: 'bafy-pred-failed',
        onchainCreationTx: '0xpred',
        onchainCreationBlock: 1,
        solverType: 'prediction.v1',
        windowStartTs: 1_000,
        windowEndTs: 2_000,
        task: { id: 'pred-failed', description: 'prediction task', solverType: 'prediction.v1' },
      });
      persistence.markFailed('pred-failed', 'prediction failure');
      store.db
        .prepare('UPDATE task_runs SET delivery_tx_hash = ? WHERE request_id = ?')
        .run('0xpredfail', 'pred-failed');

      persistence.insertDiscovered({
        requestId: 'swe-failed',
        taskCid: 'bafy-swe-failed',
        onchainCreationTx: '0xswe',
        onchainCreationBlock: 1,
        solverType: 'swe-rebench-v2.v1',
        windowStartTs: 1_000,
        windowEndTs: 2_000,
        task: { id: 'swe-failed', description: 'swe task', solverType: 'swe-rebench-v2.v1' },
      });
      persistence.markFailed('swe-failed', 'swe failure');

      const result = gatherPortfolioV0Status(store);

      // Only portfolio.v0 rows are counted.
      expect(result.totals.delivered).toBe(1);
      expect(result.totals.failed).toBe(1);
      expect(result.totals.settledFailed).toBe(0);
      expect(result.totals.localErrors).toBe(1);
      expect(result.totals.active).toBe(1);

      // Foreign-solver requestIds must not appear in the surfaced lists.
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
      const persistence = new TaskRunPersistence(store.db);
      seedIntent(persistence, 'canonical-pv0');
      store.db.prepare(
        `UPDATE task_runs
         SET solver_type = NULL,
             task_payload = ?
         WHERE request_id = ?`,
      ).run(
        JSON.stringify({
          id: 'canonical-pv0',
          description: 'test',
          contractId: 'portfolio',
          contractVersion: 'v0',
        }),
        'canonical-pv0',
      );

      seedIntent(persistence, 'legacy-pv0');
      persistence.markFailed('legacy-pv0', 'legacy failure');
      store.db.prepare(
        `UPDATE task_runs
         SET solver_type = NULL,
             task_payload = ?
         WHERE request_id = ?`,
      ).run(
        JSON.stringify({
          id: 'legacy-pv0',
          description: 'test',
          solverType: 'portfolio.v0',
        }),
        'legacy-pv0',
      );

      const result = gatherPortfolioV0Status(store);

      expect(result.totals.active).toBe(1);
      expect(result.totals.failed).toBe(1);
      expect(result.inFlight.map((row) => row.requestId)).toContain('canonical-pv0');
      expect(result.recentVerdicts.map((row) => row.requestId)).toContain('legacy-pv0');
    });
  });

  it('includes solverType and implName in in-flight summaries', async () => {
    await withTempStore(async (store) => {
      const persistence = new TaskRunPersistence(store.db);
      seedIntent(persistence, 'req-spec');

      const result = gatherPortfolioV0Status(store);
      expect(result.inFlight[0].solverType).toBe('portfolio.v0');
      expect(result.inFlight[0].implName).toBeNull(); // not yet assigned
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

      const result = gatherPortfolioV0Status(store);
      expect(result.recentSnapshots).toHaveLength(1);
      expect(result.recentSnapshots[0].id).toBe('snap-1');
      expect(result.recentSnapshots[0].requestId).toBe('req-snap');
      expect(result.recentSnapshots[0].title).toBe('System Snapshot 1');
    });
  });
});

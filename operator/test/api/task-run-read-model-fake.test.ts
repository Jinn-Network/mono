import { describe, expect, it } from 'vitest';
import { withTempStore } from '@test/store.js';
import type { PersistedTaskRun, TaskRunState } from '../../src/types/task-run.js';
import type { TaskRunReadModel } from '../../src/types/task-run-read-model.js';
import { gatherTaskRunsStatus } from '../../src/api/task-runs-build.js';
import { gatherPredictionV1Status } from '../../src/api/prediction-v1-build.js';
import { gatherPortfolioV0Status } from '../../src/api/portfolio-v0-build.js';
import { gatherLoopCompletion } from '../../src/api/loop-completion-build.js';

/**
 * #1584 — proves the four build fns depend on the neutral `TaskRunReadModel`
 * port, not on a concrete persistence class. Each fn is
 * driven against a hand-rolled fake with no database behind it.
 */

function makeRun(overrides: Partial<PersistedTaskRun> & { requestId: string; state: TaskRunState }): PersistedTaskRun {
  return {
    requestId: overrides.requestId,
    taskId: overrides.taskId ?? null,
    attemptIndex: null,
    taskCid: 'cid',
    onchainCreationTx: '0xtx',
    onchainCreationBlock: 1,
    solverType: overrides.solverType ?? null,
    solverNetManifestCid: null,
    taskRole: overrides.taskRole ?? null,
    implName: null,
    state: overrides.state,
    stateUpdatedAt: overrides.stateUpdatedAt ?? 0,
    workingDir: null,
    implStateDir: null,
    windowStartTs: 0,
    windowEndTs: 0,
    runStartedAt: null,
    preSnapshotCapturedAt: null,
    preSnapshotPayload: null,
    postSnapshotCapturedAt: null,
    postSnapshotPayload: null,
    fillsPayload: null,
    gatingClaim: null,
    informationalClaim: null,
    artifactCids: null,
    manifestCid: null,
    deliveryTxHash: overrides.deliveryTxHash ?? null,
    manifestGeneratedAt: null,
    evidenceHash: null,
    task: null,
    solutionOutputsJson: null,
    runtimePluginsJson: null,
    executorMode: null,
    executorCodeDigest: null,
    failureReason: null,
    failureAt: null,
  };
}

/** In-memory fake with no SQLite behind it. */
class FakeReadModel implements TaskRunReadModel {
  constructor(
    private readonly rows: PersistedTaskRun[],
    private readonly gating: Array<{ phasesJson: string | null; deliveredTxHash: string | null }> = [],
  ) {}
  getInFlight(): PersistedTaskRun[] {
    return this.rows.filter((r) => !['COMPLETE', 'FAILED', 'RACE_LOST'].includes(r.state));
  }
  getByState(state: TaskRunState): PersistedTaskRun[] {
    return this.rows.filter((r) => r.state === state);
  }
  getGatingRows(): Array<{ phasesJson: string | null; deliveredTxHash: string | null }> {
    return this.gating;
  }
}

describe('build fns depend on TaskRunReadModel port (#1584)', () => {
  it('gatherTaskRunsStatus reads counts off the fake port', () => {
    const fake = new FakeReadModel([
      makeRun({ requestId: 'r1', state: 'RUNNING', taskRole: 'restoration' }),
      makeRun({ requestId: 'r2', state: 'COMPLETE', taskRole: 'restoration' }),
      makeRun({ requestId: 'r3', state: 'COMPLETE', taskRole: 'evaluation' }),
      makeRun({ requestId: 'r4', state: 'FAILED', taskRole: 'evaluation' }),
    ]);
    const status = gatherTaskRunsStatus(fake);
    expect(status.totals.activeTaskRuns).toBe(1);
    expect(status.totals.completed).toBe(2);
    expect(status.totals.solutions).toBe(1);
    expect(status.totals.verdicts).toBe(1);
    expect(status.totals.failed).toBe(1);
  });

  it('gatherPredictionV1Status reads prediction.v1 runs off the fake port', () => {
    const fake = new FakeReadModel([
      makeRun({ requestId: 'p1', state: 'RUNNING', solverType: 'prediction.v1', taskRole: 'restoration' }),
      makeRun({ requestId: 'p2', state: 'COMPLETE', solverType: 'prediction.v1', taskRole: 'restoration' }),
      makeRun({ requestId: 'other', state: 'COMPLETE', solverType: 'portfolio.v0', taskRole: 'restoration' }),
    ]);
    const status = gatherPredictionV1Status(fake);
    expect(status.totals.activeTaskRuns).toBe(1);
    expect(status.totals.solutions).toBe(1);
  });

  it('gatherPortfolioV0Status reads portfolio.v0 runs off the fake port', async () => {
    const fake = new FakeReadModel([
      makeRun({ requestId: 'v1', state: 'RUNNING', solverType: 'portfolio.v0', taskRole: 'restoration' }),
      makeRun({ requestId: 'v2', state: 'COMPLETE', solverType: 'portfolio.v0', taskRole: 'restoration' }),
    ]);
    await withTempStore(async (store) => {
      const status = gatherPortfolioV0Status(fake, store, '/nonexistent-working-dir');
      expect(status.totals.active).toBe(1);
      expect(status.totals.delivered).toBe(1);
    });
  });

  it('gatherLoopCompletion reads gating rows off the fake port', () => {
    const fake = new FakeReadModel([], [
      { phasesJson: JSON.stringify(['execute', 'improve']), deliveredTxHash: '0xabc' },
      { phasesJson: null, deliveredTxHash: null },
    ]);
    const status = gatherLoopCompletion(fake);
    expect(status.total).toBe(2);
    expect(status.delivered).toBe(1);
    expect(status.reachedExecute).toBe(1);
    expect(status.reachedImprove).toBe(1);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Hex } from 'viem';
import { Store } from '../../../src/store/store.js';
import {
  TaskEngine,
  type TaskEngineOptions,
} from '../../../src/harnesses/engine/engine.js';
import {
  TaskRunPersistence,
  type PersistedTaskRun,
  type PersistedTaskRunInput,
} from '../../../src/harnesses/engine/persistence.js';
import { TaskRunState } from '../../../src/harnesses/engine/state.js';
import { recoverInFlight } from '../../../src/harnesses/engine/recovery.js';
import { SafeInnerRevertError } from '../../../src/adapters/mech/safe-revert.js';
import { gatherTaskRunsStatus } from '../../../src/api/task-runs-build.js';

/**
 * Regression test for #896: pruned evaluation opportunities (terminal at
 * discovery time, e.g. another operator already filled the verdict slots)
 * surface as `SafeInnerRevertError` with a non-recoverable inner revert
 * (TCMaxVerdictsReached, TCAttemptAlreadyFinalized, ...). The dashboard
 * was counting these as FAILED runs alongside genuine operator failures,
 * inflating the failed counter on startup.
 *
 * Expected behaviour:
 *  - Race-loss prunes land in `RACE_LOST`, not `FAILED`.
 *  - Generic engine errors still land in `FAILED`.
 *  - A `race_lost` activity event is emitted so operators can audit prunes.
 *  - `gatherTaskRunsStatus(store).totals.failed` excludes pruned runs.
 *  - `gatherTaskRunsStatus(store).totals.raceLost` surfaces the prune count.
 */

function makeOpts(store: Store): TaskEngineOptions {
  return {
    store,
    paths: { workingDirRoot: '/tmp/work', implStateDirRoot: '/tmp/impl' },
  };
}

function makeInput(id: string, overrides: Partial<PersistedTaskRunInput> = {}): PersistedTaskRunInput {
  const now = Date.now();
  return {
    requestId: id,
    taskCid: `bafycid-${id}`,
    onchainCreationTx: '0xdeadbeef',
    onchainCreationBlock: 100,
    windowStartTs: now - 10_000,
    windowEndTs: now + 86_400_000,
    task: {
      id,
      description: 'test',
      solverType: overrides.solverType ?? 'swe-rebench-v2.v1',
      role: overrides.taskRole ?? 'evaluation',
    },
    ...overrides,
  };
}

function raceLossRevert(name: string): SafeInnerRevertError {
  return new SafeInnerRevertError(
    `Safe execTransaction inner revert (estimate): ${name}()`,
    '0x00000000' as Hex,
    null,
    name,
    [],
    null,
  );
}

/**
 * Engine subclass that lets the test inject the error a given transition
 * should throw. Records which transition was called.
 */
class FailingEngine extends TaskEngine {
  readonly called: Map<string, string[]> = new Map();
  deliverError: Error | null = null;
  claimError: Error | null = null;

  private record(task: PersistedTaskRun, name: string): void {
    if (!this.called.has(task.requestId)) this.called.set(task.requestId, []);
    this.called.get(task.requestId)!.push(name);
  }

  get testPersistence(): TaskRunPersistence { return this.persistence; }

  override async claim(task: PersistedTaskRun): Promise<void> {
    this.record(task, 'claim');
    if (this.claimError) throw this.claimError;
    // No-op: advance DISCOVERED → CLAIMED so process()'s outer state machine
    // doesn't loop.
    this.persistence.transition(task.requestId, TaskRunState.CLAIMED);
  }

  override async deliver(task: PersistedTaskRun): Promise<void> {
    this.record(task, 'deliver');
    if (this.deliverError) throw this.deliverError;
  }
}

describe('race-loss pruning (#896)', () => {
  let store: Store;
  let engine: FailingEngine;
  let p: TaskRunPersistence;

  beforeEach(() => {
    store = new Store(':memory:');
    engine = new FailingEngine(makeOpts(store));
    p = engine.testPersistence;
  });

  afterEach(() => {
    store.close();
  });

  it('recovery: deliver() throwing TCMaxVerdictsReached lands in RACE_LOST (not FAILED)', async () => {
    p.insertDiscovered(makeInput('r-pruned'));
    p.transition('r-pruned', TaskRunState.CLAIMED);
    p.transition('r-pruned', TaskRunState.WAITING);
    p.transition('r-pruned', TaskRunState.PRE_SNAPSHOT);
    p.transition('r-pruned', TaskRunState.RUNNING);
    p.transition('r-pruned', TaskRunState.POST_SNAPSHOT);
    p.transition('r-pruned', TaskRunState.PACKAGING);
    p.transition('r-pruned', TaskRunState.DELIVERING);
    engine.deliverError = raceLossRevert('TCMaxVerdictsReached');

    await recoverInFlight(engine);

    const row = p.getByRequestId('r-pruned')!;
    expect(row.state).toBe('RACE_LOST');

    const status = gatherTaskRunsStatus(store);
    expect(status.totals.failed).toBe(0);
    expect(status.totals.raceLost).toBe(1);

    const events = store.getRecentActivityEvents(50);
    const raceLost = events.find((e) => e.kind === 'race_lost' && e.requestId === 'r-pruned');
    expect(raceLost).toBeDefined();
    expect(raceLost!.outcome).toBe('ok');
  });

  it('recovery: deliver() throwing a generic Error still lands in FAILED', async () => {
    p.insertDiscovered(makeInput('r-genuine-fail'));
    p.transition('r-genuine-fail', TaskRunState.CLAIMED);
    p.transition('r-genuine-fail', TaskRunState.WAITING);
    p.transition('r-genuine-fail', TaskRunState.PRE_SNAPSHOT);
    p.transition('r-genuine-fail', TaskRunState.RUNNING);
    p.transition('r-genuine-fail', TaskRunState.POST_SNAPSHOT);
    p.transition('r-genuine-fail', TaskRunState.PACKAGING);
    p.transition('r-genuine-fail', TaskRunState.DELIVERING);
    engine.deliverError = new Error('runner crashed mid-deliver');

    await recoverInFlight(engine);

    const row = p.getByRequestId('r-genuine-fail')!;
    expect(row.state).toBe(TaskRunState.FAILED);

    const status = gatherTaskRunsStatus(store);
    expect(status.totals.failed).toBe(1);
    expect(status.totals.raceLost).toBe(0);
  });

  it('process: deliver() throwing TCAttemptAlreadyFinalized in a DELIVERING row lands in RACE_LOST', async () => {
    p.insertDiscovered(makeInput('r-process-pruned'));
    p.transition('r-process-pruned', TaskRunState.CLAIMED);
    p.transition('r-process-pruned', TaskRunState.WAITING);
    p.transition('r-process-pruned', TaskRunState.PRE_SNAPSHOT);
    p.transition('r-process-pruned', TaskRunState.RUNNING);
    p.transition('r-process-pruned', TaskRunState.POST_SNAPSHOT);
    p.transition('r-process-pruned', TaskRunState.PACKAGING);
    p.transition('r-process-pruned', TaskRunState.DELIVERING);
    engine.deliverError = raceLossRevert('TCAttemptAlreadyFinalized');

    // engine.process re-throws the original error from _runTransition; that's
    // the documented contract (callers surface the error). The classifier
    // must still have marked the row RACE_LOST before the rethrow.
    await expect(engine.process('r-process-pruned')).rejects.toThrow(
      /TCAttemptAlreadyFinalized/,
    );

    const row = p.getByRequestId('r-process-pruned')!;
    expect(row.state).toBe('RACE_LOST');

    const status = gatherTaskRunsStatus(store);
    expect(status.totals.failed).toBe(0);
    expect(status.totals.raceLost).toBe(1);

    const events = store.getRecentActivityEvents(50);
    const raceLost = events.find((e) => e.kind === 'race_lost' && e.requestId === 'r-process-pruned');
    expect(raceLost).toBeDefined();
    expect(raceLost!.outcome).toBe('ok');
  });
});

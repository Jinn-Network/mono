import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../../src/store/store.js';
import {
  TaskRunPersistence,
  type PersistedTaskRunInput,
} from '../../../src/harnesses/engine/persistence.js';
import { TaskRunState } from '../../../src/harnesses/engine/state.js';

function makeInput(overrides: Partial<PersistedTaskRunInput> = {}): PersistedTaskRunInput {
  return {
    requestId: 'req-ifd-1',
    taskCid: 'bafy-task',
    onchainCreationTx: '0xtx',
    onchainCreationBlock: 1,
    solverType: 'swe-rebench-v2.v1',
    windowStartTs: Date.now() - 1_000,
    windowEndTs: Date.now() + 60_000,
    task: {
      id: 'req-ifd-1',
      description: 'fix',
      solverType: 'swe-rebench-v2.v1',
      role: 'restoration',
      spec: { repo: 'org/widget', base_commit: 'a'.repeat(40), instance_id: 'i-1' },
    },
    ...overrides,
  };
}

function solutionJson(patch: string): string {
  return JSON.stringify({
    venueRef: { name: 'swe-rebench-v2' },
    gating: {},
    solutionPayload: {
      schemaVersion: 'swe-rebench-v2-solution.v1',
      patch,
    },
    artifacts: [],
  });
}

function advanceToRunning(p: TaskRunPersistence, requestId: string): void {
  p.insertDiscovered(makeInput({ requestId }));
  p.transition(requestId, TaskRunState.CLAIMED);
  p.transition(requestId, TaskRunState.WAITING);
  p.transition(requestId, TaskRunState.PRE_SNAPSHOT);
  p.transition(requestId, TaskRunState.RUNNING);
}

describe('intermediateFailureDiffs persistence (#1643)', () => {
  let store: Store;
  let p: TaskRunPersistence;

  beforeEach(() => {
    store = new Store(':memory:');
    p = new TaskRunPersistence(store.db);
  });

  afterEach(() => {
    store.close();
  });

  it('adds intermediate_failure_diffs_json via additive migration', () => {
    const columns = (store.db.pragma('table_info(task_runs)') as Array<{ name: string }>)
      .map((r) => r.name);
    expect(columns).toContain('intermediate_failure_diffs_json');
  });

  it('retains prior patch A when overwritten by different patch B (AC1)', () => {
    advanceToRunning(p, 'req-ifd-1');
    store.db.prepare(
      'UPDATE task_runs SET solution_outputs_json = ? WHERE request_id = ?',
    ).run(solutionJson('diff --git a/x b/x\n+A\n'), 'req-ifd-1');

    p.recordPriorPatchOnOverwrite('req-ifd-1', solutionJson('diff --git a/x b/x\n+B\n'));

    const row = p.getByRequestId('req-ifd-1')!;
    expect(JSON.parse(row.intermediateFailureDiffsJson!)).toEqual([
      'diff --git a/x b/x\n+A\n',
    ]);
  });

  it('does not append empty or identical prior patches (AC3)', () => {
    advanceToRunning(p, 'req-ifd-2');
    // empty prior patch
    store.db.prepare(
      'UPDATE task_runs SET solution_outputs_json = ? WHERE request_id = ?',
    ).run(solutionJson(''), 'req-ifd-2');
    p.recordPriorPatchOnOverwrite('req-ifd-2', solutionJson('diff --git a/x b/x\n+B\n'));
    expect(p.getByRequestId('req-ifd-2')!.intermediateFailureDiffsJson).toBeNull();

    // identical prior
    store.db.prepare(
      'UPDATE task_runs SET solution_outputs_json = ? WHERE request_id = ?',
    ).run(solutionJson('diff --git a/x b/x\n+B\n'), 'req-ifd-2');
    p.recordPriorPatchOnOverwrite('req-ifd-2', solutionJson('diff --git a/x b/x\n+B\n'));
    expect(p.getByRequestId('req-ifd-2')!.intermediateFailureDiffsJson).toBeNull();
  });

  it('survives SQLite round-trip and dedupes on second append (AC6, AC3)', () => {
    advanceToRunning(p, 'req-ifd-3');
    store.db.prepare(
      'UPDATE task_runs SET solution_outputs_json = ? WHERE request_id = ?',
    ).run(solutionJson('diff --git a/x b/x\n+A\n'), 'req-ifd-3');
    p.recordPriorPatchOnOverwrite('req-ifd-3', solutionJson('diff --git a/x b/x\n+B\n'));
    // Simulate overwrite landing, then a third different patch
    store.db.prepare(
      'UPDATE task_runs SET solution_outputs_json = ? WHERE request_id = ?',
    ).run(solutionJson('diff --git a/x b/x\n+B\n'), 'req-ifd-3');
    p.recordPriorPatchOnOverwrite('req-ifd-3', solutionJson('diff --git a/x b/x\n+C\n'));
    // Re-append identical A must not duplicate
    store.db.prepare(
      'UPDATE task_runs SET solution_outputs_json = ? WHERE request_id = ?',
    ).run(solutionJson('diff --git a/x b/x\n+A\n'), 'req-ifd-3');
    p.recordPriorPatchOnOverwrite('req-ifd-3', solutionJson('diff --git a/x b/x\n+D\n'));

    const parsed = JSON.parse(p.getByRequestId('req-ifd-3')!.intermediateFailureDiffsJson!);
    expect(parsed).toEqual([
      'diff --git a/x b/x\n+A\n',
      'diff --git a/x b/x\n+B\n',
    ]);
  });
});

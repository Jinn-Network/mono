import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Store } from '../../../src/store/store.js';
import {
  TaskEngine,
  NotImplementedError,
  type TaskEngineOptions,
} from '../../../src/harnesses/engine/engine.js';
import {
  type PersistedTaskRun,
  type PersistedTaskRunInput,
  TaskRunPersistence,
} from '../../../src/harnesses/engine/persistence.js';
import { TaskRunState } from '../../../src/harnesses/engine/state.js';

function makeOpts(store: Store): TaskEngineOptions {
  return {
    store,
    paths: { workingDirRoot: '/tmp/work', implStateDirRoot: '/tmp/impl' },
  };
}

function makeInput(overrides: Partial<PersistedTaskRunInput> = {}): PersistedTaskRunInput {
  const now = Date.now();
  return {
    requestId: 'req-log-001',
    taskCid: 'bafylog',
    onchainCreationTx: '0xtx',
    onchainCreationBlock: 1,
    solverType: 'portfolio.v0',
    windowStartTs: now + 60_000,
    windowEndTs: now + 60_000 + 86_400_000,
    task: { id: 'req-log-001', description: 't', solverType: 'portfolio.v0', role: 'restoration' },
    ...overrides,
  };
}

class TestEngine extends TaskEngine {
  runImplFn?: (run: PersistedTaskRun) => Promise<void>;

  override async runImpl(run: PersistedTaskRun): Promise<void> {
    if (this.runImplFn) return this.runImplFn(run);
    throw new NotImplementedError('runImpl');
  }

  get testPersistence(): TaskRunPersistence {
    return this.persistence;
  }
}

describe('transition log dedup (jinn-mono-kzan)', () => {
  let store: Store;
  let engine: TestEngine;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    store = new Store(':memory:');
    engine = new TestEngine(makeOpts(store));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    store.close();
  });

  function transitionLines(): string[] {
    return logSpy.mock.calls
      .map((args) => String(args[0] ?? ''))
      .filter((line) => /\[harness-engine\].*→/.test(line));
  }

  it('emits exactly one transition line per RUNNING → POST_SNAPSHOT (not the duplicate bare line)', async () => {
    await engine.observe(makeInput());
    engine.testPersistence.transition('req-log-001', TaskRunState.CLAIMED);
    engine.testPersistence.transition('req-log-001', TaskRunState.WAITING);
    engine.testPersistence.transition('req-log-001', TaskRunState.PRE_SNAPSHOT);
    engine.testPersistence.transition('req-log-001', TaskRunState.RUNNING);

    engine.runImplFn = async (run) => {
      // Mirror the production runImpl behavior: log a domain-specific line,
      // then advance state.
      console.log(`[harness-engine] ${run.requestId} RUNNING → POST_SNAPSHOT via impl=test-impl`);
      engine.testPersistence.transition(run.requestId, TaskRunState.POST_SNAPSHOT);
    };

    await engine.process('req-log-001');

    const lines = transitionLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(
      '[harness-engine] req-log-001 RUNNING → POST_SNAPSHOT via impl=test-impl',
    );
    // The previous generic line `RUNNING → POST_SNAPSHOT` must not be emitted alongside it.
    expect(lines.some((l) => /RUNNING → POST_SNAPSHOT$/.test(l))).toBe(false);
  });
});

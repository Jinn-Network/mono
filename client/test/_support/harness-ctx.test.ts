import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { makeHarnessCtx } from '@test/harness-ctx.js';
import type { Task } from '@/types/task.js';

const fakeTask: Task = {
  id: 'test-1',
  description: 'fake',
  solverType: 'prediction.v0',
  role: 'restoration',
  window: { startTs: 0, endTs: 1000 },
  spec: {},
};

describe('makeHarnessCtx', () => {
  it('creates a context with sensible defaults', () => {
    const ctx = makeHarnessCtx({ task: fakeTask });
    expect(ctx.task).toMatchObject(fakeTask);
    expect(existsSync(ctx.workingDir)).toBe(true);
    expect(ctx.implStateDir).toBe(ctx.workingDir);  // same dir by default
    expect(ctx.msUntilEndTs()).toBe(0);
    expect(ctx.abort).toBeInstanceOf(AbortSignal);
    expect(typeof ctx.log).toBe('function');
    expect(ctx.trajectory.taskCid).toBe('');
  });

  it('creates separate working/impl-state dirs when separateDirs is set', () => {
    const ctx = makeHarnessCtx({ task: fakeTask, separateDirs: true });
    expect(ctx.workingDir).not.toBe(ctx.implStateDir);
    expect(existsSync(ctx.workingDir)).toBe(true);
    expect(existsSync(ctx.implStateDir)).toBe(true);
  });

  it('respects taskCid, msUntilEndTs, abort, log overrides', () => {
    const ac = new AbortController();
    const logged: unknown[] = [];
    const ctx = makeHarnessCtx({
      task: fakeTask,
      taskCid: 'bafy-test',
      msUntilEndTs: () => 5000,
      abort: ac.signal,
      log: (event) => { logged.push(event); },
    });
    expect(ctx.taskCid).toBe('bafy-test');
    expect(ctx.msUntilEndTs()).toBe(5000);
    expect(ctx.abort).toBe(ac.signal);
    ctx.log({ level: 'info', msg: 'hi' });
    expect(logged).toEqual([{ level: 'info', msg: 'hi' }]);
  });

  it('attaches extra fields for impls that read test-only ctx properties', () => {
    const ctx = makeHarnessCtx({
      task: fakeTask,
      extra: { _testDeps: { fooFn: () => 42 } },
    });
    expect((ctx as unknown as { _testDeps: { fooFn: () => number } })._testDeps.fooFn()).toBe(42);
  });

  it('normalizes task defaults for harness tests', () => {
    const ctx = makeHarnessCtx({
      task: {
        id: 'legacy',
        description: 'legacy',
        solverType: 'portfolio.v0',
        role: 'evaluation',
        spec: {},
      },
    });
    expect(ctx.task).toMatchObject({ solverType: 'portfolio.v0', role: 'evaluation' });
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  runTasksLifecycle,
  type TasksLifecycleDeps,
  type TasksLifecycleExecutor,
} from '@/cli/commands/tasks-lifecycle.js';
import { makeCommandCtx } from '@test/cli.js';

/**
 * The `jinn tasks {close,cancel,release}` CLI front-ends (one-swap M5d, #2461). The intent modules
 * themselves are covered in `test/native-requester/work-client/lifecycle.test.ts`; this suite pins
 * the front-end contract: argv validation, the feature-disabled default build, JINN_PASSWORD
 * gating, and the intent-module hand-off when deps are injected.
 */

const ATTEMPT = 'urn:uuid:11111111-2222-3333-4444-555555555555';

function only<T>(writes: string[]): T {
  const lines = writes.join('').split('\n').map((l) => l.trim()).filter(Boolean);
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as T;
}

interface Harness {
  readonly deps: TasksLifecycleDeps;
  readonly executor: TasksLifecycleExecutor;
  readonly state: { loaded: number; closed: number };
}

function fakeDeps(overrides: Partial<TasksLifecycleExecutor> = {}): Harness {
  const state = { loaded: 0, closed: 0 };
  const executor: TasksLifecycleExecutor = {
    lifecycle: {
      refundUnusedTaskBudget: vi.fn(async () => {}),
      withdrawAnnouncement: vi.fn(async () => {}),
      resolveAttempt: vi.fn(async () => ({ taskId: 99n, attemptIndex: 2 })),
      requestCancel: vi.fn(async () => 'requested' as const),
      ...overrides.lifecycle,
    },
    release: { releaseAttempt: vi.fn(async () => undefined), ...overrides.release },
    close: async () => { state.closed += 1; },
  };
  const deps: TasksLifecycleDeps = {
    loadExecutor: async () => { state.loaded += 1; return executor; },
  };
  return { deps, executor, state };
}

describe('runTasksLifecycle — argv validation (validated before wiring state)', () => {
  it('close requires a non-negative --task-id', async () => {
    const { ctx, writes, exits } = makeCommandCtx({ argv: ['--json'] });
    await runTasksLifecycle(ctx, 'close');
    expect(only<{ code: string }>(writes).code).toBe('invalid_invocation');
    expect(exits[0]).not.toBe(0);
  });

  it('cancel requires --attempt and --reason', async () => {
    const { ctx, writes } = makeCommandCtx({ argv: ['--json', '--attempt', ATTEMPT] });
    await runTasksLifecycle(ctx, 'cancel');
    expect(only<{ code: string; message: string }>(writes).code).toBe('invalid_invocation');
  });

  it('release requires --attempt-index', async () => {
    const { ctx, writes } = makeCommandCtx({ argv: ['--json', '--task-id', '42'] });
    await runTasksLifecycle(ctx, 'release');
    expect(only<{ code: string }>(writes).code).toBe('invalid_invocation');
  });
});

describe('runTasksLifecycle — feature-disabled default build', () => {
  it('a valid invocation with no deps is bootstrap_incomplete, not a silent no-op', async () => {
    const { ctx, writes } = makeCommandCtx({ argv: ['--json', '--task-id', '42'] });
    await runTasksLifecycle(ctx, 'close');
    const env = only<{ code: string; details: { state: string; verb: string } }>(writes);
    expect(env.code).toBe('bootstrap_incomplete');
    expect(env.details).toMatchObject({ state: 'feature-disabled', verb: 'close' });
  });

  it('malformed argv beats feature-disabled: invalid_invocation wins even with no deps', async () => {
    const { ctx, writes } = makeCommandCtx({ argv: ['--json'] });
    await runTasksLifecycle(ctx, 'release');
    expect(only<{ code: string }>(writes).code).toBe('invalid_invocation');
  });
});

describe('runTasksLifecycle — deps injected', () => {
  it('close drives closePosting against the executor lifecycle port and closes custody', async () => {
    const harness = fakeDeps();
    const { ctx, writes } = makeCommandCtx({ argv: ['--json', '--task-id', '42'], env: { JINN_PASSWORD: 'pw' } });
    await runTasksLifecycle(ctx, 'close', harness.deps);
    const result = only<{ verb: string; taskId: string; action: string }>(writes);
    expect(result).toMatchObject({ verb: 'tasks close', taskId: '42', action: 'refunded' });
    expect(harness.executor.lifecycle.refundUnusedTaskBudget).toHaveBeenCalledWith({ taskId: 42n });
    expect(harness.state.closed).toBe(1);
  });

  it('cancel drives cancelAttempt', async () => {
    const harness = fakeDeps();
    const { ctx, writes } = makeCommandCtx({
      argv: ['--json', '--attempt', ATTEMPT, '--reason', 'stale'],
      env: { JINN_PASSWORD: 'pw' },
    });
    await runTasksLifecycle(ctx, 'cancel', harness.deps);
    const result = only<{ verb: string; taskId: string; signal: string }>(writes);
    expect(result).toMatchObject({ verb: 'tasks cancel', taskId: '99', signal: 'requested' });
  });

  it('release drives releasePostedAttempt and reports unsupported without throwing', async () => {
    const harness = fakeDeps({ release: { releaseAttempt: async () => ({ ok: false, kind: 'unsupported' }) } });
    const { ctx, writes } = makeCommandCtx({
      argv: ['--json', '--task-id', '7', '--attempt-index', '0'],
      env: { JINN_PASSWORD: 'pw' },
    });
    await runTasksLifecycle(ctx, 'release', harness.deps);
    expect(only<{ outcome: string }>(writes).outcome).toBe('unsupported');
  });

  it('requires JINN_PASSWORD once deps are present', async () => {
    const harness = fakeDeps();
    const { ctx, writes } = makeCommandCtx({ argv: ['--json', '--task-id', '42'] });
    await runTasksLifecycle(ctx, 'close', harness.deps);
    expect(only<{ code: string }>(writes).code).toBe('invalid_invocation');
    expect(harness.state.loaded).toBe(0);
  });

  it('surfaces an intent-module RequesterError as invalid_invocation carrying its category/code', async () => {
    // A lifecycle port with NEITHER close verb -> closePosting throws config/close-unsupported.
    let closed = 0;
    const deps: TasksLifecycleDeps = {
      loadExecutor: async () => ({
        lifecycle: {
          withdrawAnnouncement: async () => {},
          resolveAttempt: async () => ({ taskId: 1n, attemptIndex: 0 }),
          requestCancel: async () => 'requested' as const,
        },
        release: { releaseAttempt: async () => undefined },
        close: async () => { closed += 1; },
      }),
    };
    const { ctx, writes } = makeCommandCtx({ argv: ['--json', '--task-id', '42'], env: { JINN_PASSWORD: 'pw' } });
    await runTasksLifecycle(ctx, 'close', deps);
    const env = only<{ code: string; details: { category: string; reason: string } }>(writes);
    expect(env.code).toBe('invalid_invocation');
    expect(env.details).toMatchObject({ category: 'config', reason: 'close-unsupported' });
    expect(closed).toBe(1);
  });
});

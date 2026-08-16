import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ClaudeSemanticAgentRunner,
} from '../../../src/harnesses/impls/jinn-repo-evaluator/claude-semantic-agent.js';

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4321;
  readonly kill = vi.fn();
}

afterEach(() => {
  vi.useRealTimers();
});

describe('semantic evaluator process supervision', () => {
  it('waits for close and escalates SIGTERM to SIGKILL before cleanup', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const killProcessGroup = vi.fn();
    const remove = vi.fn().mockResolvedValue(undefined);
    const spawnFn = vi.fn(() => child as unknown as ChildProcess);
    const runner = new ClaudeSemanticAgentRunner({
      spawn: spawnFn as unknown as typeof spawn,
      killProcessGroup,
      terminationGraceMs: 100,
      reapTimeoutMs: 100,
      makeTempDir: vi.fn().mockResolvedValue('/tmp/jinn-semantic-home'),
      remove,
      environment: {
        ANTHROPIC_API_KEY: 'test-only',
      },
    });
    const controller = new AbortController();
    const pending = runner.run({
      prompt: 'Review.',
      abort: controller.signal,
      model: 'claude-review-model',
    });
    const observed = pending.catch((error: unknown) => error);

    await vi.waitFor(() => {
      expect(spawnFn).toHaveBeenCalledOnce();
    });
    controller.abort();
    await Promise.resolve();
    expect(killProcessGroup).toHaveBeenCalledWith(4321, 'SIGTERM');
    expect(remove).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    expect(killProcessGroup).toHaveBeenCalledWith(4321, 'SIGKILL');
    expect(remove).not.toHaveBeenCalled();

    child.emit('close', null, 'SIGKILL');
    await expect(observed).resolves.toMatchObject({ name: 'AbortError' });
    expect(remove).toHaveBeenCalledWith('/tmp/jinn-semantic-home');
  });

  it('reports an unreaped process and leaves its isolated state intact', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const remove = vi.fn().mockResolvedValue(undefined);
    const spawnFn = vi.fn(() => child as unknown as ChildProcess);
    const runner = new ClaudeSemanticAgentRunner({
      spawn: spawnFn as unknown as typeof spawn,
      killProcessGroup: vi.fn(),
      terminationGraceMs: 100,
      reapTimeoutMs: 100,
      makeTempDir: vi.fn().mockResolvedValue('/tmp/jinn-semantic-home'),
      remove,
      environment: {
        ANTHROPIC_API_KEY: 'test-only',
      },
    });
    const controller = new AbortController();
    const observed = runner.run({
      prompt: 'Review.',
      abort: controller.signal,
      model: 'claude-review-model',
    }).catch((error: unknown) => error);

    await vi.waitFor(() => {
      expect(spawnFn).toHaveBeenCalledOnce();
    });
    controller.abort();
    await vi.advanceTimersByTimeAsync(200);

    await expect(observed).resolves.toMatchObject({
      name: 'SupervisedProcessUnreapedError',
    });
    expect(remove).not.toHaveBeenCalled();
  });
});

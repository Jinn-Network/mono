import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type {
  ContainerRunRequest,
} from '@jinn-network/task-execution-evaluator-adapters';
import {
  ContainerTerminatedError,
  buildDockerRunArgs,
  createDockerContainerRuntime,
  type ContainerChildProcess,
  type ContainerProcessSpawner,
} from '../../src/daemon/native-evaluator-container-runtime.js';

/**
 * A controllable fake `docker` child. It never touches a real process: the test drives its
 * lifecycle explicitly, which is exactly how the abort→terminate→settle bound is proved without a
 * live container that could ignore signals for real.
 */
class FakeChild extends EventEmitter implements ContainerChildProcess {
  readonly pid = 4321;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly signals: NodeJS.Signals[] = [];
  /** When true the child ignores SIGTERM and only dies on SIGKILL — the wedged-container case. */
  ignoreSigterm = false;
  killed = false;

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    if (signal === 'SIGKILL' || (signal === 'SIGTERM' && !this.ignoreSigterm)) {
      this.killed = true;
      // A real child closes on its own microtask/loop turn after the signal, never synchronously.
      queueMicrotask(() => this.emit('close', signal === 'SIGKILL' ? 137 : 143));
    }
    return true;
  }

  emitStdout(text: string): void {
    this.stdout.emit('data', Buffer.from(text));
  }

  close(code: number): void {
    this.emit('close', code);
  }
}

/** Records every spawn and hands back the pre-seeded children in order. */
function recordingSpawner(children: FakeChild[]): {
  readonly spawn: ContainerProcessSpawner;
  readonly calls: Array<{ readonly command: string; readonly args: string[] }>;
} {
  const calls: Array<{ readonly command: string; readonly args: string[] }> = [];
  let index = 0;
  return {
    calls,
    spawn: (command, args) => {
      calls.push({ command, args: [...args] });
      const child = children[index++];
      if (child === undefined) throw new Error('spawner ran out of pre-seeded children');
      return child;
    },
  };
}

function request(overrides: Partial<ContainerRunRequest> = {}): ContainerRunRequest {
  return {
    image: 'ghcr.io/example/grader@sha256:' + 'a'.repeat(64),
    platform: 'linux/amd64',
    workdir: '/jinn/evaluation',
    mounts: [{ source: '/host/work/abc', target: '/jinn/evaluation', readOnly: false }],
    env: { GRADER_MODE: 'strict' },
    ...overrides,
  };
}

describe('buildDockerRunArgs', () => {
  it('composes a shell-free, --rm, digest-pinned run argv from the request', () => {
    const args = buildDockerRunArgs(request(), 'jinn-grader-fixed');
    expect(args[0]).toBe('run');
    expect(args).toContain('--rm');
    // The container is named so an aborted run can be reaped out of band.
    expect(args).toContain('--name');
    expect(args).toContain('jinn-grader-fixed');
    expect(args).toContain('--platform');
    expect(args).toContain('linux/amd64');
    // workdir and its bind mount both reach docker as their own argv elements (never a shell).
    expect(args).toContain('--workdir');
    expect(args).toContain('/jinn/evaluation');
    const mount = args.find((a) => a.startsWith('type=bind'));
    expect(mount).toBe('type=bind,source=/host/work/abc,target=/jinn/evaluation');
    expect(args).toContain('GRADER_MODE=strict');
    // The image is the final positional argument, after all options.
    expect(args[args.length - 1]).toBe('ghcr.io/example/grader@sha256:' + 'a'.repeat(64));
  });

  it('marks a read-only mount readonly and omits an absent platform', () => {
    const args = buildDockerRunArgs(
      request({ platform: undefined, mounts: [{ source: '/h', target: '/c', readOnly: true }] }),
      'n',
    );
    expect(args).not.toContain('--platform');
    expect(args).toContain('type=bind,source=/h,target=/c,readonly');
  });
});

describe('createDockerContainerRuntime', () => {
  it('resolves { exitCode, stdout } when the container exits normally', async () => {
    const child = new FakeChild();
    const { spawn, calls } = recordingSpawner([child]);
    const runtime = createDockerContainerRuntime({ spawn, dockerPath: 'docker' });

    const runPromise = runtime.run(request());
    child.emitStdout('grader log line\n');
    child.close(0);
    const result = await runPromise;

    expect(result).toEqual({ exitCode: 0, stdout: 'grader log line\n' });
    expect(calls[0]!.command).toBe('docker');
    expect(calls[0]!.args[0]).toBe('run');
  });

  it('preserves a nonzero exit (a failing subject is a normal grader outcome)', async () => {
    const child = new FakeChild();
    const { spawn } = recordingSpawner([child]);
    const runtime = createDockerContainerRuntime({ spawn });
    const runPromise = runtime.run(request());
    child.close(1);
    await expect(runPromise).resolves.toEqual({ exitCode: 1, stdout: '' });
  });

  it('bounds captured stdout against an OOM flood (P0-4 N7)', async () => {
    const child = new FakeChild();
    const { spawn } = recordingSpawner([child]);
    const runtime = createDockerContainerRuntime({ spawn, maxStdoutBytes: 8 });
    const runPromise = runtime.run(request());
    child.emitStdout('0123456789abcdef'); // 16 bytes, cap is 8
    child.close(0);
    const result = await runPromise;
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(8);
    expect(result.stdout).toBe('01234567');
  });

  it('refuses to spawn when the deadline already elapsed, settling immediately', async () => {
    const { spawn, calls } = recordingSpawner([]);
    const runtime = createDockerContainerRuntime({ spawn });
    const aborted = AbortSignal.abort();
    await expect(runtime.run(request({ timeoutSignal: aborted }))).rejects.toBeInstanceOf(
      ContainerTerminatedError,
    );
    expect(calls).toHaveLength(0);
  });

  it('abort → SIGTERM → close settles promptly as a terminated run', async () => {
    const child = new FakeChild();
    const { spawn } = recordingSpawner([child]);
    const runtime = createDockerContainerRuntime({ spawn, killGraceMs: 50 });
    const controller = new AbortController();
    const runPromise = runtime.run(request({ timeoutSignal: controller.signal }));
    controller.abort();
    await expect(runPromise).rejects.toBeInstanceOf(ContainerTerminatedError);
    expect(child.signals).toContain('SIGTERM');
    // The container did honor SIGTERM, so no escalation was needed.
    expect(child.signals).not.toContain('SIGKILL');
  });

  it('abort on a SIGTERM-ignoring container escalates to SIGKILL and still settles within the bound', async () => {
    const child = new FakeChild();
    child.ignoreSigterm = true;
    const killer = new FakeChild(); // best-effort `docker kill <name>` side channel
    killer.pid = 9;
    const { spawn, calls } = recordingSpawner([child, killer]);
    const runtime = createDockerContainerRuntime({ spawn, killGraceMs: 20, settleGraceMs: 20 });
    const controller = new AbortController();

    const start = Date.now();
    const runPromise = runtime.run(request({ timeoutSignal: controller.signal }));
    controller.abort();
    await expect(runPromise).rejects.toBeInstanceOf(ContainerTerminatedError);
    const elapsed = Date.now() - start;

    expect(child.signals).toContain('SIGTERM');
    expect(child.signals).toContain('SIGKILL');
    // Settlement is bounded by kill grace + settle grace, not by the container's cooperation.
    expect(elapsed).toBeLessThan(1000);
    // The out-of-band container reaper was invoked so the container is stopped even if the CLI is not.
    expect(calls.some(({ args }) => args[0] === 'kill')).toBe(true);
  });

  it('settles within the bound even if the child never closes after SIGKILL (unkillable)', async () => {
    const child = new FakeChild();
    // Never dies: ignores both signals (kill records the signal but emits no close).
    child.kill = (signal: NodeJS.Signals): boolean => {
      child.signals.push(signal);
      return true;
    };
    const killer = new FakeChild();
    const { spawn } = recordingSpawner([child, killer]);
    const runtime = createDockerContainerRuntime({ spawn, killGraceMs: 20, settleGraceMs: 20 });
    const controller = new AbortController();
    const runPromise = runtime.run(request({ timeoutSignal: controller.signal }));
    controller.abort();
    await expect(runPromise).rejects.toBeInstanceOf(ContainerTerminatedError);
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('rejects when the docker CLI fails to spawn', async () => {
    const child = new FakeChild();
    const { spawn } = recordingSpawner([child]);
    const runtime = createDockerContainerRuntime({ spawn });
    const runPromise = runtime.run(request());
    child.stderr.emit('data', Buffer.from('docker: command not found'));
    child.emit('error', new Error('spawn docker ENOENT'));
    await expect(runPromise).rejects.toThrow(/docker/i);
  });
});

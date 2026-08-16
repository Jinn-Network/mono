import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type {
  ContainerRunRequest,
} from '@jinn-network/task-execution-evaluator-adapters';
import {
  ContainerTerminatedError,
  STDERR_LOG_DELIMITER,
  buildDockerRunArgs,
  createDockerContainerRuntime,
  resolveIsolation,
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

  emitStderr(text: string): void {
    this.stderr.emit('data', Buffer.from(text));
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

/** Extracts the value docker was given for a paired flag (`--flag value`). */
function flagValue(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

/** The `--name` the run itself used, so reaper calls can be pinned to the same container. */
function runContainerName(args: string[]): string {
  const name = flagValue(args, '--name');
  if (name === undefined) throw new Error('run argv carried no --name');
  return name;
}

describe('buildDockerRunArgs', () => {
  it('composes a shell-free, --rm, digest-pinned run argv from the request', () => {
    const args = buildDockerRunArgs(request(), 'jinn-grader-fixed');
    expect(args[0]).toBe('run');
    expect(args).toContain('--rm');
    // The container is named so an aborted run can be reaped out of band.
    expect(flagValue(args, '--name')).toBe('jinn-grader-fixed');
    expect(flagValue(args, '--platform')).toBe('linux/amd64');
    // workdir and its bind mount both reach docker as their own argv elements (never a shell).
    expect(flagValue(args, '--workdir')).toBe('/jinn/evaluation');
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

  // One assertion per isolation/resource flag on the untrusted grader run (the driver's charter).
  it('caps and isolates the untrusted container by default (matches docker-immutable-verifier)', () => {
    const args = buildDockerRunArgs(request(), 'n');
    expect(flagValue(args, '--network')).toBe('none');
    expect(flagValue(args, '--cap-drop')).toBe('ALL');
    expect(flagValue(args, '--security-opt')).toBe('no-new-privileges:true');
    expect(args).toContain('--read-only');
    expect(flagValue(args, '--memory')).toBe('8g');
    expect(flagValue(args, '--cpus')).toBe('4');
    expect(flagValue(args, '--pids-limit')).toBe('512');
    const tmpfs = flagValue(args, '--tmpfs');
    expect(tmpfs).toMatch(/^\/tmp:rw,noexec,nosuid,size=\d+$/);
    // Root by default: many grader images (swe-rebench) legitimately need it.
    expect(args).not.toContain('--user');
  });

  it('honors overridden resource/isolation caps and a pinned --user', () => {
    const iso = resolveIsolation({
      network: 'bridge',
      memory: '2g',
      cpus: '1',
      pidsLimit: 128,
      readOnlyRootfs: false,
      user: '1000:1000',
    });
    const args = buildDockerRunArgs(request(), 'n', iso);
    expect(flagValue(args, '--network')).toBe('bridge');
    expect(flagValue(args, '--memory')).toBe('2g');
    expect(flagValue(args, '--cpus')).toBe('1');
    expect(flagValue(args, '--pids-limit')).toBe('128');
    expect(args).not.toContain('--read-only');
    expect(flagValue(args, '--user')).toBe('1000:1000');
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

  it('applies the isolation caps to the actually-spawned run, defaults present unless overridden', async () => {
    const child = new FakeChild();
    const { spawn, calls } = recordingSpawner([child]);
    // Default memory/pids present when unspecified.
    const runtime = createDockerContainerRuntime({ spawn, cpus: '2' });
    const runPromise = runtime.run(request());
    child.close(0);
    await runPromise;
    const args = calls[0]!.args;
    expect(flagValue(args, '--memory')).toBe('8g'); // default
    expect(flagValue(args, '--pids-limit')).toBe('512'); // default
    expect(flagValue(args, '--cpus')).toBe('2'); // override
    expect(flagValue(args, '--network')).toBe('none');
  });

  it('preserves a nonzero exit (a failing subject is a normal grader outcome)', async () => {
    const child = new FakeChild();
    const { spawn } = recordingSpawner([child]);
    const runtime = createDockerContainerRuntime({ spawn });
    const runPromise = runtime.run(request());
    child.close(1);
    await expect(runPromise).resolves.toEqual({ exitCode: 1, stdout: '' });
  });

  it('folds bounded stderr into the log on a nonzero exit, but not on a clean exit (N6)', async () => {
    const failing = new FakeChild();
    const okChild = new FakeChild();
    const { spawn } = recordingSpawner([failing, okChild]);
    const runtime = createDockerContainerRuntime({ spawn });

    const failingRun = runtime.run(request());
    failing.emitStdout('partial log');
    failing.emitStderr('Traceback: grader crashed');
    failing.close(2);
    const failingResult = await failingRun;
    expect(failingResult.exitCode).toBe(2);
    expect(failingResult.stdout).toBe(`partial log${STDERR_LOG_DELIMITER}Traceback: grader crashed`);

    const okRun = runtime.run(request());
    okChild.emitStdout('clean log');
    okChild.emitStderr('a warning'); // discarded on a clean exit
    okChild.close(0);
    const okResult = await okRun;
    expect(okResult.stdout).toBe('clean log');
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
    const killer = new FakeChild();
    const { spawn } = recordingSpawner([child, killer]);
    const runtime = createDockerContainerRuntime({ spawn, killGraceMs: 50 });
    const controller = new AbortController();
    const runPromise = runtime.run(request({ timeoutSignal: controller.signal }));
    controller.abort();
    await expect(runPromise).rejects.toBeInstanceOf(ContainerTerminatedError);
    expect(child.signals).toContain('SIGTERM');
    // The container did honor SIGTERM, so no escalation was needed.
    expect(child.signals).not.toContain('SIGKILL');
  });

  it('abort on a SIGTERM-ignoring container escalates to SIGKILL, reaps the SAME container, and settles within the bound', async () => {
    const child = new FakeChild();
    child.ignoreSigterm = true;
    const killer = new FakeChild(); // best-effort `docker kill <name>` side channel
    const remover = new FakeChild(); // best-effort `docker rm -f <name>` after force-settle
    const { spawn, calls } = recordingSpawner([child, killer, remover]);
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
    // The out-of-band reaper is pinned to the run's own container name.
    const name = runContainerName(calls[0]!.args);
    const killCall = calls.find(({ args }) => args[0] === 'kill');
    expect(killCall?.args).toEqual(['kill', name]);
  });

  it('settles within the bound even if the child never closes after SIGKILL, then reaps with rm -f', async () => {
    const child = new FakeChild();
    // Never dies: ignores both signals (kill records the signal but emits no close).
    child.kill = (signal: NodeJS.Signals): boolean => {
      child.signals.push(signal);
      return true;
    };
    const killer = new FakeChild();
    const remover = new FakeChild();
    const { spawn, calls } = recordingSpawner([child, killer, remover]);
    const runtime = createDockerContainerRuntime({ spawn, killGraceMs: 20, settleGraceMs: 20 });
    const controller = new AbortController();
    const runPromise = runtime.run(request({ timeoutSignal: controller.signal }));
    controller.abort();
    await expect(runPromise).rejects.toBeInstanceOf(ContainerTerminatedError);
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    // The orphaned-container race is closed with `docker rm -f <same name>`.
    const name = runContainerName(calls[0]!.args);
    const removeCall = calls.find(({ args }) => args[0] === 'rm');
    expect(removeCall?.args).toEqual(['rm', '-f', name]);
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

  // #2542: on a host where the docker binary is not under the daemon's inherited PATH (e.g. macOS
  // Docker Desktop at /usr/local/bin/docker), the spawn fails ENOENT. The error must name the exact
  // resolved path that was tried and point at the sidecar dockerPath remedy, not just say "docker".
  it('names the resolved docker path and points at the sidecar dockerPath remedy on ENOENT', async () => {
    const child = new FakeChild();
    const { spawn } = recordingSpawner([child]);
    const runtime = createDockerContainerRuntime({ spawn, dockerPath: '/usr/local/bin/docker' });
    const runPromise = runtime.run(request());
    const enoent = Object.assign(new Error('spawn /usr/local/bin/docker ENOENT'), { code: 'ENOENT' });
    child.emit('error', enoent);

    let caught: Error | undefined;
    try {
      await runPromise;
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain('/usr/local/bin/docker');
    expect(caught!.message).toMatch(/dockerPath/);
    expect(caught!.message).toMatch(/sidecar/i);
  });

  // A non-ENOENT spawn error (docker found, but refused for some other reason) gets no sidecar
  // remedy appended -- the remedy is specific to "binary not found", not spawn failures in general.
  it('does not append the sidecar remedy for a non-ENOENT spawn error', async () => {
    const child = new FakeChild();
    const { spawn } = recordingSpawner([child]);
    const runtime = createDockerContainerRuntime({ spawn, dockerPath: '/usr/bin/docker' });
    const runPromise = runtime.run(request());
    const eacces = Object.assign(new Error('spawn /usr/bin/docker EACCES'), { code: 'EACCES' });
    child.emit('error', eacces);

    let caught: Error | undefined;
    try {
      await runPromise;
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain('/usr/bin/docker');
    expect(caught!.message).not.toMatch(/sidecar/i);
  });
});

// client/test/harnesses/impls/hermes-agent/adapter.test.ts
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { HermesHarnessAdapter } from '../../../../src/harnesses/impls/hermes-agent/adapter.js';
import type { TaskSessionInputs } from '../../../../src/harnesses/impls/learner/types.js';

const networkToolsRoot = fileURLToPath(new URL('../../../../plugins/network-tools/', import.meta.url));

type SpawnCall = {
  command: string;
  args: string[];
  options: { env?: NodeJS.ProcessEnv; cwd?: string };
};

function fakeHermesChild(): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  setImmediate(() => {
    child.emit('exit', 0, null);
  });
  return child;
}

function inputs(workingDir: string, implStateDir: string): TaskSessionInputs {
  return {
    taskId: 'task-1',
    requestId: 'req-1',
    taskCid: 'bafy…',
    solverType: 'swe-rebench-v2.v1',
    model: 'anthropic/claude-opus-4.6',
    implStateDir,
    workingDir,
    pluginRoots: [networkToolsRoot],
    windowStartTs: 0,
    windowEndTs: Date.now() + 60_000,
    msUntilEndTs: 60_000,
    abort: new AbortController().signal,
    mode: 'train',
    taskBody: {
      id: 'task-1',
      description: 'test',
      solverType: 'swe-rebench-v2.v1',
      role: 'restoration',
      spec: { repo: 'Unidata/netcdf-c', base_commit: 'a'.repeat(40) },
    },
  };
}

describe('HermesHarnessAdapter', () => {
  it('spawns hermes chat -q with model/provider flags and HERMES_HOME env', async () => {
    const spawnCalls: SpawnCall[] = [];
    const home = mkdtempSync(join(tmpdir(), 'hermes-home-'));
    const work = mkdtempSync(join(tmpdir(), 'hermes-wd-'));

    try {
      const adapter = new HermesHarnessAdapter({
        hermesPath: '/bin/fake-hermes',
        operatorHermesHome: home,
        hermesProvider: 'anthropic',
        daemonApiUrl: 'http://127.0.0.1:7331',
        daemonApiToken: 'tok',
        corpusEnv: {},
        _spawnFn: vi.fn((command: string, args: string[], options: any) => {
          spawnCalls.push({ command, args, options });
          return fakeHermesChild() as any;
        }) as any,
      });

      await adapter.runTask(inputs(work, home));

      expect(spawnCalls).toHaveLength(1);
      const call = spawnCalls[0];
      expect(call.command).toBe('/bin/fake-hermes');
      expect(call.args).toContain('chat');
      expect(call.args).toContain('-q');
      // Quiet/programmatic mode — suppress banner/spinner/tool previews.
      expect(call.args).toContain('-Q');
      expect(call.args).toContain('--model');
      expect(call.args).toContain('anthropic/claude-opus-4.6');
      expect(call.args).toContain('--provider');
      expect(call.args).toContain('anthropic');
      // No `-w <workingDir>` — `hermes chat` has no such flag (`--worktree` is
      // a boolean we deliberately don't pass); the cwd comes from the spawn
      // options + `terminal.cwd` in the per-Task config.yaml.
      expect(call.args).not.toContain('-w');
      expect(call.options.cwd).toBe(work);
      expect(call.options.env?.HERMES_HOME).toBe(home);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('forwards abort signal to SIGTERM on the child', async () => {
    const controller = new AbortController();
    const home = mkdtempSync(join(tmpdir(), 'hermes-home-'));
    const work = mkdtempSync(join(tmpdir(), 'hermes-wd-'));
    let child: ReturnType<typeof fakeHermesChild> | null = null;

    try {
      const adapter = new HermesHarnessAdapter({
        hermesPath: '/bin/fake-hermes',
        operatorHermesHome: home,
        daemonApiUrl: 'http://127.0.0.1:7331',
        daemonApiToken: 'tok',
        corpusEnv: {},
        _spawnFn: vi.fn((_c: string, _a: string[], _o: any) => {
          // Build a child that does NOT auto-exit so the test can abort mid-run
          const c = new EventEmitter() as EventEmitter & {
            stdout: EventEmitter;
            stderr: EventEmitter;
            killed: boolean;
            kill: ReturnType<typeof vi.fn>;
          };
          c.stdout = new EventEmitter();
          c.stderr = new EventEmitter();
          c.killed = false;
          c.kill = vi.fn(() => { c.killed = true; return true; });
          child = c;
          return child as any;
        }) as any,
      });

      const taskInputs = inputs(work, home);
      taskInputs.abort = controller.signal;

      const runPromise = adapter.runTask(taskInputs);
      // Allow spawn to register listeners
      await new Promise((r) => setImmediate(r));

      controller.abort();
      expect(child!.kill).toHaveBeenCalledWith('SIGTERM');

      // Resolve the run by emitting exit
      child!.emit('exit', null, 'SIGTERM');
      await runPromise;
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });
});

import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { ClaudeCodeHarnessAdapter } from '../../../../src/harnesses/impls/learner/index.js';
import type { Task } from '../../../../src/types/task.js';

const learnerPluginRoot = fileURLToPath(new URL('../../../../plugins/learner/', import.meta.url));

/**
 * Fake `claude` child. The claude-code adapter uses stdio ['ignore','pipe','pipe']
 * (prompt rides on the `-p` arg, not stdin), so we only need stdout/stderr emitters
 * plus a kill mock. `pid` is set so the adapter's process-group reap (process.kill
 * (-pid, …)) has something to target.
 */
type FakeClaudeChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: null;
  pid: number;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
};

function fakeClaudeChild(
  mode: 'result-then-hang' | 'result-then-exit' | 'crash-no-result' | 'result-then-late-output',
): FakeClaudeChild {
  const child = new EventEmitter() as FakeClaudeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = null;
  child.pid = 4242;
  child.killed = false;
  child.kill = vi.fn(() => { child.killed = true; return true; });
  setImmediate(() => {
    if (mode === 'crash-no-result') {
      child.stderr.emit('data', Buffer.from('boom\n'));
      child.emit('exit', 1, null);
      return;
    }
    // claude streams its work, then a terminal result message.
    child.stdout.emit('data', Buffer.from('{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}\n'));
    child.stdout.emit('data', Buffer.from('{"type":"result","subtype":"success"}\n'));
    if (mode === 'result-then-exit') {
      child.emit('exit', 0, null);
    }
    if (mode === 'result-then-late-output') {
      // The terminal result settles the session and closeLogs() ends the log
      // streams. A reaped-but-not-yet-dead child then emits more bytes — the
      // real-world trigger for the "write after end" crash. `.end()` sets
      // writableEnded synchronously, so one turn of delay suffices.
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from('{"type":"assistant","message":{"content":[{"type":"text","text":"late"}]}}\n'));
        child.stderr.emit('data', Buffer.from('late stderr after close\n'));
        child.emit('exit', 0, null);
      });
    }
    // 'result-then-hang': intentionally NEVER emits exit — reproduces #883
    // (claude emits its terminal result but the process lingers, held open by
    // a leaked tool subprocess keeping the event loop alive).
  });
  return child;
}

function sweTask(): Task {
  return {
    id: 'swe-rebench-task-restoration',
    description: 'swe-rebench-v2 restoration task',
    solverType: 'swe-rebench-v2.v1',
    role: 'restoration',
    window: { startTs: 0, endTs: Date.now() + 3_600_000 },
    spec: {
      schemaVersion: 'swe-rebench-v2.v1',
      instance_id: 'BerriAI__litellm-14715',
      repo: 'BerriAI/litellm',
      base_commit: 'a'.repeat(40),
      language: 'python',
      problem_statement: 'fix the bug',
      interface: '',
      hf_dataset: 'nebius/SWE-rebench-leaderboard',
      hf_split: '2025_09',
      deadline_unix: Math.floor(Date.now() / 1000) + 3600,
      round_month: '2025-09',
    },
  } as unknown as Task;
}

function runInputs(workingDir: string, implStateDir: string, abort: AbortSignal) {
  return {
    taskId: 'swe-rebench-task-restoration',
    requestId: '0x' + '7'.repeat(64),
    solverType: 'swe-rebench-v2.v1',
    taskBody: sweTask() as never,
    implStateDir,
    workingDir,
    taskWorkspaceDir: join(workingDir, 'repo'),
    pluginRoots: [],
    windowStartTs: 1,
    windowEndTs: 2,
    msUntilEndTs: 3_600_000,
    mode: 'train' as const,
    abort,
  };
}

function makeAdapter(
  spawnFn: unknown,
  killProcessGroup: (pid: number, sig: NodeJS.Signals) => void = () => {},
): ClaudeCodeHarnessAdapter {
  return new ClaudeCodeHarnessAdapter({
    claudePath: 'claude-test',
    pluginInstallDir: mkdtempSync(join(tmpdir(), 'jinn-claude-plugins-')),
    _spawnFn: spawnFn as never,
    // Inject a no-op group-kill so tests never fire a real signal at a real
    // process group (the fake child's pid is arbitrary).
    _killProcessGroup: killProcessGroup,
  });
}

describe('ClaudeCodeHarnessAdapter — completion + subprocess reaping (#883)', () => {
  it('resolves on the terminal result message even when the child never exits, and reaps it', async () => {
    let captured: FakeClaudeChild | undefined;
    const spawnFn = vi.fn(() => { captured = fakeClaudeChild('result-then-hang'); return captured; });
    const killGroup = vi.fn();
    const workingDir = mkdtempSync(join(tmpdir(), 'jinn-claude-hang-work-'));
    const implStateDir = mkdtempSync(join(tmpdir(), 'jinn-claude-hang-state-'));
    try {
      const adapter = makeAdapter(spawnFn, killGroup);
      // Pre-fix this never resolves (adapter waits on child 'exit', which never
      // fires) and the test times out. Post-fix it resolves on the result line.
      await adapter.runTask(runInputs(workingDir, implStateDir, new AbortController().signal), learnerPluginRoot);
      expect(captured).toBeDefined();
      // The lingering child AND its process group must be reaped, not leaked.
      expect(captured!.kill).toHaveBeenCalled();
      expect(killGroup).toHaveBeenCalledWith(captured!.pid, expect.any(String));
    } finally {
      rmSync(workingDir, { recursive: true, force: true });
      rmSync(implStateDir, { recursive: true, force: true });
    }
  }, 8000);

  it('resolves on the normal path (result then clean exit)', async () => {
    const calls: Array<{
      args: string[];
      options: { cwd?: string };
    }> = [];
    const spawnFn = vi.fn((
      _command: string,
      args: string[],
      options: { cwd?: string },
    ) => {
      calls.push({ args, options });
      return fakeClaudeChild('result-then-exit');
    });
    const workingDir = mkdtempSync(join(tmpdir(), 'jinn-claude-ok-work-'));
    const implStateDir = mkdtempSync(join(tmpdir(), 'jinn-claude-ok-state-'));
    try {
      const adapter = makeAdapter(spawnFn);
      await expect(
        adapter.runTask(runInputs(workingDir, implStateDir, new AbortController().signal), learnerPluginRoot),
      ).resolves.toBeUndefined();
      const call = calls[0]!;
      const prompt = call.args[call.args.indexOf('-p') + 1]!;
      expect(prompt).toContain(`- workingDir = ${workingDir}`);
      expect(prompt).toContain(`- taskWorkspaceDir = ${join(workingDir, 'repo')}`);
      expect(prompt).toContain('Task inspection, mutation, and verification must happen only in `taskWorkspaceDir`.');
      expect(prompt).toContain('Learner telemetry and harness artifacts must remain under `workingDir`.');
      expect(call.options.cwd).toBe(workingDir);
    } finally {
      rmSync(workingDir, { recursive: true, force: true });
      rmSync(implStateDir, { recursive: true, force: true });
    }
  }, 8000);

  it('does not crash with "write after end" when the child emits output after the terminal result', async () => {
    // Regression: the stdout/stderr 'data' handlers wrote to the log streams
    // unconditionally, but closeLogs() ends those streams on settle. A child
    // that emits bytes after the terminal result (common once a mid-session
    // tool-result envelope trips onResult early) then hit ERR_STREAM_WRITE_
    // AFTER_END, surfacing as an engine "tick: process failed: write after end".
    const spawnFn = vi.fn(() => fakeClaudeChild('result-then-late-output'));
    const workingDir = mkdtempSync(join(tmpdir(), 'jinn-claude-late-work-'));
    const implStateDir = mkdtempSync(join(tmpdir(), 'jinn-claude-late-state-'));
    const uncaught: Error[] = [];
    const onUncaught = (e: Error) => { uncaught.push(e); };
    process.on('uncaughtException', onUncaught);
    try {
      const adapter = makeAdapter(spawnFn);
      await expect(
        adapter.runTask(runInputs(workingDir, implStateDir, new AbortController().signal), learnerPluginRoot),
      ).resolves.toBeUndefined();
      // Let the post-result emissions flush through the (now-ended) streams.
      await new Promise((r) => setTimeout(r, 50));
      expect(uncaught.map((e) => e.message)).not.toContain('write after end');
    } finally {
      process.off('uncaughtException', onUncaught);
      rmSync(workingDir, { recursive: true, force: true });
      rmSync(implStateDir, { recursive: true, force: true });
    }
  }, 8000);

  it('rejects when the child crashes without a result (non-zero exit, not aborted)', async () => {
    const spawnFn = vi.fn(() => fakeClaudeChild('crash-no-result'));
    const workingDir = mkdtempSync(join(tmpdir(), 'jinn-claude-crash-work-'));
    const implStateDir = mkdtempSync(join(tmpdir(), 'jinn-claude-crash-state-'));
    try {
      const adapter = makeAdapter(spawnFn);
      await expect(
        adapter.runTask(runInputs(workingDir, implStateDir, new AbortController().signal), learnerPluginRoot),
      ).rejects.toThrow();
    } finally {
      rmSync(workingDir, { recursive: true, force: true });
      rmSync(implStateDir, { recursive: true, force: true });
    }
  }, 8000);
});

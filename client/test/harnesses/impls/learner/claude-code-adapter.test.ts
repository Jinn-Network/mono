import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  mode:
    | 'manual'
    | 'result-then-hang'
    | 'result-then-exit'
    | 'crash-no-result'
    | 'result-then-late-output',
): FakeClaudeChild {
  const child = new EventEmitter() as FakeClaudeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = null;
  child.pid = 4242;
  child.killed = false;
  child.kill = vi.fn(() => { child.killed = true; return true; });
  setImmediate(() => {
    if (mode === 'manual') return;
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

const fullTrainArtifactPaths = [
  ['orient', 'summary.json'],
  ['strategize', 'strategy.json'],
  ['plan', 'plan.json'],
  ['execute', 'summary.json'],
  ['debrief', 'analysis.json'],
  ['improve', 'summary.json'],
  ['memory-consolidation', 'consolidation_record.json'],
] as const;

function writeJsonArtifact(
  workingDir: string,
  phase: string,
  fileName: string,
  payload: Record<string, unknown> = {},
): void {
  const dir = join(workingDir, `.${phase}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, fileName), JSON.stringify(payload));
}

function writeFullTrainArtifacts(workingDir: string): void {
  for (const [phase, fileName] of fullTrainArtifactPaths) {
    writeJsonArtifact(workingDir, phase, fileName);
  }
}

function writePhases(
  workingDir: string,
  phases: readonly (typeof fullTrainArtifactPaths)[number][],
): void {
  for (const [phase, fileName] of phases) {
    writeJsonArtifact(workingDir, phase, fileName);
  }
}

function writeTask1196PartialOrientArtifacts(workingDir: string): void {
  writeJsonArtifact(workingDir, 'orient', 'goal-parse.json');
  writeJsonArtifact(workingDir, 'orient', 'world-state.json');
  writeJsonArtifact(workingDir, 'orient', 'own-history.json');
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
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

function runInputs(
  workingDir: string,
  implStateDir: string,
  abort: AbortSignal,
  options: {
    mode?: 'train' | 'frozen';
    phaseRange?: 'full' | 'pre-execute' | 'post-execute' | 'solve-only';
  } = {},
) {
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
    mode: options.mode ?? 'train',
    abort,
    ...(options.phaseRange
      ? { adapterEnv: { LEARNER_PHASE_RANGE: options.phaseRange } }
      : {}),
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
      writeFullTrainArtifacts(workingDir);
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
      writeFullTrainArtifacts(workingDir);
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
      writeFullTrainArtifacts(workingDir);
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

  it('keeps Task 1196 running across an intermediate result until terminal learner artifacts exist', async () => {
    let child: FakeClaudeChild | undefined;
    const spawnFn = vi.fn(() => {
      child = fakeClaudeChild('manual');
      return child;
    });
    const killGroup = vi.fn();
    const workingDir = mkdtempSync(join(tmpdir(), 'jinn-claude-multiturn-work-'));
    const implStateDir = mkdtempSync(join(tmpdir(), 'jinn-claude-multiturn-state-'));
    try {
      const adapter = makeAdapter(spawnFn, killGroup);
      const run = adapter.runTask(
        runInputs(workingDir, implStateDir, new AbortController().signal),
        learnerPluginRoot,
      );
      let outcome: 'pending' | 'resolved' | 'rejected' = 'pending';
      void run.then(
        () => { outcome = 'resolved'; },
        () => { outcome = 'rejected'; },
      );
      await nextTurn();

      writeTask1196PartialOrientArtifacts(workingDir);
      child!.stdout.emit(
        'data',
        Buffer.from('{"type":"result","subtype":"success"}\n'),
      );
      await nextTurn();

      expect(outcome).toBe('pending');
      expect(child!.kill).not.toHaveBeenCalled();
      expect(killGroup).not.toHaveBeenCalled();

      writeFullTrainArtifacts(workingDir);
      child!.stdout.emit(
        'data',
        Buffer.from('{"type":"result","subtype":"success"}\n'),
      );

      await expect(run).resolves.toBeUndefined();
      expect(child!.kill).toHaveBeenCalledWith('SIGTERM');
      expect(killGroup).toHaveBeenCalledWith(child!.pid, 'SIGTERM');
    } finally {
      rmSync(workingDir, { recursive: true, force: true });
      rmSync(implStateDir, { recursive: true, force: true });
    }
  }, 8000);

  it('settles a cached result on clean exit after terminal artifacts appear', async () => {
    let child: FakeClaudeChild | undefined;
    const spawnFn = vi.fn(() => {
      child = fakeClaudeChild('manual');
      return child;
    });
    const killGroup = vi.fn();
    const workingDir = mkdtempSync(join(tmpdir(), 'jinn-claude-cached-result-work-'));
    const implStateDir = mkdtempSync(join(tmpdir(), 'jinn-claude-cached-result-state-'));
    try {
      const adapter = makeAdapter(spawnFn, killGroup);
      const run = adapter.runTask(
        runInputs(workingDir, implStateDir, new AbortController().signal),
        learnerPluginRoot,
      );
      await nextTurn();

      writeTask1196PartialOrientArtifacts(workingDir);
      child!.stdout.emit(
        'data',
        Buffer.from('{"type":"result","subtype":"success"}\n'),
      );
      await nextTurn();
      expect(child!.kill).not.toHaveBeenCalled();

      writeFullTrainArtifacts(workingDir);
      child!.emit('exit', 0, null);

      await expect(run).resolves.toBeUndefined();
      expect(killGroup).not.toHaveBeenCalled();
    } finally {
      rmSync(workingDir, { recursive: true, force: true });
      rmSync(implStateDir, { recursive: true, force: true });
    }
  }, 8000);

  it('rejects a clean exit when only an intermediate result and partial artifacts exist', async () => {
    let child: FakeClaudeChild | undefined;
    const spawnFn = vi.fn(() => {
      child = fakeClaudeChild('manual');
      return child;
    });
    const workingDir = mkdtempSync(join(tmpdir(), 'jinn-claude-early-exit-work-'));
    const implStateDir = mkdtempSync(join(tmpdir(), 'jinn-claude-early-exit-state-'));
    try {
      const adapter = makeAdapter(spawnFn);
      const run = adapter.runTask(
        runInputs(workingDir, implStateDir, new AbortController().signal),
        learnerPluginRoot,
      );
      await nextTurn();

      writeTask1196PartialOrientArtifacts(workingDir);
      child!.stdout.emit(
        'data',
        Buffer.from('{"type":"result","subtype":"success"}\n'),
      );
      child!.emit('exit', 0, null);

      await expect(run).rejects.toThrow(/before learner terminal evidence/);
    } finally {
      rmSync(workingDir, { recursive: true, force: true });
      rmSync(implStateDir, { recursive: true, force: true });
    }
  }, 8000);

  it.each([
    {
      name: 'full/frozen',
      options: { mode: 'frozen' as const, phaseRange: 'full' as const },
      artifacts: fullTrainArtifactPaths.slice(0, 5),
    },
    {
      name: 'pre-execute/train',
      options: { mode: 'train' as const, phaseRange: 'pre-execute' as const },
      artifacts: fullTrainArtifactPaths.slice(0, 3),
    },
    {
      name: 'post-execute/frozen',
      options: { mode: 'frozen' as const, phaseRange: 'post-execute' as const },
      artifacts: [fullTrainArtifactPaths[4]],
    },
    {
      name: 'solve-only/frozen',
      options: { mode: 'frozen' as const, phaseRange: 'solve-only' as const },
      artifacts: fullTrainArtifactPaths.slice(0, 0),
    },
  ])('settles $name only from that mode and phase-range terminal contract', async ({
    options,
    artifacts,
  }) => {
    let child: FakeClaudeChild | undefined;
    const spawnFn = vi.fn(() => {
      child = fakeClaudeChild('manual');
      return child;
    });
    const killGroup = vi.fn();
    const workingDir = mkdtempSync(join(tmpdir(), 'jinn-claude-phase-range-work-'));
    const implStateDir = mkdtempSync(join(tmpdir(), 'jinn-claude-phase-range-state-'));
    try {
      writePhases(workingDir, artifacts);
      const adapter = makeAdapter(spawnFn, killGroup);
      const run = adapter.runTask(
        runInputs(
          workingDir,
          implStateDir,
          new AbortController().signal,
          options,
        ),
        learnerPluginRoot,
      );
      await nextTurn();
      child!.stdout.emit(
        'data',
        Buffer.from('{"type":"result","subtype":"success"}\n'),
      );

      await expect(run).resolves.toBeUndefined();
      expect(killGroup).toHaveBeenCalledWith(child!.pid, 'SIGTERM');
    } finally {
      rmSync(workingDir, { recursive: true, force: true });
      rmSync(implStateDir, { recursive: true, force: true });
    }
  }, 8000);

  it('rejects and reaps when a valid learner error artifact is terminal evidence', async () => {
    let child: FakeClaudeChild | undefined;
    const spawnFn = vi.fn(() => {
      child = fakeClaudeChild('manual');
      return child;
    });
    const killGroup = vi.fn();
    const workingDir = mkdtempSync(join(tmpdir(), 'jinn-claude-error-work-'));
    const implStateDir = mkdtempSync(join(tmpdir(), 'jinn-claude-error-state-'));
    try {
      writeJsonArtifact(workingDir, 'errors', 'plan.json', { phase: 'plan' });
      const adapter = makeAdapter(spawnFn, killGroup);
      const run = adapter.runTask(
        runInputs(workingDir, implStateDir, new AbortController().signal),
        learnerPluginRoot,
      );
      await nextTurn();
      child!.stdout.emit(
        'data',
        Buffer.from('{"type":"result","subtype":"success"}\n'),
      );

      await expect(run).rejects.toThrow(/terminal failure artifact.*plan\.json/);
      expect(killGroup).toHaveBeenCalledWith(child!.pid, 'SIGTERM');
    } finally {
      rmSync(workingDir, { recursive: true, force: true });
      rmSync(implStateDir, { recursive: true, force: true });
    }
  }, 8000);

  it('does not settle an intermediate result from a corrupt learner error artifact', async () => {
    let child: FakeClaudeChild | undefined;
    const spawnFn = vi.fn(() => {
      child = fakeClaudeChild('manual');
      return child;
    });
    const killGroup = vi.fn();
    const workingDir = mkdtempSync(join(tmpdir(), 'jinn-claude-corrupt-error-work-'));
    const implStateDir = mkdtempSync(join(tmpdir(), 'jinn-claude-corrupt-error-state-'));
    try {
      const errorsDir = join(workingDir, '.errors');
      mkdirSync(errorsDir, { recursive: true });
      writeFileSync(join(errorsDir, 'plan.json'), 'not-json{');
      const adapter = makeAdapter(spawnFn, killGroup);
      const run = adapter.runTask(
        runInputs(workingDir, implStateDir, new AbortController().signal),
        learnerPluginRoot,
      );
      let outcome: 'pending' | 'resolved' | 'rejected' = 'pending';
      void run.then(
        () => { outcome = 'resolved'; },
        () => { outcome = 'rejected'; },
      );
      await nextTurn();
      child!.stdout.emit(
        'data',
        Buffer.from('{"type":"result","subtype":"success"}\n'),
      );
      await nextTurn();

      expect(outcome).toBe('pending');
      expect(killGroup).not.toHaveBeenCalled();

      child!.emit('exit', 0, null);
      await expect(run).rejects.toThrow(/before learner terminal evidence/);
    } finally {
      rmSync(workingDir, { recursive: true, force: true });
      rmSync(implStateDir, { recursive: true, force: true });
    }
  }, 8000);

  it('preserves window-abort resolution with incomplete terminal artifacts', async () => {
    let child: FakeClaudeChild | undefined;
    const spawnFn = vi.fn(() => {
      child = fakeClaudeChild('manual');
      return child;
    });
    const killGroup = vi.fn();
    const workingDir = mkdtempSync(join(tmpdir(), 'jinn-claude-abort-work-'));
    const implStateDir = mkdtempSync(join(tmpdir(), 'jinn-claude-abort-state-'));
    const controller = new AbortController();
    try {
      const adapter = makeAdapter(spawnFn, killGroup);
      const run = adapter.runTask(
        runInputs(workingDir, implStateDir, controller.signal),
        learnerPluginRoot,
      );
      await nextTurn();

      writeTask1196PartialOrientArtifacts(workingDir);
      controller.abort();
      child!.emit('exit', null, 'SIGTERM');

      await expect(run).resolves.toBeUndefined();
      expect(killGroup).toHaveBeenCalledWith(child!.pid, 'SIGTERM');
    } finally {
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

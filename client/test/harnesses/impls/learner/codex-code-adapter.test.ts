import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { SweRebenchV2SolutionPayloadSchema } from '@jinn-network/sdk/solvernets/swe-rebench-v2';
import {
  LearnerHarness,
  CodexCodeHarnessAdapter,
} from '../../../../src/harnesses/impls/learner/index.js';
import { fakeFullPipelineRun } from '../../../../src/harnesses/impls/learner/test-utils/fake-plugin-outputs.js';
import type { HarnessContext } from '../../../../src/harnesses/types.js';
import type { Task } from '../../../../src/types/task.js';

const learnerPluginRoot = fileURLToPath(new URL('../../../../plugins/learner/', import.meta.url));
const sweRuntimePluginRoot = fileURLToPath(new URL('../../../../plugins/swe-rebench-v2-runtime/', import.meta.url));
const networkToolsPluginRoot = fileURLToPath(new URL('../../../../plugins/network-tools/', import.meta.url));

type SpawnCall = {
  command: string;
  args: string[];
  options: { env?: NodeJS.ProcessEnv; cwd?: string };
};

type FakeCodexChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: PassThrough & { end: ReturnType<typeof vi.fn> };
  /** Chunks captured from the stdin stream as utf8 strings. */
  stdinChunks: string[];
  pid: number;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
};

function fakeCodexChild(
  onSpawn?: (options: { env?: NodeJS.ProcessEnv; cwd?: string }) => void,
  opts: {
    emitErrorOnSpawn?: boolean;
    /**
     * Terminal-marker behaviour (#895). Default 'configured-then-exit'
     * preserves the legacy emit: {"type":"session_configured"} then exit 0.
     * - 'turn-completed-then-hang': emit {"type":"turn.completed",...} and
     *   then NEVER emit exit (reproduces the #883/#895 hang).
     * - 'turn-completed-then-exit': emit the marker then a clean exit 0.
     * - 'turn-failed-then-hang': emit {"type":"turn.failed",...} then NEVER exit.
     * - 'crash-no-marker': emit some stderr then exit(1) with NO terminal
     *   marker (exercises the child.on('exit') fallback: code!==0, not aborted).
     */
    mode?:
      | 'configured-then-exit'
      | 'turn-completed-then-hang'
      | 'turn-completed-then-exit'
      | 'turn-failed-then-hang'
      | 'crash-no-marker';
  } = {},
): FakeCodexChild {
  const child = new EventEmitter() as FakeCodexChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const stdin = new PassThrough();
  const stdinChunks: string[] = [];
  stdin.on('data', (chunk: Buffer) => {
    stdinChunks.push(chunk.toString('utf8'));
  });
  // Wrap stdin.end so the test can assert it was called exactly once.
  const realEnd = stdin.end.bind(stdin);
  const endMock = vi.fn((chunk?: unknown, encoding?: unknown, cb?: unknown) => {
    return realEnd(chunk as never, encoding as never, cb as never);
  });
  (stdin as unknown as { end: typeof endMock }).end = endMock;
  child.stdin = stdin as FakeCodexChild['stdin'];
  child.stdinChunks = stdinChunks;
  child.pid = 5151;
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  const mode = opts.mode ?? 'configured-then-exit';
  setImmediate(() => {
    onSpawn?.({});
    if (opts.emitErrorOnSpawn) {
      child.emit('error', new Error('spawn codex ENOENT'));
      return;
    }
    if (mode === 'turn-completed-then-hang') {
      child.stdout.emit('data', Buffer.from('{"type":"session_configured"}\n'));
      child.stdout.emit(
        'data',
        Buffer.from('{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":20}}\n'),
      );
      // intentionally NEVER emits exit — reproduces #883/#895 (codex emits its
      // terminal turn marker but the process lingers, held open by a leaked
      // tool subprocess keeping the event loop alive).
      return;
    }
    if (mode === 'turn-completed-then-exit') {
      child.stdout.emit('data', Buffer.from('{"type":"session_configured"}\n'));
      child.stdout.emit(
        'data',
        Buffer.from('{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":20}}\n'),
      );
      child.emit('exit', 0, null);
      return;
    }
    if (mode === 'turn-failed-then-hang') {
      child.stdout.emit('data', Buffer.from('{"type":"session_configured"}\n'));
      child.stdout.emit(
        'data',
        Buffer.from('{"type":"turn.failed","error":{"message":"model refused the task"}}\n'),
      );
      // never exits — settle must come from the failure marker, not exit.
      return;
    }
    if (mode === 'crash-no-marker') {
      // No terminal marker at all — codex crashes mid-turn. Settle must come
      // from the child.on('exit') fallback (code=1, not aborted → reject).
      child.stderr.emit('data', Buffer.from('boom\n'));
      child.emit('exit', 1, null);
      return;
    }
    // 'configured-then-exit' (legacy default): preserve existing test behaviour.
    child.stdout.emit('data', Buffer.from('{"type":"session_configured"}\n'));
    child.emit('exit', 0, null);
  });
  return child;
}

function sweTask(): Task {
  return {
    id: 'swe-rebench-task-restoration',
    description: 'swe-rebench-v2 restoration task',
    solverType: 'swe-rebench-v2.v1',
    role: 'restoration',
    window: { startTs: 0, endTs: Date.now() + 60_000 },
    spec: {
      schemaVersion: 'swe-rebench-v2.v1',
      instance_id: 'unidata__netcdf-c-1925',
      repo: 'Unidata/netcdf-c',
      base_commit: 'a'.repeat(40),
      language: 'c',
      problem_statement: 'fix the netcdf bug',
      interface: '',
      hf_dataset: 'nebius/SWE-rebench-leaderboard',
      hf_split: '2026_02',
      deadline_unix: Math.floor(Date.now() / 1000) + 3600,
      round_month: '2026-05',
    },
  };
}

function context(workingDir: string, implStateDir: string): HarnessContext {
  return {
    task: sweTask(),
    requestId: '0x' + '7'.repeat(64),
    solverNet: {
      name: 'SWE-rebench v2',
      solverType: 'swe-rebench-v2.v1',
      model: 'gpt-5.4-mini',
    },
    solverPluginRoots: [sweRuntimePluginRoot, networkToolsPluginRoot],
    implStateDir,
    workingDir,
    log: () => undefined,
    abort: new AbortController().signal,
    msUntilEndTs: () => 60_000,
    trajectory: { addSpan: () => undefined } as unknown as HarnessContext['trajectory'],
    mode: 'train',
  };
}

function writeTypedPayload(workingDir: string): void {
  mkdirSync(join(workingDir, '.execute'), { recursive: true });
  writeFileSync(join(workingDir, '.execute', 'solution-payload.json'), JSON.stringify({
    schemaVersion: 'swe-rebench-v2-solution.v1',
    patch: '--- a/src/example.c\n+++ b/src/example.c\n@@ -1 +1 @@\n-old\n+new\n',
  }, null, 2));
}

function runInputs(workingDir: string, implStateDir: string, abort: AbortSignal) {
  return {
    taskId: 'swe-rebench-task-restoration',
    requestId: '0x' + '7'.repeat(64),
    solverType: 'swe-rebench-v2.v1',
    taskBody: sweTask() as never,
    implStateDir,
    workingDir,
    pluginRoots: [sweRuntimePluginRoot, networkToolsPluginRoot],
    windowStartTs: 1,
    windowEndTs: 2,
    msUntilEndTs: 3_600_000,
    mode: 'train' as const,
    abort,
  };
}

function makeReapAdapter(
  spawnFn: unknown,
  killProcessGroup: (pid: number, sig: NodeJS.Signals) => void = () => {},
): CodexCodeHarnessAdapter {
  return new CodexCodeHarnessAdapter({
    codexPath: 'codex-test',
    clientRoot: '/client/root',
    _spawnFn: spawnFn as never,
    _runSessionStartHook: false,
    // Inject a no-op group-kill so tests never fire a real signal at a real
    // process group (the fake child's pid is arbitrary).
    _killProcessGroup: killProcessGroup,
  });
}

describe('CodexCodeHarnessAdapter', () => {
  it('keeps learner plugin subagent guidance harness-agnostic', () => {
    const skill = readFileSync(join(learnerPluginRoot, 'skills', 'learn', 'SKILL.md'), 'utf8');

    expect(skill).toContain('## Uniform dispatch shape');
    expect(skill).toContain('Use the dispatch, wait, and release primitives exposed by the current harness');
    expect(skill).toContain('Release/close completed subagents');
    expect(skill).toContain('Pass absolute filesystem paths in subagent inputs');
    expect(skill).not.toContain('### Codex host dispatch');
    expect(skill).not.toContain('spawn_agent({ message: <full role prompt plus inputs>, fork_context: false })');
    expect(skill).not.toContain('do not call spawn_agent');
  });

  it('uses JINN_CODEX_PATH when no codexPath is configured', async () => {
    const previous = process.env['JINN_CODEX_PATH'];
    process.env['JINN_CODEX_PATH'] = 'codex-env-test';
    const calls: SpawnCall[] = [];
    const spawnFn = vi.fn((command: string, args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string }) => {
      calls.push({ command, args, options });
      return fakeCodexChild();
    });
    const workingDir = mkdtempSync(join(tmpdir(), 'jinn-codex-env-work-'));
    const implStateDir = mkdtempSync(join(tmpdir(), 'jinn-codex-env-state-'));
    try {
      const adapter = new CodexCodeHarnessAdapter({
        clientRoot: '/client/root',
        _spawnFn: spawnFn as never,
        _runSessionStartHook: false,
      });

      await adapter.runTask({
        taskId: 'swe-rebench-task-restoration',
        requestId: '0x' + '7'.repeat(64),
        solverType: 'swe-rebench-v2.v1',
        taskBody: sweTask() as never,
        implStateDir,
        workingDir,
        taskWorkspaceDir: join(workingDir, 'repo'),
        pluginRoots: [sweRuntimePluginRoot, networkToolsPluginRoot],
        windowStartTs: 1,
        windowEndTs: 2,
        msUntilEndTs: 1,
        mode: 'train',
        abort: new AbortController().signal,
      }, learnerPluginRoot);

      expect(calls[0]!.command).toBe('codex-env-test');
      expect(calls[0]!.options.env?.JINN_CODEX_PATH).toBe('codex-env-test');
    } finally {
      if (previous === undefined) delete process.env['JINN_CODEX_PATH'];
      else process.env['JINN_CODEX_PATH'] = previous;
      rmSync(workingDir, { recursive: true, force: true });
      rmSync(implStateDir, { recursive: true, force: true });
    }
  });

  it('spawns codex exec with per-run plugin projection, MCP config, and cheap model', async () => {
    const calls: SpawnCall[] = [];
    let captured: FakeCodexChild | undefined;
    const spawnFn = vi.fn((command: string, args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string }) => {
      calls.push({ command, args, options });
      captured = fakeCodexChild();
      return captured;
    });
    const workingDir = mkdtempSync(join(tmpdir(), 'jinn-codex-adapter-work-'));
    const implStateDir = mkdtempSync(join(tmpdir(), 'jinn-codex-adapter-state-'));
    try {
      const adapter = new CodexCodeHarnessAdapter({
        codexPath: 'codex-test',
        codexModel: 'gpt-5.4-mini',
        clientRoot: '/client/root',
        storePath: '/tmp/jinn-test.db',
        daemonApiUrl: 'http://127.0.0.1:7332',
        daemonApiToken: 'test-token',
        corpusEnv: {
          discoveryUrl: 'https://subgraph.example',
          ipfsGatewayUrl: 'https://ipfs.example',
        },
        _spawnFn: spawnFn as never,
        _runSessionStartHook: false,
      });

      await adapter.runTask({
        taskId: 'swe-rebench-task-restoration',
        requestId: '0x' + '7'.repeat(64),
        solverType: 'swe-rebench-v2.v1',
        model: 'gpt-5.4-mini',
        taskBody: sweTask() as never,
        implStateDir,
        workingDir,
        taskWorkspaceDir: join(workingDir, 'repo'),
        pluginRoots: [sweRuntimePluginRoot, networkToolsPluginRoot],
        windowStartTs: 1,
        windowEndTs: 2,
        msUntilEndTs: 1,
        mode: 'train',
        abort: new AbortController().signal,
      }, learnerPluginRoot);

      expect(calls).toHaveLength(1);
      expect(calls[0]!.command).toBe('codex-test');
      expect(calls[0]!.args).toEqual(expect.arrayContaining([
        'exec',
        '--json',
        '--ignore-user-config',
        '--disable',
        'plugins',
        '--sandbox',
        'danger-full-access',
        '--dangerously-bypass-approvals-and-sandbox',
        '-C',
        workingDir,
        '-m',
        'gpt-5.4-mini',
      ]));
      expect(calls[0]!.args).toEqual(expect.arrayContaining([
        '-c',
        'mcp_servers.jinn-client.command="node"',
        '-c',
        'mcp_servers.jinn-client.args=["mcp/jinn-client-server.mjs"]',
      ]));
      // Prompt is piped to codex stdin (#675), not passed as a positional
      // argument. Read it back from the captured stdin chunks.
      expect(captured).toBeDefined();
      const promptArg = captured!.stdinChunks.join('');
      expect(promptArg).toContain('You are executing a Jinn task');
      expect(promptArg).toContain('Use the available skills, plugins, tools, and runtime context exposed by this harness');
      expect(promptArg).toContain('typed SolverNet payload');
      // Generic submission guidance lives in the prompt; SolverNet-specific
      // pattern (repo setup, schema shape, etc.) lives in the SolverPlugin's
      // SKILL.md files — see swe-rebench-v2-runtime/skills/task/.
      expect(promptArg).toContain('call submit_typed_payload');
      expect(promptArg).toContain('.execute/solution-payload.json');
      // Regression guard: ensure no SolverNet-specific guidance leaks back
      // into the adapter's prompt builder. The retired sweRebenchV2Guidance()
      // helper baked these strings in; if they reappear, the plugin-driven
      // architecture is being undone.
      expect(promptArg).not.toContain('SWE-rebench v2 restoration requirements');
      expect(promptArg).not.toContain('clone https://github.com/');
      expect(promptArg).not.toContain('"schemaVersion":"swe-rebench-v2-solution.v1"');
      // Other negative regression guards from earlier refactors.
      expect(promptArg).not.toContain('submit_typed_payload, or write');
      expect(promptArg).not.toContain('submission tool or write the expected payload file');
      expect(promptArg).not.toContain('claude-code-learner:learn');
      expect(promptArg).not.toContain('Subagent dispatch is available as `spawn_agent`');
      expect(promptArg).not.toContain('Do not pass both `message` and `items`');
      expect(promptArg).not.toContain('fork_context: false');
      expect(promptArg).not.toContain('swe-rebench-v2-orient');
      expect(promptArg).not.toContain('swe-rebench-v2-plan');
      expect(promptArg).not.toContain('do not call spawn_agent');
      // The full task body still rides in the prompt so SolverPlugin skills
      // can read goal.spec.repo / goal.spec.base_commit at runtime.
      expect(promptArg).toContain('goal (full body)');
      expect(promptArg).toContain('swe-rebench-v2.v1');
      expect(promptArg).toContain(`- workingDir = ${workingDir}`);
      expect(promptArg).toContain(`- taskWorkspaceDir = ${join(workingDir, 'repo')}`);
      expect(promptArg).toContain('Task inspection, mutation, and verification must happen only in `taskWorkspaceDir`.');
      expect(promptArg).toContain('Learner telemetry and harness artifacts must remain under `workingDir`.');

      expect(calls[0]!.options.cwd).toBe(workingDir);
      expect(calls[0]!.options.env).toMatchObject({
        IMPL_STATE_DIR: implStateDir,
        WORKING_DIR: workingDir,
        JINN_WORKING_DIR: workingDir,
        PLUGIN_ROOT: learnerPluginRoot,
        JINN_CLAUDE_CODE_LEARNER_PLUGIN_ROOT: learnerPluginRoot,
        DESIRED_STATE_ID: 'swe-rebench-task-restoration',
        DESIRED_STATE_ROLE: 'restoration',
        DESIRED_STATE_SOLVER_TYPE: 'swe-rebench-v2.v1',
        REQUEST_ID: '0x' + '7'.repeat(64),
        STORE_PATH: '/tmp/jinn-test.db',
        DAEMON_API_URL: 'http://127.0.0.1:7332',
        DAEMON_API_TOKEN: 'test-token',
        JINN_DISCOVERY_URL: 'https://subgraph.example',
        JINN_DISCOVERY_MODE: 'http',
        JINN_CORPUS_IPFS_GATEWAY_URL: 'https://ipfs.example',
      });
      expect(existsSync(join(workingDir, '.agents', 'skills', 'claude-code-learner__learn', 'SKILL.md'))).toBe(true);
      expect(existsSync(join(workingDir, '.agents', 'skills', 'swe-rebench-v2-runtime__task', 'SKILL.md'))).toBe(true);
      expect(existsSync(join(workingDir, '.agents', 'plugins', 'marketplace.json'))).toBe(true);
      expect(readFileSync(join(workingDir, '.codex-code', 'stdout.jsonl'), 'utf8')).toContain('session_configured');
    } finally {
      rmSync(workingDir, { recursive: true, force: true });
      rmSync(implStateDir, { recursive: true, force: true });
    }
  });

  it('injects SessionStart additionalContext from the learner hook into the Codex prompt', async () => {
    const calls: SpawnCall[] = [];
    let captured: FakeCodexChild | undefined;
    const spawnFn = vi.fn((command: string, args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string }) => {
      calls.push({ command, args, options });
      captured = fakeCodexChild();
      return captured;
    });
    const hookFn = vi.fn(() => ({
      status: 0,
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: 'A seven-phase self-improvement loop is available as the learn skill (claude-code-learner:learn). Your FIRST action MUST be to invoke it.',
        },
      }),
      stderr: '',
    }));
    const workingDir = mkdtempSync(join(tmpdir(), 'jinn-codex-hook-work-'));
    const implStateDir = mkdtempSync(join(tmpdir(), 'jinn-codex-hook-state-'));
    try {
      const adapter = new CodexCodeHarnessAdapter({
        codexPath: 'codex-test',
        clientRoot: '/client/root',
        _spawnFn: spawnFn as never,
        _spawnSyncFn: hookFn as never,
      });

      await adapter.runTask({
        taskId: 'swe-rebench-task-restoration',
        requestId: '0x' + '7'.repeat(64),
        solverType: 'swe-rebench-v2.v1',
        taskBody: sweTask() as never,
        implStateDir,
        workingDir,
        pluginRoots: [sweRuntimePluginRoot, networkToolsPluginRoot],
        windowStartTs: 1,
        windowEndTs: 2,
        msUntilEndTs: 1,
        mode: 'train',
        abort: new AbortController().signal,
      }, learnerPluginRoot);

      expect(hookFn).toHaveBeenCalledWith(
        '/bin/bash',
        [join(learnerPluginRoot, 'hooks', 'session-start')],
        expect.objectContaining({
          cwd: workingDir,
          encoding: 'utf8',
          env: expect.objectContaining({
            JINN_HARNESS_MODE: 'train',
            IMPL_STATE_DIR: implStateDir,
          }),
        }),
      );
      expect(captured).toBeDefined();
      const promptArg = captured!.stdinChunks.join('');
      expect(promptArg).toContain('Session start context:');
      expect(promptArg).toContain('claude-code-learner:learn');
      expect(promptArg).toContain('FIRST action MUST be to invoke it');
      expect(promptArg).not.toContain('"schemaVersion":"swe-rebench-v2-solution.v1"');
    } finally {
      rmSync(workingDir, { recursive: true, force: true });
      rmSync(implStateDir, { recursive: true, force: true });
    }
  });

  it('fails before spawning Codex when the session-start hook fails', async () => {
    const spawnFn = vi.fn();
    const hookFn = vi.fn(() => ({
      status: 1,
      stdout: '',
      stderr: 'session-start exploded',
    }));
    const workingDir = mkdtempSync(join(tmpdir(), 'jinn-codex-hook-fail-work-'));
    const implStateDir = mkdtempSync(join(tmpdir(), 'jinn-codex-hook-fail-state-'));
    try {
      const adapter = new CodexCodeHarnessAdapter({
        codexPath: 'codex-test',
        clientRoot: '/client/root',
        _spawnFn: spawnFn as never,
        _spawnSyncFn: hookFn as never,
      });

      await expect(adapter.runTask({
        taskId: 'swe-rebench-task-restoration',
        requestId: '0x' + '7'.repeat(64),
        solverType: 'swe-rebench-v2.v1',
        taskBody: sweTask() as never,
        implStateDir,
        workingDir,
        pluginRoots: [sweRuntimePluginRoot, networkToolsPluginRoot],
        windowStartTs: 1,
        windowEndTs: 2,
        msUntilEndTs: 1,
        mode: 'train',
        abort: new AbortController().signal,
      }, learnerPluginRoot)).rejects.toThrow('session-start exploded');
      expect(spawnFn).not.toHaveBeenCalled();
    } finally {
      rmSync(workingDir, { recursive: true, force: true });
      rmSync(implStateDir, { recursive: true, force: true });
    }
  });

  it('ignores malformed session-start hook stdout instead of crashing Codex startup', async () => {
    let captured: FakeCodexChild | undefined;
    const spawnFn = vi.fn(() => {
      captured = fakeCodexChild();
      return captured;
    });
    const hookFn = vi.fn(() => ({
      status: 0,
      stdout: 'session-start: ready, but not json',
      stderr: '',
    }));
    const workingDir = mkdtempSync(join(tmpdir(), 'jinn-codex-hook-malformed-work-'));
    const implStateDir = mkdtempSync(join(tmpdir(), 'jinn-codex-hook-malformed-state-'));
    try {
      const adapter = new CodexCodeHarnessAdapter({
        codexPath: 'codex-test',
        clientRoot: '/client/root',
        _spawnFn: spawnFn as never,
        _spawnSyncFn: hookFn as never,
      });

      await adapter.runTask({
        taskId: 'swe-rebench-task-restoration',
        requestId: '0x' + '7'.repeat(64),
        solverType: 'swe-rebench-v2.v1',
        taskBody: sweTask() as never,
        implStateDir,
        workingDir,
        pluginRoots: [sweRuntimePluginRoot, networkToolsPluginRoot],
        windowStartTs: 1,
        windowEndTs: 2,
        msUntilEndTs: 1,
        mode: 'train',
        abort: new AbortController().signal,
      }, learnerPluginRoot);

      expect(captured).toBeDefined();
      const promptArg = captured!.stdinChunks.join('');
      expect(promptArg).toContain('You are executing a Jinn task');
      expect(promptArg).not.toContain('Session start context:');
      expect(promptArg).not.toContain('session-start: ready, but not json');
    } finally {
      rmSync(workingDir, { recursive: true, force: true });
      rmSync(implStateDir, { recursive: true, force: true });
    }
  });

  // Regression for #675 — @openai/codex@0.133.0 detects a non-TTY-with-no-data
  // stdin as a hard error and exits before reading the positional [PROMPT].
  // The fix pipes the prompt to child.stdin and drops the positional arg.
  it('pipes the prompt to codex stdin, not as a positional argument (#675)', async () => {
    const calls: SpawnCall[] = [];
    let captured: FakeCodexChild | undefined;
    const spawnFn = vi.fn((command: string, args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string; stdio?: unknown }) => {
      calls.push({ command, args, options });
      captured = fakeCodexChild();
      return captured;
    });
    const workingDir = mkdtempSync(join(tmpdir(), 'jinn-codex-stdin-work-'));
    const implStateDir = mkdtempSync(join(tmpdir(), 'jinn-codex-stdin-state-'));
    try {
      const adapter = new CodexCodeHarnessAdapter({
        codexPath: 'codex-test',
        clientRoot: '/client/root',
        _spawnFn: spawnFn as never,
        _runSessionStartHook: false,
      });

      await adapter.runTask({
        taskId: 'swe-rebench-task-restoration',
        requestId: '0x' + '7'.repeat(64),
        solverType: 'swe-rebench-v2.v1',
        taskBody: sweTask() as never,
        implStateDir,
        workingDir,
        pluginRoots: [sweRuntimePluginRoot, networkToolsPluginRoot],
        windowStartTs: 1,
        windowEndTs: 2,
        msUntilEndTs: 1,
        mode: 'train',
        abort: new AbortController().signal,
      }, learnerPluginRoot);

      // stdio[0] must be 'pipe' so codex 0.133.0+ reads the prompt as input,
      // not flag a non-TTY-with-no-data stdin as a fatal config error.
      const opts = calls[0]!.options as { stdio?: unknown };
      expect(Array.isArray(opts.stdio)).toBe(true);
      expect((opts.stdio as unknown[])[0]).toBe('pipe');
      // The prompt must travel through stdin, not on argv.
      expect(captured).toBeDefined();
      const stdinBody = captured!.stdinChunks.join('');
      expect(stdinBody).toContain('You are executing a Jinn task');
      expect(captured!.stdin.end).toHaveBeenCalledTimes(1);
      // argv must not contain the prompt body.
      expect(calls[0]!.args).not.toContain(stdinBody);
      for (const arg of calls[0]!.args) {
        expect(arg).not.toContain('You are executing a Jinn task');
      }
    } finally {
      rmSync(workingDir, { recursive: true, force: true });
      rmSync(implStateDir, { recursive: true, force: true });
    }
  });

  it('closes stdin even when the child errors before reading the prompt (#675)', async () => {
    let captured: FakeCodexChild | undefined;
    const spawnFn = vi.fn(() => {
      captured = fakeCodexChild(undefined, { emitErrorOnSpawn: true });
      return captured;
    });
    const workingDir = mkdtempSync(join(tmpdir(), 'jinn-codex-stdin-err-work-'));
    const implStateDir = mkdtempSync(join(tmpdir(), 'jinn-codex-stdin-err-state-'));
    try {
      const adapter = new CodexCodeHarnessAdapter({
        codexPath: 'codex-test',
        clientRoot: '/client/root',
        _spawnFn: spawnFn as never,
        _runSessionStartHook: false,
      });

      await expect(
        adapter.runTask({
          taskId: 'swe-rebench-task-restoration',
          requestId: '0x' + '7'.repeat(64),
          solverType: 'swe-rebench-v2.v1',
          taskBody: sweTask() as never,
          implStateDir,
          workingDir,
          pluginRoots: [sweRuntimePluginRoot, networkToolsPluginRoot],
          windowStartTs: 1,
          windowEndTs: 2,
          msUntilEndTs: 1,
          mode: 'train',
          abort: new AbortController().signal,
        }, learnerPluginRoot),
      ).rejects.toThrow();

      expect(captured).toBeDefined();
      expect(captured!.stdin.end).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(workingDir, { recursive: true, force: true });
      rmSync(implStateDir, { recursive: true, force: true });
    }
  });

  it('round-trips swe-rebench solution payload through Codex adapter and learner harvester', async () => {
    const spawnFn = vi.fn((_command: string, _args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string }) =>
      fakeCodexChild(() => {
        const cwd = options.cwd!;
        fakeFullPipelineRun(cwd, {
          taskId: 'swe-rebench-task-restoration',
          solverType: 'swe-rebench-v2.v1',
        });
        writeTypedPayload(cwd);
      })
    );
    const workingDir = mkdtempSync(join(tmpdir(), 'jinn-codex-roundtrip-work-'));
    const implStateDir = mkdtempSync(join(tmpdir(), 'jinn-codex-roundtrip-state-'));
    try {
      const adapter = new CodexCodeHarnessAdapter({
        codexPath: 'codex-test',
        clientRoot: '/client/root',
        _spawnFn: spawnFn as never,
        _runSessionStartHook: false,
      });
      const harness = new LearnerHarness({
        name: 'codex-code-learner',
        adapter,
        pluginRoot: learnerPluginRoot,
      });

      const sol = await harness.run(context(workingDir, implStateDir));

      expect(sol.solutionPayload).toBeDefined();
      expect(() => SweRebenchV2SolutionPayloadSchema.parse(sol.solutionPayload)).not.toThrow();
      expect((sol.solutionPayload as Record<string, unknown>)['schemaVersion']).toBe('swe-rebench-v2-solution.v1');
      expect((sol.solutionPayload as Record<string, unknown>)['patch']).toContain('-old');
      expect(sol.artifacts?.find((a) => a.path === '.execute/solution-payload.json')?.artifactType)
        .toBe('swe-rebench-v2_v1_solution');
    } finally {
      rmSync(workingDir, { recursive: true, force: true });
      rmSync(implStateDir, { recursive: true, force: true });
    }
  });
});

describe('CodexCodeHarnessAdapter — completion + subprocess reaping (#895)', () => {
  it('resolves on the terminal turn.completed marker even when the child never exits, and reaps it', async () => {
    let captured: FakeCodexChild | undefined;
    const spawnFn = vi.fn(() => {
      captured = fakeCodexChild(undefined, { mode: 'turn-completed-then-hang' });
      return captured;
    });
    const killGroup = vi.fn();
    const workingDir = mkdtempSync(join(tmpdir(), 'jinn-codex-hang-work-'));
    const implStateDir = mkdtempSync(join(tmpdir(), 'jinn-codex-hang-state-'));
    try {
      const adapter = makeReapAdapter(spawnFn, killGroup);
      // Pre-fix this never resolves (adapter waits on child 'exit', which never
      // fires) and the test times out. Post-fix it resolves on the
      // turn.completed line.
      await adapter.runTask(
        runInputs(workingDir, implStateDir, new AbortController().signal),
        learnerPluginRoot,
      );
      expect(captured).toBeDefined();
      // The lingering child AND its process group must be reaped, not leaked.
      expect(captured!.kill).toHaveBeenCalled();
      expect(killGroup).toHaveBeenCalledWith(captured!.pid, expect.any(String));
    } finally {
      rmSync(workingDir, { recursive: true, force: true });
      rmSync(implStateDir, { recursive: true, force: true });
    }
  }, 8000);

  it('rejects on the terminal turn.failed marker even when the child never exits', async () => {
    let captured: FakeCodexChild | undefined;
    const spawnFn = vi.fn(() => {
      captured = fakeCodexChild(undefined, { mode: 'turn-failed-then-hang' });
      return captured;
    });
    const killGroup = vi.fn();
    const workingDir = mkdtempSync(join(tmpdir(), 'jinn-codex-fail-work-'));
    const implStateDir = mkdtempSync(join(tmpdir(), 'jinn-codex-fail-state-'));
    try {
      const adapter = makeReapAdapter(spawnFn, killGroup);
      await expect(
        adapter.runTask(
          runInputs(workingDir, implStateDir, new AbortController().signal),
          learnerPluginRoot,
        ),
      ).rejects.toThrow(/turn\.failed/);
      // Failure path still reaps the child AND its group so neither is leaked.
      expect(captured!.kill).toHaveBeenCalled();
      expect(killGroup).toHaveBeenCalledWith(captured!.pid, expect.any(String));
    } finally {
      rmSync(workingDir, { recursive: true, force: true });
      rmSync(implStateDir, { recursive: true, force: true });
    }
  }, 8000);

  it('resolves on the normal path (turn.completed then clean exit)', async () => {
    const spawnFn = vi.fn(() => fakeCodexChild(undefined, { mode: 'turn-completed-then-exit' }));
    const workingDir = mkdtempSync(join(tmpdir(), 'jinn-codex-ok-work-'));
    const implStateDir = mkdtempSync(join(tmpdir(), 'jinn-codex-ok-state-'));
    try {
      const adapter = makeReapAdapter(spawnFn);
      await expect(
        adapter.runTask(
          runInputs(workingDir, implStateDir, new AbortController().signal),
          learnerPluginRoot,
        ),
      ).resolves.toBeUndefined();
    } finally {
      rmSync(workingDir, { recursive: true, force: true });
      rmSync(implStateDir, { recursive: true, force: true });
    }
  }, 8000);

  it('rejects when the child crashes without a terminal marker (non-zero exit, not aborted)', async () => {
    const spawnFn = vi.fn(() => fakeCodexChild(undefined, { mode: 'crash-no-marker' }));
    const workingDir = mkdtempSync(join(tmpdir(), 'jinn-codex-crash-work-'));
    const implStateDir = mkdtempSync(join(tmpdir(), 'jinn-codex-crash-state-'));
    try {
      const adapter = makeReapAdapter(spawnFn);
      // No marker fires; settle must come from the child.on('exit') fallback,
      // which rejects on code!==0 when not aborted.
      await expect(
        adapter.runTask(
          runInputs(workingDir, implStateDir, new AbortController().signal),
          learnerPluginRoot,
        ),
      ).rejects.toThrow(/code=1/);
    } finally {
      rmSync(workingDir, { recursive: true, force: true });
      rmSync(implStateDir, { recursive: true, force: true });
    }
  }, 8000);
});

function authPolicyJwt(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString(
    'base64url',
  );
  const payload = Buffer.from(JSON.stringify({ sub: 'operator', exp: expSeconds })).toString(
    'base64url',
  );
  return `${header}.${payload}.signature`;
}

describe('CodexCodeHarnessAdapter — task-scoped ChatGPT OAuth policy', () => {
  it.each([
    ['omitted', undefined],
    ['compatible', 'compatible' as const],
  ])('keeps the generic %s policy API-key compatible', async (_name, policy) => {
    const previousKey = process.env['OPENAI_API_KEY'];
    process.env['OPENAI_API_KEY'] = 'generic-api-key-secret';
    const spawnFn = vi.fn((_command: string, _args: string[], _options: unknown) =>
      fakeCodexChild()
    );
    const inspectOAuth = vi.fn(() => ({
      ready: false as const,
      reason: 'must not be consulted for generic sessions',
    }));
    const workingDir = mkdtempSync(join(tmpdir(), 'jinn-codex-compatible-work-'));
    const implStateDir = mkdtempSync(join(tmpdir(), 'jinn-codex-compatible-state-'));
    try {
      const adapter = new CodexCodeHarnessAdapter({
        codexPath: 'codex-test',
        clientRoot: '/client/root',
        _spawnFn: spawnFn as never,
        _runSessionStartHook: false,
        _inspectOAuth: inspectOAuth,
      });
      await adapter.runTask({
        ...runInputs(workingDir, implStateDir, new AbortController().signal),
        ...(policy === undefined ? {} : { codexAuthPolicy: policy }),
      }, learnerPluginRoot);

      expect(inspectOAuth).not.toHaveBeenCalled();
      expect(spawnFn).toHaveBeenCalledOnce();
      expect(spawnFn.mock.calls[0]![2]).toMatchObject({
        env: expect.objectContaining({
          OPENAI_API_KEY: 'generic-api-key-secret',
        }),
      });
    } finally {
      if (previousKey === undefined) delete process.env['OPENAI_API_KEY'];
      else process.env['OPENAI_API_KEY'] = previousKey;
      rmSync(workingDir, { recursive: true, force: true });
      rmSync(implStateDir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: 'environment API key',
      environmentKey: 'env-api-key-secret',
      authFile: {
        auth_mode: 'chatgpt',
        OPENAI_API_KEY: null,
        tokens: { refresh_token: 'refresh-secret' },
      },
    },
    {
      name: 'auth-file API key',
      authFile: {
        auth_mode: 'chatgpt',
        OPENAI_API_KEY: 'file-api-key-secret',
        tokens: { refresh_token: 'refresh-secret' },
      },
    },
    {
      name: 'wrong auth mode',
      authFile: {
        auth_mode: 'apiKey',
        OPENAI_API_KEY: null,
        tokens: { refresh_token: 'refresh-secret' },
      },
    },
    {
      name: 'expired bearer',
      authFile: {
        auth_mode: 'chatgpt',
        OPENAI_API_KEY: null,
        tokens: {
          access_token: authPolicyJwt(Math.floor(Date.now() / 1000) - 3_600),
        },
      },
    },
    {
      name: 'missing auth file',
      authFile: undefined,
    },
  ])('rejects strict policy with $name before preparation or spawn', async ({
    environmentKey,
    authFile,
  }) => {
    const previousKey = process.env['OPENAI_API_KEY'];
    const previousHome = process.env['CODEX_HOME'];
    const codexHome = mkdtempSync(join(tmpdir(), 'jinn-codex-policy-home-'));
    const workingDir = mkdtempSync(join(tmpdir(), 'jinn-codex-policy-work-'));
    const implStateDir = mkdtempSync(join(tmpdir(), 'jinn-codex-policy-state-'));
    const spawnFn = vi.fn();
    const sessionStartHook = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }));
    try {
      process.env['CODEX_HOME'] = codexHome;
      if (environmentKey === undefined) delete process.env['OPENAI_API_KEY'];
      else process.env['OPENAI_API_KEY'] = environmentKey;
      if (authFile !== undefined) {
        writeFileSync(
          join(codexHome, 'auth.json'),
          JSON.stringify(authFile),
          { mode: 0o600 },
        );
      }
      const adapter = new CodexCodeHarnessAdapter({
        codexPath: 'codex-test',
        clientRoot: '/client/root',
        _spawnFn: spawnFn as never,
        _spawnSyncFn: sessionStartHook as never,
      });

      await expect(adapter.runTask({
        ...runInputs(workingDir, implStateDir, new AbortController().signal),
        codexAuthPolicy: 'chatgpt-oauth-only',
      }, learnerPluginRoot)).rejects.toThrow(/ChatGPT OAuth/i);

      expect(sessionStartHook).not.toHaveBeenCalled();
      expect(spawnFn).not.toHaveBeenCalled();
      expect(existsSync(join(workingDir, '.agents'))).toBe(false);
      expect(existsSync(join(workingDir, '.codex-code'))).toBe(false);
    } finally {
      if (previousKey === undefined) delete process.env['OPENAI_API_KEY'];
      else process.env['OPENAI_API_KEY'] = previousKey;
      if (previousHome === undefined) delete process.env['CODEX_HOME'];
      else process.env['CODEX_HOME'] = previousHome;
      rmSync(codexHome, { recursive: true, force: true });
      rmSync(workingDir, { recursive: true, force: true });
      rmSync(implStateDir, { recursive: true, force: true });
    }
  });

  it('blocks spawn when OAuth state is removed during session preparation', async () => {
    const previousKey = process.env['OPENAI_API_KEY'];
    const previousHome = process.env['CODEX_HOME'];
    const codexHome = mkdtempSync(join(tmpdir(), 'jinn-codex-rotation-home-'));
    const workingDir = mkdtempSync(join(tmpdir(), 'jinn-codex-rotation-work-'));
    const implStateDir = mkdtempSync(join(tmpdir(), 'jinn-codex-rotation-state-'));
    const authFilePath = join(codexHome, 'auth.json');
    const spawnFn = vi.fn();
    const sessionStartHook = vi.fn(() => {
      rmSync(authFilePath);
      return { status: 0, stdout: '', stderr: '' };
    });
    try {
      delete process.env['OPENAI_API_KEY'];
      process.env['CODEX_HOME'] = codexHome;
      writeFileSync(authFilePath, JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { refresh_token: 'fixture-refresh-token' },
      }), { mode: 0o600 });
      const adapter = new CodexCodeHarnessAdapter({
        codexPath: 'codex-test',
        clientRoot: '/client/root',
        _spawnFn: spawnFn as never,
        _spawnSyncFn: sessionStartHook as never,
      });

      await expect(adapter.runTask({
        ...runInputs(workingDir, implStateDir, new AbortController().signal),
        codexAuthPolicy: 'chatgpt-oauth-only',
      }, learnerPluginRoot)).rejects.toThrow(/ChatGPT OAuth/i);

      expect(sessionStartHook).toHaveBeenCalledOnce();
      expect(spawnFn).not.toHaveBeenCalled();
      expect(existsSync(join(workingDir, '.agents', 'skills'))).toBe(true);
      expect(existsSync(join(workingDir, '.codex-code'))).toBe(false);
    } finally {
      if (previousKey === undefined) delete process.env['OPENAI_API_KEY'];
      else process.env['OPENAI_API_KEY'] = previousKey;
      if (previousHome === undefined) delete process.env['CODEX_HOME'];
      else process.env['CODEX_HOME'] = previousHome;
      rmSync(codexHome, { recursive: true, force: true });
      rmSync(workingDir, { recursive: true, force: true });
      rmSync(implStateDir, { recursive: true, force: true });
    }
  });

  it('re-checks strict OAuth before restoration spawn and omits OPENAI_API_KEY defensively', async () => {
    const previousKey = process.env['OPENAI_API_KEY'];
    process.env['OPENAI_API_KEY'] = 'must-not-reach-strict-child';
    const order: string[] = [];
    let inspectionIndex = 0;
    const inspectOAuth = vi.fn(() => {
      order.push('inspect-oauth');
      return {
        ready: true as const,
        authFilePath: inspectionIndex++ === 0
          ? '/initial/codex/auth.json'
          : '/rotated/codex/auth.json',
      };
    });
    const spawnFn = vi.fn((_command: string, _args: string[], _options: unknown) => {
      order.push('spawn');
      return fakeCodexChild();
    });
    const workingDir = mkdtempSync(join(tmpdir(), 'jinn-codex-strict-work-'));
    const implStateDir = mkdtempSync(join(tmpdir(), 'jinn-codex-strict-state-'));
    try {
      const adapter = new CodexCodeHarnessAdapter({
        codexPath: 'codex-test',
        clientRoot: '/client/root',
        _spawnFn: spawnFn as never,
        _runSessionStartHook: false,
        _inspectOAuth: inspectOAuth,
      });

      await adapter.runTask({
        ...runInputs(workingDir, implStateDir, new AbortController().signal),
        taskWorkspaceDir: join(workingDir, 'repo'),
        model: 'gpt-5.4-mini',
        codexAuthPolicy: 'chatgpt-oauth-only',
        adapterEnv: {
          OPENAI_API_KEY: 'must-not-reach-strict-child-from-adapter-env',
          HOME: '/must-not-control-strict-auth-home',
          CODEX_HOME: '/must-not-control-strict-codex-home',
        },
      }, learnerPluginRoot);

      expect(inspectOAuth).toHaveBeenCalledTimes(2);
      expect(order).toEqual(['inspect-oauth', 'inspect-oauth', 'spawn']);
      const [, args, options] = spawnFn.mock.calls[0]!;
      expect(args).toEqual(expect.arrayContaining([
        '--sandbox',
        'danger-full-access',
        '--dangerously-bypass-approvals-and-sandbox',
        '-m',
        'gpt-5.4-mini',
      ]));
      expect(args).toContain('-c');
      expect(args.join('\n')).not.toContain('OPENAI_API_KEY');
      expect(args.join('\n')).not.toContain('/must-not-control-strict-auth-home');
      expect(args.join('\n')).not.toContain('/must-not-control-strict-codex-home');
      expect(options).toMatchObject({
        cwd: workingDir,
        env: expect.objectContaining({
          CODEX_HOME: '/rotated/codex',
        }),
      });
      expect(options.env).not.toHaveProperty('OPENAI_API_KEY');
      expect(options.env?.['CODEX_HOME']).not.toBe('/initial/codex');
      expect(options.env?.['HOME']).not.toBe('/must-not-control-strict-auth-home');
      expect(existsSync(join(workingDir, '.agents', 'skills'))).toBe(true);
    } finally {
      if (previousKey === undefined) delete process.env['OPENAI_API_KEY'];
      else process.env['OPENAI_API_KEY'] = previousKey;
      rmSync(workingDir, { recursive: true, force: true });
      rmSync(implStateDir, { recursive: true, force: true });
    }
  });
});

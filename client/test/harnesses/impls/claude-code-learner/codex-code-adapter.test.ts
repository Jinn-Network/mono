import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { SweRebenchV2SolutionPayloadSchema } from '@jinn-network/sdk/solvernets/swe-rebench-v2';
import {
  ClaudeCodeLearnerImpl,
  CodexCodeHarnessAdapter,
} from '../../../../src/harnesses/impls/claude-code-learner/index.js';
import { fakeFullPipelineRun } from '../../../../src/harnesses/impls/claude-code-learner/test-utils/fake-plugin-outputs.js';
import type { HarnessContext } from '../../../../src/harnesses/types.js';
import type { Task } from '../../../../src/types/task.js';

const learnerPluginRoot = fileURLToPath(new URL('../../../../plugins/claude-code-learner/', import.meta.url));
const sweRuntimePluginRoot = fileURLToPath(new URL('../../../../plugins/swe-rebench-v2-runtime/', import.meta.url));
const networkToolsPluginRoot = fileURLToPath(new URL('../../../../plugins/network-tools/', import.meta.url));

type SpawnCall = {
  command: string;
  args: string[];
  options: { env?: NodeJS.ProcessEnv; cwd?: string };
};

function fakeCodexChild(onSpawn?: (options: { env?: NodeJS.ProcessEnv; cwd?: string }) => void): EventEmitter & {
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
    onSpawn?.({});
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
    const spawnFn = vi.fn((command: string, args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string }) => {
      calls.push({ command, args, options });
      return fakeCodexChild();
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
          subgraphUrl: 'https://subgraph.example',
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
      const promptArg = calls[0]!.args.at(-1)!;
      expect(promptArg).toContain('You are executing a Jinn task');
      expect(promptArg).toContain('Use the available skills, plugins, tools, and runtime context exposed by this harness');
      expect(promptArg).toContain('typed SolverNet payload');
      expect(promptArg).toContain('SWE-rebench v2 restoration requirements:');
      expect(promptArg).toContain(`Use ${workingDir}/repo as the only task repository checkout`);
      expect(promptArg).toContain(`clone https://github.com/Unidata/netcdf-c.git into ${workingDir}/repo`);
      expect(promptArg).toContain('search_records, inspect_record, and acquire_artifact');
      expect(promptArg).toContain(`${workingDir}/.execute/solution-payload.json`);
      expect(promptArg).not.toContain('claude-code-learner:learn');
      expect(promptArg).not.toContain('Subagent dispatch is available as `spawn_agent`');
      expect(promptArg).not.toContain('Do not pass both `message` and `items`');
      expect(promptArg).not.toContain('fork_context: false');
      expect(promptArg).not.toContain('swe-rebench-v2-orient');
      expect(promptArg).not.toContain('swe-rebench-v2-plan');
      expect(promptArg).not.toContain('do not call spawn_agent');
      expect(promptArg).toContain('goal (full body)');
      expect(promptArg).toContain('swe-rebench-v2.v1');

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
        JINN_CORPUS_SUBGRAPH_URL: 'https://subgraph.example',
        JINN_CORPUS_IPFS_GATEWAY_URL: 'https://ipfs.example',
      });
      expect(existsSync(join(workingDir, '.agents', 'skills', 'claude-code-learner__learn', 'SKILL.md'))).toBe(true);
      expect(existsSync(join(workingDir, '.agents', 'skills', 'swe-rebench-v2-runtime__plan', 'SKILL.md'))).toBe(true);
      expect(existsSync(join(workingDir, '.agents', 'plugins', 'marketplace.json'))).toBe(true);
      expect(readFileSync(join(workingDir, '.codex-code', 'stdout.jsonl'), 'utf8')).toContain('session_configured');
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
      const harness = new ClaudeCodeLearnerImpl({
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

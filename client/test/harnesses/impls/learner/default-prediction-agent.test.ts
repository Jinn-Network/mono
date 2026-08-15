import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadSolverNets } from '../../../../src/solver-nets/registry.js';
import { HarnessRegistry } from '../../../../src/harnesses/engine/registry.js';
import { LearnerHarness } from '../../../../src/harnesses/impls/learner/index.js';
import { ClaudeCodeHarnessAdapter } from '../../../../src/harnesses/impls/learner/adapters/claude-code.js';
import { NoOpHarnessAdapter } from '../../../../src/harnesses/impls/learner/test-utils/noop-adapter.js';
import { PredictionV1BaselineImpl } from '../../../../src/harnesses/impls/prediction-v1-baseline/index.js';
import { makePredictionV1Task } from '../prediction-v1-test-helpers.js';

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function toolList(manifest: Record<string, unknown>): string[] {
  const jinn = manifest['jinn'] as { capabilities?: { tools?: Record<string, string[]> } };
  return Object.values(jinn.capabilities?.tools ?? {}).flat();
}

describe('default prediction agent runtime plugins', () => {
  it('routes prediction.v1 to the specialist harness with Network Tools and Prediction plugin surfaces', async () => {
    // Per `spec/2026-05-05-solvernet-creation-and-launch.md` §8/§9, the
    // bundled prediction plugin is operator-configured (not contract-bound),
    // so the launcher's quick-start defaults seed it into the operator's
    // joined SolverNet `plugins` array. Issue #421 retired the legacy
    // `solverNets` block; the registry reads joinedSolverNets exclusively.
    const registry = await loadSolverNets({
      executionWiring: [{
        workKind: 'prediction.v1',
        harness: 'claude-code-learner',
        model: 'claude-opus-test',
        plugins: ['bundled:jinn-prediction-plugin'],
        credentialRef: 'claude-code-learner-default',
        isolationPolicy: 'process',
      }],
    });
    const net = registry.forSolverType('prediction.v1');
    expect(net).toBeDefined();

    const harnessRegistry = new HarnessRegistry({
      solverTypeHarnesses: registry.harnessSelections(),
      default: 'claude-code-learner',
    });
    const adapter = new NoOpHarnessAdapter();
    const learner = new LearnerHarness({ adapter });
    harnessRegistry.register(new PredictionV1BaselineImpl());
    harnessRegistry.register(learner);

    expect(harnessRegistry.findFor({ solverType: 'prediction.v1', role: 'restoration' })?.name)
      .toBe('prediction-v1-baseline');
    expect(adapter.getInvocations()).toHaveLength(0);

    const pluginNames = net!.runtimePlugins.map((plugin) => plugin.name);
    expect(pluginNames).toEqual([
      '@jinn-network/network-tools',
      '@jinn-network/prediction-plugin',
    ]);
    expect(net!.runtimePlugins.map((plugin) => plugin.provenance)).toEqual(['default', 'configured']);
    expect(JSON.stringify(net!.runtimePlugins)).not.toMatch(/canonical/i);

    const networkTools = net!.runtimePlugins.find((plugin) => plugin.name === '@jinn-network/network-tools')!;
    const predictionPlugin = net!.runtimePlugins.find((plugin) => plugin.name === '@jinn-network/prediction-plugin')!;

    const networkClaude = readJson(join(networkTools.root, '.claude-plugin', 'plugin.json'));
    const predictionClaude = readJson(join(predictionPlugin.root, '.claude-plugin', 'plugin.json'));
    const networkJinn = readJson(join(networkTools.root, 'jinn.plugin.json'));
    const predictionJinn = readJson(join(predictionPlugin.root, 'jinn.plugin.json'));

    expect(Object.keys(networkClaude['mcpServers'] as Record<string, unknown>)).toContain('jinn-client');
    expect(toolList(networkJinn)).toEqual(expect.arrayContaining([
      'get_task',
      'search_records',
      'inspect_record',
      'acquire_artifact',
    ]));
    expect(Object.keys(predictionClaude['mcpServers'] as Record<string, unknown>)).toContain('polymarket');
    expect(predictionClaude['skills']).toEqual(expect.arrayContaining([
      'skills/prediction-corpus-retrieval/SKILL.md',
      'skills/polymarket-task-handling/SKILL.md',
    ]));
    expect(toolList(predictionJinn)).toEqual(expect.arrayContaining([
      'market.read',
      'orderbook.read',
    ]));
    expect(existsSync(join(predictionPlugin.root, 'skills', 'prediction-corpus-retrieval', 'SKILL.md')))
      .toBe(true);
  });

  it('does not hardcode prediction retrieval policy into the learner harness', () => {
    const harnessSource = readFileSync(
      join(process.cwd(), 'src/harnesses/impls/learner/harness.ts'),
      'utf8',
    );
    const adapterSource = readFileSync(
      join(process.cwd(), 'src/harnesses/impls/learner/adapters/claude-code.ts'),
      'utf8',
    );
    expect(`${harnessSource}\n${adapterSource}`).not.toMatch(
      /search_records|inspect_record|polymarket_get_market|polymarket_get_orderbook|prediction-corpus-retrieval/,
    );
  });
});

describe('ClaudeCodeHarnessAdapter Network Tools env', () => {
  it('spawns Claude Code with runtime plugin dirs and Jinn MCP env', async () => {
    const calls: Array<{ command: string; args: string[]; options: { env?: NodeJS.ProcessEnv; cwd?: string } }> = [];
    const spawnFn = vi.fn((command: string, args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string }) => {
      calls.push({ command, args, options });
      const child = new EventEmitter() as EventEmitter & {
        stderr: EventEmitter;
        killed: boolean;
        kill: ReturnType<typeof vi.fn>;
      };
      child.stderr = new EventEmitter();
      child.killed = false;
      child.kill = vi.fn();
      setImmediate(() => child.emit('exit', 0, null));
      return child;
    });

    const workingDir = mkdtempSync(join(tmpdir(), 'jinn-claude-adapter-work-'));
    const implStateDir = mkdtempSync(join(tmpdir(), 'jinn-claude-adapter-state-'));
    const pluginInstallDir = mkdtempSync(join(tmpdir(), 'jinn-claude-adapter-plugins-'));
    // The adapter lets an operator-set JINN_NETWORK_TOOLS_CLIENT_ROOT win over
    // the configured clientRoot. Clear it so this test exercises the config
    // value deterministically regardless of the runner's ambient env.
    const previousClientRoot = process.env['JINN_NETWORK_TOOLS_CLIENT_ROOT'];
    delete process.env['JINN_NETWORK_TOOLS_CLIENT_ROOT'];
    try {
      const adapter = new ClaudeCodeHarnessAdapter({
        claudePath: 'claude-test',
        claudeModel: 'test-model',
        storePath: '/tmp/jinn-test.db',
        daemonApiUrl: 'http://127.0.0.1:7331',
        daemonApiToken: 'test-token',
        corpusEnv: {
          discoveryUrl: 'https://subgraph.example',
          ipfsGatewayUrl: 'https://ipfs.example',
        },
        clientRoot: '/client/root',
        pluginInstallDir,
        _spawnFn: spawnFn as never,
      });

      await adapter.runTask({
        taskId: 'prediction-v1-polymarket-abc',
        requestId: '0x' + '9'.repeat(64),
        solverType: 'prediction.v1',
        taskBody: makePredictionV1Task(),
        implStateDir,
        workingDir,
        pluginRoots: ['/plugins/network-tools', '/plugins/jinn-prediction-plugin'],
        windowStartTs: 1,
        windowEndTs: 2,
        msUntilEndTs: 1,
        mode: 'train',
        abort: new AbortController().signal,
      }, '/plugins/learner');

      expect(calls).toHaveLength(1);
      expect(calls[0]!.command).toBe('claude-test');
      expect(calls[0]!.args).toEqual(expect.arrayContaining([
        '--setting-sources',
        'project',
        '--permission-mode',
        'bypassPermissions',
        '--output-format',
        'stream-json',
        '--include-hook-events',
        '-p',
      ]));
      const promptArg = calls[0]!.args[calls[0]!.args.indexOf('-p') + 1]!;
      expect(promptArg).toContain('You are executing a Jinn task');
      expect(promptArg).toContain('Use the available skills, plugins, tools, and runtime context exposed by this harness');
      expect(promptArg).not.toContain('claude-code-learner:learn');
      expect(promptArg).toContain('- mode = train');
      expect(calls[0]!.args).toEqual(expect.arrayContaining([
        '--plugin-dir',
        '/plugins/learner',
        '--plugin-dir',
        '/plugins/network-tools',
        '--plugin-dir',
        '/plugins/jinn-prediction-plugin',
      ]));
      expect(calls[0]!.options.cwd).toBe(workingDir);
      expect(calls[0]!.options.env).toMatchObject({
        IMPL_STATE_DIR: implStateDir,
        WORKING_DIR: workingDir,
        JINN_WORKING_DIR: workingDir,
        DESIRED_STATE_ID: 'prediction-v1-polymarket-abc',
        DESIRED_STATE_DESCRIPTION: makePredictionV1Task().description,
        DESIRED_STATE_ROLE: 'restoration',
        REQUEST_ID: '0x' + '9'.repeat(64),
        STORE_PATH: '/tmp/jinn-test.db',
        DAEMON_API_URL: 'http://127.0.0.1:7331',
        DAEMON_API_TOKEN: 'test-token',
        JINN_DISCOVERY_URL: 'https://subgraph.example',
        JINN_DISCOVERY_MODE: 'http',
        JINN_CORPUS_IPFS_GATEWAY_URL: 'https://ipfs.example',
        // Regression: the Network Tools MCP launcher needs this to resolve the
        // real Jinn MCP server. The bundled plugin is materialized into the
        // operator vendor root, so its own `../..` resolution misses the
        // client tree and the jinn-client MCP server fails to start —
        // dropping submit_typed_payload from the agent's tools.
        JINN_NETWORK_TOOLS_CLIENT_ROOT: '/client/root',
      });
      expect(calls[0]!.options.env?.['DESIRED_STATE_CONTEXT']).toBe('');
    } finally {
      if (previousClientRoot === undefined) delete process.env['JINN_NETWORK_TOOLS_CLIENT_ROOT'];
      else process.env['JINN_NETWORK_TOOLS_CLIENT_ROOT'] = previousClientRoot;
      rmSync(workingDir, { recursive: true, force: true });
      rmSync(implStateDir, { recursive: true, force: true });
      rmSync(pluginInstallDir, { recursive: true, force: true });
    }
  });
});

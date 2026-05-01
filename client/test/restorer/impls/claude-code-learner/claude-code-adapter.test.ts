import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { ClaudeCodeHarnessAdapter } from '../../../../src/restorer/impls/claude-code-learner/adapters/claude-code.js';
import type { IntentSessionInputs } from '../../../../src/restorer/impls/claude-code-learner/index.js';

function makeFakeChild(exitCode: number, exitDelayMs = 0): ChildProcess {
  const ee = new EventEmitter() as ChildProcess & EventEmitter;
  (ee as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
  (ee as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
  (ee as unknown as { kill: () => boolean }).kill = () => true;
  (ee as unknown as { killed: boolean }).killed = false;
  setTimeout(() => ee.emit('exit', exitCode, null), exitDelayMs);
  return ee;
}

function makeInputs(overrides: Partial<IntentSessionInputs> = {}): IntentSessionInputs {
  return {
    intentId: 'cc-test-1',
    intentCid: 'bafycc',
    intentKind: 'portfolio.v0',
    intentBody: {
      id: 'cc-test-1',
      description: 'Test portfolio restoration',
      spec: { kind: 'portfolio.v0', target: 0.5 },
      type: 'restoration',
      eligibility: { minBalance: 100 },
    },
    implStateDir: '/tmp/fake-state',
    workingDir: '/tmp/fake-work',
    windowStartTs: Date.now() - 1000,
    windowEndTs: Date.now() + 60_000,
    msUntilEndTs: 60_000,
    abort: new AbortController().signal,
    ...overrides,
  };
}

describe('ClaudeCodeHarnessAdapter', () => {
  it('spawns the configured claudePath with the intent prompt', async () => {
    const spawnFn = vi.fn(() => makeFakeChild(0));
    const adapter = new ClaudeCodeHarnessAdapter({
      claudePath: '/usr/bin/fake-claude',
      _spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
    });

    await adapter.runIntent(makeInputs(), '/path/to/plugin');

    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [path, args, opts] = spawnFn.mock.calls[0];
    expect(path).toEqual('/usr/bin/fake-claude');
    expect(args).toEqual(expect.arrayContaining(['-p']));
    const promptArg = (args as string[])[1];
    expect(promptArg).toContain('cc-test-1');
    expect(promptArg).toContain('claude-code-learner:coordinator');
    expect(promptArg).toContain('JINN_CLAUDE_CODE_LEARNER_PHASE_RANGE');
    expect(promptArg).toContain('Test portfolio restoration');
    expect(promptArg).toContain('portfolio.v0');
    expect(promptArg).toContain('restoration');
    expect(promptArg).toContain('minBalance');
    expect(promptArg).toContain('/tmp/fake-work');
    expect(args).toEqual(expect.arrayContaining(['--plugin-dir', '/path/to/plugin']));
    expect((opts as { env: Record<string, string> }).env.IMPL_STATE_DIR).toEqual('/tmp/fake-state');
    expect((opts as { env: Record<string, string> }).env.JINN_CLAUDE_CODE_LEARNER_PLUGIN_ROOT).toEqual('/path/to/plugin');
    expect((opts as { cwd: string }).cwd).toEqual('/tmp/fake-work');
  });

  it('rejects when child exits non-zero (and not aborted)', async () => {
    const spawnFn = vi.fn(() => makeFakeChild(1));
    const adapter = new ClaudeCodeHarnessAdapter({
      _spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
    });
    await expect(adapter.runIntent(makeInputs(), '/p')).rejects.toThrow(/exited with code=1/);
  });

  it('resolves on non-zero exit when abort signal already fired', async () => {
    const ac = new AbortController();
    ac.abort();
    const spawnFn = vi.fn(() => makeFakeChild(143));
    const adapter = new ClaudeCodeHarnessAdapter({
      _spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
    });
    await expect(adapter.runIntent(makeInputs({ abort: ac.signal }), '/p')).resolves.toBeUndefined();
  });

  it('wires Path 1 plug-ins into --mcp-config and --plugin-dir from JINN_SLOT_REGISTRY_JSON', async () => {
    const { mkdtempSync, rmSync, existsSync, readFileSync } = await import(
      'node:fs'
    );
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const tmp = mkdtempSync(join(tmpdir(), 'cc-adapter-slots-'));
    try {
      const registry = {
        builtAt: new Date().toISOString(),
        learnerVersion: '0.1.0',
        phaseAgentOverrides: [],
        topicExplorers: [],
        mcpTools: [
          {
            plugInName: '@jinn-examples/polymarket-mcp',
            packageRoot: '/tmp/poly',
            slot: {
              type: 'mcp-tool',
              command: 'node',
              args: ['/tmp/poly/dist/server.js'],
              namespace: 'polymarket',
            },
          },
        ],
        skillBundles: [
          {
            plugInName: '@jinn-examples/forecasting-techniques',
            packageRoot: '/tmp/skills',
            slot: { type: 'skill-bundle', skillsDir: 'skills' },
          },
        ],
        memoryBackends: [
          {
            plugInName: '@jinn-examples/vector-store-memory',
            packageRoot: '/tmp/vec',
            slot: {
              type: 'memory-backend',
              command: 'node',
              args: ['/tmp/vec/dist/server.js'],
            },
          },
        ],
        hooks: [],
      };
      const spawnFn = vi.fn(() => makeFakeChild(0));
      const adapter = new ClaudeCodeHarnessAdapter({
        _spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
      });
      await adapter.runIntent(
        makeInputs({
          workingDir: tmp,
          adapterEnv: { JINN_SLOT_REGISTRY_JSON: JSON.stringify(registry) },
        }),
        '/path/to/plugin',
      );
      const args = spawnFn.mock.calls[0][1] as string[];
      // Bundled plugin + skill-bundle plug-in package root both get --plugin-dir
      expect(args).toEqual(
        expect.arrayContaining(['--plugin-dir', '/path/to/plugin']),
      );
      expect(args).toEqual(
        expect.arrayContaining(['--plugin-dir', '/tmp/skills']),
      );
      // --mcp-config points at a file the adapter wrote in workingDir
      const mcpIdx = args.indexOf('--mcp-config');
      expect(mcpIdx).toBeGreaterThan(-1);
      const mcpPath = args[mcpIdx + 1] ?? '';
      expect(existsSync(mcpPath)).toBe(true);
      const mcp = JSON.parse(readFileSync(mcpPath, 'utf8')) as {
        mcpServers: Record<string, { command: string; args: string[] }>;
      };
      // mcp-tool slot present under its declared namespace
      expect(mcp.mcpServers).toHaveProperty('polymarket');
      // memory-backend slot present under memory-* prefix
      expect(mcp.mcpServers).toHaveProperty(
        'memory-@jinn-examples/vector-store-memory',
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('passes --model flag when claudeModel is set', async () => {
    const spawnFn = vi.fn(() => makeFakeChild(0));
    const adapter = new ClaudeCodeHarnessAdapter({
      claudeModel: 'claude-opus-4-7',
      _spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
    });
    await adapter.runIntent(makeInputs(), '/p');
    const args = spawnFn.mock.calls[0][1] as string[];
    expect(args).toEqual(expect.arrayContaining(['--model', 'claude-opus-4-7']));
  });
});

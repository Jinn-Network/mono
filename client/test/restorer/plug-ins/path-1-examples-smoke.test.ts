/**
 * End-to-end smoke test for Path 1 plug-in examples.
 *
 * Loads the on-disk `examples/learner-plug-ins/@jinn-examples/polymarket-mcp`
 * example via the real `loadPlugIns` pipeline, serialises the registry, and
 * runs the slot registry through the claude-code adapter (with a fake spawn)
 * to prove the plug-in surfaces in the spawned --mcp-config.
 *
 * Closes the slot-integration smoke test acceptance from Plan 4 self-review.
 */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadPlugIns } from '../../../src/restorer/plug-ins/loader.js';
import { serialiseRegistry } from '../../../src/restorer/plug-ins/serialise.js';
import { ClaudeCodeHarnessAdapter } from '../../../src/restorer/impls/claude-code-learner/adapters/claude-code.js';
import type { IntentSessionInputs } from '../../../src/restorer/impls/claude-code-learner/index.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
// client/test/restorer/plug-ins -> repo root
const REPO_ROOT = resolve(HERE, '../../../../');
const EXAMPLES_ROOT = join(
  REPO_ROOT,
  'examples/learner-plug-ins/@jinn-examples',
);

function makeFakeChild(): ChildProcess {
  const ee = new EventEmitter() as ChildProcess & EventEmitter;
  (ee as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
  (ee as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
  (ee as unknown as { kill: () => boolean }).kill = () => true;
  (ee as unknown as { killed: boolean }).killed = false;
  setTimeout(() => ee.emit('exit', 0, null), 0);
  return ee;
}

function makeInputs(workingDir: string, registryJson: string): IntentSessionInputs {
  return {
    intentId: 'smoke-1',
    intentKind: 'prediction.v0',
    implStateDir: workingDir,
    workingDir,
    windowStartTs: Date.now() - 1000,
    windowEndTs: Date.now() + 60_000,
    msUntilEndTs: 60_000,
    abort: new AbortController().signal,
    adapterEnv: { JINN_SLOT_REGISTRY_JSON: registryJson },
  };
}

describe('Path 1 examples smoke (loader → adapter)', () => {
  it.runIf(existsSync(join(EXAMPLES_ROOT, 'polymarket-mcp/jinn-plugin.json')))(
    'polymarket-mcp surfaces in the spawned --mcp-config',
    async () => {
      const result = await loadPlugIns({
        entries: [
          {
            name: '@jinn-examples/polymarket-mcp',
            entry: join(EXAMPLES_ROOT, 'polymarket-mcp'),
          },
        ],
        learnerVersion: '0.1.0',
      });
      expect(result.errors).toEqual([]);
      expect(result.registry.mcpTools).toHaveLength(1);
      expect(result.registry.mcpTools[0].slot.namespace).toBe('polymarket');

      const registryJson = JSON.stringify(
        serialiseRegistry(result.registry, '0.1.0'),
      );
      const tmp = mkdtempSync(join(tmpdir(), 'path1-smoke-'));
      try {
        const spawnFn = vi.fn(() => makeFakeChild());
        const adapter = new ClaudeCodeHarnessAdapter({
          _spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
        });
        await adapter.runIntent(
          makeInputs(tmp, registryJson),
          '/bundled/plugin',
        );
        const args = spawnFn.mock.calls[0][1] as string[];
        const mcpIdx = args.indexOf('--mcp-config');
        expect(mcpIdx).toBeGreaterThan(-1);
        const mcp = JSON.parse(readFileSync(args[mcpIdx + 1] ?? '', 'utf8')) as {
          mcpServers: Record<string, { command: string; args: string[] }>;
        };
        expect(mcp.mcpServers).toHaveProperty('polymarket');
        expect(mcp.mcpServers.polymarket.command).toBe('node');
        expect(mcp.mcpServers.polymarket.args).toEqual(['./dist/server.js']);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  );

  it.runIf(
    existsSync(join(EXAMPLES_ROOT, 'forecasting-techniques/jinn-plugin.json')),
  )('forecasting-techniques skill-bundle joins --plugin-dir', async () => {
    const result = await loadPlugIns({
      entries: [
        {
          name: '@jinn-examples/forecasting-techniques',
          entry: join(EXAMPLES_ROOT, 'forecasting-techniques'),
        },
      ],
      learnerVersion: '0.1.0',
    });
    expect(result.errors).toEqual([]);
    expect(result.registry.skillBundles).toHaveLength(1);

    const registryJson = JSON.stringify(
      serialiseRegistry(result.registry, '0.1.0'),
    );
    const tmp = mkdtempSync(join(tmpdir(), 'path1-smoke-'));
    try {
      const spawnFn = vi.fn(() => makeFakeChild());
      const adapter = new ClaudeCodeHarnessAdapter({
        _spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
      });
      await adapter.runIntent(
        makeInputs(tmp, registryJson),
        '/bundled/plugin',
      );
      const args = spawnFn.mock.calls[0][1] as string[];
      const pluginDirIdxs = args
        .map((a, i) => (a === '--plugin-dir' ? i : -1))
        .filter((i) => i !== -1);
      const dirs = pluginDirIdxs.map((i) => args[i + 1]);
      expect(dirs).toEqual(
        expect.arrayContaining([
          '/bundled/plugin',
          join(EXAMPLES_ROOT, 'forecasting-techniques'),
        ]),
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

/**
 * Stub-Hermes script smoke test (r83r Task 8).
 *
 * Asserts:
 *   1. Running stub-hermes.mjs with a SolverPlugin set produces a
 *      solution-payload.json containing the canned patch.
 *   2. stdout JSON includes plugins[].cid matching the input.
 *   3. hermesConfigFromSolverPlugins produces the expected shape from a
 *      minimal plugin directory.
 *
 * Runs via `yarn e2e:cold-start-builder` (acceptance tier).
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { hermesConfigFromSolverPlugins } from './hermes-config-shim.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STUB_HERMES = join(__dirname, '..', '..', '..', 'scripts', 'stub-hermes.mjs');

describe('stub-Hermes script + hermes-config shim (r83r)', () => {
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'jinn-stub-hermes-test-'));
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('hermesConfigFromSolverPlugins produces expected shape', () => {
    // Build a minimal plugin directory on disk.
    const pluginRoot = join(tmpRoot, 'my-plugin');
    mkdirSync(join(pluginRoot, 'skills', 'diffmin'), { recursive: true });
    mkdirSync(join(pluginRoot, 'mcp'), { recursive: true });

    writeFileSync(
      join(pluginRoot, 'skills', 'diffmin', 'SKILL.md'),
      '---\nname: diffmin\ndescription: test skill\n---\n\n# Content',
    );

    writeFileSync(
      join(pluginRoot, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          'diff-stats': {
            command: 'node',
            args: ['${CLAUDE_PLUGIN_ROOT}/mcp/diff-stats-server.mjs'],
          },
        },
      }),
    );

    const config = hermesConfigFromSolverPlugins([
      {
        manifest: {
          name: 'my-plugin',
          version: '0.1.0',
          jinn: { skills: ['skills/diffmin/SKILL.md'], supports: ['swe-rebench-v2.v1'] },
        },
        cid: 'f01551220aabbccdd',
        sha256: '0x' + 'ab'.repeat(32),
        packageRoot: pluginRoot,
      },
    ]);

    expect(config.plugins).toHaveLength(1);
    expect(config.plugins[0]!.name).toBe('my-plugin');
    expect(config.plugins[0]!.cid).toBe('f01551220aabbccdd');
    expect(config.mcp_servers['diff-stats']).toBeDefined();
    expect(config.mcp_servers['diff-stats']!.args?.[0]).toContain('mcp/diff-stats-server.mjs');
    // Verify CLAUDE_PLUGIN_ROOT was expanded.
    expect(config.mcp_servers['diff-stats']!.args?.[0]).toContain(pluginRoot);
    expect(config.skills.external_dirs).toHaveLength(1);
    expect(config.skills.external_dirs[0]).toContain('diffmin');
  });

  it('stub-hermes.mjs writes solution-payload.json and prints plugins to stdout', () => {
    const workingDir = join(tmpRoot, 'working');
    mkdirSync(workingDir, { recursive: true });

    const testPlugins = [
      { name: 'my-plugin', version: '0.1.0', cid: 'f01551220aabb', sha256: '0x' + 'ab'.repeat(32) },
    ];

    const args = JSON.stringify({
      taskBody: { schemaVersion: 'swe-rebench-v2.v1', instance_id: 'unidata__netcdf-c-1925' },
      hermesConfig: { plugins: testPlugins, mcp_servers: {}, skills: { external_dirs: [] } },
      workingDir,
    });

    const stdout = execFileSync('node', [STUB_HERMES, args], { encoding: 'utf8' });

    // Verify stdout contains the plugin list.
    const parsed = JSON.parse(stdout.trim()) as { plugins: typeof testPlugins };
    expect(parsed.plugins).toHaveLength(1);
    expect(parsed.plugins[0]!.cid).toBe('f01551220aabb');

    // Verify solution-payload.json was written.
    const payloadPath = join(workingDir, '.execute', 'solution-payload.json');
    expect(existsSync(payloadPath)).toBe(true);
    const payload = JSON.parse(readFileSync(payloadPath, 'utf8')) as {
      schemaVersion: string;
      patch: string;
      cost: { totalUsd: number };
    };
    expect(payload.schemaVersion).toBe('swe-rebench-v2-solution.v1');
    expect(payload.patch).toContain('-broken');
    expect(payload.patch).toContain('+fixed');
    expect(payload.cost.totalUsd).toBe(0.01);
  });

  it('stub-hermes.mjs exits 0 with empty plugins list', () => {
    const workingDir2 = join(tmpRoot, 'working2');
    mkdirSync(workingDir2, { recursive: true });

    const args = JSON.stringify({
      taskBody: {},
      hermesConfig: { plugins: [], mcp_servers: {}, skills: { external_dirs: [] } },
      workingDir: workingDir2,
    });

    expect(() => execFileSync('node', [STUB_HERMES, args])).not.toThrow();
  });
});

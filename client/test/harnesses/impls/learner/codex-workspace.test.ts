import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepareCodexPluginWorkspace } from '../../../../src/harnesses/impls/learner/adapters/codex-workspace.js';

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function makeSkillPlugin(root: string, name: string, skill: string): void {
  writeJson(join(root, '.codex-plugin', 'plugin.json'), {
    name,
    version: '0.1.0',
    skills: './skills/',
  });
  mkdirSync(join(root, 'skills', skill), { recursive: true });
  writeFileSync(join(root, 'skills', skill, 'SKILL.md'), [
    '---',
    `name: ${skill}`,
    'description: marker skill',
    '---',
    '',
    '# Marker',
    '',
  ].join('\n'));
}

function makeNetworkToolsPlugin(root: string): void {
  writeJson(join(root, '.codex-plugin', 'plugin.json'), {
    name: 'network-tools',
    version: '0.1.0',
    mcpServers: './.mcp.json',
  });
  writeJson(join(root, '.mcp.json'), {
    mcpServers: {
      'jinn-client': {
        command: 'node',
        args: ['mcp/jinn-client-server.mjs'],
        cwd: '.',
        env: {
          PLUGIN_DECLARED: 'yes',
        },
      },
    },
  });
  mkdirSync(join(root, 'mcp'), { recursive: true });
  writeFileSync(join(root, 'mcp', 'jinn-client-server.mjs'), 'export {};\n');
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

describe('prepareCodexPluginWorkspace', () => {
  it('projects runtime plugins into a per-run Codex workspace without global installs', () => {
    const workRoot = mkdtempSync(join(tmpdir(), 'jinn-codex-workspace-'));
    const pluginRoot = mkdtempSync(join(tmpdir(), 'jinn-codex-plugin-'));
    const networkRoot = mkdtempSync(join(tmpdir(), 'jinn-codex-network-'));
    try {
      const workingDir = join(workRoot, 'run');
      mkdirSync(workingDir, { recursive: true });
      makeSkillPlugin(pluginRoot, 'claude-code-learner', 'learn');
      makeNetworkToolsPlugin(networkRoot);

      const prepared = prepareCodexPluginWorkspace({
        workingDir,
        pluginRoots: [pluginRoot, networkRoot],
        clientRoot: '/client/root',
        mcpEnv: {
          DAEMON_API_URL: 'http://127.0.0.1:7332',
          DAEMON_API_TOKEN: 'test-token',
        },
      });

      expect(prepared.pluginRoots.map((path) => basename(path))).toEqual([
        'claude-code-learner',
        'network-tools',
      ]);
      expect(existsSync(join(workingDir, 'plugins', 'claude-code-learner', 'skills', 'learn', 'SKILL.md'))).toBe(true);
      expect(existsSync(join(workingDir, '.agents', 'skills', 'claude-code-learner__learn', 'SKILL.md'))).toBe(true);

      const marketplace = readJson(prepared.marketplacePath);
      expect(prepared.marketplacePath).toBe(join(workingDir, '.agents', 'plugins', 'marketplace.json'));
      expect(marketplace).toMatchObject({
        name: 'jinn-runtime',
        plugins: [
          {
            name: 'claude-code-learner',
            source: { source: 'local', path: './plugins/claude-code-learner' },
            policy: { installation: 'INSTALLED_BY_DEFAULT', authentication: 'NONE' },
          },
          {
            name: 'network-tools',
            source: { source: 'local', path: './plugins/network-tools' },
            policy: { installation: 'INSTALLED_BY_DEFAULT', authentication: 'NONE' },
          },
        ],
      });
      expect(existsSync(join(workingDir, '.agents', 'plugins', 'plugins'))).toBe(false);

      expect(prepared.mcpServers['jinn-client']).toMatchObject({
        command: 'node',
        args: ['mcp/jinn-client-server.mjs'],
        cwd: join(workingDir, 'plugins', 'network-tools'),
        env: {
          DAEMON_API_URL: 'http://127.0.0.1:7332',
          DAEMON_API_TOKEN: 'test-token',
          JINN_NETWORK_TOOLS_CLIENT_ROOT: '/client/root',
          PLUGIN_DECLARED: 'yes',
        },
      });
      expect(prepared.configArgs).toEqual(expect.arrayContaining([
        'mcp_servers.jinn-client.command="node"',
        'mcp_servers.jinn-client.args=["mcp/jinn-client-server.mjs"]',
        `mcp_servers.jinn-client.cwd="${join(workingDir, 'plugins', 'network-tools')}"`,
        'mcp_servers.jinn-client.env.DAEMON_API_TOKEN="test-token"',
        'mcp_servers.jinn-client.env.DAEMON_API_URL="http://127.0.0.1:7332"',
        'mcp_servers.jinn-client.env.JINN_NETWORK_TOOLS_CLIENT_ROOT="/client/root"',
      ]));
    } finally {
      rmSync(workRoot, { recursive: true, force: true });
      rmSync(pluginRoot, { recursive: true, force: true });
      rmSync(networkRoot, { recursive: true, force: true });
    }
  });
});
